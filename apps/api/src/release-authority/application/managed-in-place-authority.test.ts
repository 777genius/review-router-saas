import { describe, expect, it, vi } from "vitest";
import {
  createManagedInPlaceTransition,
  managedInPlaceBaselineManifest,
  managedInPlaceTargetManifest,
  ManagedInPlaceTransitionType,
  type ManagedInPlaceEffectReceipt,
  type ManagedInPlaceOperationPermit,
  type ManagedInPlaceTopology,
} from "@reviewrouter/features-release-rollout";
import {
  ManagedInPlaceAuthorityService,
  type ManagedInPlaceCustodyPort,
} from "./managed-in-place-authority.js";
import {
  ManagedInPlaceReadinessPhase,
  type ManagedInPlaceCustodyReadiness,
  type TrustedManagedInPlaceIdentity,
} from "./readiness.js";

const resource = "dpg-da32ipmk1f9s73dttm90-a";
const transition = createManagedInPlaceTransition({
  commitSha: "a".repeat(40),
  releaseImageDigest: `sha256:${"b".repeat(64)}`,
  providerDatabaseResourceId: resource,
});
const topology: ManagedInPlaceTopology = {
  providerDatabaseResourceId: resource,
  systemIdentifier: "7482837671845777452",
  databaseOid: "16385",
  databaseName: "review_router_dimy",
  recoveryWitnessSha256: "c".repeat(64),
};
const databaseIdentity = {
  serverIdentity: topology.systemIdentifier,
  databaseIdentity: topology.databaseOid,
  databaseName: topology.databaseName,
};
const trustedIdentity: TrustedManagedInPlaceIdentity = {
  operationDatabaseIdentity: databaseIdentity,
  coordinatorRoleName: "reviewrouter",
  custodyOwnerRoleName: "reviewrouter_operation_custody_owner",
  custodyReaderRoleName: "reviewrouter_operation_custody_reader",
  baselineManifestIdentity: managedInPlaceBaselineManifest,
  targetManifestIdentity: managedInPlaceTargetManifest,
};
const readiness = (manifest: string): ManagedInPlaceCustodyReadiness => ({
  roleName: "reviewrouter",
  custodyOwnerRoleName: trustedIdentity.custodyOwnerRoleName,
  custodyReaderRoleName: trustedIdentity.custodyReaderRoleName,
  systemIdentifier: topology.systemIdentifier,
  recoveryWitnessSha256: topology.recoveryWitnessSha256,
  databaseIdentity,
  postgresMajor: 17,
  applicationMigrationManifestIdentity: manifest,
  custodyAttested: true,
  custodyOwnerCanLogin: false,
  coordinatorCanAssumeCustodyOwner: false,
  admissionWithdrawn: true,
  fleetQuiesced: true,
  privilegedBackendPresent: false,
  automaticMigrationsDisabled: true,
  externalFenceHeld: true,
  runtimeGateStatus: "closed",
});
const operationId = "11111111-2222-3333-4444-555555555555";
const permit: ManagedInPlaceOperationPermit = {
  transitionType: ManagedInPlaceTransitionType,
  schemaVersion: 1,
  operationId,
  transitionSha256: transition.transitionSha256,
  admissionIdentityDigest: `sha256:${"d".repeat(64)}`,
  topology,
  externalFenceSha256: `sha256:${"e".repeat(64)}`,
  terminalCatalogDigest: `sha256:${"f".repeat(64)}`,
  generation: 2,
  epoch: 1,
  nonce: "0".repeat(32),
  state: "open",
};
const receipt: ManagedInPlaceEffectReceipt = {
  transitionType: ManagedInPlaceTransitionType,
  operationId,
  generation: permit.generation,
  epoch: permit.epoch,
  nonce: permit.nonce,
  ledgerManifest: managedInPlaceTargetManifest,
  terminalCatalogDigest: permit.terminalCatalogDigest,
  effectFingerprint: `sha256:${"1".repeat(64)}`,
  permitState: "terminal",
};

const claim = {
  operationId,
  transition,
  admissionIdentityDigest: permit.admissionIdentityDigest,
  externalFenceSha256: permit.externalFenceSha256,
  terminalCatalogDigest: permit.terminalCatalogDigest,
  generation: permit.generation,
  nonce: permit.nonce,
  source: topology,
  target: topology,
};

const build = (
  custody: Partial<ManagedInPlaceCustodyPort>,
  manifest = managedInPlaceBaselineManifest,
) => {
  const phases: ManagedInPlaceReadinessPhase[] = [];
  const service = new ManagedInPlaceAuthorityService(
    {
      openOperation: vi.fn(async () => permit),
      currentPermit: vi.fn(async () => permit),
      advanceEpoch: vi.fn(async () => ({
        ...permit,
        epoch: permit.epoch + 1,
        nonce: "9".repeat(32),
      })),
      readEffectReceipt: vi.fn(async () => receipt),
      ...custody,
    },
    { observe: async () => readiness(manifest) },
    {
      execute: (sequence) =>
        Promise.resolve(
          sequence((mutation, phase) => {
            phases.push(phase);
            return Promise.resolve(
              mutation({
                systemIdentifier: topology.systemIdentifier,
                recoveryWitnessSha256: topology.recoveryWitnessSha256,
              }),
            );
          }),
        ),
    },
    transition,
    trustedIdentity,
  );
  return { service, phases };
};

describe("managed in-place authority service", () => {
  it("opens a permit for one database named identically on both sides", async () => {
    const { service, phases } = build({});
    await expect(service.claim(claim)).resolves.toMatchObject({
      operationId,
      epoch: 1,
      state: "open",
    });
    expect(phases).toEqual([ManagedInPlaceReadinessPhase.BeforeExecution]);
  });

  it("refuses two different databases, an untrusted transition and a drifted permit", async () => {
    const { service } = build({});
    await expect(
      service.claim({
        ...claim,
        target: { ...topology, databaseOid: "16386" },
      }),
    ).rejects.toThrow("managed_in_place_topology_not_identical");
    await expect(
      service.claim({
        ...claim,
        transition: createManagedInPlaceTransition({
          commitSha: "f".repeat(40),
          releaseImageDigest: `sha256:${"b".repeat(64)}`,
          providerDatabaseResourceId: resource,
        }),
      }),
    ).rejects.toThrow("managed_in_place_transition_untrusted");
    const drifted = build({
      openOperation: async () => ({
        ...permit,
        terminalCatalogDigest: `sha256:${"7".repeat(64)}`,
      }),
    });
    await expect(drifted.service.claim(claim)).rejects.toThrow(
      "managed_in_place_permit_binding_conflict",
    );
  });

  it("refuses a permit bound to the wrong nonce or a different but internally consistent topology", async () => {
    const wrongNonce = build({
      openOperation: async () => ({ ...permit, nonce: "1".repeat(32) }),
    });
    await expect(wrongNonce.service.claim(claim)).rejects.toThrow(
      "managed_in_place_permit_binding_conflict",
    );
    const wrongTopology = build({
      openOperation: async () => ({
        ...permit,
        topology: { ...topology, databaseOid: "99999" },
      }),
    });
    await expect(wrongTopology.service.claim(claim)).rejects.toThrow(
      "managed_in_place_permit_binding_conflict",
    );
  });

  it("refuses to act when the execution boundary is not ready", async () => {
    const { service } = build({}, managedInPlaceTargetManifest);
    await expect(service.claim(claim)).rejects.toThrow(
      "managed_in_place_boundary_not_ready",
    );
  });

  it("advances the epoch only from the expected one and keeps the generation", async () => {
    const { service } = build({});
    await expect(
      service.begin({ operationId, expectedEpoch: 1 }),
    ).resolves.toMatchObject({ epoch: 1 });
    await expect(
      service.begin({ operationId, expectedEpoch: 2 }),
    ).rejects.toThrow("managed_in_place_permit_stale");
    await expect(
      service.begin({
        operationId,
        expectedEpoch: 1,
        nextNonce: "9".repeat(32),
      }),
    ).resolves.toMatchObject({ epoch: 2, generation: permit.generation });
    const absent = build({ currentPermit: async () => null });
    await expect(
      absent.service.begin({ operationId, expectedEpoch: 1 }),
    ).rejects.toThrow("managed_in_place_permit_absent");
    const terminal = build({
      currentPermit: async () => ({ ...permit, state: "terminal" as const }),
    });
    await expect(
      terminal.service.begin({ operationId, expectedEpoch: 1 }),
    ).rejects.toThrow("managed_in_place_permit_terminal");
  });

  it("refuses an advanced permit bound to the wrong nonce or a drifted topology", async () => {
    const wrongNonce = build({
      advanceEpoch: async () => ({
        ...permit,
        epoch: permit.epoch + 1,
        nonce: "8".repeat(32),
      }),
    });
    await expect(
      wrongNonce.service.begin({
        operationId,
        expectedEpoch: 1,
        nextNonce: "9".repeat(32),
      }),
    ).rejects.toThrow("managed_in_place_permit_advance_invalid");
    const wrongTopology = build({
      advanceEpoch: async () => ({
        ...permit,
        epoch: permit.epoch + 1,
        nonce: "9".repeat(32),
        topology: { ...topology, databaseOid: "99999" },
      }),
    });
    await expect(
      wrongTopology.service.begin({
        operationId,
        expectedEpoch: 1,
        nextNonce: "9".repeat(32),
      }),
    ).rejects.toThrow("managed_in_place_permit_advance_invalid");
  });

  it("completes only from a bound receipt read after execution", async () => {
    const { service, phases } = build({}, managedInPlaceTargetManifest);
    await expect(service.complete({ permit })).resolves.toEqual(receipt);
    expect(phases).toEqual([ManagedInPlaceReadinessPhase.AfterExecution]);
    const absent = build(
      { readEffectReceipt: async () => null },
      managedInPlaceTargetManifest,
    );
    await expect(absent.service.complete({ permit })).rejects.toThrow(
      "managed_in_place_effect_receipt_absent",
    );
    const foreign = build(
      { readEffectReceipt: async () => ({ ...receipt, epoch: 9 }) },
      managedInPlaceTargetManifest,
    );
    await expect(foreign.service.complete({ permit })).rejects.toThrow(
      "managed_in_place_effect_receipt_unbound",
    );
  });

  it("reconciles an unknown commit without replay and fences the rest", async () => {
    const committed = build({}, managedInPlaceTargetManifest);
    await expect(
      committed.service.reconcile({
        permit,
        originalBackendState: "terminated",
        rollbackConfirmed: false,
        externalFenceHeld: true,
        ledgerManifest: managedInPlaceTargetManifest,
        gateStatus: "closed",
      }),
    ).resolves.toMatchObject({
      decision: "reconciled-without-replay",
      replay: false,
    });
    const rolledBack = build({ readEffectReceipt: async () => null });
    await expect(
      rolledBack.service.reconcile({
        permit,
        originalBackendState: "terminated",
        rollbackConfirmed: true,
        externalFenceHeld: true,
        ledgerManifest: managedInPlaceBaselineManifest,
        gateStatus: "closed",
      }),
    ).resolves.toMatchObject({
      decision: "resume-same-operation",
      replay: false,
    });
    await expect(
      rolledBack.service.reconcile({
        permit,
        originalBackendState: "unknown",
        rollbackConfirmed: true,
        externalFenceHeld: true,
        ledgerManifest: managedInPlaceBaselineManifest,
        gateStatus: "closed",
      }),
    ).resolves.toMatchObject({ decision: "fenced", replay: false });
  });

  it("fails closed without a trusted transition or identity", async () => {
    const service = new ManagedInPlaceAuthorityService(
      {
        openOperation: async () => permit,
        currentPermit: async () => permit,
        advanceEpoch: async () => permit,
        readEffectReceipt: async () => receipt,
      },
      { observe: async () => readiness(managedInPlaceBaselineManifest) },
      {
        execute: (sequence) =>
          Promise.resolve(sequence(async (m) => m({} as never))),
      },
    );
    await expect(service.claim(claim)).rejects.toThrow(
      "managed_in_place_transition_missing",
    );
  });
});
