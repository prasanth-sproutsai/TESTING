/**
 * Stage 2: POST /job/create and return new jobId.
 */

const { buildJobCreateUrl, formatAxiosError, extractJobId } = require("./job-flow-common");
const { buildDynamicSoftwareJobPayload } = require("./job-create-payload");

async function createJob(http, log, session, cfg) {
  const jobUrl = buildJobCreateUrl(cfg.baseUrl, cfg.jobCreatePath);
  const body = buildDynamicSoftwareJobPayload();

  if (cfg.printPayload) {
    log("INFO", `Job payload: ${JSON.stringify(body)}`);
  }

  const headers = {
    Authorization: `Bearer ${session.authToken}`,
    uid: String(session.userId),
    org_id: String(session.orgId),
    "Content-Type": "application/json",
  };

  log("INFO", `Create job | POST ${jobUrl} | name="${body.name}"`);

  try {
    const response = await http.post(jobUrl, body, {
      headers,
      validateStatus: (status) => status === 200 || status === 201,
    });

    const jobId = extractJobId(response.data);
    if (!jobId) {
      log("ERROR", "Job create returned 200/201 but jobId could not be parsed from response");
      throw new Error("Job created but jobId not found in response (extend extractJobId())");
    }

    log("SUCCESS", `Job created | jobId=${jobId} | status=${response.status}`);
    return { jobId, status: response.status, raw: response.data };
  } catch (error) {
    const detail = error.response ? formatAxiosError(error) : error.message;
    log("ERROR", `Job creation failed | ${detail}`);
    throw error;
  }
}

module.exports = { createJob };
