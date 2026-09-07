import { describe, expect, it } from "vitest";
import {
  advanceManagedInPlacePermit,
  assertManagedInPlaceEffectReceipt,
  assertManagedInPlaceOperationPermit,
  assertManagedInPlaceTopology,
  assertManagedInPlaceTransition,
  assertManagedInPlaceTransitionIntegrity,
  createManagedInPlaceTransition,
  managedInPlaceBaselineManifest,
  managedInPlacePendingMigrationNames,
  managedInPlaceTargetManifest,
  ManagedInPlaceTransitionType,
  reconcileManagedInPlaceCommit,
  type ManagedInPlaceEffectReceipt,
  type ManagedInPlaceOperationPermit,
  type ManagedInPlaceTopology,
} from "./managed-in-place-transition";
import {
  canonicalReleaseMigrationEntries,
  createReleaseMigrationTransition,
} from "./release-migration-transition";
import { createReleaseRollout } from "./release-rollout";

const commitSha = "a".repeat(40);
const releaseImageDigest = `sha256:${"b".repeat(64)}`;
const resource = "dpg-da32ipmk1f9s73dttm90-a";
const transition = createManagedInPlaceTransition({
  commitSha,
  releaseImageDigest,
  providerDatabaseResourceId: resource,
});
const topology: ManagedInPlaceTopology = {
  providerDatabaseResourceId: resource,
  systemIdentifier: "7482837671845777452",
  databaseOid: "16385",
  databaseName: "review_router_dimy",
  recoveryWitnessSha256: "c".repeat(64),
};
const permit: ManagedInPlaceOperationPermit = {
  transitionType: ManagedInPlaceTransitionType,
  schemaVersion: 1,
  operationId: "11111111-2222-3333-4444-555555555555",
  transitionSha256: transition.transitionSha256,
  admissionIdentityDigest: `sha256:${"d".repeat(64)}`,
  topology,
  externalFenceSha256: `sha256:${"e".repeat(64)}`,
  terminalCatalogDigest: `sha256:${"f".repeat(64)}`,
  generation: 3,
  epoch: 1,
  nonce: "0".repeat(32),
  state: "open",
};
const receipt: ManagedInPlaceEffectReceipt = {
  transitionType: ManagedInPlaceTransitionType,
  operationId: permit.operationId,
  generation: permit.generation,
  epoch: permit.epoch,
  nonce: permit.nonce,
  ledgerManifest: managedInPlaceTargetManifest,
  terminalCatalogDigest: permit.terminalCatalogDigest,
  effectFingerprint: `sha256:${"1".repeat(64)}`,
  permitState: "terminal",
};

describe("managed in-place transition", () => {
  it("binds the discriminator and the exact seven bodies into its digest", () => {
    expect(transition.transitionType).toBe(ManagedInPlaceTransitionType);
    expect(
      transition.orderedPendingEntries.map((entry) => entry.migrationName),
    ).toEqual([...managedInPlacePendingMigrationNames]);
    // Every checksum comes from the one canonical entry list, not a restatement.
    for (const entry of transition.orderedPendingEntries)
      expect(canonicalReleaseMigrationEntries).toContainEqual(entry);
    expect(transition.baselineManifestIdentity).toBe(
      managedInPlaceBaselineManifest,
    );
    expect(transition.targetManifestIdentity).toBe(
      managedInPlaceTargetManifest,
    );
    expect(() =>
      assertManagedInPlaceTransitionIntegrity(transition),
    ).not.toThrow();
  });

  it("rejects a relocation transition relabelled as in-place and vice versa", () => {
    const relocation = createReleaseMigrationTransition({
      commitSha,
      releaseImageDigest,
    });
    expect(() =>
      assertManagedInPlaceTransitionIntegrity({
        ...(relocation as unknown as Record<string, unknown>),
        transitionType: ManagedInPlaceTransitionType,
      } as never),
    ).toThrow("managed_in_place_transition_untrusted");
    // Removing the discriminator changes the digest, so it cannot be dropped.
    const stripped = { ...transition } as Record<string, unknown>;
    delete stripped.transitionType;
    expect(() =>
      assertManagedInPlaceTransitionIntegrity(stripped as never),
    ).toThrow("managed_in_place_transition_untrusted");
    // Integrity alone is not trust: a well-formed transition for a different
    // release is still refused against the injected trusted one.
    expect(() =>
      assertManagedInPlaceTransition(transition, transition),
    ).not.toThrow();
    expect(() =>
      assertManagedInPlaceTransition(
        createManagedInPlaceTransition({
          commitSha: "f".repeat(40),
          releaseImageDigest,
          providerDatabaseResourceId: resource,
        }),
        transition,
      ),
    ).toThrow("managed_in_place_transition_untrusted");
  });

  it.each([
    ["a substituted checksum", { orderedPendingEntries: [] }],
    [
      "a foreign database resource",
      { providerDatabaseResourceId: "dpg-other-a" },
    ],
    [
      "a different target manifest",
      { targetManifestIdentity: `sha256:${"0".repeat(64)}` },
    ],
    ["a different baseline count", { baselineCount: 92 }],
  ])("rejects %s", (_label, change) => {
    expect(() =>
      assertManagedInPlaceTransitionIntegrity({
        ...transition,
        ...(change as Record<string, unknown>),
      }),
    ).toThrow("managed_in_place_transition_untrusted");
  });

  it("requires an identical database on both sides, where relocation requires distinct ones", () => {
    expect(
      assertManagedInPlaceTopology({ source: topology, target: topology }),
    ).toEqual(topology);
    expect(() =>
      assertManagedInPlaceTopology({
        source: topology,
        target: { ...topology, systemIdentifier: "9482837671845777452" },
      }),
    ).toThrow("managed_in_place_topology_not_identical");
    expect(() =>
      assertManagedInPlaceTopology({
        source: topology,
        target: { ...topology, databaseOid: "16386" },
      }),
    ).toThrow("managed_in_place_topology_not_identical");
    // The relocation rule is untouched: equal generations are still refused,
    // and the rejection is that specific rule rather than an earlier one.
    const generation = {
      renderResourceId: resource,
      internalHostname: "db.internal",
      databaseName: "review_router_dimy",
      systemIdentifier: topology.systemIdentifier,
      recoveryWitnessSha256: topology.recoveryWitnessSha256,
    };
    const relocationInput = {
      rolloutId: "rollout-1",
      expectedCommitSha: commitSha,
      execution: {
        organization: "reviewrouter-control",
        controlRepository: "reviewrouter-control/releases",
        workflowPath: ".github/workflows/private-network-pg17-rollout.yml",
        workflowRef: "refs/heads/main",
        event: "workflow_dispatch" as const,
        actor: "release-operator",
        runId: "123",
        runAttempt: 1,
        roleJobName: "copy-and-role-bootstrap-private",
        cutoverJobName: "pg17-cutover-private",
      },
      source: { ...generation, majorVersion: 16 as const },
      target: { ...generation, majorVersion: 17 as const },
      migrationTransition: createReleaseMigrationTransition({
        commitSha,
        releaseImageDigest,
      }),
    };
    expect(() => createReleaseRollout(relocationInput as never)).toThrow(
      "database_generations_not_distinct",
    );
    expect(() =>
      createReleaseRollout({
        ...relocationInput,
        source: {
          ...relocationInput.source,
          renderResourceId: "dpg-other-a",
          systemIdentifier: "9482837671845777452",
        },
      } as never),
    ).not.toThrow();
  });

  it("keeps every identity across a compare-and-set and refuses a stale one", () => {
    expect(() =>
      assertManagedInPlaceOperationPermit(permit, transition),
    ).not.toThrow();
    const advanced = advanceManagedInPlacePermit(permit, "1".repeat(32));
    expect(advanced).toMatchObject({
      epoch: 2,
      nonce: "1".repeat(32),
      generation: permit.generation,
      operationId: permit.operationId,
      terminalCatalogDigest: permit.terminalCatalogDigest,
    });
    expect(() => advanceManagedInPlacePermit(permit, permit.nonce)).toThrow(
      "managed_in_place_permit_nonce_invalid",
    );
    expect(() =>
      advanceManagedInPlacePermit(
        { ...permit, state: "terminal" },
        "2".repeat(32),
      ),
    ).toThrow("managed_in_place_permit_terminal");
    for (const change of [
      { transitionSha256: `sha256:${"9".repeat(64)}` },
      { generation: 0 },
      { epoch: 0 },
      { nonce: "zz" },
      { topology: { ...topology, providerDatabaseResourceId: "dpg-other-a" } },
    ])
      expect(() =>
        assertManagedInPlaceOperationPermit(
          { ...permit, ...(change as Record<string, unknown>) },
          transition,
        ),
      ).toThrow();
  });

  it("binds an effect receipt to one operation, epoch, nonce and generation", () => {
    expect(() =>
      assertManagedInPlaceEffectReceipt(receipt, permit),
    ).not.toThrow();
    for (const change of [
      { epoch: 2 },
      { nonce: "2".repeat(32) },
      { generation: 4 },
      { operationId: "99999999-2222-3333-4444-555555555555" },
      { ledgerManifest: managedInPlaceBaselineManifest },
      { terminalCatalogDigest: `sha256:${"3".repeat(64)}` },
      { permitState: "open" },
    ])
      expect(() =>
        assertManagedInPlaceEffectReceipt(
          { ...receipt, ...(change as Record<string, unknown>) },
          permit,
        ),
      ).toThrow("managed_in_place_effect_receipt_unbound");
  });

  it("reconciles an unknown commit into exactly three outcomes and never a replay", () => {
    const committed = {
      originalBackendState: "terminated" as const,
      rollbackConfirmed: false,
      externalFenceHeld: true,
      ledgerManifest: managedInPlaceTargetManifest,
      gateStatus: "closed",
      receipt,
    };
    expect(reconcileManagedInPlaceCommit(committed, permit)).toMatchObject({
      decision: "reconciled-without-replay",
      replay: false,
    });
    const rolledBack = {
      ...committed,
      rollbackConfirmed: true,
      ledgerManifest: managedInPlaceBaselineManifest,
      receipt: null,
    };
    expect(reconcileManagedInPlaceCommit(rolledBack, permit)).toMatchObject({
      decision: "resume-same-operation",
      replay: false,
    });
    for (const change of [
      { externalFenceHeld: false },
      { originalBackendState: "unknown" as const },
      { originalBackendState: "alive" as const },
      { gateStatus: "active" },
      { receipt: null },
      { receipt: { ...receipt, epoch: 9 } },
      { ledgerManifest: null },
      { ledgerManifest: `sha256:${"7".repeat(64)}` },
    ])
      expect(
        reconcileManagedInPlaceCommit(
          { ...committed, ...(change as Record<string, unknown>) },
          permit,
        ),
      ).toMatchObject({ decision: "fenced", replay: false });
    for (const change of [
      { rollbackConfirmed: false },
      { receipt },
      { externalFenceHeld: false },
    ])
      expect(
        reconcileManagedInPlaceCommit(
          { ...rolledBack, ...(change as Record<string, unknown>) },
          permit,
        ),
      ).toMatchObject({ decision: "fenced", replay: false });
    // A terminal permit can no longer resume.
    expect(
      reconcileManagedInPlaceCommit(rolledBack, {
        ...permit,
        state: "terminal",
      }),
    ).toMatchObject({ decision: "fenced" });
  });
});
