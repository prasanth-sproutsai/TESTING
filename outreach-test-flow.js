/**
 * Outreach automation for CI: login → job details → match profiles → (optional) real sequence send.
 *
 * SAFETY: By default this script does NOT call any send or template-generation APIs (dry run).
 * To actually hit generate-personalized-email + sequence/job/create (emails candidates), set:
 *   OUTREACH_ALLOW_REAL_SEND=1
 * Use only on disposable test data / isolated environments.
 *
 * --- Inputs you must provide (environment or Jenkins credentials → .env) ---
 * Required:
 *   BASE_URL              API base (e.g. https://dev.api.sproutsai.com)
 *   LOGIN_USERNAME        Account email/username for auth
 *   PASSWORD              Account password
 *   JOB_DETAILS_JOB_ID    Existing job id that already has sourced/match profiles with emails
 * Optional (same semantics as sanity-job-flow.js):
 *   ORG_ID / SANITY_ORG_ID
 *   REQUEST_TIMEOUT_MS, JOB_DETAILS_PATH, JOB_DETAILS_QUERY, MATCH_PROFILES_*, etc.
 *   GENERATE_PERSONALIZED_EMAIL_PATH, SEQUENCE_CREATE_PATH, SEQUENCE_ID, FROM_EMAIL, FROM_EMAIL_ADDRESS
 *   OUTREACH_SUBJECT, OUTREACH_BODY, ORG_NAME
 *   OUTREACH_ALLOW_REAL_SEND   Set to "1" or "true" only when real outreach APIs must run (otherwise dry run).
 * Optional result / strictness:
 *   OUTREACH_RESULT_FILE           JSON summary path (default: outreach-flow-result.json)
 *   OUTREACH_LOG_FILE              Log file path (default: logs/outreach-test.log)
 *   OUTREACH_IGNORE_SEQUENCE_ERRORS   Set to "1" if HTTP 200 with summary.errors > 0 should not fail the build
 *
 * --- Optional: assert “interested” / replies via your own API ---
 * Your backend must expose a GET that returns JSON; configure:
 *   OUTREACH_INTEREST_POLL_PATH      e.g. /your-service/jobs/{jobId}/outreach-metrics  ({jobId} is substituted)
 *   OUTREACH_INTEREST_POLL_INTERVAL_MS   default 30000
 *   OUTREACH_INTEREST_POLL_MAX_ATTEMPTS    default 20
 *   OUTREACH_INTEREST_JSON_PATH      Dot path to a number or boolean, e.g. data.interestedCount or data.hasReply
 *   OUTREACH_INTEREST_MIN_COUNT      When JSON path resolves to a number, success if value >= this (default 1)
 * If OUTREACH_INTEREST_POLL_PATH is unset, the script skips polling (email replies are async; you need either
 * an internal API, webhook tests, or a synthetic test inbox—this hook is for when you have the contract).
 */

const path = require("path");
const fs = require("fs");
const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config();

const { isoTimestamp, createDualLogger, sleep, normalizeBaseUrl, browserLikeGetHeaders } = require("./job-flow-common");
const { login } = require("./job-stage-login");
const { getJobDetails } = require("./job-stage-get-details");
const { getMatchProfiles } = require("./job-stage-get-match-profiles");
const { runOutreach } = require("./job-stage-outreach");

// --- Build config from env (aligned with sanity-job-flow.js outreach + dependencies) ---
function buildConfig() {
  return {
    baseUrl: process.env.BASE_URL,
    username: process.env.LOGIN_USERNAME,
    password: process.env.PASSWORD,
    timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 30_000),
    orgIdFallback: (process.env.ORG_ID || process.env.SANITY_ORG_ID || "").trim(),
    requestOrigin: (process.env.JOB_REQUEST_ORIGIN || "https://test.app.sproutsai.com").trim(),
    requestReferer: (process.env.JOB_REQUEST_REFERER || "https://test.app.sproutsai.com/").trim(),
    requestUserAgent: (process.env.JOB_REQUEST_USER_AGENT || "").trim(),
    jobDetailsPath: (process.env.JOB_DETAILS_PATH || "/job/job_details").replace(/\/+$/, ""),
    jobDetailsQuery: (process.env.JOB_DETAILS_QUERY || "status=active").trim(),
    matchProfilesPath: (process.env.MATCH_PROFILES_PATH || "/job/get_match_profiles").replace(/\/+$/, ""),
    matchProfilesMethod: (process.env.MATCH_PROFILES_METHOD || "POST").trim().toUpperCase(),
    matchProfilesSource: (process.env.MATCH_PROFILES_SOURCE || "Prospect").trim(),
    matchProfilesThumbsUp: (process.env.MATCH_PROFILES_THUMBS_UP || "0").trim(),
    matchProfilesLimit: Math.max(1, parseInt(process.env.MATCH_PROFILES_LIMIT || "20", 10) || 20),
    matchProfilesPage: Math.max(1, parseInt(process.env.MATCH_PROFILES_PAGE || "1", 10) || 1),
    matchProfilesMaxAttempts: Math.max(1, parseInt(process.env.MATCH_PROFILES_MAX_ATTEMPTS || "3", 10) || 3),
    matchProfilesBackoffMs: Math.max(100, parseInt(process.env.MATCH_PROFILES_BACKOFF_MS || "1000", 10) || 1000),
    generatePersonalizedEmailPath: (
      process.env.GENERATE_PERSONALIZED_EMAIL_PATH || "/email/email-templates/generate-personalized-email"
    ).replace(/\/+$/, ""),
    sequenceCreatePath: (process.env.SEQUENCE_CREATE_PATH || "/sequence/job/create").replace(/\/+$/, ""),
    outreachSubject: (process.env.OUTREACH_SUBJECT || "Exciting opportunity").trim(),
    outreachBody: (process.env.OUTREACH_BODY || "We found your profile interesting").trim(),
    sequenceId: (process.env.SEQUENCE_ID || "").trim(),
    fromEmail: (process.env.FROM_EMAIL || "").trim(),
    fromEmailAddress: (process.env.FROM_EMAIL_ADDRESS || "").trim(),
    orgName: (process.env.ORG_NAME || "").trim(),
    outreachAllowRealSend:
      process.env.OUTREACH_ALLOW_REAL_SEND === "1" || process.env.OUTREACH_ALLOW_REAL_SEND === "true",
    resultFile: (process.env.OUTREACH_RESULT_FILE || "outreach-flow-result.json").trim(),
    logFile: (process.env.OUTREACH_LOG_FILE || "logs/outreach-test.log").trim(),
    ignoreSequenceErrors:
      process.env.OUTREACH_IGNORE_SEQUENCE_ERRORS === "1" ||
      process.env.OUTREACH_IGNORE_SEQUENCE_ERRORS === "true",
    interestPollPath: (process.env.OUTREACH_INTEREST_POLL_PATH || "").trim(),
    interestPollIntervalMs: Math.max(
      1000,
      parseInt(process.env.OUTREACH_INTEREST_POLL_INTERVAL_MS || "30000", 10) || 30000
    ),
    interestPollMaxAttempts: Math.max(1, parseInt(process.env.OUTREACH_INTEREST_POLL_MAX_ATTEMPTS || "20", 10) || 20),
    interestJsonPath: (process.env.OUTREACH_INTEREST_JSON_PATH || "").trim(),
    interestMinCount: Math.max(0, parseInt(process.env.OUTREACH_INTEREST_MIN_COUNT || "1", 10) || 1),
  };
}

function validateRequired(cfg, jobId) {
  const missing = [];
  if (!cfg.baseUrl?.trim()) missing.push("BASE_URL");
  if (!cfg.username?.trim()) missing.push("LOGIN_USERNAME");
  if (!cfg.password?.trim()) missing.push("PASSWORD");
  if (!jobId) missing.push("JOB_DETAILS_JOB_ID");
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

// --- Read nested property by dot path (e.g. data.interestedCount) ---
function readDotPath(obj, dotPath) {
  const parts = String(dotPath)
    .split(".")
    .map((p) => p.trim())
    .filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

// --- Poll GET endpoint until numeric threshold or boolean true ---
async function pollInterestSignal(http, log, session, cfg, jobId) {
  if (!cfg.interestPollPath) {
    log(
      "INFO",
      "Interest poll skipped | set OUTREACH_INTEREST_POLL_PATH + OUTREACH_INTEREST_JSON_PATH when your API is ready"
    );
    return { skipped: true };
  }
  if (!cfg.interestJsonPath) {
    throw new Error("OUTREACH_INTEREST_POLL_PATH is set but OUTREACH_INTEREST_JSON_PATH is empty");
  }

  const base = normalizeBaseUrl(cfg.baseUrl);
  const pathWithId = cfg.interestPollPath.replace(/\{jobId\}/g, String(jobId).trim());
  const url = pathWithId.startsWith("http") ? pathWithId : `${base}${pathWithId.replace(/^\/?/, "/")}`;

  log(
    "INFO",
    `Interest poll | GET ${url} | every ${cfg.interestPollIntervalMs}ms | maxAttempts=${cfg.interestPollMaxAttempts}`
  );

  for (let attempt = 1; attempt <= cfg.interestPollMaxAttempts; attempt++) {
    const response = await http.get(url, {
      headers: {
        ...browserLikeGetHeaders(session, cfg),
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    });

    if (response.status !== 200) {
      log("WARN", `Interest poll attempt ${attempt} | HTTP ${response.status}`);
    } else {
      const value = readDotPath(response.data, cfg.interestJsonPath);
      log("INFO", `Interest poll attempt ${attempt} | ${cfg.interestJsonPath}=${JSON.stringify(value)}`);

      if (value === true) {
        return { ok: true, attempts: attempt, lastValue: value };
      }
      const n = Number(value);
      if (Number.isFinite(n) && n >= cfg.interestMinCount) {
        return { ok: true, attempts: attempt, lastValue: n };
      }
    }

    if (attempt < cfg.interestPollMaxAttempts) {
      await sleep(cfg.interestPollIntervalMs);
    }
  }

  return { ok: false, attempts: cfg.interestPollMaxAttempts, reason: "threshold_not_met" };
}

async function main() {
  const cfg = buildConfig();
  const jobId = String(process.env.JOB_DETAILS_JOB_ID || "").trim();
  validateRequired(cfg, jobId);

  const logPath = path.resolve(process.cwd(), cfg.logFile);
  const log = createDualLogger(logPath);
  const http = axios.create({ timeout: cfg.timeoutMs });

  const result = {
    startedAt: new Date().toISOString(),
    jobId,
    outreach: null,
    interestPoll: null,
    finishedAt: null,
    ok: false,
  };

  log("INFO", `Outreach test flow | jobId=${jobId} | logFile=${logPath}`);

  try {
    // --- Authenticate ---
    const session = await login(http, log, cfg);

    // --- Load job (org name, title, etc. for sequence payload) ---
    const { job } = await getJobDetails(http, log, session, jobId, cfg);

    // --- Prospect list (safe: read-only vs candidates) ---
    const stage7 = await getMatchProfiles(http, log, session, jobId, cfg);

    // --- Templates + sequence: only when OUTREACH_ALLOW_REAL_SEND=1 (otherwise dry run, no emails) ---
    if (!cfg.outreachAllowRealSend) {
      log(
        "WARN",
        "DRY RUN | no outreach APIs called | set OUTREACH_ALLOW_REAL_SEND=1 only in an isolated env to send for real"
      );
      result.outreach = { skipped: true, reason: "outreach_send_disabled", dryRun: true };
    } else {
      const outreachResult = await runOutreach(http, log, session, stage7, job, cfg);
      result.outreach = outreachResult;

      if (outreachResult?.skipped) {
        log("ERROR", `Outreach did not run | reason=${outreachResult.reason || "unknown"}`);
        throw new Error("Outreach skipped: no candidates with email on match profiles");
      }

      const summary = outreachResult?.stepB?.summary;
      if (summary && Number(summary.errors) > 0 && !cfg.ignoreSequenceErrors) {
        log("ERROR", `Sequence reported errors=${summary.errors} | set OUTREACH_IGNORE_SEQUENCE_ERRORS=1 to allow`);
        throw new Error(`Outreach sequence completed with errors=${summary.errors}`);
      }
    }

    // --- Optional: wait for “interested” signal (only after a real send attempt) ---
    if (cfg.outreachAllowRealSend) {
      result.interestPoll = await pollInterestSignal(http, log, session, cfg, jobId);
      if (!result.interestPoll.skipped && !result.interestPoll.ok) {
        throw new Error("Interest poll finished without meeting success criteria");
      }
    } else {
      result.interestPoll = { skipped: true, reason: "dry_run" };
    }

    result.ok = true;
    result.finishedAt = new Date().toISOString();
    log(
      "SUCCESS",
      cfg.outreachAllowRealSend ? "Outreach test flow completed (live send was enabled)" : "Outreach test flow completed (DRY RUN — no emails sent)"
    );

    const outPath = path.resolve(process.cwd(), cfg.resultFile);
    const dir = path.dirname(outPath);
    if (dir && dir !== "." && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    log("INFO", `Wrote result artifact | ${outPath}`);

    console.log(cfg.outreachAllowRealSend ? "\nRESULT: SUCCESS\n" : "\nRESULT: SUCCESS (DRY RUN — no outreach emails sent)\n");
  } catch (err) {
    result.ok = false;
    result.error = err?.message || String(err);
    result.finishedAt = new Date().toISOString();
    try {
      const outPath = path.resolve(process.cwd(), cfg.resultFile);
      fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    } catch {
      /* ignore secondary write failures */
    }
    log("ERROR", err?.message || String(err));
    console.log("\nRESULT: FAILED\n");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[${isoTimestamp()}] [FATAL]`, err);
  process.exit(1);
});
