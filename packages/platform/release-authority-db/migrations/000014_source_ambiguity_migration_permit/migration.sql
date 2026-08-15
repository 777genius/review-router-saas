-- Bind source-owned legacy ambiguity evidence and an authority-owned cutoff to
-- every target migration permit without rewriting the phase-aware migration.
BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE release_authority.release_migration_evidence (
  rollout_id text PRIMARY KEY REFERENCES release_authority.rollout(rollout_id) ON DELETE RESTRICT,
  source_legacy_ambiguity jsonb NOT NULL,
  eligibility_cutoff timestamptz(3) NOT NULL,
  CHECK (jsonb_typeof(source_legacy_ambiguity) = 'object')
);

CREATE TRIGGER release_migration_evidence_immutable_guard
BEFORE UPDATE OR DELETE ON release_authority.release_migration_evidence
FOR EACH ROW EXECUTE FUNCTION release_authority.release_rollout_receipt_immutable();

ALTER FUNCTION release_authority.release_migration_begin(jsonb)
  RENAME TO release_migration_begin_v13;
ALTER FUNCTION release_authority.release_migration_complete(jsonb)
  RENAME TO release_migration_complete_v13;
ALTER FUNCTION release_authority.release_migration_fail(jsonb)
  RENAME TO release_migration_fail_v13;
ALTER FUNCTION release_authority.release_migration_checkpoint(text,text)
  RENAME TO release_migration_checkpoint_v13;

CREATE FUNCTION release_authority.release_migration_begin(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE source_evidence jsonb := p_input->'sourceLegacyAmbiguity';
DECLARE old_permit jsonb;
DECLARE evidence_row release_authority.release_migration_evidence%ROWTYPE;
DECLARE inventory_text text;
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_input)) IS DISTINCT FROM 10::bigint
    OR NOT p_input ?& ARRAY['rolloutId','expectedCommitSha','runId','runAttempt',
      'sourceSystemIdentifier','targetSystemIdentifier','targetRecoveryWitnessSha256',
      'transitionSha256','expectedPreviousReceiptSha256','sourceLegacyAmbiguity']
    OR jsonb_typeof(source_evidence) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(source_evidence)) IS DISTINCT FROM 7::bigint
    OR NOT source_evidence ?& ARRAY['inventorySha256','activeLeaseIds','fetchedSetupIds',
      'pendingIntentIds','intentStatuses','observations','stable']
    OR source_evidence->'stable' IS DISTINCT FROM 'true'::jsonb
    OR source_evidence->>'inventorySha256' !~ '^sha256:[a-f0-9]{64}$'
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['activeLeaseIds','fetchedSetupIds',
      'pendingIntentIds','intentStatuses']) key
      WHERE jsonb_typeof(source_evidence->key) IS DISTINCT FROM 'array'
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(source_evidence->key) item
          WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'))
    OR jsonb_typeof(source_evidence->'observations') IS DISTINCT FROM 'array'
    OR jsonb_array_length(source_evidence->'observations') IS DISTINCT FROM 2
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(source_evidence->'observations') sample
      WHERE jsonb_typeof(sample) IS DISTINCT FROM 'object'
        OR (SELECT count(*) FROM jsonb_object_keys(sample)) IS DISTINCT FROM 2::bigint
        OR NOT sample ?& ARRAY['observedAt','inventorySha256']
        OR sample->>'inventorySha256' IS DISTINCT FROM source_evidence->>'inventorySha256'
        OR NOT pg_input_is_valid(sample->>'observedAt','timestamptz'))
  THEN RAISE EXCEPTION 'release migration source evidence invalid'; END IF;
  IF (source_evidence->'observations'->1->>'observedAt')::timestamptz
       <= (source_evidence->'observations'->0->>'observedAt')::timestamptz
  THEN RAISE EXCEPTION 'release migration source evidence ordering invalid'; END IF;
  inventory_text := '{"activeLeaseIds":'||release_authority.release_canonical_json(
    source_evidence->'activeLeaseIds')||',"fetchedSetupIds":'||
    release_authority.release_canonical_json(source_evidence->'fetchedSetupIds')||
    ',"pendingIntentIds":'||release_authority.release_canonical_json(
    source_evidence->'pendingIntentIds')||',"intentStatuses":'||
    release_authority.release_canonical_json(source_evidence->'intentStatuses')||'}';
  IF source_evidence->>'inventorySha256' IS DISTINCT FROM
    'sha256:'||encode(sha256(convert_to(inventory_text,'UTF8')),'hex')
  THEN RAISE EXCEPTION 'release migration source evidence digest invalid'; END IF;

  old_permit := release_authority.release_migration_begin_v13(
    p_input-'sourceLegacyAmbiguity');
  INSERT INTO release_authority.release_migration_evidence(
    rollout_id,source_legacy_ambiguity,eligibility_cutoff)
  VALUES(p_input->>'rolloutId',source_evidence,
    date_trunc('milliseconds',transaction_timestamp()))
  ON CONFLICT (rollout_id) DO NOTHING;
  SELECT * INTO STRICT evidence_row
  FROM release_authority.release_migration_evidence
  WHERE rollout_id=p_input->>'rolloutId';
  IF evidence_row.source_legacy_ambiguity IS DISTINCT FROM source_evidence
  THEN RAISE EXCEPTION 'release migration source evidence replay conflict'; END IF;
  RETURN old_permit||jsonb_build_object(
    'sourceLegacyAmbiguity',evidence_row.source_legacy_ambiguity,
    'eligibilityCutoff',to_char(evidence_row.eligibility_cutoff AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $body$;

CREATE FUNCTION release_authority.release_migration_complete(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE permit jsonb := p_input->'permit';
DECLARE evidence_row release_authority.release_migration_evidence%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_input)) IS DISTINCT FROM 2::bigint
    OR NOT p_input ?& ARRAY['permit','receipt']
    OR jsonb_typeof(permit) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(permit)) IS DISTINCT FROM 12::bigint
    OR NOT permit ?& ARRAY['schemaVersion','rolloutId','runId','runAttempt',
      'targetSystemIdentifier','targetRecoveryWitnessSha256','transitionSha256',
      'expectedPreviousReceiptSha256','sourceLegacyAmbiguity','eligibilityCutoff','epoch','nonce']
    OR NOT pg_input_is_valid(permit->>'eligibilityCutoff','timestamptz')
  THEN RAISE EXCEPTION 'release migration completion permit invalid'; END IF;
  SELECT * INTO STRICT evidence_row FROM release_authority.release_migration_evidence
    WHERE rollout_id=permit->>'rolloutId';
  IF permit->'sourceLegacyAmbiguity' IS DISTINCT FROM evidence_row.source_legacy_ambiguity
    OR (permit->>'eligibilityCutoff')::timestamptz IS DISTINCT FROM evidence_row.eligibility_cutoff
  THEN RAISE EXCEPTION 'release migration completion evidence conflict'; END IF;
  RETURN release_authority.release_migration_complete_v13(
    jsonb_build_object('permit',permit-'sourceLegacyAmbiguity'-'eligibilityCutoff',
      'receipt',p_input->'receipt'));
END $body$;

CREATE FUNCTION release_authority.release_migration_fail(p_input jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE permit jsonb := p_input->'permit';
DECLARE evidence_row release_authority.release_migration_evidence%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_input)) IS DISTINCT FROM 2::bigint
    OR NOT p_input ?& ARRAY['permit','reasonSha256']
    OR jsonb_typeof(permit) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(permit)) IS DISTINCT FROM 12::bigint
    OR NOT permit ?& ARRAY['sourceLegacyAmbiguity','eligibilityCutoff']
    OR NOT pg_input_is_valid(permit->>'eligibilityCutoff','timestamptz')
  THEN RAISE EXCEPTION 'release migration failure permit invalid'; END IF;
  SELECT * INTO STRICT evidence_row FROM release_authority.release_migration_evidence
    WHERE rollout_id=permit->>'rolloutId';
  IF permit->'sourceLegacyAmbiguity' IS DISTINCT FROM evidence_row.source_legacy_ambiguity
    OR (permit->>'eligibilityCutoff')::timestamptz IS DISTINCT FROM evidence_row.eligibility_cutoff
  THEN RAISE EXCEPTION 'release migration failure evidence conflict'; END IF;
  RETURN release_authority.release_migration_fail_v13(
    jsonb_build_object('permit',permit-'sourceLegacyAmbiguity'-'eligibilityCutoff',
      'reasonSha256',p_input->'reasonSha256'));
END $body$;

CREATE FUNCTION release_authority.release_migration_checkpoint(
  p_rollout_id text,p_target_system_identifier text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog AS $body$
DECLARE checkpoint jsonb;
DECLARE evidence_row release_authority.release_migration_evidence%ROWTYPE;
BEGIN
  checkpoint := release_authority.release_migration_checkpoint_v13(
    p_rollout_id,p_target_system_identifier);
  IF checkpoint->'permit' IS NULL OR checkpoint->'permit' = 'null'::jsonb THEN RETURN checkpoint; END IF;
  SELECT * INTO STRICT evidence_row FROM release_authority.release_migration_evidence
    WHERE rollout_id=p_rollout_id;
  RETURN jsonb_set(checkpoint,'{permit}',checkpoint->'permit'||jsonb_build_object(
    'sourceLegacyAmbiguity',evidence_row.source_legacy_ambiguity,
    'eligibilityCutoff',to_char(evidence_row.eligibility_cutoff AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
END $body$;

REVOKE ALL ON TABLE release_authority.release_migration_evidence FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_migration_begin_v13(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_migration_complete_v13(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_migration_fail_v13(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_migration_checkpoint_v13(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_migration_begin(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_migration_complete(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_migration_fail(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_migration_checkpoint(text,text) FROM PUBLIC;

DO $operational_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='reviewrouter_release_control') THEN
    REVOKE ALL ON FUNCTION release_authority.release_migration_begin_v13(jsonb) FROM reviewrouter_release_control;
    REVOKE ALL ON FUNCTION release_authority.release_migration_complete_v13(jsonb) FROM reviewrouter_release_control;
    REVOKE ALL ON FUNCTION release_authority.release_migration_fail_v13(jsonb) FROM reviewrouter_release_control;
    REVOKE ALL ON FUNCTION release_authority.release_migration_checkpoint_v13(text,text) FROM reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_migration_begin(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_migration_complete(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_migration_fail(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_migration_checkpoint(text,text) TO reviewrouter_release_control;
  END IF;
END $operational_acl$;

COMMIT;
