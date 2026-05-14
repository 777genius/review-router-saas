import { describe, expect, it } from "vitest";
import { ActionControlPlanePrStateValidator } from "../infrastructure/action-control-plane-pr-state-validator.js";

const config = {
  protocolVersion: 1,
  reviewKind: "conflict-head",
  dispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
  pullRequestNumber: 7,
  headSha: "a".repeat(40),
  baseRef: "main",
  baseSha: "b".repeat(40),
  checkout: {
    mode: "exact_head_sha",
    headSha: "a".repeat(40),
    baseRef: "main",
    baseSha: "b".repeat(40),
    persistCredentials: false,
  },
  diff: {
    mode: "expected_base_to_head",
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    maxFiles: 10,
    maxBytes: 1024,
    maxPatchBytesPerFile: 512,
  },
  posting: {
    mode: "disabled",
    reason: "posting_proxy_not_enabled",
  },
} as const;

describe("ActionControlPlanePrStateValidator", () => {
  it("re-fetches conflict config for every runtime validation phase", async () => {
    const calls: string[] = [];
    const validator = new ActionControlPlanePrStateValidator({
      sessionToken: "session-token",
      configClient: {
        async fetchConflictRuntimeConfig(input) {
          calls.push(input.sessionToken);
          return {
            runtimeConfig: {} as never,
            conflictReview: config,
          };
        },
      },
    });

    await validator.assertCurrentPrState({
      phase: "before_checkout",
      config,
    });
    await validator.assertCurrentPrState({
      phase: "before_status",
      config,
      manifestHash: "c".repeat(64),
    });

    expect(calls).toEqual(["session-token", "session-token"]);
  });

  it("fails closed when the control plane reports a stale head", async () => {
    const validator = new ActionControlPlanePrStateValidator({
      sessionToken: "session-token",
      configClient: {
        async fetchConflictRuntimeConfig() {
          return {
            runtimeConfig: {} as never,
            conflictReview: {
              ...config,
              headSha: "c".repeat(40),
            },
          };
        },
      },
    });

    await expect(
      validator.assertCurrentPrState({
        phase: "before_checkout",
        config,
      }),
    ).rejects.toThrow("conflict_runtime_pr_state_stale:headSha");
  });
});
