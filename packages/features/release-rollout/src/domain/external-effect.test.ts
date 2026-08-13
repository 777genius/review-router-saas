import { describe, expect, it } from "vitest";
import {
  classifyExternalEffectDiscovery,
  mayDispatchProviderPost,
} from "./external-effect";

describe("external effect domain invariants", () => {
  it("requires an owner-bound monotonic epoch permit for provider POST", () => {
    const record = {
      state: "dispatching" as const,
      ownerId: "controller-a",
      epoch: 7,
      providerId: null,
      safeForCompensation: false,
    };
    expect(
      mayDispatchProviderPost({
        record,
        permitOwnerId: "controller-a",
        permitEpoch: 7,
      }),
    ).toBe(true);
    expect(
      mayDispatchProviderPost({
        record,
        permitOwnerId: "controller-b",
        permitEpoch: 7,
      }),
    ).toBe(false);
    expect(
      mayDispatchProviderPost({
        record,
        permitOwnerId: "controller-a",
        permitEpoch: 6,
      }),
    ).toBe(false);
  });

  it.each([
    [
      "duplicates",
      { matchingProviderIds: ["job-a", "job-b"], timedOut: false },
      "duplicate",
    ],
    ["cleanup timeout", { matchingProviderIds: [], timedOut: true }, "timeout"],
    [
      "legacy unresolved",
      { matchingProviderIds: [], timedOut: false, legacyUnresolved: true },
      "unresolved_legacy",
    ],
  ] as const)("classifies %s as unsafe and blocked", (_name, input, reason) => {
    expect(classifyExternalEffectDiscovery(input)).toEqual({
      result: "blocked",
      safeForCompensation: false,
      reason,
    });
  });

  it("keeps an unresolved discovery pending and unsafe", () => {
    expect(
      classifyExternalEffectDiscovery({
        matchingProviderIds: [],
        timedOut: false,
      }),
    ).toEqual({ result: "pending", safeForCompensation: false });
  });
});
