import { describe, expect, it } from "vitest";
import { verifyRuntimeGenerationWitness } from "./verify-runtime-generation-witness.mjs";
import { createHash } from "node:crypto";

const witness = "w".repeat(43);
const fingerprint = createHash("sha256").update(witness).digest("hex");

describe("runtime generation witness boot gate", () => {
  it("accepts only the exact W2 tuple", () => {
    expect(
      verifyRuntimeGenerationWitness({
        REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: witness,
        REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256: fingerprint,
      }),
    ).toBe(fingerprint);
  });

  it.each([
    {},
    {
      REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: "x".repeat(43),
      REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256: fingerprint,
    },
    {
      REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: witness,
      REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256: "a".repeat(64),
    },
  ])("rejects an absent or stale W1 tuple without logging it", (env) => {
    expect(() => verifyRuntimeGenerationWitness(env)).toThrow(
      /runtime_generation_witness_/u,
    );
  });
});
