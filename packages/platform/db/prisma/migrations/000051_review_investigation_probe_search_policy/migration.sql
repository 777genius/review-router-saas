ALTER TABLE "ReviewInvestigation"
ADD COLUMN "probePolicyVersion" TEXT NOT NULL DEFAULT 'review-investigation-probe-policy.v1',
ADD COLUMN "searchPolicyVersion" TEXT NOT NULL DEFAULT 'review-investigation-fixed-string-search.v1';

-- Keep both defaults until every writer predating this migration is retired.
-- A later contract migration may remove them after rollout convergence.
