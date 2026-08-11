import { describe, expect, it } from "vitest";
import {
  assertProviderSecretAuthorizationUnexpired,
  assertProviderSecretTransitionAuthorized,
  assertExternalRecoveryWitnessAdmission,
  classifyExternalRecoveryWitnessRelation,
  ExternalRecoveryWitnessRelation,
  fingerprintDatabaseRecoveryWitness,
  isRuntimeVersionedDurableMarker,
  RuntimeVersionedDurableMarker,
} from "../domain/provider-secret-transition-policy.js";

const now = new Date("2026-08-10T00:00:00.000Z");
const valid = {
  expectedOwner: "runtime" as const,
  expectedOwnerId: "lease:1",
  expectedEpoch: 7n,
  actualFence: {
    owner: "runtime" as const,
    ownerId: "lease:1",
    epoch: 7n,
  },
  authorizationExpiresAt: new Date(now.getTime() + 1),
  now,
};

describe("provider secret transition policy", () => {
  it("rejects a deadline at equality without requiring an adapter fence", () => {
    const deadline = new Date("2026-08-10T12:00:00.000Z");
    expect(() =>
      assertProviderSecretAuthorizationUnexpired({
        authorizationExpiresAt: deadline,
        now: deadline,
      }),
    ).toThrow("provider_secret_transition_authorization_expired");
  });
  it("admits only the exact live owner and epoch", () => {
    expect(() => assertProviderSecretTransitionAuthorized(valid)).not.toThrow();
    for (const actualFence of [
      { ...valid.actualFence, ownerId: "lease:stale" },
      { ...valid.actualFence, epoch: 8n },
      { ...valid.actualFence, owner: "recovery" as const },
    ]) {
      expect(() =>
        assertProviderSecretTransitionAuthorized({ ...valid, actualFence }),
      ).toThrow("provider_secret_transition_fence_stale");
    }
  });

  it("rejects equality at the deadline", () => {
    expect(() =>
      assertProviderSecretTransitionAuthorized({
        ...valid,
        authorizationExpiresAt: now,
      }),
    ).toThrow("provider_secret_transition_authorization_expired");
  });

  it("recognizes every strict runtime durable marker without fallbacks", () => {
    for (const marker of Object.values(RuntimeVersionedDurableMarker)) {
      expect(isRuntimeVersionedDurableMarker(marker)).toBe(true);
    }
    expect(isRuntimeVersionedDurableMarker("runtime_versioned_future")).toBe(
      false,
    );
  });

  it("requires a high-entropy external recovery witness", () => {
    expect(fingerprintDatabaseRecoveryWitness("x".repeat(43))).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(() => fingerprintDatabaseRecoveryWitness("short")).toThrow(
      "codex_rotating_database_recovery_witness_unproven",
    );
  });

  it("fails automatic runtime closed across a witness rotation", () => {
    const relation = classifyExternalRecoveryWitnessRelation({
      persistedFingerprint: "a".repeat(64),
      currentFingerprint: "b".repeat(64),
    });
    expect(relation).toBe(ExternalRecoveryWitnessRelation.Mismatched);
    expect(() =>
      assertExternalRecoveryWitnessAdmission({
        transition: "automatic_runtime",
        relation,
      }),
    ).toThrow("codex_rotating_database_recovery_witness_mismatch");
  });

  it("admits a witness rotation only through forced operator recovery", () => {
    expect(() =>
      assertExternalRecoveryWitnessAdmission({
        transition: "forced_operator_recovery",
        relation: ExternalRecoveryWitnessRelation.Mismatched,
      }),
    ).not.toThrow();
  });
});
