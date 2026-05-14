ALTER TYPE "ConflictReviewAttemptStatus" ADD VALUE IF NOT EXISTS 'model_running';
ALTER TYPE "ConflictReviewAttemptStatus" ADD VALUE IF NOT EXISTS 'posting_started';
ALTER TYPE "ConflictReviewAttemptStatus" ADD VALUE IF NOT EXISTS 'summary_posted';
ALTER TYPE "ConflictReviewAttemptStatus" ADD VALUE IF NOT EXISTS 'inline_posting_completed';
ALTER TYPE "ConflictReviewAttemptStatus" ADD VALUE IF NOT EXISTS 'status_posted';
ALTER TYPE "ConflictReviewAttemptStatus" ADD VALUE IF NOT EXISTS 'degraded';
ALTER TYPE "ConflictReviewAttemptStatus" ADD VALUE IF NOT EXISTS 'dead_letter';

CREATE TYPE "ConflictReviewPostingIntentStatus" AS ENUM ('pending', 'completed', 'failed', 'ambiguous');

ALTER TABLE "ConflictReviewAttempt"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "postingManifestHash" TEXT;

CREATE TABLE "ConflictReviewPostingIntent" (
  "id" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "operationKind" TEXT NOT NULL,
  "operationFingerprint" TEXT NOT NULL,
  "manifestHash" TEXT NOT NULL,
  "status" "ConflictReviewPostingIntentStatus" NOT NULL DEFAULT 'pending',
  "githubExternalId" TEXT,
  "githubUrl" TEXT,
  "bodyHash" TEXT,
  "safeErrorCode" TEXT,
  "safeErrorSummary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ConflictReviewPostingIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConflictReviewPostingIntent_attemptId_operationKind_operationFingerprint_key"
  ON "ConflictReviewPostingIntent"("attemptId", "operationKind", "operationFingerprint");
CREATE INDEX "ConflictReviewPostingIntent_attemptId_status_idx"
  ON "ConflictReviewPostingIntent"("attemptId", "status");

ALTER TABLE "ConflictReviewPostingIntent"
  ADD CONSTRAINT "ConflictReviewPostingIntent_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "ConflictReviewAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
