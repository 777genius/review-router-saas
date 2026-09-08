import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { managedPg17Fixture } from "./lib/render-managed-pg17-fixture";
import { readRenderSchemaHandoffCatalog } from "./lib/render-schema-handoff-policy.mjs";
import { acquireCurrentScopeGuards } from "../packages/platform/db/src/current-scope-guards";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { renderSchemaHandoffCheckoutExtension } from "./lib/render-schema-handoff-policy.mjs";
import { PrismaGitHubInstallationRepository } from "../packages/features/github-installations/src/infrastructure/prisma/prisma-github-installation-repository";
import { PrismaRepositoryConnectionRepository } from "../packages/features/repositories/src/infrastructure/prisma/prisma-repository-connection-repository";

// Root-only opt-in; authentic local source catalog and offline managed PG image.
describe.skipIf(process.env.REVIEW_ROUTER_RUN_INSTALLATION_SCOPE_PG17 !== "1")(
  "installation/inventory production writers / PG17",
  () => {
    const pg = managedPg17Fixture();
    const database = "installation_scope_test";
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
      const last = "000089_codex_oauth_v4_v5_staged_compatibility";
      const count =
        catalog.findIndex((entry) => entry.migrationName === last) + 1;
      expect(count).toBeGreaterThan(0);
      const applied = await pg.apply(database, count, "r124-current-scope")
        .result;
      expect(applied).toHaveLength(count);
      expect(applied.at(-1)).toBe(last);
      // The unchanged managed fixture deliberately excludes these checkout
      // migrations. Apply their exact checked-in SQL, never an ad hoc overlay.
      expect(renderSchemaHandoffCheckoutExtension.at(-1)?.migrationName).toBe(
        "000091_workflow_provisioning_artifact_and_inventory",
      );
      for (const migration of renderSchemaHandoffCheckoutExtension) {
        const sql = readFileSync(
          new URL(
            `../packages/platform/db/prisma/migrations/${migration.migrationName}/migration.sql`,
            import.meta.url,
          ),
          "utf8",
        );
        expect(createHash("sha256").update(sql).digest("hex")).toBe(
          migration.checksum,
        );
        pg.query(database, `BEGIN;\n${sql}\nCOMMIT;`);
      }
      reader = client("r124-reader");
      writer = client("r124-writer");
      observer = client("r124-observer");
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
    let sequence = 100000n;
    type Kind =
      | "uninstall"
      | "suspend"
      | "unselect"
      | "insert"
      | "select"
      | "transfer-old"
      | "transfer-new";
    const kinds: Kind[] = [
      "uninstall",
      "suspend",
      "unselect",
      "insert",
      "select",
      "transfer-old",
      "transfer-new",
    ];
    async function fixture(kind: Kind) {
      const workspaceId = randomUUID();
      const otherWorkspaceId = randomUUID();
      for (const id of [workspaceId, otherWorkspaceId])
        await observer.workspace.create({ data: { id, slug: id, name: id } });
      const githubInstallationId = String(sequence++);
      const oldInstallation = await observer.gitHubInstallation.create({
        data: {
          workspaceId: otherWorkspaceId,
          githubInstallationId: sequence++,
          accountLogin: otherWorkspaceId,
          accountType: "Organization",
          repositorySelection: "all",
        },
      });
      const installation = await observer.gitHubInstallation.create({
        data: {
          workspaceId,
          githubInstallationId: BigInt(githubInstallationId),
          accountLogin: workspaceId,
          accountType: "Organization",
          repositorySelection: "all",
        },
      });
      const githubRepositoryId = String(sequence++);
      const repositoryId = randomUUID();
      const snapshot = {
        githubRepositoryId,
        owner: "test",
        name: repositoryId,
        fullName: `test/${repositoryId}`,
        defaultBranch: "main",
        visibility: "private" as const,
        archived: false,
        stargazersCount: 0,
      };
      const transfer = kind.startsWith("transfer");
      // Uninstall/unselect/suspend intentionally target a repository in a DIFFERENT
      // workspace from the installation, proving installation-wide fanout fencing.
      const oldWorkspaceId =
        transfer || ["uninstall", "unselect", "suspend"].includes(kind)
          ? otherWorkspaceId
          : workspaceId;
      if (kind !== "insert")
        await observer.repositoryConnection.create({
          data: {
            ...snapshot,
            githubRepositoryId: BigInt(githubRepositoryId),
            id: repositoryId,
            externalRepositoryId: githubRepositoryId,
            workspaceId: oldWorkspaceId,
            installationId: transfer ? oldInstallation.id : installation.id,
            selected: kind !== "select",
          },
        });
      const siblingId = randomUUID();
      if (["uninstall", "unselect", "suspend"].includes(kind)) {
        await observer.repositoryConnection.create({
          data: {
            ...snapshot,
            githubRepositoryId: sequence++,
            id: siblingId,
            externalRepositoryId: siblingId,
            workspaceId,
            installationId: installation.id,
          },
        });
      }
      return {
        scope: "repository" as const,
        workspaceId: kind === "transfer-new" ? workspaceId : oldWorkspaceId,
        repositoryId,
        siblingId,
        githubInstallationId,
        githubRepositoryId,
        snapshot,
        destinationWorkspaceId: workspaceId,
        inventoryGeneration: await new PrismaRepositoryConnectionRepository(
          observer,
        ).beginInstallationInventory(),
      };
    }
    type Target = Awaited<ReturnType<typeof fixture>>;
    async function mutate(db: PrismaClient, kind: Kind, target: Target) {
      const installations = new PrismaGitHubInstallationRepository(db);
      if (kind === "uninstall")
        return installations.markInstallationRemoved(
          target.githubInstallationId,
        );
      if (kind === "suspend")
        return installations.upsertInstallation({
          githubInstallationId: target.githubInstallationId,
          accountLogin: target.destinationWorkspaceId,
          accountType: "Organization",
          repositorySelection: "all",
          status: "suspended",
        });
      return new PrismaRepositoryConnectionRepository(
        db,
      ).syncInstallationRepositories({
        githubInstallationId: target.githubInstallationId,
        repositories: kind === "unselect" ? [] : [target.snapshot],
        syncedAt: new Date(),
        inventoryGeneration: target.inventoryGeneration,
      });
    }
    async function read(
      tx: Prisma.TransactionClient,
      kind: Kind,
      target: Target,
    ) {
      const installation = await tx.gitHubInstallation.findUniqueOrThrow({
        where: { githubInstallationId: BigInt(target.githubInstallationId) },
      });
      const repository = await tx.repositoryConnection.findUnique({
        where: { githubRepositoryId: BigInt(target.githubRepositoryId) },
      });
      if (kind === "uninstall" || kind === "unselect") {
        const sibling = await tx.repositoryConnection.findUniqueOrThrow({
          where: { id: target.siblingId },
        });
        expect(sibling.selected).toBe(repository?.selected);
      }
      if (kind === "uninstall")
        return `${installation.status}:${repository?.selected}`;
      if (kind === "suspend") return installation.status;
      if (kind.startsWith("transfer"))
        return repository?.workspaceId === target.destinationWorkspaceId
          ? "new"
          : "old";
      return repository ? String(repository.selected) : "absent";
    }
    const before = (kind: Kind) =>
      kind === "uninstall"
        ? "active:true"
        : kind === "suspend"
          ? "active"
          : kind === "insert"
            ? "absent"
            : kind === "select"
              ? "false"
              : kind.startsWith("transfer")
                ? "old"
                : "true";
    const after = (kind: Kind) =>
      kind === "uninstall"
        ? "removed:false"
        : kind === "suspend"
          ? "suspended"
          : kind === "unselect"
            ? "false"
            : kind.startsWith("transfer")
              ? "new"
              : "true";

    it.each(kinds)(
      "%s reader first holds actual writer, including absent rows",
      async (kind) => {
        const target = await fixture(kind);
        const entered = latch();
        const release = latch();
        const reading = outcome(
          reader.$transaction(
            async (tx) => {
              await acquireCurrentScopeGuards(tx, [
                kind === "insert"
                  ? {
                      scope: "workspace",
                      workspaceId: target.workspaceId,
                      mode: "shared",
                    }
                  : {
                      scope: "repository",
                      workspaceId: target.workspaceId,
                      repositoryId: target.repositoryId,
                      mode: "shared",
                    },
              ]);
              expect(await read(tx, kind, target)).toBe(before(kind));
              entered.release();
              await release.promise;
              expect(await read(tx, kind, target)).toBe(before(kind));
            },
            { isolationLevel: "ReadCommitted" },
          ),
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
          await waitBlocked("r124-writer");
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
        const target = await fixture(kind);
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
            reader.$transaction(
              async (tx) => {
                expect(await read(tx, kind, target)).toBe(before(kind));
                await acquireCurrentScopeGuards(tx, [
                  kind === "insert"
                    ? {
                        scope: "workspace",
                        workspaceId: target.workspaceId,
                        mode: "shared",
                      }
                    : {
                        scope: "repository",
                        workspaceId: target.workspaceId,
                        repositoryId: target.repositoryId,
                        mode: "shared",
                      },
                ]);
                return read(tx, kind, target);
              },
              { isolationLevel: "ReadCommitted" },
            ),
          );
          await waitBlocked("r124-reader");
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
  },
);
