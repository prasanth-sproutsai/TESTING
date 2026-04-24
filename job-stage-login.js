

const {
  buildLoginUrl,
  formatAxiosError,
  extractSession,
} = require("./job-flow-common");

async function login(http, log, cfg) {
  const loginUrl = buildLoginUrl(cfg.baseUrl);
  log("INFO", `Login | POST ${loginUrl}`);

  try {
    const response = await http.post(loginUrl, {
      username: cfg.username,
      password: cfg.password,
    });

    if (response.status !== 200) {
      throw new Error(`Unexpected login status ${response.status}`);
    }

    const session = extractSession(response.data, cfg.orgIdFallback || "");
    const missing = [];
    if (!session.authToken) missing.push("authToken");
    if (!session.userId) missing.push("userId (uid)");
    if (!session.orgId) missing.push("orgId");

    if (missing.length) {
      log("ERROR", `Login response missing: ${missing.join(", ")}`);
      throw new Error(
        `Login succeeded but could not parse session fields (${missing.join(
          ", "
        )}). For orgId, set ORG_ID (or SANITY_ORG_ID) in .env if your API omits it.`
      );
    }

    log("SUCCESS", "Login OK | authToken, userId, orgId extracted");
    return session;
  } catch (error) {
    const detail = error.response ? formatAxiosError(error) : error.message;
    log("ERROR", `Login failed | ${detail}`);
    throw error;
  }
}

module.exports = { login };
