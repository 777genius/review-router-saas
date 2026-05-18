-- Add per-provider hard health gate metadata.
ALTER TABLE "ReviewConfigurationVersionProvider"
ADD COLUMN "requiredHealthy" BOOLEAN NOT NULL DEFAULT false;

-- Existing configs should keep the new SaaS default: the first provider is required.
UPDATE "ReviewConfigurationVersionProvider"
SET "requiredHealthy" = true
WHERE "order" = 0;
