/**
 * Shared dynamic job body for POST /job/create (Sprouts-style UI).
 * Reads JOB_* env vars each call so sanity-job-flow and stage-2 stay aligned.
 */

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  if (!arr || arr.length === 0) return undefined;
  return arr[randomInt(0, arr.length - 1)];
}

function chance(p = 0.5) {
  return Math.random() < p;
}

function uniqueStrings(items) {
  return [...new Set(items.filter(Boolean))];
}

function sampleLocations(primary, pool, minCount, maxCount) {
  const n = randomInt(minCount, maxCount);
  const chosen = [];
  if (primary) chosen.push(primary);
  const rest = pool.filter((c) => c !== primary);
  while (chosen.length < n && rest.length) {
    const idx = randomInt(0, rest.length - 1);
    chosen.push(rest.splice(idx, 1)[0]);
  }
  return uniqueStrings(chosen);
}

function payloadEnv() {
  const hc = parseInt(process.env.JOB_HEADCOUNT, 10);
  return {
    jobCompany: process.env.JOB_COMPANY || "SproutsAI",
    jobLocation: process.env.JOB_LOCATION || "",
    jobTitle: (process.env.JOB_TITLE || "").trim(),
    jobType: (process.env.JOB_TYPE || "Full-time").trim(),
    salaryCurrency: (process.env.JOB_SALARY_CURRENCY || "INR").trim().toUpperCase(),
    headcount: Number.isFinite(hc) && hc > 0 ? hc : 1,
    hostname: (process.env.JOB_HOSTNAME || "test.app.sproutsai.com").trim(),
  };
}

const SOFTWARE_TITLES = [
  "Senior Backend Developer",
  "Full Stack Engineer",
  "Staff Software Engineer",
  "Frontend Developer",
  "Platform Engineer",
  "DevOps Engineer",
  "Software Engineer — Backend",
  "Software Engineer — Full Stack",
  "Mobile Engineer (React Native)",
  "Site Reliability Engineer",
  "Data Engineer",
  "Machine Learning Engineer",
  "Principal Software Engineer",
  "Engineering Manager — Software",
];

const CITY_POOL = [
  "Bengaluru, Karnataka",
  "Hyderabad, Telangana",
  "Pune, Maharashtra",
  "Chennai, Tamil Nadu",
  "Mumbai, Maharashtra",
  "Noida, Uttar Pradesh",
  "Gurugram, Haryana",
  "Kolkata, West Bengal",
  "Ahmedabad, Gujarat",
  "Kochi, Kerala",
  "Indore, Madhya Pradesh",
  "Remote — India",
];

// Workplace options the UI understands (sample curl uses "On-site").
const WORKPLACES = ["On-site", "Office", "Remote", "Hybrid"];

// Salary bands kept as label + numeric LPA min/max so UI can render ranges.
const SALARY_BANDS_INR = [
  { label: "₹12–18 LPA", minLpa: 12, maxLpa: 18 },
  { label: "₹15–22 LPA", minLpa: 15, maxLpa: 22 },
  { label: "₹18–28 LPA", minLpa: 18, maxLpa: 28 },
  { label: "₹22–35 LPA", minLpa: 22, maxLpa: 35 },
  { label: "₹28–42 LPA", minLpa: 28, maxLpa: 42 },
  { label: "₹32–45 LPA", minLpa: 32, maxLpa: 45 },
];

// USD bands when JOB_SALARY_CURRENCY=USD (matches manual-style "$120000 - $180000 per year").
const SALARY_BANDS_USD = [
  { min: 80000, max: 120000 },
  { min: 100000, max: 150000 },
  { min: 120000, max: 180000 },
  { min: 140000, max: 200000 },
  { min: 160000, max: 240000 },
  { min: 180000, max: 280000 },
];

const EDUCATION_OPTIONS = [
  "B.E/B.Tech in Computer Science, Information Technology, or related field",
  "B.Tech / M.Tech in Computer Science or equivalent practical experience",
  "Bachelor’s degree in Engineering or related quantitative field (or equivalent experience)",
  "B.E/B.Tech or MCA with strong fundamentals in CS and software engineering",
];

const DEPARTMENTS_POOL = [
  "Engineering",
  "Platform",
  "Product Engineering",
  "Core Engineering",
  "Technology",
  "Data Science",
  "AI",
  "Design",
  "Sales",
];

function buildDepartmentRows() {
  const count = randomInt(1, 2);
  const picked = uniqueStrings(Array.from({ length: count }, () => pick(DEPARTMENTS_POOL)));
  return picked.map((name) => ({ name: String(name).toLowerCase(), status: true }));
}

const SKILL_POOL = [
  "JavaScript",
  "TypeScript",
  "Node.js",
  "React",
  "REST API design",
  "GraphQL",
  "MongoDB",
  "PostgreSQL",
  "Redis",
  "Docker",
  "Kubernetes",
  "AWS",
  "GCP",
  "CI/CD",
  "Git",
  "System design",
  "Microservices",
  "Kafka",
  "Elasticsearch",
  "Python",
  "Go",
  "Java",
  "Spring Boot",
  "React Native",
  "Jest",
  "Playwright",
];

// Full catalog for `benefits[]` rows — API field name is `benifits` (matches job/jobDetails PUT).
const BENEFIT_CATALOG = [
  "Vision insurance",
  "Flexible schedule",
  "Tuition reimbursement",
  "Referral program",
  "Employee discount",
  "Spending account",
  "Health insurance",
  "Paid time off",
  "Dental insurance",
  "Life insurance",
  "401(K) matching Retirement plan",
  "Computer assistance",
  "Employee assistance program",
  "Health saving account",
  "Relocation assistance",
];

const BONUS_CATALOG = [
  "Performance bonus",
  "Yearly bonus",
  "Commission pay",
  "Overtime pay",
  "Quarterly bonus",
  "Shift allowance",
  "Joining bonus",
  "Other",
];

// Job type toggles — `type` strings must match the UI (lowercase / slashes).
const JOB_TYPE_OPTIONS = [
  "full-time",
  "regular/permanent",
  "part-time",
  "internship",
  "contract/temporary",
  "volunteer",
  "other",
];

function experienceBandForTitle(title) {
  const t = String(title).toLowerCase();
  // Always ASCII hyphen + spaces so backend/UI parsers never see Unicode dashes (avoids "undefined" max).
  if (/\binternship\b|\bintern\b|\bgraduate\b|\btrainee\b/.test(t)) return "0 - 1 years";
  if (/\bjunior\b|\bassociate\b/.test(t)) return "1 - 3 years";
  if (/\bprincipal\b|\bstaff\b/.test(t)) return "12 - 18 years";
  if (/\bengineering manager\b/.test(t)) return "10 - 15 years";
  if (/\bmanager\b/.test(t)) return "8 - 12 years";
  if (/\bsenior\b|\blead\b/.test(t)) return "5 - 10 years";
  if (/devops|site reliability|sre|platform engineer/.test(t)) return "3 - 8 years";
  if (/machine learning|\bml\b|data engineer/.test(t)) return "3 - 7 years";
  return "3 - 6 years";
}

// Convert experience string like "5–10 years" into numeric min/max.
function parseExperienceMinMax(experienceText) {
  const normalized = String(experienceText)
    .replace(/years?/gi, "")
    .replace(/[–—]/g, "-")
    .trim();
  const m = normalized.match(/(\d+)\s*-\s*(\d+)/);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  const single = normalized.match(/(\d+)/);
  if (single) return { min: Number(single[1]), max: Number(single[1]) };
  return { min: null, max: null };
}

function inferIsInternship(title, jobTypeLabel) {
  const t = String(title).toLowerCase();
  const jt = String(jobTypeLabel || "").toLowerCase();
  return /\binternship\b|\bintern\b|\btrainee\b/.test(t) || jt.includes("intern");
}

function pickSalaryBandInrForTitle(title) {
  const t = String(title).toLowerCase();
  const high = SALARY_BANDS_INR.slice(4);
  const midHigh = SALARY_BANDS_INR.slice(2, 6);
  const mid = SALARY_BANDS_INR.slice(1, 5);
  const low = SALARY_BANDS_INR.slice(0, 3);
  if (/\bprincipal\b|\bstaff\b/.test(t)) return pick(high.length ? high : SALARY_BANDS_INR);
  if (/\bsenior\b|\blead\b|engineering manager|manager/.test(t)) return pick(midHigh);
  if (/\bintern\b|\bjunior\b|\bassociate\b/.test(t)) return pick(low);
  return pick(mid);
}

function pickSalaryBandUsdForTitle(title) {
  const t = String(title).toLowerCase();
  const high = SALARY_BANDS_USD.slice(4);
  const midHigh = SALARY_BANDS_USD.slice(2, 6);
  const mid = SALARY_BANDS_USD.slice(1, 5);
  const low = SALARY_BANDS_USD.slice(0, 3);
  if (/\bprincipal\b|\bstaff\b/.test(t)) return pick(high.length ? high : SALARY_BANDS_USD);
  if (/\bsenior\b|\blead\b|engineering manager|manager/.test(t)) return pick(midHigh);
  if (/\bintern\b|\bjunior\b|\bassociate\b/.test(t)) return pick(low);
  return pick(mid);
}

// Pipeline stages + randomized sub-stages so each job differs.
const PIPELINE_SUBSTAGES = {
  Screening: ["Resume Screening", "Phone Screen", "Recruiter Screen"],
  Interview: ["Interview 1", "Interview 2", "Panel Interview", "Technical Round"],
};

function buildPipelineAndStageChanges() {
  const id = String(Date.now());

  const screeningSubs = chance(0.75) ? [pick(PIPELINE_SUBSTAGES.Screening)] : [];
  const interviewSubs = chance(0.75) ? [pick(PIPELINE_SUBSTAGES.Interview)] : [];

  const pipeline = [
    {
      id,
      stage: "Application Review",
      text: "Job candidate are added to this stages by default",
      subStage: [],
      isDefault: true,
      assessments: [],
    },
    {
      id,
      stage: "Screening",
      text: "Process of evaluating applications that match with job description",
      subStage: screeningSubs,
      isDefault: false,
      assessments: [],
    },
    {
      id,
      stage: "Interview",
      text: "Interview focuses on a qualification and experience of applicant.",
      subStage: interviewSubs,
      isDefault: false,
      assessments: [],
    },
    { stage: "round 1", text: "", subStage: [], isDefault: false, assessments: [] },
    {
      id,
      stage: "Hired",
      text: "Job candidate are added to this once you finalized the applicant",
      subStage: [],
      isDefault: true,
      assessments: [],
    },
    {
      id,
      stage: "Rejected",
      text: "Rejected candidate would added in this stage",
      subStage: [],
      isDefault: true,
      assessments: [],
    },
  ];

  const stageChangeData = [
    ...(screeningSubs.length ? [{ name: "", replacedwith: screeningSubs[0] }] : []),
    ...(interviewSubs.length ? [{ name: "", replacedwith: interviewSubs[0] }] : []),
  ];

  return { pipeline, stageChangeData };
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlUl(items) {
  const lis = items.map((item) => `    <li>${escapeHtml(item)}</li>`).join("\n");
  return `<ul>\n${lis}\n  </ul>`;
}

// "Roles and responsibilities" block: newline-separated lines with leading spaces (same as jobDetails PUT).
function buildRolesMultiline(title) {
  const lines = [
    "Design, build, and ship features for the role with high quality and ownership.",
    "Write clean, efficient, and well-documented code.",
    "Participate in code reviews and provide constructive feedback.",
    "Collaborate with cross-functional teams to define, design, and ship new features.",
    "Troubleshoot, debug, and resolve software defects.",
    "Contribute to the continuous improvement of our development processes.",
    "Mentor junior developers and share your expertise.",
    "Stay up-to-date with the latest industry trends and technologies.",
    "Participate in the full software development lifecycle, from concept to deployment.",
    "Ensure the quality and performance of our software products.",
  ];
  const withTitle = lines.map((line) =>
    line.includes("for the role") ? line.replace("the role", `the ${title}`) : line
  );
  return withTitle.map((line) => `  ${line}`).join("\n");
}

// Rich HTML description — mirrors manual job editor output (job/jobDetails).
function buildJobDescriptionHtml(
  title,
  company,
  workplace,
  locationDisplay,
  experienceMin,
  experienceMax,
  salaryDisplayHtml,
  skills,
  benefitSentences,
  educationLine
) {
  const hTitle = escapeHtml(`${title} at ${company}`);
  const aboutCompany = escapeHtml(
    `${company} develops intelligent autonomous agents. It provides a platform for the creation and adoption of autonomous agents, designed to drive the future of enterprise. The company primarily caters to the enterprise sector. Established in 2023, ${company} is at the forefront of Artificial Intelligence, Machine Learning, and Software as a Service (SaaS).`
  );
  const aboutRole = escapeHtml(
    `${company} is seeking a skilled ${title} to join our engineering team. You will design, develop, and implement high-quality software, collaborate with product and design, and help deliver innovative features. We value clear communication, ownership, and pragmatic problem solving in a ${String(workplace).toLowerCase()} work setting.`
  );
  const responsibilities = [
    "Design and develop scalable and maintainable software solutions.",
    "Write clean, efficient, and well-documented code.",
    "Participate in code reviews and provide constructive feedback.",
    "Collaborate with cross-functional teams to define, design, and ship new features.",
    "Troubleshoot, debug, and resolve software defects.",
    "Contribute to the continuous improvement of our development processes.",
    "Mentor junior developers and share your expertise.",
    "Stay up-to-date with the latest industry trends and technologies.",
  ];
  const qualifications = [
    educationLine,
    `${experienceMin} - ${experienceMax} years of experience in software development.`,
  ];
  const culture = escapeHtml(
    `${company} fosters a fast-paced environment emphasizing innovation and continuous progress. We encourage collaborative teamwork, valuing individual contributions. Our flat management structure promotes open communication. We place a strong emphasis on professional development through training and mentorship, supporting work-life balance with flexible working hours and arrangements, including remote options. ${company} is committed to ethical AI practices and promotes employee empowerment and autonomy.`
  );
  const benefitsHtml = htmlUl(benefitSentences);

  return [
    "<div>",
    `  <h4><b>${hTitle}</b></h4>`,
    "  <p><b>About the company:</b> </p>",
    `    <p>${aboutCompany}</p>`,
    "  <p><b>About the Role:</b> </p>",
    `    <p>${aboutRole}</p>`,
    "  <p><b>Responsibilities:</b> ",
    `  ${htmlUl(responsibilities)}`,
    "  </p>",
    "  <p><b>Qualifications:</b> ",
    `  ${htmlUl(qualifications)}`,
    "  </p>",
    "  <p><b>Skills Required:</b> ",
    `  ${htmlUl(skills)}`,
    "  </p>",
    "  <p><b>Benefits:</b></p>",
    `  ${benefitsHtml}`,
    "  <p><b>Company Culture:</b> </p>",
    `    <p>${culture}</p>`,
    `  <p><b>Location:</b>${escapeHtml(locationDisplay)}</p>`,
    `  <p><b>Salary:</b>${escapeHtml(salaryDisplayHtml)}</p>`,
    "</div>",
  ].join("\n");
}

function formatSalaryForHtml(minNum, maxNum, currency) {
  if (currency === "USD") {
    const a = Number(minNum).toLocaleString("en-US");
    const b = Number(maxNum).toLocaleString("en-US");
    return `$${a} - $${b}`;
  }
  const a = Number(minNum).toLocaleString("en-IN");
  const b = Number(maxNum).toLocaleString("en-IN");
  return `₹${a} - ₹${b}`;
}

// Map selected job type label to the `job_type[]` toggle list used by the app.
function buildJobTypeRows(selectedLabel) {
  const norm = String(selectedLabel || "Full-time").toLowerCase();
  const active =
    norm.includes("part") ? "part-time" : norm.includes("intern") ? "internship" : "full-time";
  return JOB_TYPE_OPTIONS.map((type) => ({
    type,
    status: type === active,
  }));
}

// Location rows `{ name, status }` — append region suffix for Indian cities when missing.
function buildLocationRows(locationNames) {
  return locationNames.map((raw) => {
    let n = String(raw).trim();
    // Tag suffix so rows match the job editor (e.g. "Bengaluru, Karnataka, India").
    const tagged =
      /\bindia\b/i.test(n) ||
      /\bcalifornia\b/i.test(n) ||
      /\b(usa|united states)\b/i.test(n);
    if (!tagged) n = `${n.replace(/,+\s*$/, "")}, India`;
    return { name: n, status: true };
  });
}

function pickBenefitLabelsFromCatalog() {
  const k = randomInt(5, Math.min(11, BENEFIT_CATALOG.length));
  const pool = [...BENEFIT_CATALOG];
  const chosen = [];
  while (chosen.length < k && pool.length) {
    const i = randomInt(0, pool.length - 1);
    chosen.push(pool.splice(i, 1)[0]);
  }
  return chosen;
}

function buildBenefitsToggleRows(selectedLabels) {
  const sel = new Set(selectedLabels.map((s) => String(s).toLowerCase()));
  return BENEFIT_CATALOG.map((benifits) => ({
    benifits,
    status: sel.has(benifits.toLowerCase()),
  }));
}

function buildBonusToggleRows() {
  return BONUS_CATALOG.map((benifits) => ({ benifits, status: false }));
}

function skillScoreForTitle(skill, title) {
  const t = title.toLowerCase();
  const s = skill.toLowerCase();
  let v = 6 + randomInt(0, 2);
  if (t.includes("backend") && /node|postgres|kafka|micro|java|spring|go|redis/.test(s)) v = Math.min(9, v + 2);
  if (t.includes("frontend") && /react|typescript|jest|playwright/.test(s)) v = Math.min(9, v + 2);
  if (t.includes("full stack") && /react|node|typescript|rest|postgres/.test(s)) v = Math.min(9, v + 2);
  if ((t.includes("devops") || t.includes("sre")) && /docker|kubern|ci\/cd|aws|gcp/.test(s)) v = Math.min(9, v + 2);
  return Math.min(9, Math.max(6, v));
}

function criteriaBucketForSkill(skill) {
  const s = skill.toLowerCase();
  if (/javascript|typescript|python|go|java|spring|node\.js|react|jest|playwright|react native|git/.test(s)) {
    return "Programming Languages & Fundamentals";
  }
  if (/system design|microservice|rest|graphql|architecture/.test(s)) {
    return "Software Design & Architecture";
  }
  if (/ci\/cd|git\b/.test(s)) {
    return "Development Process & Collaboration";
  }
  if (/docker|kubernetes|aws|gcp/.test(s)) {
    return "Cloud Computing & DevOps";
  }
  if (/mongo|postgres|redis|kafka|elastic/.test(s)) {
    return "Database & Data Management";
  }
  return "Development Process & Collaboration";
}

function buildCriteriasFromSkills(skills, title) {
  const buckets = new Map();
  for (const skill of skills) {
    const key = criteriaBucketForSkill(skill);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({
      label: skill,
      value: skillScoreForTitle(skill, title),
      type: 2,
    });
  }
  const rows = [];
  for (const [criteria, skillRows] of buckets) {
    const avg = Math.round(
      skillRows.reduce((sum, x) => sum + x.value, 0) / Math.max(1, skillRows.length)
    );
    rows.push({
      criteria,
      value: Math.min(9, Math.max(6, avg)),
      skills: skillRows,
    });
  }
  rows.push({ criteria: "Misc", value: 7, skills: [] });
  return rows;
}

function buildSkillScoreMap(skills, title) {
  const map = {};
  for (const s of skills) map[s] = skillScoreForTitle(s, title);
  return map;
}

function criteriasToRaw(skills, title) {
  const rows = buildCriteriasFromSkills(skills, title)
    .filter((c) => c.criteria !== "Misc")
    .map((c) => ({
      label: c.criteria,
      value: c.value,
      keySkills: c.skills,
    }));
  return rows;
}

function buildScreeningQuestions(workplace) {
  const questions = [
    {
      name: "Relocate",
      status: true,
      question: "Will you be able to reliably commute or relocate to the job location?",
      required: false,
      answerType: "yes/no",
      answer: ["Yes", "No"],
      id: 3,
    },
  ];

  if (workplace !== "On-site" && workplace !== "Office") {
    questions.push({
      name: "Remote work",
      status: true,
      question: "Are you open to work remotely?",
      required: false,
      answerType: "yes/no",
      answer: ["Yes", "No"],
      id: 6,
    });
  }

  if (chance(0.4)) {
    questions.push({
      name: "Notice period",
      status: true,
      question: "What is your current notice period?",
      required: false,
      answerType: "single-select",
      answer: ["Immediate", "15 days", "30 days", "45 days", "60 days", "90 days"],
      id: 9,
    });
  }

  return questions;
}

function randomWeights() {
  // Keep weights close to what the UI uses, and always sum to 1.
  const jobPos = 0.25;
  const edu = chance(0.5) ? 0.15 : 0.1;
  const exp = chance(0.5) ? 0.2 : 0.35;
  const skills = Number((1 - (jobPos + edu + exp)).toFixed(2));
  return {
    job_position_match_weight: jobPos,
    education_match_weight: edu,
    exp_match_weight: exp,
    skills_match_weight: skills,
  };
}

function pickSkillsForTitle(title, count) {
  const t = title.toLowerCase();
  const boost = (skill) => {
    const s = skill.toLowerCase();
    if (t.includes("backend") && /node|postgres|kafka|micro|java|spring|go|redis/.test(s)) return 3;
    if (t.includes("frontend") && /react|typescript|jest|playwright/.test(s)) return 3;
    if (t.includes("full stack") && /react|node|typescript|rest|postgres/.test(s)) return 3;
    if ((t.includes("devops") || t.includes("sre")) && /docker|kubern|ci\/cd|aws|gcp/.test(s)) return 3;
    if (t.includes("mobile") && /react native/.test(s)) return 4;
    if (t.includes("data") && /python|kafka|postgres|elastic/.test(s)) return 3;
    if (t.includes("ml") && /python/.test(s)) return 3;
    return 1;
  };
  const pool = [...SKILL_POOL].sort((a, b) => boost(b) - boost(a));
  const picked = [];
  for (let i = 0; i < pool.length && picked.length < count; i++) {
    if (!picked.includes(pool[i])) picked.push(pool[i]);
  }
  return picked.slice(0, count);
}

function buildDynamicSoftwareJobPayload() {
  const cfg = payloadEnv();
  const title = cfg.jobTitle || pick(SOFTWARE_TITLES);
  const name = title;

  const nonRemoteCities = CITY_POOL.filter((c) => !/remote/i.test(c));
  const primaryLoc =
    cfg.jobLocation ||
    (nonRemoteCities.length ? pick(nonRemoteCities) : pick(CITY_POOL));

  const locationNames = sampleLocations(primaryLoc, CITY_POOL, 2, 4);
  const workplace = pick(WORKPLACES);
  const experienceText = experienceBandForTitle(title);
  const exp = parseExperienceMinMax(experienceText);
  const experienceMin = exp.min != null ? exp.min : 3;
  const experienceMax = exp.max != null ? exp.max : 6;

  // Numeric salary range + display string (matches jobDetails `salary: { min, max, salvisibility }`).
  let salaryMinNum;
  let salaryMaxNum;
  if (cfg.salaryCurrency === "USD") {
    const usd = pickSalaryBandUsdForTitle(title);
    salaryMinNum = usd.min;
    salaryMaxNum = usd.max;
  } else {
    const salaryBand = pickSalaryBandInrForTitle(title);
    salaryMinNum = salaryBand?.minLpa != null ? salaryBand.minLpa * 100000 : 1200000;
    salaryMaxNum = salaryBand?.maxLpa != null ? salaryBand.maxLpa * 100000 : 1800000;
  }
  const salaryDisplayHtml = formatSalaryForHtml(salaryMinNum, salaryMaxNum, cfg.salaryCurrency);

  const education = pick(EDUCATION_OPTIONS);
  const skillCount = randomInt(6, 14);
  const skills = pickSkillsForTitle(title, skillCount);
  const benefitLabelsSelected = pickBenefitLabelsFromCatalog();
  const benefitLinesForHtml = benefitLabelsSelected.map((b) => (/\.$/.test(b) ? b : `${b}.`));
  const locationDisplay = locationNames.join(", ");
  const description = buildJobDescriptionHtml(
    title,
    cfg.jobCompany,
    workplace,
    locationDisplay,
    experienceMin,
    experienceMax,
    salaryDisplayHtml,
    skills,
    benefitLinesForHtml,
    education
  );

  // Body aligned with browser PUT /job/jobDetails (Sprouts job editor save).
  const isInternship = inferIsInternship(title, cfg.jobType);
  const salaryCurrencyField = cfg.salaryCurrency === "USD" ? "USD" : "INR";
  const salaryDuration = isInternship ? pick(["Per month", "Per year"]) : "Per year";
  const pipelineData = buildPipelineAndStageChanges();
  const weights = randomWeights();
  const skillScore = buildSkillScoreMap(skills, title);

  return {
    name,
    internal_job_name: title,
    company: cfg.jobCompany,
    description,
    status: "active",
    departments: buildDepartmentRows(),
    hostname: cfg.hostname,
    location: buildLocationRows(locationNames),
    salary: {
      min: salaryMinNum,
      max: salaryMaxNum,
      currency: salaryCurrencyField,
      duration: salaryDuration,
      salvisibility: "Display",
    },
    job_type: buildJobTypeRows(cfg.jobType),
    workplace,
    experience: { min: experienceMin, max: experienceMax, type: isInternship ? 1 : 0 },
    workflowId: "",
    criterias: buildCriteriasFromSkills(skills, title),
    preferCriteria: [],
    headcount: cfg.headcount,
    rawData: {
      job_position: name,
      job_type: [String(cfg.jobType || "Full-time")],
      department: [pick(DEPARTMENTS_POOL)],
      workplace_type: workplace === "On-site" ? "Office" : workplace,
      job_details:
        "This role focuses on shipping high-quality work with clear ownership. You will collaborate with cross-functional partners to deliver incremental value safely.",
      roles_and_responsibilities: buildRolesMultiline(title),
      experience: { min: experienceMin, max: experienceMax },
      education: `${education}.`,
      criterias: criteriasToRaw(skills, title),
      soft_skills:
        "The ideal candidate should possess strong analytical and problem-solving skills, excellent communication and teamwork abilities, and a proactive approach to learning and development.",
      salary: { min: salaryMinNum, max: salaryMaxNum },
      skill_score: skillScore,
      benefits:
        "This role offers comprehensive benefits, growth opportunities, and a collaborative environment focused on continuous learning and high ownership.",
      newly_generated: true,
      location: [locationDisplay],
      html: description,
    },
    job_grade: null,
    match_criteria: 65,
    top_threshold: 20,
    roles: buildRolesMultiline(title),
    pipeline: pipelineData.pipeline,
    education,
    benefits: buildBenefitsToggleRows(benefitLabelsSelected),
    confidential: false,
    bonus: buildBonusToggleRows(),
    isEvergreen: false,
    feedbackVisibility: true,
    screeningQuestions: buildScreeningQuestions(workplace),
    stageChangeData: pipelineData.stageChangeData,
    ...weights,
    stability: { threshold: 0, type: 0 },
    career_growth: { threshold: 0, type: 0 },
    startup_experience: { threshold: chance(0.3) ? randomInt(2, 6) : 0, type: chance(0.3) ? 2 : 0 },
    open_for_new_role: { threshold: chance(0.3) ? randomInt(1, 4) : 0, type: chance(0.3) ? 1 : 0 },
    custom_match_attributes: [],
    company_match: { threshold: 0, type: 0 },
    blueColor: false,
    seniority_check: chance(0.5) ? false : null,
    number_of_prospects: 20,
    company_match_attributes: chance(0.3) ? ["Culture"] : [],
    posting_status: true,
    hiring_managers: [],
    recruiters: [],
    coordinators: [],
  };
}

module.exports = { buildDynamicSoftwareJobPayload };
