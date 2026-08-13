import { describe, expect, it } from "vitest";
import {
  fingerprintRuntimeRecoveryWitness,
  runtimeGenerationWitnessReplacement,
} from "./runtime-generation-witness";

describe("runtime generation witness", () => {
  it("stages only a witness whose fingerprint matches W2", () => {
    const witness = "w".repeat(43);
    const expectedSha256 = fingerprintRuntimeRecoveryWitness(witness);
    expect(
      runtimeGenerationWitnessReplacement({ witness, expectedSha256 }),
    ).toEqual({
      REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: witness,
      REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256: expectedSha256,
    });
  });

  it("fails closed without exposing a mismatched witness", () => {
    expect(() =>
      runtimeGenerationWitnessReplacement({
        witness: "secret-witness-value-that-must-never-appear-000000",
        expectedSha256: "a".repeat(64),
      }),
    ).toThrow("runtime_recovery_witness_binding_mismatch");
  });
});
