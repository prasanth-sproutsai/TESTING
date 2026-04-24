# Automation Script Flow — Overview

This document explains the end-to-end automation we use for job sanity testing. It covers how a job is created or reused, how sourcing filters are generated and saved, how candidates are sourced and listed, and how outreach is prepared and optionally sent—in a controlled way.

---

## Stage 1: Authentication

**Main API:** POST /user/auth

- Signs in with configured credentials and establishes a session for all later steps.
- Obtains the access token and user/org context the APIs expect on follow-up calls.
- Ensures access is valid before any job work begins.
- Stops the run immediately if login fails or required session fields are missing.

---

## Stage 2: Job Creation

**Main API:** POST /job/create

- Creates a new job when the full automation path runs (not when testing against an existing job only).
- Sends structured job information such as role, company, location, and related fields from our payload builder.
- Returns a job identifier used for every downstream call.
- Skipped when the flow is started in “existing job” mode, which begins from job validation instead.

---

## Stage 3: Job Validation

**Main API:** GET /job/job_details/{jobId}

- Loads the job record for the id from creation or from configuration.
- Verifies required fields and status so we do not source or reach out on bad data.
- Surfaces problems early, before slower or side-effecting steps.
- Stops the run if validation fails.

---

## Stage 4: Auto Filter Generation

**Main API:** GET /job/get_auto_source_filter/{jobId}

- Requests an auto-generated sourcing filter aligned to the job.
- Produces criteria such as skills, experience, and related signals used for matching.
- Supports retries with backoff when the service is temporarily unavailable.
- Hands off a filter payload to the save step for persistence.

---

## Stage 5: Save Filter

**Main API:** POST /job/save-auto-source-filter

- Persists the generated filter to the job so behavior matches the product (including what the UI would show).
- Uses the job id and the filter output from the previous stage.
- Makes the same criteria available to sourcing and to later audit in the app.
- A failure here means sourcing may not run against the intended bar.

---

## Stage 6: Filter Confirmation

**Main API:** GET /job/auto-source-filter/{jobId}

- Reads the saved filter back to confirm it stored correctly.
- Can apply a short configurable wait when persistence is not instant.
- Optionally requires meaningful filter content (for example skills) before sourcing is allowed.
- Can be skipped by configuration when persistence is still handled only in the UI.

---

## Stage 7: Candidate Sourcing

**Main API:** POST /job/sourceCandidates

- Triggers candidate search for the job using the saved filter context.
- Attaches matching candidates to the job for roster and outreach steps.
- Uses retry, backoff, and optional cooldown settings from environment configuration.
- Success means the job is ready for match-profile retrieval.

---

## Stage 8: Outreach Preparation and Send

**Main API:** POST /sequence/job/create

- Loads matched profiles first (POST /job/get_match_profiles/{jobId}) so recipients and stable ids are known.
- When using a sequence template, may call the personalized-email service so each step has subject and body aligned to the template.
- Builds the sequence payload (candidates, steps, previews) and submits it with the create call so it matches product expectations.
- Real outbound email is only attempted when outreach is explicitly enabled and real-send flags are set; otherwise the stage is skipped or runs without sending mail.

---

## Execution Control and Safety

- Outreach does not run unless it is turned on in configuration; real sends require an additional explicit allow flag so routine runs do not email candidates by accident.
- The flow avoids pointless outreach when there are no eligible candidates or missing email data.
- Duplicate or conflicting sequences are enforced by the platform; the automation reports failures clearly and does not bypass business rules.
- Organization and environment settings (base URL, org id when needed, audience for match profiles) must be correct or steps fail fast with clear logs.

---

## Test Strategy Notes

- Sourcing can be exercised on its own path to validate filter generation and candidate attachment without always running outreach.
- Outreach-focused runs can target an existing job and candidate roster to avoid repeating full sourcing when the goal is sequence or email behavior—this shortens runs and allows more frequent checks.
- Together, this keeps broad sanity coverage while still allowing focused, faster loops where appropriate.

---

## Current Limitations

- Active or duplicate sequence rules can block creating a new sequence for the same candidate; resolution is a data or product-state change, not something the script overrides.
- Some steps depend on server timing (for example saved filter visibility after write).
- Inbound replies and automated positive/negative follow-up templates are owned by backend mail and classification pipelines; this automation does not simulate or trigger those events.
- Full reliability still depends on a correctly configured test environment.

---

## Future Improvements

- A single “safe test” profile that walks all APIs without creating jobs or sending mail, with a short manager-readable summary.
- Clearer run reports per stage (pass/fail, duration, and last error) for demos and CI.
- Stronger handling guidance when sequences already exist (retry paths or documented cleanup).
- Optional read-only checks after outreach (for example sequence reply-template configuration) as a standard post-run checklist.

---

## Summary

- The end-to-end job sanity flow is implemented and used regularly: auth, job create or reuse, validation, filter generate/save/confirm, sourcing, match profiles, and outreach with safety gates.
- Outreach is integrated through match listing, personalization when needed, and sequence creation; sending is deliberately optional.
- Safety and configuration flags reduce risk to real candidates during testing.
- The flow is suitable for demos and ongoing hardening; limitations above are understood and tracked for future work.

---

*Aligned with the sanity orchestrator and stage modules in this repository. Endpoint paths can be overridden via the .env.example options.*
