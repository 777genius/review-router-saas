ALTER TYPE "ReviewPublicationOperationAttemptStateV2"
ADD VALUE IF NOT EXISTS 'no_effect_proven';

ALTER TABLE "ReviewPublicationOperationAttemptV2"
ADD COLUMN "noEffectProofId" TEXT,
ADD COLUMN "noEffectProofHash" TEXT,
ADD COLUMN "noEffectReason" TEXT,
ADD COLUMN "noEffectProvenAt" TIMESTAMP(3),
ADD CONSTRAINT "ReviewPublicationOperationAttemptV2_no_effect_proof_complete" CHECK (
  ("state"::text = 'no_effect_proven') = (
    "noEffectProofId" IS NOT NULL
    AND "noEffectProofHash" IS NOT NULL
    AND "noEffectReason" IS NOT NULL
    AND "noEffectProvenAt" IS NOT NULL
  )
),
ADD CONSTRAINT "ReviewPublicationOperationAttemptV2_no_effect_hash_format" CHECK (
  "noEffectProofHash" IS NULL
  OR "noEffectProofHash" ~ '^[a-f0-9]{64}$'
);

CREATE UNIQUE INDEX "ReviewPublicationOperationAttemptV2_noEffectProofId_key"
ON "ReviewPublicationOperationAttemptV2"("noEffectProofId");
