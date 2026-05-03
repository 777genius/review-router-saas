# Control Plane Outage Mode

## Goal

ReviewRouter SaaS outages should not unnecessarily break customer pull request review when a safe static configuration exists.

## Principle

The customer CI execution plane should degrade gracefully when SaaS control plane is temporarily unavailable.

## Action Behavior

At startup:

```text
1. load static workflow/repo config
2. attempt OIDC runtime config fetch if enabled
3. if fetch succeeds and config is compatible, use runtime config
4. if fetch fails, use static config if fallback is allowed
5. if no safe config exists, skip with clear reason instead of running unknown behavior
```

## What Can Continue During SaaS Outage

- review execution with static config
- posting comments/status using customer GitHub token/App token if configured
- provider execution with customer secrets if workflow trust policy allows it

## What Cannot Continue During SaaS Outage

- dashboard config changes
- new workflow provisioning
- runtime config fetch
- health reporting
- update PR orchestration

## User-Facing Behavior

Action should write a concise note:

```text
ReviewRouter SaaS config fetch failed. Continuing with static workflow config.
```

Only fail the check if:

- static config is missing
- static fallback disabled
- installed action/config versions are incompatible
- provider setup is invalid

## Dashboard Behavior

Dashboard should show stale health when reports stop arriving:

```text
Last health report: 2 hours ago
Runtime config sync: no recent report
```

Do not claim repo is broken solely because SaaS did not receive a recent report.

## Tests

- SaaS config fetch timeout falls back to static config
- fallback disabled causes skipped result with clear reason
- health report failure does not fail review
- incompatible static config fails safely
