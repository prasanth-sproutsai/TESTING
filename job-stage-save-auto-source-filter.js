/**
 * Stage 4.5: persist generated auto-source filter.
 * Sequence: GET /job/get_auto_source_filter/:jobId -> POST /job/save-auto-source-filter -> GET /job/auto-source-filter/:jobId
 */

const { normalizeBaseUrl, formatAxiosError, browserLikeGetHeaders } = require("./job-flow-common");

function buildSaveAutoSourceFilterUrl(baseUrl, pathPrefix) {
  const base = normalizeBaseUrl(baseUrl);
  const p = String(pathPrefix || "/job/save-auto-source-filter")
    .replace(/^\/?/, "/")
    .replace(/\/+$/, "");
  return `${base}${p}`;
}

function extractSavedFilter(payload) {
  const root = payload?.data ?? payload;
  if (root && typeof root === "object" && root.job_id != null) return root;
  if (root?.data && typeof root.data === "object" && root.data.job_id != null) return root.data;
  return root;
}

async function saveAutoSourceFilter(http, log, session, jobId, generatedFilter, cfg) {
  const url = buildSaveAutoSourceFilterUrl(cfg.baseUrl, cfg.saveAutoSourceFilterPath);
  const headers = {
    ...browserLikeGetHeaders(session, cfg),
    uid: String(session.userId),
    org_id: String(session.orgId),
    "Content-Type": "application/json",
  };

  // Persist exactly what Stage 4 generated, forcing the current job_id for safety.
  const payload = {
    ...(generatedFilter && typeof generatedFilter === "object" ? generatedFilter : {}),
    job_id: String(jobId),
  };

  log("INFO", `Save auto-source filter | POST ${url} | job_id=${jobId}`);

  const response = await http.post(url, payload, {
    headers,
    validateStatus: () => true,
  });

  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`Save auto-source filter HTTP ${response.status}: ${formatAxiosError({ response })}`);
  }

  const saved = extractSavedFilter(response.data);
  const savedJobId =
    saved?.job_id ??
    saved?.jobId ??
    response?.data?.data?.job_id ??
    response?.data?.job_id;
  if (!savedJobId || String(savedJobId) !== String(jobId)) {
    throw new Error(
      `Save auto-source filter validation failed (expected job_id=${jobId}, got ${savedJobId ?? "missing"})`
    );
  }

  log("SUCCESS", `Auto-source filter persisted successfully | job_id=${savedJobId}`);
  return { status: response.status, saved, raw: response.data };
}

module.exports = {
  saveAutoSourceFilter,
  buildSaveAutoSourceFilterUrl,
};
