ALTER TABLE "ReviewRequestedIntent"
  ADD COLUMN "dispatchAttempt" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "ReviewRequestedIntent_dispatchAttempt_check"
    CHECK ("dispatchAttempt" BETWEEN 1 AND 10);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ReviewInvocationLeaseV2"
    WHERE "state" = 'active' AND "purpose" = 'provider_execution'
    GROUP BY "providerVoteIdentityHash"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'review_provider_lane_duplicate_active_preflight';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "ReviewInvocationLeaseV2"
    WHERE "state" = 'active'
      AND "purpose" = 'provider_execution'
      AND "expiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
  ) THEN
    RAISE EXCEPTION 'review_provider_lane_expired_active_preflight';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "ReviewRequestedIntent"
    WHERE "sourceRunId" IS NOT NULL AND "sourceRunAttempt" IS NOT NULL
    GROUP BY "repositoryConnectionId", "sourceRunId", "sourceRunAttempt"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'review_requested_source_run_duplicate_preflight';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "ReviewRequestedIntent"
    WHERE "state" = 'pending_dispatch'
    GROUP BY
      "workspaceId",
      "repositoryConnectionId",
      "scmRepositoryIdentityId",
      "pullRequestNumber"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'review_requested_pending_scope_duplicate_preflight';
  END IF;
END $$;

CREATE UNIQUE INDEX "ReviewInvocationLeaseV2_one_active_provider_vote_lane"
  ON "ReviewInvocationLeaseV2" ("providerVoteIdentityHash")
  WHERE "state" = 'active' AND "purpose" = 'provider_execution';

CREATE UNIQUE INDEX "ReviewRequestedIntent_source_run_identity_key"
  ON "ReviewRequestedIntent" (
    "repositoryConnectionId",
    "sourceRunId",
    "sourceRunAttempt"
  )
  WHERE "sourceRunId" IS NOT NULL AND "sourceRunAttempt" IS NOT NULL;

CREATE UNIQUE INDEX "ReviewRequestedIntent_one_pending_scope"
  ON "ReviewRequestedIntent" (
    "workspaceId",
    "repositoryConnectionId",
    "scmRepositoryIdentityId",
    "pullRequestNumber"
  )
  WHERE "state" = 'pending_dispatch';
