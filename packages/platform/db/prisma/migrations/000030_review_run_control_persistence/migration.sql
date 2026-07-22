-- B1 run-control persistence hardening. The shared ReviewTaskKindV2 enum also
-- serves evidence, so its existing values remain valid while B1 selector kinds
-- are added explicitly.
ALTER TYPE "ReviewTaskKindV2" ADD VALUE IF NOT EXISTS 'code_review';
ALTER TYPE "ReviewTaskKindV2" ADD VALUE IF NOT EXISTS 'finding_revalidation';
ALTER TYPE "ReviewTaskKindV2" ADD VALUE IF NOT EXISTS 'conflict_review';

CREATE TABLE "ReviewRunAuthorizationRenewalReceipt" (
    "renewalReplayKeyHash" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "renewalProofHash" TEXT NOT NULL,
    "authorizationVersion" INTEGER NOT NULL,
    "renewedExpiresAt" TIMESTAMP(3) NOT NULL,
    "renewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewRunAuthorizationRenewalReceipt_pkey" PRIMARY KEY ("renewalReplayKeyHash")
);

CREATE INDEX "ReviewRunAuthorizationRenewalReceipt_authorizationId_created_idx"
  ON "ReviewRunAuthorizationRenewalReceipt"("authorizationId", "createdAt");
CREATE INDEX "ReviewRunAuthorizationRenewalReceipt_createdAt_renewalReplay_idx"
  ON "ReviewRunAuthorizationRenewalReceipt"("createdAt", "renewalReplayKeyHash");

ALTER TABLE "ReviewRunAuthorizationRenewalReceipt"
  ADD CONSTRAINT "ReviewRunAuthorizationRenewalReceipt_authorizationId_fkey"
  FOREIGN KEY ("authorizationId") REFERENCES "ReviewRunAuthorization"("authorizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "ReviewRunAuthorizationRenewalReceipt"
  ADD CONSTRAINT "ReviewRunAuthorizationRenewalReceipt_positive_version"
  CHECK ("authorizationVersion" > 0);
