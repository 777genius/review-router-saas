import {
  ProducerDistributionKind,
  ReviewMutationLaneKind,
  ReviewMutationMode,
  ReviewProtocolVersion,
  ReviewRunAuthorizationState,
  REVIEW_RUN_AUTHORIZATION_TOKEN_ISSUER,
  ReviewRunAuthorizationTokenAudience,
  ReviewSafetyCapability,
  ReviewSafetyDecisionKind,
  ReviewSafetyPolicyScope,
  ReviewSafetyRolloutMode,
  ReviewTrustDomain,
} from "../domain/review-run-control-types.js";
import { requiredCapabilitiesForDecision } from "../domain/review-safety-policy.js";

export const reviewRunControlContractDescriptor = Object.freeze({
  contractVersion: 1,
  boundedContext: "review_run_control",
  protocolVersions: Object.freeze([ReviewProtocolVersion.V2]),
  actionOperations: Object.freeze([
    "authorize_review_run",
    "renew_review_run_authorization",
    "expire_or_revoke_review_run_authorization",
  ]),
  administrativeOperations: Object.freeze([
    "resolve_or_register_scm_repository_identity",
    "bind_scm_repository_identity",
    "unbind_scm_repository_identity",
    "initialize_review_mutation_authority",
    "register_review_protocol_limits_profile",
    "register_review_operational_slo_profile",
    "register_producer_release",
    "revoke_producer_release",
    "begin_review_mutation_drain",
    "abort_review_mutation_drain",
    "activate_review_mutation_epoch",
    "pause_review_mutation",
    "resume_review_mutation_epoch",
    "update_review_safety_policy",
    "set_review_safety_emergency_stop",
  ]),
  producerDistributionKinds: Object.freeze([
    ProducerDistributionKind.HostedComposite,
    ProducerDistributionKind.PublicReusable,
  ]),
  mutationLaneKinds: Object.freeze([
    ReviewMutationLaneKind.HostedReviewRouterApp,
  ]),
  mutationModes: Object.freeze([
    ReviewMutationMode.V1Open,
    ReviewMutationMode.V1Draining,
    ReviewMutationMode.V2Active,
    ReviewMutationMode.Paused,
  ]),
  authorizationStates: Object.freeze([
    ReviewRunAuthorizationState.Active,
    ReviewRunAuthorizationState.Expired,
    ReviewRunAuthorizationState.Revoked,
  ]),
  trustDomains: Object.freeze([
    ReviewTrustDomain.TrustedManaged,
    ReviewTrustDomain.TrustedLocal,
    ReviewTrustDomain.UntrustedContribution,
  ]),
  policyScopes: Object.freeze([
    ReviewSafetyPolicyScope.Global,
    ReviewSafetyPolicyScope.Workspace,
    ReviewSafetyPolicyScope.Repository,
  ]),
  rolloutModes: Object.freeze([
    ReviewSafetyRolloutMode.Disabled,
    ReviewSafetyRolloutMode.Shadow,
    ReviewSafetyRolloutMode.Allowlisted,
    ReviewSafetyRolloutMode.Enabled,
  ]),
  capabilities: Object.freeze([
    ReviewSafetyCapability.RunAuthorizationV2,
    ReviewSafetyCapability.ReviewInvestigationV1,
    ReviewSafetyCapability.EvidenceWritesV2,
    ReviewSafetyCapability.EvidenceReuseV2,
    ReviewSafetyCapability.PromptOnlyReuse,
    ReviewSafetyCapability.ContextGatewayReuse,
    ReviewSafetyCapability.PublicationOperationsV2,
    ReviewSafetyCapability.MutationEpochV2,
  ]),
  decisionRequirements: Object.freeze(
    Object.fromEntries(
      Object.values(ReviewSafetyDecisionKind).map((decisionKind) => [
        decisionKind,
        Object.freeze([...requiredCapabilitiesForDecision(decisionKind)]),
      ]),
    ),
  ),
  defaults: Object.freeze({
    capabilityMode: ReviewSafetyRolloutMode.Disabled,
    missingGlobalEmergencyControlStopsEffects: true,
    behaviorIntegratedWithRuntime: false,
  }),
  wireRepresentations: Object.freeze({
    mutationEpoch: "unsigned_decimal_string",
  }),
  authorizationCapability: Object.freeze({
    issuer: REVIEW_RUN_AUTHORIZATION_TOKEN_ISSUER,
    audience: ReviewRunAuthorizationTokenAudience.ReviewRun,
    kind: "run_authorization",
    mutationEpoch: "unsigned_decimal_string",
  }),
});

export const reviewRunControlActionContractFragment = Object.freeze({
  fragmentVersion: 1,
  boundedContext: "review_run_control",
  publishedEnums: Object.freeze([
    Object.freeze({
      typeName: "ReviewRunAuthorizationResultStatus",
      values: Object.freeze(["authorized", "restored", "renewed", "denied"]),
    }),
  ]),
  operations: Object.freeze([
    Object.freeze({
      operationId: "review_run_authorize",
      requestTypeName: "ReviewRunAuthorizeRequest",
      resultTypeName: "ReviewRunAuthorizeResult",
      callerAuthority: "fresh_scm_oidc",
      mutability: "authorization",
      naturalIdempotencyPreimage: Object.freeze([
        "oidc_replay_key_hash",
        "protocol_offer_hash",
      ]),
      semanticRetryClass: "same_request",
      requestFields: Object.freeze([]),
      resultStatusEnum: "ReviewRunAuthorizationResultStatus",
      resultFields: Object.freeze([
        Object.freeze({ name: "authorizationId", type: "identifier" }),
        Object.freeze({ name: "authorizationToken", type: "token" }),
        Object.freeze({ name: "producerReleaseId", type: "identifier" }),
        Object.freeze({ name: "protocolLimitsProfileId", type: "identifier" }),
        Object.freeze({ name: "operationalSloProfileId", type: "identifier" }),
        Object.freeze({ name: "mutationEpoch", type: "decimal" }),
        Object.freeze({ name: "expiresAt", type: "timestamp" }),
        Object.freeze({
          name: "authorizationFactsCanonicalJson",
          type: "canonical_json",
        }),
        Object.freeze({
          name: "protocolLimitsCanonicalJson",
          type: "canonical_json",
        }),
      ]),
    }),
    Object.freeze({
      operationId: "review_run_renew",
      requestTypeName: "ReviewRunRenewRequest",
      resultTypeName: "ReviewRunRenewResult",
      callerAuthority: "current_authorization_and_fresh_same_run_oidc",
      mutability: "command",
      naturalIdempotencyPreimage: Object.freeze([
        "authorization_id",
        "renewal_request_id",
        "renewal_replay_key_hash",
      ]),
      semanticRetryClass: "same_request",
      requestFields: Object.freeze([
        Object.freeze({ name: "authorizationId", type: "identifier" }),
        Object.freeze({ name: "renewalRequestId", type: "identifier" }),
        Object.freeze({ name: "oidcToken", type: "token" }),
        Object.freeze({ name: "requestedTtlMs", type: "positive_integer" }),
      ]),
      resultStatusEnum: "ReviewRunAuthorizationResultStatus",
      resultFields: Object.freeze([
        Object.freeze({ name: "authorizationId", type: "identifier" }),
        Object.freeze({ name: "authorizationToken", type: "token" }),
        Object.freeze({ name: "mutationEpoch", type: "decimal" }),
        Object.freeze({ name: "expiresAt", type: "timestamp" }),
      ]),
    }),
  ]),
});
