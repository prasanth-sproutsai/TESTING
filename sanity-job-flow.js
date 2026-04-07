const fs = require("fs");
const path = require("path");
const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config();

// --- configuration (env-driven) ---
const config = {
  baseUrl: process.env.BASE_URL,
  username: process.env.LOGIN_USERNAME,
  password: process.env.PASSWORD,
  timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 30_000),
  // Path segment for job creation (PDF-backed handler expects name, company, location + org_id/uid headers).
  jobCreatePath: (process.env.JOB_CREATE_PATH || "/job/create").replace(/^\/?/, "/"),
  jobCompany: process.env.JOB_COMPANY || "Sanity Automation Co",
  jobLocation: process.env.JOB_LOCATION || "Remote",
  logFile: process.env.SANITY_LOG_FILE || "logs.txt",
  // Some deployments omit org on /user/auth; set explicitly when needed.
  orgIdFallback: (process.env.ORG_ID || process.env.SANITY_ORG_ID || "").trim(),
};

const requiredEnv = ["BASE_URL", "LOGIN_USERNAME", "PASSWORD"];

// --- small utilities ---
function isoTimestamp() {
  return new Date().toISOString();
}

function validateEnv() {
  const missing = requiredEnv.filter((key) => !process.env[key]?.trim?.());
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
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

// Append timestamped lines to logs.txt and mirror to console.
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
function extractSession(payload) {
  let root = payload?.data ?? payload;
  // Unwrap { code, message, data: { token, user, organization, ... } } (Sprouts-style).
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

  if (!orgId && config.orgIdFallback) {
    orgId = config.orgIdFallback;
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

// --- API steps ---
async function login(http, log) {
  const loginUrl = buildLoginUrl(config.baseUrl);
  log("INFO", `Login | POST ${loginUrl}`);

  try {
    const response = await http.post(loginUrl, {
      username: config.username,
      password: config.password,
    });

    if (response.status !== 200) {
      throw new Error(`Unexpected login status ${response.status}`);
    }

    const session = extractSession(response.data);
    const missing = [];
    if (!session.authToken) missing.push("authToken");
    if (!session.userId) missing.push("userId (uid)");
    if (!session.orgId) missing.push("orgId");

    if (missing.length) {
      log("ERROR", `Login response missing: ${missing.join(", ")}`);
      throw new Error(
        `Login succeeded but could not parse session fields (${missing.join(
          ", "
        )}). For orgId, set ORG_ID (or SANITY_ORG_ID) in .env if your API omits it.`
      );
    }

    log("SUCCESS", "Login OK | authToken, userId, orgId extracted");
    return session;
  } catch (error) {
    const detail = error.response ? formatAxiosError(error) : error.message;
    log("ERROR", `Login failed | ${detail}`);
    throw error;
  }
}

async function createJob(http, log, session) {
  const jobUrl = buildJobCreateUrl(config.baseUrl, config.jobCreatePath);
  const jobName = `Automation Job ${isoTimestamp()}`;

  const body = {
    name: jobName,
    company: config.jobCompany,
    location: config.jobLocation,
  };

  const headers = {
    Authorization: `Bearer ${session.authToken}`,
    uid: String(session.userId),
    org_id: String(session.orgId),
    "Content-Type": "application/json",
  };

  log("INFO", `Create job | POST ${jobUrl} | name="${jobName}"`);

  try {
    const response = await http.post(jobUrl, body, {
      headers,
      validateStatus: (status) => status === 200 || status === 201,
    });

    const jobId = extractJobId(response.data);
    if (!jobId) {
      log(
        "ERROR",
        "Job create returned 200/201 but jobId could not be parsed from response"
      );
      throw new Error(
        "Job created but jobId not found in response (extend extractJobId())"
      );
    }

    log(
      "SUCCESS",
      `Job created | jobId=${jobId} | status=${response.status}`
    );
    return { jobId, status: response.status, raw: response.data };
  } catch (error) {
    const detail = error.response ? formatAxiosError(error) : error.message;
    log("ERROR", `Job creation failed | ${detail}`);
    throw error;
  }
}

// --- orchestration ---
async function main() {
  try {
    validateEnv();
  } catch (err) {
    console.error(`[${isoTimestamp()}] [FATAL] ${err.message}`);
    process.exit(1);
    return;
  }

  const logPath = path.resolve(process.cwd(), config.logFile);
  const log = createDualLogger(logPath);

  log("INFO", `Sanity flow started | logFile=${logPath}`);

  const http = axios.create({
    timeout: config.timeoutMs,
  });

  try {
    const session = await login(http, log);
    await createJob(http, log, session);
    log("INFO", "Sanity flow completed successfully");
  } catch {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[${isoTimestamp()}] [FATAL]`, err);
  process.exit(1);
});
