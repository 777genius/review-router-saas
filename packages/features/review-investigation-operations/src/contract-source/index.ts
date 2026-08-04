import {
  investigationRolloutCapabilities,
  investigationRolloutCapabilityDependencies,
} from "../domain/investigation-rollout-policy";

export const reviewInvestigationRolloutAuthorizationV2Contract = Object.freeze({
  authorizationDescriptorVersion: 2,
  capability: "review_investigation_v1",
  capabilities: investigationRolloutCapabilities,
  dependencies: investigationRolloutCapabilityDependencies,
});

export const reviewInvestigationRolloutAuthorizationPublishedContract =
  Object.freeze({
    exportName: "reviewInvestigationRolloutAuthorizationV2Contract",
    value: reviewInvestigationRolloutAuthorizationV2Contract,
  });
