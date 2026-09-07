import { describe, expect, it } from "vitest";
import {
  managedInPlaceClaimRequest,
  managedInPlaceEffectReceiptRequest,
  managedInPlacePermitRequest,
  rolloutClaimRequest,
} from "./http.js";
import {
  createManagedInPlaceTransition,
  createReleaseMigrationTransition,
  managedInPlaceTargetManifest,
  ManagedInPlaceTransitionType,
} from "@reviewrouter/features-release-rollout";

const resource = "dpg-da32ipmk1f9s73dttm90-a";
const transition = createManagedInPlaceTransition({
  commitSha: "a".repeat(40),
  releaseImageDigest: `sha256:${"b".repeat(64)}`,
  providerDatabaseResourceId: resource,
});
const topology = {
  providerDatabaseResourceId: resource,
  systemIdentifier: "7482837671845777452",
  databaseOid: "16385",
  databaseName: "review_router_dimy",
  recoveryWitnessSha256: "c".repeat(64),
};
const claim = {
  operationId: "11111111-2222-3333-4444-555555555555",
  transition: JSON.parse(JSON.stringify(transition)),
  admissionIdentityDigest: `sha256:${"d".repeat(64)}`,
  externalFenceSha256: `sha256:${"e".repeat(64)}`,
  terminalCatalogDigest: `sha256:${"f".repeat(64)}`,
  generation: 2,
  nonce: "0".repeat(32),
  source: { ...topology },
  target: { ...topology },
};

describe("managed in-place transport", () => {
  it("accepts one database named identically on both sides", () => {
    expect(managedInPlaceClaimRequest(claim)).toMatchObject({
      operationId: claim.operationId,
      source: topology,
      target: topology,
    });
  });

  it("refuses two databases, a relocation payload and a missing discriminator", () => {
    expect(() =>
      managedInPlaceClaimRequest({
        ...claim,
        target: { ...topology, systemIdentifier: "9482837671845777452" },
      }),
    ).toThrow();
    const relocation = JSON.parse(
      JSON.stringify(
        createReleaseMigrationTransition({
          commitSha: "a".repeat(40),
          releaseImageDigest: `sha256:${"b".repeat(64)}`,
        }),
      ),
    );
    expect(() =>
      managedInPlaceClaimRequest({ ...claim, transition: relocation }),
    ).toThrow();
    const untyped = { ...claim.transition };
    delete untyped.transitionType;
    expect(() =>
      managedInPlaceClaimRequest({ ...claim, transition: untyped }),
    ).toThrow();
    expect(() =>
      managedInPlaceClaimRequest({ ...claim, generation: 0 }),
    ).toThrow();
    expect(() =>
      managedInPlaceClaimRequest({ ...claim, nonce: "zz" }),
    ).toThrow();
    // An unexpected extra key is a different request, not a tolerated one.
    expect(() =>
      managedInPlaceClaimRequest({ ...claim, replay: true }),
    ).toThrow();
  });

  it("leaves the relocation claim parser rejecting equal identifiers", () => {
    const relocationClaim = {
      rolloutId: "rollout-1",
      expectedCommitSha: "a".repeat(40),
      runId: "123",
      runAttempt: 1,
      sourceSystemIdentifier: topology.systemIdentifier,
      targetSystemIdentifier: topology.systemIdentifier,
      targetRecoveryWitnessSha256: "c".repeat(64),
      migrationTransition: JSON.parse(
        JSON.stringify(
          createReleaseMigrationTransition({
            commitSha: "a".repeat(40),
            releaseImageDigest: `sha256:${"b".repeat(64)}`,
          }),
        ),
      ),
    };
    expect(() => rolloutClaimRequest(relocationClaim)).toThrow();
    expect(() =>
      rolloutClaimRequest({
        ...relocationClaim,
        targetSystemIdentifier: "9482837671845777452",
      }),
    ).not.toThrow();
    // And the in-place parser refuses the relocation shape outright.
    expect(() => managedInPlaceClaimRequest(relocationClaim)).toThrow();
  });

  it("validates permits and effect receipts against the same typed contract", () => {
    const permit = {
      transitionType: ManagedInPlaceTransitionType,
      schemaVersion: 1,
      operationId: claim.operationId,
      transitionSha256: transition.transitionSha256,
      admissionIdentityDigest: claim.admissionIdentityDigest,
      topology: { ...topology },
      externalFenceSha256: claim.externalFenceSha256,
      terminalCatalogDigest: claim.terminalCatalogDigest,
      generation: 2,
      epoch: 1,
      nonce: claim.nonce,
      state: "open",
    };
    expect(managedInPlacePermitRequest(permit)).toMatchObject({ epoch: 1 });
    for (const change of [
      { transitionType: "release-migration/v1" },
      { epoch: 0 },
      { state: "quarantined" },
      { nonce: "zz" },
    ])
      expect(() =>
        managedInPlacePermitRequest({ ...permit, ...change }),
      ).toThrow();

    const receipt = {
      transitionType: ManagedInPlaceTransitionType,
      operationId: claim.operationId,
      generation: 2,
      epoch: 1,
      nonce: claim.nonce,
      ledgerManifest: managedInPlaceTargetManifest,
      terminalCatalogDigest: claim.terminalCatalogDigest,
      effectFingerprint: `sha256:${"1".repeat(64)}`,
      permitState: "terminal",
    };
    expect(managedInPlaceEffectReceiptRequest(receipt)).toMatchObject({
      permitState: "terminal",
    });
    for (const change of [
      { ledgerManifest: `sha256:${"0".repeat(64)}` },
      { permitState: "open" },
      { effectFingerprint: "not-a-digest" },
    ])
      expect(() =>
        managedInPlaceEffectReceiptRequest({ ...receipt, ...change }),
      ).toThrow();
  });
});
