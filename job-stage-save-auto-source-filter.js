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

function normalizeSkillsForSourcing(skills) {
  if (!Array.isArray(skills)) return [];
  // Keep object entries as-is; convert plain strings into sourcing-compatible objects.
  return skills
    .map((s) => {
      if (s && typeof s === "object" && String(s.skill || "").trim()) {
        return {
          skill: String(s.skill).trim(),
          preference_type: String(s.preference_type || "nice_to_have"),
        };
      }
      const label = String(s || "").trim();
      if (!label) return null;
      return { skill: label, preference_type: "nice_to_have" };
    })
    .filter(Boolean);
}

function normalizeSkillLabels(skills) {
  if (!Array.isArray(skills)) return [];
  // UI compatibility: many screens read plain skill labels from normalized_skills.
  return skills
    .map((s) => {
      if (s && typeof s === "object" && String(s.skill || "").trim()) return String(s.skill).trim();
      const label = String(s || "").trim();
      return label || null;
    })
    .filter(Boolean);
}

function cleanStringArray(value) {
  if (!Array.isArray(value)) return [];
  // Remove empty items so UI chips don't render blank placeholders.
  return value.map((v) => String(v || "").trim()).filter(Boolean);
}

function cleanIndustryPrerequisites(value) {
  if (!Array.isArray(value)) return [];
  // Drop empty objects like [{}] because some UI mappers treat this as invalid data.
  return value.filter((item) => item && typeof item === "object" && Object.keys(item).length > 0);
}

async function saveAutoSourceFilter(http, log, session, jobId, generatedFilter, cfg) {
  const url = buildSaveAutoSourceFilterUrl(cfg.baseUrl, cfg.saveAutoSourceFilterPath);
  const headers = {
    ...browserLikeGetHeaders(session, cfg),
    uid: String(session.userId),
    org_id: String(session.orgId),
    "Content-Type": "application/json",
  };

  const normalizedSkills = normalizeSkillsForSourcing(generatedFilter?.skills);
  const normalizedSkillLabels = normalizeSkillLabels(generatedFilter?.skills);
  // Persist generated filter with sourcing-friendly defaults, forcing the current job_id for safety.
  const payload = {
    ...(generatedFilter && typeof generatedFilter === "object" ? generatedFilter : {}),
    job_id: String(jobId),
    // Keep API-facing object shape.
    skills: normalizedSkills,
    // Keep UI-facing string shape as compatibility fallback.
    normalized_skills:
      Array.isArray(generatedFilter?.normalized_skills) && generatedFilter.normalized_skills.length
        ? cleanStringArray(generatedFilter.normalized_skills)
        : normalizedSkillLabels,
    // Ensure list fields are always clean arrays for UI chips/selectors.
    similar_titles: cleanStringArray(generatedFilter?.similar_titles),
    similar_companies: cleanStringArray(generatedFilter?.similar_companies),
    location: cleanStringArray(generatedFilter?.location),
    company_match_attributes: cleanStringArray(generatedFilter?.company_match_attributes),
    industry_prerequisites: cleanIndustryPrerequisites(generatedFilter?.industry_prerequisites),
    title_search_depth:
      generatedFilter?.title_search_depth && String(generatedFilter.title_search_depth).trim()
        ? generatedFilter.title_search_depth
        : "current_only",
    similar_companies_search_depth:
      generatedFilter?.similar_companies_search_depth &&
      String(generatedFilter.similar_companies_search_depth).trim()
        ? generatedFilter.similar_companies_search_depth
        : "current_only",
    prospect_count: Number(generatedFilter?.prospect_count || cfg?.sourcingCandidateCount || 20),
  };

  log(
    "INFO",
    `Save auto-source filter | POST ${url} | job_id=${jobId} | normalizedSkills=${normalizedSkills.length}`
  );

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
