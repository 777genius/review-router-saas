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
