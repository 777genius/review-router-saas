import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripAtomicMigrationEnvelope } from "../run-codex-rotating-release-migration.mjs";
import {
  readRenderSchemaHandoffCatalog,
  readReviewedRenderManagedContract,
} from "./render-schema-handoff-policy.mjs";
import {
  renderSchemaHandoffDependencySql,
  renderSchemaHandoffTransaction,
} from "./render-schema-handoff-transaction.mjs";

const catalog = readRenderSchemaHandoffCatalog();
const ledger = (count = 89) =>
  catalog.slice(0, count).map((r, i) => ({
    ...r,
    id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
    startedAt: "2026-08-01T00:00:00.000001Z",
    finishedAt: "2026-08-01T00:00:01.000001Z",
    rolledBackAt: null,
    appliedStepsCount: 1,
    logsPresent: false,
    hasLogs: false,
    logsDigest: null,
  }));
const input = () => ({
  ledger: ledger(),
  retainedBinding: {
    operationId: "12345678-abcd-abcd-abcd-123456789abc",
    implementationSha: "a".repeat(40),
    custodyDigest: `sha256:${"b".repeat(64)}`,
  },
  originalMembership: {
    role: "reviewrouter_release_schema_owner",
    member: "reviewrouter",
    grantor: "postgres",
    adminOption: true,
    inheritOption: false,
    setOption: false,
  },
});

describe("bounded managed89-to92 transaction construction", () => {
  it("keeps all three fixed migration bodies and ledger changes inside one uncommitted transaction", () => {
    const sql = renderSchemaHandoffTransaction(input());
    expect(sql.match(/^BEGIN;$/gmu)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gmu)).toBeNull();
    expect(
      sql.match(/^INSERT INTO public\._prisma_migrations/gmu),
    ).toHaveLength(3);
    expect(sql.match(/^UPDATE public\._prisma_migrations/gmu)).toHaveLength(3);
    for (const r of catalog.slice(89)) {
      const source = readFileSync(
        `packages/platform/db/prisma/migrations/${r.migrationName}/migration.sql`,
        "utf8",
      );
      expect(sql).toContain(
        `SET LOCAL search_path = public, pg_temp;\n${stripAtomicMigrationEnvelope(source, r.migrationName)}\nSET LOCAL search_path = pg_catalog, public;`,
      );
    }
    expect(sql).toContain(
      'LOCK TABLE public."CodexOAuthSecretNamespace" IN SHARE ROW EXCLUSIVE MODE;',
    );
    expect(sql).toContain(
      "codex_oauth_v4_v5_compatibility_predecessor_evidence_missing",
    );
    expect(sql.indexOf("render_retained_guard_drift")).toBeLessThan(
      sql.indexOf("DROP TRIGGER reviewrouter_managed_retained_ledger_guard"),
    );
    expect(sql.indexOf("render_handoff_baseline_changed")).toBeLessThan(
      sql.indexOf("GRANT reviewrouter_release_schema_owner"),
    );
    expect(sql).toContain("GRANTED BY reviewrouter RESTRICT;");
    expect(sql).not.toMatch(/migrate resolve|REASSIGN OWNED|DROP OWNED/u);
  });

  it("only transfers the schema and namespace; dependency grants use explicit columns and grantor", () => {
    const sql = renderSchemaHandoffTransaction(input());
    expect(
      sql.match(
        /^ALTER (?:SCHEMA|TABLE).*OWNER TO reviewrouter_release_schema_owner;$/gmu,
      ),
    ).toEqual([
      "ALTER SCHEMA public OWNER TO reviewrouter_release_schema_owner;",
      'ALTER TABLE public."CodexOAuthSecretNamespace" OWNER TO reviewrouter_release_schema_owner;',
    ]);
    const grants = renderSchemaHandoffDependencySql.split("\n");
    expect(grants).toHaveLength(11);
    for (const grant of grants)
      expect(grant).toMatch(/GRANTED BY reviewrouter;$/u);
    expect(renderSchemaHandoffDependencySql).not.toMatch(
      /ALL|SELECT ON|UPDATE ON|DELETE|TRUNCATE|OWNED|WITH GRANT OPTION/u,
    );
    expect(grants.filter((g) => g.startsWith("GRANT UPDATE"))).toHaveLength(3);
    for (const grant of grants.filter((g) => g.startsWith("GRANT UPDATE")))
      expect(grant).toContain('UPDATE ("id")');
  });

  it.each([76, 88, 90, 91, 92])(
    "rejects a %i-row request instead of replaying a partial or committed handoff",
    (count) => {
      expect(() =>
        renderSchemaHandoffTransaction({ ...input(), ledger: ledger(count) }),
      ).toThrow();
    },
  );

  it.each([
    { finishedAt: null },
    { rolledBackAt: "2026-08-01T00:00:02.000001Z" },
    { hasLogs: true },
    { logsDigest: `sha256:${"c".repeat(64)}` },
    { appliedStepsCount: 0 },
    { unknown: true },
  ])(
    "keeps failed, logged and ambiguous history out of transaction construction %#",
    (change) => {
      const state = input();
      Object.assign(state.ledger[0]!, change);
      expect(() => renderSchemaHandoffTransaction(state)).toThrow(
        "managed_ledger_history",
      );
    },
  );

  it("binds the entire prior ledger and original grantor without using a fixture as approval", () => {
    const state = input();
    const plan = renderSchemaHandoffTransaction(state);
    state.ledger[0]!.id = "11111111-1111-1111-1111-111111111111";
    expect(renderSchemaHandoffTransaction(state)).not.toBe(plan);
    expect(() =>
      readReviewedRenderManagedContract("managed-schema-handoff"),
    ).toThrow("managed_independent_review_missing");
    state.originalMembership.grantor = "reviewrouter";
    expect(() => renderSchemaHandoffTransaction(state)).toThrow(
      "managed_original_membership",
    );
  });
});
