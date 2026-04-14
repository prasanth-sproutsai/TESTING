const fs = require("fs");
const path = require("path");
const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config();
const { buildDynamicSoftwareJobPayload } = require("./job-create-payload");

// Centralized config for stage-2 sanity flow.
const config = {
  baseUrl: process.env.BASE_URL,
  username: process.env.LOGIN_USERNAME,
  password: process.env.PASSWORD,
  orgIdFallback: (process.env.ORG_ID || process.env.SANITY_ORG_ID || "").trim(),
  timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 30_000),
  jobCreatePath: (process.env.JOB_CREATE_PATH || "/job/create").replace(/^\/?/, "/"),
  // Keep this configurable because route naming can differ by deployment.
  postedJobListPath: (process.env.JOB_POSTED_LIST_PATH || "/job/posted").replace(/^\/?/, "/"),
  logFile: process.env.SANITY_STAGE2_LOG_FILE || "logs.txt",
};

const requiredEnv = ["BASE_URL", "LOGIN_USERNAME", "PASSWORD"];

// Timestamp utility for log lines.
function ts() {
  return new Date().toISOString();
}

// Validate required env before any API calls.
function validateEnv() {
  const missing = requiredEnv.filter((k) => !process.env[k]?.trim?.());
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

// Normalize base URL to avoid double slashes.
function normalizeBaseUrl(baseUrl) {
  return String(baseUrl).replace(/\/+$/, "");
}

// Build login URL. If BASE_URL already points to /login, keep it.
function buildLoginUrl(baseUrl) {
  const trimmed = normalizeBaseUrl(baseUrl);
  if (/\/login$/i.test(trimmed)) return trimmed;
  return `${trimmed}/user/auth`;
}

// Build endpoint URL from base + path.
function buildUrl(baseUrl, routePath) {
  return `${normalizeBaseUrl(baseUrl)}${routePath}`;
}

// Console + file logger with timestamp.
function createLogger(filePath) {
  const dir = path.dirname(filePath);
  if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  return (level, message) => {
    const line = `[${ts()}] [${level}] ${message}`;
    console.log(line);
    fs.appendFileSync(filePath, `${line}\n`, "utf8");
  };
}

// Normalize API errors into readable message.
function formatError(error) {
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

// Extract authToken + uid + orgId from common response structures.
function extractSession(payload) {
  let root = payload?.data ?? payload;
  if (root && typeof root === "object" && root.data && (root.data.token || root.data.user)) {
    root = root.data;
  }

  const authToken =
    root.authToken ||
    root.token ||
    root.accessToken ||
    root.access_token ||
    root.jwt ||
    root?.data?.token;

  const userId =
    (typeof root.user === "string" && root.user.trim()) ||
    root.uid ||
    root.userId ||
    root.user_id ||
    root?.data?.uid ||
    root?.data?.userId ||
    null;

  const orgId =
    root.orgId ||
    root.org_id ||
    root.organizationId ||
    root?.organization?._id ||
    root?.data?.orgId ||
    root?.data?.organizationId ||
    config.orgIdFallback ||
    null;

  return { authToken, userId, orgId };
}

// Extract job id from create job response.
function extractJobId(payload) {
  let root = payload?.data ?? payload;
  if (root && typeof root === "object" && root.data && (root.data.job || root.data.newJob)) {
    root = root.data;
  }
  const job = root.job ?? root.newJob ?? root.data?.job;
  return String(job?._id ?? job?.id ?? root.jobId ?? root.id ?? root._id ?? "");
}

// Extract list content array from getPostedJobList response.
function extractPostedContent(payload) {
  const root = payload?.data ?? payload;
  if (Array.isArray(root.content)) return root.content;
  if (Array.isArray(root.data?.content)) return root.data.content;
  if (Array.isArray(root.jobs)) return root.jobs;
  return [];
}

// Stage-1: login and session extraction.
async function login(http, log) {
  const url = buildLoginUrl(config.baseUrl);
  log("INFO", `Login | POST ${url}`);
  const response = await http.post(url, {
    username: config.username,
    password: config.password,
  });
  if (response.status !== 200) throw new Error(`Unexpected login status ${response.status}`);

  const session = extractSession(response.data);
  const missing = [];
  if (!session.authToken) missing.push("authToken");
  if (!session.userId) missing.push("userId (uid)");
  if (!session.orgId) missing.push("orgId");
  if (missing.length) {
    throw new Error(
      `Login response missing ${missing.join(", ")}. Set ORG_ID if orgId is not in login payload.`
    );
  }

  log("SUCCESS", "Login OK | authToken, userId, orgId extracted");
  return session;
}

// Stage-2: create a job used by later validation.
async function createJob(http, log, session) {
  const url = buildUrl(config.baseUrl, config.jobCreatePath);
  const body = buildDynamicSoftwareJobPayload();
  const headers = {
    Authorization: `Bearer ${session.authToken}`,
    uid: String(session.userId),
    org_id: String(session.orgId),
    "Content-Type": "application/json",
  };

  log("INFO", `Create job | POST ${url} | name="${body.name}"`);
  const response = await http.post(url, body, {
    headers,
    validateStatus: (status) => status === 200 || status === 201,
  });

  const jobId = extractJobId(response.data);
  if (!jobId) throw new Error("Job created but jobId not found in response.");
  log("SUCCESS", `Job created | jobId=${jobId} | status=${response.status}`);
  return { jobId, name: body.name };
}

// Stage-3 (next stage from PDF): call getPostedJobList and validate created job presence.
async function getPostedJobListAndValidate(http, log, session, expectedJobId) {
  const url = buildUrl(config.baseUrl, config.postedJobListPath);
  const headers = {
    Authorization: `Bearer ${session.authToken}`,
    uid: String(session.userId),
    org_id: String(session.orgId),
  };
  const params = {
    status: "active",
    page: 1,
    limit: 20,
  };

  log("INFO", `Posted jobs | GET ${url} | status=${params.status} page=${params.page}`);
  const response = await http.get(url, {
    headers,
    params,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const content = extractPostedContent(response.data);
  const found = content.some((j) => String(j.id ?? j._id ?? "") === String(expectedJobId));

  if (found) {
    log("SUCCESS", `Validation passed | created job present in posted list | jobId=${expectedJobId}`);
    return;
  }

  log(
    "ERROR",
    `Validation failed | created job not found in posted list (items=${content.length}) | jobId=${expectedJobId}`
  );
  throw new Error("Created job not found in getPostedJobList response.");
}

// Main runner: login -> create job -> get posted list -> validate.
async function main() {
  validateEnv();
  const logPath = path.resolve(process.cwd(), config.logFile);
  const log = createLogger(logPath);
  const http = axios.create({ timeout: config.timeoutMs });

  log("INFO", `Stage-2 sanity flow started | logFile=${logPath}`);
  try {
    const session = await login(http, log);
    const created = await createJob(http, log, session);
    await getPostedJobListAndValidate(http, log, session, created.jobId);
    log("INFO", "Stage-2 sanity flow completed successfully");
  } catch (error) {
    log("ERROR", formatError(error));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[${ts()}] [FATAL]`, err);
  process.exit(1);
});

