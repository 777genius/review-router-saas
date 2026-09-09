import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { managedPg17Fixture } from "./lib/render-managed-pg17-fixture";
import { readRenderSchemaHandoffCatalog } from "./lib/render-schema-handoff-policy.mjs";
import { acquireCurrentScopeGuards } from "../packages/platform/db/src/current-scope-guards";
import {
  PrismaReviewConfigurationRepository,
  PrismaReviewConfigurationTransactionRepository,
} from "../packages/features/review-config/src/infrastructure/prisma/prisma-review-configuration-repository";
import { safeDefaultReviewConfiguration } from "../packages/features/review-config/src/domain/review-configuration";
import { PrismaEntitlementRepository } from "../packages/features/entitlements/src/infrastructure/prisma/prisma-entitlement-repository";
import { freeBetaEntitlement } from "../packages/features/entitlements/src/domain/entitlement";

// Root-only opt-in; authentic local source catalog and offline managed PG image.
describe.skipIf(process.env.REVIEW_ROUTER_RUN_CURRENT_SCOPE_PG17 !== "1")(
  "current scope production writers / PG17",
  () => {
    const pg = managedPg17Fixture();
    const database = "current_scope_test";
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
        transactionOptions: { timeout: 20000, maxWait: 5000 },
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
      const applied = await pg.apply(database, count, "r121-current-scope")
        .result;
      expect(applied).toHaveLength(count);
      expect(applied.at(-1)).toBe(last);
      reader = client("r121-reader");
      writer = client("r121-writer");
      observer = client("r121-observer");
      await expect(
        acquireCurrentScopeGuards(reader, [
          { scope: "global", mode: "shared" },
        ]),
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
      const workspaceId = randomUUID();
      const repositoryId = randomUUID();
      await observer.workspace.create({
        data: {
          id: workspaceId,
          slug: workspaceId,
          name: "Disposable scope test",
        },
      });
      // Explicit parent columns avoid requesting later inventory fields from this
      // authentic migration prefix. Config/entitlement writes use production Prisma.
      await observer.$executeRaw`INSERT INTO "RepositoryConnection"
      ("id", "workspaceId", "provider", "sourceBaseUrl", "externalRepositoryId", "owner", "name", "fullName", "defaultBranch", "visibility", "updatedAt")
      VALUES (${repositoryId}, ${workspaceId}, 'github', 'https://github.com', ${repositoryId}, 'test', 'scope', ${repositoryId}, 'main', 'private', ${new Date()})`;
      return { scope: "repository" as const, workspaceId, repositoryId };
    }
    type Target = Awaited<ReturnType<typeof fixture>>;
    type Kind =
      | "repo-insert"
      | "workspace-insert"
      | "repo-delete"
      | "entitlement-insert"
      | "transaction-config";
    const kinds: Kind[] = [
      "repo-insert",
      "workspace-insert",
      "repo-delete",
      "entitlement-insert",
      "transaction-config",
    ];
    function configTarget(kind: Kind, target: Target) {
      return kind === "workspace-insert"
        ? { scope: "workspace" as const, workspaceId: target.workspaceId }
        : target;
    }
    async function mutate(db: PrismaClient, kind: Kind, target: Target) {
      if (kind === "entitlement-insert") {
        await new PrismaEntitlementRepository(db).upsertWorkspaceEntitlement({
          ...freeBetaEntitlement(target.workspaceId),
          status: "paused",
        });
      } else if (kind === "repo-delete") {
        expect(
          await new PrismaReviewConfigurationRepository(db).deleteTarget(
            target,
          ),
        ).toBe(true);
      } else if (kind === "transaction-config") {
        await db.$transaction(async (tx) => {
          await acquireCurrentScopeGuards(tx, [
            { ...target, mode: "exclusive" },
          ]);
          await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${target.workspaceId} FOR UPDATE`;
          await new PrismaReviewConfigurationTransactionRepository(
            tx,
          ).saveNextVersion({
            target,
            config: safeDefaultReviewConfiguration,
            expectedVersion: null,
          });
        });
      } else {
        await new PrismaReviewConfigurationRepository(db).saveNextVersion({
          target: configTarget(kind, target),
          config: safeDefaultReviewConfiguration,
          expectedVersion: null,
        });
      }
    }
    async function read(
      tx: Prisma.TransactionClient,
      kind: Kind,
      target: Target,
    ) {
      if (kind === "entitlement-insert") {
        const row = await tx.workspaceEntitlement.findUnique({
          where: { workspaceId: target.workspaceId },
        });
        return row?.status ?? "absent";
      }
      const row = await new PrismaReviewConfigurationTransactionRepository(
        tx,
      ).findLatest(configTarget(kind, target));
      return row ? `version:${row.version}` : "absent";
    }
    async function prepare(kind: Kind, target: Target) {
      if (kind === "repo-delete")
        await new PrismaReviewConfigurationRepository(observer).saveNextVersion(
          { target, config: safeDefaultReviewConfiguration },
        );
    }
    const before = (kind: Kind) =>
      kind === "repo-delete" ? "version:1" : "absent";
    const after = (kind: Kind) =>
      kind === "repo-delete"
        ? "absent"
        : kind === "entitlement-insert"
          ? "paused"
          : "version:1";

    it.each(kinds)(
      "%s reader first holds actual writer, including absent rows",
      async (kind) => {
        const target = await fixture();
        await prepare(kind, target);
        const entered = latch();
        const release = latch();
        const reading = outcome(
          reader.$transaction(async (tx) => {
            await acquireCurrentScopeGuards(tx, [
              { ...target, mode: "shared" },
            ]);
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
          await waitBlocked("r121-writer");
          // Independent repository scopes in this workspace remain concurrent.
          if (kind === "repo-insert")
            await observer.$transaction(async (tx) => {
              await acquireCurrentScopeGuards(tx, [
                { ...target, repositoryId: "unrelated", mode: "exclusive" },
              ]);
            });
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
          await waitBlocked("r121-reader");
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
    it.each(["reader-first", "global-first"] as const)(
      "global exclusivity: %s",
      async (order) => {
        const target = await fixture();
        const entered = latch();
        const release = latch();
        const globalFirst = order === "global-first";
        const first = outcome(
          (globalFirst ? writer : reader).$transaction(async (tx) => {
            await acquireCurrentScopeGuards(
              tx,
              globalFirst
                ? [{ scope: "global", mode: "exclusive" }]
                : [{ ...target, mode: "shared" }],
            );
            entered.release();
            await release.promise;
          }),
        );
        let second: ReturnType<typeof outcome> | undefined;
        try {
          await Promise.race([
            entered.promise,
            first.then((result) => {
              if (!result.ok) throw result.error;
            }),
          ]);
          second = outcome(
            (globalFirst ? reader : writer).$transaction(async (tx) => {
              await acquireCurrentScopeGuards(
                tx,
                globalFirst
                  ? [{ ...target, mode: "shared" }]
                  : [{ scope: "global", mode: "exclusive" }],
              );
            }),
          );
          await waitBlocked(globalFirst ? "r121-reader" : "r121-writer");
          release.release();
          expect((await first).ok).toBe(true);
          expect((await second).ok).toBe(true);
        } finally {
          release.release();
          await first;
          if (second) await second;
        }
      },
    );
  },
);
