import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clearReviewExecutionCheckpoint } from "../application/use-cases/clear-review-execution-checkpoint";
import { commitReviewExecutionBatchResult as commitReviewExecutionBatchResultUseCase } from "../application/use-cases/commit-review-execution-batch-result";
import { finalizeReviewExecutionCheckpoint } from "../application/use-cases/finalize-review-execution-checkpoint";
import { pruneExpiredReviewExecutionCheckpoints } from "../application/use-cases/prune-expired-review-execution-checkpoints";
import { restoreReviewExecutionCheckpoint } from "../application/use-cases/restore-review-execution-checkpoint";
import { startOrReplaceReviewExecutionCheckpoint } from "../application/use-cases/start-or-replace-review-execution-checkpoint";
import {
  ReviewExecutionBatchCommitStatus,
  ReviewExecutionCheckpointClearStatus,
  ReviewExecutionCheckpointFinalizeStatus,
  ReviewExecutionCheckpointRestoreStatus,
  ReviewExecutionCheckpointStartStatus,
  ReviewExecutionCheckpointState,
  ReviewExecutionFindingSeverity,
  ReviewExecutionLifecycleVerdict,
  ReviewExecutionProviderResultStatus,
  prepareReviewExecutionBatchResult,
  reviewExecutionCheckpointMaxBatchBytes,
  reviewExecutionCheckpointSchemaVersion,
  reviewExecutionCheckpointTtlMs,
  type ReviewExecutionBatchPayload,
  type ReviewExecutionBatchResultCandidate,
  type ReviewExecutionCheckpointCandidate,
  type ReviewExecutionCheckpointScope,
} from "../domain/review-execution-checkpoint";
import { InMemoryReviewExecutionCheckpointRepository } from "../infrastructure/memory/in-memory-review-execution-checkpoint-repository";

const now = new Date("2026-07-16T10:00:00.000Z");
const scope: ReviewExecutionCheckpointScope = {
  workspaceId: "workspace_1",
  repositoryId: "repository_1",
  pullRequestNumber: 240,
};
const baseSha = "b".repeat(40);
const headSha = "a".repeat(40);
const compatibilityKey = sha256("compatibility");
const planHash = sha256("plan");
const workKeys = [sha256("work-0"), sha256("work-1")];

function commitReviewExecutionBatchResult(
  input: Omit<
    Parameters<typeof commitReviewExecutionBatchResultUseCase>[0],
    "headSha" | "planHash"
  >,
  dependencies: Parameters<typeof commitReviewExecutionBatchResultUseCase>[1],
) {
  return commitReviewExecutionBatchResultUseCase(
    { ...input, headSha, planHash },
    dependencies,
  );
}

describe("review execution checkpoint domain", () => {
  it("starts and restores a scoped active checkpoint", async () => {
    const checkpoints = new InMemoryReviewExecutionCheckpointRepository();

    await expect(
      restoreReviewExecutionCheckpoint(restoreInput(), { checkpoints, now }),
    ).resolves.toEqual({
      status: ReviewExecutionCheckpointRestoreStatus.Missing,
      expectedVersion: 0,
    });
    await expect(
      startOrReplaceReviewExecutionCheckpoint(
        { expectedVersion: 0, candidate: checkpointCandidate() },
        { checkpoints, now },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionCheckpointStartStatus.Started,
      checkpoint: {
        version: 1,
        state: ReviewExecutionCheckpointState.Active,
        acceptedBytes: 0,
        expiresAt: new Date(now.getTime() + reviewExecutionCheckpointTtlMs),
      },
    });
    await expect(
      restoreReviewExecutionCheckpoint(restoreInput(), { checkpoints, now }),
    ).resolves.toMatchObject({
      status: ReviewExecutionCheckpointRestoreStatus.Found,
      expectedVersion: 1,
      checkpoint: { headSha, planHash },
      batchResults: [],
    });
  });

  it.each([
    ["expired", ReviewExecutionCheckpointRestoreStatus.Expired],
    ["base", ReviewExecutionCheckpointRestoreStatus.BaseChanged],
    ["head", ReviewExecutionCheckpointRestoreStatus.HeadChanged],
    [
      "compatibility",
      ReviewExecutionCheckpointRestoreStatus.CompatibilityChanged,
    ],
    ["plan", ReviewExecutionCheckpointRestoreStatus.PlanChanged],
  ] as const)("returns a strict %s restore status", async (change, status) => {
    const checkpoints = new InMemoryReviewExecutionCheckpointRepository();
    const startedAt =
      change === "expired"
        ? new Date(now.getTime() - reviewExecutionCheckpointTtlMs - 1)
        : now;
    await startOrReplaceReviewExecutionCheckpoint(
      { expectedVersion: 0, candidate: checkpointCandidate() },
      { checkpoints, now: startedAt },
    );
    const input = {
      ...restoreInput(),
      ...(change === "base" ? { baseSha: "c".repeat(40) } : {}),
      ...(change === "head" ? { headSha: "d".repeat(40) } : {}),
      ...(change === "compatibility"
        ? { compatibilityKey: sha256("new-compatibility") }
        : {}),
      ...(change === "plan" ? { planHash: sha256("new-plan") } : {}),
    };

    await expect(
      restoreReviewExecutionCheckpoint(input, { checkpoints, now }),
    ).resolves.toEqual({ status, expectedVersion: 1 });
  });

  it("commits immutable child results and restores them in planned order", async () => {
    const checkpoints = await startedRepository();

    await expect(
      commitReviewExecutionBatchResult(
        {
          scope,
          expectedVersion: 1,
          candidate: batchCandidate(1, payload("second")),
        },
        { checkpoints, now: plus(1_000) },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionBatchCommitStatus.Committed,
      checkpoint: { version: 2 },
      batchResult: { batchIndex: 1 },
    });
    await commitReviewExecutionBatchResult(
      {
        scope,
        expectedVersion: 2,
        candidate: batchCandidate(0, payload("first")),
      },
      { checkpoints, now: plus(2_000) },
    );

    const restored = await restoreReviewExecutionCheckpoint(restoreInput(), {
      checkpoints,
      now: plus(3_000),
    });
    expect(restored).toMatchObject({
      status: ReviewExecutionCheckpointRestoreStatus.Found,
      expectedVersion: 3,
      checkpoint: { acceptedBytes: expect.any(Number) },
    });
    if (restored.status !== ReviewExecutionCheckpointRestoreStatus.Found) {
      throw new Error("expected checkpoint to be found");
    }
    expect(restored.batchResults.map((result) => result.workKey)).toEqual(
      workKeys,
    );
    expect(
      restored.batchResults.map((result) => result.payload.findings[0]?.title),
    ).toEqual(["first", "second"]);
  });

  it("rejects finalization after expiry and replaces the stale root through CAS", async () => {
    const checkpoints = new InMemoryReviewExecutionCheckpointRepository();
    const startedAt = new Date(
      now.getTime() - reviewExecutionCheckpointTtlMs - 100,
    );
    const candidate = checkpointCandidate({
      plannedWorkKeys: [workKeys[0]!],
    });
    await startOrReplaceReviewExecutionCheckpoint(
      { expectedVersion: 0, candidate },
      { checkpoints, now: startedAt },
    );
    await commitReviewExecutionBatchResultUseCase(
      {
        scope,
        expectedVersion: 1,
        headSha,
        planHash,
        candidate: batchCandidate(0, payload("expired")),
      },
      { checkpoints, now: new Date(startedAt.getTime() + 1) },
    );

    await expect(
      finalizeReviewExecutionCheckpoint(
        { scope, expectedVersion: 2, headSha, planHash },
        { checkpoints, now },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionCheckpointFinalizeStatus.Conflict,
      currentVersion: 2,
    });
    await expect(
      startOrReplaceReviewExecutionCheckpoint(
        { expectedVersion: 2, candidate },
        { checkpoints, now },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionCheckpointStartStatus.Replaced,
      checkpoint: { version: 3, acceptedBytes: 0 },
    });
  });

  it("makes same-work/hash retries idempotent and conflicting hashes immutable", async () => {
    const checkpoints = await startedRepository();
    const candidate = batchCandidate(0, payload("first"));
    const committed = await commitReviewExecutionBatchResult(
      { scope, expectedVersion: 1, candidate },
      { checkpoints, now: plus(1_000) },
    );
    expect(committed.status).toBe(ReviewExecutionBatchCommitStatus.Committed);

    await expect(
      commitReviewExecutionBatchResult(
        { scope, expectedVersion: 1, candidate },
        { checkpoints, now: plus(2_000) },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionBatchCommitStatus.Idempotent,
      checkpoint: { version: 2 },
    });
    await expect(
      commitReviewExecutionBatchResult(
        {
          scope,
          expectedVersion: 2,
          candidate: batchCandidate(0, payload("changed")),
        },
        { checkpoints, now: plus(3_000) },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionBatchCommitStatus.Conflict,
      currentVersion: 2,
      currentPayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("rejects stale, unplanned, and misindexed child commits", async () => {
    const checkpoints = await startedRepository();
    await commitReviewExecutionBatchResult(
      {
        scope,
        expectedVersion: 1,
        candidate: batchCandidate(0, payload("first")),
      },
      { checkpoints, now: plus(1_000) },
    );

    await expect(
      commitReviewExecutionBatchResult(
        {
          scope,
          expectedVersion: 1,
          candidate: batchCandidate(1, payload("stale")),
        },
        { checkpoints, now: plus(2_000) },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionBatchCommitStatus.Conflict,
      currentVersion: 2,
    });
    await expect(
      commitReviewExecutionBatchResult(
        {
          scope,
          expectedVersion: 2,
          candidate: {
            ...batchCandidate(1, payload("wrong-index")),
            batchIndex: 0,
          },
        },
        { checkpoints, now: plus(3_000) },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionBatchCommitStatus.UnplannedWork,
    });
    await expect(
      commitReviewExecutionBatchResult(
        {
          scope,
          expectedVersion: 2,
          candidate: {
            ...batchCandidate(1, payload("unknown")),
            workKey: sha256("not-planned"),
          },
        },
        { checkpoints, now: plus(4_000) },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionBatchCommitStatus.UnplannedWork,
    });
  });

  it("replaces only active aggregates through CAS and drops prior children", async () => {
    const checkpoints = await startedRepository();
    await commitReviewExecutionBatchResult(
      {
        scope,
        expectedVersion: 1,
        candidate: batchCandidate(0, payload("old")),
      },
      { checkpoints, now: plus(1_000) },
    );

    await expect(
      startOrReplaceReviewExecutionCheckpoint(
        {
          expectedVersion: 2,
          candidate: checkpointCandidate({
            headSha: "d".repeat(40),
            planHash: sha256("replacement-plan"),
            plannedWorkKeys: [sha256("replacement-work")],
          }),
        },
        { checkpoints, now: plus(2_000) },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionCheckpointStartStatus.Replaced,
      checkpoint: { version: 3, acceptedBytes: 0 },
    });
    const aggregate = await checkpoints.find(scope);
    expect(aggregate?.batchResults).toEqual([]);

    await expect(
      startOrReplaceReviewExecutionCheckpoint(
        {
          expectedVersion: 2,
          candidate: checkpointCandidate({ baseSha: "e".repeat(40) }),
        },
        { checkpoints, now: plus(3_000) },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionCheckpointStartStatus.Conflict,
      currentVersion: 3,
    });
  });

  it("redacts secrets before child hashing and rejects retention-only fields", () => {
    const secret = `github_pat_${"x".repeat(32)}`;
    const result = prepareReviewExecutionBatchResult(
      batchCandidate(
        0,
        payload("secret", {
          findings: [
            {
              file: "src/index.ts",
              line: 1,
              severity: ReviewExecutionFindingSeverity.Major,
              title: `title ${secret}`,
              message: `authorization: Bearer ${secret}`,
            },
          ],
          providerResults: [
            {
              name: "codex",
              status: ReviewExecutionProviderResultStatus.Error,
              durationSeconds: 0.01,
              errorMessage: `access_token=${secret}`,
              actualModel: "gpt-test",
              aiLikelihood: 0.8,
              lifecycleAssignedTargetIds: ["target_1"],
              lifecycleRevalidations: [
                {
                  targetId: "target_1",
                  fingerprint: "fingerprint_1",
                  verdict: ReviewExecutionLifecycleVerdict.Uncertain,
                  evidence: [
                    {
                      path: "src/index.ts",
                      reason: `client_secret=${secret}`,
                    },
                  ],
                  rationale: `token=${secret}`,
                },
              ],
            },
          ],
        }),
      ),
      { completedAt: now },
    );
    expect(JSON.stringify(result.payload)).not.toContain(secret);
    expect(result.payloadHash).toBe(sha256(JSON.stringify(result.payload)));

    for (const forbidden of [
      "suggestion",
      "rawContent",
      "diff",
      "prompt",
      "token",
      "source",
    ]) {
      expect(() =>
        prepareReviewExecutionBatchResult(
          batchCandidate(0, {
            ...payload("forbidden"),
            findings: [
              {
                ...payload("forbidden").findings[0],
                [forbidden]: "must-not-persist",
              },
            ],
          } as unknown as ReviewExecutionBatchPayload),
          { completedAt: now },
        ),
      ).toThrow("review_execution_checkpoint_finding_fields_invalid");
    }
  });

  it("rejects a child payload above 128 KiB", () => {
    const largePayload: ReviewExecutionBatchPayload = {
      filePaths: Array.from(
        { length: 200 },
        (_, index) => `src/${index}/${"x".repeat(700)}`,
      ),
      findings: [],
      providerResults: [],
    };
    expect(() =>
      prepareReviewExecutionBatchResult(batchCandidate(0, largePayload), {
        completedAt: now,
      }),
    ).toThrow("review_execution_checkpoint_batch_payload_too_large");
  });

  it("enforces the aggregate finding budget transactionally", async () => {
    const keys = [sha256("finding-heavy"), sha256("one-more")];
    const checkpoints = new InMemoryReviewExecutionCheckpointRepository();
    await startOrReplaceReviewExecutionCheckpoint(
      {
        expectedVersion: 0,
        candidate: checkpointCandidate({ plannedWorkKeys: keys }),
      },
      { checkpoints, now },
    );
    const findings = Array.from({ length: 1_000 }, (_, index) => ({
      file: `f${index}`,
      line: 1,
      severity: ReviewExecutionFindingSeverity.Minor,
      title: "t",
      message: "m",
    }));
    const first = {
      ...batchCandidate(0, {
        filePaths: [],
        findings,
        providerResults: [],
      }),
      workKey: keys[0]!,
    };
    const prepared = prepareReviewExecutionBatchResult(first, {
      completedAt: now,
    });
    expect(prepared.byteCount).toBeLessThanOrEqual(
      reviewExecutionCheckpointMaxBatchBytes,
    );
    await commitReviewExecutionBatchResult(
      { scope, expectedVersion: 1, candidate: first },
      { checkpoints, now: plus(1_000) },
    );

    await expect(
      commitReviewExecutionBatchResult(
        {
          scope,
          expectedVersion: 2,
          candidate: {
            ...batchCandidate(1, payload("extra")),
            workKey: keys[1]!,
          },
        },
        { checkpoints, now: plus(2_000) },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionBatchCommitStatus.BudgetExceeded,
      acceptedFindings: 1_000,
    });
  });

  it("finalizes only complete plans and clears only exact finalized roots", async () => {
    const checkpoints = await startedRepository();
    await commitReviewExecutionBatchResult(
      {
        scope,
        expectedVersion: 1,
        candidate: batchCandidate(0, payload("first")),
      },
      { checkpoints, now: plus(1_000) },
    );

    await expect(
      finalizeReviewExecutionCheckpoint(
        { scope, expectedVersion: 2, headSha, planHash },
        { checkpoints, now: plus(2_000) },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionCheckpointFinalizeStatus.Incomplete,
      missingWorkKeys: [workKeys[1]],
    });
    await expect(
      clearReviewExecutionCheckpoint(
        { scope, expectedVersion: 2, headSha, planHash },
        { checkpoints },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionCheckpointClearStatus.Conflict,
      currentState: ReviewExecutionCheckpointState.Active,
    });

    await commitReviewExecutionBatchResult(
      {
        scope,
        expectedVersion: 2,
        candidate: batchCandidate(1, payload("second")),
      },
      { checkpoints, now: plus(3_000) },
    );
    await expect(
      finalizeReviewExecutionCheckpoint(
        { scope, expectedVersion: 3, headSha, planHash },
        { checkpoints, now: plus(4_000) },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionCheckpointFinalizeStatus.Finalized,
      checkpoint: {
        version: 4,
        state: ReviewExecutionCheckpointState.Finalized,
      },
    });
    await expect(
      finalizeReviewExecutionCheckpoint(
        { scope, expectedVersion: 3, headSha, planHash },
        { checkpoints, now: plus(5_000) },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionCheckpointFinalizeStatus.Idempotent,
      checkpoint: { version: 4 },
    });
    await expect(
      startOrReplaceReviewExecutionCheckpoint(
        { expectedVersion: 4, candidate: checkpointCandidate() },
        { checkpoints, now: plus(5_000) },
      ),
    ).resolves.toMatchObject({
      status: ReviewExecutionCheckpointStartStatus.Finalized,
    });
    await expect(
      clearReviewExecutionCheckpoint(
        { scope, expectedVersion: 4, headSha, planHash },
        { checkpoints },
      ),
    ).resolves.toEqual({
      status: ReviewExecutionCheckpointClearStatus.Cleared,
    });
    await expect(
      clearReviewExecutionCheckpoint(
        { scope, expectedVersion: 4, headSha, planHash },
        { checkpoints },
      ),
    ).resolves.toEqual({
      status: ReviewExecutionCheckpointClearStatus.Missing,
    });
  });

  it("prunes expired roots in bounded batches", async () => {
    const checkpoints = new InMemoryReviewExecutionCheckpointRepository();
    for (let index = 1; index <= 3; index += 1) {
      await startOrReplaceReviewExecutionCheckpoint(
        {
          expectedVersion: 0,
          candidate: checkpointCandidate({
            pullRequestNumber: 240 + index,
          }),
        },
        {
          checkpoints,
          now: new Date(now.getTime() - reviewExecutionCheckpointTtlMs - index),
        },
      );
    }

    await expect(
      pruneExpiredReviewExecutionCheckpoints(
        { expiredBefore: now, limit: 2 },
        { checkpoints },
      ),
    ).resolves.toEqual({ deleted: 2 });
    await expect(
      pruneExpiredReviewExecutionCheckpoints(
        { expiredBefore: now, limit: 0 },
        { checkpoints },
      ),
    ).rejects.toThrow("review_execution_checkpoint_prune_limit_invalid");
  });
});

function checkpointCandidate(
  overrides: Partial<ReviewExecutionCheckpointCandidate> = {},
): ReviewExecutionCheckpointCandidate {
  return {
    ...scope,
    schemaVersion: reviewExecutionCheckpointSchemaVersion,
    baseSha,
    headSha,
    compatibilityKey,
    planHash,
    plannedWorkKeys: workKeys,
    sourceRunId: "run_100",
    sourceRunAttempt: "1",
    ...overrides,
  };
}

function restoreInput() {
  return {
    ...scope,
    baseSha,
    headSha,
    compatibilityKey,
    planHash,
  };
}

function batchCandidate(
  batchIndex: number,
  batchPayload: ReviewExecutionBatchPayload,
): ReviewExecutionBatchResultCandidate {
  return {
    workKey: workKeys[batchIndex] ?? sha256(`work-${batchIndex}`),
    batchId: sha256(`batch-${batchIndex}`),
    batchIndex,
    payload: batchPayload,
    sourceRunId: "run_100",
    sourceRunAttempt: "1",
  };
}

function payload(
  title: string,
  overrides: Partial<ReviewExecutionBatchPayload> = {},
): ReviewExecutionBatchPayload {
  return {
    filePaths: ["src/index.ts"],
    findings: [
      {
        file: "src/index.ts",
        line: 12,
        severity: ReviewExecutionFindingSeverity.Major,
        title,
        message: "Persist state before returning.",
        confidence: 0.9,
      },
    ],
    providerResults: [
      {
        name: "codex",
        status: ReviewExecutionProviderResultStatus.Success,
        durationSeconds: 0.15,
        actualModel: "gpt-test",
        aiLikelihood: 0.9,
        usage: {
          promptTokens: 120,
          completionTokens: 30,
          totalTokens: 151,
        },
        lifecycleAssignedTargetIds: [],
        lifecycleRevalidations: [],
      },
    ],
    ...overrides,
  };
}

async function startedRepository() {
  const checkpoints = new InMemoryReviewExecutionCheckpointRepository();
  await startOrReplaceReviewExecutionCheckpoint(
    { expectedVersion: 0, candidate: checkpointCandidate() },
    { checkpoints, now },
  );
  return checkpoints;
}

function plus(milliseconds: number): Date {
  return new Date(now.getTime() + milliseconds);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
