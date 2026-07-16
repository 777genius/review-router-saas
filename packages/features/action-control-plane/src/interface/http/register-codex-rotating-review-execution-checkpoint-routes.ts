import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
  reviewExecutionCheckpointMaxFindings,
  reviewExecutionCheckpointMaxPlannedWorkKeys,
  reviewExecutionCheckpointSchemaVersion,
  type ReviewExecutionBatchPayload,
} from "@reviewrouter/features-review-execution-checkpoints";
import { z } from "zod";
import {
  clearCodexRotatingReviewExecutionCheckpoint,
  type ClearCodexRotatingReviewExecutionCheckpointDependencies,
} from "../../application/use-cases/clear-codex-rotating-review-execution-checkpoint.js";
import {
  commitCodexRotatingReviewExecutionBatchResult,
  type CommitCodexRotatingReviewExecutionBatchResultDependencies,
} from "../../application/use-cases/commit-codex-rotating-review-execution-batch-result.js";
import {
  finalizeCodexRotatingReviewExecutionCheckpoint,
  type FinalizeCodexRotatingReviewExecutionCheckpointDependencies,
} from "../../application/use-cases/finalize-codex-rotating-review-execution-checkpoint.js";
import {
  restoreCodexRotatingReviewExecutionCheckpoint,
  type RestoreCodexRotatingReviewExecutionCheckpointDependencies,
} from "../../application/use-cases/restore-codex-rotating-review-execution-checkpoint.js";
import {
  startCodexRotatingReviewExecutionCheckpoint,
  type StartCodexRotatingReviewExecutionCheckpointDependencies,
} from "../../application/use-cases/start-codex-rotating-review-execution-checkpoint.js";

export type RegisterCodexRotatingReviewExecutionCheckpointRoutesDependencies =
  Partial<RestoreCodexRotatingReviewExecutionCheckpointDependencies> &
    Partial<StartCodexRotatingReviewExecutionCheckpointDependencies> &
    Partial<CommitCodexRotatingReviewExecutionBatchResultDependencies> &
    Partial<FinalizeCodexRotatingReviewExecutionCheckpointDependencies> &
    Partial<ClearCodexRotatingReviewExecutionCheckpointDependencies> & {
      readonly controlPlaneEnabled?: boolean;
    };

type ActionErrorResponder = {
  readonly sendError: (reply: FastifyReply, error: unknown) => unknown;
  readonly sendErrorCode: (
    reply: FastifyReply,
    code: string,
    statusCode: number,
  ) => unknown;
};

const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const uniqueSha256ArraySchema = z
  .array(sha256Schema)
  .max(reviewExecutionCheckpointMaxPlannedWorkKeys)
  .refine((items) => new Set(items).size === items.length);

const checkpointLeaseBodySchema = z
  .object({
    protocolVersion: z.literal(1),
    leaseId: z.string().min(8).max(160),
    providerInstanceId: z.string().min(8).max(160),
  })
  .strict();

const checkpointScopeBodySchema = checkpointLeaseBodySchema
  .extend({
    pullRequestNumber: z.number().int().positive(),
  })
  .strict();

const checkpointHeadAndPlanBodySchema = checkpointScopeBodySchema
  .extend({
    expectedVersion: z.number().int().nonnegative(),
    headSha: gitShaSchema,
    planHash: sha256Schema,
  })
  .strict();

const restoreBodySchema = checkpointScopeBodySchema
  .extend({
    baseSha: gitShaSchema,
    headSha: gitShaSchema,
    compatibilityKey: sha256Schema,
    planHash: sha256Schema,
  })
  .strict();

const startBodySchema = checkpointScopeBodySchema
  .extend({
    expectedVersion: z.number().int().nonnegative(),
    schemaVersion: z
      .literal(reviewExecutionCheckpointSchemaVersion)
      .default(reviewExecutionCheckpointSchemaVersion),
    baseSha: gitShaSchema,
    headSha: gitShaSchema,
    compatibilityKey: sha256Schema,
    planHash: sha256Schema,
    plannedWorkKeys: uniqueSha256ArraySchema,
  })
  .strict();

const lifecycleEvidenceSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    reason: z.string().min(1).max(4_000),
  })
  .strict();

const lifecycleRevalidationSchema = z
  .object({
    targetId: z.string().min(1).max(500),
    fingerprint: z.string().min(1).max(500).optional(),
    verdict: z.nativeEnum(ReviewExecutionLifecycleVerdict),
    confidence: z.number().min(0).max(1).optional(),
    evidence: z.array(lifecycleEvidenceSchema).max(20).optional(),
    rationale: z.string().min(1).max(4_000).optional(),
  })
  .strict();

const providerResultSchema = z
  .object({
    name: z.string().min(1).max(500),
    status: z.enum(["success", "error", "timeout", "rate_limited"]),
    durationMs: z
      .number()
      .min(0)
      .max(24 * 60 * 60 * 1000),
    errorMessage: z.string().min(1).max(2_000).optional(),
    actualModel: z.string().min(1).max(500).optional(),
    aiLikelihood: z.number().min(0).max(1).optional(),
    usage: z
      .object({
        promptTokens: z.number().int().min(0).max(1_000_000_000),
        completionTokens: z.number().int().min(0).max(1_000_000_000),
        totalTokens: z.number().int().min(0).max(1_000_000_000),
      })
      .strict()
      .optional(),
    lifecycleAssignedTargetIds: z
      .array(z.string().min(1).max(500))
      .max(200)
      .refine((items) => new Set(items).size === items.length)
      .optional(),
    lifecycleRevalidations: z
      .array(lifecycleRevalidationSchema)
      .max(200)
      .optional(),
  })
  .strict();

const findingSchema = z
  .object({
    file: z.string().min(1).max(4_096),
    startLine: z.number().int().positive().optional(),
    line: z.number().int().positive(),
    endLine: z.number().int().positive().optional(),
    severity: z.nativeEnum(ReviewExecutionFindingSeverity),
    title: z.string().min(1).max(1_000),
    message: z.string().min(1).max(20_000),
    provider: z.string().min(1).max(500).optional(),
    providers: z.array(z.string().min(1).max(500)).max(50).optional(),
    actualModel: z.string().min(1).max(500).optional(),
    providerVoteKeys: z.array(z.string().min(1).max(500)).max(100).optional(),
    providerPoolSize: z.number().int().positive().optional(),
    confidence: z.number().min(0).max(1).optional(),
    category: z.string().min(1).max(500).optional(),
    hasConsensus: z.boolean().optional(),
  })
  .strict();

const batchPayloadSchema = z
  .object({
    filePaths: z
      .array(z.string().min(1).max(4_096))
      .max(200)
      .refine((items) => new Set(items).size === items.length),
    findings: z.array(findingSchema).max(reviewExecutionCheckpointMaxFindings),
    providerResults: z.array(providerResultSchema).max(50),
  })
  .strict();

const batchResultBodySchema = checkpointScopeBodySchema
  .extend({
    expectedVersion: z.number().int().nonnegative(),
    headSha: gitShaSchema,
    planHash: sha256Schema,
    workKey: sha256Schema,
    batchId: sha256Schema,
    batchIndex: z.number().int().nonnegative(),
    payload: batchPayloadSchema,
  })
  .strict();

const restoreResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.literal("found"),
      expectedVersion: z.number().int().positive(),
      checkpoint: z
        .object({
          version: z.number().int().positive(),
          baseSha: gitShaSchema,
          headSha: gitShaSchema,
          compatibilityKey: sha256Schema,
          planHash: sha256Schema,
          plannedWorkKeys: uniqueSha256ArraySchema,
          acceptedResults: z
            .array(
              z
                .object({
                  workKey: sha256Schema,
                  payload: batchPayloadSchema,
                })
                .strict(),
            )
            .max(reviewExecutionCheckpointMaxPlannedWorkKeys),
          finalized: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.literal("missing"),
      expectedVersion: z.number().int().nonnegative(),
    })
    .strict(),
]);

const startResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.enum(["started", "replaced", "idempotent"]),
      version: z.number().int().positive(),
      headSha: gitShaSchema,
      planHash: sha256Schema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.literal("conflict"),
      currentVersion: z.number().int().nonnegative(),
    })
    .strict(),
]);

const batchResultResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.enum(["accepted", "idempotent"]),
      version: z.number().int().positive(),
      headSha: gitShaSchema,
      planHash: sha256Schema,
      workKey: sha256Schema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.literal("conflict"),
      currentVersion: z.number().int().nonnegative(),
    })
    .strict(),
]);

const finalizeResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.enum(["finalized", "idempotent"]),
      version: z.number().int().positive(),
      headSha: gitShaSchema,
      planHash: sha256Schema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.literal("conflict"),
      currentVersion: z.number().int().nonnegative(),
    })
    .strict(),
]);

const clearResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.enum(["cleared", "missing"]),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.literal("conflict"),
      currentVersion: z.number().int().nonnegative(),
    })
    .strict(),
]);

export function registerCodexRotatingReviewExecutionCheckpointRoutes(
  app: FastifyInstance,
  dependencies: RegisterCodexRotatingReviewExecutionCheckpointRoutesDependencies,
  errors: ActionErrorResponder,
): void {
  const createHandler = <Body, Result>(
    schema: z.ZodType<Body>,
    execute: (body: Body) => Promise<Result>,
    serialize: (result: Result) => unknown,
  ) => {
    return async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<unknown> => {
      if (dependencies.controlPlaneEnabled === false) {
        return errors.sendErrorCode(
          reply,
          "action_control_plane_disabled",
          503,
        );
      }
      if (
        !dependencies.codexRotatingReviewExecutionCheckpointAccess ||
        !dependencies.reviewExecutionCheckpoints ||
        !dependencies.clock
      ) {
        return errors.sendErrorCode(
          reply,
          "review_execution_checkpoint_unavailable",
          503,
        );
      }
      try {
        const body = schema.parse(request.body);
        return reply.send(serialize(await execute(body)));
      } catch (error) {
        return errors.sendError(reply, error);
      }
    };
  };

  app.post(
    "/api/action/v1/codex-oauth/review-execution-checkpoint/restore",
    { bodyLimit: 8 * 1024 },
    createHandler(
      restoreBodySchema,
      (body) =>
        restoreCodexRotatingReviewExecutionCheckpoint(
          body,
          dependencies as RestoreCodexRotatingReviewExecutionCheckpointDependencies,
        ),
      serializeRestoreResult,
    ),
  );
  app.post(
    "/api/action/v1/codex-oauth/review-execution-checkpoint/start",
    { bodyLimit: 32 * 1024 },
    createHandler(
      startBodySchema,
      (body) =>
        startCodexRotatingReviewExecutionCheckpoint(
          {
            leaseId: body.leaseId,
            providerInstanceId: body.providerInstanceId,
            expectedVersion: body.expectedVersion,
            candidate: {
              pullRequestNumber: body.pullRequestNumber,
              schemaVersion: body.schemaVersion,
              baseSha: body.baseSha,
              headSha: body.headSha,
              compatibilityKey: body.compatibilityKey,
              planHash: body.planHash,
              plannedWorkKeys: body.plannedWorkKeys,
            },
          },
          dependencies as StartCodexRotatingReviewExecutionCheckpointDependencies,
        ),
      serializeStartResult,
    ),
  );
  app.post(
    "/api/action/v1/codex-oauth/review-execution-checkpoint/batch-result",
    { bodyLimit: 160 * 1024 },
    createHandler(
      batchResultBodySchema,
      (body) =>
        commitCodexRotatingReviewExecutionBatchResult(
          {
            leaseId: body.leaseId,
            providerInstanceId: body.providerInstanceId,
            pullRequestNumber: body.pullRequestNumber,
            expectedVersion: body.expectedVersion,
            headSha: body.headSha,
            planHash: body.planHash,
            candidate: {
              workKey: body.workKey,
              batchId: body.batchId,
              batchIndex: body.batchIndex,
              payload: toDomainBatchPayload(body.payload),
            },
          },
          dependencies as CommitCodexRotatingReviewExecutionBatchResultDependencies,
        ),
      serializeBatchResult,
    ),
  );
  app.post(
    "/api/action/v1/codex-oauth/review-execution-checkpoint/finalize",
    { bodyLimit: 8 * 1024 },
    createHandler(
      checkpointHeadAndPlanBodySchema,
      (body) =>
        finalizeCodexRotatingReviewExecutionCheckpoint(
          body,
          dependencies as FinalizeCodexRotatingReviewExecutionCheckpointDependencies,
        ),
      serializeFinalizeResult,
    ),
  );
  app.post(
    "/api/action/v1/codex-oauth/review-execution-checkpoint/clear",
    { bodyLimit: 8 * 1024 },
    createHandler(
      checkpointHeadAndPlanBodySchema,
      (body) =>
        clearCodexRotatingReviewExecutionCheckpoint(
          body,
          dependencies as ClearCodexRotatingReviewExecutionCheckpointDependencies,
        ),
      serializeClearResult,
    ),
  );
}

function serializeRestoreResult(
  result: Awaited<
    ReturnType<typeof restoreCodexRotatingReviewExecutionCheckpoint>
  >,
) {
  if (result.status !== ReviewExecutionCheckpointRestoreStatus.Found) {
    return restoreResponseSchema.parse({
      protocolVersion: 1 as const,
      status: "missing" as const,
      expectedVersion: result.expectedVersion,
    });
  }
  return restoreResponseSchema.parse({
    protocolVersion: 1 as const,
    status: result.status,
    expectedVersion: result.expectedVersion,
    checkpoint: {
      version: result.checkpoint.version,
      baseSha: result.checkpoint.baseSha,
      headSha: result.checkpoint.headSha,
      compatibilityKey: result.checkpoint.compatibilityKey,
      planHash: result.checkpoint.planHash,
      plannedWorkKeys: result.checkpoint.plannedWorkKeys,
      acceptedResults: result.batchResults.map((batchResult) => ({
        workKey: batchResult.workKey,
        payload: toActionBatchPayload(batchResult.payload),
      })),
      finalized:
        result.checkpoint.state === ReviewExecutionCheckpointState.Finalized,
    },
  });
}

function serializeStartResult(
  result: Awaited<
    ReturnType<typeof startCodexRotatingReviewExecutionCheckpoint>
  >,
) {
  switch (result.status) {
    case ReviewExecutionCheckpointStartStatus.Started:
    case ReviewExecutionCheckpointStartStatus.Replaced:
    case ReviewExecutionCheckpointStartStatus.Idempotent:
      return startResponseSchema.parse({
        protocolVersion: 1 as const,
        status: result.status,
        version: result.checkpoint.version,
        headSha: result.checkpoint.headSha,
        planHash: result.checkpoint.planHash,
      });
    case ReviewExecutionCheckpointStartStatus.Conflict:
      return startResponseSchema.parse({
        protocolVersion: 1 as const,
        status: result.status,
        currentVersion: result.currentVersion,
      });
    case ReviewExecutionCheckpointStartStatus.Finalized:
      return startResponseSchema.parse({
        protocolVersion: 1 as const,
        status: "conflict" as const,
        currentVersion: result.checkpoint.version,
      });
  }
}

function serializeBatchResult(
  result: Awaited<
    ReturnType<typeof commitCodexRotatingReviewExecutionBatchResult>
  >,
) {
  switch (result.status) {
    case ReviewExecutionBatchCommitStatus.Committed:
    case ReviewExecutionBatchCommitStatus.Idempotent:
      return batchResultResponseSchema.parse({
        protocolVersion: 1 as const,
        status:
          result.status === ReviewExecutionBatchCommitStatus.Committed
            ? ("accepted" as const)
            : result.status,
        version: result.checkpoint.version,
        headSha: result.checkpoint.headSha,
        planHash: result.checkpoint.planHash,
        workKey: result.batchResult.workKey,
      });
    case ReviewExecutionBatchCommitStatus.Conflict:
      return batchResultResponseSchema.parse({
        protocolVersion: 1 as const,
        status: result.status,
        currentVersion: result.currentVersion,
      });
    case ReviewExecutionBatchCommitStatus.Missing:
    case ReviewExecutionBatchCommitStatus.Corrupted:
      return batchResultResponseSchema.parse({
        protocolVersion: 1 as const,
        status: "conflict" as const,
        currentVersion: result.currentVersion,
      });
    case ReviewExecutionBatchCommitStatus.Finalized:
    case ReviewExecutionBatchCommitStatus.UnplannedWork:
    case ReviewExecutionBatchCommitStatus.BudgetExceeded:
      return batchResultResponseSchema.parse({
        protocolVersion: 1 as const,
        status: "conflict" as const,
        currentVersion: result.checkpoint.version,
      });
  }
}

function serializeFinalizeResult(
  result: Awaited<
    ReturnType<typeof finalizeCodexRotatingReviewExecutionCheckpoint>
  >,
) {
  switch (result.status) {
    case ReviewExecutionCheckpointFinalizeStatus.Finalized:
    case ReviewExecutionCheckpointFinalizeStatus.Idempotent:
      return finalizeResponseSchema.parse({
        protocolVersion: 1 as const,
        status: result.status,
        version: result.checkpoint.version,
        headSha: result.checkpoint.headSha,
        planHash: result.checkpoint.planHash,
      });
    case ReviewExecutionCheckpointFinalizeStatus.Conflict:
      return finalizeResponseSchema.parse({
        protocolVersion: 1 as const,
        status: result.status,
        currentVersion: result.currentVersion,
      });
    case ReviewExecutionCheckpointFinalizeStatus.Missing:
    case ReviewExecutionCheckpointFinalizeStatus.Corrupted:
      return finalizeResponseSchema.parse({
        protocolVersion: 1 as const,
        status: "conflict" as const,
        currentVersion: result.currentVersion,
      });
    case ReviewExecutionCheckpointFinalizeStatus.Incomplete:
      return finalizeResponseSchema.parse({
        protocolVersion: 1 as const,
        status: "conflict" as const,
        currentVersion: result.checkpoint.version,
      });
  }
}

function serializeClearResult(
  result: Awaited<
    ReturnType<typeof clearCodexRotatingReviewExecutionCheckpoint>
  >,
) {
  switch (result.status) {
    case ReviewExecutionCheckpointClearStatus.Cleared:
    case ReviewExecutionCheckpointClearStatus.Missing:
      return clearResponseSchema.parse({
        protocolVersion: 1 as const,
        status: result.status,
      });
    case ReviewExecutionCheckpointClearStatus.Conflict:
      return clearResponseSchema.parse({
        protocolVersion: 1 as const,
        status: result.status,
        currentVersion: result.currentVersion,
      });
  }
}

type ActionBatchPayload = z.infer<typeof batchPayloadSchema>;
type ActionProviderResultStatus =
  ActionBatchPayload["providerResults"][number]["status"];

function toDomainBatchPayload(
  payload: ActionBatchPayload,
): ReviewExecutionBatchPayload {
  return {
    filePaths: payload.filePaths,
    findings: payload.findings,
    providerResults: payload.providerResults.map((providerResult) => ({
      name: providerResult.name,
      status: toDomainProviderResultStatus(providerResult.status),
      durationSeconds: providerResult.durationMs / 1000,
      ...(providerResult.errorMessage !== undefined
        ? { errorMessage: providerResult.errorMessage }
        : {}),
      ...(providerResult.actualModel !== undefined
        ? { actualModel: providerResult.actualModel }
        : {}),
      ...(providerResult.aiLikelihood !== undefined
        ? { aiLikelihood: providerResult.aiLikelihood }
        : {}),
      ...(providerResult.usage !== undefined
        ? { usage: providerResult.usage }
        : {}),
      lifecycleAssignedTargetIds:
        providerResult.lifecycleAssignedTargetIds ?? [],
      lifecycleRevalidations: (providerResult.lifecycleRevalidations ?? []).map(
        (revalidation) => ({
          targetId: revalidation.targetId,
          ...(revalidation.fingerprint !== undefined
            ? { fingerprint: revalidation.fingerprint }
            : {}),
          verdict: revalidation.verdict,
          ...(revalidation.confidence !== undefined
            ? { confidence: revalidation.confidence }
            : {}),
          evidence: (revalidation.evidence ?? []).map((evidence) => ({
            path: evidence.path,
            ...(evidence.startLine !== undefined
              ? { startLine: evidence.startLine }
              : {}),
            ...(evidence.endLine !== undefined
              ? { endLine: evidence.endLine }
              : {}),
            reason: evidence.reason,
          })),
          ...(revalidation.rationale !== undefined
            ? { rationale: revalidation.rationale }
            : {}),
        }),
      ),
    })),
  };
}

function toActionBatchPayload(
  payload: ReviewExecutionBatchPayload,
): ActionBatchPayload {
  return batchPayloadSchema.parse({
    filePaths: payload.filePaths,
    findings: payload.findings,
    providerResults: payload.providerResults.map((providerResult) => ({
      name: providerResult.name,
      status: toActionProviderResultStatus(providerResult.status),
      durationMs: providerResult.durationSeconds * 1000,
      ...(providerResult.errorMessage !== undefined
        ? { errorMessage: providerResult.errorMessage }
        : {}),
      ...(providerResult.actualModel !== undefined
        ? { actualModel: providerResult.actualModel }
        : {}),
      ...(providerResult.aiLikelihood !== undefined
        ? { aiLikelihood: providerResult.aiLikelihood }
        : {}),
      ...(providerResult.usage !== undefined
        ? { usage: providerResult.usage }
        : {}),
      lifecycleAssignedTargetIds: providerResult.lifecycleAssignedTargetIds,
      lifecycleRevalidations: providerResult.lifecycleRevalidations.map(
        (revalidation) => ({
          targetId: revalidation.targetId,
          ...(revalidation.fingerprint !== undefined
            ? { fingerprint: revalidation.fingerprint }
            : {}),
          verdict: revalidation.verdict,
          ...(revalidation.confidence !== undefined
            ? { confidence: revalidation.confidence }
            : {}),
          evidence: revalidation.evidence.map((evidence) => ({
            path: evidence.path,
            ...(evidence.startLine !== undefined
              ? { startLine: evidence.startLine }
              : {}),
            ...(evidence.endLine !== undefined
              ? { endLine: evidence.endLine }
              : {}),
            reason: evidence.reason,
          })),
          ...(revalidation.rationale !== undefined
            ? { rationale: revalidation.rationale }
            : {}),
        }),
      ),
    })),
  });
}

function toDomainProviderResultStatus(
  status: ActionProviderResultStatus,
): ReviewExecutionProviderResultStatus {
  switch (status) {
    case "success":
      return ReviewExecutionProviderResultStatus.Success;
    case "error":
      return ReviewExecutionProviderResultStatus.Error;
    case "timeout":
      return ReviewExecutionProviderResultStatus.Timeout;
    case "rate_limited":
      return ReviewExecutionProviderResultStatus.RateLimited;
  }
}

function toActionProviderResultStatus(
  status: ReviewExecutionProviderResultStatus,
): ActionProviderResultStatus {
  switch (status) {
    case ReviewExecutionProviderResultStatus.Success:
      return "success";
    case ReviewExecutionProviderResultStatus.Error:
      return "error";
    case ReviewExecutionProviderResultStatus.Timeout:
      return "timeout";
    case ReviewExecutionProviderResultStatus.RateLimited:
      return "rate_limited";
  }
}
