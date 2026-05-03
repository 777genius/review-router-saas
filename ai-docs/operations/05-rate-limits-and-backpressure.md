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
