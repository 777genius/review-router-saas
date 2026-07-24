import {
  stableJson,
  type CanonicalJsonValue,
} from "./provider-invocation-manifest";
import type {
  ReviewReuseCompatibilityPolicy,
  ReviewReuseSafetyDecision,
} from "./review-reuse-eligibility";
import type { ReviewProviderKind } from "./review-evidence-primitives";

export const reviewContextReusePolicyVectorVersion = 1;

export type ReviewContextReusePolicyVector = Readonly<{
  safetyDecision: ReviewReuseSafetyDecision;
  compatibility: ReviewReuseCompatibilityPolicy;
  eligibilityPolicyVersion: string;
  gatewayPolicyVersion: string;
  gatewayBinaryHash: string;
  trustedCapabilityProfile: string;
  producerReleaseId: string;
  providerKind: ReviewProviderKind;
  requestedModel: string;
  actualModel: string;
}>;

export function canonicalizeReviewContextReusePolicyVector(
  vector: ReviewContextReusePolicyVector,
): string {
  return stableJson({
    vectorVersion: reviewContextReusePolicyVectorVersion,
    safetyDecision: vector.safetyDecision,
    compatibility: vector.compatibility,
    eligibilityPolicyVersion: vector.eligibilityPolicyVersion,
    gatewayPolicyVersion: vector.gatewayPolicyVersion,
    gatewayBinaryHash: vector.gatewayBinaryHash,
    trustedCapabilityProfile: vector.trustedCapabilityProfile,
    producerReleaseId: vector.producerReleaseId,
    providerKind: vector.providerKind,
    requestedModel: vector.requestedModel,
    actualModel: vector.actualModel,
  } as CanonicalJsonValue);
}
