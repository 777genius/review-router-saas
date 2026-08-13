-- Revalidate durable runner-effect safety at every compensation boundary.  A
-- provider identity discovered after begin_compensation is evidence, not a
-- reason to trust the snapshot which authorized that transition.
BEGIN;

CREATE FUNCTION release_authority.release_compensation_effects_are_safe(p_rollout_id text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog AS $body$
  SELECT NOT EXISTS (
    SELECT 1 FROM release_authority.runner_intent intent
    WHERE intent.rollout_id = p_rollout_id
      AND (intent.effect_state NOT IN ('cleaned','abandoned')
        OR NOT intent.effect_safe_for_compensation
        OR intent.effect_block_reason = 'duplicate'
        OR EXISTS (
          SELECT 1 FROM release_authority.runner_job job
          WHERE job.provisioning_intent_id = intent.intent_id
          GROUP BY job.provisioning_intent_id HAVING count(*) > 1
        ))
  )
$body$;
REVOKE ALL ON FUNCTION release_authority.release_compensation_effects_are_safe(text) FROM PUBLIC;

CREATE FUNCTION release_authority.release_compensation_receipt_effect_gate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF NEW.step IN ('effect_compensation','complete_compensation')
    AND NOT release_authority.release_compensation_effects_are_safe(NEW.rollout_id)
  THEN RAISE EXCEPTION 'release runner effects changed during compensation'; END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION release_authority.release_compensation_receipt_effect_gate() FROM PUBLIC;
CREATE TRIGGER release_compensation_receipt_effect_gate_trigger
BEFORE INSERT ON release_authority.receipt
FOR EACH ROW EXECUTE FUNCTION release_authority.release_compensation_receipt_effect_gate();

CREATE FUNCTION release_authority.release_compensation_source_recovery_gate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE rollout_row release_authority.rollout%ROWTYPE;
BEGIN
  IF NEW.step IN ('restore_config_intent','source_config_restored','restore_env_intent',
      'source_env_restored','restore_deploy_intent','source_deployed','source_verified',
      'source_acl_restored','source_resumed') THEN
    -- Serialize with late job persistence.  That writer uses rollout -> intent
    -- -> job, so this boundary takes the same parent lock before reading intent
    -- or job evidence.
    SELECT * INTO STRICT rollout_row FROM release_authority.rollout
      WHERE rollout_id = NEW.rollout_id FOR UPDATE;
    IF rollout_row.state <> 'compensating'
      OR rollout_row.activation_boundary <> 'before'
      OR NOT release_authority.release_compensation_effects_are_safe(NEW.rollout_id)
    THEN RAISE EXCEPTION 'release source recovery runner effects unsafe'; END IF;
  END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION release_authority.release_compensation_source_recovery_gate() FROM PUBLIC;
CREATE TRIGGER release_compensation_source_recovery_gate_trigger
BEFORE INSERT ON release_authority.service_transition_checkpoint
FOR EACH ROW EXECUTE FUNCTION release_authority.release_compensation_source_recovery_gate();

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
        )))
  THEN RAISE EXCEPTION 'release runner duplicate effects unsafe for activation'; END IF;
  IF NEW.state IN ('compensating','compensated')
    AND (NOT EXISTS (SELECT 1 FROM release_authority.source_freeze_observation
         WHERE rollout_id=NEW.rollout_id AND phase='suspended')
      OR EXISTS (SELECT 1 FROM release_authority.source_freeze_observation intent
        WHERE intent.rollout_id=NEW.rollout_id AND intent.phase='intent' AND NOT EXISTS
          (SELECT 1 FROM release_authority.source_freeze_observation completed
           WHERE completed.rollout_id=intent.rollout_id
             AND completed.service_id=intent.service_id AND completed.phase='suspended'))
      OR NOT release_authority.release_compensation_effects_are_safe(NEW.rollout_id))
  THEN RAISE EXCEPTION 'release runner effects unsafe for compensation'; END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION release_authority.release_runner_compensation_gate() FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_authority.release_provider_authority_decide(p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $decision$
DECLARE current_row release_authority.rollout%ROWTYPE;
DECLARE existing release_authority.provider_authority_decision%ROWTYPE;
DECLARE required_state release_authority.aggregate_state;
DECLARE required_boundary text;
BEGIN
  IF jsonb_typeof(p_request) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_request)) <> 6
    OR coalesce(p_request->>'rolloutId','') = ''
    OR coalesce(p_request->>'sourceSystemIdentifier','') = ''
    OR coalesce(p_request->>'targetSystemIdentifier','') = ''
    OR coalesce(p_request->>'expectedReceiptSha256','') !~ '^sha256:[a-f0-9]{64}$'
    OR p_request->>'operation' NOT IN ('deploy_target','resume_target','resume_source')
    OR p_request->>'activationBoundary' NOT IN ('before','activated')
  THEN RAISE EXCEPTION 'provider authority request invalid'; END IF;
  SELECT * INTO current_row FROM release_authority.rollout
    WHERE rollout_id = p_request->>'rolloutId' FOR UPDATE;
  IF NOT FOUND
    OR current_row.source_system_identifier <> p_request->>'sourceSystemIdentifier'
    OR current_row.target_system_identifier <> p_request->>'targetSystemIdentifier'
  THEN RAISE EXCEPTION 'provider authority binding denied'; END IF;
  SELECT * INTO existing FROM release_authority.provider_authority_decision
    WHERE rollout_id = current_row.rollout_id AND operation = p_request->>'operation';
  IF current_row.last_receipt_sha256 <> p_request->>'expectedReceiptSha256'
  THEN RAISE EXCEPTION 'provider authority receipt denied'; END IF;
  required_state := CASE p_request->>'operation'
    WHEN 'deploy_target' THEN 'pre_activation'::release_authority.aggregate_state
    WHEN 'resume_target' THEN 'activated'::release_authority.aggregate_state
    WHEN 'resume_source' THEN 'compensating'::release_authority.aggregate_state
  END;
  required_boundary := CASE p_request->>'operation'
    WHEN 'resume_target' THEN 'activated' ELSE 'before' END;
  IF current_row.state <> required_state
    OR current_row.activation_boundary <> required_boundary
    OR p_request->>'activationBoundary' <> required_boundary
    OR (p_request->>'operation' = 'resume_source'
      AND current_row.authoritative_system_identifier <> current_row.source_system_identifier)
  THEN RAISE EXCEPTION 'provider authority state denied'; END IF;
  IF p_request->>'operation' = 'resume_source'
    AND NOT release_authority.release_compensation_effects_are_safe(current_row.rollout_id)
  THEN RAISE EXCEPTION 'provider authority runner effects changed during compensation'; END IF;
  IF existing.decision_id IS NOT NULL THEN
    IF existing.source_system_identifier <> p_request->>'sourceSystemIdentifier'
      OR existing.target_system_identifier <> p_request->>'targetSystemIdentifier'
      OR existing.expected_receipt_sha256 <> p_request->>'expectedReceiptSha256'
      OR existing.activation_boundary <> p_request->>'activationBoundary'
    THEN RAISE EXCEPTION 'provider authority replay conflict'; END IF;
    RETURN p_request || jsonb_build_object('decision','allow',
      'decisionId',existing.decision_id,'decidedAt',existing.decided_at);
  END IF;
  INSERT INTO release_authority.provider_authority_decision
    (rollout_id,operation,source_system_identifier,target_system_identifier,
     expected_receipt_sha256,activation_boundary)
  VALUES (current_row.rollout_id,p_request->>'operation',
    current_row.source_system_identifier,current_row.target_system_identifier,
    current_row.last_receipt_sha256,required_boundary)
  RETURNING * INTO existing;
  RETURN p_request || jsonb_build_object('decision','allow',
    'decisionId',existing.decision_id,'decidedAt',existing.decided_at);
END $decision$;
REVOKE ALL ON FUNCTION release_authority.release_provider_authority_decide(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_authority.release_service_transition_append(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE rollout_row release_authority.rollout%ROWTYPE;
DECLARE transition release_authority.service_transition%ROWTYPE;
DECLARE next_sequence bigint;
DECLARE existing release_authority.service_transition_checkpoint%ROWTYPE;
DECLARE predecessor text;
BEGIN
  -- Source recovery, transition completion, and late identity persistence all
  -- start with the rollout parent.  The checkpoint trigger may safely retake
  -- this lock before it inspects intents and jobs.
  SELECT * INTO STRICT rollout_row FROM release_authority.rollout
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  SELECT * INTO STRICT transition FROM release_authority.service_transition
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  IF p_input->>'step' IN ('restore_config_intent','source_config_restored','restore_env_intent',
      'source_env_restored','restore_deploy_intent','source_deployed','source_verified',
      'source_acl_restored','source_resumed')
    AND (rollout_row.state <> 'compensating'
      OR rollout_row.activation_boundary <> 'before'
      OR NOT release_authority.release_compensation_effects_are_safe(rollout_row.rollout_id))
  THEN RAISE EXCEPTION 'release source recovery runner effects unsafe'; END IF;
  IF transition.outcome = 'source_recovered'
    OR transition.manifest_sha256 <> p_input->>'manifestSha256'
    OR transition.target_contract_sha256 <> p_input->>'targetContractSha256'
    OR NOT (p_input->>'serviceId'=ANY(transition.service_ids))
  THEN RAISE EXCEPTION 'release service transition checkpoint conflict'; END IF;
  SELECT * INTO existing FROM release_authority.service_transition_checkpoint
    WHERE rollout_id=transition.rollout_id AND service_id=p_input->>'serviceId'
      AND step=p_input->>'step';
  IF FOUND THEN
    IF existing.deploy_id IS NOT DISTINCT FROM p_input->>'deployId'
      AND existing.observed_contract_sha256 IS NOT DISTINCT FROM p_input->>'observedContractSha256'
      AND existing.observed_env_sha256 IS NOT DISTINCT FROM p_input->>'observedEnvSha256'
      AND existing.intent_at IS NOT DISTINCT FROM (p_input->>'intentAt')::timestamptz
    THEN RETURN p_input || jsonb_build_object('sequence',existing.sequence); END IF;
    RAISE EXCEPTION 'release service transition checkpoint replay conflict';
  END IF;
  predecessor := CASE p_input->>'step'
    WHEN 'suspend_intent' THEN 'recovery_intent'
    WHEN 'suspended' THEN 'suspend_intent'
    WHEN 'target_config_intent' THEN 'suspended'
    WHEN 'target_configured' THEN 'target_config_intent'
    WHEN 'target_env_intent' THEN 'target_configured'
    WHEN 'target_env_applied' THEN 'target_env_intent'
    WHEN 'target_deploy_intent' THEN 'target_env_applied'
    WHEN 'target_deployed' THEN 'target_deploy_intent'
    WHEN 'target_verified' THEN 'target_deployed'
    WHEN 'source_config_restored' THEN 'restore_config_intent'
    WHEN 'restore_env_intent' THEN 'source_config_restored'
    WHEN 'source_env_restored' THEN 'restore_env_intent'
    WHEN 'restore_deploy_intent' THEN 'source_env_restored'
    WHEN 'source_deployed' THEN 'restore_deploy_intent'
    WHEN 'source_verified' THEN 'source_deployed'
    WHEN 'source_resumed' THEN 'source_verified'
    ELSE NULL END;
  IF predecessor IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM release_authority.service_transition_checkpoint
    WHERE rollout_id=transition.rollout_id
      AND (service_id=p_input->>'serviceId' OR predecessor='recovery_intent')
      AND step=predecessor)
  THEN RAISE EXCEPTION 'release service transition checkpoint out of order'; END IF;
  IF p_input->>'step' IN ('target_deployed','source_deployed','target_verified','source_verified')
    AND coalesce(p_input->>'deployId','')=''
  THEN RAISE EXCEPTION 'release service transition deploy identity missing'; END IF;
  IF p_input->>'step' IN ('target_verified','source_verified') AND
    (coalesce(p_input->>'observedContractSha256','') !~ '^sha256:[a-f0-9]{64}$'
      OR coalesce(p_input->>'observedEnvSha256','') !~ '^sha256:[a-f0-9]{64}$')
  THEN RAISE EXCEPTION 'release service transition verification hashes missing'; END IF;
  IF p_input->>'step'='source_acl_restored' AND EXISTS (
    SELECT 1 FROM unnest(transition.service_ids) service_id WHERE NOT EXISTS (
      SELECT 1 FROM release_authority.service_transition_checkpoint checkpoint
      WHERE checkpoint.rollout_id=transition.rollout_id
        AND checkpoint.service_id=service_id AND checkpoint.step='source_verified'))
  THEN RAISE EXCEPTION 'release service transition source verification incomplete'; END IF;
  IF p_input->>'step'='source_resumed' AND NOT EXISTS (
    SELECT 1 FROM release_authority.service_transition_checkpoint checkpoint
    WHERE checkpoint.rollout_id=transition.rollout_id AND checkpoint.step='source_acl_restored')
  THEN RAISE EXCEPTION 'release service transition source acl not restored'; END IF;
  SELECT coalesce(max(sequence),0)+1 INTO next_sequence
    FROM release_authority.service_transition_checkpoint
    WHERE rollout_id=transition.rollout_id;
  INSERT INTO release_authority.service_transition_checkpoint(
    rollout_id,sequence,service_id,step,manifest_sha256,target_contract_sha256,
    deploy_id,observed_contract_sha256,observed_env_sha256,intent_at)
  VALUES (transition.rollout_id,next_sequence,p_input->>'serviceId',p_input->>'step',
    transition.manifest_sha256,transition.target_contract_sha256,p_input->>'deployId',
    p_input->>'observedContractSha256',p_input->>'observedEnvSha256',
    (p_input->>'intentAt')::timestamptz);
  RETURN p_input || jsonb_build_object('sequence',next_sequence);
END $body$;
REVOKE ALL ON FUNCTION release_authority.release_service_transition_append(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_authority.release_service_transition_complete(p_input jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE updated bigint;
DECLARE rollout_row release_authority.rollout%ROWTYPE;
DECLARE transition release_authority.service_transition%ROWTYPE;
DECLARE declared_service_ids jsonb;
BEGIN
  IF p_input->>'outcome' NOT IN ('target_staged','source_recovered')
  THEN RAISE EXCEPTION 'release service transition outcome invalid'; END IF;
  SELECT * INTO STRICT rollout_row FROM release_authority.rollout
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  SELECT * INTO STRICT transition FROM release_authority.service_transition
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  IF p_input->>'outcome'='target_staged' AND EXISTS (
    SELECT 1 FROM unnest(transition.service_ids) service_id
    WHERE NOT EXISTS (SELECT 1 FROM release_authority.service_transition_checkpoint checkpoint
      WHERE checkpoint.rollout_id=transition.rollout_id
        AND checkpoint.service_id=service_id AND checkpoint.step='target_verified'))
  THEN RAISE EXCEPTION 'release target service transition incomplete'; END IF;
  IF p_input->>'outcome'='source_recovered' THEN
    IF rollout_row.state <> 'compensating' OR rollout_row.activation_boundary <> 'before'
      OR NOT release_authority.release_compensation_effects_are_safe(rollout_row.rollout_id)
    THEN RAISE EXCEPTION 'release source recovery runner effects unsafe'; END IF;
    SELECT freeze_observation.declared_service_ids INTO declared_service_ids
      FROM release_authority.source_freeze_observation freeze_observation
      WHERE freeze_observation.rollout_id=transition.rollout_id
      ORDER BY freeze_observation.observation_id LIMIT 1;
    IF declared_service_ids IS NULL
      OR (SELECT array_agg(value ORDER BY value) FROM jsonb_array_elements_text(declared_service_ids))
        <> (SELECT array_agg(value ORDER BY value) FROM unnest(transition.service_ids) value)
    THEN RAISE EXCEPTION 'release source recovery manifest mismatch'; END IF;
    IF NOT EXISTS (SELECT 1 FROM release_authority.service_transition_checkpoint
        WHERE rollout_id=transition.rollout_id AND step='source_acl_restored')
      OR EXISTS (SELECT 1 FROM unnest(transition.service_ids) service_id
        WHERE NOT EXISTS (SELECT 1 FROM release_authority.service_transition_checkpoint checkpoint
          WHERE checkpoint.rollout_id=transition.rollout_id
            AND checkpoint.service_id=service_id AND checkpoint.step='source_verified'))
      OR EXISTS (SELECT 1 FROM release_authority.source_freeze_observation freeze_observation
        WHERE freeze_observation.rollout_id=transition.rollout_id AND freeze_observation.phase='suspended'
          AND NOT EXISTS (SELECT 1 FROM release_authority.service_transition_checkpoint checkpoint
            WHERE checkpoint.rollout_id=transition.rollout_id
              AND checkpoint.service_id=freeze_observation.service_id AND checkpoint.step='source_resumed'))
      OR EXISTS (SELECT 1 FROM release_authority.service_transition_checkpoint checkpoint
        WHERE checkpoint.rollout_id=transition.rollout_id AND checkpoint.step='source_resumed'
          AND NOT EXISTS (SELECT 1 FROM release_authority.source_freeze_observation freeze_observation
            WHERE freeze_observation.rollout_id=transition.rollout_id
              AND freeze_observation.service_id=checkpoint.service_id AND freeze_observation.phase='suspended'))
    THEN RAISE EXCEPTION 'release source service recovery incomplete'; END IF;
  END IF;
  UPDATE release_authority.service_transition
    SET outcome=p_input->>'outcome',completed_at=clock_timestamp()
    WHERE rollout_id=p_input->>'rolloutId'
      AND (outcome IS NULL OR (outcome='target_staged' AND p_input->>'outcome'='source_recovered'));
  GET DIAGNOSTICS updated=ROW_COUNT;
  IF updated=1 THEN RETURN true; END IF;
  RETURN EXISTS(SELECT 1 FROM release_authority.service_transition
    WHERE rollout_id=p_input->>'rolloutId' AND outcome=p_input->>'outcome');
END $body$;
REVOKE ALL ON FUNCTION release_authority.release_service_transition_complete(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_authority.release_rollout_reconcile(
  p_rollout_id text,p_target_observation jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE current_row release_authority.rollout%ROWTYPE;
DECLARE open_jobs bigint; compensated boolean; finalized boolean;
BEGIN
  SELECT * INTO STRICT current_row FROM release_authority.rollout
    WHERE rollout_id=p_rollout_id FOR UPDATE;
  SELECT count(*) INTO open_jobs FROM release_authority.runner_job
    WHERE rollout_id=p_rollout_id AND terminal_at IS NULL;
  IF open_jobs<>0 THEN RAISE EXCEPTION 'release rollout reconciliation open jobs'; END IF;
  IF current_row.activation_boundary='before' THEN
    IF current_row.state='compensating'
      OR NOT release_authority.release_compensation_effects_are_safe(p_rollout_id) THEN
      RETURN jsonb_build_object('state','pre_activation_recovery_required',
        'sourceEligible',false,'sourceAclRestored',false,
        'sourceServicesResumed',false,'openRunnerJobs',0);
    END IF;
    SELECT EXISTS (SELECT 1 FROM release_authority.receipt
      WHERE rollout_id=p_rollout_id AND step='complete_compensation') INTO compensated;
    IF NOT compensated THEN RAISE EXCEPTION 'release rollout compensation receipt missing'; END IF;
    RETURN jsonb_build_object('state','pre_activation_compensated','sourceEligible',true,
      'sourceAclRestored',true,'sourceServicesResumed',true,'openRunnerJobs',0);
  END IF;
  IF current_row.activation_boundary='uncertain'
    AND p_target_observation->>'kind'='matching_activation_receipt' THEN
    IF p_target_observation->>'nextReceiptSha256' IS DISTINCT FROM
         p_target_observation->'activationReceipt'->>'receiptSha256'
      OR p_target_observation->'activationReceipt'->>'rolloutId' IS DISTINCT FROM
         p_target_observation->'authorization'->>'rolloutId'
      OR p_target_observation->'activationReceipt'->>'expectedCommitSha' IS DISTINCT FROM
         p_target_observation->'authorization'->>'expectedCommitSha'
      OR p_target_observation->'activationReceipt'->>'sourceSystemIdentifier' IS DISTINCT FROM
         p_target_observation->'authorization'->>'sourceSystemIdentifier'
      OR p_target_observation->'activationReceipt'->>'targetSystemIdentifier' IS DISTINCT FROM
         p_target_observation->'authorization'->>'targetSystemIdentifier'
    THEN RAISE EXCEPTION 'release rollout reconciliation receipt identity conflict'; END IF;
    SELECT release_authority.release_rollout_finalize_activation(
      p_target_observation->'authorization',p_target_observation->'activationReceipt'->'provider',
      p_target_observation->>'nextReceiptSha256',p_target_observation->'activationReceipt')
      INTO finalized;
    IF NOT finalized THEN RAISE EXCEPTION 'release rollout reconciliation activation conflict'; END IF;
    RETURN jsonb_build_object('state','activated','sourceEligible',false,
      'sourceAclRestored',false,'sourceServicesResumed',false,'openRunnerJobs',0);
  END IF;
  IF current_row.activation_boundary='uncertain' THEN
    UPDATE release_authority.rollout SET state='forward_repair_required',updated_at=clock_timestamp()
      WHERE rollout_id=p_rollout_id AND state IN ('activation_authorized','outcome_unknown');
  END IF;
  RETURN jsonb_build_object('state',CASE WHEN current_row.activation_boundary='activated'
      THEN 'activated' ELSE 'forward_repair_required' END,
    'reason',CASE WHEN current_row.activation_boundary='activated' THEN NULL
      ELSE p_target_observation->>'kind' END,
    'sourceEligible',false,'sourceAclRestored',false,
    'sourceServicesResumed',false,'openRunnerJobs',0);
END $body$;
REVOKE ALL ON FUNCTION release_authority.release_rollout_reconcile(text,jsonb) FROM PUBLIC;

DO $acl$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='reviewrouter_release_control') THEN
    GRANT EXECUTE ON FUNCTION release_authority.release_service_transition_complete(jsonb)
      TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_service_transition_append(jsonb)
      TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_rollout_reconcile(text,jsonb)
      TO reviewrouter_release_control;
  END IF;
END $acl$;

COMMIT;
