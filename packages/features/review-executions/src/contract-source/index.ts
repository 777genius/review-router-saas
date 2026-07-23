import {
  PublicationPermitValidationStatus,
  ReviewCoverageState,
  ReviewExecutionProviderKind,
  ReviewExecutionState,
  ReviewInvocationLeasePurpose,
  ReviewInvocationLeaseState,
  ReviewObservationAttachmentKind,
  ReviewTaskKind,
  ReviewWorkSlotState,
  canonicalReviewExecutionPlanPreimage,
  canonicalReviewExecutionStartPreimage,
} from "../domain/review-execution.js";
import {
  ReviewRequestedIntentState,
  ReviewRequestedTriggerKind,
} from "../domain/review-requested-intent.js";

export const reviewExecutionsContractDescriptor = Object.freeze({
  contractVersion: 1,
  fencingTokenWireType: "unsigned_decimal_string",
  providerKinds: Object.freeze(Object.values(ReviewExecutionProviderKind)),
  taskKinds: Object.freeze(Object.values(ReviewTaskKind)),
  executionStates: Object.freeze(Object.values(ReviewExecutionState)),
  workSlotStates: Object.freeze(Object.values(ReviewWorkSlotState)),
  leasePurposes: Object.freeze(Object.values(ReviewInvocationLeasePurpose)),
  leaseStates: Object.freeze(Object.values(ReviewInvocationLeaseState)),
  attachmentKinds: Object.freeze(
    Object.values(ReviewObservationAttachmentKind),
  ),
  coverageStates: Object.freeze(Object.values(ReviewCoverageState)),
  permitValidationStatuses: Object.freeze(
    Object.values(PublicationPermitValidationStatus),
  ),
  requestedIntentStates: Object.freeze(
    Object.values(ReviewRequestedIntentState),
  ),
  requestedTriggerKinds: Object.freeze(
    Object.values(ReviewRequestedTriggerKind),
  ),
});

export const reviewExecutionsActionContractFragment = Object.freeze({
  fragmentVersion: 1,
  boundedContext: "review_executions",
  publishedEnums: Object.freeze([
    Object.freeze({
      typeName: "ReviewExecutionRestoreResultStatus",
      values: Object.freeze(["found", "missing", "not_restorable"]),
    }),
    Object.freeze({
      typeName: "ReviewExecutionStartResultStatus",
      values: Object.freeze([
        "admitted",
        "restored",
        "admission_deferred",
        "stale_revision",
        "authorization_rejected",
        "idempotency_conflict",
        "concurrency_conflict",
      ]),
    }),
    Object.freeze({
      typeName: "ReviewExecutionMutationResultStatus",
      values: Object.freeze([
        "applied",
        "restored",
        "rejected",
        "conflict",
        "missing",
      ]),
    }),
    Object.freeze({
      typeName: "ReviewInvocationLeaseResultStatus",
      values: Object.freeze([
        "acquired",
        "restored",
        "applied",
        "busy",
        "stale_term",
        "expired",
        "rejected",
        "missing",
      ]),
    }),
  ]),
  operations: Object.freeze([
    Object.freeze({
      operationId: "review_execution_restore",
      requestTypeName: "ReviewExecutionRestoreRequest",
      resultTypeName: "ReviewExecutionRestoreResult",
      callerAuthority: "run_authorization",
      mutability: "read",
      naturalIdempotencyPreimage: Object.freeze([
        "authorization_id",
        "review_revision_hash",
      ]),
      semanticRetryClass: "read_only",
      requestFields: Object.freeze([
        Object.freeze({ name: "authorizationId", type: "identifier" }),
        Object.freeze({ name: "reviewRevisionHash", type: "hash" }),
      ]),
      resultStatusEnum: "ReviewExecutionRestoreResultStatus",
      resultFields: Object.freeze([
        Object.freeze({ name: "executionId", type: "nullable_identifier" }),
        Object.freeze({ name: "generation", type: "nullable_decimal" }),
        Object.freeze({ name: "streamVersion", type: "nullable_decimal" }),
        Object.freeze({ name: "executionState", type: "nullable_identifier" }),
        Object.freeze({
          name: "executionCanonicalJson",
          type: "nullable_canonical_json",
        }),
      ]),
    }),
    Object.freeze({
      operationId: "review_execution_start",
      requestTypeName: "ReviewExecutionStartRequest",
      resultTypeName: "ReviewExecutionStartResult",
      callerAuthority: "run_authorization",
      mutability: "command",
      naturalIdempotencyPreimage: Object.freeze([
        "authorization_id",
        "review_revision_hash",
        "plan_hash",
      ]),
      semanticRetryClass: "same_request",
      requestFields: Object.freeze([
        Object.freeze({ name: "authorizationId", type: "identifier" }),
        Object.freeze({ name: "executionId", type: "identifier" }),
        Object.freeze({ name: "reviewRevisionHash", type: "hash" }),
        Object.freeze({ name: "compatibilityKey", type: "hash" }),
        Object.freeze({ name: "planHash", type: "hash" }),
        Object.freeze({
          name: "workSlotsCanonicalJson",
          type: "canonical_json",
        }),
        Object.freeze({ name: "sourceRunId", type: "identifier" }),
        Object.freeze({ name: "sourceRunAttempt", type: "identifier" }),
      ]),
      resultStatusEnum: "ReviewExecutionStartResultStatus",
      resultFields: Object.freeze([
        Object.freeze({ name: "executionId", type: "nullable_identifier" }),
        Object.freeze({ name: "generation", type: "nullable_decimal" }),
        Object.freeze({ name: "streamVersion", type: "nullable_decimal" }),
        Object.freeze({ name: "executionVersion", type: "nullable_decimal" }),
        Object.freeze({
          name: "executionCanonicalJson",
          type: "nullable_canonical_json",
        }),
      ]),
    }),
    Object.freeze({
      operationId: "review_execution_supersede",
      requestTypeName: "ReviewExecutionSupersedeRequest",
      resultTypeName: "ReviewExecutionSupersedeResult",
      callerAuthority: "run_authorization",
      mutability: "command",
      naturalIdempotencyPreimage: Object.freeze([
        "execution_id",
        "expected_stream_version",
        "target_revision_hash",
      ]),
      semanticRetryClass: "same_request",
      requestFields: Object.freeze([
        Object.freeze({ name: "executionId", type: "identifier" }),
        Object.freeze({ name: "expectedStreamVersion", type: "decimal" }),
        Object.freeze({ name: "targetRevisionHash", type: "hash" }),
      ]),
      resultStatusEnum: "ReviewExecutionMutationResultStatus",
      resultFields: Object.freeze([
        Object.freeze({ name: "executionId", type: "nullable_identifier" }),
        Object.freeze({ name: "streamVersion", type: "nullable_decimal" }),
      ]),
    }),
    Object.freeze({
      operationId: "review_execution_observation_attach",
      requestTypeName: "ReviewExecutionObservationAttachRequest",
      resultTypeName: "ReviewExecutionObservationAttachResult",
      callerAuthority: "run_authorization_and_lease_capability",
      mutability: "command",
      naturalIdempotencyPreimage: Object.freeze([
        "execution_id",
        "work_slot_id",
        "observation_id",
      ]),
      semanticRetryClass: "same_request",
      requestFields: Object.freeze([
        Object.freeze({ name: "executionId", type: "identifier" }),
        Object.freeze({ name: "workSlotId", type: "identifier" }),
        Object.freeze({ name: "observationId", type: "identifier" }),
        Object.freeze({ name: "providerInvocationKey", type: "hash" }),
        Object.freeze({ name: "providerVoteIdentityHash", type: "hash" }),
        Object.freeze({ name: "payloadHash", type: "hash" }),
        Object.freeze({ name: "byteCount", type: "non_negative_integer" }),
        Object.freeze({ name: "findingCount", type: "non_negative_integer" }),
        Object.freeze({ name: "eligibilityPolicyVersion", type: "identifier" }),
      ]),
      resultStatusEnum: "ReviewExecutionMutationResultStatus",
      resultFields: Object.freeze([
        Object.freeze({ name: "executionId", type: "nullable_identifier" }),
        Object.freeze({ name: "workSlotId", type: "nullable_identifier" }),
        Object.freeze({ name: "streamVersion", type: "nullable_decimal" }),
      ]),
    }),
    Object.freeze({
      operationId: "review_execution_observation_adopt",
      requestTypeName: "ReviewExecutionObservationAdoptRequest",
      resultTypeName: "ReviewExecutionObservationAdoptResult",
      callerAuthority: "run_authorization",
      mutability: "command",
      naturalIdempotencyPreimage: Object.freeze([
        "execution_id",
        "execution_generation",
        "work_slot_id",
        "observation_id",
        "source_lease_id",
        "source_fencing_token",
      ]),
      semanticRetryClass: "same_request",
      requestFields: Object.freeze([
        Object.freeze({ name: "executionId", type: "identifier" }),
        Object.freeze({ name: "executionGeneration", type: "decimal" }),
        Object.freeze({ name: "expectedStreamVersion", type: "decimal" }),
        Object.freeze({ name: "expectedExecutionVersion", type: "decimal" }),
        Object.freeze({ name: "workSlotId", type: "identifier" }),
        Object.freeze({ name: "observationId", type: "identifier" }),
        Object.freeze({ name: "providerInvocationKey", type: "hash" }),
        Object.freeze({ name: "providerVoteIdentityHash", type: "hash" }),
        Object.freeze({ name: "payloadHash", type: "hash" }),
        Object.freeze({ name: "byteCount", type: "non_negative_integer" }),
        Object.freeze({ name: "findingCount", type: "non_negative_integer" }),
        Object.freeze({ name: "sourceLeaseId", type: "identifier" }),
        Object.freeze({ name: "sourceFencingToken", type: "decimal" }),
        Object.freeze({
          name: "manifestCanonicalJson",
          type: "canonical_json",
        }),
        Object.freeze({ name: "manifestKey", type: "hash" }),
        Object.freeze({ name: "planHash", type: "hash" }),
        Object.freeze({ name: "reviewRevisionHash", type: "hash" }),
        Object.freeze({ name: "ownerIdHash", type: "hash" }),
        Object.freeze({ name: "eligibilityPolicyVersion", type: "identifier" }),
      ]),
      resultStatusEnum: "ReviewExecutionMutationResultStatus",
      resultFields: Object.freeze([
        Object.freeze({ name: "executionId", type: "nullable_identifier" }),
        Object.freeze({ name: "workSlotId", type: "nullable_identifier" }),
        Object.freeze({ name: "streamVersion", type: "nullable_decimal" }),
        Object.freeze({
          name: "observationPayloadCanonicalJson",
          type: "nullable_canonical_json",
        }),
        Object.freeze({
          name: "observationFactsCanonicalJson",
          type: "nullable_canonical_json",
        }),
      ]),
    }),
    Object.freeze({
      operationId: "review_execution_finalize",
      requestTypeName: "ReviewExecutionFinalizeRequest",
      resultTypeName: "ReviewExecutionFinalizeResult",
      callerAuthority: "run_authorization",
      mutability: "command",
      naturalIdempotencyPreimage: Object.freeze([
        "execution_id",
        "projection_hash",
      ]),
      semanticRetryClass: "same_request",
      requestFields: Object.freeze([
        Object.freeze({ name: "executionId", type: "identifier" }),
        Object.freeze({ name: "expectedStreamVersion", type: "decimal" }),
        Object.freeze({ name: "expectedExecutionVersion", type: "decimal" }),
        Object.freeze({ name: "artifactId", type: "identifier" }),
        Object.freeze({ name: "artifactHash", type: "hash" }),
        Object.freeze({
          name: "projectionEnvelopeVersion",
          type: "positive_integer",
        }),
        Object.freeze({
          name: "projectionEnvelopeCanonicalJson",
          type: "canonical_json",
        }),
        Object.freeze({ name: "projectionHash", type: "hash" }),
        Object.freeze({ name: "lifecycleStateHash", type: "hash" }),
        Object.freeze({ name: "commandLedgerWatermark", type: "decimal" }),
        Object.freeze({ name: "allowPartial", type: "boolean" }),
      ]),
      resultStatusEnum: "ReviewExecutionMutationResultStatus",
      resultFields: Object.freeze([
        Object.freeze({ name: "executionId", type: "nullable_identifier" }),
        Object.freeze({ name: "artifactId", type: "nullable_identifier" }),
        Object.freeze({ name: "artifactHash", type: "nullable_hash" }),
        Object.freeze({ name: "publicationPermit", type: "nullable_token" }),
      ]),
    }),
    ...Object.freeze([
      Object.freeze({
        operationId: "review_invocation_lease_acquire",
        requestTypeName: "ReviewInvocationLeaseAcquireRequest",
        resultTypeName: "ReviewInvocationLeaseAcquireResult",
        callerAuthority: "run_authorization",
        mutability: "command",
        naturalIdempotencyPreimage: Object.freeze([
          "execution_id",
          "work_slot_id",
          "acquire_request_id",
        ]),
        semanticRetryClass: "same_request",
        requestFields: Object.freeze([
          Object.freeze({ name: "executionId", type: "identifier" }),
          Object.freeze({ name: "workSlotId", type: "identifier" }),
          Object.freeze({ name: "purpose", type: "identifier" }),
          Object.freeze({
            name: "manifestCanonicalJson",
            type: "canonical_json",
          }),
          Object.freeze({ name: "manifestKey", type: "hash" }),
          Object.freeze({ name: "providerVoteIdentityHash", type: "hash" }),
          Object.freeze({ name: "providerInvocationKey", type: "hash" }),
          Object.freeze({ name: "acquireRequestId", type: "identifier" }),
          Object.freeze({ name: "ownerIdHash", type: "hash" }),
        ]),
        resultStatusEnum: "ReviewInvocationLeaseResultStatus",
        resultFields: Object.freeze([
          Object.freeze({ name: "leaseId", type: "nullable_identifier" }),
          Object.freeze({ name: "attemptId", type: "nullable_identifier" }),
          Object.freeze({ name: "leaseCapability", type: "nullable_token" }),
          Object.freeze({ name: "fencingToken", type: "nullable_decimal" }),
          Object.freeze({ name: "expiresAt", type: "nullable_timestamp" }),
          Object.freeze({
            name: "resultReportUntil",
            type: "nullable_timestamp",
          }),
        ]),
      }),
      ...["renew", "release"].map((transition) =>
        Object.freeze({
          operationId: `review_invocation_lease_${transition}`,
          requestTypeName: `ReviewInvocationLease${transition === "renew" ? "Renew" : "Release"}Request`,
          resultTypeName: `ReviewInvocationLease${transition === "renew" ? "Renew" : "Release"}Result`,
          callerAuthority: "lease_capability",
          mutability: "command",
          naturalIdempotencyPreimage: Object.freeze([
            "lease_id",
            "fencing_token",
            `${transition}_request_id`,
          ]),
          semanticRetryClass: "same_request",
          requestFields: Object.freeze([
            Object.freeze({ name: "leaseId", type: "identifier" }),
            Object.freeze({ name: "ownerIdHash", type: "hash" }),
            Object.freeze({ name: "fencingToken", type: "decimal" }),
            Object.freeze({
              name: `${transition}RequestId`,
              type: "identifier",
            }),
          ]),
          resultStatusEnum: "ReviewInvocationLeaseResultStatus",
          resultFields: Object.freeze([
            Object.freeze({ name: "leaseId", type: "nullable_identifier" }),
            Object.freeze({ name: "fencingToken", type: "nullable_decimal" }),
            Object.freeze({ name: "expiresAt", type: "nullable_timestamp" }),
            ...(transition === "renew"
              ? [
                  Object.freeze({
                    name: "leaseCapability",
                    type: "nullable_token",
                  }),
                ]
              : []),
          ]),
        }),
      ),
    ]),
  ]),
});

export {
  canonicalReviewExecutionPlanPreimage,
  canonicalReviewExecutionStartPreimage,
};
export type {
  FinalizedReviewProjectionArtifact,
  PublicationPermit,
  ReviewExecution,
  ReviewExecutionObservationRef,
  ReviewExecutionScope,
  ReviewInvocationLease,
  ReviewRevision,
  ReviewWorkSlot,
  ReviewWorkSlotPlan,
} from "../domain/review-execution.js";
export type {
  ReviewRequestedIntent,
  ReviewRequestedIntentCandidate,
} from "../domain/review-requested-intent.js";
