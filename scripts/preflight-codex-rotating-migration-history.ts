import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createPrismaClient } from "../packages/platform/db/src/index";
import type { CodexRotatingMigrationHistoryRow } from "./codex-rotating-migration-history-policy";
import {
  canonicalReleaseMigrationEntries,
  canonicalReleaseMigrationResumeManifestIdentities,
} from "../packages/features/release-rollout/src/domain/release-migration-transition";

const migrationNames = canonicalReleaseMigrationEntries.map(
  ({ migrationName }) => migrationName,
);

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
for (const {
  migrationName,
  migrationSqlSha256: immutableChecksum,
} of canonicalReleaseMigrationEntries) {
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
          ORDER BY "migration_name", "started_at"
        `
      : [];
  const checkedInNames = (
    await readdir(resolve("packages/platform/db/prisma/migrations"))
  ).filter((name) => /^\d{6}_[a-z0-9_]+$/u.test(name));
  const checkedIn = new Map(
    await Promise.all(
      checkedInNames.map(
        async (name) =>
          [
            name,
            createHash("sha256")
              .update(
                await readFile(
                  resolve(
                    "packages/platform/db/prisma/migrations",
                    name,
                    "migration.sql",
                  ),
                ),
              )
              .digest("hex"),
          ] as const,
      ),
    ),
  );
  for (const row of rows) {
    if (
      !checkedIn.has(row.migration_name) ||
      checkedIn.get(row.migration_name) !== row.checksum
    )
      throw new Error(
        `release_migration_history_unknown_or_changed:${row.migration_name}`,
      );
    if (row.finished_at === null && row.rolled_back_at === null)
      throw new Error(
        `release_migration_history_unresolved:${row.migration_name}`,
      );
  }
  for (const name of checkedInNames) {
    if (
      rows.filter(
        (row) =>
          row.migration_name === name &&
          row.finished_at !== null &&
          row.rolled_back_at === null,
      ).length > 1
    )
      throw new Error(`release_migration_history_duplicate_success:${name}`);
  }
  const successful = rows
    .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
    .map((row) => `${row.migration_name}:${row.checksum}`)
    .sort()
    .join(",");
  const manifestIdentity = `sha256:${createHash("sha256").update(successful).digest("hex")}`;
  if (
    !canonicalReleaseMigrationResumeManifestIdentities.includes(
      manifestIdentity,
    )
  )
    throw new Error("release_migration_history_resume_root_untrusted");
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
