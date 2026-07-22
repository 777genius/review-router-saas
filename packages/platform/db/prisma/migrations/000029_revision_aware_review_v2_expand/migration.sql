-- CreateEnum
CREATE TYPE "ProducerDistributionKindV2" AS ENUM ('hosted_composite', 'public_reusable');

-- CreateEnum
CREATE TYPE "ProducerReleaseStateV2" AS ENUM ('registered', 'revoked');

-- CreateEnum
CREATE TYPE "ReviewMutationLaneKindV2" AS ENUM ('hosted_reviewrouter_app');

-- CreateEnum
CREATE TYPE "ReviewMutationModeV2" AS ENUM ('v1_open', 'v1_draining', 'v2_active', 'paused');

-- CreateEnum
CREATE TYPE "ReviewSafetyPolicyScopeV2" AS ENUM ('global', 'workspace', 'repository');

-- CreateEnum
CREATE TYPE "ReviewSafetyRolloutModeV2" AS ENUM ('disabled', 'shadow', 'allowlisted', 'enabled');

-- CreateEnum
CREATE TYPE "ReviewSafetyCapabilityV2" AS ENUM ('run_authorization_v2', 'evidence_writes_v2', 'evidence_reuse_v2', 'prompt_only_reuse', 'context_gateway_reuse', 'publication_operations_v2', 'mutation_epoch_v2');

-- CreateEnum
CREATE TYPE "ReviewRunAuthorizationStateV2" AS ENUM ('active', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "ReviewProviderKindV2" AS ENUM ('codex', 'claude_code', 'openrouter');

-- CreateEnum
CREATE TYPE "ReviewTaskKindV2" AS ENUM ('finding_discovery', 'lifecycle_revalidation');

-- CreateEnum
CREATE TYPE "ProviderExecutionProfileV2" AS ENUM ('prompt_only_envelope_v1', 'agentic_unbounded_v1', 'context_gateway_v1');

-- CreateEnum
CREATE TYPE "ReviewTrustDomainV2" AS ENUM ('trusted_managed', 'trusted_local', 'untrusted_contribution');

-- CreateEnum
CREATE TYPE "ReviewRequestedTriggerKindV2" AS ENUM ('pull_request_synchronized', 'pull_request_ready_for_review', 'manual_command', 'lifecycle_changed');

-- CreateEnum
CREATE TYPE "ReviewRequestedIntentStateV2" AS ENUM ('pending_dispatch', 'dispatching', 'awaiting_authorization', 'dispatched', 'superseded');

-- CreateEnum
CREATE TYPE "ReviewExecutionStateV2" AS ENUM ('planned', 'running', 'superseded', 'completed', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "ReviewWorkSlotStateV2" AS ENUM ('pending', 'leased', 'satisfied', 'exhausted', 'cancelled');

-- CreateEnum
CREATE TYPE "ReviewInvocationLeasePurposeV2" AS ENUM ('provider_execution', 'observation_adoption');

-- CreateEnum
CREATE TYPE "ReviewInvocationLeaseStateV2" AS ENUM ('active', 'released', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "ReviewObservationAttachmentKindV2" AS ENUM ('fresh_lease', 'observation_adoption', 'exact_revision_reuse', 'prompt_only_cross_revision_reuse', 'context_gateway_cross_revision_reuse');

-- CreateEnum
CREATE TYPE "ReviewCoverageStateV2" AS ENUM ('completed', 'partial');

-- CreateEnum
CREATE TYPE "ReviewSnapshotCommitOutcomeV2" AS ENUM ('committed', 'already_current', 'superseded_by_higher_generation');

-- CreateEnum
CREATE TYPE "ReviewPublicationAttemptStateV2" AS ENUM ('pending', 'publishing', 'reconciling', 'terminal');

-- CreateEnum
CREATE TYPE "ReviewPublicationTerminalOutcomeV2" AS ENUM ('succeeded', 'superseded_no_effect', 'failed_no_effect', 'stale_compensated', 'stale_visible', 'terminal_unknown');

-- CreateEnum
CREATE TYPE "ReviewPublicationClaimStateV2" AS ENUM ('active', 'expired', 'released', 'revoked');

-- CreateEnum
CREATE TYPE "ReviewPublicationKindV2" AS ENUM ('summary', 'managed_check', 'pending_review_create', 'pending_review_submit', 'submitted_review', 'thread_lifecycle');

-- CreateEnum
CREATE TYPE "ReviewPublicationEffectStrategyV2" AS ENUM ('mutable_singleton', 'pending_then_submit', 'append_only_canonical_receipt', 'reversible_lifecycle');

-- CreateEnum
CREATE TYPE "ReviewPublicationOperationStateV2" AS ENUM ('planned', 'in_flight', 'effect_observed', 'reconciling', 'completed', 'terminal_unknown');

-- CreateEnum
CREATE TYPE "ReviewPublicationOperationRoleV2" AS ENUM ('standalone', 'pending_review_create', 'pending_review_submit');

-- CreateEnum
CREATE TYPE "ReviewPublicationOperationAttemptStateV2" AS ENUM ('active', 'effect_observed', 'completed', 'stale', 'terminal_unknown');

-- CreateEnum
CREATE TYPE "ReviewPublicationExternalEffectKindV2" AS ENUM ('mutation_acknowledged', 'marker_reconciled', 'lifecycle_compensated');

-- CreateEnum
CREATE TYPE "ReviewCompletionProcessStateV2" AS ENUM ('pending_publication', 'awaiting_publication', 'pending_snapshot', 'completed', 'completed_superseded', 'blocked_partial', 'publication_not_applied', 'publication_stale_compensated', 'publication_stale_visible', 'blocked_publication_unknown');

-- CreateEnum
CREATE TYPE "ReviewCompletionWakeupKindV2" AS ENUM ('finalized_artifact_event', 'publication_event', 'snapshot_event', 'due_scan', 'recovery_scan');

-- AlterTable
ALTER TABLE "RepositoryConnection" ADD COLUMN     "scmRepositoryIdentityId" TEXT;

-- AlterTable
ALTER TABLE "ReviewSnapshot" ADD COLUMN     "publicationReceiptSetHash" TEXT,
ADD COLUMN     "scmRepositoryIdentityId" TEXT,
ADD COLUMN     "sourceArtifactHash" TEXT,
ADD COLUMN     "sourceExecutionGeneration" BIGINT,
ADD COLUMN     "sourceExecutionId" TEXT,
ADD COLUMN     "sourceReviewRevisionHash" TEXT;

-- CreateTable
CREATE TABLE "ReviewProtocolLimitsV2" (
    "protocolLimitsProfileId" TEXT NOT NULL,
    "limitsDigest" TEXT NOT NULL,
    "maxWorkSlots" INTEGER NOT NULL,
    "maxAttemptsPerSlot" INTEGER NOT NULL,
    "maxObservationBytes" INTEGER NOT NULL,
    "maxObservationFindings" INTEGER NOT NULL,
    "maxProjectionBytes" INTEGER NOT NULL,
    "maxProjectionFindings" INTEGER NOT NULL,
    "maxPublicationOperations" INTEGER NOT NULL,
    "maxPublicationChunks" INTEGER NOT NULL,
    "maxPublicationBodyBytes" INTEGER NOT NULL,
    "maxRequestBatchSize" INTEGER NOT NULL,
    "maxLeaseDurationMs" INTEGER NOT NULL,
    "maxResultReportDurationMs" INTEGER NOT NULL,
    "maxReconciliationDurationMs" INTEGER NOT NULL,
    "registeredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewProtocolLimitsV2_pkey" PRIMARY KEY ("protocolLimitsProfileId")
);

-- CreateTable
CREATE TABLE "ReviewOperationalSloProfileV2" (
    "operationalSloProfileId" TEXT NOT NULL,
    "sloDigest" TEXT NOT NULL,
    "integrationEventDeliveryMs" INTEGER NOT NULL,
    "outboxClaimAgeMs" INTEGER NOT NULL,
    "missingCompletionProcessMs" INTEGER NOT NULL,
    "dueCompletionProcessMs" INTEGER NOT NULL,
    "publicationReconciliationMs" INTEGER NOT NULL,
    "v1DrainMs" INTEGER NOT NULL,
    "admissionMs" INTEGER NOT NULL,
    "pruningBacklogAgeMs" INTEGER NOT NULL,
    "ownerRefs" TEXT[],
    "runbookRefs" TEXT[],
    "registeredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewOperationalSloProfileV2_pkey" PRIMARY KEY ("operationalSloProfileId")
);

-- CreateTable
CREATE TABLE "ProducerRelease" (
    "producerReleaseId" TEXT NOT NULL,
    "distributionKind" "ProducerDistributionKindV2" NOT NULL,
    "actionCommitSha" TEXT NOT NULL,
    "runtimeCommitSha" TEXT NOT NULL,
    "wrapperEntrypointDigest" TEXT,
    "runtimeEntrypointDigest" TEXT NOT NULL,
    "schemaDigest" TEXT NOT NULL,
    "capabilityProfile" TEXT NOT NULL,
    "protocolLimitsProfileId" TEXT NOT NULL,
    "operationalSloProfileId" TEXT NOT NULL,
    "state" "ProducerReleaseStateV2" NOT NULL DEFAULT 'registered',
    "registeredAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ProducerRelease_pkey" PRIMARY KEY ("producerReleaseId")
);

-- CreateTable
CREATE TABLE "ScmRepositoryIdentity" (
    "scmRepositoryIdentityId" TEXT NOT NULL,
    "provider" "ScmProvider" NOT NULL,
    "normalizedSourceBaseUrl" TEXT NOT NULL,
    "externalRepositoryId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "currentWorkspaceId" TEXT,
    "currentRepositoryConnectionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "boundAt" TIMESTAMP(3),
    "unboundAt" TIMESTAMP(3),

    CONSTRAINT "ScmRepositoryIdentity_pkey" PRIMARY KEY ("scmRepositoryIdentityId")
);

-- CreateTable
CREATE TABLE "ReviewMutationAuthority" (
    "scmRepositoryIdentityId" TEXT NOT NULL,
    "laneKind" "ReviewMutationLaneKindV2" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "epoch" BIGINT NOT NULL DEFAULT 0,
    "mode" "ReviewMutationModeV2" NOT NULL,
    "drainPolicyVersion" INTEGER,
    "drainStartedAt" TIMESTAMP(3),
    "v1AdmissionClosedAt" TIMESTAMP(3),
    "drainNotBefore" TIMESTAMP(3),
    "managedWorkflowInventoryHash" TEXT,
    "activationSafetyDecisionHash" TEXT,
    "initializedAt" TIMESTAMP(3) NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),

    CONSTRAINT "ReviewMutationAuthority_pkey" PRIMARY KEY ("scmRepositoryIdentityId","laneKind")
);

-- CreateTable
CREATE TABLE "ReviewSafetyPolicy" (
    "policyId" TEXT NOT NULL,
    "policyScope" "ReviewSafetyPolicyScopeV2" NOT NULL,
    "capability" "ReviewSafetyCapabilityV2" NOT NULL,
    "workspaceId" TEXT,
    "repositoryConnectionId" TEXT,
    "scmRepositoryIdentityId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "rolloutMode" "ReviewSafetyRolloutModeV2" NOT NULL DEFAULT 'disabled',
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewSafetyPolicy_pkey" PRIMARY KEY ("policyId")
);

-- CreateTable
CREATE TABLE "ReviewSafetyPolicySelector" (
    "policyId" TEXT NOT NULL,
    "selectorOrdinal" INTEGER NOT NULL,
    "providerKind" "ReviewProviderKindV2",
    "taskKind" "ReviewTaskKindV2",

    CONSTRAINT "ReviewSafetyPolicySelector_pkey" PRIMARY KEY ("policyId","selectorOrdinal")
);

-- CreateTable
CREATE TABLE "ReviewSafetyEmergencyControl" (
    "emergencyControlId" TEXT NOT NULL,
    "policyScope" "ReviewSafetyPolicyScopeV2" NOT NULL,
    "workspaceId" TEXT,
    "repositoryConnectionId" TEXT,
    "scmRepositoryIdentityId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "stopped" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewSafetyEmergencyControl_pkey" PRIMARY KEY ("emergencyControlId")
);

-- CreateTable
CREATE TABLE "ReviewRunAuthorization" (
    "authorizationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "workspaceId" TEXT NOT NULL,
    "repositoryConnectionId" TEXT NOT NULL,
    "scmRepositoryIdentityId" TEXT NOT NULL,
    "pullRequestNumber" INTEGER NOT NULL,
    "sourceRunId" TEXT NOT NULL,
    "sourceRunAttempt" TEXT NOT NULL,
    "workflowIdentityHash" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "mergeBaseSha" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "reviewRevisionHash" TEXT NOT NULL,
    "trustDomain" "ReviewTrustDomainV2" NOT NULL,
    "producerReleaseId" TEXT NOT NULL,
    "selectedProtocolVersion" TEXT NOT NULL,
    "schemaDigest" TEXT NOT NULL,
    "protocolLimitsProfileId" TEXT NOT NULL,
    "operationalSloProfileId" TEXT NOT NULL,
    "mutationEpoch" BIGINT NOT NULL,
    "providerVoteLanes" JSONB NOT NULL,
    "authorizationSafetyDecisionHash" TEXT NOT NULL,
    "protocolOfferHash" TEXT NOT NULL,
    "oidcReplayKeyHash" TEXT NOT NULL,
    "tokenSigningKeyId" TEXT NOT NULL,
    "tokenIssuer" TEXT NOT NULL,
    "tokenAudience" TEXT NOT NULL,
    "state" "ReviewRunAuthorizationStateV2" NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "renewedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ReviewRunAuthorization_pkey" PRIMARY KEY ("authorizationId")
);

-- CreateTable
CREATE TABLE "ReviewEvidenceObservation" (
    "observationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "repositoryConnectionId" TEXT NOT NULL,
    "scmRepositoryIdentityId" TEXT NOT NULL,
    "pullRequestNumber" INTEGER NOT NULL,
    "manifestKey" TEXT NOT NULL,
    "providerInvocationKey" TEXT NOT NULL,
    "providerVoteIdentityHash" TEXT NOT NULL,
    "manifestVersion" INTEGER NOT NULL,
    "providerKind" "ReviewProviderKindV2" NOT NULL,
    "requestedModel" TEXT NOT NULL,
    "actualModel" TEXT NOT NULL,
    "providerRuntimeVersion" TEXT NOT NULL,
    "taskKindSet" "ReviewTaskKindV2"[],
    "producerReleaseId" TEXT NOT NULL,
    "selectedProtocolVersion" TEXT NOT NULL,
    "trustedCapabilityProfile" TEXT NOT NULL,
    "executionProfile" "ProviderExecutionProfileV2" NOT NULL,
    "trustDomain" "ReviewTrustDomainV2" NOT NULL,
    "authorizationScopeHash" TEXT NOT NULL,
    "sourceBaseSha" TEXT NOT NULL,
    "sourceMergeBaseSha" TEXT NOT NULL,
    "sourceHeadSha" TEXT NOT NULL,
    "sourceReviewRevisionHash" TEXT NOT NULL,
    "sourcePlanHash" TEXT NOT NULL,
    "sourceExecutionId" TEXT NOT NULL,
    "sourceWorkSlotId" TEXT NOT NULL,
    "sourceAuthorizationId" TEXT NOT NULL,
    "evidenceWriteSafetyDecisionHash" TEXT NOT NULL,
    "sourceRunId" TEXT NOT NULL,
    "sourceRunAttempt" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "sourceLeaseId" TEXT NOT NULL,
    "sourceFencingToken" BIGINT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "byteCount" INTEGER NOT NULL,
    "findingCount" INTEGER NOT NULL,
    "qualityFlagsJson" JSONB NOT NULL,
    "transportAttemptCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "reuseExpiresAt" TIMESTAMP(3) NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewEvidenceObservation_pkey" PRIMARY KEY ("observationId")
);

-- CreateTable
CREATE TABLE "ReviewRequestedIntent" (
    "requestId" TEXT NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "workspaceId" TEXT NOT NULL,
    "repositoryConnectionId" TEXT NOT NULL,
    "scmRepositoryIdentityId" TEXT NOT NULL,
    "pullRequestNumber" INTEGER NOT NULL,
    "baseSha" TEXT NOT NULL,
    "mergeBaseSha" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "reviewRevisionHash" TEXT NOT NULL,
    "triggerKind" "ReviewRequestedTriggerKindV2" NOT NULL,
    "deliveryIdentityHash" TEXT NOT NULL,
    "canonicalRequestHash" TEXT NOT NULL,
    "state" "ReviewRequestedIntentStateV2" NOT NULL DEFAULT 'pending_dispatch',
    "notBefore" TIMESTAMP(3) NOT NULL,
    "claimId" TEXT,
    "claimOwnerIdHash" TEXT,
    "claimFencingToken" BIGINT,
    "claimedAt" TIMESTAMP(3),
    "claimUntil" TIMESTAMP(3),
    "sourceRunId" TEXT,
    "sourceRunAttempt" TEXT,
    "authorizationId" TEXT,
    "executionId" TEXT,
    "supersededByRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewRequestedIntent_pkey" PRIMARY KEY ("requestId")
);

-- CreateTable
CREATE TABLE "ReviewExecutionStreamV2" (
    "workspaceId" TEXT NOT NULL,
    "repositoryConnectionId" TEXT NOT NULL,
    "scmRepositoryIdentityId" TEXT NOT NULL,
    "pullRequestNumber" INTEGER NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 0,
    "activeExecutionId" TEXT,
    "preparedExecutionId" TEXT,
    "lastAllocatedGeneration" BIGINT NOT NULL DEFAULT 0,
    "currentBaseSha" TEXT,
    "currentMergeBaseSha" TEXT,
    "currentHeadSha" TEXT,
    "currentReviewRevisionHash" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewExecutionStreamV2_pkey" PRIMARY KEY ("workspaceId","repositoryConnectionId","scmRepositoryIdentityId","pullRequestNumber")
);

-- CreateTable
CREATE TABLE "ReviewExecutionV2" (
    "executionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "repositoryConnectionId" TEXT NOT NULL,
    "scmRepositoryIdentityId" TEXT NOT NULL,
    "pullRequestNumber" INTEGER NOT NULL,
    "generation" BIGINT NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "baseSha" TEXT NOT NULL,
    "mergeBaseSha" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "reviewRevisionHash" TEXT NOT NULL,
    "compatibilityKey" TEXT NOT NULL,
    "planHash" TEXT NOT NULL,
    "startIdentityHash" TEXT NOT NULL,
    "canonicalStartHash" TEXT NOT NULL,
    "state" "ReviewExecutionStateV2" NOT NULL DEFAULT 'planned',
    "authorizationId" TEXT NOT NULL,
    "producerReleaseId" TEXT NOT NULL,
    "mutationEpoch" BIGINT NOT NULL,
    "admissionSafetyDecisionHash" TEXT NOT NULL,
    "protocolLimitsProfileId" TEXT NOT NULL,
    "sourceRunId" TEXT NOT NULL,
    "sourceRunAttempt" TEXT NOT NULL,
    "supersededByExecutionId" TEXT,
    "finalizedArtifactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "admissionDeadlineAt" TIMESTAMP(3) NOT NULL,
    "admissionCheckedAt" TIMESTAMP(3),
    "executionDeadlineAt" TIMESTAMP(3) NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewExecutionV2_pkey" PRIMARY KEY ("executionId")
);

-- CreateTable
CREATE TABLE "ReviewExecutionWorkSlotV2" (
    "executionId" TEXT NOT NULL,
    "workSlotId" TEXT NOT NULL,
    "planOrdinal" INTEGER NOT NULL,
    "taskKind" "ReviewTaskKindV2" NOT NULL,
    "providerKind" "ReviewProviderKindV2" NOT NULL,
    "providerVoteIdentityHash" TEXT NOT NULL,
    "shardKey" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL,
    "attemptBudget" INTEGER NOT NULL,
    "retryPolicyVersion" TEXT NOT NULL,
    "state" "ReviewWorkSlotStateV2" NOT NULL DEFAULT 'pending',
    "nextAttemptOrdinal" INTEGER NOT NULL DEFAULT 1,
    "activeLeaseId" TEXT,
    "acceptedObservationRefId" TEXT,

    CONSTRAINT "ReviewExecutionWorkSlotV2_pkey" PRIMARY KEY ("executionId","workSlotId")
);

-- CreateTable
CREATE TABLE "ReviewInvocationLeaseV2" (
    "leaseId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "repositoryConnectionId" TEXT NOT NULL,
    "scmRepositoryIdentityId" TEXT NOT NULL,
    "pullRequestNumber" INTEGER NOT NULL,
    "executionId" TEXT NOT NULL,
    "executionGeneration" BIGINT NOT NULL,
    "providerInvocationKey" TEXT NOT NULL,
    "workSlotId" TEXT NOT NULL,
    "purpose" "ReviewInvocationLeasePurposeV2" NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "producerReleaseId" TEXT NOT NULL,
    "reviewRevisionHash" TEXT NOT NULL,
    "mutationEpoch" BIGINT NOT NULL,
    "leaseSafetyDecisionHash" TEXT NOT NULL,
    "attemptId" TEXT,
    "sourceObservationId" TEXT,
    "attemptOrdinal" INTEGER NOT NULL,
    "acquireRequestIdHash" TEXT NOT NULL,
    "acquireRequestHash" TEXT NOT NULL,
    "ownerIdHash" TEXT NOT NULL,
    "leaseCapabilityId" TEXT NOT NULL,
    "capabilitySigningKeyId" TEXT NOT NULL,
    "fencingToken" BIGINT NOT NULL,
    "state" "ReviewInvocationLeaseStateV2" NOT NULL DEFAULT 'active',
    "acquiredAt" TIMESTAMP(3) NOT NULL,
    "renewedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resultReportUntil" TIMESTAMP(3) NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewInvocationLeaseV2_pkey" PRIMARY KEY ("leaseId")
);

-- CreateTable
CREATE TABLE "ReviewInvocationLeaseTombstoneV2" (
    "leaseId" TEXT NOT NULL,
    "leaseCapabilityId" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "producerReleaseId" TEXT NOT NULL,
    "providerInvocationKeyHash" TEXT NOT NULL,
    "fencingToken" BIGINT NOT NULL,
    "terminalState" "ReviewInvocationLeaseStateV2" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resultReportUntil" TIMESTAMP(3) NOT NULL,
    "compactedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewInvocationLeaseTombstoneV2_pkey" PRIMARY KEY ("leaseId")
);

-- CreateTable
CREATE TABLE "ReviewExecutionObservationRefV2" (
    "observationRefId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "workSlotId" TEXT NOT NULL,
    "providerInvocationKey" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "providerVoteIdentityHash" TEXT NOT NULL,
    "attachmentKind" "ReviewObservationAttachmentKindV2" NOT NULL,
    "eligibilityPolicyVersion" TEXT NOT NULL,
    "reuseSafetyDecisionHash" TEXT,
    "sourceExecutionId" TEXT NOT NULL,
    "sourceLeaseId" TEXT,
    "sourceFencingToken" BIGINT,
    "payloadHash" TEXT NOT NULL,
    "byteCount" INTEGER NOT NULL,
    "findingCount" INTEGER NOT NULL,
    "attachedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewExecutionObservationRefV2_pkey" PRIMARY KEY ("observationRefId")
);

-- CreateTable
CREATE TABLE "FinalizedReviewProjectionArtifactV2" (
    "artifactId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "artifactHash" TEXT NOT NULL,
    "generation" BIGINT NOT NULL,
    "reviewedHeadSha" TEXT NOT NULL,
    "reviewRevisionHash" TEXT NOT NULL,
    "coverageState" "ReviewCoverageStateV2" NOT NULL,
    "projectionEnvelopeVersion" INTEGER NOT NULL,
    "projectionEnvelope" JSONB NOT NULL,
    "projectionEnvelopeCanonicalJson" TEXT NOT NULL,
    "projectionHash" TEXT NOT NULL,
    "byteCount" INTEGER NOT NULL,
    "findingCount" INTEGER NOT NULL,
    "lifecycleStateHash" TEXT NOT NULL,
    "commandLedgerWatermark" BIGINT NOT NULL,
    "projectionPolicyVersion" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "producerReleaseId" TEXT NOT NULL,
    "permitEpoch" BIGINT NOT NULL,
    "publicationSafetyDecisionHash" TEXT NOT NULL,
    "publicationNotAfter" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinalizedReviewProjectionArtifactV2_pkey" PRIMARY KEY ("artifactId")
);

-- CreateTable
CREATE TABLE "ReviewSnapshotCommitReceiptV2" (
    "receiptId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "sourceExecutionId" TEXT NOT NULL,
    "sourceExecutionGeneration" BIGINT NOT NULL,
    "sourceArtifactHash" TEXT NOT NULL,
    "sourceReviewRevisionHash" TEXT NOT NULL,
    "outcome" "ReviewSnapshotCommitOutcomeV2" NOT NULL,
    "resultingSnapshotVersion" INTEGER NOT NULL,
    "resultingSnapshotGeneration" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewSnapshotCommitReceiptV2_pkey" PRIMARY KEY ("receiptId")
);

-- CreateTable
CREATE TABLE "ReviewPublicationAttemptV2" (
    "publicationAttemptId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "repositoryConnectionId" TEXT NOT NULL,
    "scmRepositoryIdentityId" TEXT NOT NULL,
    "pullRequestNumber" INTEGER NOT NULL,
    "executionId" TEXT NOT NULL,
    "generation" BIGINT NOT NULL,
    "reviewedHeadSha" TEXT NOT NULL,
    "reviewRevisionHash" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "producerReleaseId" TEXT NOT NULL,
    "projectionHash" TEXT NOT NULL,
    "permitEpoch" BIGINT NOT NULL,
    "publicationSafetyDecisionHash" TEXT NOT NULL,
    "publicationNotAfter" TIMESTAMP(3) NOT NULL,
    "lifecycleStateHash" TEXT NOT NULL,
    "commandLedgerWatermark" BIGINT NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "state" "ReviewPublicationAttemptStateV2" NOT NULL DEFAULT 'pending',
    "terminalOutcome" "ReviewPublicationTerminalOutcomeV2",
    "activeClaimId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewPublicationAttemptV2_pkey" PRIMARY KEY ("publicationAttemptId")
);

-- CreateTable
CREATE TABLE "ReviewPublicationRequestReceiptV2" (
    "requestIdHash" TEXT NOT NULL,
    "publicationAttemptId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,

    CONSTRAINT "ReviewPublicationRequestReceiptV2_pkey" PRIMARY KEY ("requestIdHash")
);

-- CreateTable
CREATE TABLE "ReviewPublicationClaimTermV2" (
    "claimId" TEXT NOT NULL,
    "publicationAttemptId" TEXT NOT NULL,
    "ownerIdHash" TEXT NOT NULL,
    "acquireRequestIdHash" TEXT NOT NULL,
    "acquireRequestHash" TEXT NOT NULL,
    "commandFingerprint" TEXT NOT NULL,
    "claimCapabilityId" TEXT NOT NULL,
    "capabilitySigningKeyId" TEXT NOT NULL,
    "fencingToken" BIGINT NOT NULL,
    "state" "ReviewPublicationClaimStateV2" NOT NULL DEFAULT 'active',
    "acquiredAt" TIMESTAMP(3) NOT NULL,
    "renewedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "reportUntil" TIMESTAMP(3) NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewPublicationClaimTermV2_pkey" PRIMARY KEY ("claimId")
);

-- CreateTable
CREATE TABLE "ReviewPublicationOperationV2" (
    "publicationOperationId" TEXT NOT NULL,
    "publicationAttemptId" TEXT NOT NULL,
    "publicationKind" "ReviewPublicationKindV2" NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "effectStrategy" "ReviewPublicationEffectStrategyV2" NOT NULL,
    "role" "ReviewPublicationOperationRoleV2" NOT NULL,
    "markerHash" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "renderPolicyVersion" INTEGER NOT NULL,
    "targetCommitId" TEXT NOT NULL,
    "reviewRevisionHash" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL,
    "dependsOnOperationId" TEXT,
    "state" "ReviewPublicationOperationStateV2" NOT NULL DEFAULT 'planned',
    "reconcileUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewPublicationOperationV2_pkey" PRIMARY KEY ("publicationOperationId")
);

-- CreateTable
CREATE TABLE "ReviewPublicationOperationAttemptV2" (
    "operationAttemptId" TEXT NOT NULL,
    "publicationOperationId" TEXT NOT NULL,
    "publicationAttemptId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "acquireRequestIdHash" TEXT NOT NULL,
    "acquireRequestHash" TEXT NOT NULL,
    "commandFingerprint" TEXT NOT NULL,
    "operationCapabilityId" TEXT NOT NULL,
    "capabilitySigningKeyId" TEXT NOT NULL,
    "effectReportId" TEXT NOT NULL,
    "claimFencingToken" BIGINT NOT NULL,
    "state" "ReviewPublicationOperationAttemptStateV2" NOT NULL DEFAULT 'active',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "effectReportUntil" TIMESTAMP(3) NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewPublicationOperationAttemptV2_pkey" PRIMARY KEY ("operationAttemptId")
);

-- CreateTable
CREATE TABLE "ReviewPublicationExternalEffectV2" (
    "effectId" TEXT NOT NULL,
    "publicationAttemptId" TEXT NOT NULL,
    "publicationOperationId" TEXT NOT NULL,
    "operationAttemptId" TEXT NOT NULL,
    "effectReportId" TEXT NOT NULL,
    "reportRequestHash" TEXT NOT NULL,
    "externalObjectId" TEXT NOT NULL,
    "effectKind" "ReviewPublicationExternalEffectKindV2" NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewPublicationExternalEffectV2_pkey" PRIMARY KEY ("effectId")
);

-- CreateTable
CREATE TABLE "ReviewPublicationReceiptV2" (
    "receiptId" TEXT NOT NULL,
    "publicationAttemptId" TEXT NOT NULL,
    "publicationOperationId" TEXT NOT NULL,
    "completionRequestIdHash" TEXT NOT NULL,
    "completionRequestHash" TEXT NOT NULL,
    "completionFingerprint" TEXT NOT NULL,
    "canonicalEffectId" TEXT NOT NULL,
    "canonicalExternalObjectId" TEXT NOT NULL,
    "receiptHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewPublicationReceiptV2_pkey" PRIMARY KEY ("publicationOperationId")
);

-- CreateTable
CREATE TABLE "ReviewPublicationAuditTombstoneV2" (
    "tombstoneId" TEXT NOT NULL,
    "publicationAttemptId" TEXT NOT NULL,
    "publicationOperationId" TEXT NOT NULL,
    "reviewRevisionHash" TEXT NOT NULL,
    "markerHash" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "knownExternalObjectIds" TEXT[],
    "finalOutcome" "ReviewPublicationTerminalOutcomeV2" NOT NULL,
    "finalReason" TEXT NOT NULL,
    "lastErrorCode" TEXT,
    "terminalizedBy" TEXT NOT NULL,
    "terminalizedAt" TIMESTAMP(3) NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewPublicationAuditTombstoneV2_pkey" PRIMARY KEY ("tombstoneId")
);

-- CreateTable
CREATE TABLE "ReviewPublicationOutcomeCorrectionV2" (
    "correctionId" TEXT NOT NULL,
    "publicationAttemptId" TEXT NOT NULL,
    "correctionOrdinal" INTEGER NOT NULL,
    "priorOutcome" "ReviewPublicationTerminalOutcomeV2" NOT NULL,
    "correctedOutcome" "ReviewPublicationTerminalOutcomeV2" NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "safeReason" TEXT NOT NULL,
    "correctedBy" TEXT NOT NULL,
    "correctedAt" TIMESTAMP(3) NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewPublicationOutcomeCorrectionV2_pkey" PRIMARY KEY ("correctionId")
);

-- CreateTable
CREATE TABLE "ReviewCompletionProcess" (
    "executionId" TEXT NOT NULL,
    "processVersion" BIGINT NOT NULL DEFAULT 1,
    "finalizedArtifactId" TEXT NOT NULL,
    "publicationAttemptId" TEXT,
    "snapshotCommitReceiptId" TEXT,
    "state" "ReviewCompletionProcessStateV2" NOT NULL,
    "lastWakeupKind" "ReviewCompletionWakeupKindV2" NOT NULL,
    "lastWakeupAt" TIMESTAMP(3) NOT NULL,
    "nextActionAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastSafeReason" TEXT,
    "claimId" TEXT,
    "claimOwnerIdHash" TEXT,
    "claimFencingToken" BIGINT,
    "claimUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewCompletionProcess_pkey" PRIMARY KEY ("executionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewProtocolLimitsV2_limitsDigest_key" ON "ReviewProtocolLimitsV2"("limitsDigest");

-- CreateIndex
CREATE INDEX "ReviewProtocolLimitsV2_registeredAt_protocolLimitsProfileId_idx" ON "ReviewProtocolLimitsV2"("registeredAt", "protocolLimitsProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewOperationalSloProfileV2_sloDigest_key" ON "ReviewOperationalSloProfileV2"("sloDigest");

-- CreateIndex
CREATE INDEX "ReviewOperationalSloProfileV2_registeredAt_operationalSloPr_idx" ON "ReviewOperationalSloProfileV2"("registeredAt", "operationalSloProfileId");

-- CreateIndex
CREATE INDEX "ProducerRelease_state_registeredAt_idx" ON "ProducerRelease"("state", "registeredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProducerRelease_distributionKind_actionCommitSha_runtimeCom_key" ON "ProducerRelease"("distributionKind", "actionCommitSha", "runtimeCommitSha", "wrapperEntrypointDigest", "runtimeEntrypointDigest", "schemaDigest", "capabilityProfile", "protocolLimitsProfileId", "operationalSloProfileId");

-- CreateIndex
CREATE INDEX "ScmRepositoryIdentity_currentWorkspaceId_currentRepositoryC_idx" ON "ScmRepositoryIdentity"("currentWorkspaceId", "currentRepositoryConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "ScmRepositoryIdentity_provider_normalizedSourceBaseUrl_exte_key" ON "ScmRepositoryIdentity"("provider", "normalizedSourceBaseUrl", "externalRepositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ScmRepositoryIdentity_currentRepositoryConnectionId_key" ON "ScmRepositoryIdentity"("currentRepositoryConnectionId");

-- CreateIndex
CREATE INDEX "ReviewMutationAuthority_mode_drainNotBefore_idx" ON "ReviewMutationAuthority"("mode", "drainNotBefore");

-- CreateIndex
CREATE INDEX "ReviewSafetyPolicy_workspaceId_repositoryConnectionId_capab_idx" ON "ReviewSafetyPolicy"("workspaceId", "repositoryConnectionId", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewSafetyPolicy_policyScope_capability_workspaceId_repos_key" ON "ReviewSafetyPolicy"("policyScope", "capability", "workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewSafetyPolicySelector_policyId_providerKind_taskKind_key" ON "ReviewSafetyPolicySelector"("policyId", "providerKind", "taskKind");

-- CreateIndex
CREATE INDEX "ReviewSafetyEmergencyControl_stopped_updatedAt_idx" ON "ReviewSafetyEmergencyControl"("stopped", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewSafetyEmergencyControl_policyScope_workspaceId_reposi_key" ON "ReviewSafetyEmergencyControl"("policyScope", "workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewRunAuthorization_oidcReplayKeyHash_key" ON "ReviewRunAuthorization"("oidcReplayKeyHash");

-- CreateIndex
CREATE INDEX "ReviewRunAuthorization_repositoryConnectionId_pullRequestNu_idx" ON "ReviewRunAuthorization"("repositoryConnectionId", "pullRequestNumber", "state", "expiresAt");

-- CreateIndex
CREATE INDEX "ReviewRunAuthorization_producerReleaseId_state_idx" ON "ReviewRunAuthorization"("producerReleaseId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewRunAuthorization_workspaceId_repositoryConnectionId_s_key" ON "ReviewRunAuthorization"("workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId", "sourceRunId", "sourceRunAttempt", "protocolOfferHash");

-- CreateIndex
CREATE INDEX "ReviewEvidenceObservation_workspaceId_repositoryConnectionI_idx" ON "ReviewEvidenceObservation"("workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId", "pullRequestNumber", "trustDomain", "providerInvocationKey", "reuseExpiresAt");

-- CreateIndex
CREATE INDEX "ReviewEvidenceObservation_reuseExpiresAt_observationId_idx" ON "ReviewEvidenceObservation"("reuseExpiresAt", "observationId");

-- CreateIndex
CREATE INDEX "ReviewEvidenceObservation_retainUntil_observationId_idx" ON "ReviewEvidenceObservation"("retainUntil", "observationId");

-- CreateIndex
CREATE INDEX "ReviewEvidenceObservation_sourceExecutionId_idx" ON "ReviewEvidenceObservation"("sourceExecutionId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewEvidenceObservation_sourceExecutionId_providerVoteIde_key" ON "ReviewEvidenceObservation"("sourceExecutionId", "providerVoteIdentityHash", "attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewRequestedIntent_deliveryIdentityHash_key" ON "ReviewRequestedIntent"("deliveryIdentityHash");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewRequestedIntent_claimId_key" ON "ReviewRequestedIntent"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewRequestedIntent_claimFencingToken_key" ON "ReviewRequestedIntent"("claimFencingToken");

-- CreateIndex
CREATE INDEX "ReviewRequestedIntent_state_notBefore_requestId_idx" ON "ReviewRequestedIntent"("state", "notBefore", "requestId");

-- CreateIndex
CREATE INDEX "ReviewRequestedIntent_workspaceId_repositoryConnectionId_sc_idx" ON "ReviewRequestedIntent"("workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId", "pullRequestNumber", "state");

-- CreateIndex
CREATE INDEX "ReviewRequestedIntent_claimUntil_requestId_idx" ON "ReviewRequestedIntent"("claimUntil", "requestId");

-- CreateIndex
CREATE INDEX "ReviewExecutionStreamV2_activeExecutionId_idx" ON "ReviewExecutionStreamV2"("activeExecutionId");

-- CreateIndex
CREATE INDEX "ReviewExecutionStreamV2_preparedExecutionId_idx" ON "ReviewExecutionStreamV2"("preparedExecutionId");

-- CreateIndex
CREATE INDEX "ReviewExecutionV2_workspaceId_repositoryConnectionId_pullRe_idx" ON "ReviewExecutionV2"("workspaceId", "repositoryConnectionId", "pullRequestNumber", "state");

-- CreateIndex
CREATE INDEX "ReviewExecutionV2_retainUntil_executionId_idx" ON "ReviewExecutionV2"("retainUntil", "executionId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewExecutionV2_workspaceId_repositoryConnectionId_scmRep_key" ON "ReviewExecutionV2"("workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId", "pullRequestNumber", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewExecutionV2_authorizationId_startIdentityHash_key" ON "ReviewExecutionV2"("authorizationId", "startIdentityHash");

-- CreateIndex
CREATE INDEX "ReviewExecutionWorkSlotV2_executionId_state_idx" ON "ReviewExecutionWorkSlotV2"("executionId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewExecutionWorkSlotV2_executionId_planOrdinal_key" ON "ReviewExecutionWorkSlotV2"("executionId", "planOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewExecutionWorkSlotV2_executionId_taskKind_providerVote_key" ON "ReviewExecutionWorkSlotV2"("executionId", "taskKind", "providerVoteIdentityHash", "shardKey");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewInvocationLeaseV2_attemptId_key" ON "ReviewInvocationLeaseV2"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewInvocationLeaseV2_leaseCapabilityId_key" ON "ReviewInvocationLeaseV2"("leaseCapabilityId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewInvocationLeaseV2_fencingToken_key" ON "ReviewInvocationLeaseV2"("fencingToken");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewInvocationLeaseTombstoneV2_leaseCapabilityId_key" ON "ReviewInvocationLeaseTombstoneV2"("leaseCapabilityId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewInvocationLeaseTombstoneV2_fencingToken_key" ON "ReviewInvocationLeaseTombstoneV2"("fencingToken");

-- CreateIndex
CREATE INDEX "ReviewInvocationLeaseTombstoneV2_compactedAt_leaseId_idx" ON "ReviewInvocationLeaseTombstoneV2"("compactedAt", "leaseId");

-- CreateIndex
CREATE INDEX "ReviewInvocationLeaseV2_expiresAt_leaseId_idx" ON "ReviewInvocationLeaseV2"("expiresAt", "leaseId");

-- CreateIndex
CREATE INDEX "ReviewInvocationLeaseV2_workspaceId_executionGeneration_idx" ON "ReviewInvocationLeaseV2"("workspaceId", "executionGeneration");

-- CreateIndex
CREATE INDEX "ReviewInvocationLeaseV2_executionId_workSlotId_state_idx" ON "ReviewInvocationLeaseV2"("executionId", "workSlotId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewInvocationLeaseV2_workspaceId_repositoryConnectionId__key" ON "ReviewInvocationLeaseV2"("workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId", "pullRequestNumber", "executionGeneration", "providerInvocationKey", "acquireRequestIdHash");

-- CreateIndex
CREATE INDEX "ReviewExecutionObservationRefV2_observationId_idx" ON "ReviewExecutionObservationRefV2"("observationId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewExecutionObservationRefV2_executionId_workSlotId_key" ON "ReviewExecutionObservationRefV2"("executionId", "workSlotId");

-- CreateIndex
CREATE UNIQUE INDEX "FinalizedReviewProjectionArtifactV2_executionId_key" ON "FinalizedReviewProjectionArtifactV2"("executionId");

-- CreateIndex
CREATE INDEX "FinalizedReviewProjectionArtifactV2_retainUntil_artifactId_idx" ON "FinalizedReviewProjectionArtifactV2"("retainUntil", "artifactId");

-- CreateIndex
CREATE INDEX "FinalizedReviewProjectionArtifactV2_createdAt_executionId_idx" ON "FinalizedReviewProjectionArtifactV2"("createdAt", "executionId");

-- CreateIndex
CREATE INDEX "ReviewSnapshotCommitReceiptV2_retainUntil_receiptId_idx" ON "ReviewSnapshotCommitReceiptV2"("retainUntil", "receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewSnapshotCommitReceiptV2_sourceExecutionId_sourceArtif_key" ON "ReviewSnapshotCommitReceiptV2"("sourceExecutionId", "sourceArtifactHash");

-- CreateIndex
CREATE INDEX "ReviewPublicationAttemptV2_state_publicationNotAfter_idx" ON "ReviewPublicationAttemptV2"("state", "publicationNotAfter");

-- CreateIndex
CREATE INDEX "ReviewPublicationAttemptV2_retainUntil_publicationAttemptId_idx" ON "ReviewPublicationAttemptV2"("retainUntil", "publicationAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPublicationAttemptV2_workspaceId_repositoryConnection_key" ON "ReviewPublicationAttemptV2"("workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId", "pullRequestNumber", "executionId", "generation", "projectionHash");

-- CreateIndex
CREATE INDEX "ReviewPublicationRequestReceiptV2_publicationAttemptId_re_idx" ON "ReviewPublicationRequestReceiptV2"("publicationAttemptId", "requestIdHash");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPublicationClaimTermV2_claimCapabilityId_key" ON "ReviewPublicationClaimTermV2"("claimCapabilityId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPublicationClaimTermV2_fencingToken_key" ON "ReviewPublicationClaimTermV2"("fencingToken");

-- CreateIndex
CREATE INDEX "ReviewPublicationClaimTermV2_publicationAttemptId_state_exp_idx" ON "ReviewPublicationClaimTermV2"("publicationAttemptId", "state", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPublicationClaimTermV2_publicationAttemptId_acquireRe_key" ON "ReviewPublicationClaimTermV2"("publicationAttemptId", "acquireRequestIdHash");

-- CreateIndex
CREATE INDEX "ReviewPublicationOperationV2_state_reconcileUntil_publicati_idx" ON "ReviewPublicationOperationV2"("state", "reconcileUntil", "publicationOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPublicationOperationV2_publicationAttemptId_publicati_key" ON "ReviewPublicationOperationV2"("publicationAttemptId", "publicationKind", "chunkIndex");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPublicationOperationAttemptV2_operationCapabilityId_key" ON "ReviewPublicationOperationAttemptV2"("operationCapabilityId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPublicationOperationAttemptV2_effectReportId_key" ON "ReviewPublicationOperationAttemptV2"("effectReportId");

-- CreateIndex
CREATE INDEX "ReviewPublicationOperationAttemptV2_publicationAttemptId_st_idx" ON "ReviewPublicationOperationAttemptV2"("publicationAttemptId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPublicationOperationAttemptV2_publicationOperationId__key" ON "ReviewPublicationOperationAttemptV2"("publicationOperationId", "claimId", "acquireRequestIdHash");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPublicationOperationAttemptV2_operationAttemptId_effe_key" ON "ReviewPublicationOperationAttemptV2"("operationAttemptId", "effectReportId");

-- CreateIndex
CREATE INDEX "ReviewPublicationExternalEffectV2_publicationOperationId_ef_idx" ON "ReviewPublicationExternalEffectV2"("publicationOperationId", "effectKind", "externalObjectId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPublicationExternalEffectV2_operationAttemptId_effect_key" ON "ReviewPublicationExternalEffectV2"("operationAttemptId", "effectReportId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPublicationReceiptV2_receiptId_key" ON "ReviewPublicationReceiptV2"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPublicationReceiptV2_publicationAttemptId_complet_key" ON "ReviewPublicationReceiptV2"("publicationAttemptId", "completionRequestIdHash");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPublicationAuditTombstoneV2_publicationOperationId_key" ON "ReviewPublicationAuditTombstoneV2"("publicationOperationId");

-- CreateIndex
CREATE INDEX "ReviewPublicationAuditTombstoneV2_retainUntil_tombstoneId_idx" ON "ReviewPublicationAuditTombstoneV2"("retainUntil", "tombstoneId");

-- CreateIndex
CREATE INDEX "ReviewPublicationOutcomeCorrectionV2_retainUntil_correction_idx" ON "ReviewPublicationOutcomeCorrectionV2"("retainUntil", "correctionId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPublicationOutcomeCorrectionV2_publicationAttemptId_c_key" ON "ReviewPublicationOutcomeCorrectionV2"("publicationAttemptId", "correctionOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewCompletionProcess_claimId_key" ON "ReviewCompletionProcess"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewCompletionProcess_claimFencingToken_key" ON "ReviewCompletionProcess"("claimFencingToken");

-- CreateIndex
CREATE INDEX "ReviewCompletionProcess_state_nextActionAt_executionId_idx" ON "ReviewCompletionProcess"("state", "nextActionAt", "executionId");

-- CreateIndex
CREATE INDEX "ReviewCompletionProcess_retainUntil_executionId_idx" ON "ReviewCompletionProcess"("retainUntil", "executionId");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryConnection_id_workspaceId_scmRepositoryIdentityId_key" ON "RepositoryConnection"("id", "workspaceId", "scmRepositoryIdentityId");

-- CreateIndex
CREATE INDEX "ReviewSnapshot_sourceExecutionId_idx" ON "ReviewSnapshot"("sourceExecutionId");

-- Fencing sequences are never cycled or reset. Nullable claim terms allocate with
-- nextval() inside their atomic command transaction.
CREATE SEQUENCE "ReviewRequestedIntent_claimFencingToken_seq" AS BIGINT NO CYCLE;
CREATE SEQUENCE "ReviewInvocationLeaseV2_fencingToken_seq" AS BIGINT NO CYCLE;
CREATE SEQUENCE "ReviewPublicationClaimTermV2_fencingToken_seq" AS BIGINT NO CYCLE;
CREATE SEQUENCE "ReviewCompletionProcess_claimFencingToken_seq" AS BIGINT NO CYCLE;

ALTER TABLE "ReviewInvocationLeaseV2"
  ALTER COLUMN "fencingToken" SET DEFAULT nextval('"ReviewInvocationLeaseV2_fencingToken_seq"');
ALTER TABLE "ReviewPublicationClaimTermV2"
  ALTER COLUMN "fencingToken" SET DEFAULT nextval('"ReviewPublicationClaimTermV2_fencingToken_seq"');

-- Partial uniqueness expresses active ownership and scoped singleton semantics.
CREATE UNIQUE INDEX "ReviewExecutionV2_one_planned_per_scope"
  ON "ReviewExecutionV2" ("workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId", "pullRequestNumber")
  WHERE "state" = 'planned';
CREATE UNIQUE INDEX "ReviewRequestedIntent_one_pending_per_scope"
  ON "ReviewRequestedIntent" ("workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId", "pullRequestNumber")
  WHERE "state" = 'pending_dispatch';
CREATE UNIQUE INDEX "ReviewInvocationLeaseV2_one_active_provider_invocation"
  ON "ReviewInvocationLeaseV2" ("workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId", "pullRequestNumber", "providerInvocationKey")
  WHERE "state" = 'active';
CREATE UNIQUE INDEX "ReviewInvocationLeaseV2_one_active_work_slot"
  ON "ReviewInvocationLeaseV2" ("executionId", "workSlotId")
  WHERE "state" = 'active';
CREATE UNIQUE INDEX "ReviewPublicationClaimTermV2_one_active_claim"
  ON "ReviewPublicationClaimTermV2" ("publicationAttemptId")
  WHERE "state" = 'active';
CREATE UNIQUE INDEX "ReviewPublicationExternalEffectV2_owned_object_unique"
  ON "ReviewPublicationExternalEffectV2" ("publicationOperationId", "effectKind", "externalObjectId")
  WHERE "externalObjectId" IS NOT NULL;
CREATE UNIQUE INDEX "ReviewSafetyPolicy_global_capability_unique"
  ON "ReviewSafetyPolicy" ("capability") WHERE "policyScope" = 'global';
CREATE UNIQUE INDEX "ReviewSafetyPolicy_workspace_capability_unique"
  ON "ReviewSafetyPolicy" ("workspaceId", "capability") WHERE "policyScope" = 'workspace';
CREATE UNIQUE INDEX "ReviewSafetyPolicy_repository_capability_unique"
  ON "ReviewSafetyPolicy" ("workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId", "capability") WHERE "policyScope" = 'repository';
CREATE UNIQUE INDEX "ReviewSafetyEmergencyControl_global_unique"
  ON "ReviewSafetyEmergencyControl" ((1)) WHERE "policyScope" = 'global';
CREATE UNIQUE INDEX "ReviewSafetyEmergencyControl_workspace_unique"
  ON "ReviewSafetyEmergencyControl" ("workspaceId") WHERE "policyScope" = 'workspace';
CREATE UNIQUE INDEX "ReviewSafetyEmergencyControl_repository_unique"
  ON "ReviewSafetyEmergencyControl" ("workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId") WHERE "policyScope" = 'repository';

-- Domain checks fail closed before any v2 writer is enabled.
ALTER TABLE "ReviewProtocolLimitsV2" ADD CONSTRAINT "ReviewProtocolLimitsV2_positive_limits"
  CHECK (
    "maxWorkSlots" > 0 AND "maxAttemptsPerSlot" > 0 AND
    "maxObservationBytes" > 0 AND "maxObservationFindings" > 0 AND
    "maxProjectionBytes" > 0 AND "maxProjectionFindings" > 0 AND
    "maxPublicationOperations" > 0 AND "maxPublicationChunks" > 0 AND
    "maxPublicationBodyBytes" > 0 AND "maxRequestBatchSize" > 0 AND
    "maxLeaseDurationMs" > 0 AND
    "maxResultReportDurationMs" >= "maxLeaseDurationMs" AND
    "maxReconciliationDurationMs" >= "maxResultReportDurationMs"
  );
ALTER TABLE "ReviewOperationalSloProfileV2" ADD CONSTRAINT "ReviewOperationalSloProfileV2_positive_slos"
  CHECK (
    "integrationEventDeliveryMs" > 0 AND "outboxClaimAgeMs" > 0 AND
    "missingCompletionProcessMs" > 0 AND "dueCompletionProcessMs" > 0 AND
    "publicationReconciliationMs" > 0 AND "v1DrainMs" > 0 AND
    "admissionMs" > 0 AND "pruningBacklogAgeMs" > 0
  );
ALTER TABLE "ReviewMutationAuthority" ADD CONSTRAINT "ReviewMutationAuthority_nonnegative_fences"
  CHECK ("version" > 0 AND "epoch" >= 0);
ALTER TABLE "ReviewSafetyPolicy" ADD CONSTRAINT "ReviewSafetyPolicy_valid_scope"
  CHECK (
    ("policyScope" = 'global' AND "workspaceId" IS NULL AND "repositoryConnectionId" IS NULL AND "scmRepositoryIdentityId" IS NULL) OR
    ("policyScope" = 'workspace' AND "workspaceId" IS NOT NULL AND "repositoryConnectionId" IS NULL AND "scmRepositoryIdentityId" IS NULL) OR
    ("policyScope" = 'repository' AND "workspaceId" IS NOT NULL AND "repositoryConnectionId" IS NOT NULL AND "scmRepositoryIdentityId" IS NOT NULL)
  );
ALTER TABLE "ReviewSafetyEmergencyControl" ADD CONSTRAINT "ReviewSafetyEmergencyControl_valid_scope"
  CHECK (
    ("policyScope" = 'global' AND "workspaceId" IS NULL AND "repositoryConnectionId" IS NULL AND "scmRepositoryIdentityId" IS NULL) OR
    ("policyScope" = 'workspace' AND "workspaceId" IS NOT NULL AND "repositoryConnectionId" IS NULL AND "scmRepositoryIdentityId" IS NULL) OR
    ("policyScope" = 'repository' AND "workspaceId" IS NOT NULL AND "repositoryConnectionId" IS NOT NULL AND "scmRepositoryIdentityId" IS NOT NULL)
  );
ALTER TABLE "ReviewRunAuthorization" ADD CONSTRAINT "ReviewRunAuthorization_valid_lifetime"
  CHECK ("version" > 0 AND "pullRequestNumber" > 0 AND "mutationEpoch" > 0 AND "expiresAt" > "createdAt" AND "maxExpiresAt" >= "expiresAt");
ALTER TABLE "ReviewEvidenceObservation" ADD CONSTRAINT "ReviewEvidenceObservation_valid_retention"
  CHECK ("pullRequestNumber" > 0 AND "byteCount" >= 0 AND "findingCount" >= 0 AND "transportAttemptCount" > 0 AND "reuseExpiresAt" > "createdAt" AND "retainUntil" >= "reuseExpiresAt");
ALTER TABLE "ReviewRequestedIntent" ADD CONSTRAINT "ReviewRequestedIntent_valid_claim"
  CHECK (("claimId" IS NULL AND "claimOwnerIdHash" IS NULL AND "claimFencingToken" IS NULL AND "claimedAt" IS NULL AND "claimUntil" IS NULL) OR ("claimId" IS NOT NULL AND "claimOwnerIdHash" IS NOT NULL AND "claimFencingToken" IS NOT NULL AND "claimedAt" IS NOT NULL AND "claimUntil" > "claimedAt"));
ALTER TABLE "ReviewInvocationLeaseV2" ADD CONSTRAINT "ReviewInvocationLeaseV2_valid_purpose"
  CHECK (("purpose" = 'provider_execution' AND "attemptId" IS NOT NULL AND "sourceObservationId" IS NULL) OR ("purpose" = 'observation_adoption' AND "attemptId" IS NULL AND "sourceObservationId" IS NOT NULL));
ALTER TABLE "ReviewExecutionWorkSlotV2" ADD CONSTRAINT "ReviewExecutionWorkSlotV2_valid_plan_ordinal"
  CHECK ("planOrdinal" >= 0);
ALTER TABLE "ReviewInvocationLeaseV2" ADD CONSTRAINT "ReviewInvocationLeaseV2_valid_deadlines"
  CHECK (
    "attemptOrdinal" >= 0 AND
    (
      ("purpose" = 'provider_execution' AND "expiresAt" > "acquiredAt" AND "resultReportUntil" >= "expiresAt") OR
      ("purpose" = 'observation_adoption' AND "expiresAt" = "acquiredAt" AND "resultReportUntil" = "acquiredAt")
    ) AND
    "retainUntil" >= "resultReportUntil"
  );
ALTER TABLE "ReviewSnapshot" ADD CONSTRAINT "ReviewSnapshot_v2_columns_complete"
  CHECK ("schemaVersion" <> 2 OR ("scmRepositoryIdentityId" IS NOT NULL AND "sourceExecutionId" IS NOT NULL AND "sourceExecutionGeneration" IS NOT NULL AND "sourceArtifactHash" IS NOT NULL AND "sourceReviewRevisionHash" IS NOT NULL AND "publicationReceiptSetHash" IS NOT NULL));
ALTER TABLE "ReviewPublicationAttemptV2" ADD CONSTRAINT "ReviewPublicationAttemptV2_terminal_outcome_consistent"
  CHECK (("state" = 'terminal' AND "terminalOutcome" IS NOT NULL) OR ("state" <> 'terminal' AND "terminalOutcome" IS NULL));
ALTER TABLE "ReviewPublicationClaimTermV2" ADD CONSTRAINT "ReviewPublicationClaimTermV2_valid_deadlines"
  CHECK ("expiresAt" > "acquiredAt" AND "reportUntil" >= "expiresAt" AND "retainUntil" >= "reportUntil");
ALTER TABLE "ReviewPublicationOperationV2" ADD CONSTRAINT "ReviewPublicationOperationV2_valid_chunk"
  CHECK ("chunkIndex" >= 0);
ALTER TABLE "ReviewPublicationOperationAttemptV2" ADD CONSTRAINT "ReviewPublicationOperationAttemptV2_valid_deadlines"
  CHECK ("effectReportUntil" > "startedAt" AND "retainUntil" >= "effectReportUntil");
ALTER TABLE "ReviewPublicationOutcomeCorrectionV2" ADD CONSTRAINT "ReviewPublicationOutcomeCorrectionV2_valid_ordinal"
  CHECK ("correctionOrdinal" > 0);
ALTER TABLE "ReviewCompletionProcess" ADD CONSTRAINT "ReviewCompletionProcess_valid_claim"
  CHECK (("claimId" IS NULL AND "claimOwnerIdHash" IS NULL AND "claimFencingToken" IS NULL AND "claimUntil" IS NULL) OR ("claimId" IS NOT NULL AND "claimOwnerIdHash" IS NOT NULL AND "claimFencingToken" IS NOT NULL AND "claimUntil" IS NOT NULL));

-- Additive referential constraints are installed NOT VALID and validated by the
-- advisory-locked review-v2 migration job before any writer is promoted.
ALTER TABLE "RepositoryConnection" ADD CONSTRAINT "RepositoryConnection_scmRepositoryIdentityId_fkey" FOREIGN KEY ("scmRepositoryIdentityId") REFERENCES "ScmRepositoryIdentity"("scmRepositoryIdentityId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ScmRepositoryIdentity" ADD CONSTRAINT "ScmRepositoryIdentity_current_binding_fkey" FOREIGN KEY ("currentRepositoryConnectionId", "currentWorkspaceId", "scmRepositoryIdentityId") REFERENCES "RepositoryConnection"("id", "workspaceId", "scmRepositoryIdentityId") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE "ReviewMutationAuthority" ADD CONSTRAINT "ReviewMutationAuthority_scmRepositoryIdentityId_fkey" FOREIGN KEY ("scmRepositoryIdentityId") REFERENCES "ScmRepositoryIdentity"("scmRepositoryIdentityId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewSafetyPolicySelector" ADD CONSTRAINT "ReviewSafetyPolicySelector_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "ReviewSafetyPolicy"("policyId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewSafetyPolicy" ADD CONSTRAINT "ReviewSafetyPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewSafetyPolicy" ADD CONSTRAINT "ReviewSafetyPolicy_repository_scope_fkey" FOREIGN KEY ("repositoryConnectionId", "workspaceId", "scmRepositoryIdentityId") REFERENCES "RepositoryConnection"("id", "workspaceId", "scmRepositoryIdentityId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewSafetyEmergencyControl" ADD CONSTRAINT "ReviewSafetyEmergencyControl_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewSafetyEmergencyControl" ADD CONSTRAINT "ReviewSafetyEmergencyControl_repository_scope_fkey" FOREIGN KEY ("repositoryConnectionId", "workspaceId", "scmRepositoryIdentityId") REFERENCES "RepositoryConnection"("id", "workspaceId", "scmRepositoryIdentityId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ProducerRelease" ADD CONSTRAINT "ProducerRelease_protocolLimitsProfileId_fkey" FOREIGN KEY ("protocolLimitsProfileId") REFERENCES "ReviewProtocolLimitsV2"("protocolLimitsProfileId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ProducerRelease" ADD CONSTRAINT "ProducerRelease_operationalSloProfileId_fkey" FOREIGN KEY ("operationalSloProfileId") REFERENCES "ReviewOperationalSloProfileV2"("operationalSloProfileId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewRunAuthorization" ADD CONSTRAINT "ReviewRunAuthorization_repository_scope_fkey" FOREIGN KEY ("repositoryConnectionId", "workspaceId", "scmRepositoryIdentityId") REFERENCES "RepositoryConnection"("id", "workspaceId", "scmRepositoryIdentityId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewRunAuthorization" ADD CONSTRAINT "ReviewRunAuthorization_producerReleaseId_fkey" FOREIGN KEY ("producerReleaseId") REFERENCES "ProducerRelease"("producerReleaseId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewEvidenceObservation" ADD CONSTRAINT "ReviewEvidenceObservation_repository_scope_fkey" FOREIGN KEY ("repositoryConnectionId", "workspaceId", "scmRepositoryIdentityId") REFERENCES "RepositoryConnection"("id", "workspaceId", "scmRepositoryIdentityId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewEvidenceObservation" ADD CONSTRAINT "ReviewEvidenceObservation_sourceAuthorizationId_fkey" FOREIGN KEY ("sourceAuthorizationId") REFERENCES "ReviewRunAuthorization"("authorizationId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewEvidenceObservation" ADD CONSTRAINT "ReviewEvidenceObservation_producerReleaseId_fkey" FOREIGN KEY ("producerReleaseId") REFERENCES "ProducerRelease"("producerReleaseId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewRequestedIntent" ADD CONSTRAINT "ReviewRequestedIntent_repository_scope_fkey" FOREIGN KEY ("repositoryConnectionId", "workspaceId", "scmRepositoryIdentityId") REFERENCES "RepositoryConnection"("id", "workspaceId", "scmRepositoryIdentityId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewRequestedIntent" ADD CONSTRAINT "ReviewRequestedIntent_supersededByRequestId_fkey" FOREIGN KEY ("supersededByRequestId") REFERENCES "ReviewRequestedIntent"("requestId") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE "ReviewRequestedIntent" ADD CONSTRAINT "ReviewRequestedIntent_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "ReviewRunAuthorization"("authorizationId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewRequestedIntent" ADD CONSTRAINT "ReviewRequestedIntent_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ReviewExecutionV2"("executionId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewExecutionStreamV2" ADD CONSTRAINT "ReviewExecutionStreamV2_repository_scope_fkey" FOREIGN KEY ("repositoryConnectionId", "workspaceId", "scmRepositoryIdentityId") REFERENCES "RepositoryConnection"("id", "workspaceId", "scmRepositoryIdentityId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewExecutionV2" ADD CONSTRAINT "ReviewExecutionV2_repository_scope_fkey" FOREIGN KEY ("repositoryConnectionId", "workspaceId", "scmRepositoryIdentityId") REFERENCES "RepositoryConnection"("id", "workspaceId", "scmRepositoryIdentityId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewExecutionV2" ADD CONSTRAINT "ReviewExecutionV2_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "ReviewRunAuthorization"("authorizationId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewExecutionV2" ADD CONSTRAINT "ReviewExecutionV2_producerReleaseId_fkey" FOREIGN KEY ("producerReleaseId") REFERENCES "ProducerRelease"("producerReleaseId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewExecutionWorkSlotV2" ADD CONSTRAINT "ReviewExecutionWorkSlotV2_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ReviewExecutionV2"("executionId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewInvocationLeaseV2" ADD CONSTRAINT "ReviewInvocationLeaseV2_execution_work_slot_fkey" FOREIGN KEY ("executionId", "workSlotId") REFERENCES "ReviewExecutionWorkSlotV2"("executionId", "workSlotId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewExecutionObservationRefV2" ADD CONSTRAINT "ReviewExecutionObservationRefV2_execution_work_slot_fkey" FOREIGN KEY ("executionId", "workSlotId") REFERENCES "ReviewExecutionWorkSlotV2"("executionId", "workSlotId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewExecutionObservationRefV2" ADD CONSTRAINT "ReviewExecutionObservationRefV2_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "ReviewEvidenceObservation"("observationId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "FinalizedReviewProjectionArtifactV2" ADD CONSTRAINT "FinalizedReviewProjectionArtifactV2_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ReviewExecutionV2"("executionId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewSnapshot" ADD CONSTRAINT "ReviewSnapshot_v2_repository_scope_fkey" FOREIGN KEY ("repositoryId", "workspaceId", "scmRepositoryIdentityId") REFERENCES "RepositoryConnection"("id", "workspaceId", "scmRepositoryIdentityId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewSnapshot" ADD CONSTRAINT "ReviewSnapshot_sourceExecutionId_fkey" FOREIGN KEY ("sourceExecutionId") REFERENCES "ReviewExecutionV2"("executionId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewSnapshotCommitReceiptV2" ADD CONSTRAINT "ReviewSnapshotCommitReceiptV2_sourceExecutionId_fkey" FOREIGN KEY ("sourceExecutionId") REFERENCES "ReviewExecutionV2"("executionId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewPublicationAttemptV2" ADD CONSTRAINT "ReviewPublicationAttemptV2_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ReviewExecutionV2"("executionId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewPublicationAttemptV2" ADD CONSTRAINT "ReviewPublicationAttemptV2_repository_scope_fkey" FOREIGN KEY ("repositoryConnectionId", "workspaceId", "scmRepositoryIdentityId") REFERENCES "RepositoryConnection"("id", "workspaceId", "scmRepositoryIdentityId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewPublicationAttemptV2" ADD CONSTRAINT "ReviewPublicationAttemptV2_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "ReviewRunAuthorization"("authorizationId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewPublicationAttemptV2" ADD CONSTRAINT "ReviewPublicationAttemptV2_producerReleaseId_fkey" FOREIGN KEY ("producerReleaseId") REFERENCES "ProducerRelease"("producerReleaseId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewPublicationClaimTermV2" ADD CONSTRAINT "ReviewPublicationClaimTermV2_publicationAttemptId_fkey" FOREIGN KEY ("publicationAttemptId") REFERENCES "ReviewPublicationAttemptV2"("publicationAttemptId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewPublicationOperationV2" ADD CONSTRAINT "ReviewPublicationOperationV2_publicationAttemptId_fkey" FOREIGN KEY ("publicationAttemptId") REFERENCES "ReviewPublicationAttemptV2"("publicationAttemptId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewPublicationOperationAttemptV2" ADD CONSTRAINT "ReviewPublicationOperationAttemptV2_publicationOperationId_fkey" FOREIGN KEY ("publicationOperationId") REFERENCES "ReviewPublicationOperationV2"("publicationOperationId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewPublicationOperationAttemptV2" ADD CONSTRAINT "ReviewPublicationOperationAttemptV2_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ReviewPublicationClaimTermV2"("claimId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewPublicationExternalEffectV2" ADD CONSTRAINT "ReviewPublicationExternalEffectV2_operationAttemptId_fkey" FOREIGN KEY ("operationAttemptId") REFERENCES "ReviewPublicationOperationAttemptV2"("operationAttemptId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewPublicationReceiptV2" ADD CONSTRAINT "ReviewPublicationReceiptV2_publicationOperationId_fkey" FOREIGN KEY ("publicationOperationId") REFERENCES "ReviewPublicationOperationV2"("publicationOperationId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewPublicationAuditTombstoneV2" ADD CONSTRAINT "ReviewPublicationAuditTombstoneV2_publicationOperationId_fkey" FOREIGN KEY ("publicationOperationId") REFERENCES "ReviewPublicationOperationV2"("publicationOperationId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewPublicationOutcomeCorrectionV2" ADD CONSTRAINT "ReviewPublicationOutcomeCorrectionV2_publicationAttemptId_fkey" FOREIGN KEY ("publicationAttemptId") REFERENCES "ReviewPublicationAttemptV2"("publicationAttemptId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewCompletionProcess" ADD CONSTRAINT "ReviewCompletionProcess_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ReviewExecutionV2"("executionId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewCompletionProcess" ADD CONSTRAINT "ReviewCompletionProcess_finalizedArtifactId_fkey" FOREIGN KEY ("finalizedArtifactId") REFERENCES "FinalizedReviewProjectionArtifactV2"("artifactId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewCompletionProcess" ADD CONSTRAINT "ReviewCompletionProcess_publicationAttemptId_fkey" FOREIGN KEY ("publicationAttemptId") REFERENCES "ReviewPublicationAttemptV2"("publicationAttemptId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReviewCompletionProcess" ADD CONSTRAINT "ReviewCompletionProcess_snapshotCommitReceiptId_fkey" FOREIGN KEY ("snapshotCommitReceiptId") REFERENCES "ReviewSnapshotCommitReceiptV2"("receiptId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

INSERT INTO "ReviewSafetyEmergencyControl" (
  "emergencyControlId", "policyScope", "version", "stopped", "reason", "updatedBy", "updatedAt"
) VALUES (
  'global-review-v2', 'global', 1, TRUE, 'review_v2_not_promoted', 'migration:000029', CURRENT_TIMESTAMP
);

CREATE TABLE "ReviewV2MigrationLedger" (
  "migrationVersion" TEXT NOT NULL,
  "stepName" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "schemaDigest" TEXT NOT NULL,
  "checkpoint" JSONB,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  CONSTRAINT "ReviewV2MigrationLedger_pkey" PRIMARY KEY ("migrationVersion", "stepName"),
  CONSTRAINT "ReviewV2MigrationLedger_status_check" CHECK ("status" IN ('running', 'completed', 'failed'))
);
CREATE INDEX "ReviewV2MigrationLedger_status_updatedAt_idx"
  ON "ReviewV2MigrationLedger" ("status", "updatedAt");

CREATE TABLE "ReviewV2MigrationQuarantine" (
  "quarantineId" BIGSERIAL NOT NULL,
  "migrationVersion" TEXT NOT NULL,
  "stepName" TEXT NOT NULL,
  "repositoryConnectionId" TEXT NOT NULL,
  "safeReason" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolvedBy" TEXT,
  CONSTRAINT "ReviewV2MigrationQuarantine_pkey" PRIMARY KEY ("quarantineId")
);
CREATE UNIQUE INDEX "ReviewV2MigrationQuarantine_migration_step_repository_key"
  ON "ReviewV2MigrationQuarantine" ("migrationVersion", "stepName", "repositoryConnectionId");
CREATE INDEX "ReviewV2MigrationQuarantine_resolvedAt_quarantineId_idx"
  ON "ReviewV2MigrationQuarantine" ("resolvedAt", "quarantineId");
