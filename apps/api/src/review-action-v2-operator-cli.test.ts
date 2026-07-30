import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ReviewSafetyCapability,
  ReviewSafetyRolloutMode,
} from "@reviewrouter/features-review-run-control";
import {
  inspectEnvironment,
  parseArguments,
  reviewV2CohortEmergencyInitialization,
  reviewV2CohortOperationForCommand,
  reviewV2CohortRolloutModes,
  reviewV2GlobalEmergencyTransitionForCommand,
  serializeOperatorCliJson,
} from "./review-action-v2-operator-cli";

describe("review action v2 operator CLI", () => {
  it("parses commands and exact confirmation values without interpreting them", () => {
    expect(
      parseArguments([
        "mutation",
        "activate",
        "--repo",
        "777genius/agent-teams-ai",
        "--confirm",
        "777genius/agent-teams-ai",
      ]),
    ).toEqual({
      positionals: ["mutation", "activate"],
      options: {
        repo: "777genius/agent-teams-ai",
        confirm: "777genius/agent-teams-ai",
      },
    });
  });

  it("reports only missing or malformed environment variable names", () => {
    const credential = "operator-secret";
    const result = inspectEnvironment({
      DATABASE_URL: "postgresql://example.invalid/reviewrouter",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "private-key",
      REVIEW_ROUTER_ACTION_OIDC_AUDIENCE: "reviewrouter",
      REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_ACTIVE_KEY_ID: "authorization-1",
      REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON: "[]",
      REVIEW_ROUTER_REVIEW_V2_CAPABILITY_ACTIVE_KEY_ID: "capability-1",
      REVIEW_ROUTER_REVIEW_V2_CAPABILITY_KEYS_JSON: "[]",
      REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON: "[]",
      REVIEW_ROUTER_REVIEW_V2_PROVIDER_VOTE_LANES_JSON: "not-json",
      REVIEW_ROUTER_REVIEW_V2_PROJECTION_POLICY_VERSION: "1",
      REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL: credential,
      REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL_SHA256: createHash("sha256")
        .update(credential, "utf8")
        .digest("hex"),
    });

    expect(result).toEqual({
      ready: false,
      missing: [],
      invalid: ["REVIEW_ROUTER_REVIEW_V2_PROVIDER_VOTE_LANES_JSON"],
    });
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it("serializes bigint fencing values as decimal strings", () => {
    expect(
      JSON.parse(
        serializeOperatorCliJson({
          authority: { mutationEpoch: 7n },
          version: 2,
        }),
      ),
    ).toEqual({
      authority: { mutationEpoch: "7" },
      version: 2,
    });
  });

  it("stages only T0 capabilities and promotes context reuse independently", () => {
    const t0Capabilities = [
      ReviewSafetyCapability.RunAuthorizationV2,
      ReviewSafetyCapability.EvidenceWritesV2,
      ReviewSafetyCapability.EvidenceReuseV2,
      ReviewSafetyCapability.PublicationOperationsV2,
      ReviewSafetyCapability.MutationEpochV2,
    ] as const;
    for (const capability of t0Capabilities) {
      expect(reviewV2CohortRolloutModes(capability)).toEqual({
        global: ReviewSafetyRolloutMode.Allowlisted,
        repository: ReviewSafetyRolloutMode.Enabled,
      });
    }

    const deferredCapabilities = [
      ReviewSafetyCapability.PromptOnlyReuse,
      ReviewSafetyCapability.ContextGatewayReuse,
    ] as const;
    for (const capability of deferredCapabilities) {
      expect(reviewV2CohortRolloutModes(capability)).toBeNull();
    }
    for (const capability of t0Capabilities) {
      expect(
        reviewV2CohortRolloutModes(capability, "enable-context-reuse"),
      ).toBeNull();
    }
    expect(
      reviewV2CohortRolloutModes(
        ReviewSafetyCapability.ContextGatewayReuse,
        "shadow-context-reuse",
      ),
    ).toEqual({
      global: ReviewSafetyRolloutMode.Allowlisted,
      repository: ReviewSafetyRolloutMode.Shadow,
    });
    expect(
      reviewV2CohortRolloutModes(
        ReviewSafetyCapability.ContextGatewayReuse,
        "enable-context-reuse",
      ),
    ).toEqual({
      global: ReviewSafetyRolloutMode.Allowlisted,
      repository: ReviewSafetyRolloutMode.Enabled,
    });
    expect(
      reviewV2CohortRolloutModes(
        ReviewSafetyCapability.ContextGatewayReuse,
        "disable-context-reuse",
      ),
    ).toEqual({
      global: null,
      repository: ReviewSafetyRolloutMode.Disabled,
    });
    expect(
      reviewV2CohortRolloutModes(
        ReviewSafetyCapability.PromptOnlyReuse,
        "enable-context-reuse",
      ),
    ).toBeNull();

    expect([...t0Capabilities, ...deferredCapabilities].sort()).toEqual(
      Object.values(ReviewSafetyCapability).sort(),
    );
  });

  it("maps only explicit context reuse rollout commands", () => {
    expect(
      reviewV2CohortOperationForCommand("cohort context-reuse shadow"),
    ).toBe("shadow-context-reuse");
    expect(
      reviewV2CohortOperationForCommand("cohort context-reuse enable"),
    ).toBe("enable-context-reuse");
    expect(
      reviewV2CohortOperationForCommand("cohort context-reuse disable"),
    ).toBe("disable-context-reuse");
    expect(reviewV2CohortOperationForCommand("cohort stage")).toBe("stage-t0");
    expect(
      reviewV2CohortOperationForCommand("cohort context-reuse enabled"),
    ).toBeNull();
  });

  it("initializes missing emergency controls without clearing existing stops", () => {
    expect(reviewV2CohortEmergencyInitialization(null)).toEqual({
      expectedVersion: 0,
      stopped: false,
      reason: "review-v2-cohort-staged",
    });
    expect(
      reviewV2CohortEmergencyInitialization({ stopped: false }),
    ).toBeNull();
    expect(reviewV2CohortEmergencyInitialization({ stopped: true })).toBeNull();
  });

  it("maps only explicit global emergency transitions", () => {
    expect(
      reviewV2GlobalEmergencyTransitionForCommand("emergency global open"),
    ).toEqual({
      stopped: false,
      reason: "review-v2-global-emergency-opened",
    });
    expect(
      reviewV2GlobalEmergencyTransitionForCommand("emergency global stop"),
    ).toEqual({
      stopped: true,
      reason: "review-v2-global-emergency-stopped",
    });
    expect(
      reviewV2GlobalEmergencyTransitionForCommand("emergency repository open"),
    ).toBeNull();
  });
});
