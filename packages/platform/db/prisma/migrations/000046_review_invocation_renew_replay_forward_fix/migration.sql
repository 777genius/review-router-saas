-- Forward repair for databases that applied an earlier immutable copy of
-- 000029 before renew replay identity was added to the development branch.
ALTER TABLE "ReviewInvocationLeaseV2"
  ADD COLUMN IF NOT EXISTS "lastRenewRequestIdHash" TEXT,
  ADD COLUMN IF NOT EXISTS "lastRenewRequestHash" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ReviewInvocationLeaseV2_valid_renew_replay_identity'
      AND conrelid = '"ReviewInvocationLeaseV2"'::regclass
  ) THEN
    ALTER TABLE "ReviewInvocationLeaseV2"
      ADD CONSTRAINT "ReviewInvocationLeaseV2_valid_renew_replay_identity"
      CHECK (
        ("lastRenewRequestIdHash" IS NULL) =
        ("lastRenewRequestHash" IS NULL)
      );
  END IF;
END $$;
