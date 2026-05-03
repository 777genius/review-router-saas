# Config Resolution and Versioning

## Problem

ReviewRouter has two configuration sources:

1. static config embedded in the installed workflow or repo config file
2. SaaS-managed runtime config fetched by the action through OIDC

The precedence must be explicit to avoid surprising users.

## Source of Truth

Default SaaS mode:

```text
SaaS ReviewConfigurationVersion is source of truth.
```

Self-managed/offline mode:

```text
static workflow/repo config is source of truth.
```

## Runtime Resolution

At action start:

```text
1. read static workflow config
2. if SaaS config sync enabled, request OIDC token
3. exchange OIDC for action session
4. fetch runtime config
5. validate runtime config schema and compatibility
6. use runtime config if valid
7. fall back to static config if OIDC/config fetch fails and static config allows fallback
```

## Config Snapshot

Each review run should record the effective config snapshot metadata:

```text
configSource: saas | static | fallback
configVersion
schemaVersion
provider list
policy summary
limits summary
```

Do not report secrets or full prompts to SaaS.

## Version Compatibility

Config schema must include:

```text
schemaVersion
actionMinVersion optional
actionMaxVersion optional
```

If action version is incompatible:

- do not run risky review with unknown config
- fall back to static config if allowed
- report safe error to SaaS
- tell user to update workflow/action version

## Precedence Rules

```text
SaaS runtime config wins over static config when fetched and validated.
Static config wins when SaaS sync disabled.
Static fallback is allowed only for safe defaults.
Secrets never come from SaaS config.
```

## Config Change UX

Dashboard config changes should explain:

- affects future workflow runs
- does not modify repository workflow file unless user runs update workflow PR
- config version is auditable

## Tests

- runtime config wins when valid
- invalid runtime config falls back or fails safely
- incompatible config/action version fails with clear message
- static-only mode works without network to SaaS
- effective config metadata contains no secrets
