/**
 * Post-deploy login sanity check (Jenkins-friendly).
 * Performs exactly ONE POST to /user/auth, logs the result, then exits.
 * No intervals, no long-running loops — avoids hammering the API.
 */
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config();

const config = {
  baseUrl: process.env.BASE_URL,
  username: process.env.LOGIN_USERNAME,
  password: process.env.PASSWORD,
  timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 15_000),
  logDir: process.env.LOG_DIR || "logs",
  logFileName: process.env.LOG_FILE || "login-stability.log",
};

const requiredEnv = ["BASE_URL", "LOGIN_USERNAME", "PASSWORD"];

function validateEnv() {
  const missing = requiredEnv.filter((key) => !process.env[key]?.trim?.());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

function ensureLogDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isoTime() {
  return new Date().toISOString();
}

function buildLoginUrl(baseUrl) {
  const trimmed = String(baseUrl).replace(/\/+$/, "");
  if (/\/login$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/user/auth`;
}

function logLine(logPath, level, message) {
  const line = `[${isoTime()}] [${level}] ${message}`;
  console.log(line);
  if (logPath) {
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
  }
}

async function main() {
  validateEnv();

  const logDir = path.resolve(config.logDir);
  ensureLogDirectory(logDir);
  const logPath = path.join(logDir, config.logFileName);

  const loginUrl = buildLoginUrl(config.baseUrl);
  logLine(logPath, "INFO", `Login check | POST ${loginUrl}`);
  logLine(logPath, "INFO", `Log file: ${logPath}`);

  const startedAt = Date.now();
  try {
    const response = await axios.post(
      loginUrl,
      { username: config.username, password: config.password },
      {
        timeout: config.timeoutMs,
        headers: { "Content-Type": "application/json" },
        validateStatus: () => true,
      }
    );

    const elapsedMs = Date.now() - startedAt;

    if (response.status === 200) {
      logLine(
        logPath,
        "SUCCESS",
        `Login OK | status=${response.status} | responseTimeMs=${elapsedMs}`
      );
      process.exit(0);
    }

    const errMsg =
      (typeof response.data === "string" && response.data) ||
      response.data?.message ||
      response.statusText ||
      "Request failed";
    logLine(
      logPath,
      "ERROR",
      `Login failed | status=${response.status} | responseTimeMs=${elapsedMs} | error="${errMsg}"`
    );
    process.exit(1);
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const status = error?.response?.status ?? "NO_STATUS";
    const details =
      error?.response?.data?.message || error?.message || "Unknown request failure";
    logLine(
      logPath,
      "ERROR",
      `Login failed | status=${status} | responseTimeMs=${elapsedMs} | error="${details}"`
    );
    process.exit(1);
  }
}

main().catch((error) => {
  const msg = error?.stack || error?.message || String(error);
  console.error(`[${isoTime()}] [FATAL] ${msg}`);
  process.exit(1);
});
