import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { managedPg17Fixture } from "./lib/render-managed-pg17-fixture";
import { readRenderSchemaHandoffCatalog } from "./lib/render-schema-handoff-policy.mjs";
import { acquireCurrentScopeGuards } from "../packages/platform/db/src/current-scope-guards";
import { PrismaReviewSafetyControlRepository } from "../packages/features/review-run-control/src/infrastructure/prisma/prisma-review-safety-control-repository";
import { PrismaProducerReleaseRepository } from "../packages/features/review-run-control/src/infrastructure/prisma/prisma-producer-release-repository";
import { ReviewSafetyPolicyScope } from "../packages/features/review-run-control/src/domain/review-run-control-types";
import {
  policyFixture,
  emergencyFixture,
  releaseFixture,
  limitsProfile,
  sloProfile,
  registeredAt,
} from "../packages/features/review-run-control/src/tests/safety-release-current-scope-fixtures";

// Root-only opt-in; authentic local source catalog and offline managed PG image.
describe.skipIf(
  process.env.REVIEW_ROUTER_RUN_SAFETY_RELEASE_SCOPE_PG17 !== "1",
)("safety and release production current scope writers / PG17", () => {
  const pg = managedPg17Fixture();
  const database = "safety_release_scope_test";
  const clients: PrismaClient[] = [];
  let reader: PrismaClient;
  let writer: PrismaClient;
  let observer: PrismaClient;
  function client(name: string) {
    const result = new PrismaClient({
      adapter: new PrismaPg({
        user: "reviewrouter",
        database,
        host: "127.0.0.1",
        port: 5432,
        ssl: false,
        max: 2,
        application_name: name,
        connectionTimeoutMillis: 5000,
        stream: () => {
          const stream = pg.wireStream();
          return Object.assign(stream, {
            ref: () => stream,
            unref: () => stream,
          });
        },
      }),
      transactionOptions: {
        timeout: 20000,
        maxWait: 5000,
        isolationLevel: "ReadCommitted",
      },
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
    const last = "000054_review_config_investigation_rollout";
    const count =
      catalog.findIndex((entry) => entry.migrationName === last) + 1;
    expect(count).toBeGreaterThan(0);
    const applied = await pg.apply(database, count, "r123-current-scope")
      .result;
    expect(applied).toHaveLength(count);
    expect(applied.at(-1)).toBe(last);
    reader = client("r123-reader");
    writer = client("r123-writer");
    observer = client("r123-observer");
    await expect(
      acquireCurrentScopeGuards(reader, [{ scope: "global", mode: "shared" }]),
    ).rejects.toThrow("requires_transaction");
  }, 300000);
  afterAll(async () => {
    try {
      await Promise.all(clients.map((c) => c.$disconnect()));
    } finally {
      pg.cleanup();
    }
  });
  function latch() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }
  // Attach a rejection handler immediately so failure cleanup never leaks a rejection.
  function outcome<T>(promise: Promise<T>) {
    return promise.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
  }
  async function waitBlocked(name: string) {
    for (let i = 0; i < 200; i++) {
      const rows = await observer.$queryRaw<
        { blocked: boolean }[]
      >`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity WHERE application_name = ${name}
        AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked`;
      if (rows[0]?.blocked) return;
      await delay(20);
    }
    throw new Error(`expected_live_pg_lock_wait:${name}`);
  }
  async function fixture() {
    // Clear only this disposable database's controls, including its seeded global
    // emergency stop. Runtime mutations below always use production repositories.
    await observer.reviewSafetyPolicySelector.deleteMany();
    await observer.reviewSafetyPolicy.deleteMany();
    await observer.reviewSafetyEmergencyControl.deleteMany();
    return createTarget();
  }
  async function createTarget(existingWorkspaceId?: string) {
    const workspaceId = existingWorkspaceId ?? randomUUID();
    const repositoryId = randomUUID();
    const scmRepositoryIdentityId = randomUUID();
    if (!existingWorkspaceId)
      await observer.workspace.create({
        data: {
          id: workspaceId,
          slug: workspaceId,
          name: "Disposable r123 scope",
        },
      });
    await observer.$transaction(async (tx) => {
      await tx.scmRepositoryIdentity.create({
        data: {
          scmRepositoryIdentityId,
          provider: "github",
          normalizedSourceBaseUrl: "https://github.com",
          externalRepositoryId: repositoryId,
          currentWorkspaceId: workspaceId,
          currentRepositoryConnectionId: repositoryId,
          createdAt: registeredAt,
          boundAt: registeredAt,
        },
      });
      // The actual migration has composite safety FKs omitted from Prisma's model.
      // Explicit parent columns avoid later inventory fields outside this prefix.
      await tx.$executeRaw`INSERT INTO "RepositoryConnection"
      ("id", "workspaceId", "scmRepositoryIdentityId", "provider", "sourceBaseUrl", "externalRepositoryId", "owner", "name", "fullName", "defaultBranch", "visibility", "updatedAt")
      VALUES (${repositoryId}, ${workspaceId}, ${scmRepositoryIdentityId}, 'github', 'https://github.com', ${repositoryId}, 'test', 'scope', ${repositoryId}, 'main', 'private', ${registeredAt})`;
    });
    return {
      scope: "repository" as const,
      workspaceId,
      repositoryId,
      scmRepositoryIdentityId,
      id: randomUUID(),
    };
  }
  type Target = Awaited<ReturnType<typeof fixture>>;
  const kinds = [
    "policy-global",
    "policy-workspace",
    "policy-repository",
    "emergency-global",
    "emergency-workspace",
    "emergency-repository",
    "selector-replace",
    "release-retire",
  ] as const;
  type Kind = (typeof kinds)[number];
  function safetyScope(kind: Kind, target: Target) {
    if (kind.endsWith("global"))
      return { scope: ReviewSafetyPolicyScope.Global } as const;
    if (kind.endsWith("workspace"))
      return {
        scope: ReviewSafetyPolicyScope.Workspace,
        workspaceId: target.workspaceId,
      } as const;
    return {
      scope: ReviewSafetyPolicyScope.Repository,
      workspaceId: target.workspaceId,
      repositoryConnectionId: target.repositoryId,
      scmRepositoryIdentityId: target.scmRepositoryIdentityId,
    } as const;
  }
  async function mutate(db: PrismaClient, kind: Kind, target: Target) {
    if (kind === "release-retire") {
      expect(
        (
          await new PrismaProducerReleaseRepository(db).revokeProducerRelease({
            producerReleaseId: target.id,
            revokedAt: registeredAt,
          })
        ).status,
      ).toBe("revoked");
    } else if (kind.startsWith("emergency")) {
      expect(
        (
          await new PrismaReviewSafetyControlRepository(
            db,
          ).putReviewSafetyEmergencyControl({
            expectedVersion: 0,
            control: emergencyFixture(safetyScope(kind, target), target.id),
          })
        ).status,
      ).toBe("created");
    } else {
      const replacing = kind === "selector-replace";
      expect(
        (
          await new PrismaReviewSafetyControlRepository(
            db,
          ).putReviewSafetyPolicy({
            expectedVersion: replacing ? 1 : 0,
            policy: {
              ...policyFixture(safetyScope(kind, target), target.id),
              version: replacing ? 2 : 1,
            },
          })
        ).status,
      ).toBe(replacing ? "updated" : "created");
    }
  }
  async function read(
    tx: Prisma.TransactionClient,
    kind: Kind,
    target: Target,
  ) {
    if (kind === "release-retire")
      return (
        (
          await tx.producerRelease.findUnique({
            where: { producerReleaseId: target.id },
          })
        )?.state ?? "absent"
      );
    if (kind.startsWith("emergency"))
      return (
        await tx.reviewSafetyEmergencyControl.findUnique({
          where: { emergencyControlId: target.id },
        })
      )?.stopped
        ? "stopped"
        : "absent";
    const row = await tx.reviewSafetyPolicy.findUnique({
      where: { policyId: target.id },
    });
    if (!row) return "absent";
    const selectors = await tx.reviewSafetyPolicySelector.findMany({
      where: { policyId: target.id },
    });
    return `version:${row.version}/selectors:${selectors.length}`;
  }
  async function prepare(kind: Kind, target: Target) {
    if (kind === "release-retire") {
      const repo = new PrismaProducerReleaseRepository(observer);
      await repo.registerProtocolLimitsProfile(limitsProfile);
      await repo.registerOperationalSloProfile(sloProfile);
      expect(
        (await repo.registerProducerRelease(releaseFixture(target.id))).status,
      ).toBe("created");
    }
    if (kind === "selector-replace")
      expect(
        (
          await new PrismaReviewSafetyControlRepository(
            observer,
          ).putReviewSafetyPolicy({
            expectedVersion: 0,
            policy: policyFixture(safetyScope(kind, target), target.id, false),
          })
        ).status,
      ).toBe("created");
  }
  const before = (kind: Kind) =>
    kind === "release-retire"
      ? "registered"
      : kind === "selector-replace"
        ? "version:1/selectors:0"
        : "absent";
  const after = (kind: Kind) =>
    kind === "release-retire"
      ? "revoked"
      : kind.startsWith("emergency")
        ? "stopped"
        : kind === "selector-replace"
          ? "version:2/selectors:1"
          : "version:1/selectors:1";

  it.each(kinds)(
    "%s reader first holds actual writer, including absent rows",
    async (kind) => {
      const target = await fixture();
      await prepare(kind, target);
      const entered = latch();
      const release = latch();
      const reading = outcome(
        reader.$transaction(async (tx) => {
          await acquireCurrentScopeGuards(tx, [{ ...target, mode: "shared" }]);
          expect(await read(tx, kind, target)).toBe(before(kind));
          entered.release();
          await release.promise;
          expect(await read(tx, kind, target)).toBe(before(kind));
        }),
      );
      let writing: ReturnType<typeof outcome> | undefined;
      try {
        await Promise.race([
          entered.promise,
          reading.then((result) => {
            if (!result.ok) throw result.error;
          }),
        ]);
        writing = outcome(mutate(writer, kind, target));
        await waitBlocked("r123-writer");
        // Independent repository scopes in this workspace remain concurrent.
        if (
          kind === "policy-repository" ||
          kind === "emergency-repository" ||
          kind === "selector-replace"
        ) {
          const sibling = await createTarget(target.workspaceId);
          await prepare(kind, sibling);
          await mutate(observer, kind, sibling);
          expect(await read(observer, kind, sibling)).toBe(after(kind));
        }
        release.release();
        expect((await reading).ok).toBe(true);
        expect((await writing).ok).toBe(true);
        expect(await read(observer, kind, target)).toBe(after(kind));
      } finally {
        release.release();
        await reading;
        if (writing) await writing;
      }
    },
  );

  it.each(kinds)(
    "%s writer first commits before reader rereads",
    async (kind) => {
      const target = await fixture();
      await prepare(kind, target);
      const entered = latch();
      const release = latch();
      // Transparent root facade holds the REAL production transaction callback
      // after mutation, before commit; options and actual callback client preserved.
      const heldWriter = new Proxy(writer, {
        get(db, key) {
          if (key === "$transaction")
            return (
              work: (tx: Prisma.TransactionClient) => Promise<unknown>,
              options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
            ) =>
              db.$transaction(async (tx) => {
                const value = await work(tx);
                entered.release();
                await release.promise;
                return value;
              }, options);
          const value = Reflect.get(db, key);
          return typeof value === "function" ? value.bind(db) : value;
        },
      });
      const writing = outcome(mutate(heldWriter, kind, target));
      let reading: ReturnType<typeof outcome> | undefined;
      try {
        await Promise.race([
          entered.promise,
          writing.then((result) => {
            if (!result.ok) throw result.error;
          }),
        ]);
        reading = outcome(
          reader.$transaction(async (tx) => {
            await acquireCurrentScopeGuards(tx, [
              { ...target, mode: "shared" },
            ]);
            return read(tx, kind, target);
          }),
        );
        await waitBlocked("r123-reader");
        release.release();
        expect((await writing).ok).toBe(true);
        expect(await reading).toEqual({ ok: true, value: after(kind) });
      } finally {
        release.release();
        await writing;
        if (reading) await reading;
      }
    },
  );
});
