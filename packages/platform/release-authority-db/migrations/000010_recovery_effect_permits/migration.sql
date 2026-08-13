-- Single authority protocol for every pre-activation recovery effect. Claims
-- are leases; permits become single-use only when consumed immediately before
-- I/O. All routines lock rollout first, matching late runner-job persistence.
BEGIN;

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
    'intended','claimed','consumed','completed','forward_repair')),
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  claim_owner_id text,
  permit_token text CHECK (permit_token ~ '^[a-f0-9]{64}$'),
  lease_expires_at timestamptz(3),
  consumed_at timestamptz(3),
  completed_at timestamptz(3),
  observation jsonb,
  intended_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  PRIMARY KEY (rollout_id,effect_key),
  CHECK ((kind IN ('restore_database_writes')) = (service_id IS NULL)),
  CHECK ((state = 'claimed') = (lease_expires_at IS NOT NULL)),
  CHECK ((state = 'intended') = (claim_owner_id IS NULL AND permit_token IS NULL)),
  CHECK ((state IN ('consumed','completed','forward_repair')) = (consumed_at IS NOT NULL)),
  CHECK ((completed_at IS NULL) = (observation IS NULL)),
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
  lease_seconds := (p_input->>'leaseSeconds')::integer;
  IF coalesce(p_input->>'ownerId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
    OR lease_seconds NOT BETWEEN 5 AND 300
  THEN RAISE EXCEPTION 'release recovery effect claim invalid'; END IF;
  SELECT * INTO STRICT rollout_row FROM release_authority.rollout
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  SELECT * INTO STRICT effect_row FROM release_authority.recovery_effect
    WHERE rollout_id=rollout_row.rollout_id AND effect_key=p_input->>'effectKey' FOR UPDATE;
  IF effect_row.state IN ('consumed','completed','forward_repair')
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
BEGIN
  SELECT * INTO STRICT rollout_row FROM release_authority.rollout
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  SELECT * INTO STRICT effect_row FROM release_authority.recovery_effect
    WHERE rollout_id=rollout_row.rollout_id AND effect_key=p_input->>'effectKey' FOR UPDATE;
  IF effect_row.state IN ('consumed','completed','forward_repair') THEN
    IF effect_row.epoch=(p_input->>'epoch')::bigint
      AND effect_row.permit_token=p_input->>'permitToken'
      AND effect_row.claim_owner_id=p_input->>'ownerId'
    THEN RETURN release_authority.release_recovery_effect_snapshot(effect_row); END IF;
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
  UPDATE release_authority.recovery_effect SET state='consumed',lease_expires_at=NULL,
    consumed_at=date_trunc('milliseconds',clock_timestamp())
  WHERE rollout_id=effect_row.rollout_id AND effect_key=effect_row.effect_key
  RETURNING * INTO effect_row;
  RETURN release_authority.release_recovery_effect_snapshot(effect_row);
END $body$;

CREATE FUNCTION release_authority.release_recovery_effect_complete(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE rollout_row release_authority.rollout%ROWTYPE;
DECLARE effect_row release_authority.recovery_effect%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_input->'observation') <> 'object'
    OR p_input->'observation' = '{}'::jsonb
  THEN RAISE EXCEPTION 'release recovery effect observation invalid'; END IF;
  SELECT * INTO STRICT rollout_row FROM release_authority.rollout
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  SELECT * INTO STRICT effect_row FROM release_authority.recovery_effect
    WHERE rollout_id=rollout_row.rollout_id AND effect_key=p_input->>'effectKey' FOR UPDATE;
  IF effect_row.epoch <> (p_input->>'epoch')::bigint
    OR effect_row.permit_token <> p_input->>'permitToken'
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
  IF effect_row.state <> 'consumed'
    THEN RAISE EXCEPTION 'release recovery effect was not consumed'; END IF;
  UPDATE release_authority.recovery_effect SET state='completed',
    completed_at=date_trunc('milliseconds',clock_timestamp()),observation=p_input->'observation'
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
      WHERE rollout_id=NEW.rollout_id AND state IN ('consumed','completed','forward_repair')) THEN
    UPDATE release_authority.rollout SET recovery_forward_only=true,updated_at=clock_timestamp()
      WHERE rollout_id=NEW.rollout_id;
    UPDATE release_authority.recovery_effect SET state='forward_repair'
      WHERE rollout_id=NEW.rollout_id AND state IN ('consumed','completed');
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

REVOKE ALL ON TABLE release_authority.recovery_effect FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_effect_snapshot(release_authority.recovery_effect) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_effect_intend(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_effect_claim(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_effect_consume(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_effect_complete(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_late_job_recovery_effect_gate() FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_recovery_checkpoint_permit_gate() FROM PUBLIC;

DO $acl$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='reviewrouter_release_control') THEN
    GRANT EXECUTE ON FUNCTION release_authority.release_recovery_effect_intend(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_recovery_effect_claim(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_recovery_effect_consume(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_recovery_effect_complete(jsonb) TO reviewrouter_release_control;
  END IF;
END $acl$;

COMMIT;
