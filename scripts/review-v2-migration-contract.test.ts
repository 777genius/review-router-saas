import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  reviewV2ForeignKeys,
  reviewV2MigrationDirectories,
  reviewV2MigrationSteps,
  reviewV2MigrationVersion,
} from "./lib/review-v2-migration-contract.mjs";

const migrationFiles = reviewV2MigrationDirectories.map(
  (directory) =>
    `packages/platform/db/prisma/migrations/${directory}/migration.sql`,
);

describe("Review v2 migration contract", () => {
  it("allowlists every effective Review v2 NOT VALID foreign key with its exact definition", () => {
    const migrationSql = migrationFiles
      .map((path) => readFileSync(join(process.cwd(), path), "utf8"))
      .join("\n")
      .replaceAll(/\s+/gu, " ");

    expect(parseNotValidForeignKeys(migrationSql)).toEqual(reviewV2ForeignKeys);
    expect(reviewV2ForeignKeys).toHaveLength(48);
  });

  it("uses one unambiguous table and constraint identity per allowlisted FK", () => {
    const identities = reviewV2ForeignKeys.map(
      ({ tableName, constraintName }) => `${tableName}\u001f${constraintName}`,
    );
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("binds rollout identity and digest input through API and worker safety migrations", () => {
    expect(reviewV2MigrationDirectories).toEqual([
      "000029_revision_aware_review_v2_expand",
      "000030_review_run_control_persistence",
      "000031_review_invocation_prepared_manifest",
      "000032_review_publication_worker_safety",
      "000037_finalized_projection_artifact_identity",
      "000038_producer_release_context_gateway_artifact",
    ]);
    expect(reviewV2MigrationVersion).toBe("review-v2-000029-000038-v7");
    expect(reviewV2MigrationSteps).toEqual([
      "01_expand_guard",
      "02_repository_identity_backfill",
      "03_legacy_authority_fence_backfill",
      "04_validate_constraints",
      "05_ready_disabled",
    ]);
    expect(
      readFileSync(join(process.cwd(), migrationFiles[2]!), "utf8"),
    ).toContain('ADD COLUMN "preparedManifestCanonicalJson" TEXT');
    expect(
      readFileSync(join(process.cwd(), migrationFiles[5]!), "utf8"),
    ).toContain('ADD COLUMN "contextGatewayPolicyVersion" TEXT');
    expect(
      readFileSync(join(process.cwd(), migrationFiles[3]!), "utf8"),
    ).toContain('ADD COLUMN "observedObjectHash" TEXT');
    const migrateScript = readFileSync(
      join(process.cwd(), "scripts/review-v2-migrate.mjs"),
      "utf8",
    );
    expect(migrateScript).toContain("releaseArtifactSchemaGuardSql()");
    expect(migrateScript).toContain(
      "review_v2_release_immutable_index_invalid",
    );
    for (const investigationIdentityColumn of [
      "reviewInvestigationCapability",
      "reviewInvestigationCoverageProfileHash",
      "reviewInvestigationPolicyHash",
    ]) {
      expect(migrateScript).toContain(`'${investigationIdentityColumn}'`);
    }
  });
});

function parseNotValidForeignKeys(sql: string) {
  const statementPattern =
    /ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)" FOREIGN KEY \(([^)]+)\) REFERENCES "([^"]+)"\(([^)]+)\) ON DELETE (RESTRICT|CASCADE|NO ACTION) ON UPDATE (RESTRICT|CASCADE|NO ACTION)( DEFERRABLE INITIALLY DEFERRED)? NOT VALID;/gu;
  const effectiveDefinitions = new Map<string, ReturnType<typeof definition>>();
  for (const match of sql.matchAll(statementPattern)) {
    const current = definition(match);
    effectiveDefinitions.set(
      `${current.tableName}\u001f${current.constraintName}`,
      current,
    );
  }
  return [...effectiveDefinitions.values()];
}

function definition(match: RegExpMatchArray) {
  return {
    tableName: match[1],
    constraintName: match[2],
    sourceColumns: parseColumns(match[3] ?? ""),
    targetTableName: match[4],
    targetColumns: parseColumns(match[5] ?? ""),
    onDeleteCode: actionCode(match[6]),
    onUpdateCode: actionCode(match[7]),
    deferrable: match[8] !== undefined,
    initiallyDeferred: match[8] !== undefined,
  };
}

function parseColumns(value: string): string[] {
  return [...value.matchAll(/"([^"]+)"/gu)].map((match) => match[1] ?? "");
}

function actionCode(action: string | undefined): string {
  switch (action) {
    case "CASCADE":
      return "c";
    case "NO ACTION":
      return "a";
    case "RESTRICT":
      return "r";
    default:
      throw new Error(`Unsupported foreign-key action: ${action}`);
  }
}
