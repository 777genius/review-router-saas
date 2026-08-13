-- Retain runner identities that become visible after a rollout transition won
-- the parent lock, while preventing already-known duplicates from authorizing
-- activation.
BEGIN;

CREATE OR REPLACE FUNCTION release_authority.release_runner_persist_job(p_job jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE intent release_authority.runner_intent%ROWTYPE;
DECLARE rollout release_authority.rollout%ROWTYPE;
DECLARE existing release_authority.runner_job%ROWTYPE;
DECLARE duplicate_job boolean;
BEGIN
  -- All effect writers use rollout -> intent -> job ordering.  The rollout may
  -- have left pre-activation while this discovery waited, but the provider
  -- identity is still evidence: retain it and make the parent intent unsafe
  -- without changing the rollout transition that already committed.
  SELECT * INTO STRICT rollout FROM release_authority.rollout
    WHERE rollout_id = p_job->>'rolloutId' FOR UPDATE;
  SELECT * INTO STRICT intent FROM release_authority.runner_intent
    WHERE intent_id = p_job->>'provisioningIntentId' FOR UPDATE;
  IF intent.rollout_id <> rollout.rollout_id
    OR intent.service_id <> p_job->>'serviceId'
    OR intent.lifecycle <> p_job->>'lifecycle'
    OR coalesce(p_job->>'jobId','') = ''
    OR (p_job->>'observedAt') IS NULL
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
      OR existing.observed_at <> (p_job->>'observedAt')::timestamptz(3)
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
     cleanup_canary, lifecycle)
  VALUES (p_job->>'jobId', intent.rollout_id, intent.intent_id,
    intent.service_id, (p_job->>'observedAt')::timestamptz,
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
REVOKE ALL ON FUNCTION release_authority.release_runner_persist_job(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_authority.release_runner_reconcile_effect(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE current_row release_authority.runner_intent%ROWTYPE;
DECLARE rollout_row release_authority.rollout%ROWTYPE;
DECLARE intent_rollout_id text;
DECLARE result text := p_input->'reconciliation'->>'result';
DECLARE reason text := p_input->'reconciliation'->>'reason';
BEGIN
  IF result IS NULL OR result NOT IN ('pending','blocked')
    OR p_input->'reconciliation'->>'safeForCompensation' IS DISTINCT FROM 'false'
  THEN RAISE EXCEPTION 'release runner reconciliation safety invalid'; END IF;
  SELECT rollout_id INTO STRICT intent_rollout_id
    FROM release_authority.runner_intent WHERE intent_id = p_input->>'intentId';
  SELECT * INTO STRICT rollout_row FROM release_authority.rollout
    WHERE rollout_id = intent_rollout_id FOR UPDATE;
  SELECT * INTO STRICT current_row FROM release_authority.runner_intent
    WHERE intent_id = p_input->>'intentId' FOR UPDATE;

  -- A late durable identity already projected its permanent safety fence.
  -- Permit only the exact idempotent blocked acknowledgement after activation
  -- or compensation; no bind, clean, or state restoration is reopened.
  IF current_row.effect_state = 'blocked'
    AND current_row.effect_block_reason IN ('duplicate','unresolved_legacy') THEN
    IF (result = 'blocked' AND reason = current_row.effect_block_reason)
      OR (result = 'pending' AND current_row.effect_block_reason = 'duplicate') THEN
      RETURN release_authority.release_runner_effect_snapshot(current_row);
    END IF;
    RAISE EXCEPTION 'release runner reconciliation frozen';
  END IF;
  IF current_row.effect_state = 'abandoned' THEN
    RETURN release_authority.release_runner_effect_snapshot(current_row);
  END IF;
  IF rollout_row.state <> 'pre_activation'
    THEN RAISE EXCEPTION 'release runner reconciliation frozen'; END IF;
  IF current_row.effect_state = 'cleaned' AND result <> 'blocked'
    THEN RETURN release_authority.release_runner_effect_snapshot(current_row); END IF;
  IF current_row.effect_state NOT IN ('dispatching','bound','cleaned','blocked')
    OR current_row.effect_epoch <> (p_input->>'expectedEpoch')::bigint
  THEN RAISE EXCEPTION 'release runner reconciliation fence conflict'; END IF;
  IF current_row.effect_state = 'blocked'
    AND current_row.effect_block_reason IN ('unknown','timeout') THEN
    UPDATE release_authority.runner_intent SET
      effect_state = CASE WHEN provider_job_id IS NULL THEN 'dispatching' ELSE 'bound' END,
      effect_safe_for_compensation = false, effect_block_reason = NULL
    WHERE intent_id = current_row.intent_id RETURNING * INTO current_row;
  END IF;

  IF result = 'blocked' THEN
    IF reason IS NULL OR reason NOT IN ('unknown','duplicate','timeout','unresolved_legacy')
      THEN RAISE EXCEPTION 'release runner reconciliation reason invalid'; END IF;
    IF reason IN ('duplicate','unresolved_legacy') THEN
      UPDATE release_authority.runner_intent SET effect_state = 'blocked',
        effect_safe_for_compensation = false, effect_block_reason = reason,
        reconciliation_observation = coalesce(p_input->'observation',
          jsonb_build_object('reason',reason,'lateProviderJobId',p_input->>'jobId')),
        reconciled_at = clock_timestamp()
      WHERE intent_id = current_row.intent_id RETURNING * INTO current_row;
    ELSE
      UPDATE release_authority.runner_intent SET
        effect_state = CASE WHEN provider_job_id IS NULL THEN 'dispatching' ELSE 'bound' END,
        effect_safe_for_compensation = false, effect_block_reason = NULL,
        reconciliation_observation = coalesce(p_input->'observation',
          jsonb_build_object('reason',reason,'lateProviderJobId',p_input->>'jobId')),
        reconciled_at = clock_timestamp()
      WHERE intent_id = current_row.intent_id RETURNING * INTO current_row;
    END IF;
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
  ELSIF result = 'pending' THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'release runner reconciliation result invalid';
  END IF;
  RETURN release_authority.release_runner_effect_snapshot(current_row);
END $body$;
REVOKE ALL ON FUNCTION release_authority.release_runner_reconcile_effect(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_authority.release_runner_compensation_gate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF OLD.state = 'pre_activation' AND NEW.state = 'activation_authorized'
    AND EXISTS (
      SELECT 1 FROM release_authority.runner_intent intent
      WHERE intent.rollout_id = NEW.rollout_id
        AND (intent.effect_block_reason = 'duplicate' OR EXISTS (
          SELECT 1 FROM release_authority.runner_job job
          WHERE job.provisioning_intent_id = intent.intent_id
          GROUP BY job.provisioning_intent_id HAVING count(*) > 1
        ))
    )
  THEN RAISE EXCEPTION 'release runner duplicate effects unsafe for activation'; END IF;
  IF NEW.state = 'compensating' AND OLD.state = 'pre_activation' AND
    (NOT EXISTS (SELECT 1 FROM release_authority.source_freeze_observation
       WHERE rollout_id=NEW.rollout_id AND phase='suspended')
     OR EXISTS (SELECT 1 FROM release_authority.source_freeze_observation intent
       WHERE intent.rollout_id=NEW.rollout_id AND intent.phase='intent' AND NOT EXISTS
         (SELECT 1 FROM release_authority.source_freeze_observation completed
          WHERE completed.rollout_id=intent.rollout_id
            AND completed.service_id=intent.service_id AND completed.phase='suspended'))
     OR EXISTS (SELECT 1 FROM release_authority.runner_intent
       WHERE rollout_id=NEW.rollout_id
         AND (effect_state NOT IN ('cleaned','abandoned') OR NOT effect_safe_for_compensation))
    )
  THEN RAISE EXCEPTION 'release runner effects unsafe for compensation'; END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION release_authority.release_runner_compensation_gate() FROM PUBLIC;

DO $acl$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='reviewrouter_release_control') THEN
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_persist_job(jsonb)
      TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_reconcile_effect(jsonb)
      TO reviewrouter_release_control;
  END IF;
END $acl$;

COMMIT;
