ALTER TABLE "ReviewInvestigation"
  ADD COLUMN "totalUsageTokens" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "totalDurationMs" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "turnProvenance" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "authorizationScopeHash" TEXT;

ALTER TABLE "ReviewInvestigationCertificate"
  ADD COLUMN "scopeHash" TEXT,
  ADD COLUMN "coverageStateHash" TEXT,
  ADD COLUMN "contextAttestationSetHash" TEXT,
  ADD COLUMN "turnProvenanceHash" TEXT,
  ADD COLUMN "terminalOutcomeHash" TEXT,
  ADD COLUMN "terminalObservationCanonicalJson" TEXT,
  ADD COLUMN "criticAttestationId" TEXT,
  ADD COLUMN "criticAttestationHash" TEXT,
  ADD COLUMN "criticDecision" "ReviewInvestigationCriticDecisionV1";

CREATE INDEX "ReviewInvestigationCertificate_terminalOutcomeHash_idx"
  ON "ReviewInvestigationCertificate"("terminalOutcomeHash");

ALTER TABLE "ReviewEvidenceObservation"
  ADD COLUMN "investigationCertificateId" TEXT,
  ADD COLUMN "investigationCertificateHash" TEXT;

CREATE INDEX "ReviewEvidenceObservation_investigationCertificateId_idx"
  ON "ReviewEvidenceObservation"("investigationCertificateId");
