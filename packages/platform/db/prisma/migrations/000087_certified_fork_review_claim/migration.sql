CREATE TABLE "CertifiedForkReviewClaim" (
  "id" TEXT NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "baseRepositoryId" TEXT NOT NULL,
  "pullRequestNumber" INTEGER NOT NULL,
  "reviewHeadSha" TEXT NOT NULL,
  "baseSha" TEXT NOT NULL,
  "contextHash" TEXT NOT NULL,
  "promptPolicyVersion" INTEGER NOT NULL,
  "reservationOwner" TEXT NOT NULL,
  "executionId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "outputDigest" TEXT,
  "commentId" TEXT,
  "commentUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "publishedAt" TIMESTAMP(3),

  CONSTRAINT "CertifiedForkReviewClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CertifiedForkReviewClaim_scopeKey_key"
  ON "CertifiedForkReviewClaim"("scopeKey");
CREATE INDEX "CertifiedForkReviewClaim_baseRepositoryId_pullRequestNumber_reviewHeadSha_idx"
  ON "CertifiedForkReviewClaim"("baseRepositoryId", "pullRequestNumber", "reviewHeadSha");
