# Current ReviewRouter Action Context

## Existing Useful Capabilities

The existing ReviewRouter action work includes or targets:

- Codex CLI provider support
- Codex OAuth subscription mode
- OpenAI/OpenRouter API-key paths
- GitHub App token support for bot identity
- GitHub Actions bot fallback
- installer with curl flow
- org selected-repo secret support
- ReviewRouter branding
- future SaaS runtime config fetch through GitHub Actions OIDC
- action version modes: stable/release/main
- SaaS beta default action ref: `777genius/review-router@main`
- strict JSON findings from Codex
- read-only agentic Codex context mode
- deterministic diff seed
- safer env sanitization
- major/critical blocking policy
- deduplication and revalidation direction
- PR summary/walkthrough direction
- `/rr skip` command with signed PR ledger
- AI discussion direction for future explanation, not automatic skip

## Action vs SaaS Boundary

Action owns:

- pull request diff extraction
- context selection
- provider execution
- inline comments
- review summary
- blocking status
- skip ledger handling inside PR

SaaS owns:

- setup and configuration
- workflow provisioning
- repository selection
- health and audit
- policy management
- update orchestration
- onboarding UX

## Important Product Lessons From Action Work

- Do not show `$0.0000` cost for Codex OAuth subscription mode because it misleads users.
- “No findings” on large PRs needs explanation: skipped files, large diffs, provider health, config thresholds.
- Duplicate comments are a major trust killer.
- Natural-language skip is risky; explicit `/rr skip` is auditable.
- Review comments need clear severity and concrete impact.
- Large/generated files need explicit filtering/summarization.
- Codex can read related files in read-only agentic mode, but deterministic context still matters.

## Latest Real E2E Validation

On 2026-05-03, the SaaS provisioning path and separate action runtime were
validated against a real public smoke repository:

```text
Repo: 777genius/review-router-saas-e2e
Setup PR: https://github.com/777genius/review-router-saas-e2e/pull/3
Setup result: merged generated workflow update from @v1 to @main
Health check: expectedActionRefFound=true for 777genius/review-router@main

Clean smoke PR: https://github.com/777genius/review-router-saas-e2e/pull/4
Run: https://github.com/777genius/review-router-saas-e2e/actions/runs/25291639232
Action ref: 777genius/review-router@main
Action SHA: 37a04a039951ecf342f6221af3438105399e00ff
Provider: Codex OAuth subscription, gpt-5.4-mini
Result: workflow failed intentionally with 1 critical finding
Inline: github-actions[bot] commented on auth.js:5
```

Earlier real runs proved setup/auth worked but exposed runtime bugs where Codex
produced one finding and post-processing dropped it. The action runtime was
fixed in `777genius/review-router`:

```text
18a224e fix: preserve authentication bypass findings
45a5813 fix: harden auth query finding classification
37a04a0 fix: keep privileged default user findings
```

Keep SaaS-generated beta workflows on `@main` until a release tag is cut from a
runtime that includes those fixes.

## Latest SaaS Setup Guard Validation

On 2026-05-04, the smoke repository was re-synced through the real GitHub App
installation and probed through the SaaS repo-health path:

```text
Repo: 777genius/review-router-saas-e2e
Installation: 129154876
Expected action ref: 777genius/review-router@main
Workflow check: present, expectedActionRefFound=true
Repository sync: 245 repos seen/upserted
```

The dashboard setup action now probes the default branch before provisioning and
skips setup PR creation when the workflow already uses the expected action ref.
The GitHub workflow setup adapter also retries content write conflicts and
re-reads open setup PRs after raced PR creation conflicts, so the dashboard lock
is not the only duplicate-PR defense.

## Fresh Repository End-to-End Smoke

On 2026-05-04, a new public repository was created and exercised from scratch:

```text
Repo: 777genius/rr-saas-fresh-e2e-20260504010426
Setup PR: https://github.com/777genius/rr-saas-fresh-e2e-20260504010426/pull/1
Setup result: merged generated ReviewRouter workflow
Post-merge health: present, expectedActionRefFound=true
Codex OAuth: seeded into repository Actions secret through scripts/seed-codex-auth.sh

Review PR: https://github.com/777genius/rr-saas-fresh-e2e-20260504010426/pull/2
Run: https://github.com/777genius/rr-saas-fresh-e2e-20260504010426/actions/runs/25292193330
Result: failed intentionally with 1 critical finding
Inline: github-actions[bot] commented on auth.js:5
Finding: Login bypass ignores requested email
```

This smoke proves the beta path works for a fresh repository with App-managed
workflow provisioning and Codex OAuth running inside GitHub Actions.

The same path is now automated:

```bash
node scripts/run-with-env.mjs pnpm spike:github:fresh-repo:e2e
REVIEW_ROUTER_FRESH_E2E_MODE=review node scripts/run-with-env.mjs pnpm spike:github:fresh-repo:e2e
```

Latest automated full review smoke:

```text
Date: 2026-05-04 08:58 EEST
Repo: 777genius/rr-saas-fresh-e2e-1777874235486
Setup PR: https://github.com/777genius/rr-saas-fresh-e2e-1777874235486/pull/1
Review PR: https://github.com/777genius/rr-saas-fresh-e2e-1777874235486/pull/2
Run: https://github.com/777genius/rr-saas-fresh-e2e-1777874235486/actions/runs/25303510196
Result: failed intentionally with 1 critical finding
Inline: auth.js:5, title "Authentication ignores the supplied email"
Command: REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check
```

Previous automated full review smoke:

```text
Date: 2026-05-04
Repo: 777genius/rr-saas-fresh-e2e-1777848830828
Setup PR: https://github.com/777genius/rr-saas-fresh-e2e-1777848830828/pull/1
Review PR: https://github.com/777genius/rr-saas-fresh-e2e-1777848830828/pull/2
Run: https://github.com/777genius/rr-saas-fresh-e2e-1777848830828/actions/runs/25293200638
Result: failed intentionally with 1 critical finding
Inline: auth.js:5, title "Authentication bypass"
Command: REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check
```

Latest setup-only smoke after workflow provisioning fail-closed hardening:

```text
Repo: 777genius/rr-saas-fresh-e2e-1777847561393
Setup PR: https://github.com/777genius/rr-saas-fresh-e2e-1777847561393/pull/1
Result: setup PR merged successfully
Post-merge health: present, expectedActionRefFound=true
Action ref: 777genius/review-router@main
Command: REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=setup pnpm beta:check
```
