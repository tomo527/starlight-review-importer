import { fetchJson, isWithinTimeWindow, logInfo, normalizeUrl } from "./utils.js";

const X_SEARCH_URL = "https://api.x.com/2/tweets/search/recent";

export async function fetchXPosts({ hashtag, bearerToken, cutoff, now, timeoutMs }) {
  const posts = [];
  const seenIds = new Set();
  let nextToken;

  do {
    const url = new URL(X_SEARCH_URL);
    url.searchParams.set("query", `#${hashtag} -is:retweet`);
    url.searchParams.set("max_results", "100");
    url.searchParams.set("start_time", cutoff.toISOString());
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("tweet.fields", "author_id,created_at");
    url.searchParams.set("user.fields", "username");

    if (nextToken) {
      url.searchParams.set("next_token", nextToken);
    }

    const payload = await fetchJson(url, {
      headers: {
        Authorization: `Bearer ${bearerToken}`
      },
      source: "X",
      timeoutMs
    });

    const usersById = new Map((payload.includes?.users ?? []).map((user) => [user.id, user]));

    for (const item of payload.data ?? []) {
      if (!item.id || !item.created_at || seenIds.has(item.id)) {
        continue;
      }

      if (!isWithinTimeWindow(item.created_at, cutoff, now)) {
        continue;
      }

      seenIds.add(item.id);

      const username = usersById.get(item.author_id)?.username ?? null;
      const urlValue = username
        ? `https://x.com/${username}/status/${item.id}`
        : `https://x.com/i/web/status/${item.id}`;

      posts.push({
        source: "X",
        sourceId: item.id,
        url: normalizeUrl(urlValue),
        createdAt: item.created_at,
        authorHandle: username ? `@${username}` : null
      });
    }

    nextToken = payload.meta?.next_token;
  } while (nextToken);

  logInfo("x.fetch.complete", { count: posts.length });
  return posts;
}
