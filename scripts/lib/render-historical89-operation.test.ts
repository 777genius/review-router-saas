import { describe, expect, it } from "vitest";
import {
  authorizeHistorical89InPlaceOperation,
  historical89InPlaceCustodyBinding,
  planHistorical89InPlaceOperation,
  reconcileHistorical89InPlaceOperation,
  renderHistorical89InPlacePreflightSql,
} from "./render-historical89-operation.mjs";
import {
  readHistorical89PendingIdentities,
  renderHistorical89AdmissionPhase,
  renderHistorical89PendingBodies,
} from "./render-historical89-admission.mjs";
import {
  managedInPlaceBaselineManifest,
  managedInPlacePendingEntries,
  managedInPlacePendingMigrationNames,
  managedInPlaceTargetManifest,
  ManagedInPlaceTransitionType,
} from "../../packages/features/release-rollout/src/domain/managed-in-place-transition";

const admission = {
  operationId: "11111111-2222-3333-4444-555555555555",
  systemIdentifier: "7482837671845777452",
  databaseOid: "16385",
  databaseName: "review_router_dimy",
  recoveryIdentitySha256: `sha256:${"b".repeat(64)}`,
  externalFenceSha256: `sha256:${"c".repeat(64)}`,
};

describe("historical89 in-place operation", () => {
  it("agrees exactly with the typed domain contract about what this operation is", () => {
    // Two layers state the same operation. A drift between them would let the
    // typed authority admit a transition the SQL side would not apply.
    expect(ManagedInPlaceTransitionType).toBe(
      renderHistorical89AdmissionPhase.kind,
    );
    expect([...managedInPlacePendingMigrationNames]).toEqual([
      ...renderHistorical89PendingBodies,
    ]);
    expect(managedInPlaceBaselineManifest).toBe(
      renderHistorical89AdmissionPhase.baselineManifest,
    );
    expect(managedInPlaceTargetManifest).toBe(
      renderHistorical89AdmissionPhase.targetManifest,
    );
    const checkouts = readHistorical89PendingIdentities();
    expect(
      managedInPlacePendingEntries.map((entry) => entry.migrationSqlSha256),
    ).toEqual(checkouts.map((row: { checksum: string }) => row.checksum));
  });

  it("derives the custody binding from catalog-independent identity only", () => {
    expect(historical89InPlaceCustodyBinding(admission as never)).toEqual(
      admission,
    );
  });

  it("renders a rehearsal preflight without the permit that does not exist yet", () => {
    const binding = historical89InPlaceCustodyBinding(admission as never);
    const rehearsal = renderHistorical89InPlacePreflightSql(binding);
    expect(rehearsal).toContain("historical89_fleet_not_quiesced");
    expect(rehearsal).toContain("custody_attestation_failed");
    expect(rehearsal).not.toContain("historical89_permit_stale");
    const full = renderHistorical89InPlacePreflightSql(binding, {
      epoch: 1,
      nonce: "0".repeat(32),
      generation: 1,
      terminalCatalogDigest: `sha256:${"d".repeat(64)}`,
      admissionIdentityDigest: `sha256:${"e".repeat(64)}`,
    });
    expect(full).toContain("historical89_permit_stale");
    // The rehearsal is a strict prefix of the real preflight, so the terminal
    // catalog it observes is the one the real run reaches.
    expect(full.startsWith(rehearsal)).toBe(true);
  });

  it("never authorizes production mutation and names every blocker", () => {
    const authorization = authorizeHistorical89InPlaceOperation({
      admission: {},
      defaultAcl: {},
      creatorEvidence: {},
      terminalCatalogProvenance: "reviewed-registry",
    } as never);
    expect(authorization.authorizesProductionMutation).toBe(false);
    expect(authorization.blockedBy).toContain(
      "operation_custody:owner_bootstrapped_not_independent",
    );
    expect(
      authorization.blockedBy.some((reason) =>
        reason.startsWith("admission_qualification:"),
      ),
    ).toBe(true);
    const rehearsed = authorizeHistorical89InPlaceOperation({
      admission: {},
      defaultAcl: {},
      creatorEvidence: {},
      terminalCatalogProvenance: "disposable-rehearsal",
    } as never);
    expect(rehearsed.blockedBy).toContain(
      "terminal_catalog_provenance:disposable-rehearsal",
    );
  });

  it("rejects an incomplete plan input rather than rendering a partial operation", () => {
    expect(() => planHistorical89InPlaceOperation({} as never)).toThrow(
      "render_historical89_operation_rejected:plan_shape",
    );
  });

  it("fences every reconciliation it cannot resolve", () => {
    const base = {
      plan: { kind: renderHistorical89AdmissionPhase.kind, binding: admission },
      backendState: "terminated",
      rollbackConfirmed: true,
      ledger: [],
      terminalCatalog: {},
      gate: {},
      memberships: [],
      originalMembership: {},
      aclDelta: undefined,
      receipt: null,
      fenceHeld: true,
    };
    expect(
      reconcileHistorical89InPlaceOperation({
        ...base,
        fenceHeld: false,
      } as never),
    ).toMatchObject({
      decision: "fenced",
      replay: false,
      reasons: ["external_fence_not_held"],
    });
    expect(
      reconcileHistorical89InPlaceOperation({
        ...base,
        backendState: "unknown",
      } as never),
    ).toMatchObject({ reasons: ["original_backend_unresolved"] });
    expect(
      reconcileHistorical89InPlaceOperation({ plan: null } as never),
    ).toMatchObject({
      decision: "fenced",
      reasons: ["reconciliation_input_shape"],
    });
    expect(
      reconcileHistorical89InPlaceOperation({
        ...base,
        plan: { kind: "other", binding: admission },
      } as never),
    ).toMatchObject({ decision: "fenced", reasons: ["plan_untrusted"] });
    // Every outcome, including the fenced ones, refuses replay.
    for (const change of [{}, { fenceHeld: false }, { backendState: "alive" }])
      expect(
        reconcileHistorical89InPlaceOperation({ ...base, ...change } as never)
          .replay,
      ).toBe(false);
  });
});
