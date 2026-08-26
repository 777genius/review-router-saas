import { readFileSync } from "node:fs";
import { createHash as hash } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl =
  process.env.REVIEW_ROUTER_HOSTED_POOL_MIGRATION_DATABASE_URL;
if (!databaseUrl)
  throw new Error("hosted_pool_migration_database_url_required");
const phase = process.env.REVIEW_ROUTER_HOSTED_POOL_MIGRATION_PHASE;
if (
  phase !== "seed-000074" &&
  phase !== "verify-000075" &&
  phase !== "verify-000076" &&
  phase !== "verify-000077" &&
  phase !== "verify-000079" &&
  phase !== "verify-000080" &&
  phase !== "verify-000081" &&
  phase !== "verify-000082" &&
  phase !== "verify-000083" &&
  phase !== "verify-000084" &&
  phase !== "verify-000085" &&
  phase !== "verify-000086"
) {
  throw new Error("hosted_pool_migration_phase_required");
}
const parsed = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
  !parsed.pathname.startsWith("/reviewrouter_hosted_pool_migration_")
) {
  throw new Error("hosted_pool_migration_database_must_be_disposable_loopback");
}

const migration74Path =
  "packages/platform/db/prisma/migrations/000074_hosted_codex_account_pool/migration.sql";
const expectedMigration74Sha256 =
  "c992feca661fba44d5f147bab3834c2fd9223c43b1a161dcd1f1787993b32014";
const client = new Client({ connectionString: databaseUrl });

beforeAll(async () => {
  await client.connect();
  if (phase === "seed-000074") await client.query(seedLegacyRows);
});

afterAll(async () => client.end());

describe("hosted pool populated 000074 to 000075 migration", () => {
  it.runIf(phase === "verify-000083")(
    "adds the durable mint ledger and closed legacy quarantine without rewriting legacy receipts",
    async () => {
      const objects = await client.query(`
        SELECT to_regclass('public."HostedCodexCommentTokenMint"')::text AS mint,
               to_regclass('public."HostedCodexRuntimeClosure"')::text AS closure,
               (SELECT COUNT(*)::int FROM "HostedCodexRuntimeClosure" WHERE "state" = 'draining' AND "legacyBarrier") AS barriers,
               (SELECT COUNT(*)::int FROM "HostedCodexCommentRefreshUse" WHERE "mintId" IS NULL) AS legacy_uses,
               (SELECT "status"::text FROM "HostedCodexRuntimeGate" WHERE "id" = 'global') AS gate_status,
               (SELECT "authzEpoch"::text FROM "HostedCodexRuntimeGate" WHERE "id" = 'global') AS gate_epoch,
               (SELECT "revision"::text FROM "HostedCodexRuntimeGate" WHERE "id" = 'global') AS gate_revision
      `);
      expect(objects.rows).toEqual([
        {
          mint: '"HostedCodexCommentTokenMint"',
          closure: '"HostedCodexRuntimeClosure"',
          barriers: 1,
          legacy_uses: 0,
          gate_status: "closed",
          gate_epoch: "3",
          gate_revision: "3",
        },
      ]);
    },
  );
  it.runIf(phase === "verify-000083")(
    "limits post-issue revocation triggers to mutable authorization columns",
    async () => {
      const triggers = await client.query(`
        SELECT tgname, pg_get_triggerdef(oid, true) AS definition
        FROM pg_trigger
        WHERE tgname IN (
          'HostedCodexRepositoryBinding_comment_token_revoke',
          'HostedCodexPool_comment_token_revoke',
          'RepositoryConnection_comment_token_revoke',
          'GitHubInstallation_comment_token_revoke',
          'HostedCodexInvocationGrant_comment_token_revoke',
          'HostedCodexCommentRefreshCapability_comment_token_revoke',
          'HostedCodexRuntimeGate_comment_token_revoke'
        )
        ORDER BY tgname
      `);
      expect(triggers.rows).toHaveLength(7);
      expect(triggers.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tgname: "HostedCodexInvocationGrant_comment_token_revoke",
            definition: expect.stringContaining(
              'UPDATE OF status, "revokedAt", "expiresAt"',
            ),
          }),
          expect.objectContaining({
            tgname: "GitHubInstallation_comment_token_revoke",
            definition: expect.stringContaining('"workspaceId"'),
          }),
          expect.objectContaining({
            tgname: "RepositoryConnection_comment_token_revoke",
            definition: expect.stringContaining(
              "UPDATE OF provider, selected, archived, visibility",
            ),
          }),
        ]),
      );
      for (const trigger of triggers.rows)
        expect(String(trigger.definition)).not.toContain("requestCount");
    },
  );
  it.runIf(phase === "verify-000083")(
    "matches the exact raw-SQL mint and closure security catalog allowlist",
    async () => {
      const constraints = await client.query(`
        SELECT conname, contype, convalidated, pg_get_constraintdef(oid, true) AS definition
        FROM pg_constraint
        WHERE conrelid IN (
          '"HostedCodexCommentTokenMint"'::regclass,
          '"HostedCodexRuntimeClosure"'::regclass,
          '"HostedCodexCommentTokenRevocationProof"'::regclass,
          '"HostedCodexCommentRefreshUse"'::regclass
        ) AND (
          conname LIKE 'HostedCodexCommentToken%'
          OR conname = 'HostedCodexCommentRefreshUse_mint_fkey'
          OR conname LIKE 'HostedCodexRuntimeClosure%'
        )
        ORDER BY conname
      `);
      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "HostedCodexCommentRefreshUse_mint_fkey",
        "HostedCodexCommentTokenMint_grant_fkey",
        "HostedCodexCommentTokenMint_pkey",
        "HostedCodexCommentTokenMint_shape_check",
        "HostedCodexCommentTokenRevocationProof_mint_fkey",
        "HostedCodexCommentTokenRevocationProof_pkey",
        "HostedCodexCommentTokenRevocationProof_shape_check",
        "HostedCodexRuntimeClosure_gate_revision_key",
        "HostedCodexRuntimeClosure_pkey",
        "HostedCodexRuntimeClosure_shape_check",
      ]);
      expect(constraints.rows.every((row) => row.convalidated === true)).toBe(
        true,
      );

      const indexes = await client.query(`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND (
          indexname LIKE 'HostedCodexCommentTokenMint_%' OR
          indexname = 'HostedCodexCommentRefreshUse_mint_key')
        ORDER BY indexname
      `);
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "HostedCodexCommentRefreshUse_mint_key",
        "HostedCodexCommentTokenMint_authority_idx",
        "HostedCodexCommentTokenMint_drain_idx",
        "HostedCodexCommentTokenMint_initial_grant_key",
        "HostedCodexCommentTokenMint_logical_key",
        "HostedCodexCommentTokenMint_pkey",
        "HostedCodexCommentTokenMint_refresh_request_key",
        "HostedCodexCommentTokenMint_token_hash_key",
      ]);
      expect(
        indexes.rows.find(
          (row) =>
            row.indexname === "HostedCodexCommentTokenMint_initial_grant_key",
        )?.indexdef,
      ).toContain("WHERE (purpose = 'initial'");

      const triggers = await client.query(`
        SELECT tgname, tgenabled, pg_get_triggerdef(oid, true) AS definition
        FROM pg_trigger WHERE NOT tgisinternal AND tgfoid IN (
          'hosted_codex_comment_token_mint_guard()'::regprocedure,
          'hosted_codex_runtime_closure_guard()'::regprocedure,
          'hosted_codex_runtime_gate_activation_barrier()'::regprocedure,
          'hosted_codex_comment_token_authority_revoke_enqueue()'::regprocedure,
          'hosted_codex_comment_refresh_use_mint_guard()'::regprocedure
        ) ORDER BY tgname
      `);
      expect(triggers.rows.map((row) => row.tgname)).toEqual([
        "GitHubInstallation_comment_token_revoke",
        "HostedCodexCommentRefreshCapability_comment_token_revoke",
        "HostedCodexCommentRefreshUse_mint_guard",
        "HostedCodexCommentTokenMint_guard",
        "HostedCodexInvocationGrant_comment_token_revoke",
        "HostedCodexPool_comment_token_revoke",
        "HostedCodexRepositoryBinding_comment_token_revoke",
        "HostedCodexRuntimeClosure_guard",
        "HostedCodexRuntimeGate_activation_barrier",
        "HostedCodexRuntimeGate_comment_token_revoke",
        "RepositoryConnection_comment_token_revoke",
      ]);
      expect(triggers.rows.every((row) => row.tgenabled === "O")).toBe(true);

      const functions = await client.query(`
        SELECT proname, prosecdef, proconfig
        FROM pg_proc JOIN pg_namespace ON pg_namespace.oid = pronamespace
        WHERE nspname = 'public' AND proname IN (
          'hosted_codex_comment_refresh_use_mint_guard',
          'hosted_codex_comment_token_mint_guard',
          'hosted_codex_runtime_closure_guard',
          'hosted_codex_runtime_gate_activation_barrier',
          'hosted_codex_comment_token_authority_revoke_enqueue',
          'hosted_codex_finalize_comment_token_revocation'
        ) ORDER BY proname
      `);
      expect(functions.rows).toHaveLength(6);
      for (const fn of functions.rows) {
        expect(fn.proconfig).toContain("search_path=pg_catalog, pg_temp");
        expect(fn.prosecdef).toBe(
          fn.proname === "hosted_codex_finalize_comment_token_revocation",
        );
      }
    },
  );
  it.runIf(phase === "verify-000083")(
    "starts legacy quarantine only from a one-way drained-issuer acknowledgment",
    async () => {
      const acknowledged = await client.query(`
        UPDATE "HostedCodexRuntimeClosure"
        SET "legacyBarrier" = FALSE,
            "legacyUnsafeUntil" = clock_timestamp() + INTERVAL '61 minutes 1 second',
            "revision" = "revision" + 1
        WHERE "legacyBarrier"
        RETURNING "id", "legacyBarrier",
          "legacyUnsafeUntil" >= clock_timestamp() + INTERVAL '61 minutes' AS bounded
      `);
      expect(acknowledged.rows).toEqual([
        expect.objectContaining({ legacyBarrier: false, bounded: true }),
      ]);
      await expect(
        client.query(`
          UPDATE "HostedCodexRuntimeClosure"
          SET "legacyUnsafeUntil" = "legacyUnsafeUntil" - INTERVAL '1 minute',
              "revision" = "revision" + 1
        `),
      ).rejects.toThrow("hosted_codex_runtime_closure_transition_invalid");
      await expect(
        client.query(`
          UPDATE "HostedCodexRuntimeClosure"
          SET "state" = 'complete', "completedAt" = clock_timestamp(),
              "revision" = "revision" + 1
        `),
      ).rejects.toThrow("hosted_codex_runtime_closure_unsafe");
    },
  );

  it.runIf(phase === "verify-000084")(
    "hardens custody behind narrow security-definer routines",
    async () => {
      const migration = await client.query(`
        SELECT COUNT(*)::int AS count
        FROM "_prisma_migrations"
        WHERE migration_name = '000084_harden_comment_token_custody'
          AND finished_at IS NOT NULL AND rolled_back_at IS NULL
      `);
      expect(migration.rows[0]?.count).toBe(1);

      const routines = await client.query(`
        SELECT p.proname,
               pg_get_function_identity_arguments(p.oid) AS arguments,
               p.prosecdef,
               array_to_string(p.proconfig, ',') AS config,
               has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
               has_function_privilege(
                 'reviewrouter_comment_token_custody', p.oid, 'EXECUTE'
               ) AS custody_execute
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN (
          'hosted_codex_claim_comment_token_delivery',
          'hosted_codex_mutate_comment_token_mint',
          'hosted_codex_mutate_comment_token_mint_v83'
        )
        ORDER BY p.proname
      `);
      expect(routines.rows).toEqual([
        expect.objectContaining({
          proname: "hosted_codex_claim_comment_token_delivery",
          arguments:
            "p_mint_id text, p_token_hash text, p_delivery_claim_id_hash text",
          prosecdef: true,
          config: "search_path=pg_catalog, pg_temp",
          public_execute: false,
          custody_execute: true,
        }),
        expect.objectContaining({
          proname: "hosted_codex_mutate_comment_token_mint",
          arguments: "p_operation text, p_arguments jsonb",
          prosecdef: true,
          config: "search_path=pg_catalog, pg_temp",
          public_execute: false,
          custody_execute: true,
        }),
        expect.objectContaining({
          proname: "hosted_codex_mutate_comment_token_mint_v83",
          arguments: "p_operation text, p_arguments jsonb",
          prosecdef: true,
          config: "search_path=pg_catalog, pg_temp",
          public_execute: false,
          custody_execute: false,
        }),
      ]);

      const tableAuthority = await client.query(`
        SELECT role_name,
               has_table_privilege(
                 role_name, 'public."HostedCodexCommentTokenMint"', 'SELECT'
               ) AS can_select,
               has_table_privilege(
                 role_name, 'public."HostedCodexCommentTokenMint"', 'INSERT,UPDATE,DELETE'
               ) AS can_mutate
        FROM unnest(ARRAY[
          'reviewrouter_api', 'reviewrouter_web', 'reviewrouter_worker',
          'reviewrouter_comment_token_custody'
        ]) AS role_name
        ORDER BY role_name
      `);
      expect(tableAuthority.rows.every((row) => row.can_mutate === false)).toBe(
        true,
      );
      expect(tableAuthority.rows).toEqual([
        expect.objectContaining({
          role_name: "reviewrouter_api",
          can_select: false,
        }),
        expect.objectContaining({
          role_name: "reviewrouter_comment_token_custody",
          can_select: true,
        }),
        expect.objectContaining({
          role_name: "reviewrouter_web",
          can_select: false,
        }),
        expect.objectContaining({
          role_name: "reviewrouter_worker",
          can_select: false,
        }),
      ]);
    },
  );

  it.runIf(phase === "verify-000085")(
    "returns a typed result from the narrow runtime-gate lock authority",
    async () => {
      const result = await client.query(`
        SELECT
          (SELECT COUNT(*)::int FROM "_prisma_migrations"
           WHERE migration_name = '000085_comment_token_gate_lock_result'
             AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS migration_count,
          p.prosecdef,
          pg_get_function_result(p.oid) AS result_type,
          array_to_string(p.proconfig, ',') AS config,
          has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
          has_function_privilege(
            'reviewrouter_comment_token_custody', p.oid, 'EXECUTE'
          ) AS custody_execute
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'hosted_codex_lock_comment_token_runtime_gate'
          AND pg_get_function_identity_arguments(p.oid) = ''
      `);
      expect(result.rows).toEqual([
        {
          migration_count: 1,
          prosecdef: true,
          result_type: "boolean",
          config: "search_path=pg_catalog, pg_temp",
          public_execute: false,
          custody_execute: true,
        },
      ]);
    },
  );
  it.runIf(phase === "verify-000086")(
    "adds fair revocation scheduling and narrow mint lock authority",
    async () => {
      const result = await client.query(`
        SELECT
          (SELECT COUNT(*)::int FROM "_prisma_migrations"
           WHERE migration_name = '000086_comment_token_custody_r18_remediation'
             AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS migration_count,
          (SELECT COUNT(*)::int FROM pg_indexes
           WHERE indexname = 'HostedCodexCommentTokenMint_revocation_queue_idx') AS queue_indexes,
          (SELECT datetime_precision FROM information_schema.columns
           WHERE table_schema='public' AND table_name='HostedCodexCommentTokenMint'
             AND column_name='nextRevocationAt') AS revocation_precision,
          (SELECT COUNT(*)::int FROM pg_trigger
           WHERE tgname='HostedCodexCommentTokenMint_zz_prepare_authority_complete'
             AND NOT tgisinternal) AS authority_triggers,
          has_function_privilege('public',
            'hosted_codex_comment_token_prepare_authority_complete()', 'EXECUTE') AS authority_public_execute,
          has_function_privilege('public',
            'hosted_codex_lock_comment_token_mint(text)', 'EXECUTE') AS public_execute,
          has_function_privilege('reviewrouter_comment_token_custody',
            'hosted_codex_lock_comment_token_mint(text)', 'EXECUTE') AS custody_execute,
          has_function_privilege('reviewrouter_api',
            'hosted_codex_lock_comment_token_mint(text)', 'EXECUTE') AS api_execute,
          has_function_privilege('reviewrouter_web',
            'hosted_codex_lock_comment_token_mint(text)', 'EXECUTE') AS web_execute,
          has_function_privilege('reviewrouter_worker',
            'hosted_codex_lock_comment_token_mint(text)', 'EXECUTE') AS worker_execute,
          has_function_privilege('reviewrouter_codex_effect_authority',
            'hosted_codex_lock_comment_token_mint(text)', 'EXECUTE') AS effect_execute
      `);
      expect(result.rows).toEqual([
        {
          migration_count: 1,
          queue_indexes: 1,
          revocation_precision: 3,
          authority_triggers: 1,
          authority_public_execute: false,
          public_execute: false,
          custody_execute: true,
          api_execute: false,
          web_execute: false,
          worker_execute: false,
          effect_execute: false,
        },
      ]);
    },
  );
  it.runIf(phase === "seed-000074")(
    "seeds representative populated 000074 state",
    async () => {
      const seeded = await client.query(
        `SELECT COUNT(*)::int AS count FROM "HostedCodexInvocationGrant" WHERE "id" = 'grant-legacy'`,
      );
      expect(seeded.rows[0]?.count).toBe(1);
    },
  );

  it.runIf(phase === "verify-000079")(
    "backfills immutable server-side output budgets",
    async () => {
      const constraint = await client.query(`
        SELECT convalidated
        FROM pg_constraint
        WHERE conname = 'HostedCodexInvocationGrant_output_budget_check'
      `);
      expect(constraint.rows).toEqual([{ convalidated: false }]);
      const budget = await client.query(`
        SELECT "maxResponseBytes", "maxOutputTokens"
        FROM "HostedCodexInvocationGrant"
        WHERE "id" = 'grant-legacy'
      `);
      expect(budget.rows[0]).toEqual({
        maxResponseBytes: 8_000_000,
        maxOutputTokens: 32_768,
      });
      await expect(
        client.query(`
          UPDATE "HostedCodexInvocationGrant"
          SET "maxOutputTokens" = 32767
          WHERE "id" = 'grant-legacy'
        `),
      ).rejects.toThrow("hosted_codex_grant_output_budget_immutable");
    },
  );

  it.runIf(phase === "verify-000079")(
    "keeps grant DML available while revalidating the committed constraint",
    async () => {
      const validator = new Client({ connectionString: databaseUrl });
      await validator.connect();
      try {
        await validator.query("BEGIN");
        await validator.query(`
          ALTER TABLE "HostedCodexInvocationGrant"
          VALIDATE CONSTRAINT "HostedCodexInvocationGrant_output_budget_check"
        `);
        await client.query("SET lock_timeout = '250ms'");
        try {
          await expect(
            cloneLegacyGrant(
              "grant-validation-concurrent",
              "invocation-validation-concurrent",
              undefined,
            ),
          ).resolves.toMatchObject({ rowCount: 1 });
        } finally {
          await client.query("SET lock_timeout = DEFAULT");
        }
      } finally {
        await validator.query("ROLLBACK");
        await validator.end();
      }
    },
  );

  it.runIf(phase === "verify-000082")(
    "records the follow-up validation migration without weakening the constraint",
    async () => {
      const result = await client.query(`
        SELECT c.convalidated,
               EXISTS (
                 SELECT 1 FROM "_prisma_migrations"
                 WHERE migration_name = '000079_hosted_codex_output_limits'
                   AND finished_at IS NOT NULL AND rolled_back_at IS NULL
               ) AS metadata_committed,
               EXISTS (
                 SELECT 1 FROM "_prisma_migrations"
                 WHERE migration_name = '000082_validate_hosted_codex_output_limits'
                   AND finished_at IS NOT NULL AND rolled_back_at IS NULL
               ) AS validation_committed
        FROM pg_constraint c
        WHERE c.conname = 'HostedCodexInvocationGrant_output_budget_check'
      `);
      expect(result.rows).toEqual([
        {
          convalidated: true,
          metadata_committed: true,
          validation_committed: true,
        },
      ]);
    },
  );

  it.runIf(phase === "verify-000079")(
    "seeds historical effect evidence before credential generation binding",
    async () => {
      await client.query(`
        INSERT INTO "HostedCodexUpstreamEffectAttempt" (
          "id", "relayRequestId", "grantId", "workspaceId", "poolId",
          "accountId", "attemptOrdinal", "requestHash", "idempotencyKeyHash",
          "state", "ownerIdHash", "fenceEpoch", "heartbeatAt",
          "leaseExpiresAt", "updatedAt"
        ) VALUES (
          'attempt-legacy', 'request-legacy', 'grant-legacy',
          'workspace-legacy', 'pool-legacy', 'account-legacy', 1,
          '${h64}', '${h64.replaceAll("a", "1")}', 'prepared',
          '${h64.replaceAll("a", "2")}', 1, CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP
        )
      `);
      const seeded = await client.query(`
        SELECT COUNT(*)::int AS count
        FROM "HostedCodexUpstreamEffectAttempt"
        WHERE "id" = 'attempt-legacy'
      `);
      expect(seeded.rows[0]?.count).toBe(1);
    },
  );

  it.runIf(phase === "verify-000080")(
    "requires and preserves exact credential generation on new attempts",
    async () => {
      const migration = await client.query(`
        SELECT COUNT(*)::int AS count
        FROM "_prisma_migrations"
        WHERE migration_name = '000080_hosted_codex_attempt_generation'
          AND finished_at IS NOT NULL AND rolled_back_at IS NULL
      `);
      expect(migration.rows[0]?.count).toBe(1);
      const contract = await client.query(`
        SELECT
          (SELECT is_nullable FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'HostedCodexUpstreamEffectAttempt'
             AND column_name = 'credentialGeneration') AS nullable,
          pg_get_triggerdef(t.oid) AS trigger_definition,
          pg_get_functiondef(t.tgfoid) AS guard_definition
        FROM pg_trigger t
        WHERE t.tgrelid = '"HostedCodexUpstreamEffectAttempt"'::regclass
          AND t.tgname = 'HostedCodexUpstreamEffectAttempt_monotonic'
      `);
      expect(contract.rows[0]?.nullable).toBe("YES");
      expect(contract.rows[0]?.trigger_definition).toContain(
        "BEFORE INSERT OR UPDATE",
      );
      expect(contract.rows[0]?.guard_definition).toContain(
        "hosted_codex_effect_attempt_generation_required",
      );

      const legacy = await client.query(`
        SELECT "credentialGeneration", "state"
        FROM "HostedCodexUpstreamEffectAttempt"
        WHERE "id" = 'attempt-legacy'
      `);
      expect(legacy.rows[0]).toEqual({
        credentialGeneration: null,
        state: "prepared",
      });
      await client.query(`
        UPDATE "HostedCodexUpstreamEffectAttempt"
        SET "heartbeatAt" = "heartbeatAt" + INTERVAL '1 second',
            "leaseExpiresAt" = "leaseExpiresAt" + INTERVAL '1 second',
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = 'attempt-legacy'
      `);
      await expect(
        client.query(`
          UPDATE "HostedCodexUpstreamEffectAttempt"
          SET "credentialGeneration" = 1
          WHERE "id" = 'attempt-legacy'
        `),
      ).rejects.toThrow("hosted_codex_effect_attempt_generation_immutable");

      await client.query(`
        INSERT INTO "HostedCodexUpstreamEffectAttempt" (
          "id", "relayRequestId", "grantId", "workspaceId", "poolId",
          "accountId", "credentialGeneration", "attemptOrdinal",
          "requestHash", "idempotencyKeyHash", "state", "ownerIdHash",
          "fenceEpoch", "heartbeatAt", "leaseExpiresAt", "updatedAt"
        ) VALUES (
          'attempt-generation-valid', 'request-legacy', 'grant-legacy',
          'workspace-legacy', 'pool-legacy', 'account-legacy', 1, 2,
          '${h64}', '${h64.replaceAll("a", "3")}', 'prepared',
          '${h64.replaceAll("a", "4")}', 1, CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP
        )
      `);
      await expect(
        client.query(`
          INSERT INTO "HostedCodexUpstreamEffectAttempt" (
            "id", "relayRequestId", "grantId", "workspaceId", "poolId",
            "accountId", "attemptOrdinal", "requestHash",
            "idempotencyKeyHash", "state", "ownerIdHash", "fenceEpoch",
            "heartbeatAt", "leaseExpiresAt", "updatedAt"
          ) VALUES (
            'attempt-generation-missing', 'request-legacy', 'grant-legacy',
            'workspace-legacy', 'pool-legacy', 'account-legacy', 3,
            '${h64}', '${h64.replaceAll("a", "5")}', 'prepared',
            '${h64.replaceAll("a", "6")}', 1, CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP
          )
        `),
      ).rejects.toThrow("hosted_codex_effect_attempt_generation_required");
      await expect(
        client.query(`
          INSERT INTO "HostedCodexUpstreamEffectAttempt" (
            "id", "relayRequestId", "grantId", "workspaceId", "poolId",
            "accountId", "credentialGeneration", "attemptOrdinal",
            "requestHash", "idempotencyKeyHash", "state", "ownerIdHash",
            "fenceEpoch", "heartbeatAt", "leaseExpiresAt", "updatedAt"
          ) VALUES (
            'attempt-generation-unknown', 'request-legacy', 'grant-legacy',
            'workspace-legacy', 'pool-legacy', 'account-legacy', 999, 4,
            '${h64}', '${h64.replaceAll("a", "7")}', 'prepared',
            '${h64.replaceAll("a", "8")}', 1, CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP
          )
        `),
      ).rejects.toThrow(
        "HostedCodexUpstreamEffectAttempt_credential_generation_fkey",
      );
    },
  );

  it.runIf(phase === "verify-000081")(
    "preserves legacy grants while requiring the live singleton epoch for new grants",
    async () => {
      const legacy = await client.query(`
        SELECT "status", "runtimeAuthzEpoch", "revokedAt" IS NOT NULL AS revoked
        FROM "HostedCodexInvocationGrant" WHERE "id" = 'grant-legacy'
      `);
      expect(legacy.rows[0]).toEqual({
        status: "revoked",
        runtimeAuthzEpoch: null,
        revoked: true,
      });
      const legacyCapability = await client.query(`
        SELECT "revokedAt" IS NOT NULL AS revoked
        FROM "HostedCodexCommentRefreshCapability"
        WHERE "id" = 'comment-capability-legacy'
      `);
      expect(legacyCapability.rows[0]?.revoked).toBe(true);

      const gate = await client.query(`
        SELECT "id", "status", "authzEpoch"::text, "revision"::text
        FROM "HostedCodexRuntimeGate"
      `);
      expect(gate.rows).toEqual([
        { id: "global", status: "closed", authzEpoch: "1", revision: "1" },
      ]);

      await expect(
        cloneLegacyGrant("grant-gate-closed", "invocation-gate-closed", 1),
      ).rejects.toThrow("hosted_codex_runtime_gate_authority_mismatch");
      await client.query(`
        UPDATE "HostedCodexRuntimeGate"
        SET "status" = 'active', "authzEpoch" = 2, "revision" = 2,
            "reasonCode" = 'migration_rehearsal_activation',
            "changedAt" = "changedAt" + INTERVAL '1 second',
            "changedByHash" = '${h64.replaceAll("a", "7")}'
        WHERE "id" = 'global' AND "revision" = 1
      `);
      await expect(
        cloneLegacyGrant("grant-gate-missing", "invocation-gate-missing", null),
      ).rejects.toThrow("hosted_codex_runtime_gate_epoch_required");
      await cloneLegacyGrant("grant-gate-active", "invocation-gate-active", 2);
      await expect(
        client.query(`
          UPDATE "HostedCodexInvocationGrant"
          SET "runtimeAuthzEpoch" = 3
          WHERE "id" = 'grant-gate-active'
        `),
      ).rejects.toThrow("hosted_codex_grant_identity_immutable");
    },
  );

  it("keeps 000074 byte-identical", () => {
    expect(
      hash("sha256").update(readFileSync(migration74Path)).digest("hex"),
    ).toBe(expectedMigration74Sha256);
  });

  it.runIf(phase === "verify-000075")(
    "preserves legacy ciphertext as a revision and quarantines it",
    async () => {
      const revision = await client.query(`
      SELECT "custodyMode", "reason", "encryptedCiphertext"
      FROM "HostedCodexCredentialEnvelopeRevision"
      WHERE "credentialVersionId" = 'credential-legacy'
    `);
      expect(revision.rows).toEqual([
        {
          custodyMode: "legacy_env",
          reason: "legacy_upgrade",
          encryptedCiphertext: "Y2lwaGVydGV4dA==",
        },
      ]);
      const account = await client.query(
        `SELECT "state", "healthVersion"::text FROM "HostedCodexAccount" WHERE "id" = 'account-legacy'`,
      );
      expect(account.rows[0]).toEqual({
        state: "restore_quarantined",
        healthVersion: "2",
      });
    },
  );

  it.runIf(phase === "verify-000076")(
    "applies the terminalization invariants after the populated certification migration",
    async () => {
      const migration = await client.query(`
        SELECT COUNT(*)::int AS count
        FROM "_prisma_migrations"
        WHERE migration_name = '000076_hosted_codex_terminalization_restore_invariants'
          AND finished_at IS NOT NULL AND rolled_back_at IS NULL
      `);
      expect(migration.rows[0]?.count).toBe(1);
      const populated = await client.query(`
        SELECT
          (SELECT count(*) FROM "HostedCodexRepositoryBinding")::int AS attestations,
          (SELECT count(*) FROM "HostedCodexCommentRefreshCapability")::int AS comment_capabilities,
          (SELECT count(*) FROM "HostedCodexMutationFence")::int AS mutation_fences,
          (SELECT count(*) FROM "HostedCodexGenerationReceipt")::int AS generation_receipts
      `);
      expect(populated.rows[0]).toEqual({
        attestations: 1,
        comment_capabilities: 1,
        mutation_fences: 1,
        generation_receipts: 1,
      });
    },
  );

  it.runIf(phase === "verify-000077")(
    "applies the r57 accounting and active restore-scope remediation",
    async () => {
      const migration = await client.query(`
        SELECT COUNT(*)::int AS count
        FROM "_prisma_migrations"
        WHERE migration_name = '000077_hosted_codex_r57_security_race_remediation'
          AND finished_at IS NOT NULL AND rolled_back_at IS NULL
      `);
      expect(migration.rows[0]?.count).toBe(1);
      const indexes = await client.query(`
        SELECT COUNT(*)::int AS count FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'HostedCodexRestoreOperation_active_inventory_target_key'
      `);
      expect(indexes.rows[0]?.count).toBe(1);
    },
  );

  it.runIf(phase === "verify-000075")(
    "revokes grants and terminalizes ambiguous request accounting atomically",
    async () => {
      const grant = await client.query(`
      SELECT "status", "inFlight", "requestCount", "revokedAt" IS NOT NULL AS revoked
      FROM "HostedCodexInvocationGrant" WHERE "id" = 'grant-legacy'
    `);
      expect(grant.rows[0]).toEqual({
        status: "revoked",
        inFlight: 0,
        requestCount: 1,
        revoked: true,
      });
      const request = await client.query(`
      SELECT "status", "errorCode", "completedAt" IS NOT NULL AS completed
      FROM "HostedCodexRelayRequest" WHERE "id" = 'request-legacy'
    `);
      expect(request.rows[0]).toEqual({
        status: "terminal_unknown",
        errorCode: "security_certification_upgrade_unknown",
        completed: true,
      });
    },
  );

  it.runIf(phase === "verify-000075")(
    "records exactly one successful additive 000075 migration",
    async () => {
      const migration = await client.query(`
        SELECT COUNT(*)::int AS count
        FROM "_prisma_migrations"
        WHERE migration_name = '000075_hosted_codex_security_certification'
          AND finished_at IS NOT NULL
          AND rolled_back_at IS NULL
      `);
      expect(migration.rows[0]?.count).toBe(1);
    },
  );
});

async function cloneLegacyGrant(
  id: string,
  invocation: string,
  runtimeAuthzEpoch: number | null | undefined,
) {
  const runtimeAuthzEpochColumn =
    runtimeAuthzEpoch === undefined ? "" : ', "runtimeAuthzEpoch"';
  const runtimeAuthzEpochValue =
    runtimeAuthzEpoch === undefined
      ? ""
      : `, ${runtimeAuthzEpoch === null ? "NULL" : runtimeAuthzEpoch}`;
  return client.query(`
    INSERT INTO "HostedCodexInvocationGrant" (
      "id", "invocationId", "workspaceId", "poolId", "repositoryConnectionId",
      "repositoryBindingId", "activeAccountId", "primaryAccountId",
      "reviewRequestId", "providerInvocationKey", "runId", "runAttempt", "model",
      "policyVersion", "policyFingerprint", "runtimeConfigVersion", "bindingRevision",
      "authzEpoch"${runtimeAuthzEpochColumn}, "capabilityTokenHash", "expiresAt",
      "maxRequests", "maxConcurrentRequests", "maxRequestBytes",
      "maxResponseBytes", "maxOutputTokens", "requestCount", "inFlight", "updatedAt"
    )
    SELECT
      '${id}', '${invocation}', "workspaceId", "poolId", "repositoryConnectionId",
      "repositoryBindingId", "activeAccountId", "primaryAccountId",
      '${id}-review', '${id}-provider', '${id}-run', "runAttempt", "model",
      "policyVersion", "policyFingerprint", "runtimeConfigVersion", "bindingRevision",
      "authzEpoch"${runtimeAuthzEpochValue},
      '${hash("sha256").update(id).digest("hex")}', CURRENT_TIMESTAMP + INTERVAL '1 hour',
      "maxRequests", "maxConcurrentRequests", "maxRequestBytes",
      "maxResponseBytes", "maxOutputTokens", 0, 0, CURRENT_TIMESTAMP
    FROM "HostedCodexInvocationGrant" WHERE "id" = 'grant-legacy'
  `);
}

const h64 = "a".repeat(64);
const seedLegacyRows = `
  INSERT INTO "Workspace" ("id", "slug", "name", "updatedAt")
    VALUES ('workspace-legacy', 'workspace-legacy', 'Legacy workspace', CURRENT_TIMESTAMP);
  INSERT INTO "RepositoryConnection" (
    "id", "workspaceId", "externalRepositoryId", "owner", "name", "fullName",
    "defaultBranch", "visibility", "updatedAt"
  ) VALUES (
    'repository-legacy', 'workspace-legacy', 'repository-legacy', 'reviewrouter',
    'migration-rehearsal', 'reviewrouter/migration-rehearsal', 'main', 'private',
    CURRENT_TIMESTAMP
  );
  INSERT INTO "HostedCodexPool" (
    "id", "workspaceId", "name", "updatedAt"
  ) VALUES ('pool-legacy', 'workspace-legacy', 'Legacy', CURRENT_TIMESTAMP);
  INSERT INTO "HostedCodexAccount" (
    "id", "workspaceId", "poolId", "label", "accountFingerprint", "state",
    "healthVersion", "activeGeneration", "updatedAt"
  ) VALUES (
    'account-legacy', 'workspace-legacy', 'pool-legacy', 'Legacy', '${h64}',
    'provisioning_pending', 0, NULL, CURRENT_TIMESTAMP
  );
  INSERT INTO "HostedCodexCredentialVersion" (
    "id", "workspaceId", "poolId", "accountId", "generation",
    "databaseIncarnation", "envelopeVersion", "encryptionAlgorithm", "keyId",
    "aadHash", "generationHash", "ciphertextHash", "encryptedCiphertext",
    "envelopeMetadata"
  ) VALUES (
    'credential-legacy', 'workspace-legacy', 'pool-legacy', 'account-legacy', 1,
    'database-incarnation-legacy', 1, 'aes-256-gcm', 'legacy-key',
    '${h64}', '${h64}', '${h64}', 'Y2lwaGVydGV4dA==',
    '{"nonce":"bm9uY2U=","authenticationTag":"dGFn","wrappedDataEncryptionKey":{"keyId":"legacy-key","nonce":"bm9uY2U=","ciphertext":"d3JhcHBlZA==","authenticationTag":"dGFn"}}'::jsonb
  );
  UPDATE "HostedCodexAccount"
  SET "state" = 'healthy', "activeGeneration" = 1, "healthVersion" = 1,
      "lastHealthyAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'account-legacy';
  INSERT INTO "HostedCodexRepositoryBinding" (
    "id", "workspaceId", "poolId", "repositoryConnectionId", "updatedAt"
  ) VALUES (
    'binding-legacy', 'workspace-legacy', 'pool-legacy', 'repository-legacy', CURRENT_TIMESTAMP
  );
  INSERT INTO "HostedCodexInvocationGrant" (
    "id", "invocationId", "workspaceId", "poolId", "repositoryConnectionId",
    "repositoryBindingId", "activeAccountId", "primaryAccountId",
    "reviewRequestId", "providerInvocationKey", "runId", "runAttempt", "model",
    "policyVersion", "policyFingerprint", "runtimeConfigVersion", "bindingRevision",
    "authzEpoch", "capabilityTokenHash", "expiresAt", "maxRequests",
    "maxConcurrentRequests", "maxRequestBytes", "requestCount", "inFlight", "updatedAt"
  ) VALUES (
    'grant-legacy', 'invocation-legacy', 'workspace-legacy', 'pool-legacy',
    'repository-legacy', 'binding-legacy', 'account-legacy', 'account-legacy',
    'review-legacy', 'provider-legacy', 'run-legacy', 1, 'gpt-test', 'v1', '${h64}',
    1, 1, 1, '${h64.replaceAll("a", "b")}', CURRENT_TIMESTAMP + INTERVAL '1 hour',
    4, 4, 4096, 0, 0, CURRENT_TIMESTAMP
  );
  INSERT INTO "HostedCodexRelayRequest" (
    "id", "grantId", "ordinal", "idempotencyKeyHash", "requestHash", "status",
    "requestBytes", "startedAt", "updatedAt"
  ) VALUES (
    'request-legacy', 'grant-legacy', 1, '${h64.replaceAll("a", "c")}', '${h64}',
    'processing', 128, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
  INSERT INTO "HostedCodexCommentRefreshCapability" (
    "id", "grantId", "invocationId", "repositoryBindingId", "workspaceId",
    "poolId", "repositoryConnectionId", "capabilityTokenHash", "expiresAt",
    "maxUses", "updatedAt"
  ) VALUES (
    'comment-capability-legacy', 'grant-legacy', 'invocation-legacy',
    'binding-legacy', 'workspace-legacy', 'pool-legacy', 'repository-legacy',
    '${h64.replaceAll("a", "d")}', CURRENT_TIMESTAMP + INTERVAL '1 hour', 2,
    CURRENT_TIMESTAMP
  );
  INSERT INTO "HostedCodexMutationFence" (
    "accountId", "workspaceId", "poolId", "fenceEpoch", "ownerIdHash",
    "expectedGeneration", "expiresAt", "updatedAt"
  ) VALUES (
    'account-legacy', 'workspace-legacy', 'pool-legacy', 1,
    '${h64.replaceAll("a", "e")}', 1, CURRENT_TIMESTAMP + INTERVAL '1 hour',
    CURRENT_TIMESTAMP
  );
  INSERT INTO "HostedCodexGenerationReceipt" (
    "id", "credentialVersionId", "accountId", "workspaceId", "poolId",
    "generation", "kind", "mutationFenceEpoch", "actorIdHash", "receiptHash"
  ) VALUES (
    'generation-receipt-legacy', 'credential-legacy', 'account-legacy',
    'workspace-legacy', 'pool-legacy', 1, 'credential_created', 1,
    '${h64.replaceAll("a", "f")}', '${h64.replaceAll("a", "9")}'
  );
`;
