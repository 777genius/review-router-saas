import {
  ReviewPublicationAttemptState,
  ReviewPublicationClaimState,
  ReviewPublicationEffectStrategy,
  ReviewPublicationExternalEffectKind,
  ReviewPublicationKind,
  ReviewPublicationOperationAttemptState,
  ReviewPublicationOperationRole,
  ReviewPublicationOperationState,
  ReviewPublicationReceiptStatus,
  ReviewPublicationTerminalOutcome,
  reviewPublicationV2SchemaVersion,
} from "../domain/review-publication-attempt.js";

export const reviewPublicationV2ContractDescriptor = Object.freeze({
  schemaVersion: reviewPublicationV2SchemaVersion,
  unsignedIntegerWireType: "unsigned_decimal_string",
  attemptStates: Object.freeze(Object.values(ReviewPublicationAttemptState)),
  terminalOutcomes: Object.freeze(
    Object.values(ReviewPublicationTerminalOutcome),
  ),
  operationStates: Object.freeze(
    Object.values(ReviewPublicationOperationState),
  ),
  claimStates: Object.freeze(Object.values(ReviewPublicationClaimState)),
  operationAttemptStates: Object.freeze(
    Object.values(ReviewPublicationOperationAttemptState),
  ),
  effectStrategies: Object.freeze(
    Object.values(ReviewPublicationEffectStrategy),
  ),
  operationRoles: Object.freeze(Object.values(ReviewPublicationOperationRole)),
  publicationKinds: Object.freeze(Object.values(ReviewPublicationKind)),
  effectKinds: Object.freeze(
    Object.values(ReviewPublicationExternalEffectKind),
  ),
  receiptStatuses: Object.freeze(Object.values(ReviewPublicationReceiptStatus)),
});

export const reviewPublicationV2ActionContractFragment = Object.freeze({
  fragmentVersion: 1,
  boundedContext: "review_publishing",
  publishedEnums: Object.freeze([
    Object.freeze({
      typeName: "ReviewPublicationRequestResultStatus",
      values: Object.freeze(["accepted", "restored", "conflict"]),
    }),
    Object.freeze({
      typeName: "ReviewPublicationStatusResultStatus",
      values: Object.freeze([
        "pending",
        "publishing",
        "reconciling",
        "terminal",
      ]),
    }),
  ]),
  operations: Object.freeze([
    Object.freeze({
      operationId: "review_publication_request",
      requestTypeName: "ReviewPublicationRequest",
      resultTypeName: "ReviewPublicationRequestResult",
      callerAuthority: "run_authorization_and_publication_permit",
      mutability: "command",
      naturalIdempotencyPreimage: Object.freeze([
        "permit_id",
        "projection_hash",
      ]),
      semanticRetryClass: "same_request",
      requestFields: Object.freeze([
        Object.freeze({ name: "publicationPermit", type: "token" }),
        Object.freeze({ name: "projectionHash", type: "hash" }),
        Object.freeze({
          name: "operationsCanonicalJson",
          type: "canonical_json",
        }),
      ]),
      resultStatusEnum: "ReviewPublicationRequestResultStatus",
      resultFields: Object.freeze([
        Object.freeze({
          name: "publicationAttemptId",
          type: "nullable_identifier",
        }),
        Object.freeze({
          name: "publicationState",
          type: "nullable_identifier",
        }),
        Object.freeze({
          name: "pollAfterMs",
          type: "nullable_positive_integer",
        }),
      ]),
    }),
    Object.freeze({
      operationId: "review_publication_status",
      requestTypeName: "ReviewPublicationStatusRequest",
      resultTypeName: "ReviewPublicationStatusResult",
      callerAuthority: "run_authorization",
      mutability: "read",
      naturalIdempotencyPreimage: Object.freeze(["publication_attempt_id"]),
      semanticRetryClass: "read_only",
      requestFields: Object.freeze([
        Object.freeze({ name: "publicationAttemptId", type: "identifier" }),
      ]),
      resultStatusEnum: "ReviewPublicationStatusResultStatus",
      resultFields: Object.freeze([
        Object.freeze({ name: "publicationAttemptId", type: "identifier" }),
        Object.freeze({ name: "terminalOutcome", type: "nullable_identifier" }),
        Object.freeze({
          name: "canonicalReceiptSetHash",
          type: "nullable_hash",
        }),
        Object.freeze({
          name: "pollAfterMs",
          type: "nullable_positive_integer",
        }),
      ]),
    }),
  ]),
});
