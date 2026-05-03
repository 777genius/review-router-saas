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

## Trust Boundaries

```text
Browser -> ReviewRouter web/API
GitHub -> ReviewRouter webhook endpoint
ReviewRouter API -> GitHub API
ReviewRouter Action -> customer repository/CI/provider
```

ReviewRouter SaaS does not cross into customer code execution in v1.

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
