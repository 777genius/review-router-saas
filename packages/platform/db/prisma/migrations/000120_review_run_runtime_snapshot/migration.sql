-- Private first-admission pin on the existing authority row. Legacy rows stay NULL.
ALTER TABLE "ReviewRunAuthorization" ADD COLUMN "runtimeSnapshotCanonicalJson" TEXT;
ALTER TABLE "ReviewRunAuthorization" ADD CONSTRAINT "ReviewRunAuthorization_runtime_snapshot_bound"
  CHECK ("runtimeSnapshotCanonicalJson" IS NULL OR
    (octet_length("runtimeSnapshotCanonicalJson") BETWEEN 2 AND 32768 AND
     jsonb_typeof("runtimeSnapshotCanonicalJson"::jsonb) = 'object' AND
     "runtimeSnapshotCanonicalJson"::jsonb ->> 'snapshotVersion' = '1') IS TRUE);

CREATE FUNCTION review_run_runtime_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."runtimeSnapshotCanonicalJson" IS DISTINCT FROM OLD."runtimeSnapshotCanonicalJson" THEN
    RAISE EXCEPTION 'review_run_runtime_snapshot_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ReviewRunAuthorization_runtime_snapshot_immutable"
BEFORE UPDATE OF "runtimeSnapshotCanonicalJson" ON "ReviewRunAuthorization"
FOR EACH ROW EXECUTE FUNCTION review_run_runtime_snapshot_immutable();
