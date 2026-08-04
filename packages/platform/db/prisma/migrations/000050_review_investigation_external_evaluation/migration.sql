CREATE TABLE "ReviewInvestigationEvaluationAttestation" (
  "attestationId" TEXT NOT NULL,
  "attestationVersion" TEXT NOT NULL,
  "attestationHash" TEXT NOT NULL,
  "envelopeHash" TEXT NOT NULL,
  "signingKeyId" TEXT NOT NULL,
  "signatureAlgorithm" TEXT NOT NULL,
  "signatureValue" TEXT NOT NULL,
  "terminalSampleId" TEXT NOT NULL,
  "terminalSamplePayloadHash" TEXT NOT NULL,
  "derivedSampleId" TEXT NOT NULL,
  "investigationId" TEXT NOT NULL,
  "certificateId" TEXT NOT NULL,
  "certificateHash" TEXT NOT NULL,
  "producerReleaseId" TEXT NOT NULL,
  "corpusVersion" TEXT NOT NULL,
  "evaluationPolicyVersion" TEXT NOT NULL,
  "payloadCanonicalJson" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "importedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewInvestigationEvaluationAttestation_pkey"
    PRIMARY KEY ("attestationId"),
  CONSTRAINT "ReviewInvestigationEvaluationAttestation_version_check"
    CHECK ("attestationVersion" = 'review-investigation-evaluation.v1'),
  CONSTRAINT "ReviewInvestigationEvaluationAttestation_algorithm_check"
    CHECK ("signatureAlgorithm" = 'ed25519'),
  CONSTRAINT "ReviewInvestigationEvaluationAttestation_hash_format"
    CHECK (
      "attestationHash" ~ '^[a-f0-9]{64}$'
      AND "envelopeHash" ~ '^[a-f0-9]{64}$'
      AND "terminalSamplePayloadHash" ~ '^[a-f0-9]{64}$'
      AND "certificateHash" ~ '^[a-f0-9]{64}$'
    ),
  CONSTRAINT "ReviewInvestigationEvaluationAttestation_signature_format"
    CHECK ("signatureValue" ~ '^[A-Za-z0-9_-]{86}$')
);

CREATE UNIQUE INDEX "ReviewInvestigationEvaluationAttestation_hash_key"
ON "ReviewInvestigationEvaluationAttestation"("attestationHash");

CREATE UNIQUE INDEX "ReviewInvestigationEvaluationAttestation_envelope_hash_key"
ON "ReviewInvestigationEvaluationAttestation"("envelopeHash");

CREATE UNIQUE INDEX "ReviewInvestigationEvaluationAttestation_terminal_sample_key"
ON "ReviewInvestigationEvaluationAttestation"("terminalSampleId");

CREATE UNIQUE INDEX "ReviewInvestigationEvaluationAttestation_derived_sample_key"
ON "ReviewInvestigationEvaluationAttestation"("derivedSampleId");

CREATE INDEX "ReviewInvestigationEvaluationAttestation_release_corpus_idx"
ON "ReviewInvestigationEvaluationAttestation"(
  "producerReleaseId",
  "corpusVersion",
  "evaluationPolicyVersion",
  "importedAt"
);

CREATE INDEX "ReviewInvestigationEvaluationAttestation_investigation_idx"
ON "ReviewInvestigationEvaluationAttestation"("investigationId", "certificateId");
