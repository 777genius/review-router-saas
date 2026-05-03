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
