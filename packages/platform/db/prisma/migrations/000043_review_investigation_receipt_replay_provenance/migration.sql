ALTER TABLE "ReviewInvestigationReceipt"
  ADD COLUMN "operationReceiptIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "acceptedAttestationHash" TEXT;

ALTER TABLE "ReviewInvestigationReceipt"
  ADD CONSTRAINT "ReviewInvestigationReceipt_attestation_provenance_check"
  CHECK (
    "acceptedAttestationHash" IS NULL OR "acceptedAttestationId" IS NOT NULL
  );
