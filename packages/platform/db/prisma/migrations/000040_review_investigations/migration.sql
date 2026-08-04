CREATE TYPE "ReviewInvestigationStateV1" AS ENUM (
  'provisional', 'awaiting_turn', 'turn_leased', 'awaiting_critic',
  'ready_to_conclude', 'concluded', 'inconclusive', 'superseded', 'expired'
);
CREATE TYPE "ReviewInvestigationObligationStateV1" AS ENUM (
  'open', 'satisfied', 'unresolvable'
);
CREATE TYPE "ReviewInvestigationObligationKindV1" AS ENUM (
  'inventory_witness', 'changed_content', 'base_content', 'related_manifest',
  'direct_reference_search', 'direct_caller', 'direct_callee', 'test_evidence',
  'schema_contract', 'configuration_contract', 'migration_contract',
  'generated_source', 'dependency_contract', 'side_effect_parity',
  'external_contract', 'binary_artifact', 'context_critic'
);
CREATE TYPE "ReviewInvestigationObligationOriginV1" AS ENUM (
  'coverage_contract', 'deterministic_expansion', 'agent_proposal', 'critic_proposal'
);
CREATE TYPE "ReviewInvestigationRuntimeProfileV1" AS ENUM (
  'gateway_attested_agent_v1', 'orchestrated_tool_loop_v1',
  'preassembled_context_v1', 'prompt_only_v1', 'agentic_unbounded_v1'
);
CREATE TYPE "ReviewInvestigationCriticDecisionV1" AS ENUM (
  'accept', 'veto', 'abstain'
);
CREATE TYPE "ReviewInvestigationConclusionV1" AS ENUM (
  'verified_clean', 'findings', 'inconclusive'
);
CREATE TYPE "ReviewInvestigationTurnPurposeV1" AS ENUM ('discovery', 'critic');
CREATE TYPE "ReviewInvestigationTurnStateV1" AS ENUM (
  'leased', 'committed', 'aborted', 'expired'
);
CREATE TYPE "ReviewInvestigationReceiptKindV1" AS ENUM (
  'blob', 'tree', 'search', 'git_fact', 'relation', 'critic'
);

ALTER TYPE "ProviderExecutionProfileV2" ADD VALUE 'investigation_gateway_v1';

CREATE TABLE "ReviewInvestigation" (
  "investigationId" TEXT NOT NULL,
  "naturalIdentityHash" TEXT NOT NULL,
  "version" BIGINT NOT NULL DEFAULT 1,
  "workspaceId" TEXT NOT NULL,
  "repositoryConnectionId" TEXT NOT NULL,
  "scmRepositoryIdentityId" TEXT NOT NULL,
  "pullRequestNumber" INTEGER NOT NULL,
  "trustDomain" TEXT NOT NULL,
  "baseSha" TEXT NOT NULL,
  "mergeBaseSha" TEXT NOT NULL,
  "headSha" TEXT NOT NULL,
  "reviewRevisionHash" TEXT NOT NULL,
  "executionId" TEXT NOT NULL,
  "workSlotId" TEXT NOT NULL,
  "stableReviewUnitKey" TEXT NOT NULL,
  "providerVoteLaneId" TEXT NOT NULL,
  "providerStrategyId" TEXT NOT NULL,
  "runtimeProfile" "ReviewInvestigationRuntimeProfileV1" NOT NULL,
  "coverageContractVersion" TEXT NOT NULL,
  "expansionRulesVersion" TEXT NOT NULL,
  "criticPolicyVersion" TEXT NOT NULL,
  "gatewayPolicyVersion" TEXT NOT NULL,
  "producerReleaseId" TEXT NOT NULL,
  "runtimeProfileVersion" TEXT NOT NULL,
  "policy" JSONB NOT NULL,
  "state" "ReviewInvestigationStateV1" NOT NULL,
  "findings" JSONB NOT NULL,
  "activeTurnId" TEXT,
  "semanticTurns" INTEGER NOT NULL DEFAULT 0,
  "operationalAttempts" INTEGER NOT NULL DEFAULT 0,
  "expansionDepth" INTEGER NOT NULL DEFAULT 0,
  "criticCycles" INTEGER NOT NULL DEFAULT 0,
  "criticDecision" "ReviewInvestigationCriticDecisionV1",
  "conclusion" "ReviewInvestigationConclusionV1",
  "certificateId" TEXT,
  "dossierDigest" TEXT NOT NULL,
  "nextEligibleAt" TIMESTAMP(3),
  "supersededByInvestigationId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "retainUntil" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewInvestigation_pkey" PRIMARY KEY ("investigationId"),
  CONSTRAINT "ReviewInvestigation_version_check" CHECK ("version" > 0),
  CONSTRAINT "ReviewInvestigation_counters_check" CHECK (
    "semanticTurns" >= 0 AND "operationalAttempts" >= 0
    AND "expansionDepth" >= 0 AND "criticCycles" >= 0
  )
);

CREATE TABLE "ReviewInvestigationObligation" (
  "investigationId" TEXT NOT NULL,
  "obligationId" TEXT NOT NULL,
  "coverageContractVersion" TEXT NOT NULL,
  "stableReviewUnitKey" TEXT NOT NULL,
  "kind" "ReviewInvestigationObligationKindV1" NOT NULL,
  "canonicalSubject" TEXT NOT NULL,
  "canonicalRequirement" TEXT NOT NULL,
  "riskPriority" INTEGER NOT NULL,
  "origin" "ReviewInvestigationObligationOriginV1" NOT NULL,
  "state" "ReviewInvestigationObligationStateV1" NOT NULL,
  "receiptId" TEXT,
  "unresolvableReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewInvestigationObligation_pkey"
    PRIMARY KEY ("investigationId", "obligationId"),
  CONSTRAINT "ReviewInvestigationObligation_risk_check" CHECK ("riskPriority" >= 0),
  CONSTRAINT "ReviewInvestigationObligation_state_check" CHECK (
    ("state" = 'open' AND "receiptId" IS NULL AND "unresolvableReason" IS NULL)
    OR ("state" = 'satisfied' AND "receiptId" IS NOT NULL AND "unresolvableReason" IS NULL)
    OR ("state" = 'unresolvable' AND "receiptId" IS NULL AND "unresolvableReason" IS NOT NULL)
  )
);

CREATE TABLE "ReviewInvestigationTurn" (
  "turnId" TEXT NOT NULL,
  "investigationId" TEXT NOT NULL,
  "turnOrdinal" INTEGER NOT NULL,
  "purpose" "ReviewInvestigationTurnPurposeV1" NOT NULL,
  "state" "ReviewInvestigationTurnStateV1" NOT NULL,
  "leasedAtVersion" BIGINT NOT NULL,
  "dossierDigest" TEXT NOT NULL,
  "obligationIds" JSONB NOT NULL,
  "semanticTurnOrdinal" INTEGER NOT NULL,
  "criticCycleOrdinal" INTEGER NOT NULL,
  "acceptedAttestationId" TEXT,
  "sanitizedOutcomeHash" TEXT,
  "abortReason" TEXT,
  "leasedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "retainUntil" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewInvestigationTurn_pkey" PRIMARY KEY ("turnId"),
  CONSTRAINT "ReviewInvestigationTurn_ordinals_check" CHECK (
    "turnOrdinal" > 0 AND "leasedAtVersion" > 0
    AND "semanticTurnOrdinal" >= 0 AND "criticCycleOrdinal" >= 0
  )
);

CREATE TABLE "ReviewInvestigationReceipt" (
  "receiptId" TEXT NOT NULL,
  "investigationId" TEXT NOT NULL,
  "obligationId" TEXT NOT NULL,
  "turnId" TEXT,
  "operationKey" TEXT NOT NULL,
  "kind" "ReviewInvestigationReceiptKindV1" NOT NULL,
  "canonicalSubject" TEXT NOT NULL,
  "reviewRevisionHash" TEXT NOT NULL,
  "gatewayPolicyVersion" TEXT NOT NULL,
  "evidenceDigest" TEXT NOT NULL,
  "complete" BOOLEAN NOT NULL,
  "truncated" BOOLEAN NOT NULL,
  "failed" BOOLEAN NOT NULL,
  "acceptedAttestationId" TEXT,
  "acceptedAt" TIMESTAMP(3) NOT NULL,
  "retainUntil" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewInvestigationReceipt_pkey" PRIMARY KEY ("receiptId"),
  CONSTRAINT "ReviewInvestigationReceipt_complete_check" CHECK (
    "complete" = TRUE AND "truncated" = FALSE AND "failed" = FALSE
  )
);

CREATE TABLE "ReviewInvestigationPrivateMaterial" (
  "privateMaterialId" TEXT NOT NULL,
  "investigationId" TEXT NOT NULL,
  "obligationId" TEXT,
  "encryptionAlgorithm" TEXT NOT NULL,
  "encryptionKeyId" TEXT NOT NULL,
  "nonce" BYTEA NOT NULL,
  "authTag" BYTEA NOT NULL,
  "ciphertext" BYTEA NOT NULL,
  "associatedDataHash" TEXT NOT NULL,
  "plaintextHash" TEXT NOT NULL,
  "byteCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewInvestigationPrivateMaterial_pkey" PRIMARY KEY ("privateMaterialId"),
  CONSTRAINT "ReviewInvestigationPrivateMaterial_bytes_check" CHECK ("byteCount" > 0)
);

CREATE TABLE "ReviewInvestigationCertificate" (
  "certificateId" TEXT NOT NULL,
  "certificateHash" TEXT NOT NULL,
  "investigationId" TEXT NOT NULL,
  "terminalVersion" BIGINT NOT NULL,
  "dossierDigest" TEXT NOT NULL,
  "reviewRevisionHash" TEXT NOT NULL,
  "stableReviewUnitKey" TEXT NOT NULL,
  "providerVoteLaneId" TEXT NOT NULL,
  "coverageContractVersion" TEXT NOT NULL,
  "expansionRulesVersion" TEXT NOT NULL,
  "gatewayPolicyVersion" TEXT NOT NULL,
  "criticPolicyVersion" TEXT NOT NULL,
  "runtimeProfileVersion" TEXT NOT NULL,
  "producerReleaseId" TEXT NOT NULL,
  "conclusion" "ReviewInvestigationConclusionV1" NOT NULL,
  "findingSetHash" TEXT NOT NULL,
  "obligationSetHash" TEXT NOT NULL,
  "receiptSetHash" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewInvestigationCertificate_pkey" PRIMARY KEY ("certificateId"),
  CONSTRAINT "ReviewInvestigationCertificate_version_check" CHECK ("terminalVersion" > 0)
);

CREATE TABLE "ReviewInvestigationCommandReceipt" (
  "commandId" TEXT NOT NULL,
  "investigationId" TEXT NOT NULL,
  "commandHash" TEXT NOT NULL,
  "resultingVersion" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "retainUntil" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewInvestigationCommandReceipt_pkey" PRIMARY KEY ("commandId"),
  CONSTRAINT "ReviewInvestigationCommandReceipt_version_check" CHECK ("resultingVersion" > 0)
);

CREATE UNIQUE INDEX "ReviewInvestigation_naturalIdentityHash_key"
  ON "ReviewInvestigation"("naturalIdentityHash");
CREATE UNIQUE INDEX "ReviewInvestigation_activeTurnId_key"
  ON "ReviewInvestigation"("activeTurnId");
CREATE UNIQUE INDEX "ReviewInvestigation_certificateId_key"
  ON "ReviewInvestigation"("certificateId");
CREATE UNIQUE INDEX "ReviewInvestigation_natural_scope_key"
  ON "ReviewInvestigation"(
    "executionId", "workSlotId", "providerVoteLaneId", "stableReviewUnitKey",
    "coverageContractVersion", "runtimeProfileVersion"
  );
CREATE INDEX "ReviewInvestigation_execution_slot_state_idx"
  ON "ReviewInvestigation"("executionId", "workSlotId", "state");
CREATE INDEX "ReviewInvestigation_state_eligibility_idx"
  ON "ReviewInvestigation"("state", "nextEligibleAt", "investigationId");
CREATE INDEX "ReviewInvestigation_revision_unit_idx"
  ON "ReviewInvestigation"("reviewRevisionHash", "stableReviewUnitKey");
CREATE INDEX "ReviewInvestigation_retention_idx"
  ON "ReviewInvestigation"("retainUntil", "investigationId");

CREATE UNIQUE INDEX "ReviewInvestigationObligation_receiptId_key"
  ON "ReviewInvestigationObligation"("receiptId");
CREATE INDEX "ReviewInvestigationObligation_state_priority_idx"
  ON "ReviewInvestigationObligation"(
    "investigationId", "state", "riskPriority", "obligationId"
  );
CREATE UNIQUE INDEX "ReviewInvestigationTurn_investigation_ordinal_key"
  ON "ReviewInvestigationTurn"("investigationId", "turnOrdinal");
CREATE UNIQUE INDEX "ReviewInvestigationTurn_attestation_key"
  ON "ReviewInvestigationTurn"("acceptedAttestationId");
CREATE INDEX "ReviewInvestigationTurn_active_recovery_idx"
  ON "ReviewInvestigationTurn"("investigationId", "state", "expiresAt");
CREATE INDEX "ReviewInvestigationTurn_expiry_idx"
  ON "ReviewInvestigationTurn"("expiresAt", "turnId");
CREATE INDEX "ReviewInvestigationTurn_retention_idx"
  ON "ReviewInvestigationTurn"("retainUntil", "turnId");
CREATE UNIQUE INDEX "ReviewInvestigationReceipt_obligation_key"
  ON "ReviewInvestigationReceipt"("investigationId", "obligationId");
CREATE INDEX "ReviewInvestigationReceipt_revision_subject_idx"
  ON "ReviewInvestigationReceipt"("reviewRevisionHash", "canonicalSubject");
CREATE INDEX "ReviewInvestigationReceipt_attestation_idx"
  ON "ReviewInvestigationReceipt"("acceptedAttestationId");
CREATE INDEX "ReviewInvestigationReceipt_retention_idx"
  ON "ReviewInvestigationReceipt"("retainUntil", "receiptId");
CREATE UNIQUE INDEX "ReviewInvestigationPrivateMaterial_obligation_key"
  ON "ReviewInvestigationPrivateMaterial"("investigationId", "obligationId");
CREATE UNIQUE INDEX "ReviewInvestigationPrivateMaterial_investigation_global_key"
  ON "ReviewInvestigationPrivateMaterial"("investigationId")
  WHERE "obligationId" IS NULL;
CREATE INDEX "ReviewInvestigationPrivateMaterial_expiry_idx"
  ON "ReviewInvestigationPrivateMaterial"("expiresAt", "privateMaterialId");
CREATE UNIQUE INDEX "ReviewInvestigationCertificate_hash_key"
  ON "ReviewInvestigationCertificate"("certificateHash");
CREATE UNIQUE INDEX "ReviewInvestigationCertificate_terminal_key"
  ON "ReviewInvestigationCertificate"("investigationId", "terminalVersion");
CREATE INDEX "ReviewInvestigationCertificate_revision_unit_idx"
  ON "ReviewInvestigationCertificate"("reviewRevisionHash", "stableReviewUnitKey");
CREATE INDEX "ReviewInvestigationCertificate_expiry_idx"
  ON "ReviewInvestigationCertificate"("expiresAt", "certificateId");
CREATE INDEX "ReviewInvestigationCommandReceipt_version_idx"
  ON "ReviewInvestigationCommandReceipt"("investigationId", "resultingVersion");
CREATE INDEX "ReviewInvestigationCommandReceipt_retention_idx"
  ON "ReviewInvestigationCommandReceipt"("retainUntil", "commandId");

ALTER TABLE "ReviewInvestigationObligation"
  ADD CONSTRAINT "ReviewInvestigationObligation_investigation_fkey"
  FOREIGN KEY ("investigationId") REFERENCES "ReviewInvestigation"("investigationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewInvestigationTurn"
  ADD CONSTRAINT "ReviewInvestigationTurn_investigation_fkey"
  FOREIGN KEY ("investigationId") REFERENCES "ReviewInvestigation"("investigationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewInvestigationReceipt"
  ADD CONSTRAINT "ReviewInvestigationReceipt_obligation_fkey"
  FOREIGN KEY ("investigationId", "obligationId")
  REFERENCES "ReviewInvestigationObligation"("investigationId", "obligationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewInvestigationReceipt"
  ADD CONSTRAINT "ReviewInvestigationReceipt_turn_fkey"
  FOREIGN KEY ("turnId") REFERENCES "ReviewInvestigationTurn"("turnId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewInvestigationPrivateMaterial"
  ADD CONSTRAINT "ReviewInvestigationPrivateMaterial_investigation_fkey"
  FOREIGN KEY ("investigationId") REFERENCES "ReviewInvestigation"("investigationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewInvestigationPrivateMaterial"
  ADD CONSTRAINT "ReviewInvestigationPrivateMaterial_obligation_fkey"
  FOREIGN KEY ("investigationId", "obligationId")
  REFERENCES "ReviewInvestigationObligation"("investigationId", "obligationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewInvestigationCertificate"
  ADD CONSTRAINT "ReviewInvestigationCertificate_investigation_fkey"
  FOREIGN KEY ("investigationId") REFERENCES "ReviewInvestigation"("investigationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewInvestigationCommandReceipt"
  ADD CONSTRAINT "ReviewInvestigationCommandReceipt_investigation_fkey"
  FOREIGN KEY ("investigationId") REFERENCES "ReviewInvestigation"("investigationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewInvestigation"
  ADD CONSTRAINT "ReviewInvestigation_execution_slot_fkey"
  FOREIGN KEY ("executionId", "workSlotId")
  REFERENCES "ReviewExecutionWorkSlotV2"("executionId", "workSlotId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewInvestigation"
  ADD CONSTRAINT "ReviewInvestigation_active_turn_fkey"
  FOREIGN KEY ("activeTurnId") REFERENCES "ReviewInvestigationTurn"("turnId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewInvestigation"
  ADD CONSTRAINT "ReviewInvestigation_certificate_fkey"
  FOREIGN KEY ("certificateId") REFERENCES "ReviewInvestigationCertificate"("certificateId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewInvestigation"
  ADD CONSTRAINT "ReviewInvestigation_superseded_by_fkey"
  FOREIGN KEY ("supersededByInvestigationId") REFERENCES "ReviewInvestigation"("investigationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewInvestigationObligation"
  ADD CONSTRAINT "ReviewInvestigationObligation_receipt_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "ReviewInvestigationReceipt"("receiptId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewInvestigationTurn"
  ADD CONSTRAINT "ReviewInvestigationTurn_attestation_fkey"
  FOREIGN KEY ("acceptedAttestationId")
  REFERENCES "ReviewContextDependencyAttestation"("attestationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewInvestigationReceipt"
  ADD CONSTRAINT "ReviewInvestigationReceipt_attestation_fkey"
  FOREIGN KEY ("acceptedAttestationId")
  REFERENCES "ReviewContextDependencyAttestation"("attestationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TYPE "ReviewSafetyCapabilityV2" ADD VALUE 'review_investigation_v1';
