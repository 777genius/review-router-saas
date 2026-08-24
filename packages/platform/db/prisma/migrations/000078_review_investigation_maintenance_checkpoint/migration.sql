BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE "ReviewInvestigationMaintenanceCheckpoint" (
  "checkpointKey" TEXT NOT NULL,
  "cursorExpiresAt" TIMESTAMP(3),
  "cursorPrivateMaterialId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewInvestigationMaintenanceCheckpoint_pkey"
    PRIMARY KEY ("checkpointKey"),
  CONSTRAINT "ReviewInvestigationMaintenanceCheckpoint_key_check"
    CHECK ("checkpointKey" = 'private_material_prune.v1'),
  CONSTRAINT "ReviewInvestigationMaintenanceCheckpoint_cursor_pair_check"
    CHECK (
      ("cursorExpiresAt" IS NULL) = ("cursorPrivateMaterialId" IS NULL)
      AND ("cursorPrivateMaterialId" IS NULL OR length("cursorPrivateMaterialId") > 0)
    )
);

REVOKE ALL ON TABLE "ReviewInvestigationMaintenanceCheckpoint" FROM PUBLIC;

DO $$
BEGIN
  IF to_regrole('reviewrouter_release_migration') IS NOT NULL THEN
    ALTER TABLE "ReviewInvestigationMaintenanceCheckpoint"
      OWNER TO reviewrouter_release_migration;
  END IF;
  IF to_regrole('reviewrouter_worker') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE
      ON TABLE "ReviewInvestigationMaintenanceCheckpoint"
      TO reviewrouter_worker;
  END IF;
  IF to_regrole('reviewrouter_api') IS NOT NULL THEN
    REVOKE ALL ON TABLE "ReviewInvestigationMaintenanceCheckpoint"
      FROM reviewrouter_api;
  END IF;
  IF to_regrole('reviewrouter_web') IS NOT NULL THEN
    REVOKE ALL ON TABLE "ReviewInvestigationMaintenanceCheckpoint"
      FROM reviewrouter_web;
  END IF;
END
$$;

COMMIT;
