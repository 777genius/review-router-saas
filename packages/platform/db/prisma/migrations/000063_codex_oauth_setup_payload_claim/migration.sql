BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "CodexOAuthSetupManifest"
  ADD COLUMN "payloadVersion" INTEGER,
  ADD COLUMN "payloadGenerationHash" TEXT,
  ADD COLUMN "payloadAccountFingerprint" TEXT,
  ADD COLUMN "payloadByteSize" INTEGER,
  ADD COLUMN "payloadClaimedAt" TIMESTAMPTZ(3),
  ADD COLUMN "recoveryExpiresAt" TIMESTAMPTZ(3);

ALTER TABLE "CodexOAuthSetupManifest"
  ADD CONSTRAINT "CodexOAuthSetupManifest_payload_claim_complete_check" CHECK (
    ("payloadVersion" IS NULL AND "payloadGenerationHash" IS NULL AND
     "payloadAccountFingerprint" IS NULL AND "payloadByteSize" IS NULL AND
     "payloadClaimedAt" IS NULL)
    OR
    ("payloadVersion" = 1 AND "payloadGenerationHash" IS NOT NULL AND
     "payloadAccountFingerprint" IS NOT NULL AND "payloadByteSize" BETWEEN 1 AND 32768 AND
     "payloadClaimedAt" IS NOT NULL AND "recoveryExpiresAt" IS NOT NULL AND
     "status" IN ('fetched', 'consumed'))
  ),
  ADD CONSTRAINT "CodexOAuthSetupManifest_recovery_expiry_check" CHECK (
    "recoveryExpiresAt" IS NULL OR
    ("lastFetchedAt" IS NOT NULL AND "recoveryExpiresAt" > "lastFetchedAt")
  );

CREATE INDEX "CodexOAuthSetupManifest_recovery_expiry_idx"
  ON "CodexOAuthSetupManifest"("status", "recoveryExpiresAt");

COMMIT;
