/**
 * Orchestrator: Login → Create job → Job details → Generate filter → Source candidates → Match profiles → Outreach → (optional) saved filter.
 * Each step is implemented in job-stage-*.js; shared helpers in job-flow-common.js.
 */

const path = require("path");
const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config();
const { buildDynamicSoftwareJobPayload } = require("./job-create-payload");
const { isoTimestamp, createDualLogger, sleep } = require("./job-flow-common");
const { login } = require("./job-stage-login");
const { createJob } = require("./job-stage-create");
const { getJobDetails, validateJobDetails } = require("./job-stage-get-details");
const { getAutoSourceFilter } = require("./job-stage-auto-source-filter");
const { saveAutoSourceFilter } = require("./job-stage-save-auto-source-filter");
const { triggerSourcing } = require("./job-stage-source-candidates");
const { getMatchProfiles } = require("./job-stage-get-match-profiles");
const { runOutreach } = require("./job-stage-outreach");
const { getSavedAutoSourceFilter } = require("./job-stage-get-saved-auto-source-filter");

// --- configuration (env-driven) ---
const config = {
  baseUrl: process.env.BASE_URL,
  username: process.env.LOGIN_USERNAME,
  password: process.env.PASSWORD,
  timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 30_000),
  jobCreatePath: (process.env.JOB_CREATE_PATH || "/job/create").replace(/^\/?/, "/"),
  logFile: process.env.SANITY_LOG_FILE || "logs.txt",
  printPayload: process.env.SANITY_PRINT_PAYLOAD === "1" || process.env.SANITY_PRINT_PAYLOAD === "true",
  orgIdFallback: (process.env.ORG_ID || process.env.SANITY_ORG_ID || "").trim(),
  requestOrigin: (process.env.JOB_REQUEST_ORIGIN || "https://test.app.sproutsai.com").trim(),
  requestReferer: (process.env.JOB_REQUEST_REFERER || "https://test.app.sproutsai.com/").trim(),
  requestUserAgent: (process.env.JOB_REQUEST_USER_AGENT || "").trim(),
  jobDetailsPath: (process.env.JOB_DETAILS_PATH || "/job/job_details").replace(/\/+$/, ""),
  jobDetailsQuery: (process.env.JOB_DETAILS_QUERY || "status=active").trim(),
  autoSourceFilterPath: (process.env.JOB_AUTO_SOURCE_FILTER_PATH || "/job/get_auto_source_filter")
    .replace(/\/+$/, ""),
  autoSourceFilterMaxAttempts: Math.max(
    1,
    parseInt(process.env.JOB_AUTO_SOURCE_FILTER_MAX_ATTEMPTS || "3", 10) || 3
  ),
  autoSourceFilterBackoffMs: Math.max(
    100,
    parseInt(process.env.JOB_AUTO_SOURCE_FILTER_BACKOFF_MS || "1000", 10) || 1000
  ),
  autoSourceFilterLogFull:
    process.env.SANITY_LOG_FILTER_FULL === "1" || process.env.SANITY_LOG_FILTER_FULL === "true",
  saveAutoSourceFilterPath: (process.env.SAVE_AUTO_SOURCE_FILTER_PATH || "/job/save-auto-source-filter")
    .replace(/\/+$/, ""),
  sourcingPath: (process.env.SOURCING_PATH || "/automation/pipeline/sourcing").replace(/\/+$/, ""),
  sourcingCandidateCount: Math.max(1, parseInt(process.env.SOURCING_CANDIDATE_COUNT || "20", 10) || 20),
  sourcingMaxAttempts: Math.max(1, parseInt(process.env.SOURCING_MAX_ATTEMPTS || "3", 10) || 3),
  sourcingBackoffMs: Math.max(100, parseInt(process.env.SOURCING_BACKOFF_MS || "1000", 10) || 1000),
  // Optional idempotency guard within a run.
  sourcingCooldownMs: Math.max(0, parseInt(process.env.SOURCING_COOLDOWN_MS || "0", 10) || 0),
  matchProfilesPath: (process.env.MATCH_PROFILES_PATH || "/job/get_match_profiles").replace(/\/+$/, ""),
  // UI currently uses POST + query for prospect list and returns populated content.
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
  // Safety default: outreach is disabled unless explicitly enabled.
  outreachEnabled:
    process.env.OUTREACH_ENABLED === "1" || process.env.OUTREACH_ENABLED === "true",
  savedAutoSourceFilterPath: (process.env.JOB_SAVED_AUTO_SOURCE_FILTER_PATH || "/job/auto-source-filter")
    .replace(/\/+$/, ""),
  // Ensure saved filter has non-empty skills before triggering sourcing.
  savedAutoSourceFilterRequireSkillsReady:
    process.env.JOB_SAVED_AUTO_SOURCE_FILTER_REQUIRE_SKILLS_READY == null
      ? true
      : !["0", "false"].includes(
          String(process.env.JOB_SAVED_AUTO_SOURCE_FILTER_REQUIRE_SKILLS_READY).toLowerCase()
        ),
  savedAutoSourceFilter404Retries: Math.max(
    0,
    parseInt(process.env.JOB_SAVED_AUTO_SOURCE_FILTER_404_RETRIES || "3", 10) || 3
  ),
  skipSavedAutoSourceFilter:
    process.env.SANITY_SKIP_SAVED_AUTO_SOURCE_FILTER === "1" ||
    process.env.SANITY_SKIP_SAVED_AUTO_SOURCE_FILTER === "true",
  savedAutoSourceFilterPostGenerateDelayMs: Math.max(
    0,
    parseInt(process.env.JOB_SAVED_AUTO_SOURCE_FILTER_POST_GENERATE_MS || "5000", 10) || 5000
  ),
  savedAutoSourceFilter404DelayMinMs: Math.max(
    1000,
    parseInt(process.env.JOB_SAVED_AUTO_SOURCE_FILTER_404_DELAY_MIN_MS || "5000", 10) || 5000
  ),
  savedAutoSourceFilter404DelayMaxMs: Math.max(
    1000,
    parseInt(process.env.JOB_SAVED_AUTO_SOURCE_FILTER_404_DELAY_MAX_MS || "10000", 10) || 10000
  ),
};

const requiredEnv = ["BASE_URL", "LOGIN_USERNAME", "PASSWORD"];

function validateEnv() {
  const missing = requiredEnv.filter((key) => !process.env[key]?.trim?.());
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

async function main() {
  if (process.argv.includes("--print-payload")) {
    console.log(JSON.stringify(buildDynamicSoftwareJobPayload(), null, 2));
    process.exit(0);
    return;
  }

  // Optional: only login + GET job details + validate (no create). Usage: --job-details <jobId>
  const detailsFlagIdx = process.argv.indexOf("--job-details");
  const jobIdFromEnv = (process.env.JOB_DETAILS_JOB_ID || "").trim();
  const jobIdArgAfterFlag =
    detailsFlagIdx >= 0 ? String(process.argv[detailsFlagIdx + 1] || "").trim() : "";
  const jobIdForDetailsOnly = jobIdArgAfterFlag || jobIdFromEnv;

  try {
    validateEnv();
  } catch (err) {
    console.error(`[${isoTimestamp()}] [FATAL] ${err.message}`);
    process.exit(1);
    return;
  }

  const logPath = path.resolve(process.cwd(), config.logFile);
  const log = createDualLogger(logPath);

  const modeLabel =
    detailsFlagIdx >= 0
      ? "Details + generate filter + source + match profiles + outreach (+ optional saved filter)"
      : "Full sanity (create + details + generate filter + source + match profiles + outreach + optional saved filter)";
  log("INFO", `Sanity flow started | ${modeLabel} | logFile=${logPath}`);

  const http = axios.create({
    timeout: config.timeoutMs,
  });

  try {
    const session = await login(http, log, config);

    if (detailsFlagIdx >= 0) {
      if (!jobIdForDetailsOnly) {
        log(
          "ERROR",
          "Missing job id: pass --job-details <jobId> or set JOB_DETAILS_JOB_ID for the id"
        );
        console.log("\nRESULT: FAILED (no job id)\n");
        process.exitCode = 1;
        return;
      }
      const { job } = await getJobDetails(http, log, session, jobIdForDetailsOnly, config);
      const validationErrors = validateJobDetails(job, jobIdForDetailsOnly);
      if (validationErrors.length) {
        log("ERROR", `Job validation failed | ${validationErrors.join("; ")}`);
        console.log("\nRESULT: FAILED\n");
        process.exitCode = 1;
        return;
      }
      log("SUCCESS", "Job validation successful");
      const stage4 = await getAutoSourceFilter(http, log, session, jobIdForDetailsOnly, config);
      await saveAutoSourceFilter(http, log, session, jobIdForDetailsOnly, stage4.filter, config);
      let savedFilterForRun = null;
      if (!config.skipSavedAutoSourceFilter) {
        if (config.savedAutoSourceFilterPostGenerateDelayMs > 0) {
          log(
            "INFO",
            `Waiting ${config.savedAutoSourceFilterPostGenerateDelayMs}ms before GET saved auto-source filter`
          );
          await sleep(config.savedAutoSourceFilterPostGenerateDelayMs);
        }
        savedFilterForRun = await getSavedAutoSourceFilter(
          http,
          log,
          session,
          jobIdForDetailsOnly,
          config
        );
      } else {
        log(
          "WARN",
          "Skipping Stage 5 GET saved auto-source filter (SANITY_SKIP_SAVED_AUTO_SOURCE_FILTER)"
        );
      }
      await triggerSourcing(http, log, session, jobIdForDetailsOnly, config);
      const stage7 = await getMatchProfiles(http, log, session, jobIdForDetailsOnly, config);
      if (config.outreachEnabled) {
        await runOutreach(http, log, session, stage7, job, config);
      } else {
        log("WARN", "Outreach disabled (OUTREACH_ENABLED is not true); skipping Stage 08");
      }
      if (savedFilterForRun) log("INFO", "Saved filter already validated before sourcing trigger");
      console.log("\nRESULT: SUCCESS\n");
      log("INFO", "Get job details + auto-source filter stages completed successfully");
      return;
    }

    const created = await createJob(http, log, session, config);
    const { job } = await getJobDetails(http, log, session, created.jobId, config);
    const validationErrors = validateJobDetails(job, created.jobId);
    if (validationErrors.length) {
      log("ERROR", `Job validation failed | ${validationErrors.join("; ")}`);
      console.log("\nRESULT: FAILED\n");
      process.exitCode = 1;
      return;
    }
    log("SUCCESS", "Job validation successful");
    const stage4 = await getAutoSourceFilter(http, log, session, created.jobId, config);
    await saveAutoSourceFilter(http, log, session, created.jobId, stage4.filter, config);
    let savedFilterForRun = null;
    if (!config.skipSavedAutoSourceFilter) {
      if (config.savedAutoSourceFilterPostGenerateDelayMs > 0) {
        log(
          "INFO",
          `Waiting ${config.savedAutoSourceFilterPostGenerateDelayMs}ms before GET saved auto-source filter`
        );
        await sleep(config.savedAutoSourceFilterPostGenerateDelayMs);
      }
      savedFilterForRun = await getSavedAutoSourceFilter(http, log, session, created.jobId, config);
    } else {
      log(
        "WARN",
        "Skipping Stage 5 GET saved auto-source filter (SANITY_SKIP_SAVED_AUTO_SOURCE_FILTER)"
      );
    }
    await triggerSourcing(http, log, session, created.jobId, config);
    const stage7 = await getMatchProfiles(http, log, session, created.jobId, config);
    if (config.outreachEnabled) {
      await runOutreach(http, log, session, stage7, job, config);
    } else {
      log("WARN", "Outreach disabled (OUTREACH_ENABLED is not true); skipping Stage 08");
    }
    if (savedFilterForRun) log("INFO", "Saved filter already validated before sourcing trigger");
    console.log("\nRESULT: SUCCESS\n");
    log("INFO", "Sanity flow completed successfully");
  } catch {
    console.log("\nRESULT: FAILED\n");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[${isoTimestamp()}] [FATAL]`, err);
  process.exit(1);
});
