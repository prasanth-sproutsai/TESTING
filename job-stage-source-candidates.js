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

function validateSourcingResponse(data, expectedJobId) {
  const errors = [];
  if (!data || typeof data !== "object") {
    errors.push("response data missing");
    return errors;
  }
  if (data.success !== true) {
    errors.push(`success is not true (got ${JSON.stringify(data.success)})`);
  }
  if (String(data.job_id) !== String(expectedJobId)) {
    errors.push(`job_id mismatch (expected ${expectedJobId}, got ${data.job_id})`);
  }
  if (!data.last_triggered_at || !String(data.last_triggered_at).trim()) {
    errors.push("last_triggered_at missing");
  }
  return errors;
}

/**
 * POST {BASE_URL}{sourcingPath} (default /job/sourceCandidates, same host as BASE_URL).
 * Retry only on 5xx / transient network failures.
 */
async function triggerSourcing(http, log, session, jobId, cfg) {
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

  const payload = {
    job_id: String(jobId),
    candidateCount,
  };

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
      `Source candidates | POST ${url} | attempt ${attempt}/${maxAttempts} | job_id=${payload.job_id} | candidateCount=${payload.candidateCount}`
    );

    try {
      const response = await http.post(url, payload, {
        headers,
        validateStatus: () => true,
      });

      const status = response.status;
      const body = response.data || {};
      const data = body.data ?? body;

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
        throw noRetryError(validationErrors.join("; "));
      }

      lastTriggeredAt = String(data.last_triggered_at);
      log(
        "INFO",
        `Sourcing response | job_id=${data.job_id} | candidateCount=${data.candidateCount} | last_triggered_at=${data.last_triggered_at}`
      );
      log("SUCCESS", "Sourcing pipeline triggered successfully");
      return { status, data, raw: body };
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
  buildSourcingUrl,
};
