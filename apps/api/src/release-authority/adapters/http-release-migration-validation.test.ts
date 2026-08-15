import { describe, expect, it } from "vitest";
import { createReleaseMigrationTransition } from "@reviewrouter/features-release-rollout";
import {
  migrationBeginRequest,
  migrationCompleteRequest,
  migrationFailRequest,
  rolloutClaimRequest,
} from "./http";

const rolloutId = "rollout-validation";
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const transition = createReleaseMigrationTransition({
  commitSha: "a".repeat(40),
  releaseImageDigest: digest("b"),
});
const sourceLegacyAmbiguity = {
  inventorySha256:
    "sha256:ee9ab3e1f9d9f0e88e96addb3a20b70a04a166f0d979fd5ce3fc59e1dcdbf55f",
  activeLeaseIds: [],
  fetchedSetupIds: [],
  pendingIntentIds: [],
  intentStatuses: [],
  observations: [
    {
      observedAt: "2026-08-14T12:34:54.000Z",
      inventorySha256:
        "sha256:ee9ab3e1f9d9f0e88e96addb3a20b70a04a166f0d979fd5ce3fc59e1dcdbf55f",
    },
    {
      observedAt: "2026-08-14T12:34:55.000Z",
      inventorySha256:
        "sha256:ee9ab3e1f9d9f0e88e96addb3a20b70a04a166f0d979fd5ce3fc59e1dcdbf55f",
    },
  ],
  stable: true,
} as const;
const claim = () => ({
  rolloutId,
  expectedCommitSha: "a".repeat(40),
  runId: "42",
  runAttempt: 1,
  sourceSystemIdentifier: "7000000000000000001",
  targetSystemIdentifier: "7000000000000000002",
  targetRecoveryWitnessSha256: "c".repeat(64),
  migrationTransition: transition,
});
const begin = () => {
  const binding = { ...claim() };
  Reflect.deleteProperty(binding, "migrationTransition");
  return {
    ...binding,
    transitionSha256: transition.transitionSha256,
    expectedPreviousReceiptSha256: digest("0"),
    sourceLegacyAmbiguity,
  };
};
const permit = () => ({
  schemaVersion: 1,
  rolloutId,
  runId: "42",
  runAttempt: 1,
  targetSystemIdentifier: "7000000000000000002",
  targetRecoveryWitnessSha256: "c".repeat(64),
  transitionSha256: transition.transitionSha256,
  expectedPreviousReceiptSha256: digest("0"),
  sourceLegacyAmbiguity,
  eligibilityCutoff: "2026-08-14T12:34:56.000Z",
  epoch: 1,
  nonce: "d".repeat(32),
});
const receipt = () => ({
  step: "run_release_migration",
  receiptId: `${rolloutId}:run_release_migration:1`,
  observedAt: "2026-08-14T12:34:56.789Z",
  rolloutId,
  expectedCommitSha: "a".repeat(40),
  runId: "42",
  runAttempt: 1,
  sourceSystemIdentifier: "7000000000000000001",
  targetSystemIdentifier: "7000000000000000002",
  observationSha256: digest("1"),
  previousReceiptSha256: digest("0"),
  receiptSha256: digest("2"),
  migrationChecksum: transition.postManifestIdentity,
  transitionSha256: transition.transitionSha256,
  migrationArtifactDigest: transition.migrationArtifactDigest,
  migrationBundleSha256: transition.migrationBundleSha256,
  preManifestIdentity: transition.preManifestIdentity,
  postManifestIdentity: transition.postManifestIdentity,
  postCatalogDigest: transition.postCatalogDigest,
  permitEpoch: 1,
  permitNonce: "d".repeat(32),
  targetMigrationReceiptSha256: digest("3"),
  targetMigrationEffectFingerprint: digest("4"),
});

const without = (value: Record<string, unknown>, key: string) => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};
const rejects = (operation: () => unknown) =>
  expect(operation).toThrow("release_migration_request_invalid");

describe("release migration HTTP DTO validation", () => {
  it("accepts only the exact claim shape and rejects malformed identity fields", () => {
    expect(rolloutClaimRequest(claim())).toMatchObject({ rolloutId });
    rejects(() => rolloutClaimRequest({ ...claim(), unexpected: true }));
    rejects(() => rolloutClaimRequest(without(claim(), "runId")));
    rejects(() => rolloutClaimRequest({ ...claim(), runAttempt: "1" }));
    rejects(() => rolloutClaimRequest({ ...claim(), rolloutId: "bad id" }));
    rejects(() =>
      rolloutClaimRequest({ ...claim(), expectedCommitSha: "a".repeat(39) }),
    );
  });

  it("rejects unknown, missing, wrongly typed, malformed, and route-mismatched begin fields", () => {
    const valid = begin();
    expect(migrationBeginRequest(valid, rolloutId)).toMatchObject({
      rolloutId,
    });
    rejects(() =>
      migrationBeginRequest({ ...valid, unexpected: true }, rolloutId),
    );
    rejects(() => migrationBeginRequest(without(valid, "runId"), rolloutId));
    rejects(() =>
      migrationBeginRequest({ ...valid, runAttempt: "1" }, rolloutId),
    );
    rejects(() =>
      migrationBeginRequest(
        { ...valid, transitionSha256: digest("G") },
        rolloutId,
      ),
    );
    rejects(() =>
      migrationBeginRequest(
        {
          ...valid,
          sourceLegacyAmbiguity: {
            ...sourceLegacyAmbiguity,
            inventorySha256: digest("0"),
          },
        },
        rolloutId,
      ),
    );
    rejects(() =>
      migrationBeginRequest(
        {
          ...valid,
          sourceLegacyAmbiguity: {
            ...sourceLegacyAmbiguity,
            unexpected: true,
          },
        },
        rolloutId,
      ),
    );
    rejects(() => migrationBeginRequest(valid, "different-rollout"));
  });

  it("validates nested completion DTOs exactly, including timestamps and route binding", () => {
    const valid = { permit: permit(), receipt: receipt() };
    expect(migrationCompleteRequest(valid, rolloutId).permit.rolloutId).toBe(
      rolloutId,
    );
    rejects(() =>
      migrationCompleteRequest({ ...valid, unexpected: true }, rolloutId),
    );
    rejects(() =>
      migrationCompleteRequest(without(valid, "receipt"), rolloutId),
    );
    rejects(() =>
      migrationCompleteRequest(
        { ...valid, permit: { ...valid.permit, epoch: "1" } },
        rolloutId,
      ),
    );
    rejects(() =>
      migrationCompleteRequest(
        {
          ...valid,
          permit: { ...valid.permit, eligibilityCutoff: "2026-08-14" },
        },
        rolloutId,
      ),
    );
    rejects(() =>
      migrationCompleteRequest(
        { ...valid, receipt: { ...valid.receipt, observedAt: "2026-08-14" } },
        rolloutId,
      ),
    );
    rejects(() =>
      migrationCompleteRequest(
        {
          ...valid,
          receipt: {
            ...valid.receipt,
            targetMigrationReceiptSha256: "self-declared",
          },
        },
        rolloutId,
      ),
    );
    rejects(() => migrationCompleteRequest(valid, "different-rollout"));
  });

  it("validates failure DTOs exactly and binds the permit rollout to the route", () => {
    const valid = { permit: permit(), reasonSha256: digest("e") };
    expect(migrationFailRequest(valid, rolloutId).reasonSha256).toBe(
      digest("e"),
    );
    rejects(() =>
      migrationFailRequest({ ...valid, unexpected: true }, rolloutId),
    );
    rejects(() =>
      migrationFailRequest(without(valid, "reasonSha256"), rolloutId),
    );
    rejects(() =>
      migrationFailRequest({ ...valid, reasonSha256: 1 }, rolloutId),
    );
    rejects(() =>
      migrationFailRequest({ ...valid, reasonSha256: digest("X") }, rolloutId),
    );
    rejects(() => migrationFailRequest(valid, "different-rollout"));
  });
});
