import { describe, expect, it } from "vitest";
import {
  assertCanonicalCodexRotatingProviderId,
  canonicalCodexRotatingProviderId,
  parseCodexRotatingMutationEpoch,
} from "../index";

describe("rotating provider identity and mutation fence", () => {
  it("derives the sole provider identity from the GitHub repository id", () => {
    expect(canonicalCodexRotatingProviderId("123456")).toBe(
      "codex-rotating:123456",
    );
    expect(() => canonicalCodexRotatingProviderId("owner/repo")).toThrow();
    expect(() =>
      assertCanonicalCodexRotatingProviderId({
        providerInstanceId: "codex-rotating:654321",
        githubRepositoryId: "123456",
      }),
    ).toThrow("codex_rotating_provider_identity_mismatch");
  });

  it("accepts only positive mutation epochs", () => {
    expect(parseCodexRotatingMutationEpoch(1n)).toBe(1n);
    expect(() => parseCodexRotatingMutationEpoch(0n)).toThrow(
      "codex_rotating_mutation_epoch_invalid",
    );
  });
});
