/**
 * Outreach flow using a fixed sequence template.
 *
 * Purpose:
 * - Validate that the sequence template exists via GET /sequence/get/:id
 * - Run match profile -> outreach flow using that exact sequence_id
 *
 * Safety:
 * - Real outreach send is blocked unless OUTREACH_ALLOW_REAL_SEND=1 or true.
 */

const path = require("path");
const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config();

const { createDualLogger, isoTimestamp, normalizeBaseUrl, browserLikeGetHeaders } = require("./job-flow-common");
const { login } = require("./job-stage-login");
const { getJobDetails } = require("./job-stage-get-details");
const { getMatchProfiles } = require("./job-stage-get-match-profiles");
const { runOutreach } = require("./job-stage-outreach");

// Fixed template id provided by the team.
const DEFAULT_SEQUENCE_TEMPLATE_ID = "69e5e7cda63e80cf9b263f66";

function buildConfig() {
  return {
    // --- Core auth and API config ---
    baseUrl: process.env.BASE_URL,
    username: process.env.LOGIN_USERNAME,
    password: process.env.PASSWORD,
    timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 30_000),
    orgIdFallback: (process.env.ORG_ID || process.env.SANITY_ORG_ID || "").trim(),

    // --- Request header defaults ---
    requestOrigin: (process.env.JOB_REQUEST_ORIGIN || "https://test.app.sproutsai.com").trim(),
    requestReferer: (process.env.JOB_REQUEST_REFERER || "https://test.app.sproutsai.com/").trim(),
    requestUserAgent: (process.env.JOB_REQUEST_USER_AGENT || "").trim(),

    // --- Job + profile retrieval ---
    jobDetailsPath: (process.env.JOB_DETAILS_PATH || "/job/job_details").replace(/\/+$/, ""),
    jobDetailsQuery: (process.env.JOB_DETAILS_QUERY || "status=active").trim(),
    matchProfilesPath: (process.env.MATCH_PROFILES_PATH || "/job/get_match_profiles").replace(/\/+$/, ""),
    // Supported values: prospects | candidates
    matchProfilesAudience: (process.env.MATCH_PROFILES_AUDIENCE || "prospects").trim().toLowerCase(),
    matchProfilesMethod: (process.env.MATCH_PROFILES_METHOD || "POST").trim().toUpperCase(),
    matchProfilesSource: (process.env.MATCH_PROFILES_SOURCE || "Prospect").trim(),
    matchProfilesThumbsUp: (process.env.MATCH_PROFILES_THUMBS_UP || "0").trim(),
    matchProfilesFilter: (process.env.MATCH_PROFILES_FILTER || "Active").trim(),
    matchProfilesLimit: Math.max(1, parseInt(process.env.MATCH_PROFILES_LIMIT || "20", 10) || 20),
    matchProfilesPage: Math.max(1, parseInt(process.env.MATCH_PROFILES_PAGE || "1", 10) || 1),
    matchProfilesMaxAttempts: Math.max(1, parseInt(process.env.MATCH_PROFILES_MAX_ATTEMPTS || "3", 10) || 3),
    matchProfilesBackoffMs: Math.max(100, parseInt(process.env.MATCH_PROFILES_BACKOFF_MS || "1000", 10) || 1000),

    // --- Outreach endpoints + content ---
    generatePersonalizedEmailPath: (
      process.env.GENERATE_PERSONALIZED_EMAIL_PATH || "/email/email-templates/generate-personalized-email"
    ).replace(/\/+$/, ""),
    sequenceCreatePath: (process.env.SEQUENCE_CREATE_PATH || "/sequence/job/create").replace(/\/+$/, ""),
    sequenceGetPathPrefix: (process.env.SEQUENCE_GET_PATH_PREFIX || "/sequence/get").replace(/\/+$/, ""),
    sequenceId: (process.env.SEQUENCE_ID || DEFAULT_SEQUENCE_TEMPLATE_ID).trim(),
    fromEmail: (process.env.FROM_EMAIL || "").trim(),
    fromEmailAddress: (process.env.FROM_EMAIL_ADDRESS || "").trim(),
    orgName: (process.env.ORG_NAME || "").trim(),
    outreachSubject: (process.env.OUTREACH_SUBJECT || "Exciting opportunity").trim(),
    outreachBody: (process.env.OUTREACH_BODY || "We found your profile interesting").trim(),

    // --- Hard safety gate for real emails ---
    outreachAllowRealSend:
      process.env.OUTREACH_ALLOW_REAL_SEND === "1" || process.env.OUTREACH_ALLOW_REAL_SEND === "true",

    // --- Output logs ---
    logFile: (process.env.OUTREACH_TEMPLATE_LOG_FILE || "logs/outreach-sequence-template.log").trim(),
  };
}

function validateRequired(cfg, jobId) {
  const missing = [];
  if (!cfg.baseUrl?.trim()) missing.push("BASE_URL");
  if (!cfg.username?.trim()) missing.push("LOGIN_USERNAME");
  if (!cfg.password?.trim()) missing.push("PASSWORD");
  if (!jobId) missing.push("JOB_DETAILS_JOB_ID");
  if (!cfg.sequenceId) missing.push("SEQUENCE_ID");
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

function buildSequenceGetUrl(baseUrl, pathPrefix, sequenceId) {
  const base = normalizeBaseUrl(baseUrl);
  const p = String(pathPrefix || "/sequence/get").replace(/^\/?/, "/").replace(/\/+$/, "");
  const id = encodeURIComponent(String(sequenceId).trim());
  return `${base}${p}/${id}`;
}

async function getSequenceTemplate(http, log, session, cfg) {
  // Validate that template id exists before sending outreach.
  const url = buildSequenceGetUrl(cfg.baseUrl, cfg.sequenceGetPathPrefix, cfg.sequenceId);
  const response = await http.get(url, {
    headers: {
      ...browserLikeGetHeaders(session, cfg),
      "Content-Type": "application/json",
    },
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    throw new Error(`Sequence get failed | HTTP ${response.status}`);
  }

  const root = response.data || {};
  const template = root.data || root.result || root;
  if (!template || typeof template !== "object") {
    throw new Error("Sequence get returned an invalid template payload");
  }

  const templateName = String(template.name || template.sequence_name || "unnamed-template");
  log("INFO", `Sequence template loaded | id=${cfg.sequenceId} | name=${templateName}`);
  return template;
}

async function main() {
  const cfg = buildConfig();
  const jobId = String(process.env.JOB_DETAILS_JOB_ID || "").trim();
  validateRequired(cfg, jobId);

  const logPath = path.resolve(process.cwd(), cfg.logFile);
  const log = createDualLogger(logPath);
  const http = axios.create({ timeout: cfg.timeoutMs });

  log("INFO", `Outreach template flow started | jobId=${jobId} | sequenceId=${cfg.sequenceId}`);

  // Hard stop before any outreach API calls unless explicitly enabled.
  if (!cfg.outreachAllowRealSend) {
    log(
      "WARN",
      "DRY RUN | OUTREACH_ALLOW_REAL_SEND is not true, skipping outreach send APIs to prevent candidate emails."
    );
    console.log("\nRESULT: SUCCESS (DRY RUN — no outreach emails sent)\n");
    return;
  }

  try {
    // Step 1: Login and establish session headers/auth.
    const session = await login(http, log, cfg);

    // Step 2: Validate template id via sequence get API.
    await getSequenceTemplate(http, log, session, cfg);

    // Step 3: Fetch job details and candidate profiles.
    const { job } = await getJobDetails(http, log, session, jobId, cfg);
    const stage7 = await getMatchProfiles(http, log, session, jobId, cfg);

    // Step 4: Run outreach with the required sequence template id.
    const result = await runOutreach(http, log, session, stage7, job, cfg);
    if (result?.skipped) {
      throw new Error(`Outreach skipped | reason=${result.reason || "unknown"}`);
    }

    log("SUCCESS", `Outreach completed using template ${cfg.sequenceId}`);
    console.log("\nRESULT: SUCCESS\n");
  } catch (err) {
    log("ERROR", err?.message || String(err));
    console.log("\nRESULT: FAILED\n");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[${isoTimestamp()}] [FATAL]`, err);
  process.exit(1);
});

