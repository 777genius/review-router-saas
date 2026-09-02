import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const migrationsDirectory = join(
  repositoryRoot,
  "packages/platform/db/prisma/migrations",
);
const migrationName = /^\d{6}_[a-z0-9_]+$/u;

export const canonicalPrismaMigrationNames = Object.freeze(
  readdirSync(migrationsDirectory)
    .filter((name) => {
      const path = join(migrationsDirectory, name);
      return (
        statSync(path).isDirectory() &&
        migrationName.test(name) &&
        statSync(join(path, "migration.sql")).isFile()
      );
    })
    .sort(),
);

if (canonicalPrismaMigrationNames.length === 0)
  throw new Error("canonical_prisma_migration_catalog_empty");

export const canonicalPrismaMigrationCatalog = Object.freeze({
  appliedMigrationCount: canonicalPrismaMigrationNames.length,
  latestMigration: canonicalPrismaMigrationNames.at(-1),
});
