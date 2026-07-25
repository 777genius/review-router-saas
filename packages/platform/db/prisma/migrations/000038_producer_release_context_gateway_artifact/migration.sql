BEGIN;

ALTER TABLE "ProducerRelease"
ADD COLUMN "contextGatewayPolicyVersion" TEXT,
ADD COLUMN "contextGatewayEntrypointDigest" TEXT;

ALTER TABLE "ProducerRelease"
ADD CONSTRAINT "ProducerRelease_contextGatewayArtifact_complete"
CHECK (
  ("contextGatewayPolicyVersion" IS NULL) =
  ("contextGatewayEntrypointDigest" IS NULL)
) NOT VALID;

ALTER TABLE "ProducerRelease"
VALIDATE CONSTRAINT "ProducerRelease_contextGatewayArtifact_complete";

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
  "schemaDigest",
  "capabilityProfile",
  "protocolLimitsProfileId",
  "operationalSloProfileId"
) NULLS NOT DISTINCT;

COMMIT;
