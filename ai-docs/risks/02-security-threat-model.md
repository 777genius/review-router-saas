# Security Threat Model

## Assets

- GitHub App private key
- GitHub App installation tokens
- user sessions
- workspace/repo metadata
- audit logs
- workflow provisioning permissions
- customer provider secrets in GitHub, not SaaS
- customer private code in GitHub/CI, not SaaS

Opt-in hosted workspace account pool exception:

- SaaS-custodied, envelope-encrypted Codex account sessions
- bounded Action run grants
- transient relay prompts, tool outputs, and Responses events
- account/repository bindings, credential generations, and database incarnation

## Trust Boundaries

```text
Browser -> ReviewRouter web/API
GitHub -> ReviewRouter webhook endpoint
ReviewRouter API -> GitHub API
ReviewRouter Action -> customer repository/CI/provider
```

ReviewRouter SaaS does not cross into customer code execution in v1.

For repositories explicitly bound under
[ADR-029](../decisions/029-opt-in-hosted-workspace-account-pool.md), add:

```text
GitHub Action -> ReviewRouter bounded Responses relay -> ChatGPT upstream
ReviewRouter relay -> encrypted session store -> KMS/keyring
```

Checkout, tools, and the agent loop still execute in GitHub Actions. The relay
transiently processes prompts, tool outputs, and responses, but credentials stay
inside SaaS and relay bodies are not retained.

## Threats

### Webhook spoofing

Mitigation:

- verify GitHub webhook signatures
- reject invalid signatures before processing

### Webhook replay

Mitigation:

- unique delivery id
- idempotent processing

### GitHub App token misuse

Mitigation:

- short-lived installation tokens
- least privilege
- no token logging
- key rotation runbook

### Public fork PR secret exposure

Mitigation:

- generated workflow skips secret-backed review for fork PRs by default
- docs explain trusted rerun options

### Prompt injection via PR comments

Relevant mostly to future AI discussion features.

Mitigation:

- do not let natural language comments deterministically skip findings
- use explicit `/rr skip` command for overrides
- permission-check command actor
- signed ledger state

### Audit tampering

Mitigation:

- append-only audit events
- record actor and source
- future export/checksum if needed

### Logging sensitive data

Mitigation:

- redaction
- metadata-only logging
- no full webhook payload logs
- no secrets/code/diffs in logs

### Hosted account credential theft

Mitigation:

- envelope encryption with KMS-wrapped data keys
- AEAD AAD includes tenant, account, generation, and database incarnation
- least-privilege decrypt role and audited key use/rotation
- no plaintext in logs, traces, errors, exports, backups, or support tools
- restore quarantine and audited rewrap before restored credentials can run

### Forged or replayed hosted run grant

Mitigation:

- OIDC-authenticated issuance
- exact tenant/repository/workflow/run/attempt/account/audience binding
- short expiry plus request, byte, token, and time ceilings
- replay-safe consumption counters and immediate revocation/kill switches

### Cross-account races and pool hopping

Mitigation:

- sticky invocation-to-account binding
- no full-run account mutex; fence only refresh/writeback mutation
- generation CAS and idempotent credential writeback
- at most one backup, only for classified auth/quota failure before the first
  successful response

### Relay content leakage or amplification

Mitigation:

- body capture disabled in logs/APM/queues/retries
- streaming backpressure and strict request/output/time budgets
- safe metadata-only telemetry
- trusted/private explicitly bound repositories first
- global, workspace, account, and repository kill switches

### Unstable upstream subscription contract

Mitigation:

- hosted mode stays opt-in and disabled until compliance approval
- supported account-type allowlist and compatibility probes
- fail closed on upstream contract drift; never silently switch auth modes
- tested global shutdown path

### Forged reusable observation

An Action may claim a matching manifest or historical result. The server rebuilds
canonical identities, validates authorization plus signed lease/attempt facts,
scope/trust domain, result window and safety decision, and stores only immutable
schema-valid success. Agentic cross-head reuse is denied.

### Stale publication capability

A superseded worker may retain a token or observe an ambiguous SCM response.
Publication requires current permit, mutation epoch, revision and lifecycle
watermarks before each operation. Claim/operation fencing rejects stale owners;
ambiguous effects reconcile under the server-side App identity.

### Repository disconnect or transfer ABA

Deleting tenant bindings must not reset authority. Permanent external SCM identity
and mutation epoch survive disconnect/transfer; reconnect requires explicit rebind
while paused and a strictly newer resume epoch.
