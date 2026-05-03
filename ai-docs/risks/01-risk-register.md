# Risk Register

## Critical Risks

### R1 - Accidental secret custody

Severity: critical.

Risk: SaaS starts storing Codex OAuth or API keys casually, increasing breach and support risk.

Mitigation:

- v1 stores setup metadata only
- explicit docs and UI copy
- no secret columns in data model
- logging redaction
- future BYOK requires dedicated design

### R2 - Private code custody creep

Severity: critical.

Risk: health/reporting features accidentally start storing repository code or diffs.

Mitigation:

- no code/diff storage in v1
- workflow reporting schema must be metadata-only
- reject large/freeform report payloads
- security review before telemetry expansion

### R3 - Duplicate GitHub side effects

Severity: high.

Risk: duplicate webhooks or concurrent clicks create duplicate setup PRs/config events.

Mitigation:

- delivery idempotency table
- repo-level provisioning locks
- unique job keys
- outbox idempotency

### R4 - GitHub permission trust problem

Severity: high.

Risk: users abandon install because app permissions look too broad.

Mitigation:

- least privilege
- explain every permission
- setup PR rather than direct default branch writes
- clear docs and screenshots

### R5 - Review quality disappoints

Severity: high.

Risk: SaaS onboarding works, but underlying review comments are noisy or miss issues.

Mitigation:

- conservative defaults
- major/critical focus
- dedup/revalidation
- clear “No findings” reasoning and skipped file summary
- e2e smoke repos

### R6 - Codex OAuth fragility

Severity: high.

Risk: customers expect subscription auth to be permanent, but CI auth can become stale or hard to refresh.

Mitigation:

- early auth health check in action
- clear reseed message
- docs for org secrets and self-hosted persistent `CODEX_HOME`
- API-key mode offered as simpler alternative

### R7 - Architecture over-complexity

Severity: medium.

Risk: full DDD slows MVP too much.

Mitigation:

- use full structure only for bounded contexts with invariants
- allow collapsed files for tiny features
- keep dependency rules but avoid ceremony without value

### R8 - No clear paid path

Severity: medium.

Risk: free beta gets usage but no conversion.

Mitigation:

- model entitlements now
- identify paid value: org policies, audit, update automation, integrations, enterprise
- avoid promising everything free forever

### R9 - Multi-instance bugs

Severity: high.

Risk: product works locally but fails under multiple API/worker instances.

Mitigation:

- no in-memory correctness locks
- Postgres locks
- idempotency keys
- concurrency tests

### R10 - GitHub rate limits

Severity: medium.

Risk: repo sync/workflow checks hit GitHub API limits for large orgs.

Mitigation:

- queue syncs
- cache repo state
- backoff and retry
- sync selected repos first
- expose sync status

## Risk Review Cadence

Review before every major iteration:

- has any secret/code custody boundary changed?
- has any new GitHub permission been added?
- are new jobs idempotent?
- does the user see clear failure reasons?

### R11 - Unsafe generated GitHub Actions workflow

Severity: critical.

Risk: generated workflow uses `pull_request_target` or exposes privileged tokens/secrets while checking out untrusted PR code.

Mitigation:

- default workflow uses `pull_request`
- explicit ban on default `pull_request_target` review execution
- fork PR secret-backed review skips by default
- generated workflow security snapshot tests
- manual trusted rerun must be explicitly designed and audited

### R12 - Runtime config/action version mismatch

Severity: high.

Risk: SaaS returns config that an older installed action misinterprets, causing wrong review behavior or failures.

Mitigation:

- versioned action protocol endpoints
- config schema version
- action min/max version metadata
- invalid/incompatible config falls back or fails safely
- dashboard recommends workflow/action update

### R13 - OIDC validation bug

Severity: high.

Risk: SaaS accepts an OIDC token from the wrong repository, event, audience, or fork context and returns config/report session incorrectly.

Mitigation:

- strict issuer/audience/expiry validation
- verify repository id maps to active selected repo
- validate event/fork policy before returning secret-backed config metadata
- OIDC contract tests with reject cases
- use repository id where possible, not mutable repo name alone

### R14 - Dashboard auth or CSRF weakness

Severity: high.

Risk: attacker abuses OAuth/session/CSRF weakness to change repo config or provision workflows.

Mitigation:

- OAuth state validation
- secure httpOnly cookies
- CSRF protection for state-changing mutations
- application authorization policy for every mutation
- audit admin/config/workflow actions

### R15 - Same-repository PR secret exposure

Severity: high.

Risk: same-repository pull requests from users with write access can modify workflow-related files or run CI with more privileges than fork PRs.

Mitigation:

- document same-repository PR trust boundary
- recommend branch protection and CODEOWNERS for workflow/config files
- generated workflow uses minimal permissions and `persist-credentials: false`
- provider subprocess environment is sanitized

### R16 - GitHub App lifecycle drift

Severity: medium.

Risk: app is uninstalled, repo removed, repo renamed/transferred, or permissions changed outside ReviewRouter, leaving stale dashboard state.

Mitigation:

- explicit installation lifecycle states
- webhook handling for install/delete/suspend/repository changes
- periodic health sync
- block provisioning for disconnected/permission-error repos

### R17 - Bad action release or unstable update channel

Severity: high.

Risk: customers receive broken review behavior from bad action version or `main` channel.

Mitigation:

- stable/release/main channels with clear defaults
- action version blocklist
- update PR rollback path
- smoke tests before stable promotion

### R18 - Support/admin overreach

Severity: high.

Risk: internal support tools expose sensitive customer data or allow unapproved changes.

Mitigation:

- support views show metadata only
- support actions are limited and audited
- no code/diff/secret access
- customer-visible support access history later

### R19 - Sensitive user content stored as metadata

Severity: high.

Risk: PR titles, PR bodies, branch names, commit messages, or raw webhook payloads get stored casually and violate the privacy positioning.

Mitigation:

- data classification before adding fields
- no raw webhook payload storage by default
- metadata-only health reports
- retention defined before storing potentially sensitive content

### R20 - Action health report becomes covert code/diff channel

Severity: high.

Risk: action reports raw errors, prompts, model output, code snippets, or diffs to SaaS.

Mitigation:

- strict Zod schema
- payload size limits
- server-side secret/code-like rejection
- category-based errors instead of raw logs

### R21 - Database invariant only enforced in application code

Severity: medium.

Risk: concurrent jobs or bugs create duplicate configs, duplicate workflow provisioning records, or cross-tenant records.

Mitigation:

- unique constraints
- foreign keys
- transaction boundaries
- concurrency tests against real Postgres

### R22 - Free beta abuse without cloud execution

Severity: medium.

Risk: attackers or misconfigured customers overload webhooks, OIDC exchange, sync jobs, setup PR creation, or health reports.

Mitigation:

- per-workspace/repo/run rate limits
- job dedupe
- payload limits
- support controls to pause workspace jobs

### R23 - Async jobs require raw webhook payloads

Severity: high.

Risk: privacy policy says raw payloads are not stored, but async jobs need them and developers start persisting full webhook bodies.

Mitigation:

- normalize safe internal events immediately after signature verification
- jobs consume normalized event ids
- raw payload storage disabled by default
- tests assert PR/comment bodies are not persisted

### R24 - OIDC validation edge-case bypass

Severity: critical.

Risk: JWKS cache, clock skew, audience, replay, or action-session scoping is implemented loosely and allows config fetch for the wrong repository/run.

Mitigation:

- strict issuer/audience/signature/expiry checks
- bounded JWKS cache with fail-closed behavior
- short-lived action sessions scoped to repo/run/runAttempt
- OIDC contract tests for reject cases

### R25 - SaaS outage blocks customer reviews unnecessarily

Severity: medium.

Risk: ReviewRouter SaaS downtime causes all customer PR review workflows to fail even though static config exists.

Mitigation:

- static config fallback
- health reporting best effort
- clear check output when runtime config fetch fails
- fail only when no safe config exists

### R26 - Poison jobs retry forever

Severity: medium.

Risk: invalid normalized event, unsupported event version, or permanent permission error retries forever and clogs queues.

Mitigation:

- event versioning
- max attempts
- dead-letter state
- support-visible safe error summaries
- manual retry after fix

### R27 - Observability captures sensitive payloads

Severity: high.

Risk: logging/tracing/error tools capture request bodies, webhook payloads, prompts, code, diffs, or secrets.

Mitigation:

- disable body capture by default
- scrub headers/cookies/tokens
- no raw webhook payload logs
- privacy-safe telemetry policy
