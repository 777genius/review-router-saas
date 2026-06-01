# Subscription Runtime File Backend Worker Spike

This spike shows the intended host-neutral integration shape for backend
services that want to run subscription-backed Codex work without Postgres
migrations.

It is deliberately not Nest-specific. A host service can wrap
`FileBackendCodexWorker` in Bull, BullMQ, pg-boss, SQS, a cron process, or a
plain HTTP handler.

## What It Wires

- `LocalEncryptedFileStore` for encrypted session persistence.
- `LocalFileLeaseStore` for single-host/shared-volume refresh coordination.
- `CodexCliSessionDriver` for refresh/writeback.
- `CodexJsonAgentDriver` for task execution.
- `CodexAppServerExecutionEngine` for the fast path.
- `PackagedCodexJsonExecutionEngine` as fallback when app-server fails.
- A small `NodeProcessRunner` and temp workspace adapter for ordinary Node
  backends.

## Runtime Shape

```ts
const worker = new FileBackendCodexWorker({
  providerInstanceId: "codex:ratings",
  stateRootDir: "/var/lib/subscription-runtime",
  codexBinaryPath: "/usr/local/bin/codex",
  encryptionKey: process.env.SUBSCRIPTION_RUNTIME_FILE_KEY!,
  model: "gpt-5.5",
  reasoningEffort: "low",
  slots: 4,
});

await worker.seedCodexAuthJsonFile("/secure/bootstrap/codex-auth.json");
await worker.prewarm();

const result = await worker.runOneShot({
  runId: "match-rating:123",
  prompt: "Calculate the player rating delta for this match...",
});

console.log(result.outputText);
await worker.dispose();
```

## Deployment Notes

- Mount `stateRootDir` on a persistent volume.
- Keep `SUBSCRIPTION_RUNTIME_FILE_KEY` in the host secret manager. It must decode
  to exactly 32 bytes.
- Use an absolute `codexBinaryPath` in production. Do not rely on PATH inside
  minimal containers.
- Set queue concurrency to `slots` for each provider account.
- This file backend is for one host or a reliable shared POSIX volume. Multiple
  independent replicas still need a future Postgres or Redis store/lease
  adapter.

## Open Questions Before Production Integration

- Whether the target host image can run the pinned Codex binary on Alpine or
  needs a Debian/glibc base image.
- Whether app-server should be warmed by a cheap health task at process startup
  or only on first real job.
- Whether each product domain needs one provider account pool or separate pools
  per tenant/user.
