import { fetchJson, isWithinTimeWindow, logInfo, normalizeUrl } from "./utils.js";

const BLUESKY_SEARCH_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts";

function extractRkey(uri) {
  const parts = String(uri).split("/");
  return parts.at(-1) ?? null;
}

function extractDid(uri) {
  const parts = String(uri).split("/");
  return parts[2] ?? null;
}

export async function fetchBlueskyPosts({ hashtag, cutoff, now, timeoutMs }) {
  const posts = [];
  const seenUris = new Set();
  let cursor;

  do {
    const url = new URL(BLUESKY_SEARCH_URL);
    url.searchParams.set("tag", hashtag);
    url.searchParams.set("sort", "latest");
    url.searchParams.set("limit", "100");

    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const payload = await fetchJson(url, {
      source: "Bluesky",
      timeoutMs
    });

    for (const item of payload.posts ?? []) {
      const uri = item.uri ?? null;
      const createdAt = item.record?.createdAt ?? item.indexedAt ?? null;

      if (!uri || !createdAt || seenUris.has(uri)) {
        continue;
      }

      if (!isWithinTimeWindow(createdAt, cutoff, now)) {
        continue;
      }

      seenUris.add(uri);

      const handle = item.author?.handle ?? null;
      const rkey = extractRkey(uri);
      const profile = handle ?? extractDid(uri);

      if (!rkey || !profile) {
        continue;
      }

      posts.push({
        source: "Bluesky",
        sourceId: uri,
        url: normalizeUrl(`https://bsky.app/profile/${profile}/post/${rkey}`),
        createdAt,
        authorHandle: handle ? `@${handle}` : null
      });
    }

    cursor = payload.cursor;
  } while (cursor);

  logInfo("bluesky.fetch.complete", { count: posts.length });
  return posts;
}
