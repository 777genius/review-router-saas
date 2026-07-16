import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import {
  ReviewExecutionBatchCommitStatus,
  ReviewExecutionCheckpointClearStatus,
  ReviewExecutionCheckpointFinalizeStatus,
  ReviewExecutionCheckpointStartStatus,
  ReviewExecutionFindingSeverity,
  ReviewExecutionProviderResultStatus,
  reviewExecutionCheckpointTtlMs,
  commitReviewExecutionBatchResult,
  finalizeReviewExecutionCheckpoint,
  restoreReviewExecutionCheckpoint,
  startOrReplaceReviewExecutionCheckpoint,
} from "../index";
import { clearReviewExecutionCheckpoint } from "../application/use-cases/clear-review-execution-checkpoint";
import { PrismaReviewExecutionCheckpointRepository } from "../infrastructure/prisma/prisma-review-execution-checkpoint-repository";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase(
  "PrismaReviewExecutionCheckpointRepository real database",
  () => {
    let prisma: PrismaClient;
    let workspaceId: string;
    let repositoryId: string;

    const suffix = randomUUID().replaceAll("-", "");
    const now = new Date("2026-07-16T12:00:00.000Z");
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    const compatibilityKey = "c".repeat(64);
    const planHash = "d".repeat(64);
    const workKeys = ["1".repeat(64), "2".repeat(64)];

    beforeAll(async () => {
      prisma = createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 5 });
      const workspace = await prisma.workspace.create({
        data: {
          slug: `checkpoint-${suffix}`,
          name: "Checkpoint integration test",
          repositories: {
            create: {
              externalRepositoryId: `repo-${suffix}`,
              owner: "reviewrouter-test",
              name: `repo-${suffix}`,
              fullName: `reviewrouter-test/repo-${suffix}`,
              defaultBranch: "main",
              visibility: "private",
            },
          },
        },
        include: { repositories: true },
      });
      workspaceId = workspace.id;
      repositoryId = workspace.repositories[0]!.id;
    });

    afterAll(async () => {
      if (workspaceId) {
        await prisma.workspace.delete({ where: { id: workspaceId } });
      }
      await prisma?.$disconnect();
    });

    it("serializes concurrent CAS commits, resumes, finalizes, and clears", async () => {
      const checkpoints = new PrismaReviewExecutionCheckpointRepository(prisma);
      const scope = { workspaceId, repositoryId, pullRequestNumber: 240 };
      const started = await startOrReplaceReviewExecutionCheckpoint(
        {
          expectedVersion: 0,
          candidate: {
            ...scope,
            schemaVersion: 1,
            baseSha,
            headSha,
            compatibilityKey,
            planHash,
            plannedWorkKeys: workKeys,
            sourceRunId: "run-1",
            sourceRunAttempt: "1",
          },
        },
        { checkpoints, now },
      );
      expect(started.status).toBe(ReviewExecutionCheckpointStartStatus.Started);

      const commits = await Promise.all(
        workKeys.map((workKey, batchIndex) =>
          commitReviewExecutionBatchResult(
            {
              scope,
              expectedVersion: 1,
              headSha,
              planHash,
              candidate: batchCandidate(workKey, batchIndex),
            },
            { checkpoints, now: new Date(now.getTime() + batchIndex + 1) },
          ),
        ),
      );
      expect(commits.map((result) => result.status).sort()).toEqual(
        [
          ReviewExecutionBatchCommitStatus.Committed,
          ReviewExecutionBatchCommitStatus.Conflict,
        ].sort(),
      );

      const restored = await restoreReviewExecutionCheckpoint(
        { ...scope, baseSha, headSha, compatibilityKey, planHash },
        { checkpoints, now },
      );
      expect(restored.status).toBe("found");
      if (restored.status !== "found") throw new Error("checkpoint_not_found");
      expect(restored.batchResults).toHaveLength(1);

      const acceptedIndex = restored.batchResults[0]?.batchIndex;
      if (acceptedIndex === undefined)
        throw new Error("checkpoint_result_missing");
      const missingIndex = acceptedIndex === 0 ? 1 : 0;
      const resumed = await commitReviewExecutionBatchResult(
        {
          scope,
          expectedVersion: restored.expectedVersion,
          headSha,
          planHash,
          candidate: batchCandidate(workKeys[missingIndex]!, missingIndex),
        },
        { checkpoints, now: new Date(now.getTime() + 10) },
      );
      expect(resumed.status).toBe(ReviewExecutionBatchCommitStatus.Committed);
      if (resumed.status !== ReviewExecutionBatchCommitStatus.Committed) {
        throw new Error("checkpoint_resume_failed");
      }

      const finalized = await finalizeReviewExecutionCheckpoint(
        {
          scope,
          expectedVersion: resumed.checkpoint.version,
          headSha,
          planHash,
        },
        { checkpoints, now: new Date(now.getTime() + 20) },
      );
      expect(finalized.status).toBe(
        ReviewExecutionCheckpointFinalizeStatus.Finalized,
      );
      if (
        finalized.status !== ReviewExecutionCheckpointFinalizeStatus.Finalized
      ) {
        throw new Error("checkpoint_finalize_failed");
      }

      await expect(
        clearReviewExecutionCheckpoint(
          {
            scope,
            expectedVersion: finalized.checkpoint.version,
            headSha,
            planHash,
          },
          { checkpoints },
        ),
      ).resolves.toEqual({
        status: ReviewExecutionCheckpointClearStatus.Cleared,
      });
    });

    it("rejects expired and ABA batch commits after prune and recreate", async () => {
      const checkpoints = new PrismaReviewExecutionCheckpointRepository(prisma);
      const scope = { workspaceId, repositoryId, pullRequestNumber: 241 };
      const expiredAt = new Date(
        now.getTime() - reviewExecutionCheckpointTtlMs - 1,
      );
      await startOrReplaceReviewExecutionCheckpoint(
        {
          expectedVersion: 0,
          candidate: {
            ...scope,
            schemaVersion: 1,
            baseSha,
            headSha,
            compatibilityKey,
            planHash,
            plannedWorkKeys: [workKeys[0]!],
            sourceRunId: "expired-run",
            sourceRunAttempt: "1",
          },
        },
        { checkpoints, now: expiredAt },
      );

      await expect(
        commitReviewExecutionBatchResult(
          {
            scope,
            expectedVersion: 1,
            headSha,
            planHash,
            candidate: batchCandidate(workKeys[0]!, 0),
          },
          { checkpoints, now },
        ),
      ).resolves.toMatchObject({
        status: ReviewExecutionBatchCommitStatus.Conflict,
        currentVersion: 1,
      });

      expect(
        await checkpoints.pruneExpired({ expiredBefore: now, limit: 10 }),
      ).toBe(1);
      const replacementHeadSha = "e".repeat(40);
      const replacementPlanHash = "f".repeat(64);
      await startOrReplaceReviewExecutionCheckpoint(
        {
          expectedVersion: 0,
          candidate: {
            ...scope,
            schemaVersion: 1,
            baseSha,
            headSha: replacementHeadSha,
            compatibilityKey,
            planHash: replacementPlanHash,
            plannedWorkKeys: [workKeys[0]!],
            sourceRunId: "replacement-run",
            sourceRunAttempt: "1",
          },
        },
        { checkpoints, now },
      );

      await expect(
        commitReviewExecutionBatchResult(
          {
            scope,
            expectedVersion: 1,
            headSha,
            planHash,
            candidate: batchCandidate(workKeys[0]!, 0),
          },
          { checkpoints, now: new Date(now.getTime() + 1) },
        ),
      ).resolves.toMatchObject({
        status: ReviewExecutionBatchCommitStatus.Conflict,
        currentHeadSha: replacementHeadSha,
        currentPlanHash: replacementPlanHash,
      });
      await expect(checkpoints.find(scope)).resolves.toMatchObject({
        checkpoint: { headSha: replacementHeadSha, version: 1 },
        batchResults: [],
      });
    });

    function batchCandidate(workKey: string, batchIndex: number) {
      return {
        workKey,
        batchId: workKey,
        batchIndex,
        payload: {
          filePaths: [`src/batch-${batchIndex}.ts`],
          findings: [
            {
              file: `src/batch-${batchIndex}.ts`,
              line: 1,
              severity: ReviewExecutionFindingSeverity.Minor,
              title: `Batch ${batchIndex}`,
              message: "Verified by the real database integration test",
            },
          ],
          providerResults: [
            {
              name: "codex/oauth",
              status: ReviewExecutionProviderResultStatus.Success,
              durationSeconds: 0.01,
              lifecycleAssignedTargetIds: [],
              lifecycleRevalidations: [],
            },
          ],
        },
        sourceRunId: "run-1",
        sourceRunAttempt: "1",
      };
    }
  },
);
