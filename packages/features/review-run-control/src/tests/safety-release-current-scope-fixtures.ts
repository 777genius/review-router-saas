import type { ProducerRelease } from "../domain/producer-release";
import type { ReviewSafetyScope } from "../domain/review-safety-policy";
import {
  ProducerReleaseState,
  ReviewProviderKind,
  ReviewSafetyCapability,
  ReviewSafetyRolloutMode,
  ReviewTaskKind,
} from "../domain/review-run-control-types";
import {
  limits,
  limitsDigest,
  releaseCandidate,
  sloDigest,
  sloThresholds,
} from "./fixtures";

export const registeredAt = new Date("2026-09-08T00:00:00Z");
export const limitsProfile = {
  ...limits,
  limitsDigest,
  protocolLimitsProfileId: "r123-limits",
  registeredAt,
};
export const sloProfile = {
  ...sloThresholds,
  sloDigest,
  operationalSloProfileId: "r123-slo",
  ownerRefs: ["team-reviewrouter"],
  runbookRefs: ["runbook/review-v2"],
  registeredAt,
};
export function releaseFixture(id: string): ProducerRelease {
  return {
    ...releaseCandidate,
    producerReleaseId: id,
    runtimeCommitSha: id.replaceAll("-", "").padEnd(40, "a").slice(0, 40),
    protocolLimitsProfileId: limitsProfile.protocolLimitsProfileId,
    operationalSloProfileId: sloProfile.operationalSloProfileId,
    contextGatewayPolicyVersion: null,
    contextGatewayEntrypointDigest: null,
    reviewInvestigationProfile: null,
    state: ProducerReleaseState.Registered,
    registeredAt,
    revokedAt: null,
  };
}
export function policyFixture(
  scope: ReviewSafetyScope,
  id: string,
  selectors = true,
) {
  return {
    policyId: id,
    scope,
    capability: ReviewSafetyCapability.RunAuthorizationV2,
    version: 1,
    rolloutMode: ReviewSafetyRolloutMode.Allowlisted,
    providerTaskSelectors: selectors
      ? [
          {
            providerKind: ReviewProviderKind.Codex,
            taskKind: ReviewTaskKind.CodeReview,
          },
        ]
      : [],
    updatedBy: "r123",
    updatedAt: registeredAt,
  };
}
export function emergencyFixture(scope: ReviewSafetyScope, id: string) {
  return {
    emergencyControlId: id,
    scope,
    version: 1,
    stopped: true,
    reason: "r123-stop",
    updatedBy: "r123",
    updatedAt: registeredAt,
  };
}
