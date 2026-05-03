# Scalability and Concurrency

## Scaling Goal

ReviewRouter must support multiple API and worker instances without duplicate side effects or race conditions.

## Principle

Do not use in-memory mutexes for correctness.

In-memory locks only protect one process. ReviewRouter must use distributed coordination through PostgreSQL and the job queue.

## Required Mechanisms

### 1. Webhook Idempotency

Table:

```text
GitHubWebhookDelivery
- deliveryId unique
- eventName
- installationId nullable
- payloadHash
- status
- receivedAt
- processedAt
- errorSummary nullable
```

Behavior:

- verify signature before storing
- compute payload hash
- normalize safe internal event fields
- insert delivery id and normalized event reference
- if unique conflict, return success without duplicate side effects
- enqueue jobs using normalized event id, not raw payload
- do not perform long work inline

### 2. Distributed Locks

Port:

```ts
export interface DistributedLock {
  withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
}
```

Initial adapter:

```text
PostgresAdvisoryLock
```

Lock keys:

```text
installation:{installationId}:sync
repo:{repoId}:workflow-provision
repo:{repoId}:health-check
workspace:{workspaceId}:config-rollout
```

### 3. Queue-Level Idempotency

Use pg-boss unique/singleton jobs where possible.

Job keys:

```text
sync-installation:{installationId}
provision-workflow:{repoId}:{desiredVersion}
health-check:{repoId}
process-outbox:{eventId}
```

### 4. Outbox Pattern

Use cases write domain/application events to `OutboxEvent` in the same DB transaction as state changes.

Workers drain outbox and invoke side effects.

### 5. Optimistic Concurrency for Config

Review config updates must include expected version.

```text
if currentVersion !== expectedVersion:
  reject with conflict
else:
  create ReviewConfigurationVersion(version + 1)
```

## External Calls and Transactions

Never keep DB transaction open during long GitHub API calls.

Preferred flow:

```text
1. DB transaction: validate state, record intent, enqueue job
2. Commit
3. Worker obtains lock
4. Worker calls GitHub API
5. DB transaction: mark success/failure, emit audit event
```

## Multi-Instance Safety Checklist

- API is stateless.
- Worker is stateless except active job memory.
- Sessions use signed cookies or DB-backed sessions.
- Webhook deliveries are unique.
- Jobs have idempotency keys.
- All side effects can retry.
- Workflow provisioning has repo-level lock.
- Installation sync has installation-level lock.
- Audit writes are append-only.
