export const reviewSnapshotV2ContractSource = {
  schemaVersion: 2,
  commitOutcomes: [
    "committed",
    "already_current",
    "superseded_by_higher_generation",
  ],
  restoreModes: ["exact_projection", "lineage_hints_only"],
  restoreStatuses: [
    "found",
    "missing",
    "expired",
    "revision_changed",
    "legacy_untrusted",
    "trust_rejected",
  ],
} as const;

export const reviewSnapshotV2ActionContractFragment = Object.freeze({
  fragmentVersion: 1,
  boundedContext: "review_snapshots",
  publishedEnums: Object.freeze([
    Object.freeze({
      typeName: "ReviewSnapshotRestoreResultStatus",
      values: Object.freeze([
        "found",
        "missing",
        "expired",
        "revision_changed",
        "legacy_untrusted",
        "trust_rejected",
      ]),
    }),
  ]),
  operations: Object.freeze([
    Object.freeze({
      operationId: "review_snapshot_restore",
      requestTypeName: "ReviewSnapshotRestoreRequest",
      resultTypeName: "ReviewSnapshotRestoreResult",
      callerAuthority: "run_authorization",
      mutability: "read",
      naturalIdempotencyPreimage: Object.freeze(["review_revision_hash"]),
      semanticRetryClass: "read_only",
      requestFields: Object.freeze([
        Object.freeze({ name: "reviewRevisionHash", type: "hash" }),
      ]),
      resultStatusEnum: "ReviewSnapshotRestoreResultStatus",
      resultFields: Object.freeze([
        Object.freeze({
          name: "snapshotVersion",
          type: "nullable_positive_integer",
        }),
        Object.freeze({
          name: "sourceExecutionId",
          type: "nullable_identifier",
        }),
        Object.freeze({
          name: "sourceExecutionGeneration",
          type: "nullable_decimal",
        }),
        Object.freeze({ name: "restoreMode", type: "nullable_identifier" }),
        Object.freeze({
          name: "payloadCanonicalJson",
          type: "nullable_canonical_json",
        }),
        Object.freeze({
          name: "lineageHintsCanonicalJson",
          type: "nullable_canonical_json",
        }),
      ]),
    }),
  ]),
});
