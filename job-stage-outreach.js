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

function shouldUseSequenceTemplateSteps(cfg) {
  // Default ON when sequence id is provided, unless explicitly disabled.
  if (cfg?.outreachUseSequenceTemplateSteps === false) return false;
  const raw = String(cfg?.outreachUseSequenceTemplateSteps ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "false") return false;
  return String(cfg?.sequenceId || "").trim() !== "";
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
  const arr = root?.emails ?? root?.data ?? root?.items ?? root;
  return Array.isArray(arr) ? arr : [];
}

function buildEmailIndex(items) {
  const map = new Map();
  for (const item of items) {
    const id = String(
      item?.match_profile_id ||
        item?.matchProfileId ||
        item?.candidate_id ||
        item?.match_id ||
        item?.id ||
        item?.match_profile?._id ||
        ""
    ).trim();
    // Support legacy and new template-shaped response fields.
    const firstVariant =
      Array.isArray(item?.email_variants) && item.email_variants.length
        ? item.email_variants[0]
        : null;
    const subject = String(
      item?.subject ||
        item?.template_subject ||
        item?.email_subject ||
        item?.preview?.subject ||
        item?.data?.subject ||
        item?.data?.template_subject ||
        firstVariant?.subject ||
        firstVariant?.template_subject ||
        ""
    ).trim();
    const body = String(
      item?.body ||
        item?.template_body ||
        item?.email_body ||
        item?.preview?.body ||
        item?.data?.body ||
        item?.data?.template_body ||
        firstVariant?.body ||
        firstVariant?.template_body ||
        ""
    ).trim();
    if (!id || !subject || !body) continue;
    map.set(id, { subject, body });
  }
  return map;
}

function extractDocsFromMatchProfilesRaw(payload) {
  const root = payload?.data ?? payload;
  if (Array.isArray(root?.docs)) return root.docs;
  if (Array.isArray(root?.data?.docs)) return root.data.docs;
  if (Array.isArray(root?.content)) return root.content;
  if (Array.isArray(root?.data?.content)) return root.data.content;
  return [];
}

function buildCandidatesDataFromRaw(rawPayload, readyCandidates) {
  const docs = extractDocsFromMatchProfilesRaw(rawPayload);
  if (!Array.isArray(docs) || docs.length === 0) return [];
  const keep = new Set((Array.isArray(readyCandidates) ? readyCandidates : []).map((c) => c.matchProfileId));
  if (keep.size === 0) return [];

  const rows = [];
  for (const doc of docs) {
    const matchProfileId = String(doc?._id || doc?.match_profile?._id || "").trim();
    if (!matchProfileId || !keep.has(matchProfileId)) continue;
    const applicantId =
      String(doc?.applicant?._id || doc?.applicant_id || doc?.applicantId || "").trim();
    rows.push({
      id: matchProfileId,
      details: doc?.applicant && typeof doc.applicant === "object" ? doc.applicant : {},
      match_profile: doc,
      applicant_id: applicantId || undefined,
    });
  }
  return rows;
}

function extractSequenceDefinition(payload) {
  const root = payload?.data ?? payload;
  const response = root?.response ?? root?.data?.response ?? null;
  const seq = response && typeof response === "object" ? response : root;
  if (!seq || typeof seq !== "object") return null;
  return seq;
}

function normalizeSequenceSteps(sequence) {
  const steps = Array.isArray(sequence?.steps) ? sequence.steps : [];
  // Keep only valid step objects with action.
  return steps
    .filter((s) => s && typeof s === "object" && String(s.action || "").trim() !== "")
    .map((s) => ({ ...s }));
}

function extractSequenceEmailStages(sequence) {
  const steps = Array.isArray(sequence?.steps) ? sequence.steps : [];
  const emailActions = new Set(["SEND_TEMPLATE", "SEND_FOLLOW_UP_EMAIL"]);

  // Extract only the email-sending stages with exact template subject/body.
  return steps
    .map((step, idx) => ({
      idx,
      action: String(step?.action || "").trim(),
      templateId: String(step?.template_id || step?.template?._id || "").trim(),
      subject: String(step?.template?.subject || "").trim(),
      body: String(step?.template?.body || "").trim(),
      waitTime: step?.wait_time,
      waitType: step?.wait_type || null,
    }))
    .filter((s) => emailActions.has(s.action) && s.templateId && s.subject && s.body);
}

function buildSelectedEmails(selectedEmail) {
  const email = String(selectedEmail || "").trim();
  if (!email) return [];
  // Match UI payload contract: selectedEmails is an array of objects.
  return [
    {
      label: email,
      value: email,
      type: "Manual",
    },
  ];
}

function buildCandidateSteps(sequenceSteps, candidate) {
  // Build per-candidate steps in the same shape as the working curl payload.
  const steps = [];
  const seq = Array.isArray(sequenceSteps) ? sequenceSteps : [];
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i];
    const action = String(s?.action || "").trim();
    if (action !== "SEND_TEMPLATE" && action !== "SEND_FOLLOW_UP_EMAIL") continue;
    const templateId = String(s?.template_id || s?.template?._id || "").trim();
    const subject = String(s?.template?.subject || "").trim();
    const body = String(s?.template?.body || "").trim();
    if (!templateId || !subject || !body) continue;
    steps.push({
      sequence_step: i,
      preview: {
        subject,
        body,
      },
      template_id: templateId,
    });
  }

  // Fallback: support preview-only mode when sequence templates are unavailable.
  if (steps.length === 0 && candidate?.subject && candidate?.body) {
    steps.push({
      sequence_step: 0,
      preview: {
        subject: String(candidate.subject),
        body: String(candidate.body),
      },
      template_id: "",
    });
  }
  return steps;
}

function buildCandidatePersonalizedSteps(sequenceEmailStages, generatedByStage, candidate) {
  const out = [];
  const stages = Array.isArray(sequenceEmailStages) ? sequenceEmailStages : [];
  for (const stage of stages) {
    const stageMap = generatedByStage?.[stage.idx];
    const generated = stageMap?.get?.(candidate.matchProfileId);
    if (!generated) continue;
    out.push({
      sequence_step: Number(stage.idx),
      preview: {
        subject: generated.subject,
        body: generated.body,
      },
      template_id: stage.templateId,
    });
  }
  return out;
}

async function fetchSequenceTemplate(http, log, session, cfg) {
  const sequenceId = String(cfg?.sequenceId || "").trim();
  if (!sequenceId) return null;

  const url = buildUrl(cfg.baseUrl, cfg.sequenceGetPathPrefix, "/sequence/get") + `/${encodeURIComponent(sequenceId)}`;
  const headers = {
    ...browserLikeGetHeaders(session, cfg),
    uid: String(session.userId),
    org_id: String(session.orgId),
    "Content-Type": "application/json",
  };

  log("INFO", `Outreach sequence template | GET ${url}`);
  const response = await http.get(url, { headers, validateStatus: () => true });
  if (response.status !== 200) {
    throw new Error(`Outreach sequence template HTTP ${response.status}: ${formatAxiosError({ response })}`);
  }

  const sequence = extractSequenceDefinition(response.data);
  if (!sequence) {
    throw new Error("Outreach sequence template missing response body");
  }
  const steps = normalizeSequenceSteps(sequence);
  if (steps.length === 0) {
    throw new Error("Outreach sequence template has no valid steps");
  }
  const emailStages = extractSequenceEmailStages(sequence);
  if (emailStages.length === 0) {
    throw new Error("Outreach sequence template has no valid email template stages");
  }

  const resolvedId = String(sequence?._id || sequence?.id || sequenceId).trim();
  log(
    "INFO",
    `Outreach sequence template loaded | id=${resolvedId} | steps=${steps.length} | emailStages=${emailStages.length}`
  );
  for (const stage of emailStages) {
    const subjectPreview =
      stage.subject.length > 80 ? `${stage.subject.slice(0, 80)}...` : stage.subject;
    log(
      "INFO",
      `Sequence email stage | action=${stage.action} | template_id=${stage.templateId} | subject="${subjectPreview}"`
    );
  }
  return {
    id: resolvedId,
    name: sequence?.name || sequence?.template_name || "",
    steps,
    emailStages,
    raw: response.data,
  };
}

/**
 * Step A: POST /email/email-templates/generate-personalized-email
 */
async function generateEmailContent(
  http,
  log,
  session,
  matchProfileIds,
  cfg,
  stage7Raw,
  readyCandidates,
  opts = {}
) {
  const url = buildUrl(
    cfg.baseUrl,
    cfg.generatePersonalizedEmailPath,
    "/email/email-templates/generate-personalized-email"
  );
  const templateSubject =
    opts.templateSubject ||
    cfg.outreachTemplateSubject ||
    cfg.outreachSubject ||
    "Exciting opportunity";
  const templateBody =
    opts.templateBody ||
    cfg.outreachTemplateBody ||
    cfg.outreachBody ||
    "We found your profile interesting";
  const candidatesData = buildCandidatesDataFromRaw(stage7Raw, readyCandidates);
  const payload = {
    matchIds: matchProfileIds,
    emailDetails: {
      // Template keys align with UI curl payload for Step A.
      template_subject: templateSubject,
      template_body: templateBody,
      // Keep legacy keys for backward compatibility.
      subject: cfg.outreachSubject || "Exciting opportunity",
      body: cfg.outreachBody || "We found your profile interesting",
    },
    candidatesData,
    use_real_data: true,
    feedbacks: [],
    sequenceType: opts.sequenceType || cfg.outreachGenerateSequenceType || "normal",
  };
  const headers = {
    ...browserLikeGetHeaders(session, cfg),
    uid: String(session.userId),
    org_id: String(session.orgId),
    "Content-Type": "application/json",
  };

  log(
    "INFO",
    `Outreach Step A${opts.stageLabel ? ` (${opts.stageLabel})` : ""} | POST ${url} | matchIds=${matchProfileIds.length} | candidatesData=${candidatesData.length}`
  );
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
    const sample = Array.isArray(items) && items.length ? items[0] : response.data;
    const compact = JSON.stringify(sample);
    const snippet = compact && compact.length > 700 ? `${compact.slice(0, 700)}...` : compact;
    log("WARN", `Outreach Step A parse sample | ${snippet || "no sample payload"}`);
    throw new Error(`Outreach Step A missing subject/body for ${missing.length} match profile(s)`);
  }

  log(
    "INFO",
    `Outreach Step A${opts.stageLabel ? ` (${opts.stageLabel})` : ""} success | generated=${byMatchProfileId.size}`
  );
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
    // Candidate rows match the exact UI payload shape used in working curl samples.
    match_profile_ids: outreachCtx.candidates.map((c) => {
      const personalizedSteps = outreachCtx.personalizedStepsByCandidate?.[c.matchProfileId];
      const steps =
        Array.isArray(personalizedSteps) && personalizedSteps.length
          ? personalizedSteps
          : buildCandidateSteps(outreachCtx.sequenceSteps, c);
      return {
        id: c.matchProfileId,
        steps,
        selectedEmails: buildSelectedEmails(c.selectedEmail),
      };
    }),
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

  let sequenceTemplate = null;
  if (shouldUseSequenceTemplateSteps(cfg)) {
    sequenceTemplate = await fetchSequenceTemplate(http, log, session, cfg);
    if (sequenceTemplate?.id) {
      // Ensure sequence id used in Step B matches the fetched template.
      cfg.sequenceId = sequenceTemplate.id;
    }
  }

  let stepA = null;
  let readyCandidates = candidates;
  let generatedByStage = null;
  if (!sequenceTemplate) {
    // Backward-compatible mode: generate personalized preview then send.
    const matchIds = candidates.map((c) => c.matchProfileId);
    stepA = await generateEmailContent(
      http,
      log,
      session,
      matchIds,
      cfg,
      stage7Result?.raw,
      candidates
    );

    // Attach generated subject/body to each candidate by runtime matchProfileId.
    readyCandidates = [];
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
  } else {
    // Sequence-template mode: generate personalized previews for each email stage before create.
    const matchIds = candidates.map((c) => c.matchProfileId);
    generatedByStage = {};
    for (const stage of sequenceTemplate.emailStages || []) {
      const generated = await generateEmailContent(
        http,
        log,
        session,
        matchIds,
        cfg,
        stage7Result?.raw,
        candidates,
        {
          templateSubject: stage.subject,
          templateBody: stage.body,
          sequenceType: "normal",
          stageLabel: `${stage.action}:${stage.templateId}`,
        }
      );
      generatedByStage[stage.idx] = generated.byMatchProfileId;
    }
  }

  const outreachCtx = {
    jobId,
    jobName: getJobName(job),
    orgName: getOrgName(job, cfg),
    candidates: readyCandidates,
    sequenceSteps: sequenceTemplate?.steps || null,
    personalizedStepsByCandidate: sequenceTemplate
      ? Object.fromEntries(
          readyCandidates.map((c) => [
            c.matchProfileId,
            buildCandidatePersonalizedSteps(sequenceTemplate.emailStages, generatedByStage, c),
          ])
        )
      : null,
  };

  if (sequenceTemplate) {
    const expectedStages = (sequenceTemplate.emailStages || []).length;
    for (const c of readyCandidates) {
      const built = outreachCtx.personalizedStepsByCandidate?.[c.matchProfileId] || [];
      if (built.length !== expectedStages) {
        throw new Error(
          `Outreach aborted: personalized previews missing for candidate ${c.matchProfileId} (${built.length}/${expectedStages} stages)`
        );
      }
    }
  }

  const stepB = await sendSequence(http, log, session, outreachCtx, cfg);
  return {
    jobId,
    processedCandidates: readyCandidates.length,
    mode: sequenceTemplate ? "sequence_template_steps" : "generated_preview",
    sequenceTemplate,
    stepA,
    stepB,
  };
}

module.exports = {
  isOutreachRealSendAllowed,
  extractSequenceEmailStages,
  generateEmailContent,
  sendSequence,
  runOutreach,
};
