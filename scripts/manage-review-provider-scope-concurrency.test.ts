import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runProviderScopeConcurrencyOperation } from "./manage-review-provider-scope-concurrency.mjs";

const PRE_PROVIDER_SCOPE_PRISMA_CONFIG =
  '--config "$RUNNER_TEMP/provider-scope-migrations/pre-000079.config.mjs"';
const THROUGH_PROVIDER_SCOPE_PRISMA_CONFIG =
  '--config "$RUNNER_TEMP/provider-scope-migrations/through-000079.config.mjs"';
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

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/--[^\n]*/gu, " ");
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
  let executable = steps
    .map((step) => commentFreeExecutableSource(step.run ?? ""))
    .join("\n")
    .replace(/\\\n\s*/gu, " ");
  const approvedSchemaGrants = [
    /\bGRANT\s+USAGE\s+ON\s+SCHEMA\s+public\s+TO\s+reviewrouter_release_migration\s*;/iu,
    /\bGRANT\s+USAGE\s*,\s*CREATE\s+ON\s+SCHEMA\s+public\s+TO\s+reviewrouter_release_schema_owner\s*;/iu,
  ];
  for (const approvedGrant of approvedSchemaGrants) {
    // Remove exactly one approved occurrence. A duplicate or broadened grant
    // remains visible to the generic GRANT rejection below.
    executable = executable.replace(approvedGrant, "");
  }
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

function psqlStatements(run: unknown): string[] {
  if (typeof run !== "string") {
    return [];
  }
  const executableRun = executableShellLines(run).join("\n");
  const sources: string[] = [];
  const heredoc =
    /(?:^|\n)[^\n]*\bpsql\b[^\n]*<<'(?<delimiter>[A-Z][A-Z0-9_]*)'\n(?<sql>[\s\S]*?)\n\s*\k<delimiter>(?=\n|$)/gu;
  for (const match of executableRun.matchAll(heredoc)) {
    sources.push(match.groups?.sql ?? "");
  }
  for (const line of executableRun.split("\n")) {
    if (!/\bpsql\b/u.test(line)) {
      continue;
    }
    for (const match of line.matchAll(/(?:^|\s)-c\s+'(?<sql>[^']*)'/gu)) {
      sources.push(match.groups?.sql ?? "");
    }
    for (const match of line.matchAll(/(?:^|\s)-c\s+"(?<sql>[^"]*)"/gu)) {
      sources.push(match.groups?.sql ?? "");
    }
  }
  return sources.flatMap((source) =>
    stripSqlComments(source)
      .split(";")
      .map((statement) => statement.replace(/\s+/gu, " ").trim())
      .filter(Boolean),
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
    throw new Error("migration catalog must contain one literal Node program");
  }
  const sourceFile = ts.createSourceFile(
    "provider-scope-catalog.mjs",
    nodeSources[0] as string,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let phases: Array<{ name: string; boundary: string }> | undefined;
  let expectedBoundary: string[] | undefined;
  let phaseBoundaryComparison = 0;
  let throughBoundaryComparison = 0;
  visitNodes(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      isIdentifier(node.name, "phases") &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      phases = node.initializer.elements.map((element) => {
        if (!ts.isObjectLiteralExpression(element)) {
          return { name: "", boundary: "" };
        }
        const value = (propertyName: string) => {
          const property = element.properties.find(
            (candidate) =>
              ts.isPropertyAssignment(candidate) &&
              candidate.name.getText(sourceFile) === propertyName,
          );
          return property &&
            ts.isPropertyAssignment(property) &&
            ts.isStringLiteral(property.initializer)
            ? property.initializer.text
            : "";
        };
        return {
          name: value("name"),
          boundary: value("firstExcludedMigration"),
        };
      });
    }
    if (
      ts.isVariableDeclaration(node) &&
      isIdentifier(node.name, "expectedBoundary") &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      expectedBoundary = node.initializer.elements.map((element) =>
        ts.isStringLiteral(element) ? element.text : "",
      );
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      isIdentifier(node.left.expression, "entry") &&
      node.left.name.text === "name" &&
      ts.isPropertyAccessExpression(node.right) &&
      isIdentifier(node.right.expression, "phase") &&
      node.right.name.text === "firstExcludedMigration"
    ) {
      phaseBoundaryComparison += 1;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken &&
      isIdentifier(node.left, "name") &&
      ts.isStringLiteral(node.right) &&
      node.right.text === "000080_" &&
      ts.isArrowFunction(node.parent) &&
      ts.isCallExpression(node.parent.parent) &&
      ts.isPropertyAccessExpression(node.parent.parent.expression) &&
      isIdentifier(
        node.parent.parent.expression.expression,
        "postMigrations",
      ) &&
      node.parent.parent.expression.name.text === "some"
    ) {
      throughBoundaryComparison += 1;
    }
  });
  if (
    JSON.stringify(phases) !==
      JSON.stringify([
        { name: "pre-000079", boundary: "000079_" },
        { name: "through-000079", boundary: "000080_" },
      ]) ||
    phaseBoundaryComparison !== 1 ||
    throughBoundaryComparison !== 1 ||
    JSON.stringify(expectedBoundary) !==
      JSON.stringify([
        "000079_hosted_codex_output_limits",
        "000079_remove_account_wide_provider_lane_serialization",
      ])
  ) {
    throw new Error("migration catalog boundaries are not exact");
  }
}

function assertProviderFixtureContract(
  workflowSource: string,
  suiteSource: string,
): void {
  const steps = qualitySteps(workflowSource);
  const step = (name: string) => namedStep(steps, name);
  const index = (name: string) => steps.indexOf(step(name));
  const runLines = (name: string) => executableShellLines(step(name).run);

  const orderedSteps = [
    "Rotating Codex PostgreSQL 17 combined migration rehearsal (no skips)",
    "Apply dev database migrations",
    "Apply ordinary test database migrations",
    "Apply provider-scope database before 000079",
    "Provision provider-scope transition test roles",
    "Apply provider-scope database through 000079 and hand off relations",
    "Provider-scope real database tests",
    "Tear down provider-scope database and roles",
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

  const approvedAuthority = [
    'ALTER TABLE public."ReviewProviderScopeConcurrencyControl" OWNER TO reviewrouter_release_schema_owner',
    'ALTER TABLE public."ReviewInvocationLeaseV2" OWNER TO reviewrouter_release_schema_owner',
  ];
  const approvedHandoffStatements = [
    ...approvedAuthority,
    "GRANT USAGE ON SCHEMA public TO reviewrouter_release_migration",
    "GRANT USAGE, CREATE ON SCHEMA public TO reviewrouter_release_schema_owner",
  ];
  const authorityStatements = literalAuthorityStatements(steps);
  if (
    JSON.stringify(authorityStatements) !== JSON.stringify(approvedAuthority)
  ) {
    throw new Error("quality job contains unexpected literal SQL authority");
  }

  const provisionStatements = psqlStatements(
    step("Provision provider-scope transition test roles").run,
  );
  if (
    JSON.stringify(provisionStatements) !==
    JSON.stringify([
      "CREATE ROLE reviewrouter_release_migration LOGIN PASSWORD 'postgres' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
      "CREATE ROLE reviewrouter_release_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
    ])
  ) {
    throw new Error(
      "provider fixture roles have unexpected authority or membership",
    );
  }

  const handoffRun = step(
    "Apply provider-scope database through 000079 and hand off relations",
  ).run;
  if (
    JSON.stringify(psqlStatements(handoffRun)) !==
    JSON.stringify(approvedHandoffStatements)
  ) {
    throw new Error("provider fixture has unexpected handoff authority");
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

  const teardown = step("Tear down provider-scope database and roles");
  if (teardown.if !== "always()") {
    throw new Error("provider fixture teardown must run always");
  }
  const teardownStatements = psqlStatements(teardown.run);
  if (
    JSON.stringify(teardownStatements) !==
    JSON.stringify([
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'review_router_provider_scope_ci_test' AND pid <> pg_backend_pid()",
      "DROP DATABASE IF EXISTS review_router_provider_scope_ci_test",
      "DROP ROLE IF EXISTS reviewrouter_release_migration",
      "DROP ROLE IF EXISTS reviewrouter_release_schema_owner",
    ])
  ) {
    throw new Error("provider teardown is incomplete or ordered unsafely");
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

  it.each([
    ["deleted dev migration", "        run: pnpm db:migrate:deploy\n", ""],
    [
      "commented dev migration",
      "        run: pnpm db:migrate:deploy",
      "        run: |\n          # pnpm db:migrate:deploy",
    ],
    [
      "deleted ordinary migration",
      '        run: DATABASE_URL="$TEST_DATABASE_URL" pnpm --dir packages/platform/db db:migrate:deploy\n',
      "",
    ],
    [
      "commented ordinary migration",
      '        run: DATABASE_URL="$TEST_DATABASE_URL" pnpm --dir packages/platform/db db:migrate:deploy',
      '        run: |\n          # DATABASE_URL="$TEST_DATABASE_URL" pnpm --dir packages/platform/db db:migrate:deploy',
    ],
    [
      "deleted pre-000079 config argument",
      `            ${PRE_PROVIDER_SCOPE_PRISMA_CONFIG}`,
      "",
    ],
    [
      "commented pre-000079 config argument",
      `            ${PRE_PROVIDER_SCOPE_PRISMA_CONFIG}`,
      `            # ${PRE_PROVIDER_SCOPE_PRISMA_CONFIG}`,
    ],
    [
      "deleted through-000079 config argument",
      `            ${THROUGH_PROVIDER_SCOPE_PRISMA_CONFIG}`,
      "",
    ],
    [
      "commented through-000079 config argument",
      `            ${THROUGH_PROVIDER_SCOPE_PRISMA_CONFIG}`,
      `            # ${THROUGH_PROVIDER_SCOPE_PRISMA_CONFIG}`,
    ],
    [
      "deleted release migration schema usage",
      "          GRANT USAGE ON SCHEMA public TO reviewrouter_release_migration;\n",
      "",
    ],
    [
      "deleted schema-owner schema authority",
      `          GRANT USAGE, CREATE ON SCHEMA public
            TO reviewrouter_release_schema_owner;
`,
      "",
    ],
    [
      "broadened release migration schema authority",
      "          GRANT USAGE ON SCHEMA public TO reviewrouter_release_migration;",
      "          GRANT USAGE, CREATE ON SCHEMA public TO reviewrouter_release_migration;",
    ],
    [
      "public schema authority",
      "          GRANT USAGE ON SCHEMA public TO reviewrouter_release_migration;",
      `          GRANT USAGE ON SCHEMA public TO reviewrouter_release_migration;
          GRANT USAGE ON SCHEMA public TO PUBLIC;`,
    ],
    ["removed teardown always guard", "        if: always()\n", ""],
    [
      "commented teardown always guard",
      "        if: always()",
      "        # if: always()",
    ],
    [
      "deleted later migration smoke command",
      "        run: pnpm db:migrate:smoke\n",
      "",
    ],
    [
      "commented later migration smoke command",
      "        run: pnpm db:migrate:smoke",
      "        run: |\n          # pnpm db:migrate:smoke",
    ],
  ])("rejects %s", (_label, before, after) => {
    expectRejectedMutation(qualityGatesWorkflow, before, after, (mutated) =>
      assertProviderFixtureContract(mutated, realProviderScopeSuite),
    );
  });

  it.each([
    [
      "ALTER TABLE ONLY on an approved table",
      'ALTER TABLE public."ReviewProviderScopeConcurrencyControl"',
      'ALTER TABLE ONLY public."ReviewProviderScopeConcurrencyControl"',
    ],
    [
      "ALTER TABLE ONLY on the other approved table",
      'ALTER TABLE public."ReviewInvocationLeaseV2"',
      'ALTER TABLE ONLY public."ReviewInvocationLeaseV2"',
    ],
    [
      "a third owner transfer in another heredoc",
      "          SQL\n\n      - name: Provider-scope real database tests",
      `          SQL
          psql -h 127.0.0.1 -U postgres -d review_router_provider_scope_ci_test <<'MORE_SQL'
          ALTER TABLE public."HiddenThird" OWNER TO reviewrouter_release_schema_owner;
          MORE_SQL

      - name: Provider-scope real database tests`,
    ],
    [
      "a third owner transfer through psql -c",
      "          SQL\n\n      - name: Provider-scope real database tests",
      `          SQL
          psql -h 127.0.0.1 -U postgres -d review_router_provider_scope_ci_test -c 'ALTER TABLE public."HiddenThird" OWNER TO reviewrouter_release_schema_owner;'

      - name: Provider-scope real database tests`,
    ],
    [
      "a third owner transfer through an unquoted lowercase heredoc",
      "          SQL\n\n      - name: Provider-scope real database tests",
      `          SQL
          psql -h 127.0.0.1 -U postgres <<sql
          alter table public."LowercaseThird" owner to reviewrouter_release_schema_owner;
          sql

      - name: Provider-scope real database tests`,
    ],
    [
      "a third owner transfer through --command",
      "          SQL\n\n      - name: Provider-scope real database tests",
      `          SQL
          psql --command='alter table public."CommandThird" owner to reviewrouter_release_schema_owner;'

      - name: Provider-scope real database tests`,
    ],
    [
      "a third owner transfer piped to psql",
      "          SQL\n\n      - name: Provider-scope real database tests",
      `          SQL
          printf 'ALTER TABLE public."PipedThird" OWNER TO reviewrouter_release_schema_owner;' | psql

      - name: Provider-scope real database tests`,
    ],
    [
      "a third owner transfer in an added quality step",
      "      - name: Provider-scope real database tests",
      `      - name: Accidental authority
        run: psql --command='ALTER TABLE public."AddedStepThird" OWNER TO reviewrouter_release_schema_owner;'

      - name: Provider-scope real database tests`,
    ],
    [
      "a duplicate approved grant in another shell",
      "          SQL\n\n      - name: Provider-scope real database tests",
      `          SQL
          psql -h 127.0.0.1 -U postgres -d review_router_provider_scope_ci_test -c 'GRANT USAGE ON SCHEMA public TO reviewrouter_release_migration;'

      - name: Provider-scope real database tests`,
    ],
    [
      "an extra executable owner transfer",
      '          ALTER TABLE public."ReviewInvocationLeaseV2"',
      '          ALTER TABLE public."Extra" OWNER TO reviewrouter_release_schema_owner;\n          ALTER TABLE public."ReviewInvocationLeaseV2"',
    ],
    [
      "broad predefined-role authority",
      "          SQL\n\n      - name: Apply provider-scope database through 000079",
      "          GRANT pg_write_all_data TO reviewrouter_release_migration;\n          SQL\n\n      - name: Apply provider-scope database through 000079",
    ],
    [
      "role membership",
      "          SQL\n\n      - name: Apply provider-scope database through 000079",
      "          GRANT reviewrouter_release_schema_owner TO reviewrouter_release_migration;\n          SQL\n\n      - name: Apply provider-scope database through 000079",
    ],
    [
      "a broad role attribute",
      "          SQL\n\n      - name: Apply provider-scope database through 000079",
      "          ALTER ROLE reviewrouter_release_migration CREATEROLE;\n          SQL\n\n      - name: Apply provider-scope database through 000079",
    ],
    [
      "a broad object grant",
      "          SQL\n\n      - name: Apply provider-scope database through 000079",
      "          GRANT ALL ON ALL TABLES IN SCHEMA public TO reviewrouter_release_migration;\n          SQL\n\n      - name: Apply provider-scope database through 000079",
    ],
    [
      "database ownership authority",
      "          SQL\n\n      - name: Apply provider-scope database through 000079",
      "          ALTER DATABASE review_router_provider_scope_ci_test OWNER TO reviewrouter_release_schema_owner;\n          SQL\n\n      - name: Apply provider-scope database through 000079",
    ],
    [
      "owned-object reassignment",
      "          SQL\n\n      - name: Apply provider-scope database through 000079",
      "          REASSIGN OWNED BY postgres TO reviewrouter_release_schema_owner;\n          SQL\n\n      - name: Apply provider-scope database through 000079",
    ],
  ])("rejects %s", (_label, before, after) => {
    expectRejectedMutation(qualityGatesWorkflow, before, after, (mutated) =>
      assertProviderFixtureContract(mutated, realProviderScopeSuite),
    );
  });

  it("does not allow SQL comments to supply either ownership transfer", () => {
    const mutated = qualityGatesWorkflow.replace(
      '          ALTER TABLE public."ReviewInvocationLeaseV2"',
      '          -- ALTER TABLE public."ReviewInvocationLeaseV2"',
    );
    expect(() =>
      assertProviderFixtureContract(mutated, realProviderScopeSuite),
    ).toThrow();
  });

  it("rejects role drops moved before the database drop", () => {
    const databaseDrop =
      "          DROP DATABASE IF EXISTS review_router_provider_scope_ci_test;";
    const roleDrops =
      "          DROP ROLE IF EXISTS reviewrouter_release_migration;\n          DROP ROLE IF EXISTS reviewrouter_release_schema_owner;";
    const mutated = qualityGatesWorkflow
      .replace(databaseDrop, "__DATABASE_DROP__")
      .replace(roleDrops, `${roleDrops}\n${databaseDrop}`)
      .replace("__DATABASE_DROP__\n", "");
    expect(() =>
      assertProviderFixtureContract(mutated, realProviderScopeSuite),
    ).toThrow();
  });

  it("rejects teardown moved after the later migration smoke", () => {
    const teardown = qualityGatesWorkflow.match(
      / {6}- name: Tear down provider-scope database and roles[\s\S]*?(?=\n {6}- name: Bind hosted certification input bytes)/u,
    )?.[0];
    expect(teardown).toBeDefined();
    const mutated = qualityGatesWorkflow
      .replace(`${teardown ?? ""}\n`, "")
      .replace(
        "      - name: Review v2 migration rehearsal",
        `${teardown ?? ""}\n\n      - name: Review v2 migration rehearsal`,
      );
    expect(() =>
      assertProviderFixtureContract(mutated, realProviderScopeSuite),
    ).toThrow();
  });

  it("rejects a through-boundary mutation hidden by comment decoys", () => {
    const before = `          if (postMigrations.some((name) => name >= "000080_")) {
            throw new Error("through-000079 catalog crossed its upper boundary");
          }`;
    const after = `          /* if (postMigrations.some((name) => name >= "000080_")) {
            throw new Error("through-000079 catalog crossed its upper boundary");
          } */
          if (postMigrations.some((name) => name >= "999999_")) {
            throw new Error("through-000079 catalog crossed its upper boundary");
          }`;
    expectRejectedMutation(qualityGatesWorkflow, before, after, (mutated) =>
      assertProviderFixtureContract(mutated, realProviderScopeSuite),
    );
  });

  it("rejects migration boundary names supplied only by block comments", () => {
    const before = `            "000079_hosted_codex_output_limits",
            "000079_remove_account_wide_provider_lane_serialization",`;
    const after = `            /* "000079_hosted_codex_output_limits",
            "000079_remove_account_wide_provider_lane_serialization", */
            "999999_decoy_one",
            "999999_decoy_two",`;
    expectRejectedMutation(qualityGatesWorkflow, before, after, (mutated) =>
      assertProviderFixtureContract(mutated, realProviderScopeSuite),
    );
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
