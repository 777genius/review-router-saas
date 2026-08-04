CREATE TYPE "InvestigationShadowEvidenceAuthorityV1" AS ENUM (
  'non_authoritative'
);

CREATE TYPE "InvestigationShadowEvidenceSourceKindV1" AS ENUM (
  'terminal_certificate'
);

CREATE TABLE "ReviewInvestigationShadowEvidence" (
  "shadowEvidenceId" TEXT NOT NULL,
  "evidenceVersion" INTEGER NOT NULL,
  "authority" "InvestigationShadowEvidenceAuthorityV1" NOT NULL,
  "sourceKind" "InvestigationShadowEvidenceSourceKindV1" NOT NULL,
  "retentionPolicyVersion" TEXT NOT NULL,
  "investigationId" TEXT NOT NULL,
  "investigationVersion" BIGINT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "repositoryConnectionId" TEXT NOT NULL,
  "scmRepositoryIdentityId" TEXT NOT NULL,
  "pullRequestNumber" INTEGER NOT NULL,
  "trustDomain" "ReviewTrustDomainV2" NOT NULL,
  "authorizationScopeHash" TEXT NOT NULL,
  "sourceBaseSha" TEXT NOT NULL,
  "sourceMergeBaseSha" TEXT NOT NULL,
  "sourceHeadSha" TEXT NOT NULL,
  "sourceReviewRevisionHash" TEXT NOT NULL,
  "executionId" TEXT NOT NULL,
  "workSlotId" TEXT NOT NULL,
  "stableReviewUnitKey" TEXT NOT NULL,
  "providerVoteLaneId" TEXT NOT NULL,
  "producerReleaseId" TEXT NOT NULL,
  "conclusion" "ReviewInvestigationConclusionV1" NOT NULL,
  "certificateId" TEXT NOT NULL,
  "certificateHash" TEXT NOT NULL,
  "certificateCanonicalJson" TEXT NOT NULL,
  "terminalProviderKind" "ReviewProviderKindV2",
  "terminalActualModel" TEXT,
  "terminalOutcomeHash" TEXT NOT NULL,
  "terminalObservationCanonicalJson" TEXT NOT NULL,
  "terminalPayloadHash" TEXT NOT NULL,
  "terminalPayloadByteCount" INTEGER NOT NULL,
  "findingCount" INTEGER NOT NULL,
  "recordHash" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "retainUntil" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReviewInvestigationShadowEvidence_pkey"
    PRIMARY KEY ("shadowEvidenceId"),
  CONSTRAINT "ReviewInvestigationShadowEvidence_version_check"
    CHECK ("evidenceVersion" = 1),
  CONSTRAINT "ReviewInvestigationShadowEvidence_investigation_version_check"
    CHECK ("investigationVersion" > 0),
  CONSTRAINT "ReviewInvestigationShadowEvidence_pull_request_check"
    CHECK ("pullRequestNumber" > 0),
  CONSTRAINT "ReviewInvestigationShadowEvidence_payload_accounting_check"
    CHECK ("terminalPayloadByteCount" >= 0 AND "findingCount" >= 0),
  CONSTRAINT "ReviewInvestigationShadowEvidence_terminal_provenance_check"
    CHECK (("terminalProviderKind" IS NULL) = ("terminalActualModel" IS NULL)),
  CONSTRAINT "ReviewInvestigationShadowEvidence_retention_check"
    CHECK ("retainUntil" > "issuedAt")
);

CREATE UNIQUE INDEX "ReviewInvestigationShadowEvidence_investigation_key"
  ON "ReviewInvestigationShadowEvidence"("investigationId");

CREATE UNIQUE INDEX "ReviewInvestigationShadowEvidence_certificate_key"
  ON "ReviewInvestigationShadowEvidence"("certificateId");

CREATE UNIQUE INDEX "ReviewInvestigationShadowEvidence_certificate_hash_key"
  ON "ReviewInvestigationShadowEvidence"("certificateHash");

CREATE UNIQUE INDEX "ReviewInvestigationShadowEvidence_record_hash_key"
  ON "ReviewInvestigationShadowEvidence"("recordHash");

CREATE INDEX "ReviewInvestigationShadowEvidence_scope_revision_idx"
  ON "ReviewInvestigationShadowEvidence"(
    "workspaceId",
    "repositoryConnectionId",
    "scmRepositoryIdentityId",
    "pullRequestNumber",
    "sourceReviewRevisionHash",
    "issuedAt"
  );

CREATE INDEX "ReviewInvestigationShadowEvidence_release_idx"
  ON "ReviewInvestigationShadowEvidence"(
    "producerReleaseId",
    "issuedAt",
    "shadowEvidenceId"
  );

CREATE INDEX "ReviewInvestigationShadowEvidence_retention_idx"
  ON "ReviewInvestigationShadowEvidence"("retainUntil", "shadowEvidenceId");
