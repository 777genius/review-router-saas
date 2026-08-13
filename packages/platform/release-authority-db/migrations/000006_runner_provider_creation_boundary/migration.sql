-- Bind provider job evidence to the domain-owned instant captured before the
-- create request.  The later database observation remains audit metadata and
-- is deliberately not used as the provider creation lower bound.
BEGIN;

ALTER TABLE release_authority.runner_job
  ADD COLUMN IF NOT EXISTS provider_creation_not_before timestamptz(3);

UPDATE release_authority.runner_job job
SET provider_creation_not_before = intent.created_at
FROM release_authority.runner_intent intent
WHERE intent.intent_id = job.provisioning_intent_id
  AND job.provider_creation_not_before IS NULL;

DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM release_authority.runner_job job
    JOIN release_authority.runner_intent intent
      ON intent.intent_id = job.provisioning_intent_id
    WHERE job.provider_creation_not_before IS DISTINCT FROM intent.created_at
      OR job.observed_at < intent.created_at
  ) THEN
    RAISE EXCEPTION 'release authority provider creation history invalid';
  END IF;
END
$preflight$;

ALTER TABLE release_authority.runner_job
  ADD CONSTRAINT runner_job_provider_creation_not_before_nn
    CHECK (provider_creation_not_before IS NOT NULL) NOT VALID,
  ADD CONSTRAINT runner_job_provider_creation_boundary
    CHECK (observed_at >= provider_creation_not_before) NOT VALID;

ALTER TABLE release_authority.runner_job
  VALIDATE CONSTRAINT runner_job_provider_creation_not_before_nn;
ALTER TABLE release_authority.runner_job
  VALIDATE CONSTRAINT runner_job_provider_creation_boundary;
ALTER TABLE release_authority.runner_job
  ALTER COLUMN provider_creation_not_before SET NOT NULL;
ALTER TABLE release_authority.runner_job
  DROP CONSTRAINT runner_job_provider_creation_not_before_nn;

CREATE OR REPLACE FUNCTION release_authority.release_runner_persist_job(p_job jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE intent release_authority.runner_intent%ROWTYPE;
DECLARE rollout release_authority.rollout%ROWTYPE;
DECLARE existing release_authority.runner_job%ROWTYPE;
DECLARE duplicate_job boolean;
DECLARE not_before timestamptz(3);
DECLARE observed timestamptz(3);
BEGIN
  SELECT * INTO STRICT rollout FROM release_authority.rollout
    WHERE rollout_id = p_job->>'rolloutId' FOR UPDATE;
  SELECT * INTO STRICT intent FROM release_authority.runner_intent
    WHERE intent_id = p_job->>'provisioningIntentId' FOR UPDATE;
  not_before := (p_job->>'providerCreationNotBefore')::timestamptz(3);
  observed := (p_job->>'observedAt')::timestamptz(3);
  IF intent.rollout_id <> rollout.rollout_id
    OR intent.service_id <> p_job->>'serviceId'
    OR intent.lifecycle <> p_job->>'lifecycle'
    OR coalesce(p_job->>'jobId','') = ''
    OR not_before IS DISTINCT FROM intent.created_at
    OR observed < not_before
    OR coalesce(p_job->>'cleanupCanary','') <>
      'rr-cleanup:'||intent.rollout_id||':'||intent.runner_name
    OR intent.effect_state NOT IN ('dispatching','bound','cleaned','abandoned','blocked')
  THEN RAISE EXCEPTION 'release runner effect job persistence invalid'; END IF;

  SELECT * INTO existing FROM release_authority.runner_job
    WHERE job_id = p_job->>'jobId';
  IF FOUND THEN
    IF existing.rollout_id <> intent.rollout_id
      OR existing.provisioning_intent_id <> intent.intent_id
      OR existing.service_id <> intent.service_id
      OR existing.observed_at <> observed
      OR existing.provider_creation_not_before <> not_before
      OR existing.lifecycle <> intent.lifecycle
      OR existing.cleanup_canary <> p_job->>'cleanupCanary'
    THEN RAISE EXCEPTION 'release runner effect job identity conflict'; END IF;
    RETURN true;
  END IF;

  duplicate_job := intent.provider_job_id IS NOT NULL
      AND intent.provider_job_id <> p_job->>'jobId'
    OR EXISTS (
      SELECT 1 FROM release_authority.runner_job job
      WHERE job.provisioning_intent_id = intent.intent_id
        AND job.job_id <> p_job->>'jobId'
    );
  INSERT INTO release_authority.runner_job
    (job_id, rollout_id, provisioning_intent_id, service_id, observed_at,
     provider_creation_not_before, cleanup_canary, lifecycle)
  VALUES (p_job->>'jobId', intent.rollout_id, intent.intent_id,
    intent.service_id, observed, not_before,
    p_job->>'cleanupCanary', intent.lifecycle);

  IF duplicate_job OR intent.effect_state IN ('cleaned','abandoned')
    OR rollout.state <> 'pre_activation' THEN
    UPDATE release_authority.runner_intent SET effect_state = 'blocked',
      effect_safe_for_compensation = false,
      effect_block_reason = 'duplicate',
      reconciliation_observation = jsonb_build_object(
        'reason', 'duplicate',
        'lateProviderJobId', p_job->>'jobId',
        'rolloutStateAtPersistence', rollout.state::text),
      reconciled_at = clock_timestamp()
    WHERE intent_id = intent.intent_id;
  END IF;
  RETURN true;
END $body$;

CREATE OR REPLACE FUNCTION release_authority.release_runner_list_open_jobs(p_rollout_id text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog
AS $body$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'rolloutId', rollout_id, 'serviceId', service_id, 'jobId', job_id,
    'observedAt', to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'providerCreationNotBefore', to_char(provider_creation_not_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'cleanupCanary', cleanup_canary, 'lifecycle', lifecycle,
    'provisioningIntentId', provisioning_intent_id) ORDER BY observed_at), '[]'::jsonb)
  FROM release_authority.runner_job
  WHERE rollout_id = p_rollout_id AND terminal_at IS NULL
$body$;

CREATE OR REPLACE FUNCTION release_authority.release_runner_cleanup_observation_seed(
  p_job_id text
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog
AS $seed$
  SELECT jsonb_build_object(
    'jobId', job_id, 'serviceId', service_id, 'cleanupCanary', cleanup_canary,
    'observedAt', to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'providerCreationNotBefore', to_char(provider_creation_not_before AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM release_authority.runner_job WHERE job_id = p_job_id
$seed$;

CREATE OR REPLACE FUNCTION release_authority.release_runner_persist_cleanup_witness(
  p_job_id text, p_witness jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $witness$
DECLARE current_row release_authority.runner_job%ROWTYPE;
BEGIN
  SELECT * INTO current_row FROM release_authority.runner_job
    WHERE job_id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF current_row.cleanup_provider_witness IS NOT NULL THEN
    RETURN current_row.cleanup_provider_witness = p_witness;
  END IF;
  IF p_witness->>'jobId' <> p_job_id OR p_witness->>'canary' <> current_row.cleanup_canary OR
     coalesce(p_witness->>'providerStatus','') NOT IN ('succeeded','failed','canceled') OR
     p_witness->>'containerTerminated' <> 'true' OR
     jsonb_typeof(p_witness->'removedPaths') <> 'array' OR
     jsonb_array_length(p_witness->'removedPaths') = 0 OR
     jsonb_typeof(p_witness->'remainingPaths') <> 'array' OR
     jsonb_array_length(p_witness->'remainingPaths') <> 0 OR
     coalesce(p_witness->>'logSha256','') !~ '^sha256:[a-f0-9]{64}$' OR
     coalesce(p_witness->>'providerLogId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' OR
     coalesce(p_witness->>'providerCreatedAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$' OR
     coalesce(p_witness->>'providerObservedAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$' OR
     (p_witness->>'providerCreatedAt')::timestamptz < current_row.provider_creation_not_before OR
     (p_witness->>'providerObservedAt')::timestamptz < (p_witness->>'providerCreatedAt')::timestamptz OR
     (p_witness->>'providerObservedAt')::timestamptz > clock_timestamp() + interval '5 minutes' OR
     EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_witness->'removedPaths') AS path
       WHERE path !~ '^/runner/_work/rr-[A-Za-z0-9][A-Za-z0-9._-]{1,125}(/[A-Za-z0-9][A-Za-z0-9._-]{0,127})*$') THEN
    RAISE EXCEPTION 'release runner cleanup witness invalid';
  END IF;
  UPDATE release_authority.runner_job
    SET cleanup_provider_witness = p_witness WHERE job_id = p_job_id;
  RETURN true;
END
$witness$;

REVOKE ALL ON FUNCTION release_authority.release_runner_persist_job(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_list_open_jobs(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_cleanup_observation_seed(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_persist_cleanup_witness(text,jsonb) FROM PUBLIC;

COMMIT;
