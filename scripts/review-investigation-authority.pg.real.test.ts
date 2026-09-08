import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { createPrismaClient } from "@reviewrouter/platform-db";
import { describe, expect, it } from "vitest";
import {
  InvestigationExecutionAuthorityVerdict,
  InvestigationStoreCommitGuardKind,
  InvestigationStoreCommitStatus,
  InvestigationStoreTransitionKind,
  canonicalJson,
} from "../packages/features/review-investigations/src/index";
import { OpenReviewInvestigation } from "../packages/features/review-investigations/src/application/use-cases/open-review-investigation";
import { PlanNextInvestigationTurn } from "../packages/features/review-investigations/src/application/use-cases/plan-next-investigation-turn";
import { PrismaInvestigationStore } from "../packages/features/review-investigations/src/infrastructure/prisma/prisma-investigation-store";
import { NodeSha256InvestigationDigest } from "../packages/features/review-investigations/src/infrastructure/node/node-sha256-digest";
import {
  createPrismaInvestigationStoreHarness as createHarness,
  createInvestigationStoreContractSeed,
  digestBackedInvestigationManifestIdentity,
  FixedInvestigationClock,
} from "../packages/features/review-investigations/src/testing/index";
import { PrismaReviewExecutionStore } from "../packages/features/review-executions/src/infrastructure/prisma/prisma-review-execution-store";
import { PrismaReviewRunAuthorizationRepository } from "../packages/features/review-run-control/src/infrastructure/prisma/prisma-review-run-authorization-repository";
import { ReviewRunAuthorizationState } from "../packages/features/review-run-control/src/domain/review-run-control-types";
import { ReviewRunAuthorizationTerminateStatus } from "../packages/features/review-run-control/src/application/ports/review-run-authorization-ports";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
// CI must exercise these real PostgreSQL regressions, even if its DB env drifts.
if (process.env.CI && !databaseUrl) {
  throw new Error("REVIEW_ROUTER_TEST_DATABASE_URL is required in CI");
}
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Investigation production authority PostgreSQL integration", () => {
  it("uses production authority with poolMax=1 for concurrent opens, adoption and continuation", async () => {
    const base = createInvestigationStoreContractSeed(
      `open-db-${randomUUID()}`,
    );
    const digest = new NodeSha256InvestigationDigest();
    const naturalIdentityHash = await digest.digestUtf8(
      canonicalJson({
        scope: base.scope,
        revision: base.revision,
        executionId: base.executionId,
        workSlotId: base.workSlotId,
        stableReviewUnitKey: base.stableReviewUnitKey,
        providerVoteLaneId: base.providerVoteLaneId,
        coverageContractVersion: base.contract.coverageContractVersion,
        runtimeProfileVersion: base.contract.runtimeProfileVersion,
      }),
    );
    const seed = {
      ...base,
      naturalIdentityHash,
      investigationId: `investigation-${naturalIdentityHash.slice(0, 32)}`,
    };
    const harness = await createHarness(seed, 86_400_000, 1);
    try {
      const { ProductionInvestigationExecutionAuthority } =
        await import("../apps/api/src/review-action-v2-investigation-composition");
      const authority = new ProductionInvestigationExecutionAuthority(
        new PrismaReviewExecutionStore(harness.prisma),
        new PrismaReviewRunAuthorizationRepository(harness.prisma),
      );
      const clock = new FixedInvestigationClock(new Date());
      const open = new OpenReviewInvestigation(
        harness.store,
        authority,
        digest,
        digestBackedInvestigationManifestIdentity(digest),
        clock,
      );
      const command = {
        commandId: `open-a-${seed.investigationId}`,
        scope: seed.scope,
        revision: seed.revision,
        executionId: seed.executionId,
        workSlotId: seed.workSlotId,
        stableReviewUnitKey: seed.stableReviewUnitKey,
        providerVoteLaneId: seed.providerVoteLaneId,
        providerStrategyId: seed.providerStrategyId,
        runtimeProfile: seed.runtimeProfile,
        contract: seed.contract,
        policy: seed.policy,
        seedObligations: seed.obligations.map((item) => ({
          kind: item.kind,
          canonicalSubject: item.canonicalSubject,
          canonicalRequirement: item.canonicalRequirement,
          riskPriority: item.riskPriority,
        })),
        initialReceipts: [],
      };
      const [first, second] = await Promise.all([
        open.execute(command),
        open.execute({
          ...command,
          commandId: `open-b-${seed.investigationId}`,
        }),
      ]);
      expect(first).toEqual(second);
      const before = await harness.store.findById(first.investigationId);
      const adopted = {
        ...command,
        commandId: `open-c-${seed.investigationId}`,
      };
      expect(await open.execute(adopted)).toEqual(first);
      expect(await open.execute(adopted)).toEqual(first);
      expect(await harness.store.findById(first.investigationId)).toEqual(
        before,
      );
      expect(
        await harness.prisma.reviewInvestigationCommandReceipt.count({
          where: { commandId: adopted.commandId },
        }),
      ).toBe(1);
      await expect(
        open.execute({
          ...adopted,
          providerStrategyId: "conflicting-strategy",
        }),
      ).rejects.toThrow("investigation_idempotency_conflict");
      const continued = await new PlanNextInvestigationTurn(
        harness.store,
        authority,
        digest,
        clock,
      ).execute({
        commandId: `continue-${seed.investigationId}`,
        investigationId: first.investigationId,
        expectedVersion: first.version,
        leaseDurationMs: 60_000,
        maxObligationsForTurn: 1,
      });
      expect(continued.investigationId).toBe(first.investigationId);
      expect(continued.version).toBe(first.version + 1);
    } finally {
      await harness.dispose();
    }
  });

  it("restores a concurrent duplicate creation after intervening revocation", async () => {
    const seed = createInvestigationStoreContractSeed(
      `duplicate-${randomUUID()}`,
    );
    const harness = await createHarness(seed, 86_400_000, 1);
    const duplicateClient = createPrismaClient({
      databaseUrl: databaseUrl!,
      poolMax: 1,
    });
    const revoker = createPrismaClient({
      databaseUrl: databaseUrl!,
      poolMax: 1,
    });
    const observer = createPrismaClient({
      databaseUrl: databaseUrl!,
      poolMax: 1,
    });
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first: ReturnType<PrismaInvestigationStore["commit"]> | undefined;
    let duplicate: ReturnType<PrismaInvestigationStore["commit"]> | undefined;
    let revocation: Promise<unknown> | undefined;
    try {
      const [firstBackend] = await harness.prisma.$queryRaw<
        Array<{ pid: number }>
      >`
        SELECT pg_backend_pid() AS pid
      `;
      const [duplicateBackend] = await duplicateClient.$queryRaw<
        Array<{ pid: number }>
      >`
        SELECT pg_backend_pid() AS pid
      `;
      const [revokerBackend] = await revoker.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid() AS pid
      `;
      const commandId = `duplicate-create-${seed.investigationId}`;
      let guardCalls = 0;
      const input = {
        investigation: seed,
        expectedVersion: null,
        commandId,
        commandHash: "2".repeat(64),
        transition: { kind: InvestigationStoreTransitionKind.Opened },
        guard: {
          kind: InvestigationStoreCommitGuardKind.ExecutionAuthority,
          expectedVerdict: InvestigationExecutionAuthorityVerdict.Current,
          requireCurrentExecution: async (
            verdict?: InvestigationExecutionAuthorityVerdict,
          ) => {
            guardCalls += 1;
            if (verdict !== InvestigationExecutionAuthorityVerdict.Current) {
              throw new Error(`investigation_execution_${verdict}`);
            }
            reached();
            await resume;
          },
        },
      } as const;
      first = harness.store.commit(input);
      await Promise.race([
        paused,
        first.then(() => {
          throw new Error("first_creation_did_not_pause");
        }),
      ]);
      const waitForScopeBlock = async (
        pid: number,
        pending: Promise<unknown>,
      ) => {
        const finished = pending.then(() => {
          throw new Error("writer_completed_before_release");
        });
        void finished.catch(() => undefined);
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          const [row] = await Promise.race([
            observer.$queryRaw<Array<{ blocked: boolean }>>`
              SELECT ${firstBackend!.pid}::int = ANY(pg_blocking_pids(${pid}))
                AND EXISTS (
                  SELECT 1 FROM pg_locks
                  WHERE pid = ${pid} AND locktype = 'advisory' AND NOT granted
                ) AS blocked
            `,
            finished,
          ]);
          if (row?.blocked) return;
        }
        throw new Error("scope_lock_wait_not_observed");
      };
      const scopeKey = JSON.stringify([
        seed.scope.workspaceId,
        seed.scope.repositoryConnectionId,
        seed.scope.scmRepositoryIdentityId,
        seed.scope.pullRequestNumber,
      ]);
      // Queue revocation on the scope first, so it commits between the two
      // creates. The first create already holds both scope and authorization.
      revocation = revoker.$transaction(async (transaction) => {
        await transaction.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))
        `);
        await transaction.reviewRunAuthorization.update({
          where: { authorizationId: `authorization-${seed.investigationId}` },
          data: { state: "revoked", version: { increment: 1 } },
        });
      });
      await waitForScopeBlock(revokerBackend!.pid, revocation);
      duplicate = new PrismaInvestigationStore(duplicateClient).commit(input);
      // This wait is reachable only AFTER fastRestore misses. Waiting on the
      // first create's guard alone would allow a merely sequential restore.
      await waitForScopeBlock(duplicateBackend!.pid, duplicate);
      expect(
        await observer.reviewInvestigationCommandReceipt.count({
          where: { commandId },
        }),
      ).toBe(0);
      release();
      const committed = await first;
      await revocation;
      expect(committed.status).toBe(InvestigationStoreCommitStatus.Committed);
      await expect(duplicate).resolves.toMatchObject({
        status: InvestigationStoreCommitStatus.Restored,
        investigation: committed.investigation,
      });
      expect(guardCalls).toBe(1);
      expect(
        await observer.reviewRunAuthorization.findUniqueOrThrow({
          where: { authorizationId: `authorization-${seed.investigationId}` },
          select: { state: true },
        }),
      ).toEqual({ state: "revoked" });
      expect(
        await observer.reviewInvestigationCommandReceipt.count({
          where: { commandId },
        }),
      ).toBe(1);
    } finally {
      release();
      await Promise.allSettled([first, duplicate, revocation]);
      await duplicateClient.$disconnect();
      await revoker.$disconnect();
      await observer.$disconnect();
      await harness.dispose();
    }
  }, 15_000);

  it.each(["adoption", "creation"] as const)(
    "%s fences revocation until receipt commit and rejects an already revoked authorization",
    async (operation) => {
      const seed = createInvestigationStoreContractSeed(
        `revoke-${randomUUID()}`,
      );
      const harness = await createHarness(seed, 86_400_000, 1);
      const revoker = createPrismaClient({
        databaseUrl: databaseUrl!,
        poolMax: 1,
      });
      const observer = createPrismaClient({
        databaseUrl: databaseUrl!,
        poolMax: 1,
      });
      let release!: () => void;
      let reached!: () => void;
      const paused = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      let admission: Promise<unknown> | undefined;
      let revocation: Promise<unknown> | undefined;
      try {
        if (operation === "adoption") {
          await harness.store.commit({
            investigation: seed,
            expectedVersion: null,
            commandId: `seed-${seed.investigationId}`,
            commandHash: "1".repeat(64),
            transition: { kind: InvestigationStoreTransitionKind.Opened },
          });
        }
        const authorizationId = `authorization-${seed.investigationId}`;
        const authorization =
          await revoker.reviewRunAuthorization.findUniqueOrThrow({
            where: { authorizationId },
          });
        const [backend] = await revoker.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid() AS pid
        `;
        // Both clients have one connection; identify the admission backend so
        // the regression proves which transaction is blocking termination.
        const [admissionBackend] = await harness.prisma.$queryRaw<
          Array<{ pid: number }>
        >`
          SELECT pg_backend_pid() AS pid
        `;
        const write = (
          commandId: string,
          check: (
            verdict?: InvestigationExecutionAuthorityVerdict,
          ) => Promise<void>,
          investigation = seed,
        ) => {
          const common = {
            investigation,
            commandId,
            commandHash: "2".repeat(64),
          };
          return operation === "adoption"
            ? harness.store.adopt({
                ...common,
                expectedVersion: seed.version,
                requireCurrentExecution: check,
              })
            : harness.store.commit({
                ...common,
                expectedVersion: null,
                transition: { kind: InvestigationStoreTransitionKind.Opened },
                guard: {
                  kind: InvestigationStoreCommitGuardKind.ExecutionAuthority,
                  expectedVerdict:
                    InvestigationExecutionAuthorityVerdict.Current,
                  requireCurrentExecution: check,
                },
              });
        };
        const commandId = `admitted-${seed.investigationId}`;
        admission = write(commandId, async (verdict) => {
          expect(verdict).toBe(InvestigationExecutionAuthorityVerdict.Current);
          reached();
          await resume;
        });
        // Surface a failed admission instead of waiting forever for the barrier.
        await Promise.race([
          paused,
          admission.then(() => {
            throw new Error("admission_did_not_pause");
          }),
        ]);
        revocation = new PrismaReviewRunAuthorizationRepository(
          revoker,
        ).terminateReviewRunAuthorization({
          authorizationId,
          expectedVersion: authorization.version,
          state: ReviewRunAuthorizationState.Revoked,
          at: new Date(),
        });
        // A mapper rejection (or an unexpected successful termination) must
        // fail immediately, rather than masquerading as a lock-wait timeout.
        const terminatedBeforeRelease = revocation.then(() => {
          throw new Error("revocation_completed_before_release");
        });
        void terminatedBeforeRelease.catch(() => undefined);
        // Observe an actual PostgreSQL lock wait, never infer blocking from time.
        const deadline = Date.now() + 3_000;
        let blocked = false;
        while (Date.now() < deadline) {
          const [row] = await Promise.race([
            observer.$queryRaw<Array<{ blocked: boolean }>>`
              SELECT ${admissionBackend!.pid}::int = ANY(pg_blocking_pids(${backend!.pid})) AS blocked
            `,
            terminatedBeforeRelease,
          ]);
          if (row?.blocked) {
            blocked = true;
            break;
          }
        }
        expect(blocked).toBe(true);
        expect(
          await observer.reviewRunAuthorization.findUnique({
            where: { authorizationId },
            select: { state: true, version: true },
          }),
        ).toEqual({ state: "active", version: authorization.version });
        expect(
          await observer.reviewInvestigationCommandReceipt.count({
            where: { commandId },
          }),
        ).toBe(0);
        release();
        await expect(admission).resolves.toMatchObject({
          status: InvestigationStoreCommitStatus.Committed,
        });
        await expect(revocation).resolves.toMatchObject({
          status: ReviewRunAuthorizationTerminateStatus.Terminated,
          authorization: {
            authorizationId,
            state: ReviewRunAuthorizationState.Revoked,
            version: authorization.version + 1,
          },
        });
        expect(
          await observer.reviewRunAuthorization.findUnique({
            where: { authorizationId },
            select: { state: true, version: true },
          }),
        ).toEqual({
          state: ReviewRunAuthorizationState.Revoked,
          version: authorization.version + 1,
        });
        expect(
          await observer.reviewInvestigationCommandReceipt.count({
            where: { commandId },
          }),
        ).toBe(1);
        const rejectedId = `rejected-${seed.investigationId}`;
        await expect(
          write(
            rejectedId,
            async (verdict) => {
              expect(verdict).toBe(
                InvestigationExecutionAuthorityVerdict.Unauthorized,
              );
              throw new Error(`investigation_execution_${verdict}`);
            },
            operation === "creation"
              ? {
                  ...seed,
                  investigationId: rejectedId,
                  naturalIdentityHash: "3".repeat(64),
                }
              : seed,
          ),
        ).rejects.toThrow("investigation_execution_unauthorized");
        expect(
          await observer.reviewInvestigationCommandReceipt.count({
            where: { commandId: rejectedId },
          }),
        ).toBe(0);
      } finally {
        release();
        await Promise.allSettled([admission, revocation]);
        await revoker.$disconnect();
        await observer.$disconnect();
        await harness.dispose();
      }
    },
    15_000,
  );

});
