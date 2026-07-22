# Rate Limits and Backpressure

## GitHub API Limits

GitHub API calls are external bottlenecks. ReviewRouter must avoid bursty sync/provisioning behavior.

Controls:

- queue installation sync jobs
- sync selected repositories first
- cache repository metadata
- exponential backoff on secondary rate limits
- persist rate-limit errors as safe summaries
- avoid polling when webhook-driven updates are enough

## SaaS API Rate Limits

Protect public endpoints:

- GitHub webhook endpoint by signature and delivery id
- OIDC exchange endpoint by repo/run and IP-aware limits
- dashboard API by session/workspace limits

Implemented baseline:

- fixed-window buckets live in Postgres so limits work across multiple API/web instances
- action OIDC exchange and health-report routes use DB-backed limits
- interaction OIDC exchanges also have per-repository and per-actor buckets so comment storms are throttled before SaaS issues action sessions
- dashboard mutations use DB-backed limits
- expired buckets are removed by the worker in bounded periodic batches through `REVIEW_ROUTER_RATE_LIMIT_PRUNE_BATCH_SIZE` and `REVIEW_ROUTER_RATE_LIMIT_PRUNE_INTERVAL_MS`
- action OIDC replay nonces live in Postgres so duplicate `jti` claims are rejected across multiple API instances
- expired OIDC replay nonces are removed by the worker in bounded periodic batches through `REVIEW_ROUTER_ACTION_OIDC_REPLAY_NONCE_PRUNE_BATCH_SIZE` and `REVIEW_ROUTER_ACTION_OIDC_REPLAY_NONCE_PRUNE_INTERVAL_MS`

Current action OIDC buckets:

- per run attempt: 20 exchanges per 10 minutes;
- interaction per actor and repository: 30 exchanges per 10 minutes;
- interaction per repository: 120 exchanges per 10 minutes.

## Job Backpressure

Worker queues should expose:

- pending job count
- failed job count
- oldest job age
- retry count

If queue grows:

- pause non-critical health checks
- prioritize installation/repo sync and workflow provisioning
- delay expensive full-org syncs

## Abuse Cases

## Review v2 Queues

Admission is PR-scoped and durable before provider allocation. Enforce the
release-bound work-slot, attempts-per-slot, request-batch and payload ceilings in
Action planning, API validation and persistence. Provider queue contention uses
bounded leases and retry budgets; commit storms supersede obsolete generations
cooperatively. Never tight-loop a rate-limited provider, reconciliation or due
process.

- repeated setup PR clicks
- malicious webhook-like traffic
- OIDC exchange spam
- large organization installation causing immediate massive sync

Mitigations:

- idempotency keys
- distributed locks
- per-workspace throttles
- queued pagination
- explicit user feedback when sync is delayed
