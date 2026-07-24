CREATE TYPE "ReviewContextGatewaySessionStateV1" AS ENUM (
  'opened',
  'active',
  'sealed',
  'accepted',
  'rejected',
  'revoked',
  'expired'
);

CREATE TABLE "ReviewContextGatewaySession" (
  "sessionId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "repositoryConnectionId" TEXT NOT NULL,
  "scmRepositoryIdentityId" TEXT NOT NULL,
  "pullRequestNumber" INTEGER NOT NULL,
  "sourceBaseSha" TEXT NOT NULL,
  "sourceMergeBaseSha" TEXT NOT NULL,
  "sourceHeadSha" TEXT NOT NULL,
  "sourceReviewRevisionHash" TEXT NOT NULL,
  "checkoutTreeOid" TEXT NOT NULL,
  "sourceExecutionId" TEXT NOT NULL,
  "sourceWorkSlotId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "sourceLeaseId" TEXT NOT NULL,
  "sourceFencingToken" BIGINT NOT NULL,
  "providerKind" "ReviewProviderKindV2" NOT NULL,
  "requestedModel" TEXT NOT NULL,
  "trustedCapabilityProfile" TEXT NOT NULL,
  "executionProfile" "ProviderExecutionProfileV2" NOT NULL,
  "gatewayBinaryHash" TEXT NOT NULL,
  "gatewayPolicyVersion" TEXT NOT NULL,
  "producerReleaseId" TEXT NOT NULL,
  "selectedProtocolVersion" TEXT NOT NULL,
  "confinementProofHash" TEXT NOT NULL,
  "eventChainSeedHash" TEXT NOT NULL,
  "state" "ReviewContextGatewaySessionStateV1" NOT NULL,
  "eventCount" INTEGER NOT NULL DEFAULT 0,
  "openedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "sealedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),

  CONSTRAINT "ReviewContextGatewaySession_pkey" PRIMARY KEY ("sessionId")
);

CREATE TABLE "ReviewContextDependencyAttestation" (
  "attestationId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "attestationHash" TEXT NOT NULL,
  "manifestVersion" INTEGER NOT NULL,
  "authenticatedChainHash" TEXT NOT NULL,
  "dependencyCount" INTEGER NOT NULL,
  "operationManifestJson" JSONB NOT NULL,
  "actualModel" TEXT NOT NULL,
  "terminalOutcomeHash" TEXT NOT NULL,
  "replayMaterialHash" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL,
  "reuseExpiresAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ReviewContextDependencyAttestation_pkey" PRIMARY KEY ("attestationId")
);

CREATE TABLE "ReviewContextReplayMaterial" (
  "replayMaterialId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "attestationId" TEXT NOT NULL,
  "encryptionAlgorithm" TEXT NOT NULL,
  "encryptionKeyId" TEXT NOT NULL,
  "nonce" BYTEA NOT NULL,
  "authTag" BYTEA NOT NULL,
  "ciphertext" BYTEA NOT NULL,
  "associatedDataHash" TEXT NOT NULL,
  "plaintextHash" TEXT NOT NULL,
  "byteCount" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ReviewContextReplayMaterial_pkey" PRIMARY KEY ("replayMaterialId")
);

CREATE TABLE "ReviewContextTargetReplayProof" (
  "replayProofId" TEXT NOT NULL,
  "sourceAttestationId" TEXT NOT NULL,
  "sourceAttestationHash" TEXT NOT NULL,
  "targetExecutionId" TEXT NOT NULL,
  "targetWorkSlotId" TEXT NOT NULL,
  "targetReviewRevisionHash" TEXT NOT NULL,
  "targetCheckoutTreeOid" TEXT NOT NULL,
  "replayBinaryHash" TEXT NOT NULL,
  "replayPolicyVersion" TEXT NOT NULL,
  "reusePolicyVectorHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ReviewContextTargetReplayProof_pkey" PRIMARY KEY ("replayProofId")
);

ALTER TABLE "ReviewEvidenceObservation"
ADD COLUMN "contextDependencyAttestationId" TEXT,
ADD COLUMN "contextDependencyAttestationHash" TEXT;

ALTER TABLE "ReviewEvidenceObservation"
ADD CONSTRAINT "ReviewEvidenceObservation_context_dependency_pair"
CHECK (
  ("contextDependencyAttestationId" IS NULL AND "contextDependencyAttestationHash" IS NULL)
  OR
  ("contextDependencyAttestationId" IS NOT NULL AND "contextDependencyAttestationHash" IS NOT NULL)
);

CREATE UNIQUE INDEX "ReviewContextGatewaySession_attemptId_key"
ON "ReviewContextGatewaySession"("attemptId");

CREATE INDEX "ReviewContextGatewaySession_scope_state_idx"
ON "ReviewContextGatewaySession"(
  "workspaceId",
  "repositoryConnectionId",
  "pullRequestNumber",
  "state",
  "expiresAt"
);

CREATE INDEX "ReviewContextGatewaySession_execution_slot_idx"
ON "ReviewContextGatewaySession"("sourceExecutionId", "sourceWorkSlotId");

CREATE UNIQUE INDEX "ReviewContextDependencyAttestation_sessionId_key"
ON "ReviewContextDependencyAttestation"("sessionId");

CREATE UNIQUE INDEX "ReviewContextDependencyAttestation_hash_key"
ON "ReviewContextDependencyAttestation"("attestationHash");

CREATE INDEX "ReviewContextDependencyAttestation_expiry_idx"
ON "ReviewContextDependencyAttestation"("reuseExpiresAt", "attestationId");

CREATE UNIQUE INDEX "ReviewContextReplayMaterial_sessionId_key"
ON "ReviewContextReplayMaterial"("sessionId");

CREATE UNIQUE INDEX "ReviewContextReplayMaterial_attestationId_key"
ON "ReviewContextReplayMaterial"("attestationId");

CREATE INDEX "ReviewContextReplayMaterial_expiry_idx"
ON "ReviewContextReplayMaterial"("expiresAt", "replayMaterialId");

CREATE UNIQUE INDEX "ReviewContextTargetReplayProof_target_key"
ON "ReviewContextTargetReplayProof"(
  "sourceAttestationId",
  "targetExecutionId",
  "targetWorkSlotId",
  "targetReviewRevisionHash",
  "reusePolicyVectorHash"
);

CREATE INDEX "ReviewContextTargetReplayProof_target_expiry_idx"
ON "ReviewContextTargetReplayProof"(
  "targetExecutionId",
  "targetWorkSlotId",
  "expiresAt"
);

CREATE INDEX "ReviewContextTargetReplayProof_expiry_idx"
ON "ReviewContextTargetReplayProof"("expiresAt", "replayProofId");

CREATE INDEX "ReviewEvidenceObservation_contextDependencyAttestationId_idx"
ON "ReviewEvidenceObservation"("contextDependencyAttestationId");

ALTER TABLE "ReviewContextDependencyAttestation"
ADD CONSTRAINT "ReviewContextDependencyAttestation_sessionId_fkey"
FOREIGN KEY ("sessionId")
REFERENCES "ReviewContextGatewaySession"("sessionId")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "ReviewEvidenceObservation"
ADD CONSTRAINT "ReviewEvidenceObservation_contextDependencyAttestationId_fkey"
FOREIGN KEY ("contextDependencyAttestationId")
REFERENCES "ReviewContextDependencyAttestation"("attestationId")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "ReviewContextReplayMaterial"
ADD CONSTRAINT "ReviewContextReplayMaterial_sessionId_fkey"
FOREIGN KEY ("sessionId")
REFERENCES "ReviewContextGatewaySession"("sessionId")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "ReviewContextReplayMaterial"
ADD CONSTRAINT "ReviewContextReplayMaterial_attestationId_fkey"
FOREIGN KEY ("attestationId")
REFERENCES "ReviewContextDependencyAttestation"("attestationId")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "ReviewContextTargetReplayProof"
ADD CONSTRAINT "ReviewContextTargetReplayProof_sourceAttestationId_fkey"
FOREIGN KEY ("sourceAttestationId")
REFERENCES "ReviewContextDependencyAttestation"("attestationId")
ON DELETE RESTRICT
ON UPDATE CASCADE;
