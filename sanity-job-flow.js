/**
 * Orchestrator: Login → Create job → Job details → Generate filter → Source candidates → Match profiles → Outreach → (optional) saved filter.
 * Each step is implemented in job-stage-*.js; shared helpers in job-flow-common.js.
 */

const path = require("path");
const fs = require("fs");
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
  // Default matches job sourcing API (see team: /job/sourceCandidates); override with SOURCING_PATH if needed.
  sourcingPath: (process.env.SOURCING_PATH || "/job/sourceCandidates").replace(/\/+$/, ""),
  sourcingCandidateCount: Math.max(1, parseInt(process.env.SOURCING_CANDIDATE_COUNT || "20", 10) || 20),
  sourcingMaxAttempts: Math.max(1, parseInt(process.env.SOURCING_MAX_ATTEMPTS || "3", 10) || 3),
  sourcingBackoffMs: Math.max(100, parseInt(process.env.SOURCING_BACKOFF_MS || "1000", 10) || 1000),
  // Optional idempotency guard within a run.
  sourcingCooldownMs: Math.max(0, parseInt(process.env.SOURCING_COOLDOWN_MS || "0", 10) || 0),
  matchProfilesPath: (process.env.MATCH_PROFILES_PATH || "/job/get_match_profiles").replace(/\/+$/, ""),
  // Supported audiences:
  // - prospects  => ?thumbsUp=0&source=Prospect&limit=20&page=1
  // - candidates => ?limit=20&filter=Active&page=1
  matchProfilesAudience: (process.env.MATCH_PROFILES_AUDIENCE || "prospects").trim().toLowerCase(),
  // UI currently uses POST + query for list retrieval.
  matchProfilesMethod: (process.env.MATCH_PROFILES_METHOD || "POST").trim().toUpperCase(),
  matchProfilesSource: (process.env.MATCH_PROFILES_SOURCE || "Prospect").trim(),
  matchProfilesThumbsUp: (process.env.MATCH_PROFILES_THUMBS_UP || "0").trim(),
  matchProfilesFilter: (process.env.MATCH_PROFILES_FILTER || "Active").trim(),
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
  // Stage 08 only runs when enabled; real sends also require OUTREACH_ALLOW_REAL_SEND (see job-stage-outreach.js).
  outreachEnabled:
    process.env.OUTREACH_ENABLED === "1" || process.env.OUTREACH_ENABLED === "true",
  outreachAllowRealSend:
    process.env.OUTREACH_ALLOW_REAL_SEND === "1" || process.env.OUTREACH_ALLOW_REAL_SEND === "true",
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
  testcaseSheetPath: (process.env.SANITY_TESTCASE_SHEET || "JOB_NEW_P0_TEST_TRACKER.csv").trim(),
};

const requiredEnv = ["BASE_URL", "LOGIN_USERNAME", "PASSWORD"];

function validateEnv() {
  const missing = requiredEnv.filter((key) => !process.env[key]?.trim?.());
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

// Parse TSV/CSV testcase sheet and load rows with testcase IDs.
function loadTestcases(log, cfg) {
  const sheetPath = path.resolve(process.cwd(), cfg.testcaseSheetPath);
  if (!fs.existsSync(sheetPath)) {
    log("WARN", `Testcase sheet not found; skipping testcase tracker | path=${sheetPath}`);
    return { sheetPath, rows: [] };
  }

  const raw = fs.readFileSync(sheetPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length <= 1) {
    log("WARN", `Testcase sheet has no data rows; skipping testcase tracker | path=${sheetPath}`);
    return { sheetPath, rows: [] };
  }

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split("\t");
    const tcId = String(cols[0] || "").trim();
    const tcTitle = String(cols[1] || "").trim();
    if (!tcId || !/^TC-/.test(tcId)) continue;
    rows.push({ tcId, tcTitle, row: i + 1 });
  }

  log("INFO", `Loaded testcase sheet | path=${sheetPath} | testcaseCount=${rows.length}`);
  return { sheetPath, rows };
}

// Build in-memory tracker for testcase results and final summary.
function createTestcaseTracker(log, testcaseRows) {
  const resultById = new Map();
  testcaseRows.forEach((tc) => {
    resultById.set(tc.tcId, { status: "NOT_RUN", detail: "", tc });
  });

  const stagePrefixes = {
    LOGIN: "TC-LOGIN-",
    CREATEJOB: "TC-CREATEJOB-",
    GETJOB: "TC-GETJOB-",
    GENAUTOSOURCE: "TC-GENAUTOSOURCE-",
    GETSOURCEFILTER: "TC-GETSOURCEFILTER-",
  };

  function markByStage(stageKey, passed, detail) {
    const prefix = stagePrefixes[stageKey];
    if (!prefix) return;
    for (const [tcId, current] of resultById.entries()) {
      if (!tcId.startsWith(prefix)) continue;
      resultById.set(tcId, {
        ...current,
        status: passed ? "PASS" : "FAIL",
        detail: detail || "",
      });
    }
    log(
      passed ? "SUCCESS" : "ERROR",
      `Testcases mapped for ${stageKey} marked ${passed ? "PASS" : "FAIL"}`
    );
  }

  function summarize() {
    const totals = { PASS: 0, FAIL: 0, NOT_RUN: 0 };
    const failedIds = [];
    for (const item of resultById.values()) {
      totals[item.status] = (totals[item.status] || 0) + 1;
      if (item.status === "FAIL") {
        failedIds.push(item.tc.tcId);
      }
    }
    log(
      "INFO",
      `Testcase summary | total=${resultById.size} | passed=${totals.PASS} | failed=${totals.FAIL} | not_run=${totals.NOT_RUN}`
    );
    if (failedIds.length > 0) {
      console.log(
        `\nTESTCASE RESULT: total=${resultById.size}, passed=${totals.PASS}, failed=${totals.FAIL}, not_run=${totals.NOT_RUN}\nFAILED TESTCASE IDs: ${failedIds.join(
          ", "
        )}\n`
      );
      return;
    }
    console.log(
      `\nTESTCASE RESULT: total=${resultById.size}, passed=${totals.PASS}, failed=${totals.FAIL}, not_run=${totals.NOT_RUN}\n`
    );
  }

  return { markByStage, summarize };
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
  const testcaseSheet = loadTestcases(log, config);
  const tracker = createTestcaseTracker(log, testcaseSheet.rows);

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
    tracker.markByStage("LOGIN", true, "Login stage completed successfully");

    if (detailsFlagIdx >= 0) {
      if (!jobIdForDetailsOnly) {
        tracker.markByStage("GETJOB", false, "Missing job id for details-only mode");
        tracker.markByStage("GENAUTOSOURCE", false, "Blocked because details-only job id is missing");
        tracker.markByStage("GETSOURCEFILTER", false, "Blocked because details-only job id is missing");
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
        tracker.markByStage("GETJOB", false, validationErrors.join("; "));
        tracker.markByStage("GENAUTOSOURCE", false, "Blocked because job validation failed");
        tracker.markByStage("GETSOURCEFILTER", false, "Blocked because job validation failed");
        log("ERROR", `Job validation failed | ${validationErrors.join("; ")}`);
        console.log("\nRESULT: FAILED\n");
        process.exitCode = 1;
        return;
      }
      log("SUCCESS", "Job validation successful");
      tracker.markByStage("GETJOB", true, "Job details and validation succeeded");
      const stage4 = await getAutoSourceFilter(http, log, session, jobIdForDetailsOnly, config);
      await saveAutoSourceFilter(http, log, session, jobIdForDetailsOnly, stage4.filter, config);
      tracker.markByStage("GENAUTOSOURCE", true, "Generated and saved auto-source filter");
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
        tracker.markByStage("GETSOURCEFILTER", true, "Saved auto-source filter fetched successfully");
      } else {
        log(
          "WARN",
          "Skipping Stage 5 GET saved auto-source filter (SANITY_SKIP_SAVED_AUTO_SOURCE_FILTER)"
        );
        tracker.markByStage(
          "GETSOURCEFILTER",
          false,
          "Skipped due to SANITY_SKIP_SAVED_AUTO_SOURCE_FILTER"
        );
      }
      // Trigger sourcing with the persisted filter payload so UI history shows complete criteria.
      await triggerSourcing(
        http,
        log,
        session,
        jobIdForDetailsOnly,
        config,
        savedFilterForRun?.filter || stage4.filter
      );
      const stage7 = await getMatchProfiles(http, log, session, jobIdForDetailsOnly, config);
      if (config.outreachEnabled) {
        if (!config.outreachAllowRealSend) {
          log(
            "WARN",
            "OUTREACH_ALLOW_REAL_SEND is not true; Stage 08 will not call outreach send APIs (no candidate emails)."
          );
        }
        await runOutreach(http, log, session, stage7, job, config);
      } else {
        log(
          "WARN",
          "Outreach disabled (OUTREACH_ENABLED is not true); skipping Stage 08 | real sends also need OUTREACH_ALLOW_REAL_SEND=1"
        );
      }
      if (savedFilterForRun) log("INFO", "Saved filter already validated before sourcing trigger");
      console.log("\nRESULT: SUCCESS\n");
      log("INFO", "Get job details + auto-source filter stages completed successfully");
      return;
    }

    const created = await createJob(http, log, session, config);
    tracker.markByStage("CREATEJOB", true, "Job create stage completed successfully");
    const { job } = await getJobDetails(http, log, session, created.jobId, config);
    const validationErrors = validateJobDetails(job, created.jobId);
    if (validationErrors.length) {
      tracker.markByStage("GETJOB", false, validationErrors.join("; "));
      tracker.markByStage("GENAUTOSOURCE", false, "Blocked because job validation failed");
      tracker.markByStage("GETSOURCEFILTER", false, "Blocked because job validation failed");
      log("ERROR", `Job validation failed | ${validationErrors.join("; ")}`);
      console.log("\nRESULT: FAILED\n");
      process.exitCode = 1;
      return;
    }
    log("SUCCESS", "Job validation successful");
    tracker.markByStage("GETJOB", true, "Job details and validation succeeded");
    const stage4 = await getAutoSourceFilter(http, log, session, created.jobId, config);
    await saveAutoSourceFilter(http, log, session, created.jobId, stage4.filter, config);
    tracker.markByStage("GENAUTOSOURCE", true, "Generated and saved auto-source filter");
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
      tracker.markByStage("GETSOURCEFILTER", true, "Saved auto-source filter fetched successfully");
    } else {
      log(
        "WARN",
        "Skipping Stage 5 GET saved auto-source filter (SANITY_SKIP_SAVED_AUTO_SOURCE_FILTER)"
      );
      tracker.markByStage(
        "GETSOURCEFILTER",
        false,
        "Skipped due to SANITY_SKIP_SAVED_AUTO_SOURCE_FILTER"
      );
    }
    // Trigger sourcing with the persisted filter payload so UI history shows complete criteria.
    await triggerSourcing(http, log, session, created.jobId, config, savedFilterForRun?.filter || stage4.filter);
    const stage7 = await getMatchProfiles(http, log, session, created.jobId, config);
    if (config.outreachEnabled) {
      if (!config.outreachAllowRealSend) {
        log(
          "WARN",
          "OUTREACH_ALLOW_REAL_SEND is not true; Stage 08 will not call outreach send APIs (no candidate emails)."
        );
      }
      await runOutreach(http, log, session, stage7, job, config);
    } else {
      log(
        "WARN",
        "Outreach disabled (OUTREACH_ENABLED is not true); skipping Stage 08 | real sends also need OUTREACH_ALLOW_REAL_SEND=1"
      );
    }
    if (savedFilterForRun) log("INFO", "Saved filter already validated before sourcing trigger");
    console.log("\nRESULT: SUCCESS\n");
    log("INFO", "Sanity flow completed successfully");
  } catch {
    tracker.markByStage("CREATEJOB", false, "Stage did not complete due to run failure");
    tracker.markByStage("GETJOB", false, "Stage did not complete due to run failure");
    tracker.markByStage("GENAUTOSOURCE", false, "Stage did not complete due to run failure");
    tracker.markByStage("GETSOURCEFILTER", false, "Stage did not complete due to run failure");
    console.log("\nRESULT: FAILED\n");
    process.exitCode = 1;
  } finally {
    tracker.summarize();
  }
}

main().catch((err) => {
  console.error(`[${isoTimestamp()}] [FATAL]`, err);
  process.exit(1);
});
