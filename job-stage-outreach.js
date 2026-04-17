/**
 * Stage 8: generate personalized email content and send outreach sequence.
 */

const { normalizeBaseUrl, formatAxiosError, browserLikeGetHeaders } = require("./job-flow-common");

/**
 * Real outreach hits generate-personalized-email and sequence/job/create (can email candidates).
 * Default is OFF so automation never sends unless OUTREACH_ALLOW_REAL_SEND=1 is set in env/cfg.
 */
function isOutreachRealSendAllowed(cfg) {
  if (cfg?.outreachAllowRealSend === true || cfg?.outreachAllowRealSend === 1) return true;
  const s = String(cfg?.outreachAllowRealSend ?? "").trim().toLowerCase();
  return s === "1" || s === "true";
}

function buildUrl(baseUrl, routePath, fallbackPath) {
  const base = normalizeBaseUrl(baseUrl);
  const p = String(routePath || fallbackPath)
    .replace(/^\/?/, "/")
    .replace(/\/+$/, "");
  return `${base}${p}`;
}

function getJobName(job) {
  return (
    job?.name ??
    job?.position ??
    job?.internal_job_name ??
    job?.job_name ??
    job?.title ??
    job?.jobTitle ??
    "Job Role"
  );
}

function getOrgName(job, cfg) {
  if (cfg.orgName && String(cfg.orgName).trim()) return String(cfg.orgName).trim();
  const company = job?.company;
  if (typeof company === "string" && company.trim()) return company.trim();
  if (company && typeof company === "object" && company.name) return String(company.name);
  return "SproutsAI";
}

function pickSelectedEmail(profile) {
  const work = Array.isArray(profile?.applicant?.work_email) ? profile.applicant.work_email : [];
  const personal = Array.isArray(profile?.applicant?.email) ? profile.applicant.email : [];
  const workFirst = work.find((x) => String(x || "").trim());
  if (workFirst) return String(workFirst).trim();
  const personalFirst = personal.find((x) => String(x || "").trim());
  if (personalFirst) return String(personalFirst).trim();
  return "";
}

function flattenCandidatesFromProfilesByJob(profilesByJob) {
  const rows = [];
  const seen = new Set();
  for (const byJob of Array.isArray(profilesByJob) ? profilesByJob : []) {
    for (const p of Array.isArray(byJob?.profiles) ? byJob.profiles : []) {
      const matchProfileId = String(p?.matchProfile?._id || "").trim();
      const applicantId = String(p?.applicant?._id || "").trim();
      const selectedEmail = pickSelectedEmail(p);
      if (!matchProfileId || !applicantId || !selectedEmail) continue;
      if (seen.has(matchProfileId)) continue;
      seen.add(matchProfileId);
      rows.push({ matchProfileId, applicantId, selectedEmail });
    }
  }
  return rows;
}

function extractStepAItems(payload) {
  const root = payload?.data ?? payload;
  const arr = root?.data ?? root?.items ?? root;
  return Array.isArray(arr) ? arr : [];
}

function buildEmailIndex(items) {
  const map = new Map();
  for (const item of items) {
    const id = String(item?.match_profile_id || item?.matchProfileId || "").trim();
    const subject = String(item?.subject || "").trim();
    const body = String(item?.body || "").trim();
    if (!id || !subject || !body) continue;
    map.set(id, { subject, body });
  }
  return map;
}

/**
 * Step A: POST /email/email-templates/generate-personalized-email
 */
async function generateEmailContent(http, log, session, matchProfileIds, cfg) {
  const url = buildUrl(
    cfg.baseUrl,
    cfg.generatePersonalizedEmailPath,
    "/email/email-templates/generate-personalized-email"
  );
  const payload = {
    matchIds: matchProfileIds,
    emailDetails: {
      subject: cfg.outreachSubject || "Exciting opportunity",
      body: cfg.outreachBody || "We found your profile interesting",
    },
    use_real_data: true,
    sequenceType: "ai",
  };
  const headers = {
    ...browserLikeGetHeaders(session, cfg),
    uid: String(session.userId),
    org_id: String(session.orgId),
    "Content-Type": "application/json",
  };

  log("INFO", `Outreach Step A | POST ${url} | matchIds=${matchProfileIds.length}`);
  const response = await http.post(url, payload, {
    headers,
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    throw new Error(`Outreach Step A unexpected HTTP ${response.status}: ${formatAxiosError({ response })}`);
  }

  const items = extractStepAItems(response.data);
  const byMatchProfileId = buildEmailIndex(items);
  const missing = matchProfileIds.filter((id) => !byMatchProfileId.has(id));
  if (missing.length) {
    throw new Error(`Outreach Step A missing subject/body for ${missing.length} match profile(s)`);
  }

  log("INFO", `Outreach Step A success | generated=${byMatchProfileId.size}`);
  return { byMatchProfileId, raw: response.data };
}

/**
 * Step B: POST /sequence/job/create
 */
async function sendSequence(http, log, session, outreachCtx, cfg) {
  const url = buildUrl(cfg.baseUrl, cfg.sequenceCreatePath, "/sequence/job/create");
  const headers = {
    ...browserLikeGetHeaders(session, cfg),
    uid: String(session.userId),
    org_id: String(session.orgId),
    "Content-Type": "application/json",
  };

  const payload = {
    sequence_id: cfg.sequenceId || "sequence-placeholder",
    from_email_address: cfg.fromEmailAddress || cfg.username || "noreply@sproutsai.com",
    from_email: cfg.fromEmail || cfg.username || "noreply@sproutsai.com",
    org_name: outreachCtx.orgName,
    job_name: outreachCtx.jobName,
    job_id: outreachCtx.jobId,
    applicants: outreachCtx.candidates.map((c) => c.applicantId),
    flag: "ai",
    sequenceType: "normal",
    match_profile_ids: outreachCtx.candidates.map((c) => ({
      id: c.matchProfileId,
      selectedEmails: [c.selectedEmail],
      steps: [
        {
          preview: {
            subject: c.subject,
            body: c.body,
          },
        },
      ],
    })),
  };

  log(
    "INFO",
    `Outreach Step B | POST ${url} | candidates=${outreachCtx.candidates.length} | job_id=${outreachCtx.jobId}`
  );
  const response = await http.post(url, payload, {
    headers,
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    throw new Error(`Outreach Step B unexpected HTTP ${response.status}: ${formatAxiosError({ response })}`);
  }

  const root = response.data || {};
  const summary = root.summary ?? root.data?.summary ?? null;
  const errorLog = root.errorLog ?? root.data?.errorLog ?? [];
  if (!summary || !Number.isFinite(Number(summary.total_candidates))) {
    throw new Error("Outreach Step B response missing summary.total_candidates");
  }
  if (summary.errors == null) {
    throw new Error("Outreach Step B response missing summary.errors");
  }

  log(
    "INFO",
    `Outreach summary | total_candidates=${summary.total_candidates} | successful=${summary.successful} | errors=${summary.errors}`
  );
  if (Number(summary.errors) > 0) {
    log("WARN", `Outreach partial failures | errorLog=${JSON.stringify(errorLog)}`);
  } else {
    log("SUCCESS", "Outreach sequence sent successfully");
  }

  return { summary, errorLog, raw: response.data };
}

/**
 * Stage 08 orchestration using runtime data from Stage 07 only.
 */
async function runOutreach(http, log, session, stage7Result, job, cfg) {
  // Hard stop: no template generation and no sequence API unless explicitly allowed.
  if (!isOutreachRealSendAllowed(cfg)) {
    log(
      "WARN",
      "Outreach send DISABLED | set OUTREACH_ALLOW_REAL_SEND=1 only when you intend real candidate emails (isolated env)."
    );
    return { skipped: true, reason: "outreach_send_disabled", candidates: [] };
  }

  const jobId = String(stage7Result?.profilesByJob?.[0]?.job_id || "").trim();
  const candidates = flattenCandidatesFromProfilesByJob(stage7Result?.profilesByJob || []);

  log(
    "INFO",
    `Outreach candidates prepared | job_id=${jobId || "unknown"} | candidates=${candidates.length}`
  );
  if (!jobId || candidates.length === 0) {
    log("WARN", "Outreach skipped: no candidates with valid email");
    return { skipped: true, reason: "no_candidates", candidates: [] };
  }

  const matchIds = candidates.map((c) => c.matchProfileId);
  const stepA = await generateEmailContent(http, log, session, matchIds, cfg);

  // Attach generated subject/body to each candidate by runtime matchProfileId.
  const readyCandidates = [];
  for (const c of candidates) {
    const generated = stepA.byMatchProfileId.get(c.matchProfileId);
    if (!generated) continue;
    readyCandidates.push({
      ...c,
      subject: generated.subject,
      body: generated.body,
    });
  }

  if (readyCandidates.length === 0) {
    throw new Error("Outreach aborted: no candidates had generated subject/body");
  }

  const outreachCtx = {
    jobId,
    jobName: getJobName(job),
    orgName: getOrgName(job, cfg),
    candidates: readyCandidates,
  };

  const stepB = await sendSequence(http, log, session, outreachCtx, cfg);
  return { jobId, processedCandidates: readyCandidates.length, stepA, stepB };
}

module.exports = {
  isOutreachRealSendAllowed,
  generateEmailContent,
  sendSequence,
  runOutreach,
};
