export const reviewV2MigrationVersion = "review-v2-000029-000037-v5";
export const reviewV2MigrationDirectories = Object.freeze([
  "000029_revision_aware_review_v2_expand",
  "000030_review_run_control_persistence",
  "000031_review_invocation_prepared_manifest",
  "000032_review_publication_worker_safety",
  "000037_finalized_projection_artifact_identity",
]);
export const reviewV2RepositoryBackfillStep = "02_repository_identity_backfill";
export const reviewV2RepositoryBackfillDefaultPageSize = 500;
export const reviewV2RepositoryBackfillMaximumPageSize = 5_000;

const actionCode = Object.freeze({
  CASCADE: "c",
  "NO ACTION": "a",
  RESTRICT: "r",
});

function fk(
  tableName,
  constraintName,
  sourceColumns,
  targetTableName,
  targetColumns,
  options = {},
) {
  return Object.freeze({
    tableName,
    constraintName,
    sourceColumns: Object.freeze(sourceColumns),
    targetTableName,
    targetColumns: Object.freeze(targetColumns),
    onDeleteCode: actionCode[options.onDelete ?? "RESTRICT"],
    onUpdateCode: actionCode[options.onUpdate ?? "CASCADE"],
    deferrable: options.deferrable ?? false,
    initiallyDeferred: options.initiallyDeferred ?? false,
  });
}

export const reviewV2ForeignKeys = Object.freeze([
  fk(
    "RepositoryConnection",
    "RepositoryConnection_scmRepositoryIdentityId_fkey",
    ["scmRepositoryIdentityId"],
    "ScmRepositoryIdentity",
    ["scmRepositoryIdentityId"],
  ),
  fk(
    "ScmRepositoryIdentity",
    "ScmRepositoryIdentity_current_binding_fkey",
    [
      "currentRepositoryConnectionId",
      "currentWorkspaceId",
      "scmRepositoryIdentityId",
    ],
    "RepositoryConnection",
    ["id", "workspaceId", "scmRepositoryIdentityId"],
    { deferrable: true, initiallyDeferred: true },
  ),
  fk(
    "ReviewMutationAuthority",
    "ReviewMutationAuthority_scmRepositoryIdentityId_fkey",
    ["scmRepositoryIdentityId"],
    "ScmRepositoryIdentity",
    ["scmRepositoryIdentityId"],
  ),
  fk(
    "ReviewSafetyPolicySelector",
    "ReviewSafetyPolicySelector_policyId_fkey",
    ["policyId"],
    "ReviewSafetyPolicy",
    ["policyId"],
    { onDelete: "CASCADE" },
  ),
  fk(
    "ReviewSafetyPolicy",
    "ReviewSafetyPolicy_workspaceId_fkey",
    ["workspaceId"],
    "Workspace",
    ["id"],
  ),
  fk(
    "ReviewSafetyPolicy",
    "ReviewSafetyPolicy_repository_scope_fkey",
    ["repositoryConnectionId", "workspaceId", "scmRepositoryIdentityId"],
    "RepositoryConnection",
    ["id", "workspaceId", "scmRepositoryIdentityId"],
  ),
  fk(
    "ReviewSafetyEmergencyControl",
    "ReviewSafetyEmergencyControl_workspaceId_fkey",
    ["workspaceId"],
    "Workspace",
    ["id"],
  ),
  fk(
    "ReviewSafetyEmergencyControl",
    "ReviewSafetyEmergencyControl_repository_scope_fkey",
    ["repositoryConnectionId", "workspaceId", "scmRepositoryIdentityId"],
    "RepositoryConnection",
    ["id", "workspaceId", "scmRepositoryIdentityId"],
  ),
  fk(
    "ProducerRelease",
    "ProducerRelease_protocolLimitsProfileId_fkey",
    ["protocolLimitsProfileId"],
    "ReviewProtocolLimitsV2",
    ["protocolLimitsProfileId"],
  ),
  fk(
    "ProducerRelease",
    "ProducerRelease_operationalSloProfileId_fkey",
    ["operationalSloProfileId"],
    "ReviewOperationalSloProfileV2",
    ["operationalSloProfileId"],
  ),
  fk(
    "ReviewRunAuthorization",
    "ReviewRunAuthorization_repository_scope_fkey",
    ["repositoryConnectionId", "workspaceId", "scmRepositoryIdentityId"],
    "RepositoryConnection",
    ["id", "workspaceId", "scmRepositoryIdentityId"],
  ),
  fk(
    "ReviewRunAuthorization",
    "ReviewRunAuthorization_producerReleaseId_fkey",
    ["producerReleaseId"],
    "ProducerRelease",
    ["producerReleaseId"],
  ),
  fk(
    "ReviewEvidenceObservation",
    "ReviewEvidenceObservation_repository_scope_fkey",
    ["repositoryConnectionId", "workspaceId", "scmRepositoryIdentityId"],
    "RepositoryConnection",
    ["id", "workspaceId", "scmRepositoryIdentityId"],
  ),
  fk(
    "ReviewEvidenceObservation",
    "ReviewEvidenceObservation_sourceAuthorizationId_fkey",
    ["sourceAuthorizationId"],
    "ReviewRunAuthorization",
    ["authorizationId"],
  ),
  fk(
    "ReviewEvidenceObservation",
    "ReviewEvidenceObservation_producerReleaseId_fkey",
    ["producerReleaseId"],
    "ProducerRelease",
    ["producerReleaseId"],
  ),
  fk(
    "ReviewRequestedIntent",
    "ReviewRequestedIntent_repository_scope_fkey",
    ["repositoryConnectionId", "workspaceId", "scmRepositoryIdentityId"],
    "RepositoryConnection",
    ["id", "workspaceId", "scmRepositoryIdentityId"],
  ),
  fk(
    "ReviewRequestedIntent",
    "ReviewRequestedIntent_supersededByRequestId_fkey",
    ["supersededByRequestId"],
    "ReviewRequestedIntent",
    ["requestId"],
    { deferrable: true, initiallyDeferred: true },
  ),
  fk(
    "ReviewRequestedIntent",
    "ReviewRequestedIntent_authorizationId_fkey",
    ["authorizationId"],
    "ReviewRunAuthorization",
    ["authorizationId"],
  ),
  fk(
    "ReviewRequestedIntent",
    "ReviewRequestedIntent_executionId_fkey",
    ["executionId"],
    "ReviewExecutionV2",
    ["executionId"],
  ),
  fk(
    "ReviewExecutionStreamV2",
    "ReviewExecutionStreamV2_repository_scope_fkey",
    ["repositoryConnectionId", "workspaceId", "scmRepositoryIdentityId"],
    "RepositoryConnection",
    ["id", "workspaceId", "scmRepositoryIdentityId"],
  ),
  fk(
    "ReviewExecutionV2",
    "ReviewExecutionV2_repository_scope_fkey",
    ["repositoryConnectionId", "workspaceId", "scmRepositoryIdentityId"],
    "RepositoryConnection",
    ["id", "workspaceId", "scmRepositoryIdentityId"],
  ),
  fk(
    "ReviewExecutionV2",
    "ReviewExecutionV2_authorizationId_fkey",
    ["authorizationId"],
    "ReviewRunAuthorization",
    ["authorizationId"],
  ),
  fk(
    "ReviewExecutionV2",
    "ReviewExecutionV2_producerReleaseId_fkey",
    ["producerReleaseId"],
    "ProducerRelease",
    ["producerReleaseId"],
  ),
  fk(
    "ReviewExecutionWorkSlotV2",
    "ReviewExecutionWorkSlotV2_executionId_fkey",
    ["executionId"],
    "ReviewExecutionV2",
    ["executionId"],
  ),
  fk(
    "ReviewInvocationLeaseV2",
    "ReviewInvocationLeaseV2_execution_work_slot_fkey",
    ["executionId", "workSlotId"],
    "ReviewExecutionWorkSlotV2",
    ["executionId", "workSlotId"],
  ),
  fk(
    "ReviewExecutionObservationRefV2",
    "ReviewExecutionObservationRefV2_execution_work_slot_fkey",
    ["executionId", "workSlotId"],
    "ReviewExecutionWorkSlotV2",
    ["executionId", "workSlotId"],
  ),
  fk(
    "ReviewExecutionObservationRefV2",
    "ReviewExecutionObservationRefV2_observationId_fkey",
    ["observationId"],
    "ReviewEvidenceObservation",
    ["observationId"],
  ),
  fk(
    "FinalizedReviewProjectionArtifactV2",
    "FinalizedReviewProjectionArtifactV2_executionId_fkey",
    ["executionId"],
    "ReviewExecutionV2",
    ["executionId"],
  ),
  fk(
    "ReviewSnapshot",
    "ReviewSnapshot_v2_repository_scope_fkey",
    ["repositoryId", "workspaceId", "scmRepositoryIdentityId"],
    "RepositoryConnection",
    ["id", "workspaceId", "scmRepositoryIdentityId"],
  ),
  fk(
    "ReviewSnapshot",
    "ReviewSnapshot_sourceExecutionId_fkey",
    ["sourceExecutionId"],
    "ReviewExecutionV2",
    ["executionId"],
  ),
  fk(
    "ReviewSnapshotCommitReceiptV2",
    "ReviewSnapshotCommitReceiptV2_sourceExecutionId_fkey",
    ["sourceExecutionId"],
    "ReviewExecutionV2",
    ["executionId"],
  ),
  fk(
    "ReviewPublicationAttemptV2",
    "ReviewPublicationAttemptV2_executionId_fkey",
    ["executionId"],
    "ReviewExecutionV2",
    ["executionId"],
  ),
  fk(
    "ReviewPublicationAttemptV2",
    "ReviewPublicationAttemptV2_repository_scope_fkey",
    ["repositoryConnectionId", "workspaceId", "scmRepositoryIdentityId"],
    "RepositoryConnection",
    ["id", "workspaceId", "scmRepositoryIdentityId"],
  ),
  fk(
    "ReviewPublicationAttemptV2",
    "ReviewPublicationAttemptV2_authorizationId_fkey",
    ["authorizationId"],
    "ReviewRunAuthorization",
    ["authorizationId"],
  ),
  fk(
    "ReviewPublicationAttemptV2",
    "ReviewPublicationAttemptV2_producerReleaseId_fkey",
    ["producerReleaseId"],
    "ProducerRelease",
    ["producerReleaseId"],
  ),
  fk(
    "ReviewPublicationClaimTermV2",
    "ReviewPublicationClaimTermV2_publicationAttemptId_fkey",
    ["publicationAttemptId"],
    "ReviewPublicationAttemptV2",
    ["publicationAttemptId"],
  ),
  fk(
    "ReviewPublicationOperationV2",
    "ReviewPublicationOperationV2_publicationAttemptId_fkey",
    ["publicationAttemptId"],
    "ReviewPublicationAttemptV2",
    ["publicationAttemptId"],
  ),
  fk(
    "ReviewPublicationOperationAttemptV2",
    "ReviewPublicationOperationAttemptV2_publicationOperationId_fkey",
    ["publicationOperationId"],
    "ReviewPublicationOperationV2",
    ["publicationOperationId"],
  ),
  fk(
    "ReviewPublicationOperationAttemptV2",
    "ReviewPublicationOperationAttemptV2_claimId_fkey",
    ["claimId"],
    "ReviewPublicationClaimTermV2",
    ["claimId"],
  ),
  fk(
    "ReviewPublicationExternalEffectV2",
    "ReviewPublicationExternalEffectV2_operationAttemptId_fkey",
    ["operationAttemptId"],
    "ReviewPublicationOperationAttemptV2",
    ["operationAttemptId"],
  ),
  fk(
    "ReviewPublicationReceiptV2",
    "ReviewPublicationReceiptV2_publicationOperationId_fkey",
    ["publicationOperationId"],
    "ReviewPublicationOperationV2",
    ["publicationOperationId"],
  ),
  fk(
    "ReviewPublicationAuditTombstoneV2",
    "ReviewPublicationAuditTombstoneV2_publicationOperationId_fkey",
    ["publicationOperationId"],
    "ReviewPublicationOperationV2",
    ["publicationOperationId"],
  ),
  fk(
    "ReviewPublicationOutcomeCorrectionV2",
    "ReviewPublicationOutcomeCorrectionV2_publicationAttemptId_fkey",
    ["publicationAttemptId"],
    "ReviewPublicationAttemptV2",
    ["publicationAttemptId"],
  ),
  fk(
    "ReviewCompletionProcess",
    "ReviewCompletionProcess_executionId_fkey",
    ["executionId"],
    "ReviewExecutionV2",
    ["executionId"],
  ),
  fk(
    "ReviewCompletionProcess",
    "ReviewCompletionProcess_finalizedArtifactId_fkey",
    ["executionId", "finalizedArtifactId"],
    "FinalizedReviewProjectionArtifactV2",
    ["executionId", "artifactId"],
  ),
  fk(
    "ReviewCompletionProcess",
    "ReviewCompletionProcess_publicationAttemptId_fkey",
    ["publicationAttemptId"],
    "ReviewPublicationAttemptV2",
    ["publicationAttemptId"],
  ),
  fk(
    "ReviewCompletionProcess",
    "ReviewCompletionProcess_snapshotCommitReceiptId_fkey",
    ["snapshotCommitReceiptId"],
    "ReviewSnapshotCommitReceiptV2",
    ["receiptId"],
  ),
  fk(
    "ReviewRunAuthorizationRenewalReceipt",
    "ReviewRunAuthorizationRenewalReceipt_authorizationId_fkey",
    ["authorizationId"],
    "ReviewRunAuthorization",
    ["authorizationId"],
  ),
]);

export function reviewV2ForeignKeyValuesSql() {
  return reviewV2ForeignKeys
    .map(
      (definition) =>
        `(${sqlLiteral(definition.tableName)}, ${sqlLiteral(definition.constraintName)}, ${sqlTextArray(definition.sourceColumns)}, ${sqlLiteral(definition.targetTableName)}, ${sqlTextArray(definition.targetColumns)}, ${sqlLiteral(definition.onDeleteCode)}, ${sqlLiteral(definition.onUpdateCode)}, ${definition.deferrable}, ${definition.initiallyDeferred})`,
    )
    .join(",\n");
}

function sqlTextArray(values) {
  return `ARRAY[${values.map(sqlLiteral).join(", ")}]::text[]`;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
