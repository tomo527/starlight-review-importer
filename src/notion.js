import {
  AppError,
  buildPlaceholderTitle,
  fetchJson,
  logInfo,
  logWarn,
  normalizeUrl
} from "./utils.js";

const NOTION_API_BASE_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";

function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_VERSION
  };
}

async function notionRequest(path, { token, method = "GET", body, timeoutMs, source = "Notion" }) {
  return fetchJson(`${NOTION_API_BASE_URL}${path}`, {
    method,
    headers: notionHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
    source,
    timeoutMs
  });
}

function findTitleProperty(properties) {
  const exact = Object.values(properties).find((property) => property.name === "作品名" && property.type === "title");
  if (exact) {
    return exact;
  }

  return Object.values(properties).find((property) => property.type === "title") ?? null;
}

export async function getNotionSchema({ token, dataSourceId, timeoutMs }) {
  const dataSource = await notionRequest(`/data_sources/${dataSourceId}`, {
    token,
    timeoutMs,
    source: "Notion schema"
  });

  const properties = dataSource.properties ?? {};
  const title = findTitleProperty(properties);
  const url = properties["作品URL"] ?? null;
  const updatedAt = properties["更新日"] ?? null;
  const author = properties["投稿者アカウント名"] ?? null;

  if (!title) {
    throw new AppError(
      "Notion schema error: title property was not found. Use a title property such as `作品名` in the target data source.",
      { source: "Notion schema" }
    );
  }

  if (!url) {
    throw new AppError("Notion schema error: required property `作品URL` was not found.", {
      source: "Notion schema"
    });
  }

  if (url.type !== "url") {
    throw new AppError(
      `Notion schema error: property \`作品URL\` must be type \`url\`, but was \`${url.type}\`.`,
      { source: "Notion schema" }
    );
  }

  if (!updatedAt) {
    throw new AppError("Notion schema error: required property `更新日` was not found.", {
      source: "Notion schema"
    });
  }

  if (updatedAt.type !== "date") {
    throw new AppError(
      `Notion schema error: property \`更新日\` must be type \`date\`, but was \`${updatedAt.type}\`.`,
      { source: "Notion schema" }
    );
  }

  if (author && author.type !== "rich_text") {
    logWarn("notion.schema.optional_property_skipped", {
      property: author.name,
      reason: `expected rich_text but found ${author.type}`
    });
  }

  logInfo("notion.schema.ready", {
    titleProperty: title.name,
    urlProperty: url.name,
    updatedAtProperty: updatedAt.name,
    authorProperty: author?.type === "rich_text" ? author.name : null
  });

  return {
    titlePropertyName: title.name,
    urlPropertyName: url.name,
    updatedAtPropertyName: updatedAt.name,
    authorPropertyName: author?.type === "rich_text" ? author.name : null
  };
}

function extractUrlPropertyValue(page, propertyName) {
  const property = page.properties?.[propertyName];
  if (!property || property.type !== "url" || !property.url) {
    return null;
  }

  return normalizeUrl(property.url);
}

export async function listExistingUrls({ token, dataSourceId, urlPropertyName, timeoutMs }) {
  const urls = new Set();
  let startCursor;

  do {
    const payload = await notionRequest(`/data_sources/${dataSourceId}/query`, {
      token,
      method: "POST",
      timeoutMs,
      source: "Notion query",
      body: {
        page_size: 100,
        start_cursor: startCursor
      }
    });

    for (const result of payload.results ?? []) {
      const normalized = extractUrlPropertyValue(result, urlPropertyName);
      if (normalized) {
        urls.add(normalized);
      }
    }

    startCursor = payload.has_more ? payload.next_cursor : null;
  } while (startCursor);

  logInfo("notion.query.complete", { existingUrlCount: urls.size });
  return urls;
}

function buildProperties(entry, schema) {
  const properties = {
    [schema.titlePropertyName]: {
      title: [
        {
          type: "text",
          text: {
            content: buildPlaceholderTitle(entry.source, entry.createdAt, entry.authorHandle, entry.sourceId)
          }
        }
      ]
    },
    [schema.urlPropertyName]: {
      url: entry.url
    },
    [schema.updatedAtPropertyName]: {
      date: {
        start: entry.createdAt
      }
    }
  };

  if (schema.authorPropertyName && entry.authorHandle) {
    properties[schema.authorPropertyName] = {
      rich_text: [
        {
          type: "text",
          text: {
            content: entry.authorHandle
          }
        }
      ]
    };
  }

  return properties;
}

export async function createNotionRecord({ token, dataSourceId, schema, entry, timeoutMs }) {
  return notionRequest("/pages", {
    token,
    method: "POST",
    timeoutMs,
    source: "Notion create",
    body: {
      parent: {
        type: "data_source_id",
        data_source_id: dataSourceId
      },
      properties: buildProperties(entry, schema)
    }
  });
}
