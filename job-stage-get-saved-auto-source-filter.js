/**
 * Stage 5: GET persisted auto-source filter (after Stage 4 generates/persists it).
 */

const {
  normalizeBaseUrl,
  formatAxiosError,
  sleep,
  browserLikeGetHeaders,
} = require("./job-flow-common");

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function noRetryError(message) {
  const e = new Error(message);
  e.savedFilterNoRetry = true;
  return e;
}

function buildSavedAutoSourceFilterUrl(baseUrl, jobId, pathPrefix) {
  const base = normalizeBaseUrl(baseUrl);
  const p = String(pathPrefix || "/job/auto-source-filter")
    .replace(/^\/?/, "/")
    .replace(/\/+$/, "");
  const id = encodeURIComponent(String(jobId).trim());
  return `${base}${p}/${id}`;
}

// Unwrap { code, message, data } → saved filter document.
function extractSavedFilterFromPayload(payload) {
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

function validateSavedAutoSourceFilter(filter, expectedJobId) {
  const errors = [];
  if (!filter) {
    errors.push("saved filter body missing");
    return errors;
  }
  if (String(filter.job_id) !== String(expectedJobId)) {
    errors.push(`job_id mismatch (expected ${expectedJobId}, got ${filter.job_id})`);
  }
  const pc = filter.prospect_count;
  if (pc == null || !Number.isFinite(Number(pc))) {
    errors.push("prospect_count must be a finite number");
  }
  if (!locationIsPresent(filter)) {
    errors.push("location missing or empty");
  }
  return errors;
}

/**
 * GET /job/auto-source-filter/:jobId
 * Retries on 404 only (eventual consistency after Stage 04), 5–10s delay, up to 3 retries after first attempt.
 * Does not retry 401.
 */
async function getSavedAutoSourceFilter(http, log, session, jobId, cfg) {
  const url = buildSavedAutoSourceFilterUrl(
    cfg.baseUrl,
    jobId,
    cfg.savedAutoSourceFilterPath
  );
  const max404Retries = Math.max(
    0,
    parseInt(cfg.savedAutoSourceFilter404Retries ?? "3", 10) || 3
  );
  const delayMinMs = Math.max(
    1000,
    parseInt(cfg.savedAutoSourceFilter404DelayMinMs ?? "5000", 10) || 5000
  );
  const delayMaxMs = Math.max(
    delayMinMs,
    parseInt(cfg.savedAutoSourceFilter404DelayMaxMs ?? "10000", 10) || 10000
  );
  const maxTries = 1 + max404Retries;

  const headers = browserLikeGetHeaders(session, cfg);

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    log(
      "INFO",
      `Saved auto-source filter | GET ${url} | attempt ${attempt}/${maxTries}`
    );

    const response = await http.get(url, {
      headers,
      validateStatus: () => true,
    });

    const status = response.status;

    if (status === 401) {
      const detail = formatAxiosError({ response });
      log("ERROR", `Saved auto-source filter unauthorized | ${detail}`);
      throw noRetryError("Saved auto-source filter HTTP 401 (no retry)");
    }

    if (status === 404) {
      log("WARN", "Saved auto-source filter not found yet (404)");
      if (attempt < maxTries) {
        const delayMs = randomInt(delayMinMs, delayMaxMs);
        log("INFO", `Saved auto-source filter retry after ${delayMs}ms (eventual consistency)`);
        await sleep(delayMs);
        continue;
      }
      log("ERROR", "Saved auto-source filter still 404 after all retries");
      throw new Error("Saved auto-source filter HTTP 404 after retries");
    }

    if (status !== 200) {
      log("ERROR", `Saved auto-source filter unexpected HTTP ${status}`);
      throw new Error(`Saved auto-source filter HTTP ${status}`);
    }

    const filter = extractSavedFilterFromPayload(response.data);
    const validationErrors = validateSavedAutoSourceFilter(filter, jobId);
    if (validationErrors.length) {
      log("ERROR", `Saved auto-source filter validation failed | ${validationErrors.join("; ")}`);
      throw noRetryError(validationErrors.join("; "));
    }

    log("INFO", `Saved auto-source filter full response | ${JSON.stringify(filter)}`);
    log("SUCCESS", "Saved auto-source filter retrieved successfully");
    return { filter, status, raw: response.data };
  }

  throw new Error("Saved auto-source filter: unexpected loop exit");
}

module.exports = {
  getSavedAutoSourceFilter,
  validateSavedAutoSourceFilter,
  buildSavedAutoSourceFilterUrl,
};
