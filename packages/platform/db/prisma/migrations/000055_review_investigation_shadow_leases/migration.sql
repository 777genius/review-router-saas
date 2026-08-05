CREATE TYPE "ReviewInvestigationLeasePurposeV1" AS ENUM (
  'shadow_turn'
);

CREATE TYPE "ReviewContextLeaseAuthorityKindV1" AS ENUM (
  'standard_execution',
  'investigation_shadow'
);

ALTER TABLE "ReviewContextGatewaySession"
ADD COLUMN "sourceLeaseAuthorityKind" "ReviewContextLeaseAuthorityKindV1"
NOT NULL DEFAULT 'standard_execution';

CREATE TYPE "ReviewInvestigationLeaseStateV1" AS ENUM (
  'active',
  'released',
  'expired',
  'revoked'
);

ALTER TABLE "ReviewInvestigation"
ADD COLUMN "investigationManifestCanonicalJson" TEXT,
ADD COLUMN "investigationManifestHash" TEXT,
ADD CONSTRAINT "ReviewInvestigation_manifest_pair" CHECK (
  ("investigationManifestCanonicalJson" IS NULL) =
  ("investigationManifestHash" IS NULL)
),
ADD CONSTRAINT "ReviewInvestigation_manifest_hash_format" CHECK (
  "investigationManifestHash" IS NULL OR
  "investigationManifestHash" ~ '^[a-f0-9]{64}$'
);

CREATE TABLE "ReviewInvestigationLease" (
  "leaseId" TEXT NOT NULL,
  "purpose" "ReviewInvestigationLeasePurposeV1" NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "repositoryConnectionId" TEXT NOT NULL,
  "scmRepositoryIdentityId" TEXT NOT NULL,
  "pullRequestNumber" INTEGER NOT NULL,
  "authorizationId" TEXT NOT NULL,
  "mutationEpoch" BIGINT NOT NULL,
  "executionId" TEXT NOT NULL,
  "workSlotId" TEXT NOT NULL,
  "baseSha" TEXT NOT NULL,
  "mergeBaseSha" TEXT NOT NULL,
  "headSha" TEXT NOT NULL,
  "reviewRevisionHash" TEXT NOT NULL,
  "investigationId" TEXT NOT NULL,
  "investigationVersion" BIGINT NOT NULL,
  "turnId" TEXT NOT NULL,
  "turnPurpose" "ReviewInvestigationTurnPurposeV1" NOT NULL,
  "providerVoteLaneId" TEXT NOT NULL,
  "providerStrategyId" TEXT NOT NULL,
  "investigationManifestCanonicalJson" TEXT NOT NULL,
  "investigationManifestHash" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "acquireRequestIdHash" TEXT NOT NULL,
  "acquireRequestHash" TEXT NOT NULL,
  "lastRenewRequestIdHash" TEXT,
  "lastRenewRequestHash" TEXT,
  "lastReleaseRequestIdHash" TEXT,
  "lastReleaseRequestHash" TEXT,
  "ownerIdHash" TEXT NOT NULL,
  "leaseCapabilityId" TEXT NOT NULL,
  "capabilitySigningKeyId" TEXT NOT NULL,
  "fencingToken" BIGSERIAL NOT NULL,
  "state" "ReviewInvestigationLeaseStateV1" NOT NULL DEFAULT 'active',
  "acquiredAt" TIMESTAMP(3) NOT NULL,
  "renewedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "resultReportUntil" TIMESTAMP(3) NOT NULL,
  "retainUntil" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ReviewInvestigationLease_pkey" PRIMARY KEY ("leaseId"),
  CONSTRAINT "ReviewInvestigationLease_positive_identity" CHECK (
    "pullRequestNumber" > 0
    AND "mutationEpoch" > 0
    AND "investigationVersion" > 0
    AND "fencingToken" > 0
  ),
  CONSTRAINT "ReviewInvestigationLease_deadline_order" CHECK (
    "renewedAt" >= "acquiredAt"
    AND "expiresAt" > "renewedAt"
    AND "resultReportUntil" >= "expiresAt"
    AND "retainUntil" > "resultReportUntil"
  ),
  CONSTRAINT "ReviewInvestigationLease_hash_format" CHECK (
    "reviewRevisionHash" ~ '^[a-f0-9]{64}$'
    AND "investigationManifestHash" ~ '^[a-f0-9]{64}$'
    AND "acquireRequestIdHash" ~ '^[a-f0-9]{64}$'
    AND "acquireRequestHash" ~ '^[a-f0-9]{64}$'
    AND "ownerIdHash" ~ '^[a-f0-9]{64}$'
    AND ("lastRenewRequestIdHash" IS NULL OR "lastRenewRequestIdHash" ~ '^[a-f0-9]{64}$')
    AND ("lastRenewRequestHash" IS NULL OR "lastRenewRequestHash" ~ '^[a-f0-9]{64}$')
    AND ("lastReleaseRequestIdHash" IS NULL OR "lastReleaseRequestIdHash" ~ '^[a-f0-9]{64}$')
    AND ("lastReleaseRequestHash" IS NULL OR "lastReleaseRequestHash" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT "ReviewInvestigationLease_renew_replay_identity" CHECK (
    ("lastRenewRequestIdHash" IS NULL) = ("lastRenewRequestHash" IS NULL)
  ),
  CONSTRAINT "ReviewInvestigationLease_release_replay_identity" CHECK (
    ("lastReleaseRequestIdHash" IS NULL) = ("lastReleaseRequestHash" IS NULL)
  )
);

CREATE UNIQUE INDEX "ReviewInvestigationLease_attemptId_key"
ON "ReviewInvestigationLease"("attemptId");

CREATE UNIQUE INDEX "ReviewInvestigationLease_capability_key"
ON "ReviewInvestigationLease"("leaseCapabilityId");

CREATE UNIQUE INDEX "ReviewInvestigationLease_fencing_key"
ON "ReviewInvestigationLease"("fencingToken");

CREATE UNIQUE INDEX "ReviewInvestigationLease_acquire_identity_key"
ON "ReviewInvestigationLease"(
  "investigationId", "turnId", "acquireRequestIdHash"
);

CREATE UNIQUE INDEX "ReviewInvestigationTurn_investigation_turn_key"
ON "ReviewInvestigationTurn"("investigationId", "turnId");

ALTER TABLE "ReviewInvestigationLease"
ADD CONSTRAINT "ReviewInvestigationLease_turn_fkey"
FOREIGN KEY ("investigationId", "turnId")
REFERENCES "ReviewInvestigationTurn"("investigationId", "turnId")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ReviewInvestigationLease_active_turn_key"
ON "ReviewInvestigationLease"("investigationId", "turnId")
WHERE "state" = 'active';

CREATE INDEX "ReviewInvestigationLease_turn_state_idx"
ON "ReviewInvestigationLease"(
  "investigationId", "turnId", "state", "expiresAt"
);

CREATE INDEX "ReviewInvestigationLease_execution_slot_idx"
ON "ReviewInvestigationLease"("executionId", "workSlotId", "state");

CREATE INDEX "ReviewInvestigationLease_retention_idx"
ON "ReviewInvestigationLease"("retainUntil", "leaseId");
