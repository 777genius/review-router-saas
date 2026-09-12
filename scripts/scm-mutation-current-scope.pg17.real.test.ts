import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { managedPg17Fixture } from "./lib/render-managed-pg17-fixture";
import { readRenderSchemaHandoffCatalog } from "./lib/render-schema-handoff-policy.mjs";
import { acquireCurrentScopeGuards } from "../packages/platform/db/src/current-scope-guards";
import { PrismaScmRepositoryIdentityRepository } from "../packages/features/review-run-control/src/infrastructure/prisma/prisma-scm-repository-identity-repository";
import { PrismaReviewMutationAuthorityRepository } from "../packages/features/review-run-control/src/infrastructure/prisma/prisma-review-mutation-authority-repository";
import { ReviewMutationMode } from "../packages/features/review-run-control/src/domain/review-run-control-types";
import {
  identityFixture,
  authorityFixture,
  changedAt,
} from "../packages/features/review-run-control/src/tests/scm-mutation-current-scope-fixtures";

// Root-only opt-in; authentic local source catalog and offline managed PG image.
describe.skipIf(process.env.REVIEW_ROUTER_RUN_SCM_MUTATION_SCOPE_PG17 !== "1")(
  "SCM identity and App mutation production current scope writers / PG17",
  () => {
    const pg = managedPg17Fixture();
    const database = "scm_mutation_scope_test";
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
      const applied = await pg.apply(database, count, "r127-current-scope")
        .result;
      expect(applied).toHaveLength(count);
      expect(applied.at(-1)).toBe(last);
      reader = client("r127-reader");
      writer = client("r127-writer");
      observer = client("r127-observer");
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
    const kinds = [
      "register",
      "bind",
      "unbind",
      "rebind-old",
      "rebind-new",
      "init-bound",
      "init-unbound",
      "state-cas",
      "epoch-cas",
    ] as const;
    type Kind = (typeof kinds)[number];
    async function parent(externalId: string, sourceBaseUrl: string) {
      const workspaceId = randomUUID();
      const repositoryId = randomUUID();
      await observer.workspace.create({
        data: {
          id: workspaceId,
          slug: workspaceId,
          name: "Disposable r127 scope",
        },
      });
      // Only parent fixture insertion uses SQL, to avoid later inventory columns.
      // Binding on this repository row is changed exclusively by the production repo.
      await observer.$executeRaw`INSERT INTO "RepositoryConnection"
      ("id", "workspaceId", "provider", "sourceBaseUrl", "externalRepositoryId", "owner", "name", "fullName", "defaultBranch", "visibility", "updatedAt")
      VALUES (${repositoryId}, ${workspaceId}, 'github', ${sourceBaseUrl}, ${externalId}, 'test', 'scope', ${repositoryId}, 'main', 'private', ${changedAt})`;
      return { scope: "repository" as const, workspaceId, repositoryId };
    }
    async function fixture() {
      const scmRepositoryIdentityId = randomUUID();
      const externalId = randomUUID();
      const old = await parent(externalId, "https://github.com");
      // Distinct storage rows / workspaces for the same normalized external identity.
      // The raw URL unique key permits these spellings; production bind normalizes it.
      const destination = await parent(externalId, "https://github.com/");
      return {
        old,
        destination,
        identity: identityFixture(scmRepositoryIdentityId, externalId),
        authority: authorityFixture(scmRepositoryIdentityId),
      };
    }
    type Target = Awaited<ReturnType<typeof fixture>>;
    const repositories = (db: PrismaClient) => ({
      identities: new PrismaScmRepositoryIdentityRepository(db),
      authorities: new PrismaReviewMutationAuthorityRepository(db),
    });
    const bindInput = (target: Target, destination = false) => ({
      scmRepositoryIdentityId: target.identity.scmRepositoryIdentityId,
      expectedVersion: destination ? 3 : 1,
      workspaceId: (destination ? target.destination : target.old).workspaceId,
      repositoryConnectionId: (destination ? target.destination : target.old)
        .repositoryId,
      boundAt: changedAt,
    });
    const unbindInput = (target: Target) => ({
      scmRepositoryIdentityId: target.identity.scmRepositoryIdentityId,
      expectedVersion: 2,
      unboundAt: changedAt,
      authority: { laneKind: target.authority.laneKind, expectedVersion: 1 },
    });
    async function prepare(kind: Kind, target: Target) {
      const { identities, authorities } = repositories(observer);
      if (kind === "register") return;
      expect(
        (
          await identities.resolveOrRegisterScmRepositoryIdentity({
            identity: target.identity,
          })
        ).status,
      ).toBe("created");
      if (kind === "bind" || kind === "init-unbound") return;
      expect(
        (await identities.bindScmRepositoryIdentity(bindInput(target))).status,
      ).toBe("bound");
      if (kind === "init-bound") return;
      const paused = kind !== "state-cas";
      expect(
        (
          await authorities.initializeReviewMutationAuthority({
            ...target.authority,
            ...(paused
              ? { mode: ReviewMutationMode.Paused, pausedAt: changedAt }
              : {}),
          })
        ).status,
      ).toBe("created");
      if (kind.startsWith("rebind"))
        expect(
          (await identities.unbindScmRepositoryIdentity(unbindInput(target)))
            .status,
        ).toBe("unbound");
    }
    async function mutate(db: PrismaClient, kind: Kind, target: Target) {
      const { identities, authorities } = repositories(db);
      if (kind === "register") {
        expect(
          (
            await identities.resolveOrRegisterScmRepositoryIdentity({
              identity: target.identity,
            })
          ).status,
        ).toBe("created");
      } else if (kind === "bind" || kind.startsWith("rebind")) {
        expect(
          (
            await identities.bindScmRepositoryIdentity(
              bindInput(target, kind.startsWith("rebind")),
            )
          ).status,
        ).toBe("bound");
      } else if (kind === "unbind") {
        expect(
          (await identities.unbindScmRepositoryIdentity(unbindInput(target)))
            .status,
        ).toBe("unbound");
      } else if (kind.startsWith("init")) {
        expect(
          (
            await authorities.initializeReviewMutationAuthority(
              target.authority,
            )
          ).status,
        ).toBe("created");
      } else {
        const authority =
          kind === "state-cas"
            ? {
                ...target.authority,
                version: 2,
                mode: ReviewMutationMode.Paused,
                pausedAt: changedAt,
              }
            : { ...target.authority, version: 2, epoch: 2n };
        expect(
          (
            await authorities.compareAndSetReviewMutationAuthority({
              expectedVersion: 1,
              authority,
            })
          ).status,
        ).toBe("updated");
      }
    }
    async function read(
      tx: Prisma.TransactionClient,
      _kind: Kind,
      target: Target,
    ) {
      const identity = await tx.scmRepositoryIdentity.findUnique({
        where: {
          scmRepositoryIdentityId: target.identity.scmRepositoryIdentityId,
        },
        select: {
          version: true,
          currentWorkspaceId: true,
          currentRepositoryConnectionId: true,
          provider: true,
          normalizedSourceBaseUrl: true,
          externalRepositoryId: true,
        },
      });
      const authority = await tx.reviewMutationAuthority.findUnique({
        where: {
          scmRepositoryIdentityId_laneKind: {
            scmRepositoryIdentityId: target.identity.scmRepositoryIdentityId,
            laneKind: "hosted_reviewrouter_app",
          },
        },
        select: { version: true, epoch: true, mode: true },
      });
      const bindings = await tx.repositoryConnection.findMany({
        where: {
          id: {
            in: [target.old.repositoryId, target.destination.repositoryId],
          },
        },
        select: { id: true, scmRepositoryIdentityId: true },
      });
      return {
        identity,
        authority,
        oldBinding: bindings.find((row) => row.id === target.old.repositoryId)
          ?.scmRepositoryIdentityId,
        newBinding: bindings.find(
          (row) => row.id === target.destination.repositoryId,
        )?.scmRepositoryIdentityId,
      };
    }
    function expected(kind: Kind, target: Target, committed: boolean) {
      const rebinding = kind.startsWith("rebind");
      const absent = kind === "register" && !committed;
      const unbound =
        kind === "register" ||
        kind === "init-unbound" ||
        (kind === "bind" && !committed) ||
        (kind === "unbind" && committed) ||
        (rebinding && !committed);
      const binding = unbound
        ? null
        : rebinding
          ? target.destination
          : target.old;
      const version = rebinding
        ? committed
          ? 4
          : 3
        : kind === "unbind"
          ? committed
            ? 3
            : 2
          : unbound
            ? 1
            : 2;
      const hasAuthority =
        !["register", "bind"].includes(kind) &&
        (!kind.startsWith("init") || committed);
      const cas = kind.endsWith("cas") && committed;
      const paused =
        kind === "unbind" ||
        rebinding ||
        (kind === "state-cas" && committed) ||
        (kind === "epoch-cas" && !committed);
      return {
        identity: absent
          ? null
          : {
              version,
              currentWorkspaceId: binding?.workspaceId ?? null,
              currentRepositoryConnectionId: binding?.repositoryId ?? null,
              provider: "github",
              normalizedSourceBaseUrl: "https://github.com",
              externalRepositoryId: target.identity.externalRepositoryId,
            },
        authority: hasAuthority
          ? {
              version: cas ? 2 : 1,
              epoch: kind === "epoch-cas" && committed ? 2n : 1n,
              mode: paused ? "paused" : "v2_active",
            }
          : null,
        oldBinding:
          binding === target.old
            ? target.identity.scmRepositoryIdentityId
            : null,
        newBinding:
          binding === target.destination
            ? target.identity.scmRepositoryIdentityId
            : null,
      };
    }
    const before = (kind: Kind, target: Target) =>
      expected(kind, target, false);
    const after = (kind: Kind, target: Target) => expected(kind, target, true);
    const readerScope = (kind: Kind, target: Target) => ({
      ...(kind === "rebind-new" ? target.destination : target.old),
      mode: "shared" as const,
    });

    it.each(kinds)(
      "%s reader first holds actual writer, including absent rows",
      async (kind) => {
        const target = await fixture();
        await prepare(kind, target);
        const entered = latch();
        const release = latch();
        const reading = outcome(
          reader.$transaction(async (tx) => {
            await acquireCurrentScopeGuards(tx, [readerScope(kind, target)]);
            expect(await read(tx, kind, target)).toEqual(before(kind, target));
            entered.release();
            await release.promise;
            expect(await read(tx, kind, target)).toEqual(before(kind, target));
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
          await waitBlocked("r127-writer");
          release.release();
          expect((await reading).ok).toBe(true);
          expect((await writing).ok).toBe(true);
          expect(await read(observer, kind, target)).toEqual(
            after(kind, target),
          );
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
              await acquireCurrentScopeGuards(tx, [readerScope(kind, target)]);
              return read(tx, kind, target);
            }),
          );
          await waitBlocked("r127-reader");
          release.release();
          expect((await writing).ok).toBe(true);
          expect(await reading).toEqual({
            ok: true,
            value: after(kind, target),
          });
        } finally {
          release.release();
          await writing;
          if (reading) await reading;
        }
      },
    );
  },
);
