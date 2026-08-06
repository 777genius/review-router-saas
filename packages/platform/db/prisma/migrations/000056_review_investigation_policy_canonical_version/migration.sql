ALTER TABLE "ReviewInvestigation"
ADD COLUMN "policyCanonicalVersion" TEXT NOT NULL
DEFAULT 'review-investigation-policy.v1',
ADD CONSTRAINT "ReviewInvestigation_policy_canonical_version" CHECK (
  "policyCanonicalVersion" IN (
    'review-investigation-policy.v1',
    'review-investigation-policy.v2'
  )
);

-- Keep the v1 default until every writer predating this migration is retired.
