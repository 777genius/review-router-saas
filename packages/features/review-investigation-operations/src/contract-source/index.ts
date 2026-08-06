import {
  investigationRolloutCapabilities,
  investigationRolloutCapabilityDependencies,
} from "../domain/investigation-rollout-policy";

export const reviewInvestigationRolloutAuthorizationV3Contract = Object.freeze({
  authorizationDescriptorVersion: 3,
  capability: "review_investigation_v1",
  capabilities: investigationRolloutCapabilities,
  dependencies: investigationRolloutCapabilityDependencies,
  extensionContract: Object.freeze({
    extensionId: "review-investigation-shadow.v1",
    requiresCanonicalizerDigest: true,
    requiresSchemaDigest: true,
  }),
});

export const reviewInvestigationRolloutAuthorizationPublishedContract =
  Object.freeze({
    exportName: "reviewInvestigationRolloutAuthorizationV3Contract",
    value: reviewInvestigationRolloutAuthorizationV3Contract,
  });
