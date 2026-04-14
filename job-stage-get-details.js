/**
 * Stage 3: GET job by id (e.g. /job/job_details/:id) and validate the payload.
 */

const {
  normalizeBaseUrl,
  formatAxiosError,
  pickId,
} = require("./job-flow-common");

// Build GET URL: {base}{path}/{jobId}[?query].
function buildJobDetailsUrl(baseUrl, jobId, jobDetailsPath, jobDetailsQuery) {
  const base = normalizeBaseUrl(baseUrl);
  const path = String(jobDetailsPath || "/job/job_details").replace(/^\/?/, "/");
  const id = encodeURIComponent(String(jobId).trim());
  const q = String(jobDetailsQuery || "").trim();
  const suffix = q ? `?${q}` : "";
  return `${base}${path}/${id}${suffix}`;
}

// Unwrap job object from GET /job/details or /job/job_details style responses.
function extractJobFromDetailsPayload(payload) {
  // Common: { code, message, data: { id, position, company, status, ... } }
  let root = payload?.data ?? payload;
  if (root && typeof root === "object" && root.data) {
    const inner = root.data;
    if (
      inner &&
      typeof inner === "object" &&
      (inner.job || inner._id || inner.id || inner.name || inner.position)
    ) {
      root = inner;
    }
  }
  const job = root?.job ?? root?.result ?? root;
  if (
    job &&
    typeof job === "object" &&
    (job._id != null || job.id != null || jobNamePresent(job))
  ) {
    return job;
  }
  return null;
}

function jobNamePresent(job) {
  const n =
    job?.name ??
    job?.position ??
    job?.internal_job_name ??
    job?.job_name ??
    job?.title ??
    job?.jobTitle;
  return n != null && String(n).trim() !== "";
}

function companyIsPresent(job) {
  const c = job?.company;
  if (c == null) return false;
  if (typeof c === "string") return c.trim().length > 0;
  if (typeof c === "object") {
    if (c.name != null && String(c.name).trim()) return true;
    if (c._id != null || c.id != null) return true;
  }
  return false;
}

async function getJobDetails(http, log, session, jobId, cfg) {
  const url = buildJobDetailsUrl(
    cfg.baseUrl,
    jobId,
    cfg.jobDetailsPath,
    cfg.jobDetailsQuery
  );
  const headers = {
    Authorization: `Bearer ${session.authToken}`,
    uid: String(session.userId),
    org_id: String(session.orgId),
    "Content-Type": "application/json",
  };

  log("INFO", `Job details | GET ${url}`);

  try {
    const response = await http.get(url, {
      headers,
      validateStatus: (status) => status === 200,
    });

    if (response.status !== 200) {
      log("ERROR", `Job details expected HTTP 200, got ${response.status}`);
      throw new Error(`Job details HTTP ${response.status}`);
    }

    const job = extractJobFromDetailsPayload(response.data);
    if (!job) {
      log("ERROR", "Job details response did not contain a parseable job object");
      throw new Error("Job details parse failed");
    }

    return { job, status: response.status, raw: response.data };
  } catch (error) {
    const detail = error.response ? formatAxiosError(error) : error.message;
    log("ERROR", `Job details failed | ${detail}`);
    throw error;
  }
}

// Sanity checks after create: id, name/position, company, active status.
function validateJobDetails(job, expectedJobId) {
  const errors = [];
  const idFromJob = pickId(job);
  if (!idFromJob || String(idFromJob) !== String(expectedJobId)) {
    errors.push(`jobId mismatch (expected ${expectedJobId}, got ${idFromJob ?? "missing"})`);
  }
  const displayName =
    job.name ??
    job.position ??
    job.internal_job_name ??
    job.job_name ??
    job.title ??
    job.jobTitle;
  if (displayName == null || String(displayName).trim() === "") {
    errors.push("name missing or empty");
  }
  if (!companyIsPresent(job)) {
    errors.push("company missing");
  }
  const statusRaw = job.status ?? job.job_status ?? job.jobStatus;
  if (String(statusRaw || "").toLowerCase() !== "active") {
    errors.push(`status is not active (got ${JSON.stringify(statusRaw)})`);
  }
  return errors;
}

module.exports = {
  getJobDetails,
  validateJobDetails,
  buildJobDetailsUrl,
  extractJobFromDetailsPayload,
};
