/**
 * Stage 7: fetch match profiles for a job after sourcing trigger.
 */

const { normalizeBaseUrl, formatAxiosError, sleep, browserLikeGetHeaders } = require("./job-flow-common");

function buildMatchProfilesUrl(baseUrl, jobId, pathPrefix) {
  const base = normalizeBaseUrl(baseUrl);
  const p = String(pathPrefix || "/job/get_match_profiles")
    .replace(/^\/?/, "/")
    .replace(/\/+$/, "");
  const id = encodeURIComponent(String(jobId).trim());
  return `${base}${p}/${id}`;
}

function buildQueryString(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null) continue;
    const val = String(v).trim();
    if (!val) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(val)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function noRetryError(message) {
  const e = new Error(message);
  e.matchProfilesNoRetry = true;
  return e;
}

function pickFirstEmail(applicant) {
  const work = Array.isArray(applicant?.work_email) ? applicant.work_email : [];
  const personal = Array.isArray(applicant?.email) ? applicant.email : [];
  const workFirst = work.find((v) => String(v || "").trim());
  if (workFirst) return String(workFirst).trim();
  const personalFirst = personal.find((v) => String(v || "").trim());
  if (personalFirst) return String(personalFirst).trim();
  return "";
}

function extractDocs(payload) {
  const root = payload?.data ?? payload;
  if (Array.isArray(root?.docs)) return root.docs;
  if (Array.isArray(root?.data?.docs)) return root.data.docs;
  // Dev API variant: docs are returned as `data.content`.
  if (Array.isArray(root?.content)) return root.content;
  if (Array.isArray(root?.data?.content)) return root.data.content;
  return null;
}

function extractTotalDocs(payload, docs) {
  const root = payload?.data ?? payload;
  const total =
    root?.totalDocs ??
    root?.total_docs ??
    root?.metadata?.totalDocs ??
    root?.metadata?.total_docs ??
    root?.counts?.totalDocs ??
    root?.counts?.total_docs ??
    root?.counts?.total ??
    root?.data?.totalDocs ??
    root?.data?.total_docs;
  if (Number.isFinite(Number(total))) return Number(total);
  return Array.isArray(docs) ? docs.length : 0;
}

/**
 * GET /job/get_match_profiles/:jobId
 * Retries on 5xx and transient network failures up to maxAttempts.
 */
async function getMatchProfiles(http, log, session, jobId, cfg) {
  const method = String(cfg.matchProfilesMethod || "POST").toUpperCase();
  const qs = buildQueryString({
    thumbsUp: cfg.matchProfilesThumbsUp,
    source: cfg.matchProfilesSource,
    limit: cfg.matchProfilesLimit,
    page: cfg.matchProfilesPage,
  });
  const url = `${buildMatchProfilesUrl(cfg.baseUrl, jobId, cfg.matchProfilesPath)}${qs}`;
  const maxAttempts = Math.max(1, Number(cfg.matchProfilesMaxAttempts || 3));
  const baseDelayMs = Math.max(100, Number(cfg.matchProfilesBackoffMs || 1000));
  const headers = {
    ...browserLikeGetHeaders(session, cfg),
    "Content-Type": "application/json",
  };

  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log("INFO", `Match profiles | GET ${url} | attempt ${attempt}/${maxAttempts}`);

    try {
      const response =
        method === "POST"
          ? await http.post(url, {}, { headers, validateStatus: () => true })
          : await http.get(url, { headers, validateStatus: () => true });

      const status = response.status;
      if (status >= 500) {
        lastErr = new Error(`Match profiles HTTP ${status}`);
        log("WARN", `Match profiles server error | HTTP ${status}`);
        if (attempt < maxAttempts) {
          const delayMs = Math.pow(2, attempt - 1) * baseDelayMs;
          log("INFO", `Match profiles retry backoff | ${delayMs}ms`);
          await sleep(delayMs);
        }
        continue;
      }

      if (status !== 200) {
        throw noRetryError(`Match profiles unexpected HTTP ${status}`);
      }

      const docs = extractDocs(response.data);
      if (!Array.isArray(docs)) {
        throw noRetryError("Match profiles response missing data.docs");
      }
      if (!Array.isArray(response?.data?.data?.docs)) {
        log("WARN", "Match profiles response has no data.docs; using data.content fallback");
      }

      const totalDocs = extractTotalDocs(response.data, docs);
      log("INFO", `Match profiles stats | job_id=${jobId} | totalDocs=${totalDocs}`);

      if (docs.length === 0) {
        log("WARN", "No candidates found yet");
        return {
          status,
          totalDocs,
          profilesByJob: [{ job_id: String(jobId), profiles: [] }],
          extractedCount: 0,
          skipped: true,
          raw: response.data,
        };
      }

      const seen = new Set();
      const profiles = [];
      let skippedMissingMatchProfileId = 0;
      let skippedMissingApplicantId = 0;
      let skippedMissingEmail = 0;
      let skippedDuplicate = 0;
      for (const doc of docs) {
        const matchProfileId = doc?._id != null ? String(doc._id) : "";
        const applicant = doc?.applicant && typeof doc.applicant === "object" ? doc.applicant : null;
        const applicantId = applicant?._id != null ? String(applicant._id) : "";
        const email = pickFirstEmail(applicant);

        // Deduplicate by match profile id and skip incomplete rows for downstream sequence safety.
        if (!matchProfileId) {
          skippedMissingMatchProfileId++;
          continue;
        }
        if (!applicantId) {
          skippedMissingApplicantId++;
          continue;
        }
        if (!email) {
          skippedMissingEmail++;
          continue;
        }
        if (seen.has(matchProfileId)) {
          skippedDuplicate++;
          continue;
        }
        seen.add(matchProfileId);

        profiles.push({
          matchProfile: { _id: matchProfileId },
          applicant: {
            _id: applicantId,
            email: Array.isArray(applicant?.email) ? applicant.email : [],
            work_email: Array.isArray(applicant?.work_email) ? applicant.work_email : [],
          },
        });
      }

      const profilesByJob = [{ job_id: String(jobId), profiles }];
      if (
        skippedMissingMatchProfileId ||
        skippedMissingApplicantId ||
        skippedMissingEmail ||
        skippedDuplicate
      ) {
        log(
          "INFO",
          `Match profiles skipped | missingMatchProfileId=${skippedMissingMatchProfileId} | missingApplicantId=${skippedMissingApplicantId} | missingEmail=${skippedMissingEmail} | duplicate=${skippedDuplicate}`
        );
      }
      log("INFO", `Match profiles extracted | job_id=${jobId} | extractedProfiles=${profiles.length}`);
      return {
        status,
        totalDocs,
        extractedCount: profiles.length,
        profilesByJob,
        raw: response.data,
      };
    } catch (error) {
      if (error.matchProfilesNoRetry) {
        log("ERROR", `Match profiles failed | ${error.message}`);
        throw error;
      }

      const transient =
        error.code === "ECONNRESET" ||
        error.code === "ETIMEDOUT" ||
        error.code === "ECONNABORTED" ||
        (!error.response && error.request);

      if (transient && attempt < maxAttempts) {
        lastErr = error;
        const delayMs = Math.pow(2, attempt - 1) * baseDelayMs;
        log("WARN", `Match profiles request failed (${error.message}), retry in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }

      const detail = error.response ? formatAxiosError(error) : error.message;
      log("ERROR", `Match profiles failed | ${detail}`);
      throw error;
    }
  }

  throw lastErr || new Error("Match profiles failed after retries");
}

module.exports = {
  getMatchProfiles,
  buildMatchProfilesUrl,
};
