const fs = require("fs");
const path = require("path");
const axios = require("axios");
const dotenv = require("dotenv");

// Load environment variables from .env in the project root.
dotenv.config();

// Centralized runtime configuration for easy tuning.
const config = {
  baseUrl: process.env.BASE_URL,
  // LOGIN_USERNAME avoids clashing with Windows' built-in USERNAME env var.
  username: process.env.LOGIN_USERNAME,
  password: process.env.PASSWORD,
  intervalMs: Number(process.env.INTERVAL_MS || 60_000),
  durationHours: Number(process.env.DURATION_HOURS || 12),
  timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 15_000),
  logDir: process.env.LOG_DIR || "logs",
  logFileName: process.env.LOG_FILE || "login-stability.log",
};

const requiredEnv = ["BASE_URL", "LOGIN_USERNAME", "PASSWORD"];

// Validate required environment variables before starting any checks.
function validateEnv() {
  const missing = requiredEnv.filter((key) => !process.env[key]?.trim?.());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}`
    );
  }
}

// Ensure the log directory exists so file logging never fails silently.
function ensureLogDirectory(logDirectory) {
  if (!fs.existsSync(logDirectory)) {
    fs.mkdirSync(logDirectory, { recursive: true });
  }
}

// Format current timestamp in ISO format for consistent machine parsing.
function timestamp() {
  return new Date().toISOString();
}

// Write every log line both to console and log file.
function createLogger(logPath) {
  return (level, message) => {
    const line = `[${timestamp()}] [${level}] ${message}`;
    console.log(line);
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
  };
}

// Build the full login endpoint URL safely.
// If BASE_URL already points at a /login route, POST there; otherwise append /user/auth.
function buildLoginUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/login$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/user/auth`;
}

// Execute a single login request and return normalized result data.
async function runSingleLoginCheck(client, loginUrl, credentials) {
  const startedAt = Date.now();
  try {
    const response = await client.post(loginUrl, credentials);
    const elapsedMs = Date.now() - startedAt;
    const ok = response.status === 200;
    return { ok, status: response.status, elapsedMs, error: null };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const status = error?.response?.status ?? null;
    const details =
      error?.response?.data?.message ||
      error?.message ||
      "Unknown request failure";
    return { ok: false, status, elapsedMs, error: details };
  }
}

// Run the monitoring loop for the configured duration and interval.
async function startMonitor() {
  validateEnv();

  const logDirectory = path.resolve(config.logDir);
  ensureLogDirectory(logDirectory);
  const logPath = path.join(logDirectory, config.logFileName);
  const log = createLogger(logPath);

  const loginUrl = buildLoginUrl(config.baseUrl);
  const credentials = {
    username: config.username,
    password: config.password,
  };
  const durationMs = config.durationHours * 60 * 60 * 1000;
  const stopAt = Date.now() + durationMs;

  const client = axios.create({
    timeout: config.timeoutMs,
    headers: {
      "Content-Type": "application/json",
    },
  });

  let total = 0;
  let success = 0;
  let failure = 0;

  log(
    "INFO",
    `Starting login stability monitor | endpoint=${loginUrl} | intervalMs=${config.intervalMs} | durationHours=${config.durationHours}`
  );
  log("INFO", `Log file: ${logPath}`);

  const tick = async () => {
    total += 1;
    const result = await runSingleLoginCheck(client, loginUrl, credentials);
    if (result.ok) {
      success += 1;
      log(
        "SUCCESS",
        `Attempt #${total} | status=${result.status} | responseTimeMs=${result.elapsedMs}`
      );
    } else {
      failure += 1;
      log(
        "ERROR",
        `Attempt #${total} | status=${result.status ?? "NO_STATUS"} | responseTimeMs=${result.elapsedMs} | error="${result.error}"`
      );
    }
  };

  // Trigger immediately once, then continue at the configured interval.
  await tick();

  // Scheduler-friendly mode:
  // If duration is 0 (or negative), run exactly one attempt and exit.
  if (config.durationHours <= 0) {
    log(
      "INFO",
      `Monitor completed | total=${total} success=${success} failure=${failure}`
    );
    process.exit(0);
  }

  const timer = setInterval(async () => {
    if (Date.now() >= stopAt) {
      clearInterval(timer);
      log(
        "INFO",
        `Monitor completed | total=${total} success=${success} failure=${failure}`
      );
      process.exit(0);
      return;
    }
    await tick();
  }, config.intervalMs);
}

// Entrypoint with hard-fail logging for startup/runtime issues.
startMonitor().catch((error) => {
  const errMsg = error?.stack || error?.message || String(error);
  const line = `[${timestamp()}] [FATAL] ${errMsg}`;
  console.error(line);
  process.exit(1);
});
