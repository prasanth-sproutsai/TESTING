/**
 * Shared helpers for job sanity flows (login / create / details / auto-source / saved filter).
 * Stage-specific logic lives in job-stage-*.js files.
 */

const fs = require("fs");
const path = require("path");

function isoTimestamp() {
  return new Date().toISOString();
}

// Append timestamped lines to a log file and mirror to console.
function createDualLogger(logFilePath) {
  const dir = path.dirname(logFilePath);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return (level, message) => {
    const line = `[${isoTimestamp()}] [${level}] ${message}`;
    console.log(line);
    fs.appendFileSync(logFilePath, `${line}\n`, "utf8");
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl).replace(/\/+$/, "");
}

function buildLoginUrl(baseUrl) {
  const trimmed = normalizeBaseUrl(baseUrl);
  if (/\/login$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/user/auth`;
}

function buildJobCreateUrl(baseUrl, jobPath) {
  return `${normalizeBaseUrl(baseUrl)}${jobPath}`;
}

function formatAxiosError(error) {
  const status = error?.response?.status;
  const data = error?.response?.data;
  const msg =
    (typeof data === "string" && data) ||
    data?.message ||
    data?.error ||
    error?.message ||
    "Unknown request failure";
  return status ? `HTTP ${status}: ${msg}` : String(msg);
}

// Normalize Mongo-style ids (ObjectId object or string).
function pickId(value) {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "object") {
    if (value._id != null) return String(value._id);
    if (value.id != null) return String(value.id);
  }
  return null;
}

// Pull auth fields from common API response shapes.
function extractSession(payload, orgIdFallback) {
  let root = payload?.data ?? payload;
  if (
    root &&
    typeof root === "object" &&
    root.data &&
    (root.data.token || root.data.user)
  ) {
    root = root.data;
  }

  const userObj = root.user && typeof root.user === "object" ? root.user : null;
  const user = userObj ?? root.data?.user ?? root.profile;

  const authToken =
    root.authToken ||
    root.token ||
    root.accessToken ||
    root.access_token ||
    root.jwt ||
    root.Authorization ||
    root.authorization ||
    root?.user?.token ||
    root?.data?.token;

  let userId = null;
  if (typeof root.user === "string" && root.user.trim()) {
    userId = root.user.trim();
  } else if (typeof root.user === "number") {
    userId = String(root.user);
  } else {
    userId =
      root.uid ??
      root.userId ??
      root.user_id ??
      pickId(user) ??
      root?.data?.uid ??
      root?.data?.userId;
  }

  let orgId =
    root.orgId ??
    root.organizationId ??
    root.org_id ??
    pickId(root.organization) ??
    pickId(root.org);

  if (!orgId && user) {
    const o = user.organization ?? user.org ?? user.orgId ?? user.organizationId;
    orgId = typeof o === "string" || typeof o === "number" ? String(o) : pickId(o);
  }

  if (!orgId) {
    orgId = root?.data?.orgId ?? root?.data?.organizationId;
  }

  if (!orgId && user) {
    const first =
      Array.isArray(user.organizations) && user.organizations.length
        ? user.organizations[0]
        : null;
    orgId = pickId(first);
  }

  if (!orgId) {
    orgId =
      pickId(root.defaultOrganization) ||
      pickId(root.activeOrganization) ||
      pickId(user?.defaultOrganization) ||
      pickId(user?.activeOrganization);
  }

  if (!orgId && orgIdFallback) {
    orgId = orgIdFallback;
  }

  return { authToken, userId, orgId };
}

function extractJobId(payload) {
  let root = payload?.data ?? payload;
  if (
    root &&
    typeof root === "object" &&
    root.data &&
    (root.data.job || root.data.newJob)
  ) {
    root = root.data;
  }

  const job = root.job ?? root.newJob ?? root.data?.job;

  const id =
    job?._id ??
    job?.id ??
    root.jobId ??
    root.id ??
    root._id;

  return id != null ? String(id) : null;
}

// Headers aligned with test.app browser GETs (Origin/Referer/Accept). No If-None-Match so responses are always full bodies.
function browserLikeGetHeaders(session, cfg = {}) {
  const origin = (cfg.requestOrigin || "https://test.app.sproutsai.com").trim();
  const referer = (cfg.requestReferer || "https://test.app.sproutsai.com/").trim();
  const ua =
    (cfg.requestUserAgent || "").trim() ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
  return {
    Authorization: `Bearer ${session.authToken}`,
    uid: String(session.userId),
    org_id: String(session.orgId),
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: origin,
    Referer: referer,
    "User-Agent": ua,
  };
}

module.exports = {
  isoTimestamp,
  createDualLogger,
  sleep,
  normalizeBaseUrl,
  buildLoginUrl,
  buildJobCreateUrl,
  formatAxiosError,
  pickId,
  extractSession,
  extractJobId,
  browserLikeGetHeaders,
};
