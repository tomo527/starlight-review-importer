const DEFAULT_TIMEOUT_MS = 15000;
const PLACEHOLDER_TIMEZONE = "Asia/Tokyo";
const DEFAULT_USER_AGENT = "starlight-review-importer/1.0 (+https://github.com/tomo527/starlight-review-importer)";

export class AppError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.source = options.source ?? "app";
  }
}

export function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new AppError(`Missing required environment variable: ${name}`, { source: "config" });
  }

  return value.trim();
}

export function getOptionalEnv(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

export function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError(`${name} must be a positive integer. Received: ${value}`, { source: "config" });
  }

  return parsed;
}

export function parseBooleanEnv(value, fallback = false) {
  if (value == null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function getTimeoutMs() {
  return parsePositiveInteger(getOptionalEnv("HTTP_TIMEOUT_MS", String(DEFAULT_TIMEOUT_MS)), "HTTP_TIMEOUT_MS");
}

export function sanitizeHashtag(value) {
  return String(value).trim().replace(/^#/, "");
}

export function createTimeWindow(lookbackHours, now = new Date()) {
  const nowDate = new Date(now);
  const cutoffDate = new Date(nowDate.getTime() - lookbackHours * 60 * 60 * 1000);

  return {
    now: nowDate,
    nowIso: nowDate.toISOString(),
    cutoff: cutoffDate,
    cutoffIso: cutoffDate.toISOString()
  };
}

export function isWithinTimeWindow(value, cutoff, now) {
  const date = new Date(value);
  const time = date.getTime();

  if (Number.isNaN(time)) {
    return false;
  }

  return time >= cutoff.getTime() && time <= now.getTime();
}

export function formatPlaceholderDate(isoString) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: PLACEHOLDER_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  return formatter.format(new Date(isoString));
}

export function buildPlaceholderTitle(source, createdAt, authorHandle, sourceId) {
  const dateText = formatPlaceholderDate(createdAt);
  const fallbackToken = sourceId ? String(sourceId).split("/").at(-1) ?? String(sourceId) : null;
  const fallbackId = fallbackToken ? `post ${fallbackToken}` : "post";
  const handleText = authorHandle ?? fallbackId;
  return `[自動取込] ${source} ${dateText} ${handleText}`;
}

export function normalizeUrl(value) {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(String(value).trim());
    const hostname = url.hostname.toLowerCase();
    const normalizedHost =
      hostname === "twitter.com" ||
      hostname === "www.twitter.com" ||
      hostname === "mobile.twitter.com" ||
      hostname === "www.x.com" ||
      hostname === "mobile.x.com"
        ? "x.com"
        : hostname;

    url.protocol = "https:";
    url.hostname = normalizedHost;
    url.hash = "";
    url.search = "";

    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
      url.port = "";
    }

    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }

    return url.toString();
  } catch {
    return null;
  }
}

export function formatFields(fields = {}) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return "";
  }

  const suffix = entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ");
  return ` ${suffix}`;
}

export function logInfo(message, fields) {
  console.log(`${new Date().toISOString()} INFO ${message}${formatFields(fields)}`);
}

export function logWarn(message, fields) {
  console.warn(`${new Date().toISOString()} WARN ${message}${formatFields(fields)}`);
}

export function logError(message, fields) {
  console.error(`${new Date().toISOString()} ERROR ${message}${formatFields(fields)}`);
}

export async function fetchJson(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    source = "http",
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const mergedHeaders = {
    Accept: "application/json, text/plain, */*",
    "User-Agent": DEFAULT_USER_AGENT,
    ...headers
  };

  try {
    const response = await fetch(url, {
      method,
      headers: mergedHeaders,
      body,
      signal: controller.signal
    });

    const text = await response.text();

    if (!response.ok) {
      throw new AppError(`[${source}] HTTP ${response.status} ${response.statusText}: ${truncate(text, 600)}`, {
        source
      });
    }

    const parsed = parseJsonSafely(text);
    return parsed;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (error?.name === "AbortError") {
      throw new AppError(`[${source}] Request timed out after ${timeoutMs}ms`, { source, cause: error });
    }

    if (error instanceof SyntaxError) {
      throw new AppError(`[${source}] Failed to parse JSON response: ${error.message}`, {
        source,
        cause: error
      });
    }

    throw new AppError(`[${source}] Request failed: ${error.message}`, { source, cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

export function truncate(value, maxLength) {
  if (typeof value !== "string" || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

function parseJsonSafely(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new SyntaxError(error.message);
  }
}
