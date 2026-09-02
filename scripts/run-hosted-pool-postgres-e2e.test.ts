import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("scripts/run-hosted-pool-postgres-e2e.mjs", "utf8");

function section(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `${start} must exist`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `${end} must follow ${start}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function expectOrdered(body: string, statements: string[]): void {
  const positions = statements.map((statement) => {
    const position = body.indexOf(statement);
    expect(position, `${statement} must exist`).toBeGreaterThanOrEqual(0);
    return position;
  });
  expect(positions).toEqual([...positions].sort((left, right) => left - right));
}

describe("hosted pool PostgreSQL migration ordering", () => {
  it("keeps the V5 migrations out of every pre-handoff catalog", () => {
    for (const migration of [
      "000087_codex_oauth_v4_v5_workflow_reattestation",
      "000088_codex_oauth_reattestation_mutation_owner_fence",
      "000089_codex_oauth_v4_v5_staged_compatibility",
    ]) {
      expect(source.match(new RegExp(migration, "gu"))).toHaveLength(1);
    }
    expect(source).toContain("...codexOAuthV5Migrations");
    expect(source).toContain(
      "filter: (source) => !excludedMigrations.has(basename(source))",
    );
  });

  it("hands off authority before V5 in the populated migration rehearsal", () => {
    const migrationMode = section(
      "if (runMigration) {",
      "if (runPostgresE2e) {",
    );
    expect(migrationMode).toContain("excludeHostedPoolMigrations: true");
    expectOrdered(migrationMode, [
      "for (const migration of hostedPoolStagedMigrations)",
      "await prepareCodexOAuthV5ReleaseAuthority(migrationDatabaseUrl)",
      "applyCodexOAuthV5Migrations(rehearsalDirectory, migrationDatabaseUrl)",
    ]);
  });

  it("hands off authority before V5 in the full PostgreSQL E2E", () => {
    const postgresMode = section("if (runPostgresE2e) {", "} finally {");
    expect(postgresMode).toContain("excludeHostedPoolMigrations: false");
    expectOrdered(postgresMode, [
      "runMigrationDeploy(rehearsalDirectory, databaseUrl)",
      "await prepareCodexOAuthV5ReleaseAuthority(databaseUrl)",
      "applyCodexOAuthV5Migrations(rehearsalDirectory, databaseUrl)",
      "await applyProductionRuntimeAcl(databaseUrl, database)",
    ]);
  });

  it("uses one narrow, verified authority handoff and ordered deploy loop", () => {
    const authority = section(
      "async function prepareCodexOAuthV5ReleaseAuthority(url)",
      "function runMigrationDeploy(directory, url)",
    );
    expect(authority).toContain(
      "ALTER SCHEMA public OWNER TO reviewrouter_release_schema_owner",
    );
    expect(authority).toContain(
      'ALTER TABLE public."CodexOAuthSecretNamespace"',
    );
    expect(authority).toContain(
      'throw new Error("codex_oauth_v5_release_authority_invalid")',
    );
    expect(authority).not.toMatch(/GRANT\s+\w+\s+TO/iu);

    const deployLoop = section(
      "function applyCodexOAuthV5Migrations(directory, url)",
      "async function prepareCodexOAuthV5ReleaseAuthority(url)",
    );
    expectOrdered(deployLoop, [
      "for (const migrationName of codexOAuthV5Migrations)",
      "addMigration(directory, migrationName)",
      "runMigrationDeploy(directory, url)",
    ]);
  });
});
