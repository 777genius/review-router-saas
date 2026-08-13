CREATE TABLE public."RuntimeGenerationWitnessProof" (
  "rolloutId" TEXT NOT NULL,
  "runtimeRole" TEXT NOT NULL,
  "databaseRole" TEXT NOT NULL,
  "systemIdentifier" TEXT NOT NULL,
  "recoveryWitnessSha256" TEXT NOT NULL,
  "releaseCommitSha" TEXT NOT NULL,
  "provedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "RuntimeGenerationWitnessProof_pkey"
    PRIMARY KEY ("rolloutId", "runtimeRole", "releaseCommitSha"),
  CONSTRAINT "RuntimeGenerationWitnessProof_runtimeRole_check"
    CHECK ("runtimeRole" IN ('web', 'api', 'worker')),
  CONSTRAINT "RuntimeGenerationWitnessProof_sha_check"
    CHECK ("recoveryWitnessSha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "RuntimeGenerationWitnessProof_commit_check"
    CHECK ("releaseCommitSha" ~ '^[a-f0-9]{40}$')
);

REVOKE ALL ON TABLE public."RuntimeGenerationWitnessProof" FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.reviewrouter_record_runtime_generation_witness_proof(
  requested_rollout_id TEXT,
  requested_runtime_role TEXT,
  requested_release_commit_sha TEXT,
  requested_recovery_witness_sha256 TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $proof$
DECLARE
  expected_database_role TEXT;
  binding JSONB;
BEGIN
  IF requested_rollout_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$'
     OR requested_runtime_role NOT IN ('web', 'api', 'worker')
     OR requested_release_commit_sha !~ '^[a-f0-9]{40}$'
     OR requested_recovery_witness_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'runtime generation proof identity invalid';
  END IF;
  expected_database_role := 'reviewrouter_' || requested_runtime_role;
  IF session_user <> expected_database_role THEN
    RAISE EXCEPTION 'runtime generation proof database role mismatch';
  END IF;
  SELECT shobj_description(oid, 'pg_database')::jsonb INTO binding
  FROM pg_database WHERE datname = current_database();
  IF binding IS NULL
     OR binding->>'systemIdentifier' IS DISTINCT FROM
        (SELECT system_identifier::text FROM pg_control_system())
     OR binding->>'recoveryWitnessSha256' IS DISTINCT FROM
        requested_recovery_witness_sha256 THEN
    RAISE EXCEPTION 'runtime generation proof witness binding mismatch';
  END IF;
  INSERT INTO public."RuntimeGenerationWitnessProof" (
    "rolloutId", "runtimeRole", "databaseRole", "systemIdentifier",
    "recoveryWitnessSha256", "releaseCommitSha"
  ) VALUES (
    requested_rollout_id, requested_runtime_role, session_user,
    binding->>'systemIdentifier', requested_recovery_witness_sha256,
    requested_release_commit_sha
  )
  ON CONFLICT ("rolloutId", "runtimeRole", "releaseCommitSha") DO UPDATE
  SET "databaseRole" = EXCLUDED."databaseRole",
      "systemIdentifier" = EXCLUDED."systemIdentifier",
      "recoveryWitnessSha256" = EXCLUDED."recoveryWitnessSha256",
      "provedAt" = clock_timestamp();
END
$proof$;

REVOKE ALL ON FUNCTION public.reviewrouter_record_runtime_generation_witness_proof(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
DO $grant_runtime_proof$
DECLARE runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['reviewrouter_web', 'reviewrouter_api', 'reviewrouter_worker'] LOOP
    IF to_regrole(runtime_role) IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.reviewrouter_record_runtime_generation_witness_proof(TEXT, TEXT, TEXT, TEXT) TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END
$grant_runtime_proof$;

CREATE OR REPLACE FUNCTION public.reviewrouter_read_runtime_generation_witness_proofs(
  requested_rollout_id TEXT,
  requested_release_commit_sha TEXT
) RETURNS TABLE (
  "runtimeRole" TEXT,
  "databaseRole" TEXT,
  "systemIdentifier" TEXT,
  "recoveryWitnessSha256" TEXT,
  "releaseCommitSha" TEXT,
  "provedAt" TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $read$
BEGIN
  IF session_user <> 'reviewrouter_api' THEN
    RAISE EXCEPTION 'runtime generation proof reader role mismatch';
  END IF;
  RETURN QUERY
  SELECT proof."runtimeRole", proof."databaseRole", proof."systemIdentifier",
         proof."recoveryWitnessSha256", proof."releaseCommitSha", proof."provedAt"
  FROM public."RuntimeGenerationWitnessProof" proof
  WHERE proof."rolloutId" = requested_rollout_id
    AND proof."releaseCommitSha" = requested_release_commit_sha
  ORDER BY proof."runtimeRole";
END
$read$;

REVOKE ALL ON FUNCTION public.reviewrouter_read_runtime_generation_witness_proofs(TEXT, TEXT) FROM PUBLIC;
DO $grant_runtime_read$
BEGIN
  IF to_regrole('reviewrouter_api') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.reviewrouter_read_runtime_generation_witness_proofs(TEXT, TEXT)
      TO reviewrouter_api;
  END IF;
END
$grant_runtime_read$;

CREATE OR REPLACE FUNCTION public.reviewrouter_runtime_generation_write_read_canary(
  requested_rollout_id TEXT,
  requested_nonce TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $canary$
DECLARE
  observed_nonce TEXT;
BEGIN
  IF session_user <> 'reviewrouter_api'
     OR requested_rollout_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$'
     OR requested_nonce !~ '^[a-f0-9]{48}$' THEN
    RAISE EXCEPTION 'runtime generation canary identity invalid';
  END IF;
  CREATE TEMPORARY TABLE IF NOT EXISTS pg_temp.reviewrouter_runtime_canary (
    rollout_id TEXT PRIMARY KEY,
    nonce TEXT NOT NULL
  ) ON COMMIT DROP;
  INSERT INTO pg_temp.reviewrouter_runtime_canary (rollout_id, nonce)
  VALUES (requested_rollout_id, requested_nonce)
  ON CONFLICT (rollout_id) DO UPDATE SET nonce = EXCLUDED.nonce;
  SELECT nonce INTO observed_nonce
  FROM pg_temp.reviewrouter_runtime_canary
  WHERE rollout_id = requested_rollout_id;
  IF observed_nonce IS DISTINCT FROM requested_nonce THEN
    RAISE EXCEPTION 'runtime generation canary write read mismatch';
  END IF;
  RETURN observed_nonce;
END
$canary$;

REVOKE ALL ON FUNCTION public.reviewrouter_runtime_generation_write_read_canary(TEXT, TEXT) FROM PUBLIC;
DO $grant_runtime_canary$
BEGIN
  IF to_regrole('reviewrouter_api') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.reviewrouter_runtime_generation_write_read_canary(TEXT, TEXT)
      TO reviewrouter_api;
  END IF;
END
$grant_runtime_canary$;
