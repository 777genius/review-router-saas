import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  checkedDatabaseTarget,
  assertEmptyDatabase,
} from "./database-target.mjs";
import { ProviderAccountError } from "../src/domain/provider-account";
import {
  bindWorkspaceAccount,
  resolveWorkspaceAccountBinding,
  revokeWorkspaceAccountBinding,
} from "../src/application/use-cases/workspace-account-bindings";

import { runBindingFencePostgresTests } from "./postgres-fences";

const enabled = process.env.RR_PROVIDER_ACCOUNTS_PG_TEST === "1";
const denied = (code: string) => (error: unknown) =>
  error instanceof ProviderAccountError && error.code === code;

// Regressions: SQL permits XOR/owner transfer/revision rollback; the real adapter
// loses a CAS race; current workspace or live stable-ID membership is not enforced.
// Main-owned opt-in only. This file never provisions a database/cluster or reads
// ambient DATABASE_URL/PGPASSWORD. Historical migrations require a disposable
// cluster because their existing SQL also installs cluster-wide release roles.
test(
  "C1 full-schema migrations and actual Prisma/PostgreSQL boundaries",
  {
    skip: !enabled,
    timeout: 240_000,
  },
  async (t) => {
    assert.equal(
      process.env.RR_PROVIDER_ACCOUNTS_DISPOSABLE_CLUSTER,
      "1",
      "explicit disposable cluster required",
    );
    const target = checkedDatabaseTarget(
      process.env.RR_PROVIDER_ACCOUNTS_PG_TEST_URL ?? "",
    );
    const [
      { Client },
      { PrismaClient },
      { PrismaPg },
      { PrismaProviderAccountRepository },
      { PrismaProviderAccountSynchronization },
      { PrismaWorkspaceAccessRepository },
    ] = await Promise.all([
      import("pg"),
      import("@prisma/client"),
      import("@prisma/adapter-pg"),
      import("../src/infrastructure/prisma/prisma-provider-account-repository"),
      import("../src/infrastructure/prisma/prisma-provider-account-synchronization"),
      import("../../auth/src/infrastructure/prisma/prisma-workspace-access-repository"),
    ]);
    const sql = new Client(target);
    await sql.connect();
    let prisma: InstanceType<typeof PrismaClient> | undefined;
    try {
      // Refuse any preexisting application object before the first write.
      await assertEmptyDatabase(sql);
      const migrations = new URL(
        "../../../platform/db/prisma/migrations/",
        import.meta.url,
      );
      const names = (await readdir(migrations))
        .filter((name) => /^\d{6}_/.test(name))
        .sort();
      assert.ok(names.includes("000117_provider_accounts"));
      assert.ok(names.includes("000118_workspace_binding_fences"));
      for (const name of names) {
        if (name === "000118_workspace_binding_fences") {
          // Existing 117 rows prove that 118 initializes policy independently.
          await sql.query(`INSERT INTO "Workspace" ("id", "slug", "name", "updatedAt")
            VALUES ('c2a-bootstrap-workspace', 'c2a-bootstrap-workspace', 'Synthetic bootstrap', now());
            INSERT INTO "ProviderAccountConnection" ("id", "ownerWorkspaceId", "gatewayAccountRef", "displayName", "state", "updatedAt") VALUES
            ('c2a-bootstrap-active-connection', 'c2a-bootstrap-workspace', 'c2a-bootstrap-active-account', 'Active bootstrap', 'active', now()),
            ('c2a-bootstrap-revoked-connection', 'c2a-bootstrap-workspace', 'c2a-bootstrap-revoked-account', 'Revoked bootstrap', 'active', now());
            INSERT INTO "WorkspaceAccountBinding" ("id", "workspaceId", "connectionId", "state", "updatedAt") VALUES
            ('c2a-bootstrap-active', 'c2a-bootstrap-workspace', 'c2a-bootstrap-active-connection', 'active', now()),
            ('c2a-bootstrap-revoked', 'c2a-bootstrap-workspace', 'c2a-bootstrap-revoked-connection', 'active', now());
            UPDATE "WorkspaceAccountBinding" SET "revision" = 2, "state" = 'revoked' WHERE "id" = 'c2a-bootstrap-revoked';
            UPDATE "WorkspaceAccountBinding" SET "revision" = 2 WHERE "id" = 'c2a-bootstrap-active';
            UPDATE "WorkspaceAccountBinding" SET "revision" = 3 WHERE "id" = 'c2a-bootstrap-active';`);
        }
        const migration = await readFile(
          new URL(`${name}/migration.sql`, migrations),
          "utf8",
        );
        // psql executes statements individually. A multi-statement pg query wraps
        // historical CONCURRENTLY/enum migrations in an implicit transaction.
        const applied = spawnSync(
          "psql",
          [
            "-X",
            "--no-password",
            "-v",
            "ON_ERROR_STOP=1",
            "-h",
            target.host,
            "-p",
            String(target.port),
            "-U",
            target.user,
            "-d",
            target.database,
          ],
          {
            input: migration,
            encoding: "utf8",
            timeout: 60_000,
            env: {
              PATH: process.env.PATH,
              PGPASSFILE: "/dev/null",
              PGSSLMODE: "disable",
              PGOPTIONS: "-c search_path=public",
            },
          },
        );
        assert.equal(
          applied.error,
          undefined,
          "psql must be available for full historical migrations",
        );
        assert.equal(
          applied.status,
          0,
          `migration ${name} failed: ${applied.stderr}`,
        );
      }
      await assert.rejects(
        assertEmptyDatabase(sql),
        /provider_accounts_fixture_not_empty/,
      );
      prisma = new PrismaClient({
        adapter: new PrismaPg(target),
        transactionOptions: { maxWait: 10_000, timeout: 20_000 },
      });
      const db = prisma;
      const accounts = new PrismaProviderAccountRepository(db);
      const mirror = new PrismaProviderAccountSynchronization(db);
      const workspaceAccess = new PrismaWorkspaceAccessRepository(db);
      const dependencies = { accounts, workspaceAccess };
      const workspaceId = "rr-test-workspace-a";
      const foreignWorkspaceId = "rr-test-workspace-b";
      const connectionId = "rr-test-connection-a";
      const actor = {
        userId: "rr-test-user-admin",
        githubUserId: "920001",
        githubLogin: "rr-test-renamed-login",
      };
      const scope = { workspaceId, connectionId };
      const metadata = {
        gatewayOperationRef: "rr-test-operation",
        profileRef: "rr-test-profile",
        displayName: "Synthetic gateway account",
        state: "active" as const,
      };
      await db.workspace.createMany({
        data: [
          {
            id: workspaceId,
            slug: "rr-test-workspace-a",
            name: "Synthetic workspace A",
          },
          {
            id: foreignWorkspaceId,
            slug: "rr-test-workspace-b",
            name: "Synthetic workspace B",
          },
        ],
      });
      await db.user.createMany({
        data: [
          {
            id: actor.userId,
            githubUserId: 920001n,
            githubLogin: "rr-test-original-login",
          },
          {
            id: "rr-test-member",
            githubUserId: 920002n,
            githubLogin: "rr-test-member",
          },
        ],
      });
      await db.workspaceMember.createMany({
        data: [
          {
            workspaceId,
            userId: actor.userId,
            githubLogin: "rr-test-original-login",
            role: "admin",
          },
          {
            workspaceId: foreignWorkspaceId,
            userId: actor.userId,
            role: "admin",
          },
          { workspaceId, userId: "rr-test-member", role: "member" },
        ],
      });
      const mirrored = await mirror.recordWorkspaceConnection({
        id: connectionId,
        workspaceId,
        gatewayAccountRef: "rr-test-gateway-a",
        ...metadata,
      });
      assert.deepEqual(mirrored.owner, { kind: "workspace", workspaceId });

      await t.test(
        "database constraints reject raw SQL ownership/identity/revision violations",
        async () => {
          const connectionInsert = `INSERT INTO "ProviderAccountConnection"
        ("id", "ownerUserId", "ownerWorkspaceId", "gatewayAccountRef", "displayName", "updatedAt")
        VALUES ($1, $2, $3, $4, 'Synthetic account', now())`;
          async function rejected(
            query: string,
            args: unknown[],
            code: string,
          ) {
            await assert.rejects(
              sql.query(query, args),
              (error: unknown) =>
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === code,
            );
          }
          await rejected(
            connectionInsert,
            ["xor-none", null, null, "rr-test-xor-none"],
            "23514",
          );
          await rejected(
            connectionInsert,
            ["xor-both", actor.userId, workspaceId, "rr-test-xor-both"],
            "23514",
          );
          await rejected(
            connectionInsert,
            ["orphan", null, "missing-workspace", "rr-test-orphan"],
            "23503",
          );
          await rejected(
            connectionInsert,
            ["duplicate-ref", null, workspaceId, "rr-test-gateway-a"],
            "23505",
          );
          await rejected(
            `UPDATE "ProviderAccountConnection" SET "ownerWorkspaceId" = $1, "metadataRevision" = 2 WHERE "id" = $2`,
            [foreignWorkspaceId, connectionId],
            "23514",
          );
          await rejected(
            `UPDATE "ProviderAccountConnection" SET "ownerWorkspaceId" = NULL, "ownerUserId" = $1, "metadataRevision" = 2 WHERE "id" = $2`,
            [actor.userId, connectionId],
            "23514",
          );
          await rejected(
            `UPDATE "ProviderAccountConnection" SET "gatewayAccountRef" = 'rr-test-repointed', "metadataRevision" = 2 WHERE "id" = $1`,
            [connectionId],
            "23514",
          );
          await rejected(
            `UPDATE "ProviderAccountConnection" SET "metadataRevision" = 0 WHERE "id" = $1`,
            [connectionId],
            "23514",
          );
          await rejected(
            `DELETE FROM "Workspace" WHERE "id" = $1`,
            [workspaceId],
            "23503",
          );
          const bindingInsert = `INSERT INTO "WorkspaceAccountBinding" ("id", "workspaceId", "connectionId", "state", "updatedAt") VALUES ($1, $2, $3, 'active', now())`;
          await rejected(
            bindingInsert,
            ["orphan-binding", workspaceId, "missing-connection"],
            "23503",
          );
          await rejected(
            bindingInsert,
            ["orphan-workspace-binding", "missing-workspace", connectionId],
            "23503",
          );
          await sql.query(connectionInsert, [
            "rr-test-personal-connection",
            actor.userId,
            null,
            "rr-test-personal-gateway",
          ]);
          await rejected(
            `DELETE FROM "User" WHERE "id" = $1`,
            [actor.userId],
            "23503",
          );
          // Existing NULL ownership cannot be adopted, even by a missing User.
          await rejected(
            `UPDATE "Workspace" SET "personalOwnerUserId" = 'missing-user' WHERE "id" = $1`,
            [foreignWorkspaceId],
            "23514",
          );
          assert.equal(
            (
              await db.workspace.findUniqueOrThrow({
                where: { id: foreignWorkspaceId },
              })
            ).personalOwnerUserId,
            null,
          );
          // A fresh invalid owner still exercises the actual foreign-key guard.
          await rejected(
            `INSERT INTO "Workspace" ("id", "slug", "name", "personalOwnerUserId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, now(), now())`,
            [
              "rr-test-missing-personal-owner",
              "rr-test-missing-personal-owner",
              "Synthetic missing owner",
              "missing-user",
            ],
            "23503",
          );
          // Personal ownership starts at fresh birth; C1 still rejects consume.
          const personalWorkspace = await db.workspace.create({
            data: {
              slug: "rr-test-fresh-personal-workspace",
              name: "Synthetic fresh personal workspace",
              personalOwnerUserId: actor.userId,
              members: { create: { userId: actor.userId, role: "owner" } },
            },
          });
          assert.equal(
            (
              await db.workspace.findUniqueOrThrow({
                where: { id: workspaceId },
              })
            ).personalOwnerUserId,
            null,
          );
          await assert.rejects(
            bindWorkspaceAccount(
              {
                workspaceId: personalWorkspace.id,
                connectionId: "rr-test-personal-connection",
                actor,
                expectedRevision: 0,
              },
              dependencies,
            ),
            denied("connection_unavailable"),
          );
        },
      );

      let bindingId = "";
      await t.test(
        "initial bind and bind/revoke races have one winner; stale bind cannot undo local revocation",
        async () => {
          const bind = (expectedRevision: number) =>
            bindWorkspaceAccount(
              { ...scope, actor, expectedRevision },
              dependencies,
            );
          const initial = await Promise.allSettled([bind(0), bind(0)]);
          assert.equal(
            initial.filter((r) => r.status === "fulfilled").length,
            1,
          );
          const initialLoser = initial.find((r) => r.status === "rejected");
          assert.ok(
            initialLoser?.status === "rejected" &&
              denied("revision_conflict")(initialLoser.reason),
          );
          const binding = await db.workspaceAccountBinding.findFirstOrThrow({
            where: scope,
            orderBy: [{ state: "asc" }, { createdAt: "desc" }, { id: "desc" }],
          });
          assert.equal(binding.revision, 1);
          bindingId = binding.id;
          const race = await Promise.allSettled([
            bind(1),
            revokeWorkspaceAccountBinding(
              { ...scope, actor, expectedRevision: 1 },
              dependencies,
            ),
          ]);
          assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
          const loser = race.find((r) => r.status === "rejected");
          assert.ok(
            loser?.status === "rejected" &&
              denied("revision_conflict")(loser.reason),
          );
          const current = await db.workspaceAccountBinding.findUniqueOrThrow({
            where: { id: bindingId },
          });
          assert.equal(current.revision, 2);
          const revokedRevision =
            current.state === "active"
              ? (
                  await revokeWorkspaceAccountBinding(
                    { ...scope, actor, expectedRevision: 2 },
                    dependencies,
                  )
                ).revision
              : current.revision;
          await assert.rejects(bind(1), denied("revision_conflict"));
          await assert.rejects(
            resolveWorkspaceAccountBinding(
              { workspaceId, bindingId, actor },
              dependencies,
            ),
            denied("binding_unavailable"),
          );
          const reactivated = await bind(revokedRevision);
          assert.equal(reactivated.revision, revokedRevision + 1);
          const insert = `INSERT INTO "WorkspaceAccountBinding" ("id", "workspaceId", "connectionId", "state", "updatedAt") VALUES ('duplicate-binding', $1, $2, 'active', now())`;
          await assert.rejects(
            sql.query(insert, [workspaceId, connectionId]),
            (error: unknown) =>
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "23505",
          );
          await assert.rejects(
            sql.query(
              `UPDATE "WorkspaceAccountBinding" SET "revision" = 0 WHERE "id" = $1`,
              [bindingId],
            ),
            (error: unknown) =>
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "23514",
          );
          await assert.rejects(
            sql.query(
              `UPDATE "WorkspaceAccountBinding" SET "workspaceId" = $1, "revision" = "revision" + 1 WHERE "id" = $2`,
              [foreignWorkspaceId, bindingId],
            ),
            (error: unknown) =>
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "23514",
          );
          await assert.rejects(
            sql.query(
              `DELETE FROM "ProviderAccountConnection" WHERE "id" = $1`,
              [connectionId],
            ),
            (error: unknown) =>
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "23503",
          );
          // Exercise the composite key through a future-style same-workspace FK.
          await sql.query(`CREATE TABLE rr_test_repo_config ("bindingId" text, "workspaceId" text,
        FOREIGN KEY ("bindingId", "workspaceId") REFERENCES "WorkspaceAccountBinding"("id", "workspaceId"))`);
          await sql.query(`INSERT INTO rr_test_repo_config VALUES ($1, $2)`, [
            bindingId,
            workspaceId,
          ]);
          await assert.rejects(
            sql.query(`INSERT INTO rr_test_repo_config VALUES ($1, $2)`, [
              bindingId,
              foreignWorkspaceId,
            ]),
            (error: unknown) =>
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "23503",
          );
        },
      );

      await t.test(
        "scoped selection and live authorization deny foreign/member/stale identity access",
        async () => {
          // The preceding race leaves a retained revoke fence on the rebind.
          // Selection requires the exact durable-ACK bookkeeping before these
          // independent membership and account-status assertions can execute.
          const rebound = await accounts.findBinding({
            workspaceId,
            bindingId,
          });
          const pending = rebound?.binding.pendingFence;
          assert.ok(pending);
          await assert.rejects(
            resolveWorkspaceAccountBinding(
              { workspaceId, bindingId, actor },
              dependencies,
            ),
            denied("binding_unavailable"),
          );
          assert.equal(
            await accounts.acknowledgeBindingFence({
              workspaceId,
              bindingId,
              ...pending,
            }),
            true,
          );
          const selected = await resolveWorkspaceAccountBinding(
            { workspaceId, bindingId, actor },
            dependencies,
          );
          assert.equal(selected.gatewayAccountRef, "rr-test-gateway-a");
          await assert.rejects(
            resolveWorkspaceAccountBinding(
              { workspaceId: foreignWorkspaceId, bindingId, actor },
              dependencies,
            ),
            denied("binding_unavailable"),
          );
          const foreignBinding = await db.workspaceAccountBinding.create({
            data: {
              workspaceId: foreignWorkspaceId,
              connectionId,
              state: "active",
            },
          });
          await assert.rejects(
            resolveWorkspaceAccountBinding(
              {
                workspaceId: foreignWorkspaceId,
                bindingId: foreignBinding.id,
                actor,
              },
              dependencies,
            ),
            denied("connection_unavailable"),
          );
          await assert.rejects(
            bindWorkspaceAccount(
              {
                workspaceId: foreignWorkspaceId,
                connectionId,
                actor,
                expectedRevision: 1,
              },
              dependencies,
            ),
            denied("connection_unavailable"),
          );
          const memberActor = {
            userId: "rr-test-member",
            githubUserId: "920002",
            githubLogin: "rr-test-member",
          };
          const revision = selected.bindingRevision;
          assert.equal(
            (
              await resolveWorkspaceAccountBinding(
                { workspaceId, bindingId, actor: memberActor },
                dependencies,
              )
            ).bindingRevision,
            revision,
          );
          await assert.rejects(
            revokeWorkspaceAccountBinding(
              { ...scope, actor: memberActor, expectedRevision: revision },
              dependencies,
            ),
            denied("workspace_forbidden"),
          );
          await db.workspaceMember.delete({
            where: {
              workspaceId_userId: { workspaceId, userId: actor.userId },
            },
          });
          // A matching legacy login role must not rescue the present stable userId.
          await db.workspaceMember.create({
            data: {
              workspaceId,
              githubLogin: actor.githubLogin,
              role: "admin",
            },
          });
          await assert.rejects(
            bindWorkspaceAccount(
              { ...scope, actor, expectedRevision: revision },
              dependencies,
            ),
            denied("workspace_forbidden"),
          );
          await assert.rejects(
            resolveWorkspaceAccountBinding(
              { workspaceId, bindingId, actor },
              dependencies,
            ),
            denied("workspace_forbidden"),
          );
          await db.workspaceMember.create({
            data: { workspaceId, userId: actor.userId, role: "admin" },
          });
          const githubActor = {
            githubUserId: actor.githubUserId,
            githubLogin: "rr-test-new-login",
          };
          assert.equal(
            (
              await resolveWorkspaceAccountBinding(
                { workspaceId, bindingId, actor: githubActor },
                dependencies,
              )
            ).connectionId,
            connectionId,
          );
          const overrideActor = {
            userId: "rr-test-no-membership",
            githubUserId: "920099",
            githubLogin: "rr-test-local-admin",
          };
          const overrideDependencies = {
            ...dependencies,
            localAdminGithubLogins: ["RR-TEST-LOCAL-ADMIN"],
          };
          assert.equal(
            (
              await resolveWorkspaceAccountBinding(
                { workspaceId, bindingId, actor: overrideActor },
                overrideDependencies,
              )
            ).connectionId,
            connectionId,
          );
          await assert.rejects(
            bindWorkspaceAccount(
              {
                workspaceId: foreignWorkspaceId,
                connectionId,
                actor: overrideActor,
                expectedRevision: 1,
              },
              overrideDependencies,
            ),
            denied("connection_unavailable"),
          );
        },
      );

      // Regression: bind trusts its earlier active projection after a gateway
      // synchronization quarantines the account before the atomic storage step.
      // All auth, reads, synchronization and CAS below use the real Prisma adapters;
      // the product-port barrier makes that external status change deterministic.
      await t.test(
        "status changed after live preflight cannot create an active binding",
        async () => {
          const raceConnectionId = "rr-test-connection-status-race";
          await mirror.recordWorkspaceConnection({
            id: raceConnectionId,
            workspaceId,
            gatewayAccountRef: "rr-test-gateway-status-race",
            ...metadata,
          });
          const raceScope = { workspaceId, connectionId: raceConnectionId };
          const barrierAccounts = {
            findOwnedConnection: accounts.findOwnedConnection.bind(accounts),
            findBinding: accounts.findBinding.bind(accounts),
            async compareAndSetBinding(
              input: Parameters<typeof accounts.compareAndSetBinding>[0],
            ) {
              await mirror.synchronizeMetadata({
                ...raceScope,
                ...metadata,
                state: "quarantined",
                expectedRevision: 1,
              });
              return accounts.compareAndSetBinding(input);
            },
          };
          await assert.rejects(
            bindWorkspaceAccount(
              {
                ...raceScope,
                actor,
                expectedRevision: 0,
              },
              { workspaceAccess, accounts: barrierAccounts },
            ),
            denied("connection_unavailable"),
          );
          assert.equal(
            await db.workspaceAccountBinding.count({ where: raceScope }),
            0,
          );
          assert.equal(
            (
              await db.providerAccountConnection.findUniqueOrThrow({
                where: { id: raceConnectionId },
              })
            ).state,
            "quarantined",
          );
        },
      );

      // R2: gate only transaction admission, then delegate to the actual Prisma
      // client/database. No query, lock, CAS or return value is mocked. Production
      // gets no test hook. Validation has already run when `entered` resolves.
      function transactionGate() {
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const client = new Proxy(db, {
          get(target, property) {
            if (property === "$transaction") {
              return async (...args: unknown[]) => {
                enter();
                await gate;
                return Reflect.apply(target.$transaction, target, args);
              };
            }
            return Reflect.get(target, property, target);
          },
        });
        return { client, entered, release };
      }

      await t.test(
        "binding adapter captures CAS revision, scope and requested state before transaction admission",
        async () => {
          for (const stale of [true, false]) {
            const suffix = stale ? "stale" : "fresh";
            const a = {
              workspaceId,
              connectionId: `rr-test-binding-alias-a-${suffix}`,
            };
            const b = {
              workspaceId: foreignWorkspaceId,
              connectionId: `rr-test-binding-alias-b-${suffix}`,
            };
            for (const target of [a, b]) {
              await mirror.recordWorkspaceConnection({
                id: target.connectionId,
                workspaceId: target.workspaceId,
                gatewayAccountRef: `gateway-${target.connectionId}`,
                ...metadata,
              });
              await accounts.compareAndSetBinding({
                ...target,
                expectedRevision: 0,
                state: "active",
              });
              await accounts.compareAndSetBinding({
                ...target,
                expectedRevision: 1,
                state: "revoked",
              });
            }
            const gate = transactionGate();
            const adapter = new PrismaProviderAccountRepository(gate.client);
            const input: Parameters<typeof adapter.compareAndSetBinding>[0] = {
              ...a,
              expectedRevision: stale ? 1 : 2,
              state: stale ? "active" : "revoked",
            };
            const pending = adapter.compareAndSetBinding(input);
            // Attach rejection assertions before releasing the gate.
            const result = stale
              ? assert.rejects(pending, denied("revision_conflict"))
              : pending;
            await gate.entered;
            Object.assign(input, {
              ...b,
              expectedRevision: 2,
              state: "active",
            });
            gate.release();
            const returned = await result;
            if (!stale) {
              assert.ok(returned);
              assert.equal(returned.workspaceId, a.workspaceId);
              assert.equal(returned.connectionId, a.connectionId);
              assert.equal(returned.revision, 3);
              assert.equal(returned.state, "revoked");
            }
            const original = await db.workspaceAccountBinding.findFirstOrThrow({
              where: a,
              orderBy: [
                { state: "asc" },
                { createdAt: "desc" },
                { id: "desc" },
              ],
            });
            const foreign = await db.workspaceAccountBinding.findFirstOrThrow({
              where: b,
              orderBy: [
                { state: "asc" },
                { createdAt: "desc" },
                { id: "desc" },
              ],
            });
            assert.equal(original.revision, stale ? 2 : 3);
            assert.equal(original.state, "revoked");
            assert.equal(foreign.revision, 2);
            assert.equal(foreign.state, "revoked");
          }
        },
      );

      await t.test(
        "synchronization adapter captures CAS revision, scope and safe metadata before transaction admission",
        async () => {
          for (const stale of [true, false]) {
            const suffix = stale ? "stale" : "fresh";
            const a = {
              workspaceId,
              connectionId: `rr-test-metadata-alias-a-${suffix}`,
            };
            const b = {
              workspaceId: foreignWorkspaceId,
              connectionId: `rr-test-metadata-alias-b-${suffix}`,
            };
            for (const target of [a, b]) {
              await mirror.recordWorkspaceConnection({
                id: target.connectionId,
                workspaceId: target.workspaceId,
                gatewayAccountRef: `gateway-${target.connectionId}`,
                ...metadata,
              });
              await mirror.synchronizeMetadata({
                ...target,
                ...metadata,
                expectedRevision: 1,
                state: "disabled",
              });
            }
            const gate = transactionGate();
            const adapter = new PrismaProviderAccountSynchronization(
              gate.client,
            );
            const input: Parameters<typeof adapter.synchronizeMetadata>[0] = {
              ...a,
              ...metadata,
              expectedRevision: stale ? 1 : 2,
              state: stale ? "active" : "disabled",
              gatewayOperationRef: "original-operation",
              profileRef: "original-profile",
              displayName: "Original safe label",
            };
            const pending = adapter.synchronizeMetadata(input);
            const result = stale
              ? assert.rejects(pending, denied("revision_conflict"))
              : pending;
            await gate.entered;
            Object.assign(input, {
              ...b,
              expectedRevision: 2,
              state: "active",
              gatewayOperationRef: "changed-operation",
              profileRef: "changed-profile",
              displayName: "Changed safe label",
            });
            gate.release();
            const returned = await result;
            if (!stale) {
              assert.ok(returned);
              assert.equal(returned.id, a.connectionId);
              assert.deepEqual(returned.owner, {
                kind: "workspace",
                workspaceId: a.workspaceId,
              });
              assert.equal(returned.metadataRevision, 3);
              assert.equal(returned.state, "disabled");
              assert.equal(returned.gatewayOperationRef, "original-operation");
              assert.equal(returned.profileRef, "original-profile");
              assert.equal(returned.displayName, "Original safe label");
            }
            const original =
              await db.providerAccountConnection.findUniqueOrThrow({
                where: { id: a.connectionId },
              });
            const foreign =
              await db.providerAccountConnection.findUniqueOrThrow({
                where: { id: b.connectionId },
              });
            assert.equal(original.metadataRevision, stale ? 2 : 3);
            assert.equal(original.state, "disabled");
            assert.equal(
              original.gatewayOperationRef,
              stale ? metadata.gatewayOperationRef : "original-operation",
            );
            assert.equal(
              original.profileRef,
              stale ? metadata.profileRef : "original-profile",
            );
            assert.equal(
              original.displayName,
              stale ? metadata.displayName : "Original safe label",
            );
            assert.equal(foreign.metadataRevision, 2);
            assert.equal(foreign.state, "disabled");
            assert.equal(
              foreign.gatewayOperationRef,
              metadata.gatewayOperationRef,
            );
            assert.equal(foreign.profileRef, metadata.profileRef);
            assert.equal(foreign.displayName, metadata.displayName);
          }
        },
      );

      await t.test(
        "privileged status synchronization is CAS and disables selection without authorizing native effects",
        async () => {
          const disabled = await mirror.synchronizeMetadata({
            ...scope,
            ...metadata,
            state: "disabled",
            expectedRevision: 1,
          });
          assert.equal(disabled.metadataRevision, 2);
          await assert.rejects(
            mirror.synchronizeMetadata({
              ...scope,
              ...metadata,
              expectedRevision: 1,
            }),
            denied("revision_conflict"),
          );
          await assert.rejects(
            resolveWorkspaceAccountBinding(
              { workspaceId, bindingId, actor },
              dependencies,
            ),
            denied("connection_unavailable"),
          );
          const b = await db.workspaceAccountBinding.findUniqueOrThrow({
            where: { id: bindingId },
          });
          await assert.rejects(
            bindWorkspaceAccount(
              { ...scope, actor, expectedRevision: b.revision },
              dependencies,
            ),
            denied("connection_unavailable"),
          );
          await revokeWorkspaceAccountBinding(
            { ...scope, actor, expectedRevision: b.revision },
            dependencies,
          );
          await assert.rejects(
            resolveWorkspaceAccountBinding(
              { workspaceId, bindingId, actor },
              dependencies,
            ),
            denied("binding_unavailable"),
          );
          // Safe extra fields must never flow into a native DTO or persisted record.
          const incoming = {
            ...scope,
            ...metadata,
            expectedRevision: 2,
            nativeDescriptor: { synthetic: true },
            prompt: "synthetic-ignored",
          };
          const active = await mirror.synchronizeMetadata(incoming);
          assert.equal(active.metadataRevision, 3);
          assert.deepEqual(
            Object.keys(active).sort(),
            [
              "displayName",
              "gatewayAccountRef",
              "gatewayOperationRef",
              "id",
              "metadataRevision",
              "owner",
              "profileRef",
              "state",
            ].sort(),
          );
          await assert.rejects(
            resolveWorkspaceAccountBinding(
              { workspaceId, bindingId, actor },
              dependencies,
            ),
            denied("binding_unavailable"),
          );
        },
      );
      await runBindingFencePostgresTests(t, {
        db,
        sql,
        workspaceId,
        foreignWorkspaceId,
        actor,
        dependencies,
        targetUrl: process.env.RR_PROVIDER_ACCOUNTS_PG_TEST_URL ?? "",
        createPrisma: () =>
          new PrismaClient({
            adapter: new PrismaPg(target),
            transactionOptions: { maxWait: 10_000, timeout: 20_000 },
          }),
      });
    } finally {
      await prisma?.$disconnect();
      await sql.end();
    }
    // Leave inspectable evidence in this newly disposable database. Main destroys
    // the dedicated database/cluster after review; no production/old fixture cleanup.
  },
);
