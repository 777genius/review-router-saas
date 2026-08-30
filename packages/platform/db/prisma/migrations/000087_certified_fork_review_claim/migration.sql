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
  "expectedLeaseKey" TEXT NOT NULL,
  "reservationExpiresAt" TIMESTAMP(3) NOT NULL DEFAULT (transaction_timestamp() + interval '1 hour'),
  "recoveryState" TEXT NOT NULL DEFAULT 'reserved',
  "recoveryEvidenceHash" TEXT,
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

ALTER TABLE "CertifiedForkReviewClaim"
  ADD CONSTRAINT "CertifiedForkReviewClaim_recovery_state_check"
  CHECK ("recoveryState" IN ('reserved', 'ambiguous', 'recovered'));

CREATE UNIQUE INDEX "CertifiedForkReviewClaim_scopeKey_key"
  ON "CertifiedForkReviewClaim"("scopeKey");
CREATE INDEX "CertifiedForkReviewClaim_baseRepositoryId_pullRequestNumber_reviewHeadSha_idx"
  ON "CertifiedForkReviewClaim"("baseRepositoryId", "pullRequestNumber", "reviewHeadSha");

REVOKE ALL ON TABLE "CertifiedForkReviewClaim" FROM PUBLIC;
DO $acl$
BEGIN
  IF to_regrole('reviewrouter_api') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CertifiedForkReviewClaim"
      TO reviewrouter_api;
  END IF;
  IF to_regrole('reviewrouter_web') IS NOT NULL THEN
    REVOKE ALL ON TABLE "CertifiedForkReviewClaim" FROM reviewrouter_web;
  END IF;
  IF to_regrole('reviewrouter_worker') IS NOT NULL THEN
    REVOKE ALL ON TABLE "CertifiedForkReviewClaim" FROM reviewrouter_worker;
  END IF;
END
$acl$;
