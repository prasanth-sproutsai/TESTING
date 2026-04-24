/**
 * Stage 6: trigger sourcing for a job (POST job/sourceCandidates by default).
 * Legacy path was /automation/pipeline/sourcing; set SOURCING_PATH to override.
 */

const { normalizeBaseUrl, formatAxiosError, sleep, browserLikeGetHeaders } = require("./job-flow-common");

function buildSourcingUrl(baseUrl, pathPrefix) {
  const base = normalizeBaseUrl(baseUrl);
  const p = String(pathPrefix || "/job/sourceCandidates")
    .replace(/^\/?/, "/")
    .replace(/\/+$/, "");
  return `${base}${p}`;
}

function noRetryError(message) {
  const e = new Error(message);
  e.sourcingNoRetry = true;
  return e;
}

function isRecentTimestamp(isoString, cooldownMs) {
  if (!isoString || !cooldownMs || cooldownMs <= 0) return false;
  const t = Date.parse(String(isoString));
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < cooldownMs;
}

// Read the first non-empty field from a list of source objects.
function pickFirstDefined(sources, keys) {
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const key of keys) {
      if (src[key] !== undefined && src[key] !== null && String(src[key]).trim() !== "") {
        return src[key];
      }
    }
  }
  return undefined;
}

// Normalize new + legacy sourcing response variants into one shape.
function normalizeSourcingResponse(body) {
  const root = body && typeof body === "object" ? body : {};
  const data = root.data && typeof root.data === "object" ? root.data : null;
  const result = root.result && typeof root.result === "object" ? root.result : null;
  const payload = root.payload && typeof root.payload === "object" ? root.payload : null;
  const sources = [data, result, payload, root];

  const rawSuccess = pickFirstDefined(sources, ["success", "ok", "status"]);
  const success =
    rawSuccess === true ||
    rawSuccess === "true" ||
    rawSuccess === "ok" ||
    rawSuccess === "success";

  const jobId = pickFirstDefined(sources, ["job_id", "jobId", "_id", "id"]);
  const lastTriggeredAt = pickFirstDefined(sources, [
    "last_triggered_at",
    "lastTriggeredAt",
    "triggered_at",
    "triggeredAt",
    "updatedAt",
    "createdAt",
  ]);
  const candidateCount = pickFirstDefined(sources, ["candidateCount", "candidate_count", "prospect_count"]);

  return {
    success,
    rawSuccess,
    job_id: jobId != null ? String(jobId) : "",
    last_triggered_at: lastTriggeredAt != null ? String(lastTriggeredAt) : "",
    candidateCount: candidateCount != null ? Number(candidateCount) : undefined,
  };
}

function validateSourcingResponse(data, expectedJobId) {
  const errors = [];
  if (!data || typeof data !== "object") {
    errors.push("response data missing");
    return errors;
  }
  // Only fail on explicit false values. Some endpoints omit "success" on 200.
  if (data.rawSuccess !== undefined && data.success !== true) {
    errors.push(`success is not true (got ${JSON.stringify(data.rawSuccess)})`);
  }
  // Fail mismatch only when response provides a job id.
  if (data.job_id && String(data.job_id) !== String(expectedJobId)) {
    errors.push(`job_id mismatch (expected ${expectedJobId}, got ${data.job_id})`);
  }
  return errors;
}

function cleanStringArray(value) {
  if (!Array.isArray(value)) return [];
  // Keep UI/history payload clean by dropping blank entries.
  return value.map((v) => String(v || "").trim()).filter(Boolean);
}

function normalizeSkills(value) {
  if (!Array.isArray(value)) return [];
  // Accept both ["Node.js"] and [{ skill: "Node.js", preference_type: "nice_to_have" }].
  return value
    .map((item) => {
      if (item && typeof item === "object") {
        const skill = String(item.skill || item.label || "").trim();
        if (!skill) return null;
        return {
          skill,
          preference_type: String(item.preference_type || "nice_to_have").trim() || "nice_to_have",
        };
      }
      const skill = String(item || "").trim();
      if (!skill) return null;
      return { skill, preference_type: "nice_to_have" };
    })
    .filter(Boolean);
}

function cleanObjectArray(value) {
  if (!Array.isArray(value)) return [];
  // Remove null/empty objects to avoid malformed filter history rows.
  return value.filter((item) => item && typeof item === "object" && Object.keys(item).length > 0);
}

function normalizeEducation(value) {
  const edu = value && typeof value === "object" ? value : {};
  // Keep education shape stable for sourcing endpoint and UI history rendering.
  return {
    universities: cleanStringArray(edu.universities),
    top_n: Number.isFinite(Number(edu.top_n)) ? Number(edu.top_n) : 0,
    field: cleanStringArray(edu.field),
    degrees: cleanStringArray(edu.degrees),
  };
}

function pruneEmpty(value) {
  const out = {};
  for (const [k, v] of Object.entries(value || {})) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "string" && !v.trim()) continue;
    out[k] = v;
  }
  return out;
}

function buildSourcingPayload(jobId, candidateCount, sourcingFilter) {
  // Baseline payload expected by sourcing trigger.
  const base = {
    job_id: String(jobId),
    count: candidateCount,
    candidateCount,
  };

  if (!sourcingFilter || typeof sourcingFilter !== "object") {
    return base;
  }

  const skills = normalizeSkills(sourcingFilter.skills);
  const normalizedSkills =
    Array.isArray(sourcingFilter.normalized_skills) && sourcingFilter.normalized_skills.length
      ? cleanStringArray(sourcingFilter.normalized_skills)
      : skills.map((s) => s.skill);

  // Pass saved filter fields so backend history/UI can show complete criteria.
  const enriched = pruneEmpty({
    ...base,
    location: cleanStringArray(sourcingFilter.location),
    location_radius: Number.isFinite(Number(sourcingFilter.location_radius))
      ? Number(sourcingFilter.location_radius)
      : 25,
    min_exp: Number.isFinite(Number(sourcingFilter.min_exp)) ? Number(sourcingFilter.min_exp) : undefined,
    max_exp: Number.isFinite(Number(sourcingFilter.max_exp)) ? Number(sourcingFilter.max_exp) : undefined,
    similar_titles: cleanStringArray(sourcingFilter.similar_titles),
    similar_companies: cleanStringArray(sourcingFilter.similar_companies),
    industries: cleanStringArray(sourcingFilter.industries),
    company_match_attributes: cleanStringArray(sourcingFilter.company_match_attributes),
    industry_prerequisites: cleanObjectArray(sourcingFilter.industry_prerequisites),
    custom_attributes: cleanObjectArray(sourcingFilter.custom_attributes),
    skills,
    normalized_skills: normalizedSkills,
    education: normalizeEducation(sourcingFilter.education),
  });

  return enriched;
}

/**
 * POST {BASE_URL}{sourcingPath} (default /job/sourceCandidates, same host as BASE_URL).
 * Retry only on 5xx / transient network failures.
 */
async function triggerSourcing(http, log, session, jobId, cfg, sourcingFilter) {
  // Allow paths like /job/sourceCandidates/{jobId} when SOURCING_PATH contains {jobId}.
  const pathResolved = String(cfg.sourcingPath || "")
    .replace(/\{jobId\}/g, String(jobId).trim())
    .replace(/\{JOB_ID\}/g, String(jobId).trim());
  const url = buildSourcingUrl(cfg.baseUrl, pathResolved || undefined);
  const maxAttempts = Math.max(1, Number(cfg.sourcingMaxAttempts || 3));
  const baseDelayMs = Math.max(100, Number(cfg.sourcingBackoffMs || 1000));
  const candidateCount = Math.max(1, Number(cfg.sourcingCandidateCount || 20));
  const cooldownMs = Math.max(0, Number(cfg.sourcingCooldownMs || 0));

  // Browser-like headers + JSON content type for POST payload.
  const headers = {
    ...browserLikeGetHeaders(session, cfg),
    "Content-Type": "application/json",
  };

  const payload = buildSourcingPayload(jobId, candidateCount, sourcingFilter);

  let lastErr = null;
  let lastTriggeredAt = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Optional cooldown guard for repeated calls in the same process.
    if (isRecentTimestamp(lastTriggeredAt, cooldownMs)) {
      log("WARN", `Sourcing trigger skipped by cooldown (${cooldownMs}ms window)`);
      return {
        skipped: true,
        reason: "cooldown",
        job_id: String(jobId),
        last_triggered_at: lastTriggeredAt,
      };
    }

    log(
      "INFO",
      `Source candidates | POST ${url} | attempt ${attempt}/${maxAttempts} | job_id=${payload.job_id} | candidateCount=${payload.candidateCount} | skills=${Array.isArray(payload.skills) ? payload.skills.length : 0} | locations=${Array.isArray(payload.location) ? payload.location.length : 0}`
    );

    try {
      const response = await http.post(url, payload, {
        headers,
        validateStatus: () => true,
      });

      const status = response.status;
      const body = response.data || {};
      const data = normalizeSourcingResponse(body);

      if (status === 400) {
        const detail = formatAxiosError({ response });
        log("ERROR", `Sourcing client/config error | ${detail}`);
        throw noRetryError(`Sourcing HTTP 400 (no retry): ${detail}`);
      }

      if (status >= 500) {
        lastErr = new Error(`Sourcing HTTP ${status}`);
        log("WARN", `Sourcing server error | HTTP ${status}`);
        if (attempt < maxAttempts) {
          const delayMs = Math.pow(2, attempt - 1) * baseDelayMs;
          log("INFO", `Sourcing retry backoff | ${delayMs}ms`);
          await sleep(delayMs);
        }
        continue;
      }

      if (status !== 200) {
        throw noRetryError(`Sourcing unexpected HTTP ${status}`);
      }

      const validationErrors = validateSourcingResponse(data, jobId);
      if (validationErrors.length) {
        // Include compact payload to debug contract differences quickly.
        const compact = JSON.stringify(body);
        const snippet = compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
        log("WARN", `Sourcing response shape | ${snippet}`);
        throw noRetryError(validationErrors.join("; "));
      }

      // If API omits timestamp, use local now for cooldown bookkeeping.
      lastTriggeredAt = data.last_triggered_at || new Date().toISOString();
      log(
        "INFO",
        `Sourcing response | job_id=${data.job_id || jobId} | candidateCount=${data.candidateCount ?? "n/a"} | last_triggered_at=${data.last_triggered_at || "n/a"}`
      );
      log("SUCCESS", "Sourcing pipeline triggered successfully");
      return { status, data: { ...data, job_id: data.job_id || String(jobId) }, raw: body };
    } catch (error) {
      if (error.sourcingNoRetry) {
        log("ERROR", `Sourcing failed | ${error.message}`);
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
        log("WARN", `Sourcing request failed (${error.message}), retry in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }

      const detail = error.response ? formatAxiosError(error) : error.message;
      log("ERROR", `Sourcing failed | ${detail}`);
      throw error;
    }
  }

  throw lastErr || new Error("Sourcing failed after retries");
}

module.exports = {
  triggerSourcing,
  validateSourcingResponse,
  normalizeSourcingResponse,
  buildSourcingPayload,
  buildSourcingUrl,
};
