import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPrismaClient } from "../packages/platform/db/src/index";
import {
  assertCodexRotatingMigrationHistoryIsPristine,
  checkedInCodexRotatingMigrationChecksums,
  type CodexRotatingMigrationHistoryRow,
} from "./codex-rotating-migration-history-policy";

const migrationNames = [
  "000060_codex_oauth_setup_serialization",
  "000061_codex_oauth_provider_mutation_fence",
  "000062_codex_oauth_remote_outcome_unknown",
  "000063_codex_oauth_setup_payload_claim",
  "000064_codex_oauth_versioned_secret_namespaces",
  "000065_codex_oauth_authority_acl_hardening",
  "000066_codex_oauth_rotating_cascade_authority",
  "000073_codex_oauth_active_namespace_refresh",
  "000069_release_rollout_ledger",
] as const;

const sourceDigests = Object.fromEntries(
  await Promise.all(
    migrationNames.map(async (migrationName) => [
      migrationName,
      createHash("sha256")
        .update(
          await readFile(
            resolve(
              "packages/platform/db/prisma/migrations",
              migrationName,
              "migration.sql",
            ),
          ),
        )
        .digest("hex"),
    ]),
  ),
);
for (const [migrationName, immutableChecksum] of Object.entries(
  checkedInCodexRotatingMigrationChecksums,
)) {
  if (sourceDigests[migrationName] !== immutableChecksum) {
    throw new Error(
      `codex_rotating_immutable_migration_source_mismatch:${migrationName}`,
    );
  }
}

const credentialPath = process.env.REVIEW_ROUTER_DATABASE_URL_FILE;
const databaseUrl = credentialPath
  ? (await readFile(credentialPath, "utf8")).trim()
  : process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("codex_rotating_migration_preflight_database_url_required");
}
const prisma = createPrismaClient({ databaseUrl, poolMax: 1 });

try {
  const table = await prisma.$queryRaw<Array<{ name: string | null }>>`
    SELECT to_regclass('public._prisma_migrations')::text AS "name"
  `;
  const rows =
    table[0]?.name === "_prisma_migrations"
      ? await prisma.$queryRaw<CodexRotatingMigrationHistoryRow[]>`
          SELECT "migration_name", "checksum", "finished_at", "rolled_back_at",
                 "applied_steps_count"
          FROM "_prisma_migrations"
          WHERE "migration_name" IN (
            '000060_codex_oauth_setup_serialization',
            '000061_codex_oauth_provider_mutation_fence',
            '000062_codex_oauth_remote_outcome_unknown',
            '000063_codex_oauth_setup_payload_claim',
            '000064_codex_oauth_versioned_secret_namespaces',
            '000065_codex_oauth_authority_acl_hardening',
            '000066_codex_oauth_rotating_cascade_authority',
            '000073_codex_oauth_active_namespace_refresh',
            '000067_release_rollout_ledger',
            '000069_release_rollout_ledger'
          )
        `
      : [];
  assertCodexRotatingMigrationHistoryIsPristine(rows);
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      migrationNames,
      checkedInSha256: sourceDigests,
      registeredRows: rows.length,
    })}\n`,
  );
} finally {
  await prisma.$disconnect();
}
