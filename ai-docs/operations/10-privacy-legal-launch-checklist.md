# Privacy and Legal Launch Checklist

## Purpose

This is not legal advice. It is a product/engineering checklist to avoid launching a SaaS that makes privacy claims without matching product behavior and documents.

## Before Public Beta

Need at least draft:

- privacy policy
- terms of service
- data retention statement
- security overview
- subprocessors/infrastructure list if applicable
- contact email for security/privacy requests

## Claims Must Match Implementation

If marketing says:

```text
We do not store your code or diffs.
```

Then implementation must enforce:

- health reports reject code/diff payloads
- logs do not store code/diff
- support tools do not show code/diff
- telemetry schema is metadata-only
- Balanced Memory candidates reject raw code/diff/prompt/model-response fields and store only distilled memory text that the user asked ReviewRouter to remember or review for confirmation
- memory audit, outbox, and usage telemetry store ids/hashes/status metadata, not memory body or source text
- memory delete/forget removes runtime exposure immediately and redacts the canonical item body/source plus confirmed origin suggestion body/source

If marketing says:

```text
Codex OAuth stays in your environment.
```

Then implementation must enforce:

- no Codex auth upload endpoint
- no Codex auth DB column
- no Codex auth log capture
- setup docs direct users to GitHub secrets or trusted self-hosted runner

## Data Subject / Workspace Deletion

Before broader public launch:

- user can request workspace deletion
- deletion behavior is documented
- retention window is documented
- GitHub App uninstall does not imply immediate data deletion unless stated

## Security Contact

Publish a security contact before public launch.

Minimum:

```text
security@reviewrouter.example
```

Replace with real domain before launch.

## Enterprise Later

Not v1, but future enterprise customers may ask for:

- DPA
- SOC2 roadmap
- SSO/SAML
- audit exports
- self-hosted control plane
- data residency
