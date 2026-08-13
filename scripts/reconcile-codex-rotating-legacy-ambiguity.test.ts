import { describe, expect, it, vi } from "vitest";
import {
  legacyAmbiguityReconciliationSql,
  reconcileLegacyAmbiguity,
} from "./reconcile-codex-rotating-legacy-ambiguity.mjs";

const inventory = {
  activeLeaseIds: Array.from({ length: 613 }, (_, index) => `lease-${index}`),
  fetchedSetupIds: Array.from({ length: 32 }, (_, index) => `setup-${index}`),
  pendingIntentIds: [],
  intentStatuses: ["completed", "failed", "remote_outcome_unknown"],
};

describe("legacy cutover reconciliation", () => {
  it("captures two stable production-shaped samples and reaches raw-status zero", () => {
    const run = vi.fn((step: string) => {
      if (step === "legacy_ambiguity_inventory_after")
        return JSON.stringify({
          ...inventory,
          activeLeaseIds: [],
          fetchedSetupIds: [],
          pendingIntentIds: [],
        });
      return JSON.stringify(inventory);
    });
    const result = reconcileLegacyAmbiguity(
      {
        databaseUrl: "postgresql://release:s@target.internal/db",
        recoveryWitnessSha256: "a".repeat(64),
        rolloutId: "rollout-1",
      },
      run,
    );
    expect(result.inventory.activeLeaseIds).toHaveLength(613);
    expect(result.inventory.fetchedSetupIds).toHaveLength(32);
    expect(result.stableSamples).toBe(2);
    expect(result.status).toBe("reconciled");
  });

  it("fails closed on unstable inventory and every unclassified intent status", () => {
    let sample = 0;
    expect(() =>
      reconcileLegacyAmbiguity(
        {
          databaseUrl: "postgresql://release:s@target.internal/db",
          recoveryWitnessSha256: "a".repeat(64),
          rolloutId: "rollout-1",
        },
        (step: string) => {
          if (step.includes("inventory")) sample += 1;
          return JSON.stringify({
            ...inventory,
            activeLeaseIds: sample === 1 ? ["lease-a"] : ["lease-b"],
          });
        },
      ),
    ).toThrow("legacy_reconciliation_inventory_not_stable");
    expect(() =>
      reconcileLegacyAmbiguity(
        {
          databaseUrl: "postgresql://release:s@target.internal/db",
          recoveryWitnessSha256: "a".repeat(64),
          rolloutId: "rollout-1",
        },
        () => JSON.stringify({ ...inventory, intentStatuses: ["new_state"] }),
      ),
    ).toThrow("legacy_reconciliation_intent_status_unclassified:new_state");
  });

  it("encodes negative eligibility gates and acknowledged fetched recovery", () => {
    const sql = legacyAmbiguityReconciliationSql({
      inventory,
      inventorySha256: `sha256:${"b".repeat(64)}`,
      recoveryWitnessSha256: "a".repeat(64),
      rolloutId: "rollout-1",
    });
    expect(sql).toContain('lease."expiresAt" <= clock_timestamp()');
    expect(sql).toContain('lease."mutationEpoch" < provider."mutationEpoch"');
    expect(sql).toContain("versioned-namespace-cutover:");
    expect(sql).toContain("remote_outcome_unknown");
    expect(sql).toContain("legacy_reconciliation_lease_not_eligible");
    expect(sql).toContain("legacy_reconciliation_fetched_setup_not_eligible");
    expect(sql).toContain("all_prior_installers_and_writers_are_stopped");
    expect(sql).toContain("acknowledgedSecretMayHaveChanged");
    expect(sql).toContain("legacyInventorySha256");
    expect(sql).not.toMatch(/DELETE\s+FROM/iu);
  });
});
