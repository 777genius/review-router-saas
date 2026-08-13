-- Bind transactional source recovery to the authority-owned freeze mutation set.
BEGIN;

CREATE FUNCTION release_authority.release_source_resume_is_rollout_owned()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF NEW.step = 'source_resumed' AND NOT EXISTS (
    SELECT 1 FROM release_authority.source_freeze_observation freeze
    WHERE freeze.rollout_id = NEW.rollout_id
      AND freeze.service_id = NEW.service_id
      AND freeze.phase = 'suspended'
  ) THEN
    RAISE EXCEPTION 'release source resume lacks rollout suspension evidence';
  END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION release_authority.release_source_resume_is_rollout_owned() FROM PUBLIC;

CREATE TRIGGER release_source_resume_rollout_ownership_guard
BEFORE INSERT ON release_authority.service_transition_checkpoint
FOR EACH ROW EXECUTE FUNCTION release_authority.release_source_resume_is_rollout_owned();

CREATE OR REPLACE FUNCTION release_authority.release_service_transition_complete(p_input jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE updated bigint;
DECLARE transition release_authority.service_transition%ROWTYPE;
DECLARE declared_service_ids jsonb;
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
  IF p_input->>'outcome'='source_recovered' THEN
    SELECT freeze.declared_service_ids INTO declared_service_ids
      FROM release_authority.source_freeze_observation freeze
      WHERE freeze.rollout_id=transition.rollout_id
      ORDER BY freeze.observation_id LIMIT 1;
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
      OR EXISTS (SELECT 1 FROM release_authority.source_freeze_observation freeze
        WHERE freeze.rollout_id=transition.rollout_id AND freeze.phase='suspended'
          AND NOT EXISTS (SELECT 1 FROM release_authority.service_transition_checkpoint checkpoint
            WHERE checkpoint.rollout_id=transition.rollout_id
              AND checkpoint.service_id=freeze.service_id AND checkpoint.step='source_resumed'))
      OR EXISTS (SELECT 1 FROM release_authority.service_transition_checkpoint checkpoint
        WHERE checkpoint.rollout_id=transition.rollout_id AND checkpoint.step='source_resumed'
          AND NOT EXISTS (SELECT 1 FROM release_authority.source_freeze_observation freeze
            WHERE freeze.rollout_id=transition.rollout_id
              AND freeze.service_id=checkpoint.service_id AND freeze.phase='suspended'))
    THEN RAISE EXCEPTION 'release source service recovery incomplete'; END IF;
  END IF;
  UPDATE release_authority.service_transition SET outcome=p_input->>'outcome',completed_at=clock_timestamp()
    WHERE rollout_id=p_input->>'rolloutId'
      AND (outcome IS NULL OR (outcome='target_staged' AND p_input->>'outcome'='source_recovered'));
  GET DIAGNOSTICS updated=ROW_COUNT;
  IF updated=1 THEN RETURN true; END IF;
  RETURN EXISTS(SELECT 1 FROM release_authority.service_transition
    WHERE rollout_id=p_input->>'rolloutId' AND outcome=p_input->>'outcome');
END $body$;
REVOKE ALL ON FUNCTION release_authority.release_service_transition_complete(jsonb) FROM PUBLIC;

DO $acl$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='reviewrouter_release_control') THEN
    GRANT EXECUTE ON FUNCTION release_authority.release_service_transition_complete(jsonb) TO reviewrouter_release_control;
  END IF;
END $acl$;

COMMIT;
