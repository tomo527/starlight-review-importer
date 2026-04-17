import { pathToFileURL } from "node:url";
import { fetchBlueskyPosts } from "./bluesky.js";
import { createNotionRecord, getNotionSchema, listExistingUrls } from "./notion.js";
import {
  AppError,
  createTimeWindow,
  getOptionalEnv,
  getRequiredEnv,
  getTimeoutMs,
  logError,
  logInfo,
  normalizeUrl,
  parseBooleanEnv,
  parsePositiveInteger,
  sanitizeHashtag
} from "./utils.js";
import { fetchXPosts } from "./x.js";

function aggregateErrors(results) {
  return results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message ?? String(result.reason));
}

async function main() {
  const notionToken = getRequiredEnv("NOTION_TOKEN");
  const notionDataSourceId = getRequiredEnv("NOTION_DATA_SOURCE_ID");
  const xBearerToken = getRequiredEnv("X_BEARER_TOKEN");
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

  const sourceResults = await Promise.allSettled([
    fetchXPosts({
      hashtag,
      bearerToken: xBearerToken,
      cutoff,
      now,
      timeoutMs
    }),
    fetchBlueskyPosts({
      hashtag,
      cutoff,
      now,
      timeoutMs
    })
  ]);

  const xPosts = sourceResults[0].status === "fulfilled" ? sourceResults[0].value : [];
  const blueskyPosts = sourceResults[1].status === "fulfilled" ? sourceResults[1].value : [];
  const sourceErrors = aggregateErrors(sourceResults);

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

  logInfo("import.summary", {
    xFetchedCount: xPosts.length,
    blueskyFetchedCount: blueskyPosts.length,
    candidateCount: candidates.length,
    notionAddedCount,
    duplicateSkippedCount: duplicateSkipCount,
    errorCount: sourceErrors.length,
    dryRun
  });

  if (sourceErrors.length > 0) {
    throw new AppError(`Source fetch completed with errors: ${sourceErrors.join(" | ")}`, {
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
