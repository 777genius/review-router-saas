import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runProviderScopeConcurrencyOperation } from "./manage-review-provider-scope-concurrency.mjs";
import { writeDisposableMigrationCatalog } from "./self-hosted-e2e/disposable-release-role-fixture.mjs";

const PRE_PROVIDER_SCOPE_PRISMA_CONFIG =
  '--config "$(cat "$RUNNER_TEMP/provider-scope-migrations/pre-000079.config-path")"';
const THROUGH_PROVIDER_SCOPE_PRISMA_CONFIG =
  '--config "$(cat "$RUNNER_TEMP/provider-scope-migrations/through-000079.config-path")"';
const PROVIDER_SCOPE_URL =
  "postgresql://postgres:postgres@127.0.0.1:5432/review_router_provider_scope_ci_test?schema=public";

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
};

function qualitySteps(workflowSource: string): WorkflowStep[] {
  const workflow = parse(workflowSource) as {
    jobs?: { quality?: { steps?: WorkflowStep[] } };
  };
  const steps = workflow.jobs?.quality?.steps;
  if (!Array.isArray(steps)) {
    throw new Error("missing quality job steps");
  }
  return steps;
}

function namedStep(steps: WorkflowStep[], name: string): WorkflowStep {
  const matches = steps.filter((step) => step.name === name);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one workflow step named ${name}`);
  }
  return matches[0] as WorkflowStep;
}

function executableShellLines(run: unknown): string[] {
  if (typeof run !== "string") {
    return [];
  }
  return run
    .replace(/\\\n\s*/gu, " ")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function commentFreeExecutableSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .split("\n")
    .map((line) => {
      if (/^\s*#/u.test(line)) {
        return "";
      }
      return line
        .replace(/(^|\s)\/\/.*$/u, "$1")
        .replace(/(^|\s)--(?=\s|$).*$/u, "$1");
    })
    .join("\n");
}

function literalAuthorityStatements(steps: WorkflowStep[]): string[] {
  const executable = steps
    .map((step) => commentFreeExecutableSource(step.run ?? ""))
    .join("\n")
    .replace(/\\\n\s*/gu, " ");
  const forbidden = [
    /\bGRANT\b/giu,
    /\bALTER\s+ROLE\b/giu,
    /\bALTER\s+DATABASE\b/giu,
    /\bREASSIGN\s+OWNED\b/giu,
    /\bALTER\s+GROUP\b[\s\S]{0,200}?\b(?:ADD|DROP)\s+USER\b/giu,
    /\bCREATE\s+(?:ROLE|USER)\b[^;]*?\b(?:IN\s+ROLE|ROLE|ADMIN)\b/giu,
    /\bpg_write_all_data\b/giu,
  ];
  const findings = forbidden.flatMap((pattern) =>
    Array.from(executable.matchAll(pattern), (match) => match[0]),
  );
  const ownerTransfers = Array.from(
    executable.matchAll(
      /\bALTER\s+TABLE\b[\s\S]{0,300}?\bOWNER\s+TO\s+[a-z_][a-z0-9_$]*/giu,
    ),
    (match) => match[0].replace(/\s+/gu, " ").trim(),
  );
  return [...findings, ...ownerTransfers];
}

function heredocBodies(run: unknown): string[] {
  if (typeof run !== "string") {
    return [];
  }
  return Array.from(
    run.matchAll(
      /(?:^|\n)[^\n]*<<\s*['"]?(?<delimiter>[a-z_][a-z0-9_]*)['"]?\s*\n(?<body>[\s\S]*?)\n\s*\k<delimiter>(?=\s*(?:\n|$))/giu,
    ),
    (match) => match.groups?.body ?? "",
  );
}

function visitNodes(node: ts.Node, visit: (candidate: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => visitNodes(child, visit));
}

function isIdentifier(node: ts.Node | undefined, text: string): boolean {
  return ts.isIdentifier(node) && node.text === text;
}

function isProcessEnv(node: ts.Node): boolean {
  return (
    (ts.isPropertyAccessExpression(node) &&
      isIdentifier(node.expression, "process") &&
      node.name.text === "env") ||
    (ts.isElementAccessExpression(node) &&
      isIdentifier(node.expression, "process") &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "env")
  );
}

function assertProviderSuiteBinding(suiteSource: string): void {
  const sourceFile = ts.createSourceFile(
    "prisma-review-execution-store-real.test.ts",
    suiteSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const environmentAccesses: ts.Node[] = [];
  const clientCalls: ts.CallExpression[] = [];
  let databaseUrlIdentifiers = 0;
  let validBindingCount = 0;

  visitNodes(sourceFile, (node) => {
    if (isIdentifier(node, "databaseUrl")) {
      databaseUrlIdentifiers += 1;
    }
    if (isProcessEnv(node)) {
      environmentAccesses.push(node);
      const parent = node.parent;
      const declaration = parent?.parent;
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === "REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL" &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer === parent &&
        isIdentifier(declaration.name, "databaseUrl") &&
        ts.isVariableDeclarationList(declaration.parent) &&
        (declaration.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        validBindingCount += 1;
      }
    }
    if (
      ts.isCallExpression(node) &&
      isIdentifier(node.expression, "createPrismaClient")
    ) {
      clientCalls.push(node);
    }
  });

  if (
    environmentAccesses.length !== 1 ||
    validBindingCount !== 1 ||
    databaseUrlIdentifiers !== 3
  ) {
    throw new Error(
      "provider suite must have one direct dedicated URL binding",
    );
  }
  if (clientCalls.length !== 1) {
    throw new Error("provider suite must create exactly one Prisma client");
  }
  const [argument] = clientCalls[0]?.arguments ?? [];
  if (!argument || !ts.isObjectLiteralExpression(argument)) {
    throw new Error("provider client must receive a literal options object");
  }
  const databaseUrlProperties = argument.properties.filter(
    (property) =>
      (ts.isShorthandPropertyAssignment(property) &&
        property.name.text === "databaseUrl") ||
      ((ts.isPropertyAssignment(property) ||
        ts.isMethodDeclaration(property) ||
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property)) &&
        property.name.getText(sourceFile) === "databaseUrl"),
  );
  if (
    databaseUrlProperties.length !== 1 ||
    !ts.isShorthandPropertyAssignment(databaseUrlProperties[0] as ts.Node) ||
    argument.properties.some(ts.isSpreadAssignment)
  ) {
    throw new Error("provider client must use only the dedicated URL binding");
  }
}

function assertMigrationCatalogContract(run: unknown): void {
  const nodeSources = heredocBodies(run);
  if (nodeSources.length !== 1) {
    throw new Error("migration catalog must contain one Node program");
  }
  const executable = commentFreeExecutableSource(nodeSources[0] as string);
  if (
    !executable.includes(
      'import { writeDisposableMigrationCatalog } from "./scripts/self-hosted-e2e/disposable-release-role-fixture.mjs"',
    ) ||
    !executable.includes('["pre79", "pre-000079"]') ||
    !executable.includes('["through79", "through-000079"]') ||
    !executable.includes("writeDisposableMigrationCatalog(phase, root)") ||
    !executable.includes(
      "writeFileSync(join(root, `${label}.config-path`), `${config}\\n`)",
    )
  ) {
    throw new Error("provider catalogs must use the imported bounded fixture");
  }
}

function assertProviderFixtureContract(
  workflowSource: string,
  suiteSource: string,
): void {
  const workflow = parse(workflowSource) as {
    jobs?: {
      quality?: {
        env?: Record<string, string>;
        services?: Record<string, { ports?: string[] }>;
      };
    };
  };
  const quality = workflow.jobs?.quality;
  const steps = qualitySteps(workflowSource);
  const step = (name: string) => namedStep(steps, name);
  const index = (name: string) => steps.indexOf(step(name));
  const runLines = (name: string) => executableShellLines(step(name).run);

  const orderedSteps = [
    "Create CI databases",
    "Apply ordinary test database migrations",
    "Rotating Codex PostgreSQL 17 combined migration rehearsal (no skips)",
    "Apply dev database migrations",
    "Complete disposable CI release-role catalog",
    "Build provider-scope migration catalogs",
    "Apply provider-scope database before 000079",
    "Apply provider-scope database through 000079 and hand off relations",
    "Provider-scope real database tests",
    "Tear down provider-scope database",
    "Migration smoke test",
  ];
  for (let position = 1; position < orderedSteps.length; position += 1) {
    if (
      index(orderedSteps[position - 1] as string) >=
      index(orderedSteps[position] as string)
    ) {
      throw new Error(
        `workflow lifecycle is out of order near ${orderedSteps[position]}`,
      );
    }
  }

  const exactCommands: Array<[string, string]> = [
    ["Apply dev database migrations", "pnpm db:migrate:deploy"],
    [
      "Apply ordinary test database migrations",
      'DATABASE_URL="$TEST_DATABASE_URL" pnpm --dir packages/platform/db db:migrate:deploy',
    ],
    [
      "Apply provider-scope database before 000079",
      `DATABASE_URL="$REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL" pnpm --filter @reviewrouter/platform-db exec prisma migrate deploy ${PRE_PROVIDER_SCOPE_PRISMA_CONFIG}`,
    ],
  ];
  for (const [name, command] of exactCommands) {
    if (!runLines(name).includes(command)) {
      throw new Error(`${name} is missing its executable migration command`);
    }
  }
  const throughCommand = `DATABASE_URL="$REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL" pnpm --filter @reviewrouter/platform-db exec prisma migrate deploy ${THROUGH_PROVIDER_SCOPE_PRISMA_CONFIG}`;
  if (
    !runLines(
      "Apply provider-scope database through 000079 and hand off relations",
    ).includes(throughCommand)
  ) {
    throw new Error("through-000079 migration command is missing or unbounded");
  }

  assertMigrationCatalogContract(
    step("Build provider-scope migration catalogs").run,
  );

  const authorityStatements = literalAuthorityStatements(steps);
  if (authorityStatements.length !== 0) {
    throw new Error("quality job contains unexpected literal SQL authority");
  }

  const provision = runLines("Complete disposable CI release-role catalog");
  const freshPreflightIndex = provision.findIndex(
    (line) =>
      line.includes("disposableFreshDatabasePreflightSql as sql") &&
      line.includes("disposable-release-role-fixture.mjs"),
  );
  if (
    freshPreflightIndex < 0 ||
    !provision[freshPreflightIndex + 1]?.includes(
      'psql -XqAt -h 127.0.0.1 -U postgres -d "$database" -v ON_ERROR_STOP=1',
    ) ||
    !provision.includes(
      "for database in review_router_provider_scope_ci_test; do",
    ) ||
    !provision.includes(
      "node scripts/self-hosted-e2e/disposable-release-role-fixture.mjs provision-ci",
    )
  ) {
    throw new Error(
      "provider fixture must verify the fresh catalog before role creation",
    );
  }

  const handoff = runLines(
    "Apply provider-scope database through 000079 and hand off relations",
  );
  for (const importedSql of [
    "disposableProvider79HandoffSql",
    "disposableProvider79VerificationSql",
  ]) {
    const importedIndex = handoff.findIndex(
      (line) =>
        line.includes(`${importedSql} as sql`) &&
        line.includes("disposable-release-role-fixture.mjs"),
    );
    if (
      importedIndex < 0 ||
      !handoff[importedIndex + 1]?.includes(
        "psql -XqAt -h 127.0.0.1 -U postgres -d review_router_provider_scope_ci_test -v ON_ERROR_STOP=1",
      )
    ) {
      throw new Error(`provider fixture is missing ${importedSql}`);
    }
  }

  const appUrl =
    "postgresql://postgres:postgres@127.0.0.1:5433/review_router_ci_test?schema=public";
  if (
    quality?.env?.TEST_DATABASE_URL !== appUrl ||
    quality.env.REVIEW_ROUTER_TEST_DATABASE_URL !== appUrl ||
    !quality.services?.postgres?.ports?.includes("5432:5432") ||
    !quality.services?.["postgres-app-test"]?.ports?.includes("5433:5432") ||
    !runLines("Create CI databases").includes(
      "psql -h 127.0.0.1 -p 5433 -U postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE review_router_ci_test'",
    ) ||
    !runLines("Apply ordinary test database migrations").some(
      (line) =>
        line.includes("-p 5433") &&
        line.includes("reviewrouter_release_migration") &&
        line.includes("reviewrouter_release_schema_owner") &&
        line.endsWith("= 0"),
    ) ||
    !runLines("Apply ordinary test database migrations").some(
      (line) =>
        line.includes("codex_oauth_provider_identity_guard") &&
        line.includes("proowner") &&
        line.includes("postgres") &&
        line.endsWith("= 1"),
    ) ||
    !runLines("Apply ordinary test database migrations").some(
      (line) =>
        line.includes("rolname='reviewrouter_release_migration'") &&
        line.endsWith("= 0"),
    )
  ) {
    throw new Error(
      "ordinary test database must migrate role-free in its own cluster",
    );
  }

  const providerTest = step("Provider-scope real database tests");
  if (
    JSON.stringify(Object.keys(providerTest.env ?? {})) !==
      JSON.stringify(["REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL"]) ||
    providerTest.env?.REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL !==
      PROVIDER_SCOPE_URL ||
    !runLines("Provider-scope real database tests").includes(
      "pnpm exec vitest run packages/features/review-executions/src/tests/prisma-review-execution-store-real.test.ts",
    )
  ) {
    throw new Error(
      "provider real suite is not bound to its dedicated database",
    );
  }
  if (
    !runLines("Create CI databases").includes(
      "psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE review_router_provider_scope_ci_test'",
    )
  ) {
    throw new Error("provider fixture database creation is missing");
  }
  assertProviderSuiteBinding(suiteSource);

  const teardown = step("Tear down provider-scope database");
  if (teardown.if !== "always()") {
    throw new Error("provider fixture teardown must run always");
  }
  if (
    !executableShellLines(teardown.run).some((line) =>
      line.includes(
        "DROP DATABASE IF EXISTS review_router_provider_scope_ci_test",
      ),
    )
  ) {
    throw new Error("provider teardown must drop the disposable database");
  }
  if (!runLines("Migration smoke test").includes("pnpm db:migrate:smoke")) {
    throw new Error("later migration smoke command is missing");
  }
}

function expectRejectedMutation(
  baseline: string,
  before: string,
  after: string,
  assertion: (mutated: string) => void,
): void {
  const mutated = baseline.replace(before, after);
  expect(mutated).not.toBe(baseline);
  expect(() => assertion(mutated)).toThrow();
}

describe("provider scope concurrency rollout control", () => {
  const source = readFileSync(
    join(import.meta.dirname, "manage-review-provider-scope-concurrency.mjs"),
    "utf8",
  );
  const pg17Proof = readFileSync(
    join(import.meta.dirname, "run-hosted-pool-postgres-e2e.mjs"),
    "utf8",
  );
  const qualityGatesWorkflow = readFileSync(
    join(import.meta.dirname, "../.github/workflows/ci.yml"),
    "utf8",
  );
  const realProviderScopeSuite = readFileSync(
    join(
      import.meta.dirname,
      "../packages/features/review-executions/src/tests/prisma-review-execution-store-real.test.ts",
    ),
    "utf8",
  );

  it("requires an explicit old-fleet drain before activation", () => {
    expect(source).toContain("--confirm-old-replicas-drained");
    expect(source).toContain(
      'activate: "reviewrouter_provider_scope_concurrency_activate"',
    );
  });

  it("closes first and verifies duplicate lanes are drained before rollback", () => {
    expect(source).toContain("--confirm-no-old-replica-started");
    expect(source).toContain(
      'verifyRollback: "reviewrouter_provider_scope_concurrency_verify_rollback"',
    );
    expect(source).toContain("status.duplicateActiveVoteLanes === 0");
    expect(source).toContain("status.legacyProviderVoteIndex?.exact === true");
  });

  it("reconciles ambiguous commits by reading desired state and retrying", () => {
    expect(source).toContain("ambiguousConnectionCodes");
    expect(source).toContain("reconciledAfterAmbiguousCommit: true");
    expect(source).toContain("isDesiredState(operation, status)");
    expect(source).toContain("maxAttempts = 3");
  });

  it("returns success when an activation committed before its response was lost", async () => {
    let activated = false;
    let discarded = false;
    const result = await runProviderScopeConcurrencyOperation({
      operation: "activate",
      databaseUrl: "postgresql://restricted.invalid/review_router",
      createClient: () => ({
        connect: async () => undefined,
        end: async () => undefined,
        query: async (statement: string) => {
          if (statement.includes("_activate")) {
            activated = true;
            discarded = true;
            throw Object.assign(new Error("connection lost after commit"), {
              code: "08006",
            });
          }
          return {
            rows: [
              {
                status: {
                  activated,
                  duplicateActiveVoteLanes: 0,
                  legacyProviderVoteIndex: activated ? null : { exact: true },
                },
              },
            ],
          };
        },
      }),
    });

    expect(discarded).toBe(true);
    expect(result).toEqual({
      reconciledAfterAmbiguousCommit: true,
      status: {
        activated: true,
        duplicateActiveVoteLanes: 0,
        legacyProviderVoteIndex: null,
      },
    });
  });

  it("uses only restricted routines and never assumes schema-owner authority", () => {
    expect(source).toContain("SELECT public.${routineName}() AS status");
    expect(source).not.toContain("SET LOCAL ROLE");
    expect(source).not.toContain("reviewrouter_release_schema_owner");
    expect(source).not.toContain("DROP INDEX");
    expect(source).not.toContain(
      'UPDATE "ReviewProviderScopeConcurrencyControl"',
    );
  });

  it("runs the real PG17 activation and rollback proof as the restricted release login", () => {
    expect(pg17Proof).toContain(
      "proveProviderScopeConcurrencyRollout(\n      releaseMigrationDatabaseUrl,\n      databaseUrl,",
    );
    expect(pg17Proof).not.toContain(
      "proveProviderScopeConcurrencyRollout(databaseUrl)",
    );
    expect(pg17Proof).toContain("owner_memberships !== 0");
    expect(pg17Proof).not.toContain(
      "GRANT reviewrouter_release_schema_owner TO reviewrouter_release_migration",
    );
    expect(pg17Proof).toContain(
      "provider_scope_concurrency_release_authority_invalid",
    );
    expect(pg17Proof).toContain("reconciledAfterAmbiguousCommit !== true");
    expect(pg17Proof).toContain(
      "provider_scope_concurrency_commit_response_loss_recovery_invalid",
    );
    expect(pg17Proof).toContain(
      "provider_scope_concurrency_restricted_dml_present",
    );
    expect(pg17Proof).not.toContain("SET LOCAL ROLE");
  });

  it("accepts the checked-in provider fixture lifecycle contract", () => {
    expect(() =>
      assertProviderFixtureContract(
        qualityGatesWorkflow,
        realProviderScopeSuite,
      ),
    ).not.toThrow();
  });

  // Each mutation breaks a separate CI boundary: app DB isolation, bounded
  // provider migration, restricted fixture authority, or cleanup.
  it.each([
    [
      "ordinary migration removed",
      '          DATABASE_URL="$TEST_DATABASE_URL" pnpm --dir packages/platform/db db:migrate:deploy',
      '          # DATABASE_URL="$TEST_DATABASE_URL" pnpm --dir packages/platform/db db:migrate:deploy',
    ],
    [
      "ordinary database redirected into the role-bearing cluster",
      "      REVIEW_ROUTER_TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5433/review_router_ci_test?schema=public\n\n    services:",
      "      REVIEW_ROUTER_TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/review_router_ci_test?schema=public\n\n    services:",
    ],
    [
      "provider pre-79 catalog removed",
      PRE_PROVIDER_SCOPE_PRISMA_CONFIG,
      '--config "$RUNNER_TEMP/provider-scope-migrations/unbounded.config.mjs"',
    ],
    [
      "provider through-79 catalog removed",
      THROUGH_PROVIDER_SCOPE_PRISMA_CONFIG,
      '--config "$RUNNER_TEMP/provider-scope-migrations/unbounded.config.mjs"',
    ],
    [
      "fixture role provisioning removed",
      "node scripts/self-hosted-e2e/disposable-release-role-fixture.mjs provision-ci",
      "echo roles-ready",
    ],
    [
      "provider handoff removed",
      "disposableProvider79HandoffSql as sql",
      "disposableProvider79HandoffRemoved as sql",
    ],
    [
      "provider authority verification removed",
      "disposableProvider79VerificationSql as sql",
      "disposableProvider79VerificationRemoved as sql",
    ],
    [
      "provider teardown guard removed",
      "      - name: Tear down provider-scope database\n        if: always()",
      "      - name: Tear down provider-scope database",
    ],
    [
      "provider database cleanup removed",
      "DROP DATABASE IF EXISTS review_router_provider_scope_ci_test;",
      "SELECT 1;",
    ],
    [
      "broad inline grant added",
      "      - name: Provider-scope real database tests",
      "      - name: Broad authority\n        run: psql -c 'GRANT ALL ON ALL TABLES IN SCHEMA public TO reviewrouter_release_migration;'\n\n      - name: Provider-scope real database tests",
    ],
  ])("rejects %s", (_label, before, after) => {
    expectRejectedMutation(qualityGatesWorkflow, before, after, (mutated) =>
      assertProviderFixtureContract(mutated, realProviderScopeSuite),
    );
  });

  it("rejects moving app migration after release-role provisioning", () => {
    const app = qualityGatesWorkflow.match(
      / {6}- name: Apply ordinary test database migrations[\s\S]*?(?=\n {6}- name: Rotating Codex PostgreSQL 17 combined migration rehearsal)/u,
    )?.[0];
    expect(app).toBeDefined();
    const mutated = qualityGatesWorkflow
      .replace(`${app ?? ""}\n`, "")
      .replace(
        "      - name: Apply dev database migrations",
        `${app ?? ""}\n\n      - name: Apply dev database migrations`,
      );
    expect(() =>
      assertProviderFixtureContract(mutated, realProviderScopeSuite),
    ).toThrow();
  });

  it("rejects replacement of the imported catalog implementation", () => {
    expectRejectedMutation(
      qualityGatesWorkflow,
      "writeDisposableMigrationCatalog(phase, root)",
      'writeDisposableMigrationCatalog("full", root)',
      (mutated) =>
        assertProviderFixtureContract(mutated, realProviderScopeSuite),
    );
  });

  it("materializes exact pre-79 and through-79 migration sets", () => {
    const root = mkdtempSync(join(tmpdir(), "review-router-provider-catalog-"));
    try {
      const migrationNames = (phase: "pre79" | "through79") => {
        const config = writeDisposableMigrationCatalog(phase, root);
        const prismaRoot = join(config, "..", "prisma", "migrations");
        return readdirSync(prismaRoot).filter((name) =>
          /^\d{6}_[a-z0-9_]+$/u.test(name),
        );
      };
      const pre = migrationNames("pre79");
      const through = migrationNames("through79");
      expect(pre.some((name) => name >= "000079_")).toBe(false);
      expect(through).toContain("000079_hosted_codex_output_limits");
      expect(through).toContain(
        "000079_remove_account_wide_provider_lane_serialization",
      );
      expect(through.some((name) => name >= "000080_")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([
    [
      "direct DATABASE_URL fallback",
      "process.env.REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL || process.env.DATABASE_URL",
    ],
    ["bracket fallback", 'process.env["DATABASE_URL"]'],
    [
      "nullish test URL fallback",
      "process.env.REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL ?? process.env.REVIEW_ROUTER_TEST_DATABASE_URL",
    ],
    [
      "logical test URL fallback",
      "process.env.REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL || process.env.REVIEW_ROUTER_TEST_DATABASE_URL",
    ],
    [
      "indirect DATABASE_URL fallback",
      'process.env[fallbackKey];\nconst fallbackKey = "DATABASE_URL"',
    ],
    [
      "dynamically joined DATABASE_URL fallback",
      'process.env["DATABASE" + "_URL"]',
    ],
    [
      "destructured environment alias",
      "process.env.REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL;\nconst { DATABASE_URL } = process.env",
    ],
    [
      "environment object alias",
      "process.env.REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL;\nconst environment = process.env",
    ],
  ])("rejects provider suite %s", (_label, expression) => {
    expectRejectedMutation(
      realProviderScopeSuite,
      "process.env.REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL;",
      `${expression};`,
      (mutatedSuite) =>
        assertProviderFixtureContract(qualityGatesWorkflow, mutatedSuite),
    );
  });

  it.each([
    ["direct alternate value", "DATABASE_URL"],
    [
      "logical alternate value",
      "databaseUrl || process.env.REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL",
    ],
    [
      "nullish alternate value",
      "databaseUrl ?? process.env.REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL",
    ],
    ["alias alternate value", "providerDatabaseUrl"],
  ])("rejects createPrismaClient %s", (_label, value) => {
    expectRejectedMutation(
      realProviderScopeSuite,
      "createPrismaClient({ databaseUrl, poolMax: 8 })",
      `createPrismaClient({ databaseUrl: ${value}, poolMax: 8 })`,
      (mutatedSuite) =>
        assertProviderFixtureContract(qualityGatesWorkflow, mutatedSuite),
    );
  });

  it("rejects a provider URL alias fallback", () => {
    expectRejectedMutation(
      realProviderScopeSuite,
      "const databaseUrl = process.env.REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL;",
      `const dedicatedUrl = process.env.REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL;
const fallbackUrl = process.env.DATABASE_URL;
const databaseUrl = dedicatedUrl ?? fallbackUrl;`,
      (mutatedSuite) =>
        assertProviderFixtureContract(qualityGatesWorkflow, mutatedSuite),
    );
  });

  it("does not allow a comment to prove the dedicated provider URL binding", () => {
    const mutatedSuite = realProviderScopeSuite.replace(
      "const databaseUrl = process.env.REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL;",
      "// const databaseUrl = process.env.REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL;\nconst databaseUrl = undefined;",
    );
    expect(() =>
      assertProviderFixtureContract(qualityGatesWorkflow, mutatedSuite),
    ).toThrow();
  });

  it("rejects an additional generic URL in the provider test step", () => {
    const dedicatedEnv = `      - name: Provider-scope real database tests
        env:
          REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL: ${PROVIDER_SCOPE_URL}`;
    const mutated = qualityGatesWorkflow.replace(
      dedicatedEnv,
      `${dedicatedEnv}\n          DATABASE_URL: postgresql://forbidden.invalid/fallback`,
    );
    expect(() =>
      assertProviderFixtureContract(mutated, realProviderScopeSuite),
    ).toThrow();
  });

  it("does not allow an inline comment to prove the dedicated binding", () => {
    const mutatedSuite = realProviderScopeSuite.replace(
      "const databaseUrl = process.env.REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL;",
      "const databaseUrl = undefined; // const databaseUrl = process.env.REVIEW_ROUTER_PROVIDER_SCOPE_TEST_DATABASE_URL;",
    );
    expect(() =>
      assertProviderFixtureContract(qualityGatesWorkflow, mutatedSuite),
    ).toThrow();
  });
});
