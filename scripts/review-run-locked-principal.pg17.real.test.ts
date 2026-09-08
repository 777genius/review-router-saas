import { readRenderSchemaHandoffCatalog } from "./lib/render-schema-handoff-policy.mjs";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { managedPg17Fixture } from "./lib/render-managed-pg17-fixture";
import { PrismaReviewRunAuthorizationRepository } from "../packages/features/review-run-control/src/infrastructure/prisma/prisma-review-run-authorization-repository";
import { PrismaLockedReviewRunPrincipalReader } from "../packages/features/review-run-control/src/infrastructure/prisma/prisma-locked-review-run-principal-reader";
import {
  databaseNow,
  type ReviewRunControlTransaction,
} from "../packages/features/review-run-control/src/infrastructure/prisma/prisma-review-run-control-utils";
import { ReviewRunAuthorizationState } from "../packages/features/review-run-control/src/domain/review-run-control-types";
import { createReviewRunControlTestKit } from "../packages/features/review-run-control/src/testing/review-run-control-test-kit";
import {
  provisionV2AuthorizationContext,
  limits,
  limitsDigest,
  sloThresholds,
  sloDigest,
  releaseCandidate,
} from "../packages/features/review-run-control/src/tests/fixtures";

// Root opt-in: runs only the existing labelled/offline disposable PG17 fixture.
const enabled = process.env.REVIEW_ROUTER_RUN_LOCKED_PRINCIPAL_PG17 === "1";
describe.skipIf(!enabled)(
  "locked run principal with production Prisma mutations / PG17",
  () => {
    const pg = managedPg17Fixture();
    const database = "locked_principal_test";
    const clients: PrismaClient[] = [];
    let readerDb: PrismaClient;
    let writerDb: PrismaClient;
    let observer: PrismaClient;

    function client(name: string) {
      // Same PrismaClient + PrismaPg stack as platform-db/createPrismaClient.
      // Only the transport changes to the fixture's offline Docker wire stream.
      const config = {
        user: "reviewrouter",
        database,
        host: "127.0.0.1",
        port: 5432,
        ssl: false as const,
        stream: () => {
          const stream = pg.wireStream();
          // This fixture keeps its Docker stdio child referenced until cleanup.
          // Pool ref/unref affect process liveness only, never PostgreSQL I/O.
          return Object.assign(stream, {
            ref: () => stream,
            unref: () => stream,
          });
        },
        max: 2,
        application_name: name,
        connectionTimeoutMillis: 5_000,
      };
      const result = new PrismaClient({
        adapter: new PrismaPg(config),
        transactionOptions: { timeout: 20_000, maxWait: 5_000 },
      });
      clients.push(result);
      return result;
    }
    beforeAll(async () => {
      await pg.start();
      pg.query(
        "postgres",
        `CREATE ROLE reviewrouter LOGIN; CREATE DATABASE ${database} OWNER reviewrouter;`,
        "postgres",
      );
      const catalog = readRenderSchemaHandoffCatalog();
      const lastMigration =
        "000053_review_run_authorization_investigation_snapshot";
      const count =
        catalog.findIndex((entry) => entry.migrationName === lastMigration) + 1;
      expect(count).toBeGreaterThan(0);
      const applied = await pg.apply(database, count, "r115-schema-fixture")
        .result;
      expect(applied).toHaveLength(count);
      expect(applied.at(-1)).toBe(lastMigration);
      readerDb = client("r115-reader");
      writerDb = client("r115-writer");
      observer = client("r115-observer");
      const f = await memoryAuthorization();
      const a = f.authorization;
      await observer.reviewProtocolLimitsV2.create({
        data: {
          protocolLimitsProfileId: a.protocolLimitsProfileId,
          limitsDigest,
          ...limits,
          registeredAt: a.createdAt,
        },
      });
      await observer.reviewOperationalSloProfileV2.create({
        data: {
          operationalSloProfileId: a.operationalSloProfileId,
          sloDigest,
          ...sloThresholds,
          ownerRefs: ["team-reviewrouter"],
          runbookRefs: ["runbook/review-v2"],
          registeredAt: a.createdAt,
        },
      });
      await observer.producerRelease.create({
        data: { ...releaseCandidate, registeredAt: a.createdAt },
      });
      await observer.workspace.create({
        data: {
          id: a.workspaceId,
          slug: a.workspaceId,
          name: "Disposable principal test",
        },
      });
      await observer.$transaction(async (tx) => {
        await tx.scmRepositoryIdentity.create({
          data: {
            scmRepositoryIdentityId: a.scmRepositoryIdentityId,
            provider: "github",
            normalizedSourceBaseUrl: "https://github.com",
            externalRepositoryId: "123456",
            currentWorkspaceId: a.workspaceId,
            currentRepositoryConnectionId: a.repositoryConnectionId,
            createdAt: a.createdAt,
            boundAt: a.createdAt,
          },
        });
        // Fixture-only parent row: migration 91 adds inventoryGeneration,
        // outside this principal test's authentic schema prefix through 53.
        // Explicit columns avoid asking today's Prisma client for that field.
        await tx.$executeRaw`INSERT INTO "RepositoryConnection"
          ("id", "workspaceId", "provider", "sourceBaseUrl", "externalRepositoryId",
           "scmRepositoryIdentityId", "owner", "name", "fullName", "defaultBranch",
           "visibility", "updatedAt")
          VALUES (${a.repositoryConnectionId}, ${a.workspaceId}, 'github', 'https://github.com',
            '123456', ${a.scmRepositoryIdentityId}, 'test', 'disposable', 'test/disposable',
            'main', 'private', ${a.createdAt})`;
      });
    }, 300_000);
    afterAll(async () => {
      try {
        await Promise.all(clients.map((c) => c.$disconnect()));
      } finally {
        pg.cleanup();
      }
    });

    async function memoryAuthorization(ttlMs = 600_000) {
      const kit = createReviewRunControlTestKit({ now: new Date() });
      const context = await provisionV2AuthorizationContext(kit);
      const result = await kit.control.authorizations.authorizeReviewRun({
        ...context.authorizeInput,
        authorizationTtlMs: ttlMs,
      });
      if (!("authorization" in result))
        throw new Error("fixture_authorization");
      return { kit, authorization: result.authorization };
    }
    async function seed(ttlMs?: number) {
      const f = await memoryAuthorization(ttlMs);
      const id = randomUUID();
      const a = {
        ...f.authorization,
        authorizationId: id,
        sourceRunId: id,
        oidcReplayKeyHash: createHash("sha256").update(id).digest("hex"),
      };
      const result = await new PrismaReviewRunAuthorizationRepository(
        observer,
      ).createOrRestoreReviewRunAuthorization(a);
      expect(result.status).toBe("created");
      const bearer = await f.kit.tokens.issue(a);
      const reader = new PrismaLockedReviewRunPrincipalReader(f.kit.tokens);
      const principal = await reader.preflight(bearer.token);
      return { a, reader, principal };
    }
    function mutation(
      client: PrismaClient,
      kind: "renew" | "terminate",
      authorizationId: string,
    ) {
      const repository = new PrismaReviewRunAuthorizationRepository(client);
      return kind === "renew"
        ? repository.renewReviewRunAuthorization({
            authorizationId,
            expectedVersion: 1,
            renewalReplayKeyHash: createHash("sha256")
              .update(randomUUID())
              .digest("hex"),
            renewalProofHash: "f".repeat(64),
            renewedAt: new Date(),
            expiresAt: new Date(Date.now() + 1_200_000),
          })
        : repository.terminateReviewRunAuthorization({
            authorizationId,
            expectedVersion: 1,
            state: ReviewRunAuthorizationState.Revoked,
            at: new Date(),
          });
    }
    async function waitBlocked(name: string) {
      for (let i = 0; i < 200; i++) {
        const rows = await observer.$queryRaw<readonly { blocked: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE application_name = ${name} AND wait_event_type = 'Lock'
          AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked`;
        if (rows[0]?.blocked) return;
        await delay(20);
      }
      throw new Error(`expected_live_pg_lock_wait:${name}`);
    }

    it.each(["renew", "terminate"] as const)(
      "%s commits first: reader waits then rejects the changed row before work",
      async (kind) => {
        const f = await seed();
        const mutated = latch(),
          release = latch();
        // The production repository executes its real callback on a real Prisma tx.
        // Delay callback return before COMMIT to observe held production locks.
        const heldWriter = new Proxy(writerDb, {
          get(target, key, receiver) {
            if (key !== "$transaction")
              return Reflect.get(target, key, receiver);
            return (
              work: (tx: ReviewRunControlTransaction) => Promise<unknown>,
            ) =>
              target.$transaction(async (tx) => {
                const result = await work(tx);
                mutated.open();
                await release.promise;
                return result;
              });
          },
        });
        const write = mutation(heldWriter, kind, f.a.authorizationId);
        const work = vi.fn();
        let read: Promise<unknown> | undefined;
        try {
          await Promise.race([mutated.promise, write]);
          read = readerDb.$transaction(async (tx) => {
            const locked = await f.reader.lock(tx, f.principal);
            try {
              locked.assert((await databaseNow(tx)).getTime());
              work();
            } finally {
              locked.close();
            }
          });
          // Attach rejection handling before releasing the concurrent writer.
          const outcome = read.then(
            () => ({ error: undefined }),
            (error: unknown) => ({ error }),
          );
          await waitBlocked("r115-reader");
          release.open();
          expect((await write).status).toBe(
            kind === "renew" ? "renewed" : "terminated",
          );
          expect((await outcome).error).toBeInstanceOf(Error);
          expect((await outcome).error).toHaveProperty(
            "message",
            "review_run_principal_not_current",
          );
          expect(work).not.toHaveBeenCalled();
        } finally {
          release.open();
          await Promise.allSettled([write, ...(read ? [read] : [])]);
        }
      },
    );

    it.each(["renew", "terminate"] as const)(
      "reader first: actual %s waits until reader transaction commits",
      async (kind) => {
        const f = await seed();
        // Actual root must fail before any statement-only advisory/row lock.
        await expect(f.reader.lock(readerDb, f.principal)).rejects.toThrow(
          "not_current",
        );
        const acquired = latch(),
          release = latch();
        const read = readerDb.$transaction(async (tx) => {
          const locked = await f.reader.lock(tx, f.principal);
          try {
            acquired.open();
            await release.promise;
            locked.assert((await databaseNow(tx)).getTime());
          } finally {
            locked.close();
          }
        });
        let write: ReturnType<typeof mutation> | undefined;
        try {
          await Promise.race([acquired.promise, read]);
          write = mutation(writerDb, kind, f.a.authorizationId);
          await waitBlocked("r115-writer");
          expect(
            (
              await observer.reviewRunAuthorization.findUniqueOrThrow({
                where: { authorizationId: f.a.authorizationId },
              })
            ).version,
          ).toBe(1);
          release.open();
          await read;
          expect((await write).status).toBe(
            kind === "renew" ? "renewed" : "terminated",
          );
        } finally {
          release.open();
          await Promise.allSettled([read, ...(write ? [write] : [])]);
        }
      },
    );

    it("strict expiry crosses an actual advisory wait even when production renewal restores unchanged claims", async () => {
      const f = await seed(5_000);
      const mutated = latch(),
        release = latch();
      const heldWriter = new Proxy(writerDb, {
        get(target, key, receiver) {
          if (key !== "$transaction") return Reflect.get(target, key, receiver);
          return (
            work: (tx: ReviewRunControlTransaction) => Promise<unknown>,
          ) =>
            target.$transaction(async (tx) => {
              const result = await work(tx);
              mutated.open();
              await release.promise;
              return result;
            });
        },
      });
      const write = new PrismaReviewRunAuthorizationRepository(
        heldWriter,
      ).renewReviewRunAuthorization({
        authorizationId: f.a.authorizationId,
        expectedVersion: 1,
        renewalReplayKeyHash: createHash("sha256")
          .update(randomUUID())
          .digest("hex"),
        renewalProofHash: "f".repeat(64),
        renewedAt: new Date(),
        expiresAt: f.a.expiresAt,
      });
      const work = vi.fn();
      let read: Promise<unknown> | undefined;
      try {
        await Promise.race([mutated.promise, write]);
        read = readerDb.$transaction(async (tx) => {
          const locked = await f.reader.lock(tx, f.principal);
          try {
            locked.assert((await databaseNow(tx)).getTime());
            work();
          } finally {
            locked.close();
          }
        });
        const outcome = read.then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
        await waitBlocked("r115-reader");
        while (
          (await databaseNow(observer)).getTime() < f.a.expiresAt.getTime()
        )
          await delay(25);
        release.open();
        expect((await write).status).toBe("restored");
        expect((await outcome).error).toBeInstanceOf(Error);
        expect((await outcome).error).toHaveProperty(
          "message",
          "review_run_principal_not_current",
        );
        expect(work).not.toHaveBeenCalled();
      } finally {
        release.open();
        await Promise.allSettled([write, ...(read ? [read] : [])]);
      }
    });

    it("expiry crosses downstream wait: recovery/pre-build rejects before work; production sweeper waits on SHARE", async () => {
      const f = await seed(5_000);
      const acquired = latch(),
        release = latch();
      const work = vi.fn();
      const read = readerDb.$transaction(async (tx) => {
        const locked = await f.reader.lock(tx, f.principal);
        try {
          locked.assert((await databaseNow(tx)).getTime());
          acquired.open();
          await release.promise;
          // No fork lease argument: recovery must perform the same strict checks.
          locked.assert((await databaseNow(tx)).getTime());
          work();
        } finally {
          locked.close();
        }
      });
      const outcome = read.then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      let sweep: Promise<number> | undefined;
      try {
        await Promise.race([acquired.promise, read]);
        while (
          (await databaseNow(observer)).getTime() < f.a.expiresAt.getTime()
        )
          await delay(25);
        sweep = new PrismaReviewRunAuthorizationRepository(
          writerDb,
        ).expireDueReviewRunAuthorizations(1_000);
        await waitBlocked("r115-writer");
        release.open();
        expect((await outcome).error).toBeInstanceOf(Error);
        expect((await outcome).error).toHaveProperty(
          "message",
          "review_run_principal_not_current",
        );
        expect(await sweep).toBeGreaterThanOrEqual(1);
        expect(work).not.toHaveBeenCalled();
      } finally {
        release.open();
        await Promise.allSettled([read, ...(sweep ? [sweep] : [])]);
      }
    });
  },
);

function latch() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
