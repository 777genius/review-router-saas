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
import { PrismaRepositoryWebhookHandler } from "../apps/api/src/github/prisma-repository-webhook-handler";

// Root-only opt-in; authentic local source catalog and offline managed PG image.
describe.skipIf(
  process.env.REVIEW_ROUTER_RUN_REPOSITORY_WEBHOOK_SCOPE_PG17 !== "1",
)("repository webhook production writer / PG17", () => {
  const pg = managedPg17Fixture();
  const database = "repository_webhook_scope_test";
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
    expect(count).toBe(92);
    const applied = await pg.apply(database, count, "r128-current-scope")
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
    reader = client("r128-reader");
    writer = client("r128-writer");
    observer = client("r128-observer");
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
  let sequence = 100000n;
  const kinds = [
    "deleted-repository",
    "deleted-workspace",
    "metadata-repository",
    "metadata-workspace",
  ] as const;
  type Kind = (typeof kinds)[number];
  async function fixture() {
    const workspaceId = randomUUID();
    const installationWorkspaceId = randomUUID();
    for (const id of [workspaceId, installationWorkspaceId])
      await observer.workspace.create({ data: { id, slug: id, name: id } });
    const installation = await observer.gitHubInstallation.create({
      data: {
        workspaceId: installationWorkspaceId,
        githubInstallationId: sequence++,
        accountLogin: installationWorkspaceId,
        accountType: "Organization",
        repositorySelection: "all",
      },
    });
    const repositoryId = randomUUID();
    const githubRepositoryId = sequence++;
    await observer.repositoryConnection.create({
      data: {
        id: repositoryId,
        workspaceId,
        installationId: installation.id,
        githubRepositoryId,
        externalRepositoryId: String(githubRepositoryId),
        owner: "old",
        name: repositoryId,
        fullName: `old/${repositoryId}`,
        defaultBranch: "main",
        visibility: "public",
        archived: false,
        selected: true,
        stargazersCount: 1,
      },
    });
    return {
      workspaceId,
      repositoryId,
      installationId: installation.id,
      githubInstallationId: installation.githubInstallationId,
      githubRepositoryId,
    };
  }
  type Target = Awaited<ReturnType<typeof fixture>>;
  function scopes(kind: Kind, target: Target) {
    return [
      kind.endsWith("workspace")
        ? {
            scope: "workspace" as const,
            workspaceId: target.workspaceId,
            mode: "shared" as const,
          }
        : {
            scope: "repository" as const,
            workspaceId: target.workspaceId,
            repositoryId: target.repositoryId,
            mode: "shared" as const,
          },
    ];
  }
  async function mutate(db: PrismaClient, kind: Kind, target: Target) {
    return new PrismaRepositoryWebhookHandler(db).handleGitHubRepositoryWebhook(
      {
        deliveryId: randomUUID(),
        eventName: "repository",
        payload: {
          action: kind.startsWith("deleted") ? "deleted" : "edited",
          installation: {
            id: Number(target.githubInstallationId),
            account: { login: "test", type: "Organization" },
            repository_selection: "all",
          },
          repository: {
            id: Number(target.githubRepositoryId),
            owner: { login: "new" },
            name: `renamed-${target.repositoryId}`,
            full_name: `new/renamed-${target.repositoryId}`,
            default_branch: "trunk",
            visibility: "private",
            private: true,
            archived: true,
            stargazers_count: 9,
          },
        },
      },
    );
  }
  async function read(tx: Prisma.TransactionClient, target: Target) {
    const repository = await tx.repositoryConnection.findUniqueOrThrow({
      where: { githubRepositoryId: target.githubRepositoryId },
    });
    expect(repository.id).toBe(target.repositoryId);
    expect(repository.workspaceId).toBe(target.workspaceId);
    expect(repository.installationId).toBe(target.installationId);
    return {
      selected: repository.selected,
      owner: repository.owner,
      name: repository.name,
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      visibility: repository.visibility,
      archived: repository.archived,
      stargazersCount: repository.stargazersCount,
    };
  }
  const before = (target: Target) => ({
    selected: true,
    owner: "old",
    name: target.repositoryId,
    fullName: `old/${target.repositoryId}`,
    defaultBranch: "main",
    visibility: "public",
    archived: false,
    stargazersCount: 1,
  });
  const after = (kind: Kind, target: Target) =>
    kind.startsWith("deleted")
      ? { ...before(target), selected: false }
      : {
          selected: true,
          owner: "new",
          name: `renamed-${target.repositoryId}`,
          fullName: `new/renamed-${target.repositoryId}`,
          defaultBranch: "trunk",
          visibility: "private",
          archived: true,
          stargazersCount: 9,
        };

  it.each(kinds)(
    "%s reader first holds actual writer, before discovery",
    async (kind) => {
      const target = await fixture();
      const entered = latch();
      const release = latch();
      const reading = outcome(
        reader.$transaction(
          async (tx) => {
            expect(await tx.$queryRaw`SHOW transaction_isolation`).toEqual([
              { transaction_isolation: "read committed" },
            ]);
            await acquireCurrentScopeGuards(tx, scopes(kind, target));
            expect(await read(tx, target)).toEqual(before(target));
            entered.release();
            await release.promise;
            expect(await read(tx, target)).toEqual(before(target));
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
        await waitBlocked("r128-writer");
        release.release();
        expect((await reading).ok).toBe(true);
        expect((await writing).ok).toBe(true);
        expect(await read(observer, target)).toEqual(after(kind, target));
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
              expect(await tx.$queryRaw`SHOW transaction_isolation`).toEqual([
                { transaction_isolation: "read committed" },
              ]);
              expect(await read(tx, target)).toEqual(before(target));
              await acquireCurrentScopeGuards(tx, scopes(kind, target));
              return read(tx, target);
            },
            { isolationLevel: "ReadCommitted" },
          ),
        );
        await waitBlocked("r128-reader");
        release.release();
        expect((await writing).ok).toBe(true);
        expect(await reading).toEqual({ ok: true, value: after(kind, target) });
      } finally {
        release.release();
        await writing;
        if (reading) await reading;
      }
    },
  );
});
