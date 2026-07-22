CREATE SEQUENCE "OutboxEvent_claimVersion_seq" AS BIGINT;

ALTER TABLE "OutboxEvent"
  ADD COLUMN "claimId" TEXT,
  ADD COLUMN "claimVersion" BIGINT,
  ADD COLUMN "claimOwnerHash" TEXT,
  ADD COLUMN "claimUntil" TIMESTAMP(3);

CREATE UNIQUE INDEX "OutboxEvent_claimId_key"
  ON "OutboxEvent"("claimId");
CREATE INDEX "OutboxEvent_status_claimUntil_idx"
  ON "OutboxEvent"("status", "claimUntil");

CREATE TABLE "OutboxFencingControl" (
  "id" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "activatedAt" TIMESTAMP(3),
  "activatedBy" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OutboxFencingControl_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OutboxFencingControl_singleton_check" CHECK ("id" = 1)
);

INSERT INTO "OutboxFencingControl" ("id", "enabled") VALUES (1, false);

CREATE OR REPLACE FUNCTION reviewrouter_guard_outbox_claim_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  fencing_enabled BOOLEAN;
  transaction_claim_id TEXT;
  transaction_claim_version BIGINT;
BEGIN
  SELECT control."enabled"
  INTO fencing_enabled
  FROM "OutboxFencingControl" control
  WHERE control."id" = 1;

  IF NOT COALESCE(fencing_enabled, false) THEN
    RETURN NEW;
  END IF;

  IF OLD."status" <> 'processing'::"OutboxEventStatus"
     AND NEW."status" = 'processing'::"OutboxEventStatus" THEN
    IF NEW."claimId" IS NULL
       OR NEW."claimVersion" IS NULL
       OR NEW."claimOwnerHash" IS NULL
       OR NEW."claimUntil" IS NULL
       OR (OLD."claimVersion" IS NOT NULL
           AND NEW."claimVersion" <= OLD."claimVersion") THEN
      RAISE EXCEPTION 'outbox_unfenced_claim'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'processing'::"OutboxEventStatus" THEN
    transaction_claim_id := NULLIF(
      current_setting('reviewrouter.outbox_claim_id', true),
      ''
    );
    transaction_claim_version := NULLIF(
      current_setting('reviewrouter.outbox_claim_version', true),
      ''
    )::BIGINT;

    IF OLD."claimId" IS NULL
       OR OLD."claimVersion" IS NULL
       OR transaction_claim_id IS DISTINCT FROM OLD."claimId"
       OR transaction_claim_version IS DISTINCT FROM OLD."claimVersion" THEN
      RAISE EXCEPTION 'outbox_stale_claim'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW."status" = 'processing'::"OutboxEventStatus"
     AND (
       NEW."claimId" IS NULL
       OR NEW."claimVersion" IS NULL
       OR NEW."claimOwnerHash" IS NULL
       OR NEW."claimUntil" IS NULL
     ) THEN
    RAISE EXCEPTION 'outbox_processing_claim_required'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "OutboxEvent_claim_transition_guard"
BEFORE UPDATE ON "OutboxEvent"
FOR EACH ROW
EXECUTE FUNCTION reviewrouter_guard_outbox_claim_transition();
