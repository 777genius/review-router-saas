import { describe, expect, it } from "vitest";
import {
  ManagedInPlaceReadinessPhase,
  managedInPlaceDatabaseIsReady,
  type ManagedInPlaceCustodyReadiness,
  type TrustedManagedInPlaceIdentity,
} from "./readiness.js";
import {
  managedInPlaceBaselineManifest,
  managedInPlaceTargetManifest,
} from "@reviewrouter/features-release-rollout";

const databaseIdentity = {
  serverIdentity: "7482837671845777452",
  databaseIdentity: "16385",
  databaseName: "review_router_dimy",
};
const trusted: TrustedManagedInPlaceIdentity = {
  operationDatabaseIdentity: databaseIdentity,
  coordinatorRoleName: "reviewrouter",
  custodyOwnerRoleName: "reviewrouter_operation_custody_owner",
  custodyReaderRoleName: "reviewrouter_operation_custody_reader",
  baselineManifestIdentity: managedInPlaceBaselineManifest,
  targetManifestIdentity: managedInPlaceTargetManifest,
};
const readiness: ManagedInPlaceCustodyReadiness = {
  roleName: "reviewrouter",
  custodyOwnerRoleName: "reviewrouter_operation_custody_owner",
  custodyReaderRoleName: "reviewrouter_operation_custody_reader",
  systemIdentifier: "7482837671845777452",
  recoveryWitnessSha256: "c".repeat(64),
  databaseIdentity,
  postgresMajor: 17,
  applicationMigrationManifestIdentity: managedInPlaceBaselineManifest,
  custodyAttested: true,
  custodyOwnerCanLogin: false,
  coordinatorCanAssumeCustodyOwner: false,
  admissionWithdrawn: true,
  fleetQuiesced: true,
  privilegedBackendPresent: false,
  automaticMigrationsDisabled: true,
  externalFenceHeld: true,
  runtimeGateStatus: "closed",
};

describe("managed in-place readiness", () => {
  it("accepts the colocated topology at each phase's own manifest", () => {
    expect(
      managedInPlaceDatabaseIsReady(
        readiness,
        trusted,
        ManagedInPlaceReadinessPhase.BeforeExecution,
      ),
    ).toBe(true);
    expect(
      managedInPlaceDatabaseIsReady(
        {
          ...readiness,
          applicationMigrationManifestIdentity: managedInPlaceTargetManifest,
        },
        trusted,
        ManagedInPlaceReadinessPhase.AfterExecution,
      ),
    ).toBe(true);
    // Neither phase accepts the other's manifest, so a partially applied or
    // already-applied state is never "ready" for the wrong step.
    expect(
      managedInPlaceDatabaseIsReady(
        readiness,
        trusted,
        ManagedInPlaceReadinessPhase.AfterExecution,
      ),
    ).toBe(false);
    expect(
      managedInPlaceDatabaseIsReady(
        {
          ...readiness,
          applicationMigrationManifestIdentity: `sha256:${"0".repeat(64)}`,
        },
        trusted,
        ManagedInPlaceReadinessPhase.BeforeExecution,
      ),
    ).toBe(false);
  });

  it("refuses a custody placed on a different database", () => {
    expect(
      managedInPlaceDatabaseIsReady(
        {
          ...readiness,
          databaseIdentity: { ...databaseIdentity, databaseIdentity: "16386" },
        },
        trusted,
        ManagedInPlaceReadinessPhase.BeforeExecution,
      ),
    ).toBe(false);
    expect(
      managedInPlaceDatabaseIsReady(
        readiness,
        {
          ...trusted,
          operationDatabaseIdentity: {
            ...databaseIdentity,
            serverIdentity: "9482837671845777452",
          },
        },
        ManagedInPlaceReadinessPhase.BeforeExecution,
      ),
    ).toBe(false);
  });

  it.each([
    ["missing custody attestation", { custodyAttested: false }],
    ["a custody owner that can log in", { custodyOwnerCanLogin: true }],
    [
      "a coordinator that can become the custody owner",
      { coordinatorCanAssumeCustodyOwner: true },
    ],
    ["open admission", { admissionWithdrawn: false }],
    ["a live fleet", { fleetQuiesced: false }],
    ["a privileged concurrent backend", { privilegedBackendPresent: true }],
    ["enabled automatic migrations", { automaticMigrationsDisabled: false }],
    ["a released external fence", { externalFenceHeld: false }],
    ["an open runtime gate", { runtimeGateStatus: "active" }],
    ["a non-PG17 server", { postgresMajor: 16 }],
    ["a foreign coordinator role", { roleName: "reviewrouter_api" }],
    [
      "a custody owner role that is not the reviewed one",
      { custodyOwnerRoleName: "postgres" },
    ],
  ])("refuses %s", (_label, change) => {
    expect(
      managedInPlaceDatabaseIsReady(
        { ...readiness, ...(change as Record<string, unknown>) },
        trusted,
        ManagedInPlaceReadinessPhase.BeforeExecution,
      ),
    ).toBe(false);
  });
});
