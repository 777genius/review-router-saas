-- Global ordering is allocated before an installation inventory is fetched.
CREATE SEQUENCE "RepositoryInventoryGeneration" AS BIGINT;
ALTER TABLE "RepositoryConnection"
  ADD COLUMN "inventoryGeneration" BIGINT NOT NULL DEFAULT 0;

-- Old setup PRs have no verified artifact binding and require installed recovery.
ALTER TABLE "WorkflowProvisioning" ADD COLUMN "pullRequestHeadSha" TEXT;
