import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ReviewSafetyCapability,
  ReviewSafetyRolloutMode,
} from "@reviewrouter/features-review-run-control";
import {
  inspectEnvironment,
  parseArguments,
  reviewV2CohortRolloutModes,
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

  it("stages only T0 capabilities and keeps deferred reuse disabled", () => {
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
      expect(reviewV2CohortRolloutModes(capability)).toEqual({
        global: ReviewSafetyRolloutMode.Disabled,
        repository: ReviewSafetyRolloutMode.Disabled,
      });
    }

    expect([...t0Capabilities, ...deferredCapabilities].sort()).toEqual(
      Object.values(ReviewSafetyCapability).sort(),
    );
  });
});
