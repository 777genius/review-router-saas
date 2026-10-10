import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PrismaActionControlPlaneRepository } from "../../../action-control-plane/src/infrastructure/prisma/prisma-action-control-plane-repository";
import { switchRepositoryConfigurationAuthMode } from "../../../workflow-provisioning/src/infrastructure/prisma/prisma-hosted-pool-configuration";
import {
  parseReviewConfigurationStrict,
  PrismaReviewConfigurationRepository,
  PrismaReviewConfigurationTransactionRepository,
  resolveReviewConfiguration,
  safeDefaultReviewConfiguration,
  saveReviewConfiguration,
  saveReviewConfigurationWithOperation,
  findReviewConfigurationOperation,
  ReviewConfigurationWriteConflictError,
  type ReviewConfigurationOperationInput,
} from "../index";

const enabled = process.env.RR_REVIEW_CONFIG_GATEWAY_PG_TEST === "1";

// Same boundary as the provider-accounts PG suite: an explicitly disposable
// empty loopback DB/cluster, no ambient DATABASE_URL, URL password, pgpass or SSL.
// The primary qualifier supplies PGPASSWORD server-side; never put it in the URL.
function disposableTarget(raw: string) {
  const url = new URL(raw);
  const port = url.port ? Number(url.port) : 5432;
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^rr_gateway_test_c2b_[a-z0-9_]+$/.test(url.pathname.slice(1)) ||
    !/^[a-zA-Z0-9_]+$/.test(url.username) ||
    url.password ||
    url.search ||
    url.hash ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("review_config_disposable_loopback_database_required");
  }
  return {
    host: url.hostname === "[::1]" ? "::1" : url.hostname,
    port,
    user: url.username,
    database: url.pathname.slice(1),
    password: () => process.env.PGPASSWORD ?? "",
    ssl: false,
    max: 8,
    options: "-c search_path=public",
    application_name: "rr_gateway_config_c2b_test",
    client_encoding: "UTF8",
  };
}

// Detects persistence/adapter loss, parent workspace substitution, SQL bypass,
// stale CAS overwrites and selection of revoked/fenced/foreign/personal bindings.
// This proves product configuration only, never live gateway execution admission.
describe.skipIf(!enabled)(
  "C2b actual migrated PostgreSQL configuration",
  () => {
    it("backfills legacy rows and enforces safe scoped versioned selections", async () => {
      expect(process.env.RR_REVIEW_CONFIG_GATEWAY_DISPOSABLE_CLUSTER).toBe("1");
      const target = disposableTarget(
        process.env.RR_REVIEW_CONFIG_GATEWAY_PG_TEST_URL ?? "",
      );
      const [{ Client }, { PrismaClient }, { PrismaPg }] = await Promise.all([
        import("pg"),
        import("@prisma/client"),
        import("@prisma/adapter-pg"),
      ]);
      const sql = new Client(target);
      await sql.connect();
      let prisma: InstanceType<typeof PrismaClient> | undefined;
      let refetched: InstanceType<typeof PrismaClient> | undefined;
      try {
        const empty = await sql.query<{ nonempty: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
          UNION ALL
          SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
          UNION ALL
          SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
          UNION ALL
          SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_'
            AND n.nspname NOT IN ('information_schema', 'public')
        ) AS nonempty`);
        expect(empty.rows[0]?.nonempty).toBe(false);
        const migrations = new URL(
          "../../../../platform/db/prisma/migrations/",
          import.meta.url,
        );
        const names = (await readdir(migrations))
          .filter((name) => /^\d{6}_/.test(name))
          .sort();
        expect(names).toHaveLength(121);
        expect(names.at(-1)).toBe(
          "000122_review_configuration_operation_receipt",
        );
        let legacyBefore: unknown;
        for (const name of names) {
          if (name === "000119_review_configuration_gateway_binding") {
            // Real pre-119 data detects destructive backfill or parent-scope guessing.
            await sql.query(`
            INSERT INTO "Workspace" ("id", "slug", "name", "updatedAt") VALUES
              ('c2b-w', 'c2b-w', 'Synthetic W', now()), ('c2b-x', 'c2b-x', 'Synthetic X', now());
            INSERT INTO "ReviewConfiguration" ("id", "workspaceId", "targetKey", "updatedAt")
              VALUES ('c2b-legacy-config', 'c2b-w', 'workspace:default', now());
            INSERT INTO "ReviewConfigurationVersion" ("id", "configurationId", "version", "schemaVersion",
              "providerKind", "providerAuthMode", "model", "reasoningEffort", "failOnSeverity",
              "inlineMaxComments", "targetTokensPerBatch") VALUES
              ('c2b-legacy-version', 'c2b-legacy-config', 1, 2, 'codex',
               'codex_subscription_oauth_rotating', 'gpt-5.6-sol', 'high', 'critical', 50, 50000);
            INSERT INTO "ReviewConfigurationVersionProvider" ("id", "configurationVersionId", "order",
              "providerKind", "providerAuthMode", "model", "reasoningEffort", "requiredHealthy") VALUES
              ('c2b-legacy-provider', 'c2b-legacy-version', 0, 'codex',
               'codex_subscription_oauth_rotating', 'gpt-5.6-sol', 'high', true);`);
            legacyBefore = (
              await sql.query(`
            SELECT (SELECT to_jsonb(v) FROM "ReviewConfigurationVersion" v
                    WHERE v."id" = 'c2b-legacy-version') AS v,
                   (SELECT to_jsonb(p) FROM "ReviewConfigurationVersionProvider" p
                    WHERE p."id" = 'c2b-legacy-provider') AS p`)
            ).rows;
          }
          if (name.startsWith("000087")) {
            // Existing release role owns the boundary in this guarded fresh DB.
            await sql.query(
              'ALTER SCHEMA public OWNER TO reviewrouter_release_schema_owner; ALTER TABLE public."CodexOAuthSecretNamespace" OWNER TO reviewrouter_release_schema_owner;',
            );
          }
          // Match the existing account PG convention: psql runs statements singly,
          // including historical CONCURRENTLY and enum migrations outside implicit transactions.
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
              input: await readFile(
                new URL(`${name}/migration.sql`, migrations),
                "utf8",
              ),
              encoding: "utf8",
              timeout: 60_000,
              env: {
                PATH: process.env.PATH,
                PGPASSWORD: process.env.PGPASSWORD,
                PGPASSFILE: "/dev/null",
                PGSSLMODE: "disable",
                PGOPTIONS: "-c search_path=public",
              },
            },
          );
          expect(
            applied.error,
            "psql required for historical migrations",
          ).toBeUndefined();
          expect(
            applied.status,
            `migration ${name} failed: ${applied.stderr}`,
          ).toBe(0);
        }
        const legacyAfter = await sql.query(`
        SELECT (SELECT to_jsonb(v) - 'workspaceId' - 'gatewayBindingId' - 'gatewayProfileRef'
                  - 'operationId' - 'operationIntentHash'
                FROM "ReviewConfigurationVersion" v WHERE v."id" = 'c2b-legacy-version') AS v,
               (SELECT to_jsonb(p) - 'workspaceId' - 'gatewayBindingId' - 'gatewayProfileRef'
                FROM "ReviewConfigurationVersionProvider" p WHERE p."id" = 'c2b-legacy-provider') AS p`);
        expect(legacyAfter.rows).toEqual(legacyBefore);
        for (const table of [
          "ReviewConfigurationVersion",
          "ReviewConfigurationVersionProvider",
        ] as const) {
          const rows = (
            await sql.query(
              `SELECT "workspaceId", "gatewayBindingId", "gatewayProfileRef" FROM "${table}"`,
            )
          ).rows;
          expect(rows).toEqual([
            {
              workspaceId: "c2b-w",
              gatewayBindingId: null,
              gatewayProfileRef: null,
            },
          ]);
        }

        prisma = new PrismaClient({
          adapter: new PrismaPg(target),
          transactionOptions: { maxWait: 10_000, timeout: 20_000 },
        });
        const configs = new PrismaReviewConfigurationRepository(prisma);
        const workspace = { scope: "workspace", workspaceId: "c2b-w" } as const;
        await prisma.repositoryConnection.create({
          data: {
            id: "c2b-repo",
            workspaceId: workspace.workspaceId,
            externalRepositoryId: "c2b-repo",
            owner: "synthetic",
            name: "repo",
            fullName: "synthetic/repo",
            defaultBranch: "main",
            visibility: "private",
          },
        });
        const repository = {
          ...workspace,
          scope: "repository",
          repositoryId: "c2b-repo",
        } as const;
        const deps = { configurations: configs };
        // A gateway opt-in must preserve clearing a legacy repository override.
        await configs.saveNextVersion({
          target: repository,
          config: safeDefaultReviewConfiguration,
          expectedVersion: null,
        });
        expect(await configs.deleteTarget(repository)).toBe(true);
        expect(await configs.findLatest(repository)).toBeNull();
        expect(
          (
            await resolveReviewConfiguration(
              { scope: "workspace", workspaceId: "c2b-x" },
              deps,
            )
          ).config,
        ).toEqual(safeDefaultReviewConfiguration);
        expect(
          (await resolveReviewConfiguration(repository, deps)).source,
        ).toBe("workspace");

        async function binding(
          id: string,
          workspaceId = "c2b-w",
          profileRef = "profile-mimo",
          ownerUserId?: string,
        ) {
          await prisma!.providerAccountConnection.create({
            data: {
              id: `${id}-connection`,
              ...(ownerUserId
                ? { ownerUserId }
                : { ownerWorkspaceId: workspaceId }),
              gatewayAccountRef: `${id}-account`,
              profileRef,
              displayName: "Synthetic account",
              state: "active",
            },
          });
          await prisma!.workspaceAccountBinding.create({
            data: {
              id,
              workspaceId,
              connectionId: `${id}-connection`,
              state: "active",
            },
          });
        }
        await binding("c2b-first");
        await binding("c2b-second", "c2b-w", "profile-openrouter");
        await binding("c2b-foreign", "c2b-x");
        const provider = (
          gatewayBindingId = "c2b-first",
          gatewayProfileRef = "profile-mimo",
          model = "mimo-v2-pro",
        ) => ({
          kind: "codex",
          authMode: "codex_account_gateway",
          model,
          gatewayBindingId,
          gatewayProfileRef,
          reasoningEffort: "high",
          agenticContext: false,
          fastMode: true,
        });
        const configFor = (selected: unknown) =>
          parseReviewConfigurationStrict({
            schemaVersion: 2,
            providers: [selected],
            blockingPolicy: {},
            limits: {},
          });
        const config = parseReviewConfigurationStrict({
          schemaVersion: 2,
          providers: [
            provider(),
            provider("c2b-second", "profile-openrouter", "openai/gpt-5.6-sol"),
          ],
          execution: { providerMaxParallel: 2 },
          blockingPolicy: {},
          limits: {},
        });
        const savedDefault = await saveReviewConfiguration(
          { target: workspace, config, expectedVersion: 1 },
          deps,
        );
        expect(savedDefault.version).toBe(2);
        expect(savedDefault.config).toEqual(config);
        expect(
          (await resolveReviewConfiguration(repository, deps)).config,
        ).toEqual(config);
        const override = configFor(
          provider("c2b-second", "profile-openrouter", "openai/gpt-5.6-sol"),
        );
        const saved = await saveReviewConfiguration(
          { target: repository, config: override, expectedVersion: null },
          deps,
        );
        expect(
          (await resolveReviewConfiguration(repository, deps)).source,
        ).toBe("repository");
        expect((await configs.findLatest(repository))?.config).toEqual(
          override,
        );
        // Old-pool provisioning must not convert a pinned gateway selection.
        expect(
          await prisma.$transaction((transaction) =>
            switchRepositoryConfigurationAuthMode({
              transaction,
              workspaceId: "c2b-w",
              repositoryId: "c2b-repo",
              authMode: "codex_subscription_oauth_hosted_pool",
            }),
          ),
        ).toBe(false);
        expect(await configs.findLatest(repository)).toEqual(saved);
        // The existing CI configuration reader must preserve the saved gateway
        // references instead of stripping them during DTO reconstruction.
        const runtimeConfig = await new PrismaActionControlPlaneRepository(
          prisma,
        ).findRuntimeReviewConfiguration({
          workspaceId: "c2b-w",
          repositoryId: "c2b-repo",
        });
        expect(runtimeConfig).toEqual({
          source: "repository",
          version: saved.version,
          config: override,
        });

        expect(
          await configs.findLatestForRepositories({
            workspaceId: "c2b-w",
            repositoryIds: ["c2b-repo"],
          }),
        ).toEqual([{ repositoryId: "c2b-repo", config: saved }]);
        const firstVersion =
          await prisma.reviewConfigurationVersion.findFirstOrThrow({
            where: {
              configuration: { workspaceId: "c2b-w", repositoryId: "c2b-repo" },
            },
            include: { providers: { orderBy: { order: "asc" } } },
          });
        expect(firstVersion.gatewayBindingId).toBe("c2b-second");
        expect(firstVersion.gatewayProfileRef).toBe("profile-openrouter");
        expect(
          firstVersion.providers.map((p) => [
            p.workspaceId,
            p.gatewayBindingId,
            p.gatewayProfileRef,
          ]),
        ).toEqual([["c2b-w", "c2b-second", "profile-openrouter"]]);
        const defaultVersion =
          await prisma.reviewConfigurationVersion.findFirstOrThrow({
            where: { configurationId: "c2b-legacy-config", version: 2 },
            include: { providers: { orderBy: { order: "asc" } } },
          });
        expect(
          defaultVersion.providers.map((p) => [
            p.gatewayBindingId,
            p.gatewayProfileRef,
          ]),
        ).toEqual([
          ["c2b-first", "profile-mimo"],
          ["c2b-second", "profile-openrouter"],
        ]);
        expect(defaultVersion.gatewayBindingId).toBe(
          defaultVersion.providers[0]?.gatewayBindingId,
        );

        await prisma.$disconnect();
        refetched = new PrismaClient({
          adapter: new PrismaPg(target),
          transactionOptions: { maxWait: 10_000, timeout: 20_000 },
        });
        prisma = refetched;
        const fresh = new PrismaReviewConfigurationRepository(refetched);
        expect(await fresh.findLatest(repository)).toEqual(saved);
        expect((await fresh.findLatest(workspace))?.config).toEqual(config);
        const next = await fresh.saveNextVersion({
          target: repository,
          config,
          expectedVersion: 1,
        });
        expect(next.version).toBe(2);
        await expect(
          fresh.saveNextVersion({
            target: repository,
            config: override,
            expectedVersion: 1,
          }),
        ).rejects.toMatchObject({
          code: "review_configuration_write_conflict",
        });
        expect(await fresh.findLatest(repository)).toEqual(next);
        expect(
          await refetched.reviewConfigurationVersion.findUniqueOrThrow({
            where: { id: firstVersion.id },
            include: { providers: { orderBy: { order: "asc" } } },
          }),
        ).toEqual(firstVersion);

        // Real SQL INSERTs, not Prisma validation, must fail with the intended FK/CHECK.
        for (const table of [
          "ReviewConfigurationVersion",
          "ReviewConfigurationVersionProvider",
        ] as const) {
          const templateId =
            table === "ReviewConfigurationVersion"
              ? firstVersion.id
              : firstVersion.providers[0]!.id;
          let ordinal = 1000;
          async function deniedInsert(
            patch: Record<string, unknown>,
            code: string,
          ) {
            ordinal += 1;
            const overrides = {
              id: `c2b-denied-${ordinal}`,
              version: ordinal,
              order: ordinal,
              ...patch,
            };
            await expect(
              sql.query(
                `INSERT INTO "${table}" SELECT
            (jsonb_populate_record(NULL::"${table}", to_jsonb(base) || $2::jsonb)).*
            FROM "${table}" base WHERE base."id" = $1`,
                [templateId, JSON.stringify(overrides)],
              ),
            ).rejects.toMatchObject({ code });
          }
          await deniedInsert({ gatewayBindingId: "c2b-foreign" }, "23503");
          await deniedInsert(
            { workspaceId: "c2b-x", gatewayBindingId: "c2b-foreign" },
            "23503",
          );
          await deniedInsert(
            { gatewayBindingId: null, gatewayProfileRef: null },
            "23514",
          );
          await deniedInsert({ gatewayBindingId: null }, "23514");
          await deniedInsert({ gatewayProfileRef: null }, "23514");
          await deniedInsert({ gatewayProfileRef: "" }, "23514");
          await deniedInsert(
            { gatewayProfileRef: "https://private.example" },
            "23514",
          );
          await deniedInsert({ gatewayProfileRef: "p".repeat(161) }, "23514");
          await deniedInsert({ providerKind: "claude" }, "23514");
          await deniedInsert(
            { providerAuthMode: "codex_subscription_oauth_rotating" },
            "23514",
          );
          await deniedInsert({ providerAuthMode: "unknown_gateway" }, "23514");
        }
        // Detects a forged root parent assigning W's actual repository to workspace X,
        // even before it has versions that could otherwise enforce the parent scope.
        await expect(
          sql.query(`INSERT INTO "ReviewConfiguration"
        ("id", "workspaceId", "repositoryId", "targetKey", "updatedAt") VALUES
        ('c2b-forged-parent', 'c2b-x', 'c2b-repo', 'repo:c2b-repo', now())`),
        ).rejects.toMatchObject({ code: "23503" });
        expect(
          await refetched.reviewConfiguration.findUnique({
            where: { id: "c2b-forged-parent" },
          }),
        ).toBeNull();
        await expect(
          sql.query(
            `DELETE FROM "WorkspaceAccountBinding" WHERE "id" = 'c2b-first'`,
          ),
        ).rejects.toMatchObject({ code: "23503" });
        await expect(
          sql.query(`UPDATE "ReviewConfiguration" SET "workspaceId" = 'c2b-x'
        WHERE "id" = 'c2b-legacy-config'`),
        ).rejects.toMatchObject({ code: "23503" });

        // Eligibility is checked live in the same save transaction; denied saves leave no version.
        const refused = async (
          selected: unknown,
          message = "review_configuration_gateway_binding_unavailable",
        ) => {
          await expect(
            fresh.saveNextVersion({
              target: repository,
              config: configFor(selected),
              expectedVersion: 2,
            }),
          ).rejects.toThrow(message);
          expect(await fresh.findLatest(repository)).toEqual(next);
        };
        await refused(provider("c2b-missing"));
        await refused(provider("c2b-foreign"));
        // A scoped binding alone cannot authorize a connection owned by another workspace.
        await refetched.workspaceAccountBinding.create({
          data: {
            id: "c2b-foreign-owner",
            workspaceId: "c2b-w",
            connectionId: "c2b-foreign-connection",
            state: "active",
          },
        });
        await refused(provider("c2b-foreign-owner"));
        await refused(
          provider("c2b-first", "profile-mismatch"),
          "review_configuration_gateway_profile_mismatch",
        );
        await binding("c2b-revoked");
        await sql.query(`UPDATE "WorkspaceAccountBinding" SET "state" = 'revoked', "revision" = 2,
        "policyRevision" = 2, "pendingFenceOperationId" = 'c2b-revoke-intent',
        "pendingFencePolicySubject" = "id", "pendingFencePolicyRevision" = 2 WHERE "id" = 'c2b-revoked'`);
        await refused(provider("c2b-revoked"));
        await sql.query(`UPDATE "WorkspaceAccountBinding" SET "state" = 'active', "revision" = 3,
        "policyRevision" = 3 WHERE "id" = 'c2b-revoked'`);
        await refused(provider("c2b-revoked")); // Active rebind must still deny while the fence is pending.
        await sql.query(`UPDATE "WorkspaceAccountBinding" SET "pendingFenceOperationId" = NULL,
        "pendingFencePolicySubject" = NULL, "pendingFencePolicyRevision" = NULL,
        "fenceAckOperationId" = 'c2b-revoke-intent', "fenceAckPolicyRevision" = 2 WHERE "id" = 'c2b-revoked'`);
        const afterAck = await fresh.saveNextVersion({
          target: repository,
          config: configFor(provider("c2b-revoked")),
          expectedVersion: 2,
        });
        expect(afterAck.version).toBe(3); // ACK2 clears retained intent without inventing ACK3.
        await sql.query(`UPDATE "WorkspaceAccountBinding" SET "state" = 'revoked', "revision" = 4,
        "policyRevision" = 4, "pendingFenceOperationId" = 'c2b-revoke-again',
        "pendingFencePolicySubject" = "id", "pendingFencePolicyRevision" = 4 WHERE "id" = 'c2b-revoked';
        UPDATE "WorkspaceAccountBinding" SET "pendingFenceOperationId" = NULL,
        "pendingFencePolicySubject" = NULL, "pendingFencePolicyRevision" = NULL,
        "fenceAckOperationId" = 'c2b-revoke-again', "fenceAckPolicyRevision" = 4 WHERE "id" = 'c2b-revoked'`);
        await expect(
          fresh.saveNextVersion({
            target: repository,
            config: configFor(provider("c2b-revoked")),
            expectedVersion: 3,
          }),
        ).rejects.toThrow("review_configuration_gateway_binding_unavailable");
        for (const state of [
          "disabled",
          "quarantined",
          "pending",
          "unknown",
        ] as const) {
          await refetched.providerAccountConnection.update({
            where: { id: "c2b-first-connection" },
            data: { state, metadataRevision: { increment: 1 } },
          });
          await expect(
            fresh.saveNextVersion({
              target: repository,
              config: configFor(provider()),
              expectedVersion: 3,
            }),
          ).rejects.toThrow("review_configuration_gateway_binding_unavailable");
        }
        // Disabled mirror/history remains readable; previous snapshots are never rewritten.
        expect((await fresh.findLatest(workspace))?.config).toEqual(config);
        expect(
          await refetched.reviewConfigurationVersion.findUniqueOrThrow({
            where: { id: firstVersion.id },
            include: { providers: { orderBy: { order: "asc" } } },
          }),
        ).toEqual(firstVersion);
        expect(await fresh.findLatest(repository)).toEqual(afterAck);
        expect(
          await refetched.reviewConfigurationVersion.count({
            where: { configurationId: firstVersion.configurationId },
          }),
        ).toBe(3);

        await refetched.user.create({ data: { id: "c2b-user" } });
        // These are DB fixtures only; they cannot become C2b personal/sharing selection.
        await binding("c2b-user-owned", "c2b-w", "profile-mimo", "c2b-user");
        await expect(
          fresh.saveNextVersion({
            target: repository,
            config: configFor(provider("c2b-user-owned")),
            expectedVersion: 3,
          }),
        ).rejects.toThrow("review_configuration_gateway_binding_unavailable");
        await refetched.workspace.create({
          data: {
            id: "c2b-personal",
            slug: "c2b-personal",
            name: "Synthetic personal",
            personalOwnerUserId: "c2b-user",
          },
        });
        await binding("c2b-personal-binding", "c2b-personal");
        await expect(
          fresh.saveNextVersion({
            target: { scope: "workspace", workspaceId: "c2b-personal" },
            config: configFor(provider("c2b-personal-binding")),
            expectedVersion: null,
          }),
        ).rejects.toThrow("review_configuration_gateway_binding_unavailable");
        expect(
          await fresh.findLatest({
            scope: "workspace",
            workspaceId: "c2b-personal",
          }),
        ).toBeNull();

        // Plausible failures: a lost commit response causes a second version,
        // stale CAS hides a committed receipt, partial hashes accept changed intent,
        // a later writer replaces readback, or foreign scopes disclose the receipt.
        // Use the SAME real Prisma/PG boundary; no second mock or unit layer.
        await refetched.repositoryConnection.create({
          data: {
            id: "c2b-receipt-repo",
            workspaceId: "c2b-w",
            externalRepositoryId: "c2b-receipt-repo",
            owner: "synthetic",
            name: "receipt",
            fullName: "synthetic/receipt",
            defaultBranch: "main",
            visibility: "private",
          },
        });
        const receiptTarget = {
          ...repository,
          repositoryId: "c2b-receipt-repo",
        };
        const operation = {
          target: receiptTarget,
          config: override,
          expectedVersion: null,
          operationId: "c2b-stable-batch",
        };
        const receiptDeps = { configurations: fresh };
        const committed = await saveReviewConfigurationWithOperation(
          operation,
          receiptDeps,
        );
        expect(committed.version).toBe(1);
        // Readback checks original CAS intent against the scoped historical receipt.
        expect(
          await findReviewConfigurationOperation(operation, receiptDeps),
        ).toEqual(committed);
        await expect(
          findReviewConfigurationOperation(
            {
              ...operation,
              expectedVersion: 1,
            },
            receiptDeps,
          ),
        ).rejects.toBeInstanceOf(ReviewConfigurationWriteConflictError);
        await expect(
          fresh.findOperation({
            ...operation,
            expectedVersion: 1,
          }),
        ).rejects.toBeInstanceOf(ReviewConfigurationWriteConflictError);
        for (const expectedVersion of [
          undefined,
          0,
          -1,
          1.5,
          NaN,
          Number.MAX_SAFE_INTEGER + 1,
        ]) {
          const invalidLookup = {
            target: receiptTarget,
            operationId: operation.operationId,
            expectedVersion,
          } as unknown as Parameters<typeof fresh.findOperation>[0];
          await expect(
            findReviewConfigurationOperation(invalidLookup, receiptDeps),
          ).rejects.toThrow("review_configuration_expected_version_invalid");
          await expect(fresh.findOperation(invalidLookup)).rejects.toThrow(
            "review_configuration_expected_version_invalid",
          );
        }
        for (const [invalidLookup, message] of [
          [
            { ...operation, operationId: "bad\n" },
            "review_configuration_operation_id_invalid",
          ],
          [
            { ...operation, target: { ...receiptTarget, workspaceId: "" } },
            "review_configuration_target_invalid",
          ],
        ] as const) {
          await expect(
            findReviewConfigurationOperation(invalidLookup, receiptDeps),
          ).rejects.toThrow(message);
          await expect(fresh.findOperation(invalidLookup)).rejects.toThrow(
            message,
          );
        }
        expect(
          await saveReviewConfigurationWithOperation(operation, receiptDeps),
        ).toEqual(committed);
        const receiptRow =
          await refetched.reviewConfigurationVersion.findFirstOrThrow({
            where: {
              configuration: { repositoryId: receiptTarget.repositoryId },
              operationId: operation.operationId,
            },
            include: { providers: { orderBy: { order: "asc" } } },
          });
        expect(receiptRow.operationIntentHash).toMatch(/^[0-9a-f]{64}$/);
        const versionCount = () =>
          refetched!.reviewConfigurationVersion.count({
            where: { configurationId: receiptRow.configurationId },
          });
        expect(await versionCount()).toBe(1);
        for (const changed of [
          { ...operation, expectedVersion: 1 },
          {
            ...operation,
            config: parseReviewConfigurationStrict({
              ...override,
              limits: { ...override.limits, inlineMaxComments: 7 },
            }),
          },
          {
            ...operation,
            config: parseReviewConfigurationStrict({
              ...override,
              reviewLanguage: "French",
            }),
          },
          {
            ...operation,
            config: parseReviewConfigurationStrict({
              ...override,
              investigationRollout: {
                ...override.investigationRollout,
                recordingEnabled: true,
              },
            }),
          },
          { ...operation, config },
        ]) {
          await expect(
            saveReviewConfigurationWithOperation(changed, receiptDeps),
          ).rejects.toMatchObject({
            code: "review_configuration_write_conflict",
          });
        }
        expect(await versionCount()).toBe(1);
        await expect(
          saveReviewConfigurationWithOperation(
            {
              ...operation,
              operationId: "c2b-distinct-batch",
            },
            receiptDeps,
          ),
        ).rejects.toMatchObject({
          code: "review_configuration_write_conflict",
        });
        await fresh.saveNextVersion({
          target: receiptTarget,
          config: override,
          expectedVersion: 1,
        });
        const advanced = await fresh.saveNextVersion({
          target: receiptTarget,
          config: parseReviewConfigurationStrict({
            ...override,
            reviewLanguage: "German",
          }),
          expectedVersion: 2,
        });
        expect(advanced.version).toBe(3);
        expect(
          await saveReviewConfigurationWithOperation(operation, receiptDeps),
        ).toEqual(committed);
        expect(
          await findReviewConfigurationOperation(operation, receiptDeps),
        ).toEqual(committed);
        expect(await fresh.findLatest(receiptTarget)).toEqual(advanced);
        expect(await versionCount()).toBe(3);
        for (const target of [
          { ...receiptTarget, workspaceId: "c2b-x" },
          repository,
          workspace,
        ]) {
          expect(
            await findReviewConfigurationOperation(
              {
                target,
                operationId: operation.operationId,
                expectedVersion: null,
              },
              receiptDeps,
            ),
          ).toBeNull();
        }

        // Actual SQL row lock holds both requests in-flight. Observing TWO SQL
        // lock waits avoids a scheduler-dependent Promise.all concurrency claim.
        // While blocked, mutate caller input to detect reading it after await.
        const raceClient = new PrismaClient({
          adapter: new PrismaPg({
            ...target,
            application_name: "rr_receipt_race",
          }),
          transactionOptions: { maxWait: 10_000, timeout: 20_000 },
        });
        const raceRepo = new PrismaReviewConfigurationRepository(raceClient);
        type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
        type MutableOperationInput = Omit<
          Mutable<ReviewConfigurationOperationInput>,
          "target"
        > & {
          target: Mutable<ReviewConfigurationOperationInput["target"]>;
        };
        const submitted: MutableOperationInput = {
          target: { ...receiptTarget },
          config: parseReviewConfigurationStrict(override),
          expectedVersion: 3,
          operationId: "c2b-concurrent-batch",
        };
        const directSubmitted: MutableOperationInput = {
          ...submitted,
          target: { ...receiptTarget },
          config: parseReviewConfigurationStrict(override),
        };
        try {
          await sql.query("BEGIN");
          await sql.query(
            'SELECT "id" FROM "ReviewConfiguration" WHERE "id" = $1 FOR UPDATE',
            [receiptRow.configurationId],
          );
          const racing = Promise.allSettled([
            saveReviewConfigurationWithOperation(submitted, {
              configurations: raceRepo,
            }),
            raceRepo.saveNextVersionWithOperation(directSubmitted),
          ]);
          try {
            await expect
              .poll(
                async () => {
                  // This observer also holds the row lock in an open transaction;
                  // discard its cached activity snapshot before each observation.
                  await sql.query("SELECT pg_stat_clear_snapshot()");
                  const observed = await sql.query<{ count: number }>(`
                SELECT count(*)::int AS count FROM pg_stat_activity
                WHERE datname = current_database() AND application_name = 'rr_receipt_race'
                  AND wait_event_type = 'Lock'`);
                  return observed.rows[0]?.count;
                },
                { timeout: 5_000, interval: 20 },
              )
              .toBe(2);
            for (const mutable of [submitted, directSubmitted]) {
              mutable.target.workspaceId = "c2b-x";
              mutable.config.limits.inlineMaxComments = 7;
              mutable.expectedVersion = 99;
              mutable.operationId = "c2b-mutated-batch";
            }
          } finally {
            await sql.query("ROLLBACK");
            // Drain on observation failures as well; no leaked/unhandled work.
            await racing;
          }
          const results = await racing;
          for (const result of results) {
            if (result.status !== "fulfilled") throw result.reason;
            expect(result.value).toMatchObject({
              version: 4,
              config: override,
            });
          }
          expect(results[0]).toEqual(results[1]);
          expect(await versionCount()).toBe(4);

          // Hold actual receipt SELECTs at the SQL boundary. Both use-case and
          // direct repository ingress must own original lookup fields before I/O.
          const lookupSubmitted: MutableOperationInput = {
            ...operation,
            target: { ...receiptTarget },
          };
          const directLookupSubmitted: MutableOperationInput = {
            ...operation,
            target: { ...receiptTarget },
          };
          await sql.query("BEGIN");
          await sql.query(
            'LOCK TABLE "ReviewConfigurationVersion" IN ACCESS EXCLUSIVE MODE',
          );
          const reading = Promise.allSettled([
            findReviewConfigurationOperation(lookupSubmitted, {
              configurations: raceRepo,
            }),
            raceRepo.findOperation(directLookupSubmitted),
          ]);
          try {
            await expect
              .poll(
                async () => {
                  await sql.query("SELECT pg_stat_clear_snapshot()");
                  const observed = await sql.query<{ count: number }>(`
                SELECT count(*)::int AS count FROM pg_stat_activity
                WHERE datname = current_database() AND application_name = 'rr_receipt_race'
                  AND wait_event_type = 'Lock'`);
                  return observed.rows[0]?.count;
                },
                { timeout: 5_000, interval: 20 },
              )
              .toBe(2);
            for (const mutable of [lookupSubmitted, directLookupSubmitted]) {
              mutable.target.workspaceId = "c2b-x";
              mutable.expectedVersion = 1;
              mutable.operationId = "c2b-mutated-lookup";
            }
          } finally {
            await sql.query("ROLLBACK");
            await reading;
          }
          for (const result of await reading) {
            if (result.status !== "fulfilled") throw result.reason;
            expect(result.value).toEqual(committed);
          }
          expect(await versionCount()).toBe(4);
        } finally {
          await sql.query("ROLLBACK");
          await raceClient.$disconnect();
        }
        expect(
          await findReviewConfigurationOperation(
            {
              target: receiptTarget,
              operationId: "c2b-mutated-batch",
              expectedVersion: 3,
            },
            receiptDeps,
          ),
        ).toBeNull();
        const readClient = new PrismaClient({ adapter: new PrismaPg(target) });
        try {
          expect(
            await findReviewConfigurationOperation(operation, {
              configurations: new PrismaReviewConfigurationRepository(
                readClient,
              ),
            }),
          ).toEqual(committed);
        } finally {
          await readClient.$disconnect();
        }

        // Lost save ACK followed by clear used to cascade-delete the receipt:
        // retry could resurrect the override or accept a different full intent.
        // Exercise that lifecycle in this existing isolated, actual SQL fixture.
        await refetched.repositoryConnection.create({
          data: {
            id: "c2b-cleared-receipt-repo",
            workspaceId: "c2b-w",
            externalRepositoryId: "c2b-cleared-receipt-repo",
            owner: "synthetic",
            name: "cleared-receipt",
            fullName: "synthetic/cleared-receipt",
            defaultBranch: "main",
            visibility: "private",
          },
        });
        const clearedTarget = {
          ...repository,
          repositoryId: "c2b-cleared-receipt-repo",
        };
        const lostResponseOperation = {
          target: clearedTarget,
          config: override,
          expectedVersion: null,
          operationId: "c2b-cleared-original",
        };
        // A committed result withheld from the caller models lost response;
        // there is no transport mock or inference that absence means no effect.
        const lostResponseReceipt = await saveReviewConfigurationWithOperation(
          lostResponseOperation,
          receiptDeps,
        );
        expect(lostResponseReceipt.version).toBe(1);
        const retainedHistory = () =>
          refetched!.reviewConfigurationVersion.findMany({
            where: {
              configuration: {
                workspaceId: "c2b-w",
                repositoryId: clearedTarget.repositoryId,
              },
            },
            orderBy: { version: "asc" },
            include: { providers: { orderBy: { order: "asc" } } },
          });
        const originalHistory = await retainedHistory();
        expect(originalHistory).toHaveLength(1);
        const runtimeConfigs = new PrismaActionControlPlaneRepository(
          refetched,
        );
        const runtimeTarget = {
          workspaceId: "c2b-w",
          repositoryId: clearedTarget.repositoryId,
        };
        expect(
          await runtimeConfigs.findRuntimeReviewConfiguration(runtimeTarget),
        ).toEqual({ source: "repository", version: 1, config: override });
        const expectCleared = async (expectedHistory = originalHistory) => {
          expect(await fresh.findLatest(clearedTarget)).toBeNull();
          expect(
            await fresh.findLatestForRepositories({
              workspaceId: "c2b-w",
              repositoryIds: [clearedTarget.repositoryId],
            }),
          ).toEqual([]);
          expect(
            await resolveReviewConfiguration(clearedTarget, receiptDeps),
          ).toMatchObject({ source: "workspace", version: 2, config });
          // CI must ignore retained receipt history on both regular reads and
          // strict admission reads using the existing transaction port.
          expect(
            await runtimeConfigs.findRuntimeReviewConfiguration(runtimeTarget),
          ).toEqual({ source: "workspace", version: 2, config });
          expect(
            await refetched!.$transaction((tx) =>
              runtimeConfigs.findRuntimeReviewConfiguration(
                runtimeTarget,
                tx,
                true,
              ),
            ),
          ).toEqual({ source: "workspace", version: 2, config });
          expect(
            await refetched!.reviewConfiguration.findUniqueOrThrow({
              where: {
                workspaceId_targetKey: {
                  workspaceId: "c2b-w",
                  targetKey: `repo:${clearedTarget.repositoryId}`,
                },
              },
              select: { active: true },
            }),
          ).toEqual({ active: false });
          expect(await retainedHistory()).toEqual(expectedHistory);
        };
        expect(await fresh.deleteTarget(clearedTarget)).toBe(true);
        await expectCleared();
        expect(
          await findReviewConfigurationOperation(
            lostResponseOperation,
            receiptDeps,
          ),
        ).toEqual(lostResponseReceipt);
        expect(
          await saveReviewConfigurationWithOperation(
            lostResponseOperation,
            receiptDeps,
          ),
        ).toEqual(lostResponseReceipt);
        await expectCleared();
        await expect(
          saveReviewConfigurationWithOperation(
            {
              ...lostResponseOperation,
              config,
            },
            receiptDeps,
          ),
        ).rejects.toMatchObject({
          code: "review_configuration_write_conflict",
        });
        await expectCleared();
        expect(
          await refetched.$transaction(async (tx) => {
            const transactionConfigs =
              new PrismaReviewConfigurationTransactionRepository(tx);
            expect(
              await transactionConfigs.findLatest(clearedTarget),
            ).toBeNull();
            return transactionConfigs.deleteTarget(clearedTarget);
          }),
        ).toBe(false);
        // Inactive override has expectedVersion=null, while stored sequence is
        // monotonic. Failed CAS cannot reactivate; new operations may do so.
        await expect(
          fresh.saveNextVersion({
            target: clearedTarget,
            config: override,
            expectedVersion: 1,
          }),
        ).rejects.toMatchObject({
          code: "review_configuration_write_conflict",
        });
        await expectCleared();
        const newOperation = {
          ...lostResponseOperation,
          operationId: "c2b-cleared-new",
          config: parseReviewConfigurationStrict({
            ...override,
            reviewLanguage: "French",
            limits: { ...override.limits, inlineMaxComments: 7 },
            investigationRollout: {
              ...override.investigationRollout,
              recordingEnabled: true,
            },
          }),
        };
        expect(newOperation.expectedVersion).toBeNull();
        const reactivated = await saveReviewConfigurationWithOperation(
          newOperation,
          receiptDeps,
        );
        expect(reactivated.version).toBe(2);
        expect(reactivated.config).toEqual(newOperation.config);
        expect(reactivated.revisionToken).toMatch(/^db:/);
        expect(reactivated.revisionToken).not.toBe(
          lostResponseReceipt.revisionToken,
        );
        expect(
          await findReviewConfigurationOperation(newOperation, receiptDeps),
        ).toEqual(reactivated);
        expect(await fresh.findOperation(newOperation)).toEqual(reactivated);
        expect(
          await saveReviewConfigurationWithOperation(newOperation, receiptDeps),
        ).toEqual(reactivated);
        await expect(
          findReviewConfigurationOperation(
            {
              ...newOperation,
              expectedVersion: 1,
            },
            receiptDeps,
          ),
        ).rejects.toBeInstanceOf(ReviewConfigurationWriteConflictError);
        await expect(
          saveReviewConfigurationWithOperation(
            {
              ...newOperation,
              expectedVersion: 1,
            },
            receiptDeps,
          ),
        ).rejects.toBeInstanceOf(ReviewConfigurationWriteConflictError);
        expect(
          await findReviewConfigurationOperation(
            lostResponseOperation,
            receiptDeps,
          ),
        ).toEqual(lostResponseReceipt);
        expect(
          await saveReviewConfigurationWithOperation(
            lostResponseOperation,
            receiptDeps,
          ),
        ).toEqual(lostResponseReceipt);
        expect(await fresh.findLatest(clearedTarget)).toEqual(reactivated);
        const reactivatedHistory = await retainedHistory();
        expect(reactivatedHistory).toHaveLength(2);
        expect(reactivatedHistory.slice(0, 1)).toEqual(originalHistory);
        expect(await fresh.deleteTarget(clearedTarget)).toBe(true);
        await expectCleared(reactivatedHistory);
        expect(
          await findReviewConfigurationOperation(newOperation, receiptDeps),
        ).toEqual(reactivated);
        expect(
          await saveReviewConfigurationWithOperation(newOperation, receiptDeps),
        ).toEqual(reactivated);
        expect(
          await findReviewConfigurationOperation(
            lostResponseOperation,
            receiptDeps,
          ),
        ).toEqual(lostResponseReceipt);
        expect(
          await saveReviewConfigurationWithOperation(
            lostResponseOperation,
            receiptDeps,
          ),
        ).toEqual(lostResponseReceipt);
        await expect(
          findReviewConfigurationOperation(
            {
              ...newOperation,
              expectedVersion: 1,
            },
            receiptDeps,
          ),
        ).rejects.toBeInstanceOf(ReviewConfigurationWriteConflictError);
        await expect(
          saveReviewConfigurationWithOperation(
            {
              ...newOperation,
              expectedVersion: 1,
            },
            receiptDeps,
          ),
        ).rejects.toBeInstanceOf(ReviewConfigurationWriteConflictError);
        await expectCleared(reactivatedHistory);
        const ordinaryAfterClear = await fresh.saveNextVersion({
          target: clearedTarget,
          config: override,
          expectedVersion: null,
        });
        expect(ordinaryAfterClear.version).toBe(3);
        expect(
          await saveReviewConfigurationWithOperation(
            lostResponseOperation,
            receiptDeps,
          ),
        ).toEqual(lostResponseReceipt);
        expect(await fresh.findLatest(clearedTarget)).toEqual(
          ordinaryAfterClear,
        );
        expect((await retainedHistory()).slice(0, 1)).toEqual(originalHistory);

        // Same batch ID has independent target scope, not a global ledger.
        const scoped = await saveReviewConfigurationWithOperation(
          {
            ...operation,
            target: workspace,
            expectedVersion: 2,
          },
          receiptDeps,
        );
        expect(scoped.version).toBe(3);
        expect(scoped.revisionToken).not.toBe(committed.revisionToken);
        // A stored receipt remains historical even when its selection is revoked;
        // NEW saves retain the existing live binding/profile guards.
        await sql.query(`UPDATE "WorkspaceAccountBinding" SET "state" = 'revoked', "revision" = 2,
        "policyRevision" = 2, "pendingFenceOperationId" = 'c2b-second-revoke-intent',
        "pendingFencePolicySubject" = 'c2b-second', "pendingFencePolicyRevision" = 2 WHERE "id" = 'c2b-second'`);
        // Receipt survives clearing even when the latest version was ordinary;
        // a revoked selection cannot reactivate through a NEW operation.
        expect(await fresh.deleteTarget(clearedTarget)).toBe(true);
        expect(
          await findReviewConfigurationOperation(newOperation, receiptDeps),
        ).toEqual(reactivated);
        expect(await fresh.findOperation(newOperation)).toEqual(reactivated);
        expect(
          await saveReviewConfigurationWithOperation(newOperation, receiptDeps),
        ).toEqual(reactivated);
        await expect(
          findReviewConfigurationOperation(
            {
              ...newOperation,
              expectedVersion: 1,
            },
            receiptDeps,
          ),
        ).rejects.toBeInstanceOf(ReviewConfigurationWriteConflictError);
        expect(
          await findReviewConfigurationOperation(
            lostResponseOperation,
            receiptDeps,
          ),
        ).toEqual(lostResponseReceipt);
        expect(
          await saveReviewConfigurationWithOperation(
            lostResponseOperation,
            receiptDeps,
          ),
        ).toEqual(lostResponseReceipt);
        await expect(
          saveReviewConfigurationWithOperation(
            {
              ...lostResponseOperation,
              operationId: "c2b-cleared-revoked-new",
            },
            receiptDeps,
          ),
        ).rejects.toThrow("review_configuration_gateway_binding_unavailable");
        expect(await fresh.findLatest(clearedTarget)).toBeNull();
        expect(
          await findReviewConfigurationOperation(
            {
              target: clearedTarget,
              operationId: "c2b-cleared-revoked-new",
              expectedVersion: null,
            },
            receiptDeps,
          ),
        ).toBeNull();
        const historyAfterDeniedReactivation = await retainedHistory();
        expect(historyAfterDeniedReactivation).toHaveLength(3);
        expect(historyAfterDeniedReactivation.slice(0, 1)).toEqual(
          originalHistory,
        );
        expect(
          await saveReviewConfigurationWithOperation(operation, receiptDeps),
        ).toEqual(committed);
        await expect(
          saveReviewConfigurationWithOperation(
            {
              ...operation,
              expectedVersion: 4,
              operationId: "c2b-revoked-batch",
            },
            receiptDeps,
          ),
        ).rejects.toThrow("review_configuration_gateway_binding_unavailable");
        expect(
          await findReviewConfigurationOperation(
            {
              target: receiptTarget,
              operationId: "c2b-revoked-batch",
              expectedVersion: 4,
            },
            receiptDeps,
          ),
        ).toBeNull();
        expect(await versionCount()).toBe(4);
        expect(
          await refetched.reviewConfigurationVersion.findUniqueOrThrow({
            where: { id: receiptRow.id },
            include: { providers: { orderBy: { order: "asc" } } },
          }),
        ).toEqual(receiptRow);

        // SQL bypass must enforce a strict pair and scoped uniqueness itself.
        let receiptOrdinal = 2000;
        for (const [patch, code] of [
          [{ operationId: null }, "23514"],
          [{ operationIntentHash: null }, "23514"],
          [{ operationId: "" }, "23514"],
          [{ operationId: "bad\n" }, "23514"],
          [{ operationId: "x".repeat(129) }, "23514"],
          [{ operationIntentHash: "invalid" }, "23514"],
          [{}, "23505"],
        ] as const) {
          receiptOrdinal += 1;
          await expect(
            sql.query(
              `INSERT INTO "ReviewConfigurationVersion" SELECT
            (jsonb_populate_record(NULL::"ReviewConfigurationVersion", to_jsonb(base) || $2::jsonb)).*
            FROM "ReviewConfigurationVersion" base WHERE base."id" = $1`,
              [
                receiptRow.id,
                JSON.stringify({
                  id: `c2b-receipt-denied-${receiptOrdinal}`,
                  version: receiptOrdinal,
                  ...patch,
                }),
              ],
            ),
          ).rejects.toMatchObject({ code });
        }
        // With both overrides cleared, CI returns null to its existing default
        // selection path. Replaying either stable receipt must keep that state.
        expect(await fresh.deleteTarget(workspace)).toBe(true);
        const expectDefault = async () => {
          expect(await fresh.findLatest(workspace)).toBeNull();
          expect(await fresh.findLatest(clearedTarget)).toBeNull();
          expect(
            await resolveReviewConfiguration(clearedTarget, receiptDeps),
          ).toMatchObject({
            source: "default",
            version: 1,
            config: safeDefaultReviewConfiguration,
          });
          expect(
            await runtimeConfigs.findRuntimeReviewConfiguration(runtimeTarget),
          ).toBeNull();
          expect(
            await refetched!.$transaction((tx) =>
              runtimeConfigs.findRuntimeReviewConfiguration(
                runtimeTarget,
                tx,
                true,
              ),
            ),
          ).toBeNull();
        };
        await expectDefault();
        expect(
          await findReviewConfigurationOperation(
            {
              ...operation,
              target: workspace,
              expectedVersion: 2,
            },
            receiptDeps,
          ),
        ).toEqual(scoped);
        expect(
          await saveReviewConfigurationWithOperation(
            {
              ...operation,
              target: workspace,
              expectedVersion: 2,
            },
            receiptDeps,
          ),
        ).toEqual(scoped);
        expect(
          await saveReviewConfigurationWithOperation(
            lostResponseOperation,
            receiptDeps,
          ),
        ).toEqual(lostResponseReceipt);
        expect(
          await findReviewConfigurationOperation(newOperation, receiptDeps),
        ).toEqual(reactivated);
        expect(
          await saveReviewConfigurationWithOperation(newOperation, receiptDeps),
        ).toEqual(reactivated);
        await expectDefault();
        expect(await retainedHistory()).toEqual(historyAfterDeniedReactivation);
      } finally {
        await refetched?.$disconnect();
        if (prisma !== refetched) await prisma?.$disconnect();
        await sql.end();
      }
    }, 240_000);
  },
);
