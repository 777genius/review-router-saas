import {
  ProviderRequestMessageRole,
  providerInvocationIdentityDomain,
  providerInvocationManifestV1CanonicalizerDescriptor,
  providerInvocationManifestDomain,
  providerInvocationManifestVersion,
  providerRequestEnvelopeVersion,
} from "../domain/provider-invocation-manifest.js";
import {
  ProviderExecutionProfile,
  ReviewProviderKind,
  ReviewTaskKind,
} from "../domain/review-evidence-primitives.js";

export const reviewEvidenceContractDescriptor = Object.freeze({
  contractVersion: 1,
  providerRequestEnvelopeVersion,
  providerInvocationManifestVersion,
  providerInvocationManifestDomain,
  providerInvocationIdentityDomain,
  providerKinds: Object.freeze([
    ReviewProviderKind.Codex,
    ReviewProviderKind.ClaudeCode,
    ReviewProviderKind.OpenRouter,
  ]),
  taskKinds: Object.freeze([
    ReviewTaskKind.FindingDiscovery,
    ReviewTaskKind.LifecycleRevalidation,
  ]),
  executionProfiles: Object.freeze([
    ProviderExecutionProfile.PromptOnlyEnvelopeV1,
    ProviderExecutionProfile.AgenticUnboundedV1,
    ProviderExecutionProfile.ContextGatewayV1,
  ]),
  requestMessageRoles: Object.freeze([
    ProviderRequestMessageRole.System,
    ProviderRequestMessageRole.Developer,
    ProviderRequestMessageRole.User,
    ProviderRequestMessageRole.Assistant,
    ProviderRequestMessageRole.Tool,
  ]),
});

export const reviewEvidenceActionContractFragment = Object.freeze({
  fragmentVersion: 1,
  boundedContext: "review_evidence",
  publishedCanonicalizers: Object.freeze([
    providerInvocationManifestV1CanonicalizerDescriptor,
  ]),
  publishedEnums: Object.freeze([
    Object.freeze({
      typeName: "ReviewEvidenceLookupResultStatus",
      values: Object.freeze(["hit", "shadow", "miss", "replay_required"]),
    }),
    Object.freeze({
      typeName: "ReviewEvidenceCommitResultStatus",
      values: Object.freeze(["accepted", "idempotent", "rejected", "conflict"]),
    }),
  ]),
  operations: Object.freeze([
    Object.freeze({
      operationId: "review_evidence_lookup",
      requestTypeName: "ReviewEvidenceLookupRequest",
      resultTypeName: "ReviewEvidenceLookupResult",
      callerAuthority: "run_authorization",
      mutability: "read",
      naturalIdempotencyPreimage: Object.freeze([
        "execution_id",
        "work_slot_id",
        "provider_invocation_key",
      ]),
      semanticRetryClass: "read_only",
      requestFields: Object.freeze([
        Object.freeze({ name: "executionId", type: "identifier" }),
        Object.freeze({ name: "workSlotId", type: "identifier" }),
        Object.freeze({ name: "planHash", type: "hash" }),
        Object.freeze({
          name: "manifestCanonicalJson",
          type: "canonical_json",
        }),
        Object.freeze({ name: "manifestKey", type: "hash" }),
        Object.freeze({ name: "providerInvocationKey", type: "hash" }),
        Object.freeze({ name: "providerVoteIdentityHash", type: "hash" }),
      ]),
      resultStatusEnum: "ReviewEvidenceLookupResultStatus",
      resultFields: Object.freeze([
        Object.freeze({ name: "observationId", type: "nullable_identifier" }),
        Object.freeze({ name: "payloadHash", type: "nullable_hash" }),
        Object.freeze({
          name: "payloadCanonicalJson",
          type: "nullable_canonical_json",
        }),
        Object.freeze({
          name: "byteCount",
          type: "nullable_positive_integer",
        }),
        Object.freeze({
          name: "findingCount",
          type: "nullable_non_negative_integer",
        }),
        Object.freeze({ name: "actualModel", type: "nullable_string" }),
        Object.freeze({ name: "qualityFlags", type: "identifier_array" }),
        Object.freeze({
          name: "transportAttemptCount",
          type: "nullable_positive_integer",
        }),
        Object.freeze({
          name: "attachmentCapability",
          type: "nullable_token",
        }),
        Object.freeze({ name: "attachmentKind", type: "nullable_identifier" }),
        Object.freeze({
          name: "reuseSafetyDecisionHash",
          type: "nullable_hash",
        }),
        Object.freeze({
          name: "eligibilityPolicyVersion",
          type: "nullable_identifier",
        }),
        Object.freeze({
          name: "sourceLeaseId",
          type: "nullable_identifier",
        }),
        Object.freeze({
          name: "sourceFencingToken",
          type: "nullable_decimal",
        }),
        Object.freeze({
          name: "sourceOwnerIdHash",
          type: "nullable_hash",
        }),
        Object.freeze({
          name: "contextDependencyAttestationId",
          type: "nullable_identifier",
        }),
        Object.freeze({
          name: "contextDependencyAttestationHash",
          type: "nullable_hash",
        }),
        Object.freeze({
          name: "contextReplayCapability",
          type: "nullable_token",
        }),
        Object.freeze({
          name: "contextReplayPlanCanonicalJson",
          type: "nullable_canonical_json",
        }),
        Object.freeze({
          name: "contextReplayPlanHash",
          type: "nullable_hash",
        }),
        Object.freeze({ name: "denialReasons", type: "identifier_array" }),
      ]),
    }),
    Object.freeze({
      operationId: "review_evidence_commit",
      requestTypeName: "ReviewEvidenceCommitRequest",
      resultTypeName: "ReviewEvidenceCommitResult",
      callerAuthority: "run_authorization_and_lease_capability",
      mutability: "command",
      naturalIdempotencyPreimage: Object.freeze(["attempt_id", "payload_hash"]),
      semanticRetryClass: "same_request",
      allOrNoneRequestFieldGroups: Object.freeze([
        Object.freeze([
          "contextDependencyAttestationId",
          "contextDependencyAttestationHash",
        ]),
      ]),
      requestFields: Object.freeze([
        Object.freeze({ name: "attemptId", type: "identifier" }),
        Object.freeze({ name: "sourceLeaseId", type: "identifier" }),
        Object.freeze({ name: "ownerIdHash", type: "hash" }),
        Object.freeze({ name: "fencingToken", type: "decimal" }),
        Object.freeze({ name: "completionStatus", type: "identifier" }),
        Object.freeze({ name: "schemaValidated", type: "boolean" }),
        Object.freeze({ name: "fullyConsumed", type: "boolean" }),
        Object.freeze({ name: "actualModel", type: "string" }),
        Object.freeze({
          name: "contextDependencyAttestationId",
          type: "nullable_identifier",
        }),
        Object.freeze({
          name: "contextDependencyAttestationHash",
          type: "nullable_hash",
        }),
        Object.freeze({ name: "payloadCanonicalJson", type: "canonical_json" }),
        Object.freeze({ name: "payloadHash", type: "hash" }),
        Object.freeze({ name: "qualityFlags", type: "identifier_array" }),
        Object.freeze({
          name: "transportAttemptCount",
          type: "positive_integer",
        }),
      ]),
      resultStatusEnum: "ReviewEvidenceCommitResultStatus",
      resultFields: Object.freeze([
        Object.freeze({ name: "observationId", type: "nullable_identifier" }),
        Object.freeze({ name: "historicalOnly", type: "boolean" }),
        Object.freeze({
          name: "eligibilityPolicyVersion",
          type: "nullable_identifier",
        }),
        Object.freeze({ name: "rejectionReason", type: "nullable_identifier" }),
      ]),
    }),
  ]),
});

export { providerInvocationManifestV1CanonicalizerDescriptor };
