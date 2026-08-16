import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { sha256Canonical } from "../packages/features/release-rollout/src/domain/release-rollout";
import {
  guardedLegacyAmbiguityReconciliationProcedureSql,
  legacyAmbiguityReconciliationSql,
  prepareLegacyAmbiguityReconciliation,
} from "./reconcile-codex-rotating-legacy-ambiguity.mjs";

const inventory = {
  activeLeaseIds: Array.from(
    { length: 613 },
    (_, index) => `lease-${index}`,
  ).sort(),
  fetchedSetupIds: Array.from(
    { length: 32 },
    (_, index) => `setup-${index}`,
  ).sort(),
  pendingIntentIds: [],
  intentStatuses: ["completed", "failed"],
};
const sourceEvidence = (value = inventory) => {
  const inventorySha256 = `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
  const unsigned = {
    schemaVersion: 1 as const,
    rolloutId: "rollout-1",
    sourceSystemIdentifier: "100",
    sourceDatabaseName: "reviewrouter",
    sourceRecoveryWitnessSha256: "b".repeat(64),
    authorityPrincipal: "source_admin",
    fenceId: "source-fence:rollout-1",
    fenceEstablishedAt: "2026-08-15T00:00:00.000Z",
    fencedInventorySha256: `sha256:${"f".repeat(64)}`,
    ...value,
    inventorySha256,
    observations: [
      { observedAt: "2026-08-15T00:00:01.000Z", inventorySha256 },
      { observedAt: "2026-08-15T00:00:02.000Z", inventorySha256 },
    ],
    eligibilityCutoff: "2026-08-15T00:00:02.000Z",
    stable: true,
  } as const;
  return {
    ...unsigned,
    receiptSha256: `sha256:${sha256Canonical(unsigned)}`,
  } as const;
};

describe("legacy cutover reconciliation", () => {
  it("uses the source-owned two-sample evidence without target resampling", () => {
    const run = vi.fn();
    const result = prepareLegacyAmbiguityReconciliation(
      {
        databaseUrl: "postgresql://release:s@target.internal/db",
        recoveryWitnessSha256: "a".repeat(64),
        rolloutId: "rollout-1",
        eligibilityCutoff: "2026-08-15T00:00:02.000Z",
        legacyAmbiguity: sourceEvidence(),
      },
      run,
    );
    expect(result.input.inventory.activeLeaseIds).toHaveLength(613);
    expect(result.evidence.observations).toHaveLength(2);
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed on unstable inventory and every unclassified intent status", () => {
    expect(() =>
      prepareLegacyAmbiguityReconciliation(
        {
          databaseUrl: "postgresql://release:s@target.internal/db",
          recoveryWitnessSha256: "a".repeat(64),
          rolloutId: "rollout-1",
          eligibilityCutoff: "2026-08-15T00:00:02.000Z",
          legacyAmbiguity: {
            ...sourceEvidence(),
            inventorySha256: `sha256:${"0".repeat(64)}`,
          },
        },
        vi.fn(),
      ),
    ).toThrow("legacy_reconciliation_source_evidence_invalid");
    expect(() =>
      prepareLegacyAmbiguityReconciliation(
        {
          databaseUrl: "postgresql://release:s@target.internal/db",
          recoveryWitnessSha256: "a".repeat(64),
          rolloutId: "rollout-1",
          eligibilityCutoff: "2026-08-15T00:00:02.000Z",
          legacyAmbiguity: sourceEvidence({
            ...inventory,
            intentStatuses: ["new_state"],
          }),
        },
        vi.fn(),
      ),
    ).toThrow("legacy_reconciliation_intent_status_unclassified:new_state");
    expect(() =>
      prepareLegacyAmbiguityReconciliation(
        {
          databaseUrl: "postgresql://release:s@target.internal/db",
          recoveryWitnessSha256: "a".repeat(64),
          rolloutId: "rollout-1",
          eligibilityCutoff: "2026-08-15T00:00:02.000Z",
          legacyAmbiguity: { ...sourceEvidence(), unexpected: [] },
        },
        vi.fn(),
      ),
    ).toThrow("legacy_reconciliation_source_evidence_invalid");
  });

  it("encodes negative eligibility gates and acknowledged fetched recovery", () => {
    const sql = legacyAmbiguityReconciliationSql({
      inventory,
      inventorySha256: `sha256:${"b".repeat(64)}`,
      recoveryWitnessSha256: "a".repeat(64),
      rolloutId: "rollout-1",
      eligibilityCutoff: "2026-08-15T00:00:02.000Z",
    });
    expect(sql).toContain(
      "lease.\"expiresAt\" <= '2026-08-15T00:00:02.000Z'::timestamptz",
    );
    expect(sql).not.toContain('"expiresAt" <= clock_timestamp()');
    expect(sql).toContain('lease."mutationEpoch" < provider."mutationEpoch"');
    expect(sql).toContain("versioned-namespace-cutover:");
    expect(sql).toContain("remote_outcome_unknown");
    expect(sql).toContain("'pending','remote_outcome_unknown'");
    expect(sql).toContain(
      "NOT IN ('completed','failed','pending','remote_outcome_unknown')",
    );
    expect(sql).toContain("legacy_reconciliation_unresolved_intent");
    expect(sql).toContain("legacy_reconciliation_inventory_addition");
    expect(sql).toContain("legacy_reconciliation_lease_not_eligible");
    expect(sql).toContain("legacy_reconciliation_fetched_setup_not_eligible");
    expect(sql).toMatch(
      /"expiresAt" <= '2026-08-15T00:00:02\.000Z'::timestamptz[\s\S]+legacy_reconciliation_lease_not_eligible/u,
    );
    expect(sql).toContain("all_prior_installers_and_writers_are_stopped");
    expect(sql).toContain("acknowledgedSecretMayHaveChanged");
    expect(sql).toContain("legacyInventorySha256");
    expect(sql).not.toMatch(/DELETE\s+FROM/iu);
  });

  it("rechecks the original digest and permits only inventory subsets", () => {
    const sql = guardedLegacyAmbiguityReconciliationProcedureSql(
      "reviewrouter_schema_owner",
    );
    expect(sql).toContain("sha256(convert_to");
    expect(sql).toContain("requested_eligibility_cutoff");
    expect(sql).toContain(
      "requested_inventory::jsonb->'activeLeaseIds' ? lease.\"id\"",
    );
    expect(sql).toContain(
      "requested_inventory::jsonb->'fetchedSetupIds' ? manifest.\"id\"",
    );
    expect(sql).toContain("legacy_reconciliation_inventory_addition");
    expect(sql).toContain("legacy_reconciliation_unresolved_intent");
    expect(sql).not.toContain("rr-sentinel-active");
  });
});
