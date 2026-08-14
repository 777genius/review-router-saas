-- Single authority protocol for every pre-activation recovery effect. Claims
-- are leases; permits become single-use only when consumed immediately before
-- I/O. All routines lock rollout first, matching late runner-job persistence.
BEGIN;

CREATE FUNCTION release_authority.release_recovery_effect_observation_is_valid(
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

ALTER TABLE release_authority.rollout
  ADD COLUMN recovery_forward_only boolean NOT NULL DEFAULT false;

CREATE TABLE release_authority.recovery_effect (
  rollout_id text NOT NULL REFERENCES release_authority.rollout(rollout_id) ON DELETE RESTRICT,
  effect_key text NOT NULL CHECK (effect_key ~ '^[a-z][a-z0-9_]*(?::[A-Za-z0-9._-]+)?$'),
  kind text NOT NULL CHECK (kind IN (
    'restore_service_config','restore_service_environment','restore_service_deploy',
    'restore_database_writes','resume_source_service')),
  service_id text,
  state text NOT NULL DEFAULT 'intended' CHECK (state IN (
    'intended','claimed','consumed','executing','completed','forward_repair')),
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  claim_owner_id text,
  permit_token text CHECK (permit_token ~ '^[a-f0-9]{64}$'),
  lease_expires_at timestamptz(3),
  consumed_at timestamptz(3),
  execution_receipt_sha256 text CHECK (execution_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  completed_at timestamptz(3),
  observation jsonb,
  intended_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  PRIMARY KEY (rollout_id,effect_key),
  CHECK ((kind IN ('restore_database_writes')) = (service_id IS NULL)),
  CHECK ((state = 'claimed') = (lease_expires_at IS NOT NULL)),
  CHECK ((state = 'intended') = (claim_owner_id IS NULL AND permit_token IS NULL)),
  CHECK ((state IN ('consumed','executing','completed','forward_repair')) = (consumed_at IS NOT NULL)),
  CHECK ((state IN ('consumed','executing','completed','forward_repair')) =
    (execution_receipt_sha256 IS NOT NULL)),
  CHECK ((completed_at IS NULL) = (observation IS NULL)),
  CHECK (observation IS NULL OR
    release_authority.release_recovery_effect_observation_is_valid(kind,observation)),
  CHECK (observation IS NULL OR NOT (observation ? 'serviceId')
    OR observation->>'serviceId'=service_id),
  CHECK (state <> 'completed' OR completed_at IS NOT NULL),
  CHECK (state IN ('completed','forward_repair') OR completed_at IS NULL)
);

CREATE FUNCTION release_authority.release_recovery_effect_snapshot(
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

CREATE FUNCTION release_authority.release_recovery_effect_intend(p_input jsonb)
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

CREATE FUNCTION release_authority.release_recovery_effect_claim(p_input jsonb)
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

CREATE FUNCTION release_authority.release_recovery_effect_consume(p_input jsonb)
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
CREATE FUNCTION release_authority.release_recovery_effect_validate_execution(p_input jsonb)
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

CREATE FUNCTION release_authority.release_recovery_effect_complete(p_input jsonb)
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
CREATE FUNCTION release_authority.release_recovery_effect_reconcile(p_input jsonb)
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
CREATE FUNCTION release_authority.release_late_job_recovery_effect_gate() RETURNS trigger
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
CREATE TRIGGER release_late_job_recovery_effect_gate_trigger
AFTER INSERT ON release_authority.runner_job
FOR EACH ROW EXECUTE FUNCTION release_authority.release_late_job_recovery_effect_gate();

-- Old checkpoints are observations only. They can no longer authorize their
-- own effects; a completed permit-bound effect must precede each completion.
CREATE FUNCTION release_authority.release_recovery_checkpoint_permit_gate() RETURNS trigger
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
CREATE TRIGGER release_recovery_checkpoint_permit_gate_trigger
BEFORE INSERT ON release_authority.service_transition_checkpoint
FOR EACH ROW EXECUTE FUNCTION release_authority.release_recovery_checkpoint_permit_gate();

-- Provider-neutral one-shot mutation authority. Render has no conditional
-- write primitive, so this is an authority lease plus pre/post witness, not a
-- claim of provider-native CAS.
CREATE TABLE release_authority.provider_mutation (
  rollout_id text NOT NULL REFERENCES release_authority.rollout(rollout_id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 256),
  provider text NOT NULL CHECK (provider ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  resource_kind text NOT NULL CHECK (resource_kind ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 256),
  expected_fingerprint text NOT NULL CHECK (expected_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  expected_version text,
  state text NOT NULL CHECK (state IN ('claimed','consumed','executing','completed','precondition_drift','execution_denied','forward_repair')),
  owner_id text NOT NULL CHECK (owner_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  epoch bigint NOT NULL CHECK (epoch > 0),
  permit_id text NOT NULL CHECK (permit_id ~ '^[a-f0-9]{64}$'),
  permit_token text NOT NULL CHECK (permit_token ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  consumed_at timestamptz(3),
  receipt_sha256 text CHECK (receipt_sha256 ~ '^[a-f0-9]{64}$'),
  observation jsonb,
  completed_at timestamptz(3),
  PRIMARY KEY (rollout_id,operation,provider,resource_kind,resource_id),
  CHECK ((state='claimed')=(consumed_at IS NULL)),
  CHECK ((state='claimed')=(receipt_sha256 IS NULL)),
  CHECK ((state IN ('completed','precondition_drift','execution_denied','forward_repair'))=(completed_at IS NOT NULL))
);

CREATE FUNCTION release_authority.release_provider_mutation_permit(
  p_row release_authority.provider_mutation
) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $body$
  SELECT jsonb_build_object(
    'rolloutId',p_row.rollout_id,'operation',p_row.operation,
    'resource',jsonb_build_object('provider',p_row.provider,'kind',p_row.resource_kind,'id',p_row.resource_id),
    'ownerId',p_row.owner_id,'epoch',p_row.epoch,'permitId',p_row.permit_id,
    'token',p_row.permit_token,
    'expected',jsonb_build_object('fingerprint',p_row.expected_fingerprint,'version',p_row.expected_version),
    'issuedAt',to_char(p_row.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt',to_char(p_row.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'singleUse',true)
$body$;

CREATE FUNCTION release_authority.release_provider_mutation_issue(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE mutation release_authority.provider_mutation%ROWTYPE;
DECLARE seconds integer;
BEGIN
  IF jsonb_typeof(p_input)<>'object' OR jsonb_array_length(jsonb_path_query_array(p_input,'$.keyvalue()'))<>6
    OR NOT p_input ?& ARRAY['rolloutId','operation','resource','ownerId','expected','leaseSeconds']
    OR length(p_input->>'rolloutId') NOT BETWEEN 1 AND 256
    OR length(p_input->>'operation') NOT BETWEEN 1 AND 256
    OR coalesce(p_input->>'ownerId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
    OR jsonb_typeof(p_input->'resource')<>'object'
    OR jsonb_array_length(jsonb_path_query_array(p_input->'resource','$.keyvalue()'))<>3
    OR NOT (p_input->'resource') ?& ARRAY['provider','kind','id']
    OR coalesce(p_input#>>'{resource,provider}','') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    OR coalesce(p_input#>>'{resource,kind}','') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    OR length(p_input#>>'{resource,id}') NOT BETWEEN 1 AND 256
    OR jsonb_typeof(p_input->'expected')<>'object'
    OR jsonb_array_length(jsonb_path_query_array(p_input->'expected','$.keyvalue()'))<>2
    OR NOT (p_input->'expected') ?& ARRAY['fingerprint','version']
    OR coalesce(p_input#>>'{expected,fingerprint}','') !~ '^sha256:[a-f0-9]{64}$'
    OR ((p_input#>'{expected,version}') <> 'null'::jsonb AND length(p_input#>>'{expected,version}') NOT BETWEEN 1 AND 256)
    OR coalesce(p_input->>'leaseSeconds','') !~ '^[0-9]+$'
    OR (p_input->>'leaseSeconds')::numeric NOT BETWEEN 5 AND 300
  THEN RAISE EXCEPTION 'provider mutation issue invalid'; END IF;
  seconds := (p_input->>'leaseSeconds')::integer;
  PERFORM 1 FROM release_authority.rollout WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'provider mutation rollout missing'; END IF;
  SELECT * INTO mutation FROM release_authority.provider_mutation WHERE
    rollout_id=p_input->>'rolloutId' AND operation=p_input->>'operation'
    AND provider=p_input#>>'{resource,provider}' AND resource_kind=p_input#>>'{resource,kind}'
    AND resource_id=p_input#>>'{resource,id}' FOR UPDATE;
  IF FOUND THEN
    IF mutation.expected_fingerprint<>p_input#>>'{expected,fingerprint}'
      OR mutation.expected_version IS DISTINCT FROM nullif(p_input#>>'{expected,version}','')
    THEN RAISE EXCEPTION 'provider mutation expected state conflict'; END IF;
    IF mutation.state<>'claimed' THEN RAISE EXCEPTION 'provider mutation permit already consumed'; END IF;
    IF mutation.expires_at>clock_timestamp() THEN
      IF mutation.owner_id<>p_input->>'ownerId' THEN RAISE EXCEPTION 'provider mutation lease held'; END IF;
      RETURN release_authority.release_provider_mutation_permit(mutation);
    END IF;
    UPDATE release_authority.provider_mutation SET owner_id=p_input->>'ownerId',epoch=epoch+1,
      permit_id=replace(pg_catalog.gen_random_uuid()::text,'-','')||
        replace(pg_catalog.gen_random_uuid()::text,'-',''),
      permit_token=replace(pg_catalog.gen_random_uuid()::text,'-','')||replace(pg_catalog.gen_random_uuid()::text,'-',''),
      issued_at=date_trunc('milliseconds',clock_timestamp()),
      expires_at=date_trunc('milliseconds',clock_timestamp()+make_interval(secs=>seconds))
    WHERE rollout_id=mutation.rollout_id AND operation=mutation.operation AND provider=mutation.provider
      AND resource_kind=mutation.resource_kind AND resource_id=mutation.resource_id RETURNING * INTO mutation;
    RETURN release_authority.release_provider_mutation_permit(mutation);
  END IF;
  INSERT INTO release_authority.provider_mutation(
    rollout_id,operation,provider,resource_kind,resource_id,expected_fingerprint,expected_version,
    state,owner_id,epoch,permit_id,permit_token,issued_at,expires_at)
  VALUES (p_input->>'rolloutId',p_input->>'operation',p_input#>>'{resource,provider}',
    p_input#>>'{resource,kind}',p_input#>>'{resource,id}',p_input#>>'{expected,fingerprint}',
    nullif(p_input#>>'{expected,version}',''),'claimed',p_input->>'ownerId',1,
    replace(pg_catalog.gen_random_uuid()::text,'-','')||
      replace(pg_catalog.gen_random_uuid()::text,'-',''),
    replace(pg_catalog.gen_random_uuid()::text,'-','')||
      replace(pg_catalog.gen_random_uuid()::text,'-',''),
    date_trunc('milliseconds',clock_timestamp()),
    date_trunc('milliseconds',clock_timestamp()+make_interval(secs=>seconds))) RETURNING * INTO mutation;
  RETURN release_authority.release_provider_mutation_permit(mutation);
END $body$;

CREATE FUNCTION release_authority.release_provider_mutation_consume(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE mutation release_authority.provider_mutation%ROWTYPE; DECLARE receipt text;
BEGIN
  SELECT * INTO STRICT mutation FROM release_authority.provider_mutation WHERE
    rollout_id=p_input->>'rolloutId' AND operation=p_input->>'operation'
    AND provider=p_input#>>'{resource,provider}' AND resource_kind=p_input#>>'{resource,kind}'
    AND resource_id=p_input#>>'{resource,id}' FOR UPDATE;
  IF mutation.state<>'claimed' OR mutation.expires_at<=clock_timestamp()
    OR mutation.owner_id<>p_input->>'ownerId' OR mutation.epoch<>(p_input->>'epoch')::bigint
    OR mutation.permit_id<>p_input->>'permitId' OR mutation.permit_token<>p_input->>'token'
    OR mutation.expected_fingerprint<>p_input#>>'{expected,fingerprint}'
    OR mutation.expected_version IS DISTINCT FROM nullif(p_input#>>'{expected,version}','')
  THEN RAISE EXCEPTION 'provider mutation permit denied or replayed'; END IF;
  receipt:=replace(pg_catalog.gen_random_uuid()::text,'-','')||
    replace(pg_catalog.gen_random_uuid()::text,'-','');
  UPDATE release_authority.provider_mutation SET state='consumed',
    consumed_at=date_trunc('milliseconds',clock_timestamp()),receipt_sha256=encode(sha256(convert_to(receipt,'UTF8')),'hex')
  WHERE rollout_id=mutation.rollout_id AND operation=mutation.operation AND provider=mutation.provider
    AND resource_kind=mutation.resource_kind AND resource_id=mutation.resource_id RETURNING * INTO mutation;
  RETURN jsonb_build_object('rolloutId',mutation.rollout_id,'operation',mutation.operation,
    'resource',jsonb_build_object('provider',mutation.provider,'kind',mutation.resource_kind,'id',mutation.resource_id),
    'ownerId',mutation.owner_id,'epoch',mutation.epoch,'permitId',mutation.permit_id,'receiptId',receipt,
    'expected',jsonb_build_object('fingerprint',mutation.expected_fingerprint,'version',mutation.expected_version),
    'consumedAt',to_char(mutation.consumed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $body$;

CREATE FUNCTION release_authority.release_provider_mutation_validate_execution(p_input jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE mutation release_authority.provider_mutation%ROWTYPE;
BEGIN
  SELECT * INTO STRICT mutation FROM release_authority.provider_mutation WHERE
    rollout_id=p_input->>'rolloutId' AND operation=p_input->>'operation'
    AND provider=p_input#>>'{resource,provider}' AND resource_kind=p_input#>>'{resource,kind}'
    AND resource_id=p_input#>>'{resource,id}' FOR UPDATE;
  IF mutation.owner_id<>p_input->>'ownerId' OR mutation.epoch<>(p_input->>'epoch')::bigint
    OR mutation.permit_id<>p_input->>'permitId'
    OR mutation.receipt_sha256<>encode(sha256(convert_to(p_input->>'receiptId','UTF8')),'hex')
    OR mutation.expected_fingerprint<>p_input#>>'{expected,fingerprint}'
    OR mutation.expected_version IS DISTINCT FROM nullif(p_input#>>'{expected,version}','')
  THEN RAISE EXCEPTION 'provider mutation execution binding conflict'; END IF;
  IF mutation.state<>'consumed' OR mutation.expires_at<=clock_timestamp() THEN RETURN false; END IF;
  UPDATE release_authority.provider_mutation SET state='executing' WHERE
    rollout_id=mutation.rollout_id AND operation=mutation.operation AND provider=mutation.provider
    AND resource_kind=mutation.resource_kind AND resource_id=mutation.resource_id;
  RETURN true;
END $body$;

CREATE FUNCTION release_authority.release_provider_mutation_finish(p_input jsonb,p_reconcile boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE mutation release_authority.provider_mutation%ROWTYPE; DECLARE receipt jsonb:=p_input->'receipt';
DECLARE result text:=CASE WHEN p_reconcile THEN p_input->>'result' ELSE 'exact_postcondition' END;
DECLARE observation jsonb:=p_input->'observation';
BEGIN
  SELECT * INTO STRICT mutation FROM release_authority.provider_mutation WHERE
    rollout_id=receipt->>'rolloutId' AND operation=receipt->>'operation'
    AND provider=receipt#>>'{resource,provider}' AND resource_kind=receipt#>>'{resource,kind}'
    AND resource_id=receipt#>>'{resource,id}' FOR UPDATE;
  IF mutation.owner_id<>receipt->>'ownerId' OR mutation.epoch<>(receipt->>'epoch')::bigint
    OR mutation.permit_id<>receipt->>'permitId'
    OR mutation.receipt_sha256<>encode(sha256(convert_to(receipt->>'receiptId','UTF8')),'hex')
    OR result NOT IN ('exact_postcondition','precondition_drift','execution_not_authorized','ambiguous_forward_repair')
    OR (observation IS NOT NULL AND (observation#>>'{resource,provider}'<>mutation.provider
      OR observation#>>'{resource,kind}'<>mutation.resource_kind OR observation#>>'{resource,id}'<>mutation.resource_id
      OR coalesce(observation#>>'{state,fingerprint}','') !~ '^sha256:[a-f0-9]{64}$'))
  THEN RAISE EXCEPTION 'provider mutation finish binding conflict'; END IF;
  IF mutation.state NOT IN ('consumed','executing') THEN RAISE EXCEPTION 'provider mutation finish replayed'; END IF;
  IF NOT p_reconcile AND mutation.state<>'executing' THEN RAISE EXCEPTION 'provider mutation not executing'; END IF;
  UPDATE release_authority.provider_mutation SET
    state=CASE result WHEN 'exact_postcondition' THEN 'completed' WHEN 'precondition_drift' THEN 'precondition_drift' WHEN 'execution_not_authorized' THEN 'execution_denied' ELSE 'forward_repair' END,
    observation=observation,completed_at=date_trunc('milliseconds',clock_timestamp())
  WHERE rollout_id=mutation.rollout_id AND operation=mutation.operation AND provider=mutation.provider
    AND resource_kind=mutation.resource_kind AND resource_id=mutation.resource_id;
  IF result='ambiguous_forward_repair' THEN
    UPDATE release_authority.rollout SET state='forward_repair_required',updated_at=clock_timestamp()
      WHERE rollout_id=mutation.rollout_id AND state<>'forward_repair_required';
  END IF;
  RETURN true;
END $body$;
CREATE FUNCTION release_authority.release_provider_mutation_complete(p_input jsonb)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $body$
  SELECT release_authority.release_provider_mutation_finish(p_input,false)
$body$;
CREATE FUNCTION release_authority.release_provider_mutation_reconcile(p_input jsonb)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $body$
  SELECT release_authority.release_provider_mutation_finish(p_input,true)
$body$;

REVOKE ALL ON TABLE release_authority.provider_mutation FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_permit(release_authority.provider_mutation) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_issue(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_consume(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_validate_execution(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_finish(jsonb,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_complete(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_mutation_reconcile(jsonb) FROM PUBLIC;
REVOKE ALL ON TABLE release_authority.recovery_effect FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_effect_observation_is_valid(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_effect_snapshot(release_authority.recovery_effect) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_effect_intend(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_effect_claim(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_effect_consume(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_effect_validate_execution(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_effect_complete(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_effect_reconcile(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_late_job_recovery_effect_gate() FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_checkpoint_permit_gate() FROM PUBLIC;

DO $acl$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='reviewrouter_release_control') THEN
    GRANT EXECUTE ON FUNCTION release_authority.release_recovery_effect_intend(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_recovery_effect_claim(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_recovery_effect_consume(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_recovery_effect_validate_execution(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_recovery_effect_complete(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_recovery_effect_reconcile(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_provider_mutation_issue(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_provider_mutation_consume(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_provider_mutation_validate_execution(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_provider_mutation_complete(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_provider_mutation_reconcile(jsonb) TO reviewrouter_release_control;
  END IF;
END $acl$;

COMMIT;
