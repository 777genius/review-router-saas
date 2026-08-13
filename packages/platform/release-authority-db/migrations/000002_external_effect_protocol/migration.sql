-- Forward-only external-effect safety protocol. Provider dispatch is authorized by
-- one atomic prepared -> dispatching transition; dispatching is never lease-redriven.
ALTER TABLE release_authority.runner_intent
  ADD COLUMN effect_state text NOT NULL DEFAULT 'blocked',
  ADD COLUMN effect_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN effect_owner text,
  ADD COLUMN effect_lease_expires_at timestamptz(3),
  ADD COLUMN effect_dispatch_started_at timestamptz(3),
  ADD COLUMN effect_discovery_deadline timestamptz(3),
  ADD COLUMN effect_safe_for_compensation boolean NOT NULL DEFAULT false,
  ADD COLUMN effect_block_reason text;

ALTER TABLE release_authority.runner_intent
  ADD CONSTRAINT runner_intent_effect_state_check CHECK
    (effect_state IN ('prepared','dispatching','bound','cleaned','abandoned','blocked')),
  ADD CONSTRAINT runner_intent_effect_epoch_check CHECK (effect_epoch >= 0),
  ADD CONSTRAINT runner_intent_effect_safe_check CHECK
    (NOT effect_safe_for_compensation OR effect_state IN ('cleaned','abandoned')),
  ADD CONSTRAINT runner_intent_effect_dispatch_check CHECK
    ((effect_state <> 'dispatching') OR
      (effect_epoch > 0 AND effect_owner IS NOT NULL AND
       effect_dispatch_started_at IS NOT NULL AND effect_discovery_deadline IS NOT NULL)),
  ADD CONSTRAINT runner_intent_effect_bound_check CHECK
    ((effect_state <> 'bound') OR provider_job_id IS NOT NULL);

UPDATE release_authority.runner_intent SET
  effect_state = CASE
    WHEN outcome = 'bound' AND provider_job_id IS NOT NULL THEN 'bound'
    WHEN outcome = 'persistence_failed_cleaned' THEN 'cleaned'
    ELSE 'blocked'
  END,
  effect_safe_for_compensation = coalesce(outcome = 'persistence_failed_cleaned', false),
  effect_block_reason = CASE
    WHEN outcome IS NULL OR outcome = 'persistence_failed_unknown'
      THEN 'unresolved_legacy' ELSE NULL END,
  effect_owner = NULL,
  effect_lease_expires_at = NULL;

ALTER TABLE release_authority.runner_intent
  ADD CONSTRAINT runner_intent_effect_protocol_invariant CHECK (
    (effect_state = 'prepared' AND effect_owner IS NOT NULL AND
      effect_lease_expires_at IS NOT NULL AND provider_job_id IS NULL AND
      effect_dispatch_started_at IS NULL AND effect_discovery_deadline IS NULL AND
      NOT effect_safe_for_compensation) OR
    (effect_state = 'dispatching' AND effect_owner IS NOT NULL AND effect_epoch > 0 AND
      effect_lease_expires_at IS NULL AND provider_job_id IS NULL AND
      effect_dispatch_started_at IS NOT NULL AND effect_discovery_deadline IS NOT NULL AND
      NOT effect_safe_for_compensation) OR
    (effect_state = 'bound' AND provider_job_id IS NOT NULL AND
      NOT effect_safe_for_compensation) OR
    (effect_state = 'cleaned' AND effect_safe_for_compensation) OR
    (effect_state = 'abandoned' AND provider_job_id IS NULL AND
      effect_safe_for_compensation) OR
    (effect_state = 'blocked' AND NOT effect_safe_for_compensation)
  );

CREATE FUNCTION release_authority.release_runner_effect_snapshot(
  p_row release_authority.runner_intent
) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $body$
  SELECT jsonb_build_object(
    'state', p_row.effect_state,
    'ownerId', p_row.effect_owner,
    'epoch', p_row.effect_epoch,
    'providerId', p_row.provider_job_id,
    'safeForCompensation', p_row.effect_safe_for_compensation,
    'reconciliation', CASE
      WHEN p_row.effect_state IN ('cleaned','abandoned') THEN
        jsonb_build_object('result','clean','safeForCompensation',true)
      WHEN p_row.effect_state = 'blocked' THEN
        jsonb_build_object('result','blocked','safeForCompensation',false,
          'reason',coalesce(p_row.effect_block_reason,'unknown'))
      ELSE jsonb_build_object('result','pending','safeForCompensation',false)
    END)
$body$;

CREATE OR REPLACE FUNCTION release_authority.release_runner_list_intents(p_rollout_id text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog
AS $body$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', intent_id, 'rolloutId', rollout_id, 'serviceId', service_id,
    'lifecycle', lifecycle, 'workflowJobId', workflow_job_id,
    'runnerName', runner_name,
    'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'startCommandSha256', start_command_sha256,
    'creationLeaseOwner', effect_owner,
    'creationLeaseExpiresAt', to_char(effect_lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effect', release_authority.release_runner_effect_snapshot(r)) ORDER BY created_at), '[]'::jsonb)
  FROM release_authority.runner_intent r WHERE rollout_id = p_rollout_id
$body$;

CREATE FUNCTION release_authority.release_runner_prepare_effect(p_intent jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE current_row release_authority.runner_intent%ROWTYPE;
DECLARE rollout_row release_authority.rollout%ROWTYPE;
BEGIN
  IF coalesce(p_intent->>'id','') !~ '^rri-[a-f0-9]{64}$'
    OR coalesce(p_intent->>'creationLeaseOwner','') !~ '^rrc-[0-9a-f-]{36}$'
    OR coalesce(p_intent->>'startCommandSha256','') !~ '^sha256:[a-f0-9]{64}$'
    OR coalesce(p_intent->>'lifecycle','') NOT IN ('role','cutover')
  THEN RAISE EXCEPTION 'release runner effect preparation invalid'; END IF;

  SELECT * INTO rollout_row FROM release_authority.rollout
    WHERE rollout_id = p_intent->>'rolloutId' FOR UPDATE;
  IF NOT FOUND OR rollout_row.state <> 'pre_activation'
    THEN RAISE EXCEPTION 'release runner effect preparation frozen'; END IF;

  INSERT INTO release_authority.runner_intent(
    intent_id, rollout_id, service_id, lifecycle, workflow_job_id, runner_name,
    created_at, start_command_sha256, effect_state, effect_epoch, effect_owner,
    effect_lease_expires_at, effect_safe_for_compensation)
  VALUES (p_intent->>'id', p_intent->>'rolloutId', p_intent->>'serviceId',
    p_intent->>'lifecycle', p_intent->>'workflowJobId', p_intent->>'runnerName',
    (p_intent->>'createdAt')::timestamptz, p_intent->>'startCommandSha256',
    'prepared', 0, p_intent->>'creationLeaseOwner',
    clock_timestamp() + interval '120 seconds', false)
  ON CONFLICT (intent_id) DO NOTHING;

  SELECT * INTO STRICT current_row FROM release_authority.runner_intent
    WHERE intent_id = p_intent->>'id' FOR UPDATE;
  IF current_row.rollout_id <> p_intent->>'rolloutId'
    OR current_row.service_id <> p_intent->>'serviceId'
    OR current_row.lifecycle <> p_intent->>'lifecycle'
    OR current_row.workflow_job_id <> p_intent->>'workflowJobId'
    OR current_row.runner_name <> p_intent->>'runnerName'
    OR current_row.start_command_sha256 <> p_intent->>'startCommandSha256'
  THEN RAISE EXCEPTION 'release runner effect identity conflict'; END IF;

  -- Only prepared work may be lease-redriven. Dispatching and blocked are immutable
  -- with respect to provider POST authority.
  IF current_row.effect_state = 'prepared'
    AND current_row.effect_lease_expires_at <= clock_timestamp() THEN
    UPDATE release_authority.runner_intent SET
      effect_owner = p_intent->>'creationLeaseOwner',
      effect_lease_expires_at = clock_timestamp() + interval '120 seconds'
    WHERE intent_id = current_row.intent_id RETURNING * INTO current_row;
  END IF;
  RETURN release_authority.release_runner_effect_snapshot(current_row);
END $body$;

CREATE FUNCTION release_authority.release_runner_acquire_dispatch_permit(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE current_row release_authority.runner_intent%ROWTYPE;
DECLARE rollout_row release_authority.rollout%ROWTYPE;
BEGIN
  IF coalesce(p_input->>'claimantId','') !~ '^rrc-[0-9a-f-]{36}$'
    OR coalesce(p_input->>'startCommandSha256','') !~ '^sha256:[a-f0-9]{64}$'
    OR (p_input->>'expectedEpoch')::bigint < 0
    OR (p_input->>'leaseSeconds')::integer NOT BETWEEN 30 AND 300
  THEN RAISE EXCEPTION 'release runner dispatch permit invalid'; END IF;
  SELECT * INTO STRICT current_row FROM release_authority.runner_intent
    WHERE intent_id = p_input->>'intentId' FOR UPDATE;
  SELECT * INTO STRICT rollout_row FROM release_authority.rollout
    WHERE rollout_id = current_row.rollout_id FOR UPDATE;
  IF rollout_row.state <> 'pre_activation'
    THEN RAISE EXCEPTION 'release runner dispatch frozen'; END IF;
  IF current_row.start_command_sha256 <> p_input->>'startCommandSha256'
    THEN RAISE EXCEPTION 'release runner dispatch command conflict'; END IF;
  IF current_row.effect_state = 'prepared'
    AND current_row.effect_epoch = (p_input->>'expectedEpoch')::bigint
    AND current_row.effect_owner = p_input->>'claimantId'
    AND current_row.effect_lease_expires_at > clock_timestamp() THEN
    UPDATE release_authority.runner_intent SET
      effect_state = 'dispatching',
      effect_epoch = effect_epoch + 1,
      effect_dispatch_started_at = clock_timestamp(),
      effect_discovery_deadline = clock_timestamp() + interval '120 seconds',
      effect_lease_expires_at = NULL
    WHERE intent_id = current_row.intent_id RETURNING * INTO current_row;
  END IF;
  RETURN release_authority.release_runner_effect_snapshot(current_row);
END $body$;

CREATE OR REPLACE FUNCTION release_authority.release_runner_persist_job(p_job jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE intent release_authority.runner_intent%ROWTYPE;
BEGIN
  SELECT * INTO STRICT intent FROM release_authority.runner_intent
    WHERE intent_id = p_job->>'provisioningIntentId' FOR UPDATE;
  IF intent.effect_state <> 'dispatching'
    OR intent.rollout_id <> p_job->>'rolloutId'
    OR intent.service_id <> p_job->>'serviceId'
    OR intent.lifecycle <> p_job->>'lifecycle'
    OR coalesce(p_job->>'jobId','') = ''
    OR coalesce(p_job->>'cleanupCanary','') <>
      'rr-cleanup:'||intent.rollout_id||':'||intent.runner_name
  THEN RAISE EXCEPTION 'release runner effect job persistence invalid'; END IF;
  INSERT INTO release_authority.runner_job
    (job_id, rollout_id, provisioning_intent_id, service_id, observed_at,
     cleanup_canary, lifecycle)
  VALUES (p_job->>'jobId', p_job->>'rolloutId', p_job->>'provisioningIntentId',
    p_job->>'serviceId', (p_job->>'observedAt')::timestamptz,
    p_job->>'cleanupCanary', p_job->>'lifecycle');
  RETURN true;
END $body$;

CREATE FUNCTION release_authority.release_runner_reconcile_effect(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE current_row release_authority.runner_intent%ROWTYPE;
DECLARE result text := p_input->'reconciliation'->>'result';
DECLARE reason text := p_input->'reconciliation'->>'reason';
BEGIN
  IF result IS NULL OR result NOT IN ('clean','pending','blocked')
    OR (result = 'clean' AND p_input->'reconciliation'->>'safeForCompensation' IS DISTINCT FROM 'true')
    OR (result <> 'clean' AND p_input->'reconciliation'->>'safeForCompensation' IS DISTINCT FROM 'false')
  THEN RAISE EXCEPTION 'release runner reconciliation safety invalid'; END IF;
  SELECT * INTO STRICT current_row FROM release_authority.runner_intent
    WHERE intent_id = p_input->>'intentId' FOR UPDATE;
  IF current_row.effect_state IN ('cleaned','abandoned','blocked')
    THEN RETURN release_authority.release_runner_effect_snapshot(current_row); END IF;
  IF current_row.effect_state NOT IN ('dispatching','bound')
    OR current_row.effect_epoch <> (p_input->>'expectedEpoch')::bigint
  THEN RAISE EXCEPTION 'release runner reconciliation fence conflict'; END IF;

  IF result = 'clean' THEN
    IF coalesce(p_input->>'jobId','') = ''
      OR jsonb_typeof(p_input->'observation') IS DISTINCT FROM 'object'
      OR p_input->'observation'->>'step' IS DISTINCT FROM
        (CASE current_row.lifecycle WHEN 'role' THEN 'cleanup_role_runner'
          ELSE 'cleanup_cutover_runner' END)
      OR p_input->'observation'->'provider'->>'renderJobId' IS DISTINCT FROM p_input->>'jobId'
      OR p_input->'observation'->'facts'->'provider'->>'id' IS DISTINCT FROM p_input->>'jobId'
      OR p_input->'observation'->'facts'->'provider'->>'serviceId' IS DISTINCT FROM current_row.service_id
      OR coalesce(p_input->'observation'->'facts'->'provider'->>'status','')
        NOT IN ('succeeded','failed','canceled')
      OR p_input->'observation'->'facts'->'runner'->>'listenerStopped' IS DISTINCT FROM 'true'
      OR p_input->'observation'->'facts'->'runner'->>'workspaceRemoved' IS DISTINCT FROM 'true'
      OR p_input->'observation'->'facts'->'runner'->>'credentialProcessGone' IS DISTINCT FROM 'true'
      OR p_input->'observation'->'facts'->'runner'->>'canary' IS DISTINCT FROM
        'rr-cleanup:'||current_row.rollout_id||':'||current_row.runner_name
    THEN RAISE EXCEPTION 'release runner clean reconciliation proof invalid'; END IF;
    UPDATE release_authority.runner_intent SET effect_state = 'cleaned',
      effect_safe_for_compensation = true, effect_block_reason = NULL,
      reconciliation_observation = p_input->'observation', reconciled_at = clock_timestamp()
    WHERE intent_id = current_row.intent_id RETURNING * INTO current_row;
  ELSIF result = 'blocked' THEN
    IF reason IS NULL OR reason NOT IN ('unknown','duplicate','timeout','unresolved_legacy')
      THEN RAISE EXCEPTION 'release runner reconciliation reason invalid'; END IF;
    UPDATE release_authority.runner_intent SET effect_state = 'blocked',
      effect_safe_for_compensation = false, effect_block_reason = reason,
      reconciliation_observation = p_input->'observation', reconciled_at = clock_timestamp()
    WHERE intent_id = current_row.intent_id RETURNING * INTO current_row;
  ELSIF result = 'pending' AND nullif(p_input->>'jobId','') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM release_authority.runner_job
      WHERE job_id = p_input->>'jobId'
        AND provisioning_intent_id = current_row.intent_id
        AND rollout_id = current_row.rollout_id
        AND service_id = current_row.service_id
        AND lifecycle = current_row.lifecycle
    ) THEN RAISE EXCEPTION 'release runner bind requires durable job'; END IF;
    UPDATE release_authority.runner_intent SET effect_state = 'bound',
      provider_job_id = p_input->>'jobId', outcome = 'bound',
      effect_safe_for_compensation = false, reconciled_at = clock_timestamp()
    WHERE intent_id = current_row.intent_id
      AND (provider_job_id IS NULL OR provider_job_id = p_input->>'jobId')
    RETURNING * INTO current_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'release runner reconciliation provider conflict'; END IF;
  ELSIF result = 'pending' AND current_row.effect_state = 'dispatching'
    AND clock_timestamp() > current_row.effect_discovery_deadline THEN
    UPDATE release_authority.runner_intent SET effect_state = 'blocked',
      effect_block_reason = 'timeout', effect_safe_for_compensation = false,
      reconciled_at = clock_timestamp()
    WHERE intent_id = current_row.intent_id RETURNING * INTO current_row;
  ELSIF result <> 'pending' THEN
    RAISE EXCEPTION 'release runner reconciliation result invalid';
  END IF;
  RETURN release_authority.release_runner_effect_snapshot(current_row);
END $body$;

CREATE FUNCTION release_authority.release_runner_abandon_prepared(
  p_intent_id text, p_owner text, p_expected_epoch bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE current_row release_authority.runner_intent%ROWTYPE;
BEGIN
  UPDATE release_authority.runner_intent SET effect_state = 'abandoned',
    effect_safe_for_compensation = true, effect_lease_expires_at = NULL
  WHERE intent_id = p_intent_id AND effect_state = 'prepared'
    AND effect_owner = p_owner AND effect_epoch = p_expected_epoch
  RETURNING * INTO current_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'release runner prepared abandon conflict'; END IF;
  RETURN release_authority.release_runner_effect_snapshot(current_row);
END $body$;

CREATE FUNCTION release_authority.release_runner_terminal_effect() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF OLD.terminal_at IS NULL AND NEW.terminal_at IS NOT NULL THEN
    UPDATE release_authority.runner_intent SET effect_state = 'cleaned',
      effect_safe_for_compensation = true, effect_block_reason = NULL,
      reconciled_at = clock_timestamp()
    WHERE intent_id = NEW.provisioning_intent_id AND effect_state = 'bound';
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER release_runner_terminal_effect_trigger
AFTER UPDATE OF terminal_at ON release_authority.runner_job
FOR EACH ROW EXECUTE FUNCTION release_authority.release_runner_terminal_effect();

CREATE FUNCTION release_authority.release_runner_compensation_gate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF OLD.state = 'pre_activation' AND NEW.state = 'compensating' AND
    (NOT EXISTS (
       SELECT 1 FROM release_authority.runner_intent
       WHERE rollout_id = NEW.rollout_id
     ) OR EXISTS (
       SELECT 1 FROM release_authority.runner_intent
       WHERE rollout_id = NEW.rollout_id AND
         (effect_state NOT IN ('cleaned','abandoned') OR
          NOT effect_safe_for_compensation)
     ))
  THEN RAISE EXCEPTION 'release runner effects unsafe for compensation'; END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER release_runner_compensation_gate_trigger
BEFORE UPDATE OF state ON release_authority.rollout
FOR EACH ROW EXECUTE FUNCTION release_authority.release_runner_compensation_gate();

REVOKE ALL ON FUNCTION release_authority.release_runner_prepare_effect(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_acquire_dispatch_permit(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_reconcile_effect(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_abandon_prepared(text,text,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_compensation_gate() FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_persist_intent(jsonb) FROM reviewrouter_release_control;
REVOKE ALL ON FUNCTION release_authority.release_runner_claim_provider_creation(jsonb) FROM reviewrouter_release_control;
REVOKE ALL ON FUNCTION release_authority.release_runner_record_intent_outcome(jsonb) FROM reviewrouter_release_control;
GRANT EXECUTE ON FUNCTION release_authority.release_runner_prepare_effect(jsonb) TO reviewrouter_release_control;
GRANT EXECUTE ON FUNCTION release_authority.release_runner_acquire_dispatch_permit(jsonb) TO reviewrouter_release_control;
GRANT EXECUTE ON FUNCTION release_authority.release_runner_reconcile_effect(jsonb) TO reviewrouter_release_control;
GRANT EXECUTE ON FUNCTION release_authority.release_runner_abandon_prepared(text,text,bigint) TO reviewrouter_release_control;
