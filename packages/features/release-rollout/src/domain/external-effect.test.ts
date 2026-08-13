import { describe, expect, it } from "vitest";
import {
  assertRunnerProvisioningIntentRecord,
  classifyExternalEffectDiscovery,
  mayDispatchProviderPost,
} from "./external-effect";

const listedIntent = (effect: {
  state: "prepared" | "dispatching" | "bound" | "cleaned";
  ownerId: string;
  epoch: number;
  providerId: string | null;
  safeForCompensation: boolean;
}) => ({
  id: `rri-${"a".repeat(64)}`,
  rolloutId: "rollout-1",
  serviceId: "service-1",
  lifecycle: "role" as const,
  workflowJobId: "123",
  runnerName: "runner-1",
  createdAt: "2026-08-12T00:00:00.000Z",
  startCommandSha256: `sha256:${"b".repeat(64)}`,
  creationLeaseOwner: effect.ownerId,
  creationLeaseExpiresAt:
    effect.state === "prepared" ? "2026-08-12T00:02:00.000Z" : null,
  effect,
});

describe("external effect domain invariants", () => {
  it.each([
    ["prepared", 0, null, false],
    ["dispatching", 1, null, false],
    ["bound", 1, "job-1", false],
    ["cleaned", 1, "job-1", true],
  ] as const)(
    "accepts a valid %s listed intent, including owner retention after its lease",
    (state, epoch, providerId, safeForCompensation) => {
      const intent = listedIntent({
        state,
        ownerId: "controller-a",
        epoch,
        providerId,
        safeForCompensation,
      });
      expect(assertRunnerProvisioningIntentRecord(intent)).toBe(intent);
    },
  );

  it.each([
    ["prepared without an expiry", { creationLeaseExpiresAt: null }],
    [
      "dispatching with a stale expiry",
      { creationLeaseExpiresAt: "2026-08-12T00:02:00.000Z" },
    ],
    ["an owner inconsistent with the effect", { creationLeaseOwner: "other" }],
  ])("rejects %s", (_name, override) => {
    const prepared = listedIntent({
      state: "prepared",
      ownerId: "controller-a",
      epoch: 0,
      providerId: null,
      safeForCompensation: false,
    });
    const intent = {
      ...prepared,
      ...override,
      effect:
        _name === "dispatching with a stale expiry"
          ? { ...prepared.effect, state: "dispatching" as const, epoch: 1 }
          : prepared.effect,
    };
    expect(() => assertRunnerProvisioningIntentRecord(intent)).toThrow(
      "runner_provisioning_intent_lease_invariant_violated",
    );
  });

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
