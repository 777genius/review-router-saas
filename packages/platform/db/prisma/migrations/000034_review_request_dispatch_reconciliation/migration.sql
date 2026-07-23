BEGIN;

LOCK TABLE "ReviewRequestedIntent" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ReviewRequestedIntent"
    WHERE "state" = 'dispatching'
  ) THEN
    RAISE EXCEPTION 'review_requested_dispatching_migration_preflight';
  END IF;
END $$;

DROP INDEX "ReviewRequestedIntent_state_notBefore_requestId_idx";
DROP INDEX "ReviewRequestedIntent_workspaceId_repositoryConnectionId_sc_idx";
DROP INDEX "ReviewRequestedIntent_one_pending_per_scope";
DROP INDEX "ReviewRequestedIntent_one_pending_scope";

ALTER TYPE "ReviewRequestedIntentStateV2"
  RENAME TO "ReviewRequestedIntentStateV2_old";

CREATE TYPE "ReviewRequestedIntentStateV2" AS ENUM (
  'pending_dispatch',
  'dispatching',
  'reconciling_dispatch',
  'awaiting_authorization',
  'dispatched',
  'terminal',
  'superseded'
);

ALTER TABLE "ReviewRequestedIntent"
  ALTER COLUMN "state" DROP DEFAULT,
  ALTER COLUMN "state" TYPE "ReviewRequestedIntentStateV2"
    USING ("state"::text::"ReviewRequestedIntentStateV2"),
  ALTER COLUMN "state" SET DEFAULT 'pending_dispatch';

DROP TYPE "ReviewRequestedIntentStateV2_old";

CREATE TYPE "ReviewRequestedIntentTerminalReasonV2" AS ENUM (
  'dispatch_failed_no_effect',
  'dispatch_outcome_unknown',
  'authorization_deadline_exceeded',
  'dispatch_attempts_exhausted'
);

ALTER TABLE "ReviewRequestedIntent"
  ADD COLUMN "submissionStartedAt" TIMESTAMP(3),
  ADD COLUMN "nextResolutionAt" TIMESTAMP(3),
  ADD COLUMN "resolutionDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "terminalReason" "ReviewRequestedIntentTerminalReasonV2";

UPDATE "ReviewRequestedIntent"
SET
  "submissionStartedAt" = COALESCE("claimedAt", "updatedAt", "createdAt"),
  "resolutionDeadlineAt" = "updatedAt" + INTERVAL '30 minutes',
  "nextResolutionAt" = LEAST(
    (clock_timestamp() AT TIME ZONE 'UTC'),
    "updatedAt" + INTERVAL '30 minutes'
  )
WHERE "state" = 'awaiting_authorization';

ALTER TABLE "ReviewRequestedIntent"
  ADD CONSTRAINT "ReviewRequestedIntent_resolution_window_check"
    CHECK (
      (
        "state" IN ('reconciling_dispatch', 'awaiting_authorization')
        AND "submissionStartedAt" IS NOT NULL
        AND "nextResolutionAt" IS NOT NULL
        AND "resolutionDeadlineAt" IS NOT NULL
        AND "nextResolutionAt" <= "resolutionDeadlineAt"
      )
      OR (
        "state" NOT IN ('reconciling_dispatch', 'awaiting_authorization')
        AND "nextResolutionAt" IS NULL
      )
    ),
  ADD CONSTRAINT "ReviewRequestedIntent_terminal_reason_check"
    CHECK (
      (
        "state" = 'terminal'
        AND "terminalReason" IS NOT NULL
        AND "claimId" IS NULL
        AND "claimOwnerIdHash" IS NULL
        AND "claimFencingToken" IS NULL
        AND "claimedAt" IS NULL
        AND "claimUntil" IS NULL
      )
      OR (
        "state" <> 'terminal'
        AND "terminalReason" IS NULL
      )
    ),
  ADD CONSTRAINT "ReviewRequestedIntent_reconciling_identity_check"
    CHECK (
      "state" <> 'reconciling_dispatch'
      OR (
        "claimId" IS NOT NULL
        AND "sourceRunId" IS NULL
        AND "sourceRunAttempt" IS NULL
        AND "authorizationId" IS NULL
        AND "executionId" IS NULL
      )
    ),
  ADD CONSTRAINT "ReviewRequestedIntent_awaiting_identity_check"
    CHECK (
      "state" <> 'awaiting_authorization'
      OR (
        "claimId" IS NULL
        AND "sourceRunId" IS NOT NULL
        AND "sourceRunAttempt" IS NOT NULL
        AND "authorizationId" IS NULL
        AND "executionId" IS NULL
      )
    );

CREATE INDEX "ReviewRequestedIntent_state_nextResolutionAt_requestId_idx"
  ON "ReviewRequestedIntent" (
    "state",
    "nextResolutionAt",
    "requestId"
  );

CREATE INDEX "ReviewRequestedIntent_state_notBefore_requestId_idx"
  ON "ReviewRequestedIntent" ("state", "notBefore", "requestId");

CREATE INDEX "ReviewRequestedIntent_workspaceId_repositoryConnectionId_sc_idx"
  ON "ReviewRequestedIntent" (
    "workspaceId",
    "repositoryConnectionId",
    "scmRepositoryIdentityId",
    "pullRequestNumber",
    "state"
  );

CREATE UNIQUE INDEX "ReviewRequestedIntent_one_pending_per_scope"
  ON "ReviewRequestedIntent" (
    "workspaceId",
    "repositoryConnectionId",
    "scmRepositoryIdentityId",
    "pullRequestNumber"
  )
  WHERE "state" = 'pending_dispatch';

CREATE UNIQUE INDEX "ReviewRequestedIntent_one_pending_scope"
  ON "ReviewRequestedIntent" (
    "workspaceId",
    "repositoryConnectionId",
    "scmRepositoryIdentityId",
    "pullRequestNumber"
  )
  WHERE "state" = 'pending_dispatch';

COMMIT;
