/**
 * Stage 4: GET auto-source filter for a job (merged internal + external sourcing criteria).
 */

const {
  normalizeBaseUrl,
  formatAxiosError,
  sleep,
  browserLikeGetHeaders,
} = require("./job-flow-common");

// Errors that must not trigger 5xx/network retry (bad input, bad payload, unexpected HTTP).
function noRetryError(message) {
  const e = new Error(message);
  e.autoSourceNoRetry = true;
  return e;
}

function buildAutoSourceFilterUrl(baseUrl, jobId, pathPrefix) {
  const base = normalizeBaseUrl(baseUrl);
  const p = String(pathPrefix || "/job/get_auto_source_filter")
    .replace(/^\/?/, "/")
    .replace(/\/+$/, "");
  const id = encodeURIComponent(String(jobId).trim());
  return `${base}${p}/${id}`;
}

// Normalize { code, message, data } → filter object.
function extractFilterFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const inner = payload.data;
  if (inner && typeof inner === "object" && inner.job_id != null) {
    return inner;
  }
  if (payload.job_id != null) {
    return payload;
  }
  return null;
}

function locationIsPresent(filter) {
  const loc = filter?.location;
  if (loc == null) return false;
  if (Array.isArray(loc)) return loc.length > 0 && String(loc[0] || "").trim() !== "";
  if (typeof loc === "string") return loc.trim() !== "";
  return false;
}

function validateAutoSourceFilter(filter, expectedJobId) {
  const errors = [];
  if (!filter) {
    errors.push("filter body missing");
    return errors;
  }
  if (String(filter.job_id) !== String(expectedJobId)) {
    errors.push(`job_id mismatch (expected ${expectedJobId}, got ${filter.job_id})`);
  }
  if (!Array.isArray(filter.skills) || filter.skills.length === 0) {
    errors.push("skills must be a non-empty array");
  }
  if (!locationIsPresent(filter)) {
    errors.push("location missing or empty");
  }
  const minExp = Number(filter.min_exp);
  const maxExp = Number(filter.max_exp);
  if (!Number.isFinite(minExp) || !Number.isFinite(maxExp)) {
    errors.push("min_exp and max_exp must be valid numbers");
  } else if (minExp > maxExp) {
    errors.push("min_exp must be <= max_exp");
  }
  return errors;
}

function logFilterAudit(log, filter, logFull) {
  const snapshot = {
    job_id: filter.job_id,
    skills: filter.skills,
    location: filter.location,
    min_exp: filter.min_exp,
    max_exp: filter.max_exp,
    similar_titles: filter.similar_titles,
    similar_companies: filter.similar_companies,
  };
  log("INFO", `Auto-source filter snapshot | ${JSON.stringify(snapshot)}`);
  if (logFull) {
    log("INFO", `Auto-source filter full response | ${JSON.stringify(filter)}`);
  }
}

/**
 * GET /job/get_auto_source_filter/:jobId — retries on 5xx / network errors (up to maxAttempts).
 * Does not retry on 400/404.
 */
async function getAutoSourceFilter(http, log, session, jobId, cfg) {
  const url = buildAutoSourceFilterUrl(cfg.baseUrl, jobId, cfg.autoSourceFilterPath);
  const maxAttempts = Number(cfg.autoSourceFilterMaxAttempts || 3);
  const baseDelayMs = Number(cfg.autoSourceFilterBackoffMs || 1000);
  const logFull = cfg.autoSourceFilterLogFull === true || cfg.autoSourceFilterLogFull === "1";

  // Match browser GET (test.app): Accept, Origin, Referer — no Content-Type / If-None-Match on GET.
  const headers = browserLikeGetHeaders(session, cfg);

  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log("INFO", `Auto-source filter | GET ${url} | attempt ${attempt}/${maxAttempts}`);

    try {
      const response = await http.get(url, {
        headers,
        validateStatus: () => true,
      });

      const status = response.status;

      if (status === 400 || status === 404) {
        const detail = formatAxiosError({ response });
        log("ERROR", `Auto-source filter client error | ${detail}`);
        throw noRetryError(`Auto-source filter HTTP ${status} (no retry)`);
      }

      if (status >= 500) {
        lastErr = new Error(`Auto-source filter HTTP ${status}`);
        log("WARN", `Auto-source filter server error | HTTP ${status}`);
        if (attempt < maxAttempts) {
          const delayMs = Math.pow(2, attempt - 1) * baseDelayMs;
          log("INFO", `Auto-source filter retry backoff | ${delayMs}ms`);
          await sleep(delayMs);
        }
        continue;
      }

      if (status !== 200) {
        log("ERROR", `Auto-source filter unexpected HTTP ${status}`);
        throw noRetryError(`Auto-source filter HTTP ${status}`);
      }

      const filter = extractFilterFromPayload(response.data);
      const validationErrors = validateAutoSourceFilter(filter, jobId);
      if (validationErrors.length) {
        log("ERROR", `Auto-source filter validation failed | ${validationErrors.join("; ")}`);
        throw noRetryError(validationErrors.join("; "));
      }

      logFilterAudit(log, filter, logFull);
      log("SUCCESS", "Auto-source filter generated successfully");
      return { filter, status, raw: response.data };
    } catch (error) {
      if (error.autoSourceNoRetry) {
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
        log(
          "WARN",
          `Auto-source filter request failed (${error.message}), retry in ${delayMs}ms`
        );
        await sleep(delayMs);
        continue;
      }

      const detail = error.response ? formatAxiosError(error) : error.message;
      log("ERROR", `Auto-source filter failed | ${detail}`);
      throw error;
    }
  }

  log("ERROR", "Auto-source filter exhausted retries");
  throw lastErr || new Error("Auto-source filter failed after retries");
}

module.exports = {
  getAutoSourceFilter,
  validateAutoSourceFilter,
  buildAutoSourceFilterUrl,
};
