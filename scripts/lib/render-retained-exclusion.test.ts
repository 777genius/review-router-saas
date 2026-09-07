import { describe, expect, it } from "vitest";
import {
  renderManagedCoordinatorExclusionSql,
  renderRetainedLedgerGuard,
} from "./render-retained-exclusion.mjs";
import { activationMigrationExclusionSql } from "../run-codex-rotating-release-migration.mjs";
import {
  readRenderSchemaHandoffCatalog,
  readReviewedRenderManagedContract,
} from "./render-schema-handoff-policy.mjs";

const binding = {
  operationId: "12345678-abcd-abcd-abcd-123456789abc",
  implementationSha: "a".repeat(40),
  custodyDigest: `sha256:${"b".repeat(64)}`,
};

describe("Prisma writer-owned retained migration exclusion", () => {
  it("keeps source identity fixed and the original operation binding immutable", () => {
    const input = { ...binding };
    const guard = renderRetainedLedgerGuard(input);
    expect(guard.applicationName).toBe(`rr-retained-${binding.operationId}`);
    expect(Object.isFrozen(guard)).toBe(true);
    input.implementationSha = "c".repeat(40);
    expect(renderRetainedLedgerGuard(input).verifySql).not.toBe(
      guard.verifySql,
    );
    expect(renderRetainedLedgerGuard(binding)).toEqual(guard);
    const catalog = readRenderSchemaHandoffCatalog();
    for (const row of catalog.slice(0, 89)) {
      expect(guard.installSql).toContain(row.migrationName);
      expect(guard.installSql).toContain(row.checksum);
    }
    for (const row of catalog.slice(89))
      expect(guard.installSql).not.toContain(row.checksum);
    // Binding a SQL plan is not a production approval or an escape from HOLD.
    expect(() =>
      readReviewedRenderManagedContract("managed-retained-upgrade"),
    ).toThrow("managed_independent_review_missing");
  });

  it.each([
    {},
    null,
    { ...binding, operationId: "'; SELECT 1; --" },
    { ...binding, implementationSha: "main" },
    { ...binding, custodyDigest: "observed-fixture" },
    { ...binding, databaseUrl: "postgresql://secret" },
    { ...binding, implementationSha: undefined },
    { ...binding, phase: "managed-schema-handoff" },
  ])("rejects incomplete, unbounded and cross-phase bindings %#", (invalid) => {
    expect(() => renderRetainedLedgerGuard(invalid)).toThrow(
      "guard_binding_invalid",
    );
  });

  it("requires both existing locks without blocking in the inverse Prisma lock order", () => {
    expect(renderManagedCoordinatorExclusionSql).toContain(
      activationMigrationExclusionSql,
    );
    expect(renderManagedCoordinatorExclusionSql).toContain(
      "pg_try_advisory_xact_lock(72707369::bigint)",
    );
    expect(renderManagedCoordinatorExclusionSql).not.toContain(
      "pg_advisory_xact_lock(72707369",
    );
    const guard = renderRetainedLedgerGuard(binding);
    expect(
      guard.installSql.indexOf("render_managed_coordinator_exclusion_missing"),
    ).toBeLessThan(guard.installSql.indexOf("CREATE FUNCTION"));
    expect(guard.installSql).not.toContain("CREATE OR REPLACE");
    expect(guard.installSql).not.toMatch(
      /DROP |DISABLE |CASCADE|migrate resolve/u,
    );
  });
});
