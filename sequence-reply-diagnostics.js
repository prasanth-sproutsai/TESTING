/**
 * Sequence automated-reply diagnostics.
 *
 * When a candidate replies, the product may send delayed positive/negative templates
 * only if the sequence document on the server has those template IDs (and the
 * inbound-mail / classification pipeline runs). This script does not send mail or
 * simulate a reply; it only reads GET /sequence/get/:id (and optionally GET /template-tags)
 * so you can verify configuration before debugging backend behavior.
 */

const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config();

const { isoTimestamp, normalizeBaseUrl, browserLikeGetHeaders } = require("./job-flow-common");
const { login } = require("./job-stage-login");

// Match job-stage-outreach extractSequenceDefinition so nested response shapes parse the same way.
function extractSequenceDefinition(payload) {
  const root = payload?.data ?? payload;
  const response = root?.response ?? root?.data?.response ?? null;
  const seq = response && typeof response === "object" ? response : root;
  if (!seq || typeof seq !== "object") return null;
  return seq;
}

function buildConfig() {
  const sequenceId = String(
    process.env.SEQUENCE_REPLY_DIAG_ID || process.env.SEQUENCE_ID || ""
  ).trim();

  return {
    baseUrl: process.env.BASE_URL,
    username: process.env.LOGIN_USERNAME,
    password: process.env.PASSWORD,
    timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 30_000),
    orgIdFallback: (process.env.ORG_ID || process.env.SANITY_ORG_ID || "").trim(),
    requestOrigin: (process.env.JOB_REQUEST_ORIGIN || "https://test.app.sproutsai.com").trim(),
    requestReferer: (process.env.JOB_REQUEST_REFERER || "https://test.app.sproutsai.com/").trim(),
    requestUserAgent: (process.env.JOB_REQUEST_USER_AGENT || "").trim(),
    sequenceGetPathPrefix: (process.env.SEQUENCE_GET_PATH_PREFIX || "/sequence/get").replace(/\/+$/, ""),
    sequenceId,
    templateTagsPath: (process.env.TEMPLATE_TAGS_PATH || "/template-tags").replace(/\/+$/, ""),
    fetchTemplateTags:
      process.env.SEQUENCE_REPLY_DIAG_FETCH_TAGS === "1" ||
      process.env.SEQUENCE_REPLY_DIAG_FETCH_TAGS === "true",
  };
}

function log(level, message) {
  console.log(`[${isoTimestamp()}] [${level}] ${message}`);
}

function buildSequenceGetUrl(baseUrl, pathPrefix, sequenceId) {
  const base = normalizeBaseUrl(baseUrl);
  const p = String(pathPrefix || "/sequence/get").replace(/^\/?/, "/").replace(/\/+$/, "");
  const id = encodeURIComponent(String(sequenceId).trim());
  return `${base}${p}/${id}`;
}

// Collect keys likely related to automated reply / tags / email preference from a sequence doc.
function pickReplyRelatedFields(sequence) {
  if (!sequence || typeof sequence !== "object") return {};
  const out = {};
  const keys = Object.keys(sequence);
  const interest = (k) =>
    /reply|positive|negative|automated|template_tag|sequence_tag|tag|preference|email_pref/i.test(k);

  for (const k of keys) {
    if (interest(k)) {
      const v = sequence[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = {
          _id: v._id ?? v.id,
          name: v.name ?? v.template_name ?? v.title,
          subject: v.subject ?? v.template_subject,
        };
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

async function fetchTemplateTags(http, session, cfg) {
  const base = normalizeBaseUrl(cfg.baseUrl);
  const p = String(cfg.templateTagsPath || "/template-tags").replace(/^\/?/, "/");
  const url = `${base}${p}`;
  const headers = {
    ...browserLikeGetHeaders(session, cfg),
    "Content-Type": "application/json",
  };
  const response = await http.get(url, { headers, validateStatus: () => true });
  return response;
}

async function main() {
  const cfg = buildConfig();
  const missing = [];
  if (!cfg.baseUrl?.trim()) missing.push("BASE_URL");
  if (!cfg.username?.trim()) missing.push("LOGIN_USERNAME");
  if (!cfg.password?.trim()) missing.push("PASSWORD");
  if (!cfg.sequenceId) missing.push("SEQUENCE_REPLY_DIAG_ID or SEQUENCE_ID");
  if (missing.length) {
    console.error(`Missing: ${missing.join(", ")}`);
    process.exit(1);
  }

  const http = axios.create({ timeout: cfg.timeoutMs });

  // Block 1: authenticate (same session shape as other job flows).
  log("INFO", `Login then GET sequence | sequenceId=${cfg.sequenceId}`);
  const session = await login(http, log, cfg);

  // Block 2: load sequence definition from API.
  const url = buildSequenceGetUrl(cfg.baseUrl, cfg.sequenceGetPathPrefix, cfg.sequenceId);
  const seqResponse = await http.get(url, {
    headers: {
      ...browserLikeGetHeaders(session, cfg),
      "Content-Type": "application/json",
    },
    validateStatus: () => true,
  });

  if (seqResponse.status !== 200) {
    log("ERROR", `Sequence get HTTP ${seqResponse.status}`);
    process.exit(1);
  }

  const sequence = extractSequenceDefinition(seqResponse.data);
  if (!sequence) {
    log("ERROR", "Could not parse sequence from response");
    process.exit(1);
  }

  const name = String(sequence.name || sequence.sequence_name || "").trim() || "(unnamed)";
  const id = String(sequence._id || sequence.id || cfg.sequenceId).trim();

  // Block 3: print reply-related fields (IDs must be set for server-side auto-replies to have templates).
  log("INFO", `Sequence | id=${id} | name=${name}`);
  const related = pickReplyRelatedFields(sequence);
  if (Object.keys(related).length === 0) {
    log(
      "WARN",
      "No obvious reply/tag/preference fields on this object (API may use different names). First-level keys sample:"
    );
    log("INFO", Object.keys(sequence).slice(0, 40).join(", "));
  } else {
    log("INFO", `Reply-related fields: ${JSON.stringify(related, null, 2)}`);
  }

  const posId = sequence.positive_reply_template_id ?? sequence.positiveReplyTemplateId;
  const negId = sequence.negative_reply_template_id ?? sequence.negativeReplyTemplateId;

  // Block 4: human-readable checklist for why auto-replies might not send.
  if (!posId) {
    log(
      "WARN",
      "positive_reply_template_id (or equivalent) is missing — automated positive reply cannot be queued from this sequence."
    );
  } else {
    log("INFO", `positive_reply_template_id present | ${String(posId)}`);
  }
  if (!negId) {
    log(
      "WARN",
      "negative_reply_template_id (or equivalent) is missing — automated negative reply cannot be queued from this sequence."
    );
  } else {
    log("INFO", `negative_reply_template_id present | ${String(negId)}`);
  }

  log(
    "INFO",
    "Inbound auto-reply still requires backend mail ingest + sentiment/classification jobs; this script only verifies persisted sequence config."
  );

  // Block 5: optional template-tags list (UI "Sequence Tag" / outreach tags).
  if (cfg.fetchTemplateTags) {
    const tagRes = await fetchTemplateTags(http, session, cfg);
    if (tagRes.status !== 200) {
      log("WARN", `template-tags HTTP ${tagRes.status} (non-fatal)`);
    } else {
      const body = tagRes.data?.data ?? tagRes.data?.result ?? tagRes.data;
      const list = Array.isArray(body) ? body : body?.tags ?? body?.items ?? [];
      log("INFO", `template-tags count=${Array.isArray(list) ? list.length : "?"}`);
      if (Array.isArray(list) && list.length <= 30) {
        log("INFO", JSON.stringify(list, null, 2));
      }
    }
  }
}

main().catch((err) => {
  console.error(`[${isoTimestamp()}] [FATAL]`, err?.message || err);
  process.exit(1);
});
