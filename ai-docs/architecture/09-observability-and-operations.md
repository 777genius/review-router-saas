# Observability and Operations

## Goals

Operators must be able to answer:

- did GitHub send the webhook?
- did we verify and accept it?
- did we enqueue the right job?
- did the job run once or retry?
- did GitHub API fail because of permissions/rate limits?
- did workflow provisioning create/update the expected PR?
- which workspace/repo/config version was involved?

## Structured Logs

Every log should include when available:

```text
requestId
workspaceId
installationId
repoId
githubDeliveryId
jobId
outboxEventId
actorUserId
```

Never log secrets or code.

## Operational Tables

```text
GitHubWebhookDelivery
OutboxEvent
JobExecution or pg-boss job table
AuditEvent
WorkflowProvisioning
ProviderSetupState
```

## Metrics Later

Not required in lean v0, but design should allow:

```text
webhook_received_total
webhook_duplicate_total
webhook_failed_total
job_duration_ms
job_failed_total
github_api_rate_limit_remaining
workflow_provision_success_total
workflow_provision_failure_total
```

## Runbooks Needed

## Review v2 Safety Signals

Emit bounded counters/gauges for admission denial, reuse tier/reason, stale lease
and claim rejection, completion-process age, publication reconciliation outcome,
unknown effects, migration quarantine and pruning backlog. Labels must be finite
enums or release/profile IDs, never repository, PR, account, prompt or finding
content. Alert thresholds, owner `team-reviewrouter` and runbook
`operations/review-v2` are release-bound by ADR-028; missing telemetry blocks
writer enablement.

- GitHub webhook failure investigation
- setup PR failed
- installation removed/suspended
- repo sync stale
- provider setup missing
- stuck provisioning lock/job
- Codex auth stale warning support
- GitHub App private key rotation

## Support Debug Page

Internal-only support view should show safe metadata:

- workspace
- installation
- repo
- config version
- workflow provisioning history
- webhook deliveries
- audit events
- provider setup state

It must not show secrets or repository code.
