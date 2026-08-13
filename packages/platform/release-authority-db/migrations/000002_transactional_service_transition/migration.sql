BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE release_authority.service_transition (
  rollout_id text PRIMARY KEY REFERENCES release_authority.rollout(rollout_id) ON DELETE RESTRICT,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  target_contract_sha256 text NOT NULL CHECK (target_contract_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  service_ids text[] NOT NULL CHECK (cardinality(service_ids) = 3),
  outcome text CHECK (outcome IN ('target_staged','source_recovered')),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz(3),
  CHECK ((outcome IS NULL) = (completed_at IS NULL))
);

CREATE TABLE release_authority.service_transition_checkpoint (
  rollout_id text NOT NULL REFERENCES release_authority.service_transition(rollout_id) ON DELETE RESTRICT,
  sequence bigint NOT NULL CHECK (sequence > 0),
  service_id text NOT NULL,
  step text NOT NULL CHECK (step IN (
    'recovery_intent','suspend_intent','suspended',
    'target_config_intent','target_configured','target_env_intent','target_env_applied',
    'target_deploy_intent','target_deployed','target_verified',
    'restore_config_intent','source_config_restored','restore_env_intent','source_env_restored',
    'restore_deploy_intent','source_deployed','source_verified','source_acl_restored','source_resumed'
  )),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  target_contract_sha256 text NOT NULL CHECK (target_contract_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  deploy_id text,
  observed_contract_sha256 text CHECK (observed_contract_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  observed_env_sha256 text CHECK (observed_env_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (rollout_id, sequence)
);
CREATE UNIQUE INDEX service_transition_checkpoint_step_key
  ON release_authority.service_transition_checkpoint(rollout_id,service_id,step);

CREATE FUNCTION release_authority.release_service_transition_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  RAISE EXCEPTION 'release service transition evidence is immutable';
END $body$;

CREATE TRIGGER release_service_transition_checkpoint_immutable_guard
BEFORE UPDATE OR DELETE ON release_authority.service_transition_checkpoint
FOR EACH ROW EXECUTE FUNCTION release_authority.release_service_transition_immutable();

CREATE FUNCTION release_authority.release_service_transition_begin(p_input jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE current_row release_authority.service_transition%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_input->'serviceIds') <> 'array'
    OR jsonb_array_length(p_input->'serviceIds') <> 3
    OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(p_input->'serviceIds')) <> 3
    OR coalesce(p_input->>'manifestSha256','') !~ '^sha256:[a-f0-9]{64}$'
    OR coalesce(p_input->>'targetContractSha256','') !~ '^sha256:[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'release service transition intent invalid'; END IF;
  INSERT INTO release_authority.service_transition(
    rollout_id,manifest_sha256,target_contract_sha256,service_ids)
  VALUES (p_input->>'rolloutId',p_input->>'manifestSha256',p_input->>'targetContractSha256',
    ARRAY(SELECT value FROM jsonb_array_elements_text(p_input->'serviceIds')))
  ON CONFLICT (rollout_id) DO NOTHING;
  IF FOUND THEN RETURN 'created'; END IF;
  SELECT * INTO STRICT current_row FROM release_authority.service_transition
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  IF current_row.manifest_sha256 <> p_input->>'manifestSha256'
    OR current_row.target_contract_sha256 <> p_input->>'targetContractSha256'
    OR current_row.service_ids <> ARRAY(SELECT value FROM jsonb_array_elements_text(p_input->'serviceIds'))
  THEN RAISE EXCEPTION 'release service transition intent conflict'; END IF;
  RETURN 'existing';
END $body$;

CREATE FUNCTION release_authority.release_service_transition_append(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE transition release_authority.service_transition%ROWTYPE;
DECLARE next_sequence bigint;
DECLARE existing release_authority.service_transition_checkpoint%ROWTYPE;
DECLARE predecessor text;
BEGIN
  SELECT * INTO STRICT transition FROM release_authority.service_transition
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
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
    deploy_id,observed_contract_sha256,observed_env_sha256)
  VALUES (transition.rollout_id,next_sequence,p_input->>'serviceId',p_input->>'step',
    transition.manifest_sha256,transition.target_contract_sha256,p_input->>'deployId',
    p_input->>'observedContractSha256',p_input->>'observedEnvSha256');
  RETURN p_input || jsonb_build_object('sequence',next_sequence);
END $body$;

CREATE FUNCTION release_authority.release_service_transition_read(p_rollout_id text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog AS $body$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'rolloutId',rollout_id,'manifestSha256',manifest_sha256,
    'targetContractSha256',target_contract_sha256,'serviceId',service_id,
    'sequence',sequence,'step',step,'deployId',deploy_id,
    'observedContractSha256',observed_contract_sha256,'observedEnvSha256',observed_env_sha256)
    ORDER BY sequence),'[]'::jsonb)
  FROM release_authority.service_transition_checkpoint WHERE rollout_id=p_rollout_id
$body$;

CREATE FUNCTION release_authority.release_service_transition_complete(p_input jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE updated bigint;
DECLARE transition release_authority.service_transition%ROWTYPE;
BEGIN
  IF p_input->>'outcome' NOT IN ('target_staged','source_recovered')
  THEN RAISE EXCEPTION 'release service transition outcome invalid'; END IF;
  SELECT * INTO STRICT transition FROM release_authority.service_transition
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  IF p_input->>'outcome'='target_staged' AND EXISTS (
    SELECT 1 FROM unnest(transition.service_ids) service_id
    WHERE NOT EXISTS (SELECT 1 FROM release_authority.service_transition_checkpoint checkpoint
      WHERE checkpoint.rollout_id=transition.rollout_id
        AND checkpoint.service_id=service_id AND checkpoint.step='target_verified'))
  THEN RAISE EXCEPTION 'release target service transition incomplete'; END IF;
  IF p_input->>'outcome'='source_recovered' AND (
    NOT EXISTS (SELECT 1 FROM release_authority.service_transition_checkpoint
      WHERE rollout_id=transition.rollout_id AND step='source_acl_restored')
    OR EXISTS (SELECT 1 FROM unnest(transition.service_ids) service_id
      WHERE NOT EXISTS (SELECT 1 FROM release_authority.service_transition_checkpoint checkpoint
        WHERE checkpoint.rollout_id=transition.rollout_id
          AND checkpoint.service_id=service_id AND checkpoint.step='source_verified')
      OR NOT EXISTS (SELECT 1 FROM release_authority.service_transition_checkpoint checkpoint
        WHERE checkpoint.rollout_id=transition.rollout_id
          AND checkpoint.service_id=service_id AND checkpoint.step='source_resumed')))
  THEN RAISE EXCEPTION 'release source service recovery incomplete'; END IF;
  UPDATE release_authority.service_transition SET outcome=p_input->>'outcome',completed_at=clock_timestamp()
    WHERE rollout_id=p_input->>'rolloutId'
      AND (outcome IS NULL OR (outcome='target_staged' AND p_input->>'outcome'='source_recovered'));
  GET DIAGNOSTICS updated=ROW_COUNT;
  IF updated=1 THEN RETURN true; END IF;
  RETURN EXISTS(SELECT 1 FROM release_authority.service_transition
    WHERE rollout_id=p_input->>'rolloutId' AND outcome=p_input->>'outcome');
END $body$;

CREATE FUNCTION release_authority.release_service_transition_activation_gate(
  p_rollout_id text, p_deploy_ids jsonb
) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog AS $body$
  SELECT EXISTS (
    SELECT 1 FROM release_authority.service_transition transition
    WHERE transition.rollout_id=p_rollout_id AND transition.outcome='target_staged'
      AND EXISTS (SELECT 1 FROM release_authority.receipt receipt
        WHERE receipt.rollout_id=transition.rollout_id AND receipt.step='stage_target_services'
          AND receipt.provider_binding->>'serviceRecoveryManifestSha256'=transition.manifest_sha256
          AND receipt.provider_binding->>'targetServiceContractSha256'=transition.target_contract_sha256)
      AND (SELECT jsonb_agg(checkpoint.deploy_id ORDER BY array_position(transition.service_ids,checkpoint.service_id))
        FROM release_authority.service_transition_checkpoint checkpoint
        WHERE checkpoint.rollout_id=transition.rollout_id AND checkpoint.step='target_verified')=p_deploy_ids
      AND (SELECT count(*) FROM release_authority.service_transition_checkpoint checkpoint
        WHERE checkpoint.rollout_id=transition.rollout_id AND checkpoint.step='target_verified')=3)
$body$;

REVOKE ALL ON TABLE release_authority.service_transition FROM PUBLIC;
REVOKE ALL ON TABLE release_authority.service_transition_checkpoint FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_service_transition_begin(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_service_transition_append(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_service_transition_read(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_service_transition_complete(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_service_transition_activation_gate(text,jsonb) FROM PUBLIC;

DO $acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='reviewrouter_release_control') THEN
    GRANT EXECUTE ON FUNCTION release_authority.release_service_transition_begin(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_service_transition_append(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_service_transition_read(text) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_service_transition_complete(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_service_transition_activation_gate(text,jsonb) TO reviewrouter_release_control;
  END IF;
END $acl$;

COMMIT;
