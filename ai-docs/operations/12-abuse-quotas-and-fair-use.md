# Abuse, Quotas, and Fair Use

## Why This Matters

Even without cloud review execution, SaaS endpoints can be abused through webhook floods, OIDC exchanges, repository syncs, setup PR creation, and health report spam.

## Free Beta Limits

Initial soft limits should exist even if not exposed as billing:

```text
max workspaces per user: 3
max repositories per workspace sync: 250
max setup PR attempts per repo per hour: 5
max review config saves per workspace per hour: 60
max full installation syncs per installation per 15 minutes: 10
max health reports and OIDC exchanges: DB-backed action rate limits
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

## Implemented Baseline

- `features-rate-limits` owns fixed-window rate-limit domain logic and application ports.
- `PrismaRateLimitStore` uses a DB-backed bucket table so limits work across multiple API instances.
- Action control-plane checks rate limits before issuing GitHub Actions OIDC sessions and before accepting action health reports.
- Action route errors map rate-limit denials to HTTP `429` with safe public error code `rate_limited`.
- Dashboard mutations use the same DB-backed rate-limit package for manual installation syncs, setup PR creation, review config saves, and dead-letter retries.
- Dashboard rate-limit denials are mapped to a safe `rate_limited` UI error without exposing bucket keys.
- The worker periodically prunes expired DB rate-limit buckets, so the fixed-window table does not grow forever.
- Cleanup is bounded by `REVIEW_ROUTER_RATE_LIMIT_PRUNE_BATCH_SIZE`, throttled by `REVIEW_ROUTER_RATE_LIMIT_PRUNE_INTERVAL_MS`, and logs only aggregate deleted counts.
- Installation repository sync applies `REVIEW_ROUTER_MAX_REPOSITORIES_PER_SYNC` before persistence, default `250`, using deterministic full-name ordering when the GitHub installation exceeds the cap.

Local DB smoke:

```bash
node scripts/run-with-env.mjs pnpm spike:rate-limit:e2e
```

The smoke covers fixed-window blocking, reset behavior, and expired-bucket pruning against the local Postgres database.

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
