-- Append-only repair for the published 000009/000010 history.
-- Hardens recovery-effect receipts, then adds resource-scoped provider mutation
-- fencing with idempotent consume and terminal replay.
BEGIN;

ALTER TABLE release_authority.provider_authority_decision
  DROP CONSTRAINT provider_authority_decision_operation_check;
ALTER TABLE release_authority.provider_authority_decision
  ADD CONSTRAINT provider_authority_decision_operation_check CHECK (
    operation IN ('freeze_source','deploy_target','resume_target','resume_source'));

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
    OR p_request->>'operation' NOT IN (
      'freeze_source','deploy_target','resume_target','resume_source')
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
    WHEN 'freeze_source' THEN 'pre_activation'::release_authority.aggregate_state
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

CREATE OR REPLACE FUNCTION release_authority.release_recovery_effect_observation_is_valid(
  p_kind text, p_observation jsonb
) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $body$
  SELECT CASE p_kind
    WHEN 'restore_service_config' THEN
      jsonb_typeof(p_observation)='object' AND jsonb_array_length(jsonb_path_query_array(p_observation,'$.keyvalue()'))=3
      AND p_observation ?& ARRAY['serviceId','serviceContractSha256','suspended']
      AND p_observation->>'serviceId' ~ '^srv-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      AND p_observation->>'serviceContractSha256' ~ '^sha256:[a-f0-9]{64}$'
      AND jsonb_typeof(p_observation->'suspended')='boolean'
    WHEN 'restore_service_environment' THEN
      jsonb_typeof(p_observation)='object' AND jsonb_array_length(jsonb_path_query_array(p_observation,'$.keyvalue()'))=2
      AND p_observation ?& ARRAY['serviceId','environmentSha256']
      AND p_observation->>'serviceId' ~ '^srv-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      AND p_observation->>'environmentSha256' ~ '^sha256:[a-f0-9]{64}$'
    WHEN 'restore_service_deploy' THEN
      jsonb_typeof(p_observation)='object' AND jsonb_array_length(jsonb_path_query_array(p_observation,'$.keyvalue()'))=2
      AND p_observation ?& ARRAY['serviceId','deployId']
      AND p_observation->>'serviceId' ~ '^srv-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      AND p_observation->>'deployId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$'
    WHEN 'restore_database_writes' THEN
      jsonb_typeof(p_observation)='object' AND (
        (jsonb_array_length(jsonb_path_query_array(p_observation,'$.keyvalue()'))=2
          AND p_observation ?& ARRAY['sourceWritesRestored','observedAt'])
        OR (jsonb_array_length(jsonb_path_query_array(p_observation,'$.keyvalue()'))=4
          AND p_observation ?& ARRAY['systemIdentifier','aclSha256','observedAt','sourceWritesRestored']
          AND p_observation->>'systemIdentifier' ~ '^[0-9]{1,64}$'
          AND p_observation->>'aclSha256' ~ '^sha256:[a-f0-9]{64}$'))
      AND p_observation->'sourceWritesRestored'='true'::jsonb
      AND p_observation->>'observedAt' ~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$'
    WHEN 'resume_source_service' THEN
      jsonb_typeof(p_observation)='object' AND jsonb_array_length(jsonb_path_query_array(p_observation,'$.keyvalue()'))=4
      AND p_observation ?& ARRAY['serviceId','resumed','serviceContractSha256','environmentSha256']
      AND p_observation->>'serviceId' ~ '^srv-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      AND p_observation->'resumed'='true'::jsonb
      AND p_observation->>'serviceContractSha256' ~ '^sha256:[a-f0-9]{64}$'
      AND p_observation->>'environmentSha256' ~ '^sha256:[a-f0-9]{64}$'
    ELSE false END
$body$;

ALTER TABLE release_authority.recovery_effect
  ADD COLUMN execution_receipt_sha256 text;

-- A published database may contain an in-flight old-format effect. It cannot
-- be granted an execution capability retroactively; quarantine it forward-only.
UPDATE release_authority.rollout AS rollout
SET recovery_forward_only=true,updated_at=clock_timestamp()
WHERE EXISTS (
  SELECT 1 FROM release_authority.recovery_effect AS effect
  WHERE effect.rollout_id=rollout.rollout_id
    AND effect.state IN ('consumed','completed','forward_repair')
);
UPDATE release_authority.recovery_effect
SET state='forward_repair',
    execution_receipt_sha256=encode(sha256(convert_to(
      replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),'UTF8')),'hex')
WHERE state IN ('consumed','completed','forward_repair');

DO $constraints$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT conname FROM pg_catalog.pg_constraint
    WHERE conrelid='release_authority.recovery_effect'::regclass
      AND contype='c'
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE release_authority.recovery_effect DROP CONSTRAINT %I',
      item.conname);
  END LOOP;
END
$constraints$;

ALTER TABLE release_authority.recovery_effect
  ADD CONSTRAINT recovery_effect_effect_key_check
    CHECK (effect_key ~ '^[a-z][a-z0-9_]*(?::[A-Za-z0-9._-]+)?$'),
  ADD CONSTRAINT recovery_effect_kind_check
    CHECK (kind IN ('restore_service_config','restore_service_environment',
      'restore_service_deploy','restore_database_writes','resume_source_service')),
  ADD CONSTRAINT recovery_effect_state_check
    CHECK (state IN ('intended','claimed','consumed','executing','completed','forward_repair')),
  ADD CONSTRAINT recovery_effect_epoch_check CHECK (epoch >= 0),
  ADD CONSTRAINT recovery_effect_permit_token_check
    CHECK (permit_token ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT recovery_effect_execution_receipt_check
    CHECK (execution_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT recovery_effect_service_scope_check
    CHECK ((kind IN ('restore_database_writes')) = (service_id IS NULL)),
  ADD CONSTRAINT recovery_effect_claim_lease_check
    CHECK ((state = 'claimed') = (lease_expires_at IS NOT NULL)),
  ADD CONSTRAINT recovery_effect_intent_capability_check
    CHECK ((state = 'intended') = (claim_owner_id IS NULL AND permit_token IS NULL)),
  ADD CONSTRAINT recovery_effect_consumption_check
    CHECK ((state IN ('consumed','executing','completed','forward_repair')) =
      (consumed_at IS NOT NULL)),
  ADD CONSTRAINT recovery_effect_execution_receipt_presence_check
    CHECK ((state IN ('consumed','executing','completed','forward_repair')) =
      (execution_receipt_sha256 IS NOT NULL)),
  ADD CONSTRAINT recovery_effect_observation_completion_check
    CHECK ((completed_at IS NULL) = (observation IS NULL)),
  ADD CONSTRAINT recovery_effect_observation_shape_check
    CHECK (observation IS NULL OR
      release_authority.release_recovery_effect_observation_is_valid(kind,observation)),
  ADD CONSTRAINT recovery_effect_observation_service_check
    CHECK (observation IS NULL OR NOT (observation ? 'serviceId')
      OR observation->>'serviceId'=service_id),
  ADD CONSTRAINT recovery_effect_completed_check
    CHECK (state <> 'completed' OR completed_at IS NOT NULL),
  ADD CONSTRAINT recovery_effect_terminal_check
    CHECK (state IN ('completed','forward_repair') OR completed_at IS NULL);

CREATE OR REPLACE FUNCTION release_authority.release_recovery_effect_snapshot(
  p_effect release_authority.recovery_effect
) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $body$
  SELECT jsonb_build_object(
    'rolloutId',p_effect.rollout_id,'effectKey',p_effect.effect_key,
    'kind',p_effect.kind,'serviceId',p_effect.service_id,'state',p_effect.state,
    'epoch',p_effect.epoch,'claimOwnerId',p_effect.claim_owner_id,
    'permitToken',p_effect.permit_token,
    'leaseExpiresAt',CASE WHEN p_effect.lease_expires_at IS NULL THEN NULL ELSE
      to_char(p_effect.lease_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'consumedAt',CASE WHEN p_effect.consumed_at IS NULL THEN NULL ELSE
      to_char(p_effect.consumed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'completedAt',CASE WHEN p_effect.completed_at IS NULL THEN NULL ELSE
      to_char(p_effect.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'observation',p_effect.observation)
$body$;

CREATE OR REPLACE FUNCTION release_authority.release_recovery_effect_intend(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE rollout_row release_authority.rollout%ROWTYPE;
DECLARE effect_row release_authority.recovery_effect%ROWTYPE;
DECLARE service text := nullif(p_input->>'serviceId','');
BEGIN
  IF jsonb_typeof(p_input) <> 'object'
    OR jsonb_array_length(jsonb_path_query_array(p_input,'$.keyvalue()')) NOT IN (3,4)
    OR NOT p_input ?& ARRAY['rolloutId','effectKey','kind']
    OR (jsonb_array_length(jsonb_path_query_array(p_input,'$.keyvalue()'))=4) <> (p_input ? 'serviceId')
    OR length(p_input->>'rolloutId') NOT BETWEEN 1 AND 256
    OR coalesce(p_input->>'effectKey','') !~ '^[a-z][a-z0-9_]*(?::[A-Za-z0-9._-]+)?$'
    OR p_input->>'kind' NOT IN ('restore_service_config','restore_service_environment',
      'restore_service_deploy','restore_database_writes','resume_source_service')
    OR ((p_input->>'kind'='restore_database_writes') IS DISTINCT FROM (service IS NULL))
  THEN RAISE EXCEPTION 'release recovery effect intent invalid'; END IF;
  SELECT * INTO STRICT rollout_row FROM release_authority.rollout
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  IF rollout_row.state <> 'compensating' OR rollout_row.activation_boundary <> 'before'
    OR rollout_row.recovery_forward_only
    OR NOT release_authority.release_compensation_effects_are_safe(rollout_row.rollout_id)
  THEN RAISE EXCEPTION 'release recovery effect intent denied'; END IF;
  IF service IS NOT NULL AND (
    (p_input->>'kind'='resume_source_service' AND NOT EXISTS (
      SELECT 1 FROM release_authority.source_freeze_observation
      WHERE rollout_id=rollout_row.rollout_id AND service_id=service AND phase='suspended'))
    OR (p_input->>'kind'<>'resume_source_service' AND NOT EXISTS (
      SELECT 1 FROM release_authority.service_transition
      WHERE rollout_id=rollout_row.rollout_id AND service=ANY(service_ids)))
  ) THEN RAISE EXCEPTION 'release recovery effect service scope denied'; END IF;
  INSERT INTO release_authority.recovery_effect(rollout_id,effect_key,kind,service_id)
  VALUES (rollout_row.rollout_id,p_input->>'effectKey',p_input->>'kind',service)
  ON CONFLICT (rollout_id,effect_key) DO NOTHING;
  SELECT * INTO STRICT effect_row FROM release_authority.recovery_effect
    WHERE rollout_id=rollout_row.rollout_id AND effect_key=p_input->>'effectKey' FOR UPDATE;
  IF effect_row.kind <> p_input->>'kind' OR effect_row.service_id IS DISTINCT FROM service
  THEN RAISE EXCEPTION 'release recovery effect intent replay conflict'; END IF;
  RETURN release_authority.release_recovery_effect_snapshot(effect_row);
END $body$;

CREATE OR REPLACE FUNCTION release_authority.release_recovery_effect_claim(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE rollout_row release_authority.rollout%ROWTYPE;
DECLARE effect_row release_authority.recovery_effect%ROWTYPE;
DECLARE lease_seconds integer;
BEGIN
  IF jsonb_typeof(p_input) <> 'object' OR jsonb_array_length(jsonb_path_query_array(p_input,'$.keyvalue()')) <> 5
    OR NOT p_input ?& ARRAY['rolloutId','effectKey','kind','ownerId','leaseSeconds']
    OR length(p_input->>'rolloutId') NOT BETWEEN 1 AND 256
    OR coalesce(p_input->>'effectKey','') !~ '^[a-z][a-z0-9_]*(?::[A-Za-z0-9._-]+)?$'
    OR p_input->>'kind' NOT IN ('restore_service_config','restore_service_environment',
      'restore_service_deploy','restore_database_writes','resume_source_service')
    OR jsonb_typeof(p_input->'leaseSeconds') <> 'number'
    OR coalesce(p_input->>'leaseSeconds','') !~ '^[0-9]+$'
    OR (p_input->>'leaseSeconds')::numeric NOT BETWEEN 5 AND 300
    OR coalesce(p_input->>'ownerId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
  THEN RAISE EXCEPTION 'release recovery effect claim invalid'; END IF;
  lease_seconds := (p_input->>'leaseSeconds')::integer;
  SELECT * INTO STRICT rollout_row FROM release_authority.rollout
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  SELECT * INTO STRICT effect_row FROM release_authority.recovery_effect
    WHERE rollout_id=rollout_row.rollout_id AND effect_key=p_input->>'effectKey' FOR UPDATE;
  IF effect_row.kind <> p_input->>'kind'
    THEN RAISE EXCEPTION 'release recovery effect claim binding conflict'; END IF;
  IF effect_row.state IN ('consumed','executing','completed','forward_repair')
    THEN RETURN release_authority.release_recovery_effect_snapshot(effect_row); END IF;
  IF rollout_row.state <> 'compensating' OR rollout_row.activation_boundary <> 'before'
    OR rollout_row.recovery_forward_only
    OR NOT release_authority.release_compensation_effects_are_safe(rollout_row.rollout_id)
  THEN RAISE EXCEPTION 'release recovery effect claim denied'; END IF;
  IF effect_row.state='claimed' AND effect_row.lease_expires_at > clock_timestamp() THEN
    IF effect_row.claim_owner_id <> p_input->>'ownerId'
      THEN RAISE EXCEPTION 'release recovery effect already claimed'; END IF;
    RETURN release_authority.release_recovery_effect_snapshot(effect_row);
  END IF;
  UPDATE release_authority.recovery_effect SET state='claimed',epoch=epoch+1,
    claim_owner_id=p_input->>'ownerId',permit_token=
      replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),
    lease_expires_at=date_trunc('milliseconds',clock_timestamp()+make_interval(secs=>lease_seconds))
  WHERE rollout_id=effect_row.rollout_id AND effect_key=effect_row.effect_key
  RETURNING * INTO effect_row;
  RETURN release_authority.release_recovery_effect_snapshot(effect_row);
END $body$;

CREATE OR REPLACE FUNCTION release_authority.release_recovery_effect_consume(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE rollout_row release_authority.rollout%ROWTYPE;
DECLARE effect_row release_authority.recovery_effect%ROWTYPE;
DECLARE execution_receipt text;
BEGIN
  IF jsonb_typeof(p_input) <> 'object' OR jsonb_array_length(jsonb_path_query_array(p_input,'$.keyvalue()')) <> 6
    OR NOT p_input ?& ARRAY['rolloutId','effectKey','kind','ownerId','epoch','permitToken']
    OR length(p_input->>'rolloutId') NOT BETWEEN 1 AND 256
    OR coalesce(p_input->>'effectKey','') !~ '^[a-z][a-z0-9_]*(?::[A-Za-z0-9._-]+)?$'
    OR p_input->>'kind' NOT IN ('restore_service_config','restore_service_environment',
      'restore_service_deploy','restore_database_writes','resume_source_service')
    OR coalesce(p_input->>'ownerId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
    OR jsonb_typeof(p_input->'epoch') <> 'number'
    OR coalesce(p_input->>'epoch','') !~ '^[1-9][0-9]*$'
    OR (p_input->>'epoch')::numeric > 9223372036854775807
    OR coalesce(p_input->>'permitToken','') !~ '^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'release recovery effect permit invalid'; END IF;
  SELECT * INTO STRICT rollout_row FROM release_authority.rollout
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  SELECT * INTO STRICT effect_row FROM release_authority.recovery_effect
    WHERE rollout_id=rollout_row.rollout_id AND effect_key=p_input->>'effectKey' FOR UPDATE;
  IF effect_row.kind <> p_input->>'kind'
    THEN RAISE EXCEPTION 'release recovery effect permit binding conflict'; END IF;
  IF effect_row.state IN ('consumed','executing','completed','forward_repair') THEN
    IF effect_row.epoch=(p_input->>'epoch')::bigint
      AND effect_row.permit_token=p_input->>'permitToken'
      AND effect_row.claim_owner_id=p_input->>'ownerId'
    THEN RETURN jsonb_build_object('record',
      release_authority.release_recovery_effect_snapshot(effect_row),
      'executionAuthorization',NULL); END IF;
    RAISE EXCEPTION 'release recovery effect permit replay conflict';
  END IF;
  IF rollout_row.state <> 'compensating' OR rollout_row.activation_boundary <> 'before'
    OR rollout_row.recovery_forward_only
    OR NOT release_authority.release_compensation_effects_are_safe(rollout_row.rollout_id)
    OR effect_row.state <> 'claimed' OR effect_row.lease_expires_at <= clock_timestamp()
    OR effect_row.epoch <> (p_input->>'epoch')::bigint
    OR effect_row.permit_token <> p_input->>'permitToken'
    OR effect_row.claim_owner_id <> p_input->>'ownerId'
  THEN RAISE EXCEPTION 'release recovery effect permit denied'; END IF;
  execution_receipt := replace(gen_random_uuid()::text,'-','')||
    replace(gen_random_uuid()::text,'-','');
  UPDATE release_authority.recovery_effect SET state='consumed',lease_expires_at=NULL,
    consumed_at=date_trunc('milliseconds',clock_timestamp()),
    execution_receipt_sha256=encode(sha256(convert_to(execution_receipt,'UTF8')),'hex')
  WHERE rollout_id=effect_row.rollout_id AND effect_key=effect_row.effect_key
  RETURNING * INTO effect_row;
  RETURN jsonb_build_object(
    'record',release_authority.release_recovery_effect_snapshot(effect_row),
    'executionAuthorization',jsonb_build_object(
      'receipt',execution_receipt,'rolloutId',effect_row.rollout_id,
      'effectKey',effect_row.effect_key,'kind',effect_row.kind,
      'ownerId',effect_row.claim_owner_id,'epoch',effect_row.epoch,
      'permitToken',effect_row.permit_token));
END $body$;

-- The receipt is an ephemeral capability returned only to the consume
-- linearization winner. Validation is itself one-shot: a dropped validation
-- response leaves the effect executing/ambiguous and never authorizes retry.
CREATE OR REPLACE FUNCTION release_authority.release_recovery_effect_validate_execution(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE rollout_row release_authority.rollout%ROWTYPE;
DECLARE effect_row release_authority.recovery_effect%ROWTYPE;
DECLARE receipt_hash text;
BEGIN
  IF jsonb_typeof(p_input) <> 'object' OR jsonb_array_length(jsonb_path_query_array(p_input,'$.keyvalue()')) <> 7
    OR NOT p_input ?& ARRAY['rolloutId','effectKey','kind','ownerId','epoch','permitToken','executionReceipt']
    OR length(p_input->>'rolloutId') NOT BETWEEN 1 AND 256
    OR coalesce(p_input->>'effectKey','') !~ '^[a-z][a-z0-9_]*(?::[A-Za-z0-9._-]+)?$'
    OR p_input->>'kind' NOT IN ('restore_service_config','restore_service_environment',
      'restore_service_deploy','restore_database_writes','resume_source_service')
    OR coalesce(p_input->>'ownerId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
    OR jsonb_typeof(p_input->'epoch') <> 'number'
    OR coalesce(p_input->>'epoch','') !~ '^[1-9][0-9]*$'
    OR (p_input->>'epoch')::numeric > 9223372036854775807
    OR coalesce(p_input->>'permitToken','') !~ '^[a-f0-9]{64}$'
    OR coalesce(p_input->>'executionReceipt','') !~ '^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'release recovery effect execution validation invalid'; END IF;
  receipt_hash := encode(sha256(convert_to(p_input->>'executionReceipt','UTF8')),'hex');
  SELECT * INTO STRICT rollout_row FROM release_authority.rollout
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  SELECT * INTO STRICT effect_row FROM release_authority.recovery_effect
    WHERE rollout_id=rollout_row.rollout_id AND effect_key=p_input->>'effectKey' FOR UPDATE;
  IF effect_row.kind <> p_input->>'kind' OR effect_row.epoch <> (p_input->>'epoch')::bigint
    OR effect_row.permit_token <> p_input->>'permitToken'
    OR effect_row.claim_owner_id <> p_input->>'ownerId'
    OR effect_row.execution_receipt_sha256 <> receipt_hash
  THEN RAISE EXCEPTION 'release recovery effect execution fence conflict'; END IF;
  IF effect_row.state='executing' THEN
    RETURN jsonb_build_object('record',release_authority.release_recovery_effect_snapshot(effect_row),
      'executionAuthorization',NULL);
  END IF;
  IF rollout_row.state <> 'compensating' OR rollout_row.activation_boundary <> 'before'
    OR rollout_row.recovery_forward_only
    OR NOT release_authority.release_compensation_effects_are_safe(rollout_row.rollout_id)
    OR effect_row.state <> 'consumed'
  THEN RAISE EXCEPTION 'release recovery effect execution denied'; END IF;
  UPDATE release_authority.recovery_effect SET state='executing'
    WHERE rollout_id=effect_row.rollout_id AND effect_key=effect_row.effect_key
    RETURNING * INTO effect_row;
  RETURN jsonb_build_object(
    'record',release_authority.release_recovery_effect_snapshot(effect_row),
    'executionAuthorization',jsonb_build_object(
      'receipt',p_input->>'executionReceipt','rolloutId',effect_row.rollout_id,
      'effectKey',effect_row.effect_key,'kind',effect_row.kind,
      'ownerId',effect_row.claim_owner_id,'epoch',effect_row.epoch,
      'permitToken',effect_row.permit_token));
END $body$;

CREATE OR REPLACE FUNCTION release_authority.release_recovery_effect_complete(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE rollout_row release_authority.rollout%ROWTYPE;
DECLARE effect_row release_authority.recovery_effect%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_input) <> 'object' OR jsonb_array_length(jsonb_path_query_array(p_input,'$.keyvalue()')) <> 8
    OR NOT p_input ?& ARRAY['rolloutId','effectKey','kind','ownerId','epoch','permitToken','executionReceipt','observation']
    OR length(p_input->>'rolloutId') NOT BETWEEN 1 AND 256
    OR coalesce(p_input->>'effectKey','') !~ '^[a-z][a-z0-9_]*(?::[A-Za-z0-9._-]+)?$'
    OR p_input->>'kind' NOT IN ('restore_service_config','restore_service_environment',
      'restore_service_deploy','restore_database_writes','resume_source_service')
    OR coalesce(p_input->>'ownerId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
    OR jsonb_typeof(p_input->'epoch') <> 'number'
    OR coalesce(p_input->>'epoch','') !~ '^[1-9][0-9]*$'
    OR (p_input->>'epoch')::numeric > 9223372036854775807
    OR coalesce(p_input->>'permitToken','') !~ '^[a-f0-9]{64}$'
    OR coalesce(p_input->>'executionReceipt','') !~ '^[a-f0-9]{64}$'
    OR NOT release_authority.release_recovery_effect_observation_is_valid(
      p_input->>'kind',p_input->'observation')
  THEN RAISE EXCEPTION 'release recovery effect observation invalid'; END IF;
  SELECT * INTO STRICT rollout_row FROM release_authority.rollout
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  SELECT * INTO STRICT effect_row FROM release_authority.recovery_effect
    WHERE rollout_id=rollout_row.rollout_id AND effect_key=p_input->>'effectKey' FOR UPDATE;
  IF effect_row.kind <> p_input->>'kind'
    OR effect_row.claim_owner_id <> p_input->>'ownerId'
  THEN RAISE EXCEPTION 'release recovery effect completion binding conflict'; END IF;
  IF (p_input->'observation') ? 'serviceId'
    AND p_input->'observation'->>'serviceId' <> effect_row.service_id
  THEN RAISE EXCEPTION 'release recovery effect observation binding conflict'; END IF;
  IF effect_row.epoch <> (p_input->>'epoch')::bigint
    OR effect_row.permit_token <> p_input->>'permitToken'
    OR effect_row.execution_receipt_sha256 <>
      encode(sha256(convert_to(p_input->>'executionReceipt','UTF8')),'hex')
  THEN RAISE EXCEPTION 'release recovery effect completion fence conflict'; END IF;
  IF effect_row.state='completed' THEN
    IF effect_row.observation <> p_input->'observation'
      THEN RAISE EXCEPTION 'release recovery effect completion replay conflict'; END IF;
    RETURN release_authority.release_recovery_effect_snapshot(effect_row);
  END IF;
  IF effect_row.state='forward_repair' OR rollout_row.recovery_forward_only THEN
    IF effect_row.observation IS NOT NULL AND effect_row.observation <> p_input->'observation'
      THEN RAISE EXCEPTION 'release recovery effect forward observation conflict'; END IF;
    IF effect_row.observation IS NULL THEN
      UPDATE release_authority.recovery_effect SET state='forward_repair',
        completed_at=date_trunc('milliseconds',clock_timestamp()),observation=p_input->'observation'
      WHERE rollout_id=effect_row.rollout_id AND effect_key=effect_row.effect_key
      RETURNING * INTO effect_row;
    END IF;
    RETURN release_authority.release_recovery_effect_snapshot(effect_row);
  END IF;
  IF effect_row.state <> 'executing'
    THEN RAISE EXCEPTION 'release recovery effect execution not authorized'; END IF;
  UPDATE release_authority.recovery_effect SET state='completed',
    completed_at=date_trunc('milliseconds',clock_timestamp()),observation=p_input->'observation'
  WHERE rollout_id=effect_row.rollout_id AND effect_key=effect_row.effect_key
  RETURNING * INTO effect_row;
  RETURN release_authority.release_recovery_effect_snapshot(effect_row);
END $body$;

-- Recovery after a consumed/executing crash is deliberately not completion.
-- It durably records the observation for operator reconciliation while keeping
-- every completion-gated checkpoint closed.
CREATE OR REPLACE FUNCTION release_authority.release_recovery_effect_reconcile(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE rollout_row release_authority.rollout%ROWTYPE;
DECLARE effect_row release_authority.recovery_effect%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_input) <> 'object' OR jsonb_array_length(jsonb_path_query_array(p_input,'$.keyvalue()')) <> 7
    OR NOT p_input ?& ARRAY['rolloutId','effectKey','kind','ownerId','epoch','permitToken','observation']
    OR length(p_input->>'rolloutId') NOT BETWEEN 1 AND 256
    OR coalesce(p_input->>'effectKey','') !~ '^[a-z][a-z0-9_]*(?::[A-Za-z0-9._-]+)?$'
    OR p_input->>'kind' NOT IN ('restore_service_config','restore_service_environment',
      'restore_service_deploy','restore_database_writes','resume_source_service')
    OR coalesce(p_input->>'ownerId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
    OR jsonb_typeof(p_input->'epoch') <> 'number'
    OR coalesce(p_input->>'epoch','') !~ '^[1-9][0-9]*$'
    OR (p_input->>'epoch')::numeric > 9223372036854775807
    OR coalesce(p_input->>'permitToken','') !~ '^[a-f0-9]{64}$'
    OR NOT release_authority.release_recovery_effect_observation_is_valid(
      p_input->>'kind',p_input->'observation')
  THEN RAISE EXCEPTION 'release recovery effect reconciliation invalid'; END IF;
  SELECT * INTO STRICT rollout_row FROM release_authority.rollout
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  SELECT * INTO STRICT effect_row FROM release_authority.recovery_effect
    WHERE rollout_id=rollout_row.rollout_id AND effect_key=p_input->>'effectKey' FOR UPDATE;
  IF effect_row.kind <> p_input->>'kind' OR effect_row.claim_owner_id <> p_input->>'ownerId'
    OR effect_row.epoch <> (p_input->>'epoch')::bigint
    OR effect_row.permit_token <> p_input->>'permitToken'
    OR effect_row.state NOT IN ('consumed','executing','forward_repair')
  THEN RAISE EXCEPTION 'release recovery effect reconciliation fence conflict'; END IF;
  IF (p_input->'observation') ? 'serviceId'
    AND p_input->'observation'->>'serviceId' <> effect_row.service_id
  THEN RAISE EXCEPTION 'release recovery effect observation binding conflict'; END IF;
  IF effect_row.observation IS NOT NULL AND effect_row.observation <> p_input->'observation'
    THEN RAISE EXCEPTION 'release recovery effect forward observation conflict'; END IF;
  UPDATE release_authority.rollout SET recovery_forward_only=true,updated_at=clock_timestamp()
    WHERE rollout_id=effect_row.rollout_id;
  UPDATE release_authority.recovery_effect SET state='forward_repair',
    completed_at=coalesce(completed_at,date_trunc('milliseconds',clock_timestamp())),
    observation=coalesce(observation,p_input->'observation')
    WHERE rollout_id=effect_row.rollout_id AND effect_key=effect_row.effect_key
    RETURNING * INTO effect_row;
  RETURN release_authority.release_recovery_effect_snapshot(effect_row);
END $body$;

-- This trigger runs inside late-job persistence, after its rollout-first lock.
-- A pre-consumption job makes the subsequent consume fail. A post-consumption
-- job records a monotonic forward-repair state; it never rewinds the effect.
CREATE OR REPLACE FUNCTION release_authority.release_late_job_recovery_effect_gate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF EXISTS (SELECT 1 FROM release_authority.recovery_effect
      WHERE rollout_id=NEW.rollout_id AND state IN ('consumed','executing','completed','forward_repair')) THEN
    UPDATE release_authority.rollout SET recovery_forward_only=true,updated_at=clock_timestamp()
      WHERE rollout_id=NEW.rollout_id;
    UPDATE release_authority.recovery_effect SET state='forward_repair'
      WHERE rollout_id=NEW.rollout_id AND state IN ('consumed','executing','completed');
  END IF;
  RETURN NEW;
END $body$;

-- Old checkpoints are observations only. They can no longer authorize their
-- own effects; a completed permit-bound effect must precede each completion.
CREATE OR REPLACE FUNCTION release_authority.release_recovery_checkpoint_permit_gate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE required_key text; required_kind text;
BEGIN
  required_kind := CASE NEW.step
    WHEN 'source_config_restored' THEN 'restore_service_config'
    WHEN 'source_env_restored' THEN 'restore_service_environment'
    WHEN 'source_deployed' THEN 'restore_service_deploy'
    WHEN 'source_acl_restored' THEN 'restore_database_writes'
    WHEN 'source_resumed' THEN 'resume_source_service' END;
  IF required_kind IS NULL THEN RETURN NEW; END IF;
  required_key := CASE required_kind
    WHEN 'restore_database_writes' THEN 'restore_database_writes'
    ELSE required_kind||':'||NEW.service_id END;
  IF NOT EXISTS (SELECT 1 FROM release_authority.recovery_effect
      WHERE rollout_id=NEW.rollout_id AND effect_key=required_key
        AND kind=required_kind AND state='completed')
  THEN RAISE EXCEPTION 'release recovery checkpoint permit completion missing'; END IF;
  RETURN NEW;
END $body$;

CREATE TABLE release_authority.provider_resource_lease (
  provider text NOT NULL CHECK (provider IN ('render')),
  resource_kind text NOT NULL CHECK (resource_kind IN (
    'service','service_environment','deploy_creation_slot','job_creation_intent')),
  resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 256),
  fence_epoch bigint NOT NULL DEFAULT 0 CHECK (fence_epoch >= 0),
  active_rollout_id text,
  active_operation text,
  active_permit_id text,
  active_state text CHECK (active_state IN ('claimed','consumed','executing','forward_repair')),
  updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  PRIMARY KEY (provider,resource_kind,resource_id),
  CHECK ((active_rollout_id IS NULL)=(active_operation IS NULL)),
  CHECK ((active_rollout_id IS NULL)=(active_permit_id IS NULL)),
  CHECK ((active_rollout_id IS NULL)=(active_state IS NULL))
);

CREATE TABLE release_authority.provider_mutation (
  rollout_id text NOT NULL REFERENCES release_authority.rollout(rollout_id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 256),
  provider text NOT NULL CHECK (provider IN ('render')),
  resource_kind text NOT NULL CHECK (resource_kind IN (
    'service','service_environment','deploy_creation_slot','job_creation_intent')),
  resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 256),
  expected_fingerprint text NOT NULL CHECK (expected_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  expected_version text,
  authority_operation text NOT NULL CHECK (authority_operation IN (
    'freeze_source','deploy_target','resume_target','resume_source')),
  authority_receipt_sha256 text NOT NULL CHECK (
    authority_receipt_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN (
    'claimed','consumed','executing','completed','precondition_drift',
    'execution_denied','forward_repair','expired_unconsumed')),
  owner_id text NOT NULL CHECK (owner_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  epoch bigint NOT NULL CHECK (epoch > 0),
  permit_id text NOT NULL UNIQUE CHECK (permit_id ~ '^[a-f0-9]{64}$'),
  permit_token text NOT NULL CHECK (permit_token ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  consumed_at timestamptz(3),
  receipt_id text CHECK (receipt_id ~ '^[a-f0-9]{64}$'),
  observation jsonb,
  terminal_result text CHECK (terminal_result IN (
    'exact_postcondition','precondition_drift','execution_not_authorized',
    'ambiguous_forward_repair','expired_unconsumed')),
  completed_at timestamptz(3),
  PRIMARY KEY (rollout_id,operation,provider,resource_kind,resource_id),
  CHECK ((state IN ('claimed','expired_unconsumed'))=
    (consumed_at IS NULL AND receipt_id IS NULL)),
  CHECK ((state IN ('completed','precondition_drift','execution_denied',
    'forward_repair','expired_unconsumed'))=(completed_at IS NOT NULL)),
  CHECK ((terminal_result IS NULL)=(completed_at IS NULL)),
  CHECK (state<>'expired_unconsumed' OR observation IS NULL)
);

CREATE FUNCTION release_authority.release_provider_mutation_permit(
  p_row release_authority.provider_mutation
) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $body$
  SELECT jsonb_build_object(
    'rolloutId',p_row.rollout_id,'operation',p_row.operation,
    'resource',jsonb_build_object('provider',p_row.provider,
      'kind',p_row.resource_kind,'id',p_row.resource_id),
    'ownerId',p_row.owner_id,'epoch',p_row.epoch,'permitId',p_row.permit_id,
    'token',p_row.permit_token,
    'expected',jsonb_build_object('fingerprint',p_row.expected_fingerprint,
      'version',p_row.expected_version),
    'issuedAt',to_char(p_row.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt',to_char(p_row.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'singleUse',true)
$body$;

CREATE FUNCTION release_authority.release_provider_mutation_receipt(
  p_row release_authority.provider_mutation
) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $body$
  SELECT jsonb_build_object(
    'rolloutId',p_row.rollout_id,'operation',p_row.operation,
    'resource',jsonb_build_object('provider',p_row.provider,
      'kind',p_row.resource_kind,'id',p_row.resource_id),
    'ownerId',p_row.owner_id,'epoch',p_row.epoch,'permitId',p_row.permit_id,
    'receiptId',p_row.receipt_id,
    'expected',jsonb_build_object('fingerprint',p_row.expected_fingerprint,
      'version',p_row.expected_version),
    'consumedAt',to_char(p_row.consumed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$body$;

CREATE FUNCTION release_authority.release_provider_mutation_outcome(
  p_row release_authority.provider_mutation
) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $body$
  SELECT jsonb_build_object(
    'status','terminal','result',p_row.terminal_result,
    'rolloutId',p_row.rollout_id,'operation',p_row.operation,
    'resource',jsonb_build_object('provider',p_row.provider,
      'kind',p_row.resource_kind,'id',p_row.resource_id),
    'ownerId',p_row.owner_id,'epoch',p_row.epoch,'permitId',p_row.permit_id,
    'receiptId',p_row.receipt_id,
    'expected',jsonb_build_object('fingerprint',p_row.expected_fingerprint,
      'version',p_row.expected_version),
    'consumedAt',to_char(p_row.consumed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'observation',p_row.observation,
    'completedAt',to_char(p_row.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$body$;

CREATE FUNCTION release_authority.release_provider_mutation_authority_is_current(
  p_row release_authority.provider_mutation
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $body$
  SELECT EXISTS (SELECT 1 FROM release_authority.rollout rollout_row
    JOIN release_authority.provider_authority_decision decision
      ON decision.rollout_id=rollout_row.rollout_id
     AND decision.operation=p_row.authority_operation
     AND decision.expected_receipt_sha256=p_row.authority_receipt_sha256
    WHERE rollout_row.rollout_id=p_row.rollout_id
      AND rollout_row.last_receipt_sha256=p_row.authority_receipt_sha256
      AND decision.source_system_identifier=rollout_row.source_system_identifier
      AND decision.target_system_identifier=rollout_row.target_system_identifier
      AND decision.activation_boundary=rollout_row.activation_boundary)
$body$;

CREATE FUNCTION release_authority.release_provider_mutation_issue(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE mutation release_authority.provider_mutation%ROWTYPE;
DECLARE resource_lease release_authority.provider_resource_lease%ROWTYPE;
DECLARE seconds integer;
DECLARE new_permit_id text;
DECLARE mutation_exists boolean;
DECLARE rollout_row release_authority.rollout%ROWTYPE;
DECLARE required_decision text;
BEGIN
  IF jsonb_typeof(p_input)<>'object'
    OR jsonb_array_length(jsonb_path_query_array(p_input,'$.keyvalue()'))<>6
    OR NOT p_input ?& ARRAY['rolloutId','operation','resource','ownerId','expected','leaseSeconds']
    OR length(p_input->>'rolloutId') NOT BETWEEN 1 AND 256
    OR length(p_input->>'operation') NOT BETWEEN 1 AND 256
    OR coalesce(p_input->>'ownerId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
    OR jsonb_typeof(p_input->'resource')<>'object'
    OR jsonb_array_length(jsonb_path_query_array(p_input->'resource','$.keyvalue()'))<>3
    OR NOT (p_input->'resource') ?& ARRAY['provider','kind','id']
    OR p_input#>>'{resource,provider}' <> 'render'
    OR p_input#>>'{resource,kind}' NOT IN (
      'service','service_environment','deploy_creation_slot','job_creation_intent')
    OR length(p_input#>>'{resource,id}') NOT BETWEEN 1 AND 256
    OR jsonb_typeof(p_input->'expected')<>'object'
    OR jsonb_array_length(jsonb_path_query_array(p_input->'expected','$.keyvalue()'))<>2
    OR NOT (p_input->'expected') ?& ARRAY['fingerprint','version']
    OR coalesce(p_input#>>'{expected,fingerprint}','') !~ '^sha256:[a-f0-9]{64}$'
    OR ((p_input#>'{expected,version}') <> 'null'::jsonb
      AND length(p_input#>>'{expected,version}') NOT BETWEEN 1 AND 256)
    OR jsonb_typeof(p_input->'leaseSeconds')<>'number'
    OR coalesce(p_input->>'leaseSeconds','') !~ '^[0-9]+$'
    OR (p_input->>'leaseSeconds')::numeric NOT BETWEEN 5 AND 300
  THEN RAISE EXCEPTION 'provider mutation issue invalid'; END IF;
  seconds := (p_input->>'leaseSeconds')::integer;
  SELECT * INTO rollout_row FROM release_authority.rollout
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'provider mutation rollout missing'; END IF;
  IF p_input->>'operation' !~ '^(freeze|target_[a-z_]+|recover_resume_source|service_(suspend|resume)|configure_(target|source)|replace_environment|deploy_(artifact|source)):'
    OR pg_catalog.right(p_input->>'operation',
      pg_catalog.length(p_input#>>'{resource,id}')+1)
      IS DISTINCT FROM ':'||(p_input#>>'{resource,id}')
  THEN RAISE EXCEPTION 'provider mutation operation resource binding denied'; END IF;
  required_decision := CASE
    WHEN p_input->>'operation' LIKE 'freeze:%' THEN 'freeze_source'
    WHEN rollout_row.state='pre_activation' THEN 'deploy_target'
    WHEN rollout_row.state='activated' THEN 'resume_target'
    WHEN rollout_row.state='compensating' THEN 'resume_source'
    ELSE '__invalid__' END;
  IF required_decision='__invalid__'
    OR (required_decision='deploy_target' AND (rollout_row.state<>'pre_activation'
      OR rollout_row.activation_boundary<>'before'))
    OR (required_decision='resume_target' AND (rollout_row.state<>'activated'
      OR rollout_row.activation_boundary<>'activated'))
    OR (required_decision='resume_source' AND (rollout_row.state<>'compensating'
      OR rollout_row.activation_boundary<>'before'
      OR rollout_row.authoritative_system_identifier<>
        rollout_row.source_system_identifier))
    OR (required_decision IS NOT NULL AND required_decision<>'__invalid__'
      AND NOT EXISTS (SELECT 1
        FROM release_authority.provider_authority_decision decision
        WHERE decision.rollout_id=rollout_row.rollout_id
          AND decision.operation=required_decision
          AND decision.expected_receipt_sha256=rollout_row.last_receipt_sha256
          AND decision.source_system_identifier=rollout_row.source_system_identifier
          AND decision.target_system_identifier=rollout_row.target_system_identifier
          AND decision.activation_boundary=rollout_row.activation_boundary))
  THEN RAISE EXCEPTION 'provider mutation rollout authority denied'; END IF;

  INSERT INTO release_authority.provider_resource_lease(
    provider,resource_kind,resource_id)
  VALUES ('render',p_input#>>'{resource,kind}',p_input#>>'{resource,id}')
  ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT resource_lease
  FROM release_authority.provider_resource_lease
  WHERE provider='render' AND resource_kind=p_input#>>'{resource,kind}'
    AND resource_id=p_input#>>'{resource,id}' FOR UPDATE;

  SELECT * INTO mutation FROM release_authority.provider_mutation
  WHERE rollout_id=p_input->>'rolloutId' AND operation=p_input->>'operation'
    AND provider='render' AND resource_kind=p_input#>>'{resource,kind}'
    AND resource_id=p_input#>>'{resource,id}' FOR UPDATE;
  mutation_exists := FOUND;

  IF resource_lease.active_rollout_id IS NOT NULL THEN
    IF resource_lease.active_rollout_id<>p_input->>'rolloutId'
      OR resource_lease.active_operation<>p_input->>'operation'
    THEN
      IF resource_lease.active_state<>'claimed' THEN
        RAISE EXCEPTION 'provider resource mutation lease held';
      END IF;
      UPDATE release_authority.provider_mutation SET
        state='expired_unconsumed',terminal_result='expired_unconsumed',
        completed_at=date_trunc('milliseconds',clock_timestamp())
      WHERE rollout_id=resource_lease.active_rollout_id
        AND operation=resource_lease.active_operation
        AND provider=resource_lease.provider
        AND resource_kind=resource_lease.resource_kind
        AND resource_id=resource_lease.resource_id
        AND state='claimed' AND expires_at<=clock_timestamp();
      IF NOT FOUND THEN RAISE EXCEPTION 'provider resource mutation lease held'; END IF;
      resource_lease.active_rollout_id := NULL;
    ELSIF NOT mutation_exists THEN
      RAISE EXCEPTION 'provider resource mutation identity missing';
    END IF;
  END IF;

  IF mutation_exists THEN
    IF mutation.expected_fingerprint<>p_input#>>'{expected,fingerprint}'
      OR mutation.expected_version IS DISTINCT FROM nullif(p_input#>>'{expected,version}','')
      OR mutation.authority_operation<>required_decision
      OR mutation.authority_receipt_sha256<>rollout_row.last_receipt_sha256
    THEN RAISE EXCEPTION 'provider mutation expected state conflict'; END IF;
    IF mutation.state<>'claimed' THEN
      RAISE EXCEPTION 'provider mutation terminal authorization cannot be renewed';
    END IF;
    IF mutation.expires_at>clock_timestamp() THEN
      IF mutation.owner_id<>p_input->>'ownerId'
      THEN RAISE EXCEPTION 'provider mutation lease held'; END IF;
      RETURN release_authority.release_provider_mutation_permit(mutation);
    END IF;
  END IF;

  new_permit_id := replace(gen_random_uuid()::text,'-','')||
    replace(gen_random_uuid()::text,'-','');
  UPDATE release_authority.provider_resource_lease SET
    fence_epoch=fence_epoch+1,active_rollout_id=p_input->>'rolloutId',
    active_operation=p_input->>'operation',active_permit_id=new_permit_id,
    active_state='claimed',updated_at=date_trunc('milliseconds',clock_timestamp())
  WHERE provider=resource_lease.provider
    AND resource_kind=resource_lease.resource_kind
    AND resource_id=resource_lease.resource_id
  RETURNING * INTO resource_lease;

  IF mutation_exists THEN
    UPDATE release_authority.provider_mutation SET
      owner_id=p_input->>'ownerId',epoch=resource_lease.fence_epoch,
      authority_operation=required_decision,
      authority_receipt_sha256=rollout_row.last_receipt_sha256,
      permit_id=new_permit_id,
      permit_token=replace(gen_random_uuid()::text,'-','')||
        replace(gen_random_uuid()::text,'-',''),
      issued_at=date_trunc('milliseconds',clock_timestamp()),
      expires_at=date_trunc('milliseconds',clock_timestamp()+make_interval(secs=>seconds))
    WHERE rollout_id=mutation.rollout_id AND operation=mutation.operation
      AND provider=mutation.provider AND resource_kind=mutation.resource_kind
      AND resource_id=mutation.resource_id RETURNING * INTO mutation;
  ELSE
    INSERT INTO release_authority.provider_mutation(
      rollout_id,operation,provider,resource_kind,resource_id,
      expected_fingerprint,expected_version,authority_operation,
      authority_receipt_sha256,state,owner_id,epoch,permit_id,
      permit_token,issued_at,expires_at)
    VALUES (p_input->>'rolloutId',p_input->>'operation','render',
      p_input#>>'{resource,kind}',p_input#>>'{resource,id}',
      p_input#>>'{expected,fingerprint}',nullif(p_input#>>'{expected,version}',''),
      required_decision,rollout_row.last_receipt_sha256,
      'claimed',p_input->>'ownerId',resource_lease.fence_epoch,new_permit_id,
      replace(gen_random_uuid()::text,'-','')||
        replace(gen_random_uuid()::text,'-',''),
      date_trunc('milliseconds',clock_timestamp()),
      date_trunc('milliseconds',clock_timestamp()+make_interval(secs=>seconds)))
    RETURNING * INTO mutation;
  END IF;
  RETURN release_authority.release_provider_mutation_permit(mutation);
END $body$;

-- Durable idempotency read and bounded takeover. A stale consumed record is
-- safe to rotate because execution validation did not commit; the epoch change
-- invalidates the old receipt atomically. Executing is reconciliation-only.
CREATE FUNCTION release_authority.release_provider_mutation_recover(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE mutation release_authority.provider_mutation%ROWTYPE;
DECLARE resource_lease release_authority.provider_resource_lease%ROWTYPE;
DECLARE seconds integer;
DECLARE new_permit_id text;
BEGIN
  IF jsonb_typeof(p_input)<>'object'
    OR jsonb_array_length(jsonb_path_query_array(p_input,'$.keyvalue()'))<>6
    OR NOT p_input ?& ARRAY['rolloutId','operation','resource','ownerId','expected','leaseSeconds']
    OR length(p_input->>'rolloutId') NOT BETWEEN 1 AND 256
    OR length(p_input->>'operation') NOT BETWEEN 1 AND 256
    OR coalesce(p_input->>'ownerId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
    OR jsonb_typeof(p_input->'resource')<>'object'
    OR jsonb_array_length(jsonb_path_query_array(p_input->'resource','$.keyvalue()'))<>3
    OR NOT (p_input->'resource') ?& ARRAY['provider','kind','id']
    OR p_input#>>'{resource,provider}' <> 'render'
    OR p_input#>>'{resource,kind}' NOT IN (
      'service','service_environment','deploy_creation_slot','job_creation_intent')
    OR length(p_input#>>'{resource,id}') NOT BETWEEN 1 AND 256
    OR jsonb_typeof(p_input->'expected')<>'object'
    OR jsonb_array_length(jsonb_path_query_array(p_input->'expected','$.keyvalue()'))<>2
    OR NOT (p_input->'expected') ?& ARRAY['fingerprint','version']
    OR coalesce(p_input#>>'{expected,fingerprint}','') !~ '^sha256:[a-f0-9]{64}$'
    OR ((p_input#>'{expected,version}') <> 'null'::jsonb
      AND length(p_input#>>'{expected,version}') NOT BETWEEN 1 AND 256)
    OR jsonb_typeof(p_input->'leaseSeconds')<>'number'
    OR coalesce(p_input->>'leaseSeconds','') !~ '^[0-9]+$'
    OR (p_input->>'leaseSeconds')::numeric NOT BETWEEN 5 AND 300
  THEN RAISE EXCEPTION 'provider mutation recovery invalid'; END IF;
  seconds := (p_input->>'leaseSeconds')::integer;
  -- Canonical lock order is resource first in every provider mutation routine.
  SELECT * INTO resource_lease FROM release_authority.provider_resource_lease
  WHERE provider=p_input#>>'{resource,provider}'
    AND resource_kind=p_input#>>'{resource,kind}'
    AND resource_id=p_input#>>'{resource,id}' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','absent'); END IF;
  SELECT * INTO mutation FROM release_authority.provider_mutation
  WHERE rollout_id=p_input->>'rolloutId' AND operation=p_input->>'operation'
    AND provider=resource_lease.provider
    AND resource_kind=resource_lease.resource_kind
    AND resource_id=resource_lease.resource_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','absent'); END IF;
  -- Executing/terminal records carry the authoritative precondition. A
  -- restarted worker observes today's post-state, so its provisional witness
  -- must not prevent reconciliation or exact replay.
  IF ((mutation.completed_at IS NULL AND mutation.state<>'executing') AND (
      mutation.expected_fingerprint<>p_input#>>'{expected,fingerprint}'
      OR mutation.expected_version IS DISTINCT FROM nullif(p_input#>>'{expected,version}','')))
    OR (mutation.owner_id<>p_input->>'ownerId' AND (
      mutation.completed_at IS NOT NULL OR mutation.state='executing'
      OR mutation.expires_at>clock_timestamp()))
  THEN RAISE EXCEPTION 'provider mutation recovery binding conflict'; END IF;
  IF mutation.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('status','terminal','outcome',
      release_authority.release_provider_mutation_outcome(mutation));
  END IF;
  IF mutation.state<>'executing'
    AND NOT release_authority.release_provider_mutation_authority_is_current(mutation)
  THEN RAISE EXCEPTION 'provider mutation recovery authority stale'; END IF;
  IF resource_lease.fence_epoch<>mutation.epoch
    OR resource_lease.active_rollout_id<>mutation.rollout_id
    OR resource_lease.active_operation<>mutation.operation
    OR resource_lease.active_permit_id<>mutation.permit_id
  THEN RAISE EXCEPTION 'provider mutation recovery resource fence conflict'; END IF;
  IF mutation.state='claimed' THEN
    IF mutation.expires_at<=clock_timestamp() THEN
      RETURN jsonb_build_object('status','absent');
    END IF;
    RETURN jsonb_build_object('status','permit','permit',
      release_authority.release_provider_mutation_permit(mutation));
  END IF;
  IF mutation.state='consumed' AND mutation.expires_at<=clock_timestamp() THEN
    new_permit_id := replace(gen_random_uuid()::text,'-','')||
      replace(gen_random_uuid()::text,'-','');
    UPDATE release_authority.provider_resource_lease SET
      fence_epoch=fence_epoch+1,active_permit_id=new_permit_id,
      active_state='claimed',updated_at=date_trunc('milliseconds',clock_timestamp())
    WHERE provider=mutation.provider AND resource_kind=mutation.resource_kind
      AND resource_id=mutation.resource_id RETURNING * INTO resource_lease;
    UPDATE release_authority.provider_mutation SET state='claimed',
      owner_id=p_input->>'ownerId',epoch=resource_lease.fence_epoch,
      permit_id=new_permit_id,
      permit_token=replace(gen_random_uuid()::text,'-','')||
        replace(gen_random_uuid()::text,'-',''),
      issued_at=date_trunc('milliseconds',clock_timestamp()),
      expires_at=date_trunc('milliseconds',clock_timestamp()+make_interval(secs=>seconds)),
      consumed_at=NULL,receipt_id=NULL
    WHERE rollout_id=mutation.rollout_id AND operation=mutation.operation
      AND provider=mutation.provider AND resource_kind=mutation.resource_kind
      AND resource_id=mutation.resource_id RETURNING * INTO mutation;
    RETURN jsonb_build_object('status','permit','permit',
      release_authority.release_provider_mutation_permit(mutation));
  END IF;
  IF mutation.state IN ('consumed','executing') THEN
    RETURN jsonb_build_object('status','receipt','phase',mutation.state,
      -- A fresh executing lease can still be inside provider I/O. Exact replay
      -- may inspect it, but must not reconcile or clear its resource fence.
      'reconciliationOnly',mutation.state='executing'
        AND mutation.expires_at<=clock_timestamp(),'receipt',
      release_authority.release_provider_mutation_receipt(mutation));
  END IF;
  RAISE EXCEPTION 'provider mutation recovery state invalid';
END $body$;

CREATE FUNCTION release_authority.release_provider_mutation_consume(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE mutation release_authority.provider_mutation%ROWTYPE;
DECLARE resource_lease release_authority.provider_resource_lease%ROWTYPE;
BEGIN
  SELECT * INTO STRICT resource_lease FROM release_authority.provider_resource_lease
  WHERE provider=p_input#>>'{resource,provider}'
    AND resource_kind=p_input#>>'{resource,kind}'
    AND resource_id=p_input#>>'{resource,id}' FOR UPDATE;
  SELECT * INTO STRICT mutation FROM release_authority.provider_mutation
  WHERE rollout_id=p_input->>'rolloutId' AND operation=p_input->>'operation'
    AND provider=resource_lease.provider AND resource_kind=resource_lease.resource_kind
    AND resource_id=resource_lease.resource_id FOR UPDATE;
  IF mutation.owner_id<>p_input->>'ownerId'
    OR mutation.epoch<>(p_input->>'epoch')::bigint
    OR mutation.permit_id<>p_input->>'permitId'
    OR mutation.permit_token<>p_input->>'token'
    OR mutation.expected_fingerprint<>p_input#>>'{expected,fingerprint}'
    OR mutation.expected_version IS DISTINCT FROM nullif(p_input#>>'{expected,version}','')
    OR resource_lease.fence_epoch<>mutation.epoch
    OR resource_lease.active_rollout_id<>mutation.rollout_id
    OR resource_lease.active_operation<>mutation.operation
    OR resource_lease.active_permit_id<>mutation.permit_id
    OR NOT release_authority.release_provider_mutation_authority_is_current(mutation)
  THEN RAISE EXCEPTION 'provider mutation permit binding conflict'; END IF;
  IF mutation.state<>'claimed' THEN
    IF mutation.receipt_id IS NOT NULL THEN
      RETURN release_authority.release_provider_mutation_receipt(mutation);
    END IF;
    RAISE EXCEPTION 'provider mutation permit denied';
  END IF;
  IF mutation.expires_at<=clock_timestamp()
  THEN RAISE EXCEPTION 'provider mutation permit expired'; END IF;
  UPDATE release_authority.provider_mutation SET state='consumed',
    consumed_at=date_trunc('milliseconds',clock_timestamp()),
    receipt_id=replace(gen_random_uuid()::text,'-','')||
      replace(gen_random_uuid()::text,'-','')
  WHERE rollout_id=mutation.rollout_id AND operation=mutation.operation
    AND provider=mutation.provider AND resource_kind=mutation.resource_kind
    AND resource_id=mutation.resource_id RETURNING * INTO mutation;
  UPDATE release_authority.provider_resource_lease SET
    active_state='consumed',updated_at=date_trunc('milliseconds',clock_timestamp())
  WHERE provider=mutation.provider AND resource_kind=mutation.resource_kind
    AND resource_id=mutation.resource_id;
  RETURN release_authority.release_provider_mutation_receipt(mutation);
END $body$;

CREATE FUNCTION release_authority.release_provider_mutation_validate_execution(p_input jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE mutation release_authority.provider_mutation%ROWTYPE;
DECLARE resource_lease release_authority.provider_resource_lease%ROWTYPE;
BEGIN
  SELECT * INTO STRICT resource_lease FROM release_authority.provider_resource_lease
  WHERE provider=p_input#>>'{resource,provider}'
    AND resource_kind=p_input#>>'{resource,kind}'
    AND resource_id=p_input#>>'{resource,id}' FOR UPDATE;
  SELECT * INTO STRICT mutation FROM release_authority.provider_mutation
  WHERE rollout_id=p_input->>'rolloutId' AND operation=p_input->>'operation'
    AND provider=resource_lease.provider AND resource_kind=resource_lease.resource_kind
    AND resource_id=resource_lease.resource_id FOR UPDATE;
  IF mutation.owner_id<>p_input->>'ownerId'
    OR mutation.epoch<>(p_input->>'epoch')::bigint
    OR mutation.permit_id<>p_input->>'permitId'
    OR mutation.receipt_id<>p_input->>'receiptId'
    OR mutation.expected_fingerprint<>p_input#>>'{expected,fingerprint}'
    OR mutation.expected_version IS DISTINCT FROM nullif(p_input#>>'{expected,version}','')
    OR resource_lease.fence_epoch<>mutation.epoch
    OR resource_lease.active_rollout_id<>mutation.rollout_id
    OR resource_lease.active_operation<>mutation.operation
    OR resource_lease.active_permit_id<>mutation.permit_id
    OR NOT release_authority.release_provider_mutation_authority_is_current(mutation)
  THEN RAISE EXCEPTION 'provider mutation execution binding conflict'; END IF;
  IF mutation.state<>'consumed' OR mutation.expires_at<=clock_timestamp()
  THEN RETURN false; END IF;
  UPDATE release_authority.provider_mutation SET state='executing'
  WHERE rollout_id=mutation.rollout_id AND operation=mutation.operation
    AND provider=mutation.provider AND resource_kind=mutation.resource_kind
    AND resource_id=mutation.resource_id;
  UPDATE release_authority.provider_resource_lease SET
    active_state='executing',updated_at=date_trunc('milliseconds',clock_timestamp())
  WHERE provider=mutation.provider AND resource_kind=mutation.resource_kind
    AND resource_id=mutation.resource_id;
  RETURN true;
END $body$;

CREATE FUNCTION release_authority.release_provider_mutation_finish(
  p_input jsonb,p_reconcile boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE mutation release_authority.provider_mutation%ROWTYPE;
DECLARE resource_lease release_authority.provider_resource_lease%ROWTYPE;
DECLARE receipt jsonb:=p_input->'receipt';
DECLARE result text:=CASE WHEN p_reconcile THEN p_input->>'result'
  ELSE 'exact_postcondition' END;
DECLARE terminal_observation jsonb:=p_input->'observation';
DECLARE next_state text;
BEGIN
  SELECT * INTO STRICT resource_lease FROM release_authority.provider_resource_lease
  WHERE provider=receipt#>>'{resource,provider}'
    AND resource_kind=receipt#>>'{resource,kind}'
    AND resource_id=receipt#>>'{resource,id}' FOR UPDATE;
  SELECT * INTO STRICT mutation FROM release_authority.provider_mutation
  WHERE rollout_id=receipt->>'rolloutId' AND operation=receipt->>'operation'
    AND provider=resource_lease.provider AND resource_kind=resource_lease.resource_kind
    AND resource_id=resource_lease.resource_id FOR UPDATE;
  IF mutation.owner_id<>receipt->>'ownerId'
    OR mutation.epoch<>(receipt->>'epoch')::bigint
    OR mutation.permit_id<>receipt->>'permitId'
    OR mutation.receipt_id<>receipt->>'receiptId'
    OR result NOT IN ('exact_postcondition','precondition_drift',
      'execution_not_authorized','ambiguous_forward_repair')
    OR terminal_observation IS NULL OR terminal_observation='null'::jsonb
    OR (
      jsonb_typeof(terminal_observation)<>'object'
      OR jsonb_array_length(jsonb_path_query_array(
        terminal_observation,'$.keyvalue()'))
        <> CASE WHEN terminal_observation ? 'resultIdentity' THEN 4 ELSE 3 END
      OR NOT terminal_observation ?& ARRAY['resource','state','observedAt']
      OR jsonb_typeof(terminal_observation->'resource')<>'object'
      OR jsonb_array_length(jsonb_path_query_array(
        terminal_observation->'resource','$.keyvalue()'))<>3
      OR NOT (terminal_observation->'resource') ?& ARRAY['provider','kind','id']
      OR terminal_observation#>>'{resource,provider}'<>mutation.provider
      OR terminal_observation#>>'{resource,kind}'<>mutation.resource_kind
      OR terminal_observation#>>'{resource,id}'<>mutation.resource_id
      OR jsonb_typeof(terminal_observation->'state')<>'object'
      OR jsonb_array_length(jsonb_path_query_array(
        terminal_observation->'state','$.keyvalue()'))<>2
      OR NOT (terminal_observation->'state') ?& ARRAY['fingerprint','version']
      OR coalesce(terminal_observation#>>'{state,fingerprint}','') !~ '^sha256:[a-f0-9]{64}$'
      OR ((terminal_observation#>'{state,version}') <> 'null'::jsonb
        AND length(terminal_observation#>>'{state,version}') NOT BETWEEN 1 AND 256)
      OR coalesce(terminal_observation->>'observedAt','')
        !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      OR (terminal_observation ? 'resultIdentity' AND (
        jsonb_typeof(terminal_observation->'resultIdentity')<>'object'
        OR NOT (
          ((terminal_observation#>>'{resultIdentity,kind}')='deploy'
            AND mutation.resource_kind='deploy_creation_slot'
            AND jsonb_array_length(jsonb_path_query_array(
              terminal_observation->'resultIdentity','$.keyvalue()'))=2
            AND (terminal_observation->'resultIdentity') ?& ARRAY['kind','id']
            AND length(terminal_observation#>>'{resultIdentity,id}') BETWEEN 1 AND 256)
          OR ((terminal_observation#>>'{resultIdentity,kind}')='job'
            AND mutation.resource_kind='job_creation_intent'
            AND jsonb_array_length(jsonb_path_query_array(
              terminal_observation->'resultIdentity','$.keyvalue()'))=2
            AND (terminal_observation->'resultIdentity') ?& ARRAY['kind','id']
            AND length(terminal_observation#>>'{resultIdentity,id}') BETWEEN 1 AND 256)
          OR ((terminal_observation#>>'{resultIdentity,kind}')='environment'
            AND mutation.resource_kind='service_environment'
            AND jsonb_array_length(jsonb_path_query_array(
              terminal_observation->'resultIdentity','$.keyvalue()'))=3
            AND (terminal_observation->'resultIdentity') ?&
              ARRAY['kind','environmentSha256','environmentKeysSha256']
            AND coalesce(terminal_observation#>>'{resultIdentity,environmentSha256}','')
              ~ '^sha256:[a-f0-9]{64}$'
            AND coalesce(terminal_observation#>>'{resultIdentity,environmentKeysSha256}','')
              ~ '^sha256:[a-f0-9]{64}$'))))
    )
  THEN RAISE EXCEPTION 'provider mutation finish binding conflict'; END IF;

  IF mutation.completed_at IS NOT NULL THEN
    IF mutation.terminal_result<>result
      OR mutation.observation IS DISTINCT FROM terminal_observation
    THEN RAISE EXCEPTION 'provider mutation terminal replay conflict'; END IF;
    RETURN release_authority.release_provider_mutation_outcome(mutation);
  END IF;

  IF resource_lease.fence_epoch<>mutation.epoch
    OR resource_lease.active_rollout_id<>mutation.rollout_id
    OR resource_lease.active_operation<>mutation.operation
    OR resource_lease.active_permit_id<>mutation.permit_id
  THEN RAISE EXCEPTION 'provider mutation resource fence conflict'; END IF;
  IF NOT p_reconcile AND mutation.state<>'executing'
  THEN RAISE EXCEPTION 'provider mutation not executing'; END IF;
  IF p_reconcile AND mutation.state NOT IN ('consumed','executing')
  THEN RAISE EXCEPTION 'provider mutation reconciliation state conflict'; END IF;
  IF p_reconcile AND (
      (mutation.state='executing' AND result<>'ambiguous_forward_repair')
      OR (mutation.state='consumed' AND result NOT IN (
        'precondition_drift','execution_not_authorized'))
      OR (mutation.state='consumed' AND result='precondition_drift'
        AND terminal_observation#>>'{state,fingerprint}'=mutation.expected_fingerprint
        AND terminal_observation#>>'{state,version}' IS NOT DISTINCT FROM mutation.expected_version)
      OR (mutation.state='consumed' AND result='execution_not_authorized'
        AND (terminal_observation#>>'{state,fingerprint}'<>mutation.expected_fingerprint
          OR terminal_observation#>>'{state,version}' IS DISTINCT FROM mutation.expected_version))
    )
  THEN RAISE EXCEPTION 'provider mutation reconciliation decision conflict'; END IF;
  IF result<>'ambiguous_forward_repair'
    AND NOT release_authority.release_provider_mutation_authority_is_current(mutation)
  THEN RAISE EXCEPTION 'provider mutation terminal authority stale'; END IF;

  next_state := CASE result
    WHEN 'exact_postcondition' THEN 'completed'
    WHEN 'precondition_drift' THEN 'precondition_drift'
    WHEN 'execution_not_authorized' THEN 'execution_denied'
    ELSE 'forward_repair' END;
  UPDATE release_authority.provider_mutation SET state=next_state,
    observation=terminal_observation,terminal_result=result,
    completed_at=date_trunc('milliseconds',clock_timestamp())
  WHERE rollout_id=mutation.rollout_id AND operation=mutation.operation
    AND provider=mutation.provider AND resource_kind=mutation.resource_kind
    AND resource_id=mutation.resource_id RETURNING * INTO mutation;

  IF next_state='forward_repair' THEN
    UPDATE release_authority.provider_resource_lease SET
      active_state='forward_repair',
      updated_at=date_trunc('milliseconds',clock_timestamp())
    WHERE provider=mutation.provider AND resource_kind=mutation.resource_kind
      AND resource_id=mutation.resource_id;
  ELSE
    UPDATE release_authority.provider_resource_lease SET
      active_rollout_id=NULL,active_operation=NULL,active_permit_id=NULL,
      active_state=NULL,updated_at=date_trunc('milliseconds',clock_timestamp())
    WHERE provider=mutation.provider AND resource_kind=mutation.resource_kind
      AND resource_id=mutation.resource_id;
  END IF;
  RETURN release_authority.release_provider_mutation_outcome(mutation);
END $body$;

CREATE FUNCTION release_authority.release_provider_mutation_complete(p_input jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $body$
  SELECT release_authority.release_provider_mutation_finish(p_input,false)
$body$;
CREATE FUNCTION release_authority.release_provider_mutation_reconcile(p_input jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $body$
  SELECT release_authority.release_provider_mutation_finish(p_input,true)
$body$;

REVOKE ALL ON TABLE release_authority.provider_resource_lease FROM PUBLIC;
REVOKE ALL ON TABLE release_authority.provider_mutation FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_permit(
  release_authority.provider_mutation) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_receipt(
  release_authority.provider_mutation) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_outcome(
  release_authority.provider_mutation) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_authority_is_current(
  release_authority.provider_mutation) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_issue(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_recover(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_consume(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_validate_execution(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_finish(jsonb,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_complete(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_reconcile(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_effect_observation_is_valid(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_effect_validate_execution(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_effect_reconcile(jsonb) FROM PUBLIC;

DO $acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname='reviewrouter_release_control') THEN
    GRANT EXECUTE ON FUNCTION release_authority.release_recovery_effect_validate_execution(jsonb)
      TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_recovery_effect_reconcile(jsonb)
      TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_provider_mutation_issue(jsonb)
      TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_provider_mutation_recover(jsonb)
      TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_provider_mutation_consume(jsonb)
      TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_provider_mutation_validate_execution(jsonb)
      TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_provider_mutation_complete(jsonb)
      TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_provider_mutation_reconcile(jsonb)
      TO reviewrouter_release_control;
  END IF;
END
$acl$;

COMMIT;
