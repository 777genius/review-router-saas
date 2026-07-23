import { describe, expect, it, vi } from "vitest";
import type {
  OutboxEvent,
  OutboxEventRepositoryPort,
  NewOutboxEvent,
} from "@reviewrouter/features-outbox";
import {
  classifyConflictReviewEligibility,
  conflictReviewAttemptExchangeTtlMs,
  conflictReviewDispatchEventType,
  conflictReviewFallbackVersion,
  createConflictReviewDispatchIdentity,
  hashConflictReviewDispatchNonce,
  safeConflictReviewErrorSummary,
  type ConflictReviewAttempt,
  type ConflictReviewPullRequestSnapshot,
  type ConflictReviewRepository,
} from "../domain/conflict-review";
import {
  processConflictReviewDetection,
  type ProcessConflictReviewDetectionResult,
} from "../application/use-cases/process-conflict-review-detection";
import {
  requestConflictReviewDetectionFromPullRequestWebhook,
  requestConflictReviewDetectionFromPushWebhook,
} from "../application/use-cases/request-conflict-review-detection";
import type { ConflictReviewGitHubGatewayPort } from "../application/ports/conflict-review-github-gateway-port";
import type { ConflictReviewRepositoryPort } from "../application/ports/conflict-review-repository-port";
import { createConflictReviewDetectionRequestedHandler } from "../infrastructure/outbox/conflict-review-detection-requested-handler";
import { PrismaConflictReviewRepository } from "../infrastructure/prisma/prisma-conflict-review-repository";

const now = new Date("2026-05-14T12:00:00.000Z");
const clock = { now: () => now };

const repository: ConflictReviewRepository = {
  workspaceId: "workspace_1",
  repositoryId: "repo_1",
  githubRepositoryId: "123456",
  githubInstallationId: "987654",
  owner: "777genius",
  name: "example",
  fullName: "777genius/example",
  defaultBranch: "main",
  selected: true,
  installationStatus: "active",
};

describe("conflict review", () => {
  it("uses a positive dirty mergeability signal only", () => {
    const pullRequest = pullRequestSnapshot();

    expect(
      classifyConflictReviewEligibility({ repository, pullRequest }),
    ).toEqual({ eligible: true });
    expect(
      classifyConflictReviewEligibility({
        repository,
        pullRequest: {
          ...pullRequest,
          mergeable: false,
          mergeableState: "blocked",
        },
      }),
    ).toEqual({ eligible: false, reason: "mergeable_state_not_conflict" });
    expect(
      classifyConflictReviewEligibility({
        repository,
        pullRequest: {
          ...pullRequest,
          headRepositoryFullName: "fork/example",
        },
      }),
    ).toEqual({ eligible: false, reason: "fork_pr" });
    expect(
      classifyConflictReviewEligibility({
        repository,
        pullRequest: {
          ...pullRequest,
          baseRef: "refs/heads/main",
        },
      }),
    ).toEqual({ eligible: false, reason: "base_ref_unsafe" });
    expect(() =>
      createConflictReviewDispatchIdentity({
        githubRepositoryId: repository.githubRepositoryId,
        pullRequestNumber: 7,
        headSha: pullRequest.headSha,
        baseRef: "feature/../main",
        baseSha: pullRequest.baseSha,
      }),
    ).toThrow();
  });

  it("records a durable attempt before dispatching repository_dispatch", async () => {
    const repositories = new InMemoryConflictReviewRepository(repository);
    const github = new InMemoryConflictReviewGithub();

    const result = await processConflictReviewDetection(
      {
        source: "pull_request",
        deliveryId: "delivery-1",
        githubInstallationId: repository.githubInstallationId,
        githubRepositoryId: repository.githubRepositoryId,
        repositoryFullName: repository.fullName,
        pullRequestNumber: 7,
        action: "synchronize",
      },
      { repositories, github, clock },
    );

    expect(result).toMatchObject({
      status: "queued",
      pullRequestNumber: 7,
    } satisfies Partial<ProcessConflictReviewDetectionResult>);
    expect(repositories.attempts).toHaveLength(1);
    expect(github.dispatches).toHaveLength(1);
    expect(github.dispatches[0]?.payload).toMatchObject({
      protocol_version: 1,
      dispatch_event_type: conflictReviewDispatchEventType,
      repository_id: "123456",
      pr_number: 7,
      head_sha: pullRequestSnapshot().headSha,
      base_ref: "main",
      base_sha: pullRequestSnapshot().baseSha,
      fallback_version: conflictReviewFallbackVersion,
    });
  });

  it("skips detection before GitHub reads when repository rollout is disabled", async () => {
    const repositories = new InMemoryConflictReviewRepository(repository);
    const github = new InMemoryConflictReviewGithub();

    const result = await processConflictReviewDetection(
      {
        source: "pull_request",
        deliveryId: "delivery-1",
        githubInstallationId: repository.githubInstallationId,
        githubRepositoryId: repository.githubRepositoryId,
        repositoryFullName: repository.fullName,
        pullRequestNumber: 7,
        action: "synchronize",
      },
      {
        repositories,
        github,
        rolloutPolicy: { isConflictReviewFallbackAllowed: () => false },
        clock,
      },
    );

    expect(result).toEqual({
      status: "ignored",
      reason: "conflict_review_rollout_disabled",
    });
    expect(repositories.attempts).toHaveLength(0);
    expect(github.pullRequestCalls).toHaveLength(0);
    expect(github.dispatches).toHaveLength(0);
  });

  it("uses the signed webhook repository full name as fresh GitHub API coordinates", async () => {
    const repositories = new InMemoryConflictReviewRepository({
      ...repository,
      owner: "old-owner",
      name: "old-name",
      fullName: "old-owner/old-name",
    });
    const github = new InMemoryConflictReviewGithub();

    await processConflictReviewDetection(
      {
        source: "pull_request",
        deliveryId: "delivery-rename",
        githubInstallationId: repository.githubInstallationId,
        githubRepositoryId: repository.githubRepositoryId,
        repositoryFullName: repository.fullName,
        pullRequestNumber: 7,
        action: "synchronize",
      },
      { repositories, github, clock },
    );

    expect(github.pullRequestCalls[0]).toMatchObject({
      owner: "777genius",
      repo: "example",
    });
    expect(github.dispatches[0]).toMatchObject({
      owner: "777genius",
      repo: "example",
    });
  });

  it("does not dispatch duplicate attempts for the same head and base identity", async () => {
    const repositories = new InMemoryConflictReviewRepository(repository);
    const github = new InMemoryConflictReviewGithub();
    const payload = {
      source: "pull_request" as const,
      deliveryId: "delivery-1",
      githubInstallationId: repository.githubInstallationId,
      githubRepositoryId: repository.githubRepositoryId,
      repositoryFullName: repository.fullName,
      pullRequestNumber: 7,
      action: "synchronize",
    };

    await processConflictReviewDetection(payload, {
      repositories,
      github,
      clock,
    });
    const duplicate = await processConflictReviewDetection(payload, {
      repositories,
      github,
      clock,
    });

    expect(duplicate.status).toBe("already_recorded");
    expect(repositories.attempts).toHaveLength(1);
    expect(github.dispatches).toHaveLength(1);
  });

  it("rotates dispatch identity when retrying a failed dispatch attempt", async () => {
    const repositories = new InMemoryConflictReviewRepository(repository);
    const github = new InMemoryConflictReviewGithub();
    github.dispatchFailuresRemaining = 1;
    const payload = {
      source: "pull_request" as const,
      deliveryId: "delivery-1",
      githubInstallationId: repository.githubInstallationId,
      githubRepositoryId: repository.githubRepositoryId,
      repositoryFullName: repository.fullName,
      pullRequestNumber: 7,
      action: "synchronize",
    };

    await expect(
      processConflictReviewDetection(payload, {
        repositories,
        github,
        clock,
      }),
    ).rejects.toThrow("github_dispatch_failed");
    const failedAttempt = repositories.attempts[0]!;
    expect(failedAttempt.status).toBe("failed");

    const retry = await processConflictReviewDetection(payload, {
      repositories,
      github,
      clock,
    });

    expect(retry).toMatchObject({
      status: "queued",
      attemptId: failedAttempt.id,
    });
    expect(repositories.attempts).toHaveLength(1);
    expect(repositories.attempts[0]?.dispatchId).not.toBe(
      failedAttempt.dispatchId,
    );
    expect(repositories.attempts[0]?.dispatchNonceHash).not.toBe(
      failedAttempt.dispatchNonceHash,
    );
    expect(github.dispatches).toHaveLength(1);
  });

  it("redacts the raw dispatch nonce from safe error summaries", () => {
    const nonce = "n".repeat(40);

    expect(
      safeConflictReviewErrorSummary(
        new Error(`GitHub dispatch failed with nonce ${nonce}`),
        [nonce],
      ),
    ).toBe("GitHub dispatch failed with nonce [redacted]");
  });

  it("gates dispatch on workflow capability", async () => {
    const repositories = new InMemoryConflictReviewRepository(repository);
    const github = new InMemoryConflictReviewGithub();
    github.capability = { supported: false, reason: "workflow_missing" };

    const result = await processConflictReviewDetection(
      {
        source: "pull_request",
        deliveryId: "delivery-1",
        githubInstallationId: repository.githubInstallationId,
        githubRepositoryId: repository.githubRepositoryId,
        repositoryFullName: repository.fullName,
        pullRequestNumber: 7,
        action: "synchronize",
      },
      { repositories, github, clock },
    );

    expect(result).toEqual({
      status: "ignored",
      reason: "workflow_missing_conflict_capability",
    });
    expect(repositories.attempts).toHaveLength(0);
    expect(github.dispatches).toHaveLength(0);
  });

  it("keeps unresolved GitHub mergeability retryable in the outbox", async () => {
    const repositories = new InMemoryConflictReviewRepository(repository);
    const github = new InMemoryConflictReviewGithub();
    github.pullRequest = {
      ...pullRequestSnapshot(),
      mergeable: null,
      mergeableState: null,
    };
    const handler = createConflictReviewDetectionRequestedHandler({
      repositories,
      github,
      clock,
    });

    await expect(
      handler.handle(
        outboxEvent({
          source: "pull_request",
          deliveryId: "delivery-1",
          githubInstallationId: repository.githubInstallationId,
          githubRepositoryId: repository.githubRepositoryId,
          repositoryFullName: repository.fullName,
          pullRequestNumber: 7,
          action: "synchronize",
        }),
      ),
    ).rejects.toMatchObject({
      code: "github_mergeability_unknown",
      retryable: true,
    });
    expect(repositories.attempts).toHaveLength(0);
    expect(github.dispatches).toHaveLength(0);
  });

  it("keeps base-push reconciliation retryable when any open PR has unknown mergeability", async () => {
    const repositories = new InMemoryConflictReviewRepository(repository);
    const github = new InMemoryConflictReviewGithub();
    github.openPullRequestNumbersForBase = [7, 8];
    github.pullRequests.set(7, {
      ...pullRequestSnapshot(7),
      mergeable: null,
      mergeableState: null,
    });
    github.pullRequests.set(8, pullRequestSnapshot(8));
    const handler = createConflictReviewDetectionRequestedHandler({
      repositories,
      github,
      clock,
    });

    await expect(
      handler.handle(
        outboxEvent({
          source: "base_push",
          deliveryId: "delivery-2",
          githubInstallationId: repository.githubInstallationId,
          githubRepositoryId: repository.githubRepositoryId,
          repositoryFullName: repository.fullName,
          baseRef: "main",
        }),
      ),
    ).rejects.toMatchObject({
      code: "github_mergeability_unknown",
      retryable: true,
    });
    expect(github.dispatches).toHaveLength(1);
    expect(github.dispatches[0]?.payload.pr_number).toBe(8);
  });

  it("binds conflict review exchange to the recorded nonce, TTL, and first GitHub run", async () => {
    const prisma = new InMemoryPrismaConflictReviewAttempt();
    const repositories = new PrismaConflictReviewRepository(prisma.asPrisma());
    const dispatchPayload = prisma.dispatchPayload();

    await expect(
      repositories.verifyConflictReviewExchange({
        claims: {
          repository_id: repository.githubRepositoryId,
          run_id: "100",
          run_attempt: "1",
        },
        dispatchPayload,
        configSnapshotId: "repository:7",
        exchangedAt: now,
      }),
    ).resolves.toMatchObject({
      reviewKind: "conflict-head",
      dispatchId: dispatchPayload.dispatchId,
      pullRequestNumber: 7,
    });
    expect(prisma.record.githubRunId).toBe("100");
    expect(prisma.record.configSnapshotId).toBe("repository:7");

    await expect(
      repositories.verifyConflictReviewExchange({
        claims: {
          repository_id: repository.githubRepositoryId,
          run_id: "100",
          run_attempt: "2",
        },
        dispatchPayload,
        configSnapshotId: "repository:7",
        exchangedAt: now,
      }),
    ).resolves.toMatchObject({ reviewKind: "conflict-head" });
    expect(prisma.record.githubRunAttempt).toBe("2");

    await expect(
      repositories.verifyConflictReviewExchange({
        claims: {
          repository_id: repository.githubRepositoryId,
          run_id: "100",
          run_attempt: "3",
        },
        dispatchPayload,
        configSnapshotId: "repository:8",
        exchangedAt: now,
      }),
    ).rejects.toThrow("conflict_review_config_snapshot_mismatch");
    expect(prisma.record.configSnapshotId).toBe("repository:7");
    expect(prisma.record.githubRunAttempt).toBe("2");

    await expect(
      repositories.verifyConflictReviewExchange({
        claims: {
          repository_id: repository.githubRepositoryId,
          run_id: "101",
          run_attempt: "1",
        },
        dispatchPayload,
        configSnapshotId: "repository:7",
        exchangedAt: now,
      }),
    ).rejects.toThrow("conflict_review_run_mismatch");

    await expect(
      repositories.verifyConflictReviewExchange({
        claims: {
          repository_id: repository.githubRepositoryId,
          run_id: "100",
          run_attempt: "1",
        },
        dispatchPayload,
        configSnapshotId: "repository:7",
        exchangedAt: now,
      }),
    ).rejects.toThrow("conflict_review_run_attempt_stale");

    await expect(
      repositories.verifyConflictReviewExchange({
        claims: {
          repository_id: repository.githubRepositoryId,
          run_id: "100",
          run_attempt: "3",
        },
        dispatchPayload: {
          ...dispatchPayload,
          dispatchEventType: "wrong_dispatch_action" as never,
        },
        configSnapshotId: "repository:7",
        exchangedAt: now,
      }),
    ).rejects.toThrow("conflict_review_event_type_mismatch");

    const expired = new InMemoryPrismaConflictReviewAttempt({
      createdAt: new Date(
        now.getTime() - conflictReviewAttemptExchangeTtlMs - 1,
      ),
    });
    await expect(
      new PrismaConflictReviewRepository(
        expired.asPrisma(),
      ).verifyConflictReviewExchange({
        claims: {
          repository_id: repository.githubRepositoryId,
          run_id: "200",
          run_attempt: "1",
        },
        dispatchPayload: expired.dispatchPayload(),
        configSnapshotId: "repository:7",
        exchangedAt: now,
      }),
    ).rejects.toThrow("conflict_review_attempt_expired");
  });

  it("does not downgrade a started attempt when dispatch marking races with runtime exchange", async () => {
    const prisma = new InMemoryPrismaConflictReviewAttempt({
      status: "started",
      githubRunId: "100",
      githubRunAttempt: "1",
    });
    const repositories = new PrismaConflictReviewRepository(prisma.asPrisma());

    await repositories.markAttemptDispatched({
      attemptId: prisma.record.id,
      dispatchedAt: now,
    });

    expect(prisma.record.status).toBe("started");
    expect(prisma.record.githubRunId).toBe("100");
  });

  it("does not downgrade a started attempt when dispatch failure races with runtime exchange", async () => {
    const prisma = new InMemoryPrismaConflictReviewAttempt({
      status: "started",
      githubRunId: "100",
      githubRunAttempt: "1",
    });
    const repositories = new PrismaConflictReviewRepository(prisma.asPrisma());

    await repositories.markAttemptFailed({
      attemptId: prisma.record.id,
      errorCode: "github_dispatch_failed",
      safeErrorSummary: "GitHub timed out after accepting dispatch",
      failedAt: now,
    });

    expect(prisma.record.status).toBe("started");
    expect(prisma.record.githubRunId).toBe("100");
  });

  it("issues conflict posting scopes only for the bound run and manifest", async () => {
    const prisma = new InMemoryPrismaConflictReviewAttempt({
      status: "started",
      githubRunId: "100",
      githubRunAttempt: "1",
      configSnapshotId: "repository:7",
    });
    const repositories = new PrismaConflictReviewRepository(prisma.asPrisma());
    const manifestHash = "c".repeat(64);

    const scope = await repositories.issueConflictReviewPostingSession({
      session: {
        workspaceId: repository.workspaceId,
        repositoryId: repository.repositoryId,
        githubRepositoryId: repository.githubRepositoryId,
        repository: repository.fullName,
        githubRunId: "100",
        githubRunAttempt: "1",
        reviewKind: "conflict-head",
        conflictDispatchId: prisma.record.dispatchId,
        pullRequestNumber: 7,
        headSha: "a".repeat(40),
        baseRef: "main",
        baseSha: "b".repeat(40),
        configSnapshotId: "repository:7",
      },
      manifestHash,
      issuedAt: now,
    });

    expect(scope).toMatchObject({
      purpose: "conflict-review-posting",
      attemptId: "attempt_1",
      dispatchId: prisma.record.dispatchId,
      manifestHash,
      headSha: "a".repeat(40),
      baseRef: "main",
      baseSha: "b".repeat(40),
      protocolVersion: 1,
    });
    expect(scope.operationScopeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(prisma.record.status).toBe("posting_started");
    expect(prisma.record.postingManifestHash).toBe(manifestHash);
    expect(prisma.record.version).toBe(2);

    await expect(
      repositories.issueConflictReviewPostingSession({
        session: {
          workspaceId: repository.workspaceId,
          repositoryId: repository.repositoryId,
          githubRepositoryId: repository.githubRepositoryId,
          repository: repository.fullName,
          githubRunId: "100",
          githubRunAttempt: "1",
          reviewKind: "conflict-head",
          conflictDispatchId: prisma.record.dispatchId,
          pullRequestNumber: 7,
          headSha: "a".repeat(40),
          baseRef: "main",
          baseSha: "b".repeat(40),
          configSnapshotId: "repository:7",
        },
        manifestHash: "d".repeat(64),
        issuedAt: now,
      }),
    ).rejects.toThrow("conflict_review_posting_manifest_mismatch");
  });

  it("recovers ambiguous posting intents with the same idempotency key", async () => {
    const manifestHash = "c".repeat(64);
    const prisma = new InMemoryPrismaConflictReviewAttempt({
      status: "posting_started",
      githubRunId: "100",
      githubRunAttempt: "1",
      configSnapshotId: "repository:7",
      postingManifestHash: manifestHash,
    });
    const repositories = new PrismaConflictReviewRepository(prisma.asPrisma());
    const scope = {
      purpose: "conflict-review-posting" as const,
      attemptId: prisma.record.id,
      workspaceId: repository.workspaceId,
      repositoryId: repository.repositoryId,
      githubRepositoryId: repository.githubRepositoryId,
      githubInstallationId: repository.githubInstallationId,
      repository: repository.fullName,
      githubRunId: "100",
      githubRunAttempt: "1",
      dispatchId: prisma.record.dispatchId,
      pullRequestNumber: 7,
      headSha: "a".repeat(40),
      baseRef: "main",
      baseSha: "b".repeat(40),
      configSnapshotId: "repository:7",
      manifestHash,
      operationScopeHash: "d".repeat(64),
      protocolVersion: 1 as const,
    };
    const operationFingerprint = "e".repeat(64);

    const reserved = await repositories.reserveConflictReviewPostingIntent({
      scope,
      operationKind: "summary_comment",
      operationFingerprint,
      bodyHash: "f".repeat(64),
      requestedAt: now,
    });
    expect(reserved).toEqual({
      status: "reserved",
      intentId: "posting_intent_1",
    });
    await repositories.markConflictReviewPostingIntentAmbiguous({
      scope,
      intentId: "posting_intent_1",
      operationKind: "summary_comment",
      safeErrorCode: "conflict_summary_post_ambiguous",
      safeErrorSummary: "timeout",
      failedAt: now,
    });
    expect(prisma.postingIntents.get(operationFingerprint)?.status).toBe(
      "ambiguous",
    );

    await expect(
      repositories.reserveConflictReviewPostingIntent({
        scope,
        operationKind: "summary_comment",
        operationFingerprint,
        bodyHash: "f".repeat(64),
        requestedAt: now,
      }),
    ).resolves.toEqual({
      status: "reserved",
      intentId: "posting_intent_1",
    });
    expect(prisma.postingIntents.get(operationFingerprint)?.status).toBe(
      "pending",
    );

    await repositories.commitConflictReviewPostingIntent({
      scope,
      intentId: "posting_intent_1",
      operationKind: "summary_comment",
      githubExternalId: "summary_1",
      githubUrl: "https://github.com/777genius/example/pull/7#issuecomment-1",
      bodyHash: "f".repeat(64),
      completedAt: now,
    });
    await expect(
      repositories.reserveConflictReviewPostingIntent({
        scope,
        operationKind: "summary_comment",
        operationFingerprint,
        bodyHash: "f".repeat(64),
        requestedAt: now,
      }),
    ).resolves.toEqual({
      status: "completed",
      intentId: "posting_intent_1",
      githubExternalId: "summary_1",
      githubUrl: "https://github.com/777genius/example/pull/7#issuecomment-1",
    });
  });

  it("queues detection from PR and base push webhooks without dispatching in the HTTP request", async () => {
    const outbox = new InMemoryOutbox();
    const pullRequestResult =
      await requestConflictReviewDetectionFromPullRequestWebhook(
        {
          deliveryId: "delivery-pr",
          eventName: "pull_request",
          payloadHash: "hash",
          payload: {
            action: "synchronize",
            installation: { id: 987654 },
            repository: {
              id: 123456,
              name: "example",
              full_name: "777genius/example",
            },
            pull_request: {
              number: 7,
              html_url: "https://github.com/777genius/example/pull/7",
              state: "open",
              merged: false,
              draft: false,
              base: { ref: "main" },
              head: { ref: "feature" },
            },
          },
        },
        { outbox, clock },
      );
    const pushResult = await requestConflictReviewDetectionFromPushWebhook(
      {
        deliveryId: "delivery-push",
        eventName: "push",
        payloadHash: "hash",
        payload: {
          ref: "refs/heads/main",
          deleted: false,
          installation: { id: 987654 },
          repository: {
            id: 123456,
            name: "example",
            full_name: "777genius/example",
          },
        },
      },
      { outbox, clock },
    );

    expect(pullRequestResult).toEqual({ processed: true, queued: true });
    expect(pushResult).toEqual({ processed: true, queued: true });
    await expect(
      requestConflictReviewDetectionFromPushWebhook(
        {
          deliveryId: "delivery-push-unsafe",
          eventName: "push",
          payloadHash: "hash",
          payload: {
            ref: "refs/heads/gh-readonly-queue/main/pr-1",
            deleted: false,
            installation: { id: 987654 },
            repository: {
              id: 123456,
              name: "example",
              full_name: "777genius/example",
            },
          },
        },
        { outbox, clock },
      ),
    ).resolves.toEqual({
      processed: false,
      queued: false,
      reason: "push_not_branch",
    });
    expect(outbox.events.map((event) => event.type)).toEqual([
      "conflict_review.detection_requested",
      "conflict_review.detection_requested",
    ]);
  });

  it("skips webhook enqueue when repository rollout is disabled", async () => {
    const outbox = new InMemoryOutbox();
    const result = await requestConflictReviewDetectionFromPullRequestWebhook(
      {
        deliveryId: "delivery-pr",
        eventName: "pull_request",
        payloadHash: "hash",
        payload: {
          action: "synchronize",
          installation: { id: 987654 },
          repository: {
            id: 123456,
            name: "example",
            full_name: "777genius/example",
          },
          pull_request: {
            number: 7,
            html_url: "https://github.com/777genius/example/pull/7",
            state: "open",
            merged: false,
            draft: false,
            base: { ref: "main" },
            head: { ref: "feature" },
          },
        },
      },
      {
        outbox,
        rolloutPolicy: { isConflictReviewFallbackAllowed: () => false },
        clock,
      },
    );

    expect(result).toEqual({
      processed: false,
      queued: false,
      reason: "conflict_review_rollout_disabled",
    });
    expect(outbox.events).toHaveLength(0);
  });
});

function pullRequestSnapshot(number = 7): ConflictReviewPullRequestSnapshot {
  return {
    repositoryFullName: repository.fullName,
    number,
    state: "open",
    draft: false,
    merged: false,
    headSha: "a".repeat(40),
    headRef: "feature",
    headRepositoryFullName: repository.fullName,
    baseSha: "b".repeat(40),
    baseRef: "main",
    baseRepositoryFullName: repository.fullName,
    mergeable: false,
    mergeableState: "dirty",
  };
}

function outboxEvent(payload: unknown): OutboxEvent {
  return {
    id: "event_1",
    type: "conflict_review.detection_requested",
    version: 1,
    idempotencyKey: "conflict-review:test",
    workspaceId: repository.workspaceId,
    repositoryId: repository.repositoryId,
    aggregateId: repository.repositoryId,
    payload,
    status: "processing",
    attempts: 1,
    maxAttempts: 5,
    nextAttemptAt: null,
    claimId: "claim_1",
    claimVersion: 1n,
    claimOwnerHash: "worker_1",
    claimUntil: new Date(now.getTime() + 60_000),
    occurredAt: now,
  };
}

class InMemoryOutbox implements OutboxEventRepositoryPort {
  public readonly events: NewOutboxEvent[] = [];

  async enqueue(event: NewOutboxEvent): Promise<{ readonly created: boolean }> {
    this.events.push(event);
    return { created: true };
  }

  recoverStaleProcessing = vi.fn();
  claimDue = vi.fn();
  renewClaim = vi.fn();
  markProcessed = vi.fn();
  markRetry = vi.fn();
  markDeadLetter = vi.fn();
}

class InMemoryConflictReviewRepository implements ConflictReviewRepositoryPort {
  public readonly attempts: ConflictReviewAttempt[] = [];

  constructor(private readonly repository: ConflictReviewRepository | null) {}

  async findRepositoryByGitHubIdentity(): Promise<ConflictReviewRepository | null> {
    return this.repository;
  }

  async tryCreateAttempt(
    attempt: Parameters<ConflictReviewRepositoryPort["tryCreateAttempt"]>[0],
  ): ReturnType<ConflictReviewRepositoryPort["tryCreateAttempt"]> {
    const existing = this.attempts.find(
      (candidate) =>
        candidate.repositoryId === attempt.repositoryId &&
        candidate.pullRequestNumber === attempt.pullRequestNumber &&
        candidate.headSha === attempt.headSha &&
        candidate.baseRef === attempt.baseRef &&
        candidate.baseSha === attempt.baseSha &&
        candidate.fallbackVersion === attempt.fallbackVersion,
    );
    if (existing) {
      return { created: false, attempt: existing };
    }
    const created: ConflictReviewAttempt = {
      ...attempt,
      id: `attempt_${this.attempts.length + 1}`,
      status: "recorded",
      version: 1,
      postingManifestHash: null,
    };
    this.attempts.push(created);
    return { created: true, attempt: created };
  }

  async refreshAttemptDispatch(
    input: Parameters<
      ConflictReviewRepositoryPort["refreshAttemptDispatch"]
    >[0],
  ): ReturnType<ConflictReviewRepositoryPort["refreshAttemptDispatch"]> {
    const existing = this.attempts.find(
      (attempt) =>
        attempt.id === input.attemptId &&
        attempt.dispatchId === input.previousDispatchId &&
        ["recorded", "failed"].includes(attempt.status),
    );
    if (!existing) return null;
    this.replaceAttempt(input.attemptId, {
      dispatchId: input.dispatchId,
      dispatchNonceHash: input.dispatchNonceHash,
      dispatchEventType: input.dispatchEventType,
      status: "recorded",
      createdAt: input.refreshedAt,
    });
    return (
      this.attempts.find((attempt) => attempt.id === input.attemptId) ?? null
    );
  }

  async markAttemptDispatched(
    input: Parameters<ConflictReviewRepositoryPort["markAttemptDispatched"]>[0],
  ): Promise<void> {
    this.replaceAttempt(input.attemptId, { status: "dispatched" });
  }

  async markAttemptSkipped(): Promise<void> {}

  async markAttemptFailed(
    input: Parameters<ConflictReviewRepositoryPort["markAttemptFailed"]>[0],
  ): Promise<void> {
    this.replaceAttempt(input.attemptId, { status: "failed" });
  }

  private replaceAttempt(
    attemptId: string,
    patch: Partial<ConflictReviewAttempt>,
  ): void {
    const index = this.attempts.findIndex(
      (attempt) => attempt.id === attemptId,
    );
    if (index === -1) return;
    this.attempts[index] = { ...this.attempts[index]!, ...patch };
  }
}

class InMemoryConflictReviewGithub implements ConflictReviewGitHubGatewayPort {
  public readonly pullRequestCalls: Array<{
    readonly owner: string;
    readonly repo: string;
  }> = [];

  public dispatches: {
    readonly owner: string;
    readonly repo: string;
    readonly payload: Parameters<
      ConflictReviewGitHubGatewayPort["dispatchConflictReview"]
    >[0]["payload"];
  }[] = [];

  public capability: Awaited<
    ReturnType<ConflictReviewGitHubGatewayPort["getReviewWorkflowCapability"]>
  > = { supported: true };

  public pullRequest = pullRequestSnapshot();
  public pullRequests = new Map<number, ConflictReviewPullRequestSnapshot>();
  public openPullRequestNumbersForBase: readonly number[] = [7];
  public dispatchFailuresRemaining = 0;

  async getPullRequest(
    input: Parameters<ConflictReviewGitHubGatewayPort["getPullRequest"]>[0],
  ) {
    this.pullRequestCalls.push({ owner: input.owner, repo: input.repo });
    return this.pullRequests.get(input.pullRequestNumber) ?? this.pullRequest;
  }

  async listOpenPullRequestNumbersForBase(): Promise<readonly number[]> {
    return this.openPullRequestNumbersForBase;
  }

  async getReviewWorkflowCapability() {
    return this.capability;
  }

  async dispatchConflictReview(
    input: Parameters<
      ConflictReviewGitHubGatewayPort["dispatchConflictReview"]
    >[0],
  ): Promise<void> {
    if (this.dispatchFailuresRemaining > 0) {
      this.dispatchFailuresRemaining -= 1;
      throw new Error("github_dispatch_failed");
    }
    expect(input.payload.dispatch_id).toMatch(
      /^cr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(input.payload.nonce.length).toBeGreaterThan(32);
    this.dispatches.push({
      owner: input.owner,
      repo: input.repo,
      payload: input.payload,
    });
  }
}

class InMemoryPrismaConflictReviewAttempt {
  public readonly nonce = "n".repeat(40);
  public readonly postingIntents = new Map<
    string,
    {
      id: string;
      attemptId: string;
      operationKind: string;
      operationFingerprint: string;
      manifestHash: string;
      bodyHash: string;
      status: "pending" | "completed" | "failed" | "ambiguous";
      githubExternalId: string | null;
      githubUrl: string | null;
      safeErrorCode: string | null;
      safeErrorSummary: string | null;
      completedAt: Date | null;
    }
  >();
  public readonly record: {
    id: string;
    workspaceId: string;
    repositoryId: string;
    githubRepositoryId: bigint;
    githubInstallationId: bigint;
    pullRequestNumber: number;
    headSha: string;
    baseRef: string;
    baseSha: string;
    fallbackVersion: number;
    dispatchId: string;
    dispatchNonceHash: string;
    dispatchEventType: string;
    status: string;
    version: number;
    createdAt: Date;
    githubRunId: string | null;
    githubRunAttempt: string | null;
    configSnapshotId: string | null;
    postingManifestHash: string | null;
  };

  constructor(
    overrides: Partial<InMemoryPrismaConflictReviewAttempt["record"]> = {},
  ) {
    this.record = {
      id: "attempt_1",
      workspaceId: repository.workspaceId,
      repositoryId: repository.repositoryId,
      githubRepositoryId: BigInt(repository.githubRepositoryId),
      githubInstallationId: BigInt(repository.githubInstallationId),
      pullRequestNumber: 7,
      headSha: pullRequestSnapshot().headSha,
      baseRef: "main",
      baseSha: pullRequestSnapshot().baseSha,
      fallbackVersion: conflictReviewFallbackVersion,
      dispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
      dispatchNonceHash: hashConflictReviewDispatchNonce(this.nonce),
      dispatchEventType:
        conflictReviewDispatchEventType as typeof conflictReviewDispatchEventType,
      status: "dispatched",
      version: 1,
      createdAt: now,
      githubRunId: null,
      githubRunAttempt: null,
      configSnapshotId: null,
      postingManifestHash: null,
      ...overrides,
    };
  }

  dispatchPayload() {
    return {
      protocolVersion: 1 as const,
      dispatchEventType:
        conflictReviewDispatchEventType as typeof conflictReviewDispatchEventType,
      dispatchId: this.record.dispatchId,
      nonce: this.nonce,
      repositoryId: this.record.githubRepositoryId.toString(),
      pullRequestNumber: this.record.pullRequestNumber,
      headSha: this.record.headSha,
      baseRef: this.record.baseRef,
      baseSha: this.record.baseSha,
      fallbackVersion: 1 as const,
    };
  }

  asPrisma() {
    return {
      conflictReviewAttempt: {
        findUnique: vi.fn(
          async (input: { where: { dispatchId?: string; id?: string } }) =>
            input.where.dispatchId === this.record.dispatchId ||
            input.where.id === this.record.id
              ? this.record
              : null,
        ),
        updateMany: vi.fn(
          async (input: {
            where: {
              id: string;
              status?: string | { in: readonly string[] };
              githubRunId?: string;
              githubRunAttempt?: string;
              configSnapshotId?: string;
              OR?: readonly Record<string, string | null>[];
              AND?: readonly {
                OR: readonly Record<string, string | null>[];
              }[];
            };
            data: Partial<{
              status: string;
              githubRunId: string;
              githubRunAttempt: string;
              configSnapshotId: string;
              startedAt: Date;
              dispatchedAt: Date;
              postingManifestHash: string;
              version: { increment: number };
            }>;
          }) => {
            if (
              input.where.id !== this.record.id ||
              (input.where.status !== undefined &&
                !statusMatches(input.where.status, this.record.status))
            ) {
              return { count: 0 };
            }
            if (
              input.where.githubRunId !== undefined &&
              input.where.githubRunId !== this.record.githubRunId
            ) {
              return { count: 0 };
            }
            if (
              input.where.githubRunAttempt !== undefined &&
              input.where.githubRunAttempt !== this.record.githubRunAttempt
            ) {
              return { count: 0 };
            }
            if (
              input.where.configSnapshotId !== undefined &&
              input.where.configSnapshotId !== this.record.configSnapshotId
            ) {
              return { count: 0 };
            }
            const runMatches =
              input.where.OR?.some((condition) =>
                condition.githubRunId === null
                  ? this.record.githubRunId === null
                  : condition.githubRunId !== undefined
                    ? condition.githubRunId === this.record.githubRunId
                    : condition.postingManifestHash === null
                      ? this.record.postingManifestHash === null
                      : condition.postingManifestHash !== undefined
                        ? condition.postingManifestHash ===
                          this.record.postingManifestHash
                        : false,
              ) ?? true;
            if (!runMatches) {
              return { count: 0 };
            }
            const configSnapshotMatches =
              input.where.AND?.every((condition) =>
                condition.OR.some((entry) =>
                  entry.configSnapshotId === null
                    ? this.record.configSnapshotId === null
                    : entry.configSnapshotId === this.record.configSnapshotId,
                ),
              ) ?? true;
            if (!configSnapshotMatches) {
              return { count: 0 };
            }
            if (input.data.status !== undefined) {
              this.record.status = input.data.status;
            }
            if (input.data.githubRunId !== undefined) {
              this.record.githubRunId = input.data.githubRunId;
            }
            if (input.data.githubRunAttempt !== undefined) {
              this.record.githubRunAttempt = input.data.githubRunAttempt;
            }
            if (input.data.configSnapshotId !== undefined) {
              this.record.configSnapshotId = input.data.configSnapshotId;
            }
            if (input.data.postingManifestHash !== undefined) {
              this.record.postingManifestHash = input.data.postingManifestHash;
            }
            if (input.data.version !== undefined) {
              this.record.version += input.data.version.increment;
            }
            return { count: 1 };
          },
        ),
      },
      conflictReviewPostingIntent: {
        create: vi.fn(
          async (input: {
            data: {
              attemptId: string;
              operationKind: string;
              operationFingerprint: string;
              manifestHash: string;
              bodyHash: string;
              createdAt: Date;
            };
          }) => {
            if (this.postingIntents.has(input.data.operationFingerprint)) {
              throw Object.assign(new Error("unique conflict"), {
                code: "P2002",
              });
            }
            const record = {
              id: `posting_intent_${this.postingIntents.size + 1}`,
              attemptId: input.data.attemptId,
              operationKind: input.data.operationKind,
              operationFingerprint: input.data.operationFingerprint,
              manifestHash: input.data.manifestHash,
              bodyHash: input.data.bodyHash,
              status: "pending" as const,
              githubExternalId: null,
              githubUrl: null,
              safeErrorCode: null,
              safeErrorSummary: null,
              completedAt: null,
            };
            this.postingIntents.set(input.data.operationFingerprint, record);
            return record;
          },
        ),
        findUnique: vi.fn(
          async (input: {
            where: {
              attemptId_operationKind_operationFingerprint: {
                attemptId: string;
                operationKind: string;
                operationFingerprint: string;
              };
            };
          }) => {
            const key =
              input.where.attemptId_operationKind_operationFingerprint
                .operationFingerprint;
            const record = this.postingIntents.get(key);
            if (
              !record ||
              record.attemptId !==
                input.where.attemptId_operationKind_operationFingerprint
                  .attemptId ||
              record.operationKind !==
                input.where.attemptId_operationKind_operationFingerprint
                  .operationKind
            ) {
              return null;
            }
            return record;
          },
        ),
        updateMany: vi.fn(
          async (input: {
            where: {
              id: string;
              attemptId: string;
              operationKind: string;
              operationFingerprint?: string;
              manifestHash: string;
              status: string;
            };
            data: Partial<{
              status: "pending" | "completed" | "failed" | "ambiguous";
              githubExternalId: string;
              githubUrl: string | null;
              bodyHash: string;
              completedAt: Date | null;
              safeErrorCode: string | null;
              safeErrorSummary: string | null;
            }>;
          }) => {
            const record = [...this.postingIntents.values()].find(
              (candidate) =>
                candidate.id === input.where.id &&
                candidate.attemptId === input.where.attemptId &&
                candidate.operationKind === input.where.operationKind &&
                candidate.manifestHash === input.where.manifestHash &&
                candidate.status === input.where.status &&
                (input.where.operationFingerprint === undefined ||
                  candidate.operationFingerprint ===
                    input.where.operationFingerprint),
            );
            if (!record) {
              return { count: 0 };
            }
            if (input.data.status !== undefined) {
              record.status = input.data.status;
            }
            if (input.data.githubExternalId !== undefined) {
              record.githubExternalId = input.data.githubExternalId;
            }
            if (input.data.githubUrl !== undefined) {
              record.githubUrl = input.data.githubUrl;
            }
            if (input.data.bodyHash !== undefined) {
              record.bodyHash = input.data.bodyHash;
            }
            if (input.data.completedAt !== undefined) {
              record.completedAt = input.data.completedAt;
            }
            if (input.data.safeErrorCode !== undefined) {
              record.safeErrorCode = input.data.safeErrorCode;
            }
            if (input.data.safeErrorSummary !== undefined) {
              record.safeErrorSummary = input.data.safeErrorSummary;
            }
            return { count: 1 };
          },
        ),
      },
    } as never;
  }
}

function statusMatches(
  expected: string | { in: readonly string[] },
  actual: string,
): boolean {
  return typeof expected === "string"
    ? expected === actual
    : expected.in.includes(actual);
}
