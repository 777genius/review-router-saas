# ReviewRouter Self-Hosted Privacy Boundary

ReviewRouter's privacy model is based on where code is read.

## Code Boundary

The GitHub Action runner may read source code because it runs inside the
customer repository workflow. The hosted or self-hosted control plane should
receive metadata and review artifacts, not raw source files by default.

## Allowed Control-Plane Payloads

The control plane may store or process:

- workspace, repository, installation, PR, run, and attempt identities
- owner/repo names and repository ids
- PR number and branch names
- base SHA, merge-base SHA, head SHA, review revision hash
- workflow path, workflow SHA, action ref, action producer SHA
- batch ids, work-slot ids, lease ids, attempt counters
- file paths, line ranges, diff fingerprints, context fingerprints
- provider kind, model id, effort level, provider invocation identity hash
- normalized findings, summaries, lifecycle decisions, publication receipts
- context attestation digests and replay proofs
- webhook delivery ids, audit events, timestamps, safe error codes

## Forbidden Control-Plane Payloads

The control plane must not store or log:

- raw `CODEX_AUTH_JSON`
- refresh tokens, access tokens, cookies, API keys, private keys
- GitHub installation tokens
- raw source file contents by default
- complete provider prompts by default
- raw provider stdout/stderr without redaction
- unredacted HTTP headers or authorization material
- temporary dispatch nonces or capability token plaintext

## Retention

Self-hosted operators own the database and backup retention window. The default
retention policy should keep only the metadata required for:

- active PR review reuse
- finding lifecycle reconciliation
- audit/debugging of recent failures
- release and protocol compatibility checks

Future retention automation must be implemented behind domain/application ports
so hosted and self-hosted deployments use the same deletion rules.

## Redaction Requirements

Tests should assert that logs and persisted safe payloads redact:

- `TOKEN`
- `SECRET`
- `PASSWORD`
- `PRIVATE_KEY`
- `API_KEY`
- `AUTH_JSON`
- OAuth refresh/access token shapes
- GitHub `ghs_` and installation token-like values
- dispatch nonces and capability tokens

## Operator Guidance

- Store provider credentials in GitHub Actions secrets, not in control-plane env.
- Use `managed-review` unless dashboard workflow/secret provisioning is required.
- Use `provisioning` only when ReviewRouter must write setup PRs or repository
  secrets.
- Put the API and web apps behind HTTPS.
- Keep Postgres on a private network or localhost binding.
- Rotate the GitHub App private key and webhook secret if the host is
  compromised.
