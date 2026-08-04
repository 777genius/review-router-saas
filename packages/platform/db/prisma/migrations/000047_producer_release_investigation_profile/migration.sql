BEGIN;

ALTER TABLE "ProducerRelease"
ADD COLUMN "reviewInvestigationCapability" TEXT,
ADD COLUMN "reviewInvestigationCoverageProfileHash" TEXT,
ADD COLUMN "reviewInvestigationPolicyHash" TEXT;

ALTER TABLE "ProducerRelease"
ADD CONSTRAINT "ProducerRelease_reviewInvestigationProfile_complete"
CHECK (
  (
    "reviewInvestigationCapability" IS NULL
    AND "reviewInvestigationCoverageProfileHash" IS NULL
    AND "reviewInvestigationPolicyHash" IS NULL
  ) OR (
    "reviewInvestigationCapability" = 'review_investigation_v1'
    AND "reviewInvestigationCoverageProfileHash" ~ '^[a-f0-9]{64}$'
    AND "reviewInvestigationPolicyHash" ~ '^[a-f0-9]{64}$'
    AND "contextGatewayPolicyVersion" IS NOT NULL
    AND "contextGatewayEntrypointDigest" IS NOT NULL
  )
) NOT VALID;

ALTER TABLE "ProducerRelease"
VALIDATE CONSTRAINT "ProducerRelease_reviewInvestigationProfile_complete";

DROP INDEX "ProducerRelease_distributionKind_actionCommitSha_runtimeCom_key";

CREATE UNIQUE INDEX "ProducerRelease_distributionKind_actionCommitSha_runtimeCom_key"
ON "ProducerRelease"(
  "distributionKind",
  "actionCommitSha",
  "runtimeCommitSha",
  "wrapperEntrypointDigest",
  "runtimeEntrypointDigest",
  "contextGatewayPolicyVersion",
  "contextGatewayEntrypointDigest",
  "reviewInvestigationCapability",
  "reviewInvestigationCoverageProfileHash",
  "reviewInvestigationPolicyHash",
  "schemaDigest",
  "capabilityProfile",
  "protocolLimitsProfileId",
  "operationalSloProfileId"
) NULLS NOT DISTINCT;

COMMIT;
