import { pathToFileURL } from "node:url";
import { fetchBlueskyPosts, getBlueskyConfigFromEnv } from "./bluesky.js";
import { createNotionRecord, getNotionSchema, listExistingUrls } from "./notion.js";
import {
  AppError,
  createTimeWindow,
  getOptionalEnv,
  getRequiredEnv,
  getTimeoutMs,
  logError,
  logInfo,
  logWarn,
  normalizeUrl,
  parseBooleanEnv,
  parsePositiveInteger,
  sanitizeHashtag
} from "./utils.js";
import { fetchXPosts } from "./x.js";

function aggregateErrors(results) {
  return results
    .filter((result) => result.status === "rejected")
    .map((result) => result.message ?? "unknown source error");
}

async function settleSource(source, run) {
  try {
    const result = await run();
    return {
      source,
      status: result?.skipped ? "skipped" : "fulfilled",
      posts: result?.posts ?? result ?? [],
      message: result?.skipReason ?? null
    };
  } catch (error) {
    return {
      source,
      status: "rejected",
      posts: [],
      message: error.message
    };
  }
}

async function main() {
  const notionToken = getRequiredEnv("NOTION_TOKEN");
  const notionDataSourceId = getRequiredEnv("NOTION_DATA_SOURCE_ID");
  const xBearerToken = getRequiredEnv("X_BEARER_TOKEN");
  const blueskyConfig = getBlueskyConfigFromEnv();
  const hashtag = sanitizeHashtag(getOptionalEnv("HASHTAG", "舞台創造科のレビュー"));
  const lookbackHours = parsePositiveInteger(getOptionalEnv("IMPORT_LOOKBACK_HOURS", "24"), "IMPORT_LOOKBACK_HOURS");
  const timeoutMs = getTimeoutMs();
  const dryRun = parseBooleanEnv(process.env.DRY_RUN, false);
  const { now, nowIso, cutoff, cutoffIso } = createTimeWindow(lookbackHours);

  logInfo("import.start", {
    hashtag,
    lookbackHours,
    cutoffIso,
    nowIso,
    dryRun
  });

  const schema = await getNotionSchema({
    token: notionToken,
    dataSourceId: notionDataSourceId,
    timeoutMs
  });

  const existingUrls = await listExistingUrls({
    token: notionToken,
    dataSourceId: notionDataSourceId,
    urlPropertyName: schema.urlPropertyName,
    timeoutMs
  });

  const sourceResults = await Promise.all([
    settleSource("X", () =>
      fetchXPosts({
        hashtag,
        bearerToken: xBearerToken,
        cutoff,
        now,
        timeoutMs
      })
    ),
    settleSource("Bluesky", () =>
      fetchBlueskyPosts({
        hashtag,
        cutoff,
        now,
        timeoutMs,
        ...blueskyConfig
      })
    )
  ]);

  const xResult = sourceResults[0];
  const blueskyResult = sourceResults[1];
  const xPosts = xResult.status === "fulfilled" ? xResult.posts : [];
  const blueskyPosts = blueskyResult.status === "fulfilled" ? blueskyResult.posts : [];
  const sourceErrors = aggregateErrors(sourceResults);
  const successfulSources = sourceResults.filter((result) => result.status === "fulfilled");
  const failedSources = sourceResults.filter((result) => result.status === "rejected");
  const skippedSources = sourceResults.filter((result) => result.status === "skipped");
  const unavailableMessages = [...failedSources, ...skippedSources]
    .map((result) => `${result.source}: ${result.message ?? result.status}`)
    .filter(Boolean);

  const candidates = [];
  const batchUrls = new Set();
  let duplicateSkipCount = 0;

  for (const entry of [...xPosts, ...blueskyPosts]) {
    const normalized = normalizeUrl(entry.url);

    if (!normalized) {
      continue;
    }

    if (existingUrls.has(normalized) || batchUrls.has(normalized)) {
      duplicateSkipCount += 1;
      continue;
    }

    batchUrls.add(normalized);
    candidates.push({
      ...entry,
      url: normalized
    });
  }

  let notionAddedCount = 0;

  for (const entry of candidates) {
    logInfo("notion.record.prepare", {
      source: entry.source,
      createdAt: entry.createdAt,
      url: entry.url,
      authorHandle: entry.authorHandle,
      dryRun
    });

    if (dryRun) {
      continue;
    }

    await createNotionRecord({
      token: notionToken,
      dataSourceId: notionDataSourceId,
      schema,
      entry,
      timeoutMs
    });

    notionAddedCount += 1;
  }

  if (failedSources.length > 0 || skippedSources.length > 0) {
    logWarn("import.partial_source_status", {
      xStatus: xResult.status,
      blueskyStatus: blueskyResult.status,
      failedSources: failedSources.map((result) => result.source),
      skippedSources: skippedSources.map((result) => result.source),
      failureMessages: failedSources.map((result) => `${result.source}: ${result.message}`),
      skipMessages: skippedSources.map((result) => `${result.source}: ${result.message}`)
    });
  }

  logInfo("import.summary", {
    xFetchedCount: xPosts.length,
    blueskyFetchedCount: blueskyPosts.length,
    candidateCount: candidates.length,
    notionAddedCount,
    duplicateSkippedCount: duplicateSkipCount,
    errorCount: sourceErrors.length,
    xStatus: xResult.status,
    blueskyStatus: blueskyResult.status,
    dryRun
  });

  if (successfulSources.length === 0) {
    throw new AppError(`All sources were unavailable: ${unavailableMessages.join(" | ") || "no source completed successfully"}`, {
      source: "import"
    });
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error) => {
    logError("import.failed", {
      message: error.message,
      source: error.source ?? "app"
    });
    process.exitCode = 1;
  });
}

export { main };
