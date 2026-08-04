CREATE TYPE "ReviewInvestigationTelemetrySourceV1" AS ENUM (
  'disposable_fixture',
  'shadow',
  'allowlisted'
);

CREATE TABLE "ReviewInvestigationTelemetrySample" (
  "sampleId" TEXT NOT NULL,
  "producerReleaseId" TEXT NOT NULL,
  "source" "ReviewInvestigationTelemetrySourceV1" NOT NULL,
  "repositoryScopeHash" TEXT NOT NULL,
  "reviewRevisionHash" TEXT NOT NULL,
  "stableReviewUnitHash" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "collectedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewInvestigationTelemetrySample_pkey" PRIMARY KEY ("sampleId"),
  CONSTRAINT "ReviewInvestigationTelemetry_hash_format" CHECK (
    "repositoryScopeHash" ~ '^[a-f0-9]{64}$'
    AND "reviewRevisionHash" ~ '^[a-f0-9]{64}$'
    AND "stableReviewUnitHash" ~ '^[a-f0-9]{64}$'
    AND "payloadHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE INDEX "ReviewInvestigationTelemetry_release_idx"
ON "ReviewInvestigationTelemetrySample"(
  "producerReleaseId", "collectedAt", "sampleId"
);

CREATE INDEX "ReviewInvestigationTelemetry_scope_idx"
ON "ReviewInvestigationTelemetrySample"("repositoryScopeHash", "collectedAt");

CREATE TABLE "ReviewInvestigationPromotionReport" (
  "reportHash" TEXT NOT NULL,
  "producerReleaseId" TEXT NOT NULL,
  "generatedAt" TIMESTAMP(3) NOT NULL,
  "canonicalJson" TEXT NOT NULL,
  "body" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewInvestigationPromotionReport_pkey" PRIMARY KEY ("reportHash"),
  CONSTRAINT "ReviewInvestigationPromotionReport_hash_format" CHECK (
    "reportHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE INDEX "ReviewInvestigationPromotion_release_idx"
ON "ReviewInvestigationPromotionReport"(
  "producerReleaseId", "generatedAt", "reportHash"
);
