# Abuse, Quotas, and Fair Use

## Why This Matters

Even without cloud review execution, SaaS endpoints can be abused through webhook floods, OIDC exchanges, repository syncs, setup PR creation, and health report spam.

## Free Beta Limits

Initial soft limits should exist even if not exposed as billing:

```text
max workspaces per user
max repositories selected per workspace
max setup PR attempts per repo per hour
max health reports per repo per hour
max OIDC exchanges per repo/run
max full installation syncs per installation per hour
```

Limits can be generous, but they must exist.

## Abuse Controls

- webhook signature verification before work
- delivery id dedupe
- per-installation sync queue
- per-repo provisioning lock
- OIDC exchange rate limit keyed by repo/run/IP
- health report size limit
- dashboard mutation rate limit

## User Experience

Rate-limited users should see actionable messages:

```text
Repository sync is already running. Try again in a few minutes.
```

Do not expose internal rate-limit implementation details.

## Admin Controls

Support/security admins need safe controls:

- pause workspace jobs
- disable OIDC config fetch for workspace
- disable workflow provisioning for workspace
- force installation resync after cooldown

All controls must be audited.
