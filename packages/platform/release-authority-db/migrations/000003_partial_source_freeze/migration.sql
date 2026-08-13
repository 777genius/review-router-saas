-- Durable, authority-owned evidence for provider mutations that can occur before
-- the aggregate freeze receipt is appended.
BEGIN;

CREATE TABLE release_authority.source_freeze_observation (
  observation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rollout_id text NOT NULL REFERENCES release_authority.rollout(rollout_id) ON DELETE RESTRICT,
  service_id text NOT NULL CHECK (service_id ~ '^srv-[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  phase text NOT NULL CHECK (phase IN ('intent','unchanged','suspended')),
  latest_successful_deploy_id text NOT NULL,
  observed_at timestamptz(3) NOT NULL,
  declared_service_ids jsonb NOT NULL,
  recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (rollout_id, service_id, phase),
  CHECK (jsonb_typeof(declared_service_ids) = 'array' AND jsonb_array_length(declared_service_ids) BETWEEN 1 AND 100)
);
REVOKE ALL ON release_authority.source_freeze_observation FROM PUBLIC;
CREATE TABLE release_authority.source_freeze_completion (
  rollout_id text PRIMARY KEY REFERENCES release_authority.rollout(rollout_id) ON DELETE RESTRICT,
  declared_service_ids jsonb NOT NULL,
  observed_at timestamptz(3) NOT NULL,
  recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(declared_service_ids)='array' AND jsonb_array_length(declared_service_ids) BETWEEN 1 AND 100)
);
REVOKE ALL ON release_authority.source_freeze_completion FROM PUBLIC;

CREATE FUNCTION release_authority.release_source_freeze_inventory_canonical(
  p_inventory jsonb
) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $body$
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb)
  FROM jsonb_array_elements_text(p_inventory) inventory(value)
$body$;
REVOKE ALL ON FUNCTION release_authority.release_source_freeze_inventory_canonical(jsonb) FROM PUBLIC;

CREATE FUNCTION release_authority.release_source_freeze_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  RAISE EXCEPTION 'release source freeze observations are immutable';
END $body$;
REVOKE ALL ON FUNCTION release_authority.release_source_freeze_immutable() FROM PUBLIC;
CREATE TRIGGER release_source_freeze_immutable_guard
BEFORE UPDATE OR DELETE ON release_authority.source_freeze_observation
FOR EACH ROW EXECUTE FUNCTION release_authority.release_source_freeze_immutable();
CREATE TRIGGER release_source_freeze_completion_immutable_guard
BEFORE UPDATE OR DELETE ON release_authority.source_freeze_completion
FOR EACH ROW EXECUTE FUNCTION release_authority.release_source_freeze_immutable();

CREATE FUNCTION release_authority.release_source_freeze_record(
  p_rollout_id text, p_expected_commit_sha text, p_run_id text, p_run_attempt integer,
  p_source_system_identifier text, p_target_system_identifier text,
  p_service_id text, p_latest_successful_deploy_id text, p_observed_at timestamptz,
  p_declared_service_ids jsonb
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE current_row release_authority.rollout%ROWTYPE;
DECLARE existing release_authority.source_freeze_observation%ROWTYPE;
DECLARE distinct_count integer;
BEGIN
  SELECT * INTO STRICT current_row FROM release_authority.rollout
    WHERE rollout_id = p_rollout_id FOR UPDATE;
  IF current_row.expected_commit_sha <> p_expected_commit_sha
    OR current_row.run_id <> p_run_id OR current_row.run_attempt <> p_run_attempt
    OR current_row.source_system_identifier <> p_source_system_identifier
    OR current_row.target_system_identifier <> p_target_system_identifier
    OR current_row.state <> 'pre_activation' OR current_row.activation_boundary <> 'before'
  THEN RAISE EXCEPTION 'release source freeze binding invalid'; END IF;
  IF p_service_id !~ '^srv-[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
    OR coalesce(p_latest_successful_deploy_id,'') = ''
    OR p_observed_at IS NULL OR p_observed_at > clock_timestamp() + interval '1 minute'
    OR jsonb_typeof(p_declared_service_ids) <> 'array'
    OR jsonb_array_length(p_declared_service_ids) NOT BETWEEN 1 AND 100
    OR NOT p_declared_service_ids ? p_service_id
  THEN RAISE EXCEPTION 'release source freeze observation invalid'; END IF;
  SELECT count(DISTINCT value)::integer INTO distinct_count
    FROM jsonb_array_elements_text(p_declared_service_ids);
  IF distinct_count <> jsonb_array_length(p_declared_service_ids)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_declared_service_ids) value
      WHERE value !~ '^srv-[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
  THEN RAISE EXCEPTION 'release source freeze inventory invalid'; END IF;
  SELECT * INTO existing FROM release_authority.source_freeze_observation
    WHERE rollout_id = p_rollout_id AND service_id = p_service_id AND phase = 'suspended';
  IF FOUND THEN
    IF existing.latest_successful_deploy_id <> p_latest_successful_deploy_id
      OR release_authority.release_source_freeze_inventory_canonical(
        existing.declared_service_ids
      ) <> release_authority.release_source_freeze_inventory_canonical(
        p_declared_service_ids
      )
    THEN RAISE EXCEPTION 'release source freeze replay conflict'; END IF;
    RETURN 'existing';
  END IF;
  IF EXISTS (SELECT 1 FROM release_authority.source_freeze_observation
      WHERE rollout_id = p_rollout_id AND
        release_authority.release_source_freeze_inventory_canonical(
          declared_service_ids
        ) <> release_authority.release_source_freeze_inventory_canonical(
          p_declared_service_ids
        ))
  THEN RAISE EXCEPTION 'release source freeze inventory conflict'; END IF;
  IF NOT EXISTS (SELECT 1 FROM release_authority.source_freeze_observation
      WHERE rollout_id = p_rollout_id AND service_id = p_service_id AND phase = 'intent')
  THEN RAISE EXCEPTION 'release source freeze intent missing'; END IF;
  INSERT INTO release_authority.source_freeze_observation(
    rollout_id,service_id,phase,latest_successful_deploy_id,observed_at,declared_service_ids)
  VALUES (p_rollout_id,p_service_id,'suspended',p_latest_successful_deploy_id,
    date_trunc('milliseconds',p_observed_at),p_declared_service_ids);
  RETURN 'recorded';
END $body$;
REVOKE ALL ON FUNCTION release_authority.release_source_freeze_record(text,text,text,integer,text,text,text,text,timestamptz,jsonb) FROM PUBLIC;

CREATE FUNCTION release_authority.release_source_freeze_prepare(
  p_rollout_id text, p_expected_commit_sha text, p_run_id text, p_run_attempt integer,
  p_source_system_identifier text, p_target_system_identifier text,
  p_service_id text, p_latest_successful_deploy_id text, p_observed_at timestamptz,
  p_declared_service_ids jsonb, p_before_suspended boolean
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE current_row release_authority.rollout%ROWTYPE;
DECLARE existing release_authority.source_freeze_observation%ROWTYPE;
DECLARE intended boolean;
DECLARE distinct_count integer;
BEGIN
  SELECT * INTO STRICT current_row FROM release_authority.rollout
    WHERE rollout_id = p_rollout_id FOR UPDATE;
  IF current_row.expected_commit_sha <> p_expected_commit_sha
    OR current_row.run_id <> p_run_id OR current_row.run_attempt <> p_run_attempt
    OR current_row.source_system_identifier <> p_source_system_identifier
    OR current_row.target_system_identifier <> p_target_system_identifier
    OR current_row.state <> 'pre_activation' OR current_row.activation_boundary <> 'before'
    OR p_before_suspended IS NULL
    OR p_service_id !~ '^srv-[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
    OR coalesce(p_latest_successful_deploy_id,'') = ''
    OR p_observed_at IS NULL OR p_observed_at > clock_timestamp() + interval '1 minute'
    OR jsonb_typeof(p_declared_service_ids) <> 'array'
    OR jsonb_array_length(p_declared_service_ids) NOT BETWEEN 1 AND 100
    OR NOT p_declared_service_ids ? p_service_id
  THEN RAISE EXCEPTION 'release source freeze preparation invalid'; END IF;
  SELECT count(DISTINCT value)::integer INTO distinct_count FROM jsonb_array_elements_text(p_declared_service_ids);
  IF distinct_count<>jsonb_array_length(p_declared_service_ids)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_declared_service_ids) value
      WHERE value !~ '^srv-[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
  THEN RAISE EXCEPTION 'release source freeze inventory invalid'; END IF;
  IF EXISTS (SELECT 1 FROM release_authority.source_freeze_observation
      WHERE rollout_id=p_rollout_id AND
        release_authority.release_source_freeze_inventory_canonical(
          declared_service_ids
        ) <> release_authority.release_source_freeze_inventory_canonical(
          p_declared_service_ids
        ))
  THEN RAISE EXCEPTION 'release source freeze inventory conflict'; END IF;
  SELECT * INTO existing FROM release_authority.source_freeze_observation
    WHERE rollout_id=p_rollout_id AND service_id=p_service_id AND phase IN ('intent','unchanged')
    ORDER BY observation_id LIMIT 1;
  IF FOUND THEN
    IF existing.latest_successful_deploy_id<>p_latest_successful_deploy_id
      OR release_authority.release_source_freeze_inventory_canonical(
        existing.declared_service_ids
      ) <> release_authority.release_source_freeze_inventory_canonical(
        p_declared_service_ids
      )
    THEN RAISE EXCEPTION 'release source freeze replay conflict'; END IF;
    RETURN existing.phase='intent';
  END IF;
  intended := NOT p_before_suspended;
  INSERT INTO release_authority.source_freeze_observation(
    rollout_id,service_id,phase,latest_successful_deploy_id,observed_at,declared_service_ids)
  VALUES (p_rollout_id,p_service_id,CASE WHEN intended THEN 'intent' ELSE 'unchanged' END,
    p_latest_successful_deploy_id,date_trunc('milliseconds',p_observed_at),p_declared_service_ids);
  RETURN intended;
END $body$;
REVOKE ALL ON FUNCTION release_authority.release_source_freeze_prepare(text,text,text,integer,text,text,text,text,timestamptz,jsonb,boolean) FROM PUBLIC;

CREATE FUNCTION release_authority.release_source_freeze_complete(
  p_rollout_id text, p_expected_commit_sha text, p_run_id text, p_run_attempt integer,
  p_source_system_identifier text, p_target_system_identifier text,
  p_declared_service_ids jsonb, p_observed_at timestamptz
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE current_row release_authority.rollout%ROWTYPE;
DECLARE existing release_authority.source_freeze_completion%ROWTYPE;
DECLARE distinct_count integer;
BEGIN
  SELECT * INTO STRICT current_row FROM release_authority.rollout WHERE rollout_id=p_rollout_id FOR UPDATE;
  IF current_row.expected_commit_sha<>p_expected_commit_sha OR current_row.run_id<>p_run_id
    OR current_row.run_attempt<>p_run_attempt OR current_row.source_system_identifier<>p_source_system_identifier
    OR current_row.target_system_identifier<>p_target_system_identifier OR current_row.state<>'pre_activation'
    OR current_row.activation_boundary<>'before' OR p_observed_at IS NULL
    OR p_observed_at>clock_timestamp()+interval '1 minute'
    OR jsonb_typeof(p_declared_service_ids)<>'array'
    OR jsonb_array_length(p_declared_service_ids) NOT BETWEEN 1 AND 100
  THEN RAISE EXCEPTION 'release source freeze completion binding invalid'; END IF;
  SELECT count(DISTINCT value)::integer INTO distinct_count FROM jsonb_array_elements_text(p_declared_service_ids);
  IF distinct_count<>jsonb_array_length(p_declared_service_ids)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_declared_service_ids) value
      WHERE value !~ '^srv-[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
  THEN RAISE EXCEPTION 'release source freeze completion inventory invalid'; END IF;
  SELECT * INTO existing FROM release_authority.source_freeze_completion WHERE rollout_id=p_rollout_id;
  IF FOUND THEN
    IF release_authority.release_source_freeze_inventory_canonical(
        existing.declared_service_ids
      ) <> release_authority.release_source_freeze_inventory_canonical(
        p_declared_service_ids
      ) THEN
      RAISE EXCEPTION 'release source freeze completion replay conflict'; END IF;
    RETURN 'existing';
  END IF;
  IF EXISTS (SELECT 1 FROM release_authority.source_freeze_observation
      WHERE rollout_id=p_rollout_id AND
        release_authority.release_source_freeze_inventory_canonical(
          declared_service_ids
        ) <> release_authority.release_source_freeze_inventory_canonical(
          p_declared_service_ids
        ))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_declared_service_ids) declared(service_id)
      WHERE NOT EXISTS (SELECT 1 FROM release_authority.source_freeze_observation observation
        WHERE observation.rollout_id=p_rollout_id AND observation.service_id=declared.service_id
          AND observation.phase IN ('unchanged','suspended')))
    OR EXISTS (SELECT 1 FROM release_authority.source_freeze_observation intent
      WHERE intent.rollout_id=p_rollout_id AND intent.phase='intent' AND NOT EXISTS
        (SELECT 1 FROM release_authority.source_freeze_observation completed
          WHERE completed.rollout_id=intent.rollout_id AND completed.service_id=intent.service_id
            AND completed.phase='suspended'))
  THEN RAISE EXCEPTION 'release source freeze completion unproven'; END IF;
  INSERT INTO release_authority.source_freeze_completion(rollout_id,declared_service_ids,observed_at)
    VALUES(p_rollout_id,p_declared_service_ids,date_trunc('milliseconds',p_observed_at));
  RETURN 'recorded';
END $body$;
REVOKE ALL ON FUNCTION release_authority.release_source_freeze_complete(text,text,text,integer,text,text,jsonb,timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_authority.release_rollout_compensation_checkpoint(
  p_rollout_id text, p_source_system_identifier text, p_target_system_identifier text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog AS $body$
DECLARE current_row release_authority.rollout%ROWTYPE;
DECLARE latest_receipt release_authority.receipt%ROWTYPE;
DECLARE receipt_count integer; DECLARE freeze_services jsonb; DECLARE freeze_status text;
DECLARE freeze_inventory_complete boolean;
BEGIN
  SELECT * INTO STRICT current_row FROM release_authority.rollout
    WHERE rollout_id=p_rollout_id AND source_system_identifier=p_source_system_identifier
      AND target_system_identifier=p_target_system_identifier;
  SELECT count(*)::integer INTO receipt_count FROM release_authority.receipt WHERE rollout_id=p_rollout_id;
  SELECT * INTO latest_receipt FROM release_authority.receipt
    WHERE rollout_id=p_rollout_id AND receipt_sha256=current_row.last_receipt_sha256;
  SELECT coalesce(jsonb_agg(jsonb_build_object('serviceId',service_id,
      'latestSuccessfulDeployId',latest_successful_deploy_id,
      'observedAt',to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ORDER BY observation_id),'[]'::jsonb) INTO freeze_services
    FROM release_authority.source_freeze_observation WHERE rollout_id=p_rollout_id AND phase='suspended';
  SELECT EXISTS (SELECT 1 FROM release_authority.source_freeze_completion WHERE rollout_id=p_rollout_id)
    OR (EXISTS (SELECT 1 FROM release_authority.source_freeze_observation WHERE rollout_id=p_rollout_id)
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text((SELECT declared_service_ids
          FROM release_authority.source_freeze_observation WHERE rollout_id=p_rollout_id
          ORDER BY observation_id LIMIT 1)) declared(service_id)
        WHERE NOT EXISTS (SELECT 1 FROM release_authority.source_freeze_observation observed
          WHERE observed.rollout_id=p_rollout_id AND observed.service_id=declared.service_id
            AND observed.phase IN ('unchanged','suspended'))))
    INTO freeze_inventory_complete;
  freeze_status := CASE WHEN EXISTS (SELECT 1 FROM release_authority.source_freeze_observation intent
      WHERE intent.rollout_id=p_rollout_id AND intent.phase='intent' AND NOT EXISTS
        (SELECT 1 FROM release_authority.source_freeze_observation completed
          WHERE completed.rollout_id=intent.rollout_id AND completed.service_id=intent.service_id AND completed.phase='suspended')) THEN 'unknown'
    WHEN jsonb_array_length(freeze_services)=0 AND freeze_inventory_complete THEN 'none'
    WHEN jsonb_array_length(freeze_services)=0 THEN 'unknown'
    WHEN freeze_inventory_complete THEN 'complete'
    ELSE 'partial' END;
  RETURN jsonb_build_object('activationBoundary',current_row.activation_boundary,
    'state',current_row.state,'lastReceiptSha256',current_row.last_receipt_sha256,
    'lastStep',latest_receipt.step,'receiptCount',receipt_count,
    'sourceFreeze',jsonb_build_object('status',freeze_status,'services',freeze_services,
      'serviceIds',(SELECT coalesce(jsonb_agg(value->>'serviceId'),'[]'::jsonb) FROM jsonb_array_elements(freeze_services) value)));
END $body$;

CREATE OR REPLACE FUNCTION release_authority.release_runner_compensation_gate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF NEW.state = 'compensating' AND OLD.state = 'pre_activation' AND
    (NOT EXISTS (SELECT 1 FROM release_authority.source_freeze_observation WHERE rollout_id=NEW.rollout_id AND phase='suspended')
     OR EXISTS (SELECT 1 FROM release_authority.source_freeze_observation intent
       WHERE intent.rollout_id=NEW.rollout_id AND intent.phase='intent' AND NOT EXISTS
         (SELECT 1 FROM release_authority.source_freeze_observation completed
          WHERE completed.rollout_id=intent.rollout_id AND completed.service_id=intent.service_id AND completed.phase='suspended'))
     OR EXISTS (SELECT 1 FROM release_authority.runner_intent WHERE rollout_id=NEW.rollout_id
      AND (effect_state NOT IN ('cleaned','abandoned') OR NOT effect_safe_for_compensation))
    )
  THEN RAISE EXCEPTION 'release runner effects unsafe for compensation'; END IF;
  RETURN NEW;
END $body$;

DO $acl$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='reviewrouter_release_control') THEN
    GRANT EXECUTE ON FUNCTION release_authority.release_source_freeze_record(text,text,text,integer,text,text,text,text,timestamptz,jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_source_freeze_prepare(text,text,text,integer,text,text,text,text,timestamptz,jsonb,boolean) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_source_freeze_complete(text,text,text,integer,text,text,jsonb,timestamptz) TO reviewrouter_release_control;
  END IF;
END $acl$;

COMMIT;
