import { AppError, fetchJson, getOptionalEnv, isWithinTimeWindow, logInfo, logWarn, normalizeUrl } from "./utils.js";

const DEFAULT_BLUESKY_SERVICE = "https://bsky.social";
const BLUESKY_CREATE_SESSION_PATH = "/xrpc/com.atproto.server.createSession";
const BLUESKY_SEARCH_POSTS_PATH = "/xrpc/app.bsky.feed.searchPosts";

function extractRkey(uri) {
  const parts = String(uri).split("/");
  return parts.at(-1) ?? null;
}

function extractDid(uri) {
  const parts = String(uri).split("/");
  return parts[2] ?? null;
}

function buildSearchQuery(hashtag) {
  const normalized = String(hashtag).trim().replace(/^#/, "");
  return `#${normalized}`;
}

export function getBlueskyConfigFromEnv() {
  return {
    identifier: getOptionalEnv("BLUESKY_IDENTIFIER", ""),
    appPassword: getOptionalEnv("BLUESKY_APP_PASSWORD", ""),
    service: getOptionalEnv("BLUESKY_SERVICE", DEFAULT_BLUESKY_SERVICE)
  };
}

function getServiceOrigin(service) {
  return new URL(service).origin;
}

async function createSession({ identifier, appPassword, service, timeoutMs }) {
  const payload = await fetchJson(`${getServiceOrigin(service)}${BLUESKY_CREATE_SESSION_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      identifier,
      password: appPassword
    }),
    source: "Bluesky auth",
    timeoutMs
  });

  return payload.accessJwt;
}

export async function fetchBlueskyPosts({ hashtag, cutoff, now, timeoutMs, identifier, appPassword, service }) {
  if (!identifier || !appPassword) {
    logWarn("bluesky.fetch.skipped", {
      reason: "missing BLUESKY_IDENTIFIER or BLUESKY_APP_PASSWORD"
    });
    return {
      posts: [],
      skipped: true,
      skipReason: "missing credentials"
    };
  }

  const accessJwt = await createSession({
    identifier,
    appPassword,
    service,
    timeoutMs
  });
  const query = buildSearchQuery(hashtag);

  const posts = [];
  const seenUris = new Set();
  let cursor;

  try {
    do {
      const url = new URL(`${getServiceOrigin(service)}${BLUESKY_SEARCH_POSTS_PATH}`);
      url.searchParams.set("q", query);
      url.searchParams.set("tag", hashtag);
      url.searchParams.set("sort", "latest");
      url.searchParams.set("limit", "100");

      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }

      const payload = await fetchJson(url, {
        headers: {
          Authorization: `Bearer ${accessJwt}`
        },
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
  } catch (error) {
    logWarn("bluesky.fetch.failed", {
      query,
      tag: hashtag,
      service: getServiceOrigin(service),
      message: error.message
    });

    throw new AppError(
      `[Bluesky] searchPosts failed for query=${query} tag=${hashtag}: ${error.message}`,
      { source: "Bluesky", cause: error }
    );
  }

  logInfo("bluesky.fetch.complete", { count: posts.length, service: getServiceOrigin(service), query, tag: hashtag });
  return {
    posts,
    skipped: false
  };
}
