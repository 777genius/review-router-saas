import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryReviewExecutionCheckpointRepository } from "@reviewrouter/features-review-execution-checkpoints";
import {
  registerActionControlPlaneRoutes,
  type CodexRotatingReviewExecutionCheckpointAccessPort,
} from "../index.js";

const routePrefix = "/api/action/v1/codex-oauth/review-execution-checkpoint";
const now = new Date("2026-07-16T12:00:00.000Z");
const providerInstanceId = "codex-rotating:123456";
const leaseId = "lease_123456";
const secondLeaseId = "lease_654321";
const pullRequestNumber = 240;
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const compatibilityKey = "c".repeat(64);
const planHash = "d".repeat(64);
const firstWorkKey = "1".repeat(64);
const secondWorkKey = "2".repeat(64);

describe("Codex OAuth review execution checkpoint routes", () => {
  it("restores, starts, commits idempotently, finalizes, and clears", async () => {
    const context = await buildRouteContext();
    const { app, checkpoints } = context;
    try {
      const missing = await post(app, "restore", restoreBody());
      expect(missing.statusCode).toBe(200);
      expect(missing.json()).toEqual({
        protocolVersion: 1,
        status: "missing",
        expectedVersion: 0,
      });

      const started = await post(app, "start", startBody());
      expect(started.statusCode).toBe(200);
      expect(started.json()).toEqual({
        protocolVersion: 1,
        status: "started",
        version: 1,
        headSha,
        planHash,
      });
      expect(
        await checkpoints.find({
          workspaceId: "workspace_1",
          repositoryId: "repo_1",
          pullRequestNumber,
        }),
      ).toMatchObject({
        checkpoint: {
          workspaceId: "workspace_1",
          repositoryId: "repo_1",
          sourceRunId: "9001",
          sourceRunAttempt: "2",
        },
      });

      const idempotentStart = await post(app, "start", startBody());
      expect(idempotentStart.json()).toEqual({
        protocolVersion: 1,
        status: "idempotent",
        version: 1,
        headSha,
        planHash,
      });

      const secondPayload = batchPayload("src/second.ts", "Second result");
      const acceptedSecond = await post(
        app,
        "batch-result",
        batchResultBody({
          expectedVersion: 1,
          workKey: secondWorkKey,
          batchIndex: 1,
          payload: secondPayload,
        }),
      );
      expect(acceptedSecond.json()).toEqual({
        protocolVersion: 1,
        status: "accepted",
        version: 2,
        headSha,
        planHash,
        workKey: secondWorkKey,
      });

      const idempotentBatch = await post(
        app,
        "batch-result",
        batchResultBody({
          expectedVersion: 1,
          workKey: secondWorkKey,
          batchIndex: 1,
          payload: secondPayload,
        }),
      );
      expect(idempotentBatch.json()).toEqual({
        protocolVersion: 1,
        status: "idempotent",
        version: 2,
        headSha,
        planHash,
        workKey: secondWorkKey,
      });

      const firstPayload = batchPayload(
        "src/first.ts",
        "First result",
        "rate_limited",
        false,
      );
      const acceptedFirst = await post(
        app,
        "batch-result",
        batchResultBody({
          expectedVersion: 2,
          workKey: firstWorkKey,
          batchIndex: 0,
          payload: firstPayload,
        }),
      );
      expect(acceptedFirst.json()).toEqual({
        protocolVersion: 1,
        status: "accepted",
        version: 3,
        headSha,
        planHash,
        workKey: firstWorkKey,
      });

      const restored = await post(app, "restore", restoreBody());
      expect(restored.json()).toEqual({
        protocolVersion: 1,
        status: "found",
        expectedVersion: 3,
        checkpoint: {
          version: 3,
          baseSha,
          headSha,
          compatibilityKey,
          planHash,
          plannedWorkKeys: [firstWorkKey, secondWorkKey],
          acceptedResults: [
            { workKey: firstWorkKey, payload: normalizedPayload(firstPayload) },
            {
              workKey: secondWorkKey,
              payload: normalizedPayload(secondPayload),
            },
          ],
          finalized: false,
        },
      });

      const finalized = await post(app, "finalize", {
        ...leaseScopeBody(),
        expectedVersion: 3,
        headSha,
        planHash,
      });
      expect(finalized.json()).toEqual({
        protocolVersion: 1,
        status: "finalized",
        version: 4,
        headSha,
        planHash,
      });
      expect(
        (
          await post(app, "finalize", {
            ...leaseScopeBody(),
            expectedVersion: 3,
            headSha,
            planHash,
          })
        ).json(),
      ).toEqual({
        protocolVersion: 1,
        status: "idempotent",
        version: 4,
        headSha,
        planHash,
      });
      expect((await post(app, "start", startBody())).json()).toEqual({
        protocolVersion: 1,
        status: "conflict",
        currentVersion: 4,
      });
      expect((await post(app, "restore", restoreBody())).json()).toMatchObject({
        checkpoint: { finalized: true },
      });

      const cleared = await post(app, "clear", {
        ...leaseScopeBody(),
        expectedVersion: 4,
        headSha,
        planHash,
      });
      expect(cleared.json()).toEqual({
        protocolVersion: 1,
        status: "cleared",
      });
      const missingClear = await post(app, "clear", {
        ...leaseScopeBody(),
        expectedVersion: 4,
        headSha,
        planHash,
      });
      expect(missingClear.json()).toEqual({
        protocolVersion: 1,
        status: "missing",
      });
    } finally {
      await app.close();
    }
  });

  it("normalizes restore mismatches and mutation anomalies", async () => {
    const { app } = await buildRouteContext();
    try {
      expect((await post(app, "start", startBody())).statusCode).toBe(200);

      for (const changed of [
        { baseSha: "e".repeat(40) },
        { headSha: "e".repeat(40) },
        { compatibilityKey: "e".repeat(64) },
        { planHash: "e".repeat(64) },
      ]) {
        expect(
          (await post(app, "restore", { ...restoreBody(), ...changed })).json(),
        ).toEqual({
          protocolVersion: 1,
          status: "missing",
          expectedVersion: 1,
        });
      }

      expect(
        (
          await post(app, "start", {
            ...startBody(),
            planHash: "e".repeat(64),
          })
        ).json(),
      ).toEqual({
        protocolVersion: 1,
        status: "conflict",
        currentVersion: 1,
      });

      for (const changed of [
        { headSha: "e".repeat(40) },
        { planHash: "e".repeat(64) },
      ]) {
        expect(
          (
            await post(
              app,
              "batch-result",
              batchResultBody({
                expectedVersion: 1,
                workKey: firstWorkKey,
                batchIndex: 0,
                payload: batchPayload("src/first.ts", "Mismatched identity"),
                ...changed,
              }),
            )
          ).json(),
        ).toEqual({
          protocolVersion: 1,
          status: "conflict",
          currentVersion: 1,
        });
      }

      expect(
        (
          await post(
            app,
            "batch-result",
            batchResultBody({
              expectedVersion: 1,
              workKey: "f".repeat(64),
              batchIndex: 0,
              payload: batchPayload("src/unplanned.ts", "Unplanned"),
            }),
          )
        ).json(),
      ).toEqual({
        protocolVersion: 1,
        status: "conflict",
        currentVersion: 1,
      });

      const accepted = await post(
        app,
        "batch-result",
        batchResultBody({
          expectedVersion: 1,
          workKey: firstWorkKey,
          batchIndex: 0,
          payload: batchPayload("src/first.ts", "First"),
        }),
      );
      expect(accepted.json()).toMatchObject({ status: "accepted", version: 2 });

      expect(
        (
          await post(
            app,
            "batch-result",
            batchResultBody({
              expectedVersion: 2,
              workKey: firstWorkKey,
              batchIndex: 0,
              payload: batchPayload("src/first.ts", "Changed"),
            }),
          )
        ).json(),
      ).toEqual({
        protocolVersion: 1,
        status: "conflict",
        currentVersion: 2,
      });

      expect(
        (
          await post(app, "finalize", {
            ...leaseScopeBody(),
            expectedVersion: 2,
            headSha,
            planHash,
          })
        ).json(),
      ).toEqual({
        protocolVersion: 1,
        status: "conflict",
        currentVersion: 2,
      });

      expect(
        (
          await post(app, "clear", {
            ...leaseScopeBody(),
            expectedVersion: 2,
            headSha,
            planHash,
          })
        ).json(),
      ).toEqual({
        protocolVersion: 1,
        status: "conflict",
        currentVersion: 2,
      });
    } finally {
      await app.close();
    }
  });

  it("rejects client-owned scope, unknown fields, invalid leases, and oversized bodies", async () => {
    const context = await buildRouteContext();
    const { app, access } = context;
    try {
      const forged = await post(app, "start", {
        ...startBody(),
        workspaceId: "attacker_workspace",
        repositoryId: "attacker_repo",
        sourceRunId: "attacker_run",
      });
      expect(forged.statusCode).toBe(400);
      expect(
        access.authorizeReviewExecutionCheckpointAccess,
      ).not.toHaveBeenCalled();

      const nestedUnknown = await post(
        app,
        "batch-result",
        batchResultBody({
          expectedVersion: 0,
          workKey: firstWorkKey,
          batchIndex: 0,
          payload: {
            ...batchPayload("src/first.ts", "First"),
            sourceRunAttempt: "99",
          } as ActionBatchPayload,
        }),
      );
      expect(nestedUnknown.statusCode).toBe(400);

      const invalidLease = await post(app, "restore", {
        ...restoreBody(),
        leaseId: "lease_invalid",
      });
      expect(invalidLease.statusCode).toBe(409);
      expect(invalidLease.json()).toMatchObject({
        error: { code: "codex_rotating_lease_not_active" },
      });

      for (const [route, limit] of [
        ["restore", 8 * 1024],
        ["start", 32 * 1024],
        ["batch-result", 160 * 1024],
        ["finalize", 8 * 1024],
        ["clear", 8 * 1024],
      ] as const) {
        const oversized = await post(app, route, {
          ...leaseScopeBody(),
          padding: "x".repeat(limit),
        });
        expect(oversized.statusCode, route).toBe(413);
      }
    } finally {
      await app.close();
    }
  });

  it("isolates identical pull requests by server-resolved lease scope", async () => {
    const { app, checkpoints } = await buildRouteContext({
      [secondLeaseId]: {
        workspaceId: "workspace_2",
        repositoryId: "repo_2",
        sourceRunId: "9002",
        sourceRunAttempt: "1",
        pullRequestNumber,
      },
    });
    try {
      expect((await post(app, "start", startBody())).statusCode).toBe(200);
      expect(
        (
          await post(app, "start", {
            ...startBody(),
            leaseId: secondLeaseId,
          })
        ).statusCode,
      ).toBe(200);

      await expect(
        checkpoints.find({
          workspaceId: "workspace_1",
          repositoryId: "repo_1",
          pullRequestNumber,
        }),
      ).resolves.toBeTruthy();
      await expect(
        checkpoints.find({
          workspaceId: "workspace_2",
          repositoryId: "repo_2",
          pullRequestNumber,
        }),
      ).resolves.toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("rejects a different PR number under an otherwise valid lease", async () => {
    const { app, checkpoints } = await buildRouteContext();
    try {
      const response = await post(app, "start", {
        ...startBody(),
        pullRequestNumber: pullRequestNumber + 1,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "codex_rotating_lease_not_active" },
      });
      await expect(
        checkpoints.find({
          workspaceId: "workspace_1",
          repositoryId: "repo_1",
          pullRequestNumber: pullRequestNumber + 1,
        }),
      ).resolves.toBeNull();
    } finally {
      await app.close();
    }
  });
});

async function buildRouteContext(
  additionalScopes: Record<
    string,
    {
      readonly workspaceId: string;
      readonly repositoryId: string;
      readonly sourceRunId: string;
      readonly sourceRunAttempt: string;
      readonly pullRequestNumber: number;
    }
  > = {},
) {
  const checkpoints = new InMemoryReviewExecutionCheckpointRepository();
  const scopes = {
    [leaseId]: {
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
      sourceRunId: "9001",
      sourceRunAttempt: "2",
      pullRequestNumber,
    },
    ...additionalScopes,
  };
  const access: CodexRotatingReviewExecutionCheckpointAccessPort = {
    authorizeReviewExecutionCheckpointAccess: vi.fn(async (input) => {
      if (input.providerInstanceId !== providerInstanceId) {
        return { status: "lease_not_active" as const };
      }
      const scope = scopes[input.leaseId as keyof typeof scopes];
      return scope && scope.pullRequestNumber === input.pullRequestNumber
        ? { status: "ready" as const, scope }
        : { status: "lease_not_active" as const };
    }),
  };
  const app = Fastify({ logger: false });
  await registerActionControlPlaneRoutes(app, {
    codexRotatingReviewExecutionCheckpointAccess: access,
    reviewExecutionCheckpoints: checkpoints,
    clock: { now: () => now },
  } as unknown as Parameters<typeof registerActionControlPlaneRoutes>[1]);
  return { app, checkpoints, access };
}

function leaseScopeBody() {
  return {
    protocolVersion: 1,
    leaseId,
    providerInstanceId,
    pullRequestNumber,
  };
}

function restoreBody() {
  return {
    ...leaseScopeBody(),
    baseSha,
    headSha,
    compatibilityKey,
    planHash,
  };
}

function startBody() {
  return {
    ...restoreBody(),
    expectedVersion: 0,
    plannedWorkKeys: [firstWorkKey, secondWorkKey],
  };
}

function batchResultBody(input: {
  readonly expectedVersion: number;
  readonly workKey: string;
  readonly batchIndex: number;
  readonly payload: ActionBatchPayload;
  readonly headSha?: string;
  readonly planHash?: string;
}) {
  return {
    ...leaseScopeBody(),
    expectedVersion: input.expectedVersion,
    headSha: input.headSha ?? headSha,
    planHash: input.planHash ?? planHash,
    workKey: input.workKey,
    batchId: `${input.batchIndex + 3}`.repeat(64),
    batchIndex: input.batchIndex,
    payload: input.payload,
  };
}

function batchPayload(
  file: string,
  title: string,
  status: "success" | "rate_limited" = "success",
  includeLifecycle = true,
): ActionBatchPayload {
  const lifecycleTargetId = "t".repeat(500);
  return {
    filePaths: [file],
    findings: [
      {
        file,
        line: 12,
        severity: "major",
        title,
        message: `${title} must remain resumable.`,
      },
    ],
    providerResults: [
      {
        name: "codex",
        status,
        durationMs: 1_500,
        usage: {
          promptTokens: 1_200,
          completionTokens: 300,
          totalTokens: 1_600,
        },
        ...(includeLifecycle
          ? {
              lifecycleAssignedTargetIds: [lifecycleTargetId],
              lifecycleRevalidations: [
                {
                  targetId: lifecycleTargetId,
                  verdict: "still_valid" as const,
                },
              ],
            }
          : {}),
      },
    ],
  };
}

function normalizedPayload(payload: ActionBatchPayload): ActionBatchPayload {
  return {
    ...payload,
    providerResults: payload.providerResults.map((providerResult) => ({
      ...providerResult,
      lifecycleAssignedTargetIds:
        providerResult.lifecycleAssignedTargetIds ?? [],
      lifecycleRevalidations: (providerResult.lifecycleRevalidations ?? []).map(
        (revalidation) => ({
          ...revalidation,
          evidence: revalidation.evidence ?? [],
        }),
      ),
    })),
  };
}

type ActionBatchPayload = {
  readonly filePaths: readonly string[];
  readonly findings: readonly {
    readonly file: string;
    readonly line: number;
    readonly severity: "major";
    readonly title: string;
    readonly message: string;
  }[];
  readonly providerResults: readonly {
    readonly name: string;
    readonly status: "success" | "rate_limited";
    readonly durationMs: number;
    readonly usage?: {
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens: number;
    };
    readonly lifecycleAssignedTargetIds?: readonly string[];
    readonly lifecycleRevalidations?: readonly {
      readonly targetId: string;
      readonly verdict: "still_valid";
      readonly evidence?: readonly {
        readonly path: string;
        readonly reason: string;
      }[];
    }[];
  }[];
};

async function post(
  app: FastifyInstance,
  route: string,
  payload: Record<string, unknown>,
) {
  return await app.inject({
    method: "POST",
    url: `${routePrefix}/${route}`,
    payload,
  });
}
