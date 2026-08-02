ALTER TABLE "ReviewInvestigationReceipt"
  ADD COLUMN "operationReceiptIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "acceptedAttestationHash" TEXT,
  ADD COLUMN "replayProofId" TEXT;

ALTER TABLE "ReviewInvestigationReceipt"
  ADD CONSTRAINT "ReviewInvestigationReceipt_attestation_provenance_check"
  CHECK (
    ("acceptedAttestationHash" IS NULL OR "acceptedAttestationId" IS NOT NULL)
    AND
    ("replayProofId" IS NULL OR "acceptedAttestationHash" IS NOT NULL)
  );

CREATE INDEX "ReviewInvestigationReceipt_replay_proof_idx"
  ON "ReviewInvestigationReceipt" ("replayProofId");
