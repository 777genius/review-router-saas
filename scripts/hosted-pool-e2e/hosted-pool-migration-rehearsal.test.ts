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
  phase !== "verify-000080"
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
