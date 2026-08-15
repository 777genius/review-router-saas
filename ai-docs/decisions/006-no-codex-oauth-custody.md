# ADR-006: Do Not Store Codex OAuth in SaaS v1

## Status

Accepted.

## Decision

ReviewRouter SaaS v1 must not store customer Codex ChatGPT OAuth `auth.json` or `config.toml` secrets.

## Rationale

Codex OAuth credentials are highly sensitive. Storing them centrally would create credential custody, support, abuse, compliance, and trust risks.

Because review execution runs in customer CI/CD, these credentials can stay in customer-controlled GitHub repo/org secrets or on a self-hosted runner with persistent `CODEX_HOME`.

## SaaS Stores Only Setup State

Allowed:

```text
provider type
setup source: repo secret / org selected repo secret / self-hosted runner / unknown
configured: true / false / unknown
last health check summary
last seen workflow config
```

Forbidden in v1:

```text
CODEX_AUTH_JSON plaintext
CODEX_CONFIG_TOML plaintext
OPENAI_API_KEY plaintext unless future encrypted BYOK is explicitly designed
repository code
pull request diff content
```

## Consequences

Positive:

- strong privacy story
- lower breach blast radius
- fewer compliance issues
- easier customer trust

Negative:

- setup requires customer-side secret placement
- SaaS cannot fully repair broken Codex auth automatically
- health checks can only infer state unless workflow reports back

## Hosted Pool Scope Amendment

This decision remains authoritative for the default legacy repository-owned
mode. [ADR-029](./029-opt-in-hosted-workspace-account-pool.md) defines a separate,
explicitly enabled provider mode in which SaaS stores envelope-encrypted Codex
credentials and relays Responses traffic for explicitly bound repositories.

In that mode, credentials never leave SaaS, while prompts, tool outputs, and
responses pass through SaaS transiently without durable body storage. The mode
must stay feature-flagged, kill-switchable, and unavailable until its compliance
gate passes.
