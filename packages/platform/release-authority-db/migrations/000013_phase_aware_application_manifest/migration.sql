-- Durable, append-only application-manifest transition fence.  The release
-- authority, not a worker request, owns the exact pre/post identities.
BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE release_authority.rollout
  ADD COLUMN migration_transition jsonb,
  ADD COLUMN migration_transition_sha256 text,
  ADD COLUMN target_recovery_witness_sha256 text,
  ADD COLUMN target_manifest_phase text NOT NULL DEFAULT 'pre_migration',
  ADD COLUMN migration_permit jsonb,
  ADD COLUMN migration_permit_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN migration_permit_nonce text,
  ADD COLUMN migration_previous_receipt_sha256 text,
  ADD COLUMN migration_effect_fingerprint text,
  ADD COLUMN migration_receipt jsonb,
  ADD COLUMN migration_failure_sha256 text,
  ADD CONSTRAINT rollout_migration_transition_sha_check CHECK
    (migration_transition_sha256 IS NULL OR migration_transition_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  ADD CONSTRAINT rollout_target_recovery_witness_check CHECK
    (target_recovery_witness_sha256 IS NULL OR target_recovery_witness_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT rollout_target_manifest_phase_check CHECK
    (target_manifest_phase IN ('pre_migration','migrating','post_migration','quarantined')),
  ADD CONSTRAINT rollout_migration_permit_epoch_check CHECK (migration_permit_epoch >= 0),
  ADD CONSTRAINT rollout_migration_permit_nonce_check CHECK
    (migration_permit_nonce IS NULL OR migration_permit_nonce ~ '^[a-f0-9]{32}$'),
  ADD CONSTRAINT rollout_migration_previous_receipt_check CHECK
    (migration_previous_receipt_sha256 IS NULL OR migration_previous_receipt_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  ADD CONSTRAINT rollout_migration_effect_fingerprint_check CHECK
    (migration_effect_fingerprint IS NULL OR migration_effect_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  ADD CONSTRAINT rollout_migration_failure_check CHECK
    (migration_failure_sha256 IS NULL OR migration_failure_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  ADD CONSTRAINT rollout_activation_post_manifest_check CHECK
    (migration_transition IS NULL OR activation_migration_checksum IS NULL OR
      (target_manifest_phase='post_migration' AND
       activation_migration_checksum=migration_transition->>'postManifestIdentity')),
  ADD CONSTRAINT rollout_migration_phase_shape_check CHECK (
    (migration_transition IS NULL AND migration_transition_sha256 IS NULL AND
      target_recovery_witness_sha256 IS NULL AND migration_permit IS NULL AND
      migration_permit_epoch=0 AND migration_permit_nonce IS NULL AND
      migration_previous_receipt_sha256 IS NULL AND migration_effect_fingerprint IS NULL AND
      migration_receipt IS NULL AND migration_failure_sha256 IS NULL) OR
    (migration_transition IS NOT NULL AND migration_transition_sha256 IS NOT NULL AND
      target_recovery_witness_sha256 IS NOT NULL AND (
        (target_manifest_phase='pre_migration' AND migration_permit IS NULL AND
          migration_permit_epoch=0 AND migration_receipt IS NULL AND migration_failure_sha256 IS NULL) OR
        (target_manifest_phase='migrating' AND migration_permit IS NOT NULL AND
          migration_permit_epoch>0 AND migration_permit_nonce IS NOT NULL AND
          migration_previous_receipt_sha256 IS NOT NULL AND migration_receipt IS NULL AND
          migration_failure_sha256 IS NULL) OR
        (target_manifest_phase='post_migration' AND migration_permit IS NOT NULL AND
          migration_effect_fingerprint IS NOT NULL AND migration_receipt IS NOT NULL AND
          migration_failure_sha256 IS NULL) OR
        (target_manifest_phase='quarantined' AND migration_permit IS NOT NULL AND
          migration_failure_sha256 IS NOT NULL AND migration_receipt IS NULL)
      ))
  );

CREATE TABLE release_authority.target_generation_claim (
  target_system_identifier text PRIMARY KEY CHECK (target_system_identifier ~ '^[0-9]+$'),
  target_recovery_witness_sha256 text NOT NULL CHECK (target_recovery_witness_sha256 ~ '^[a-f0-9]{64}$'),
  rollout_id text NOT NULL UNIQUE REFERENCES release_authority.rollout(rollout_id) ON DELETE RESTRICT,
  transition_sha256 text NOT NULL CHECK (transition_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  claimed_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  UNIQUE (target_system_identifier,target_recovery_witness_sha256)
);

CREATE TRIGGER release_target_generation_claim_immutable_guard
BEFORE UPDATE OR DELETE ON release_authority.target_generation_claim
FOR EACH ROW EXECUTE FUNCTION release_authority.release_rollout_receipt_immutable();

CREATE FUNCTION release_authority.release_canonical_json(value jsonb)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog AS $canonical_json$
SELECT CASE jsonb_typeof(value)
  WHEN 'object' THEN '{'||coalesce((SELECT string_agg(to_json(key)::text||':'||
    release_authority.release_canonical_json(item),',' ORDER BY key COLLATE "C")
    FROM jsonb_each(value) entry(key,item)),'')||'}'
  WHEN 'array' THEN '['||coalesce((SELECT string_agg(
    release_authority.release_canonical_json(item),',' ORDER BY ordinal)
    FROM jsonb_array_elements(value) WITH ORDINALITY entry(item,ordinal)),'')||']'
  ELSE value::text
END
$canonical_json$;

CREATE FUNCTION release_authority.release_rollout_claim_transition(p_input jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE current_row release_authority.rollout%ROWTYPE;
DECLARE transition jsonb;
BEGIN
  transition := p_input->'migrationTransition';
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'release migration transition claim invalid'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_input)) IS DISTINCT FROM 8::bigint
    OR NOT p_input ?& ARRAY['rolloutId','expectedCommitSha','runId','runAttempt',
      'sourceSystemIdentifier','targetSystemIdentifier','targetRecoveryWitnessSha256','migrationTransition']
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['rolloutId','expectedCommitSha','runId',
      'sourceSystemIdentifier','targetSystemIdentifier','targetRecoveryWitnessSha256']) key
      WHERE jsonb_typeof(p_input->key) IS DISTINCT FROM 'string')
    OR jsonb_typeof(p_input->'runAttempt') IS DISTINCT FROM 'number'
    OR jsonb_typeof(transition) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'release migration transition claim invalid'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(transition)) IS DISTINCT FROM 12::bigint
    OR NOT transition ?& ARRAY['schemaVersion','commitSha','releaseImageDigest',
      'migrationArtifactDigest','orderedMigrationEntries','preManifestIdentity',
      'orderedPendingEntriesSha256','migrationBundleSha256','allowedResumeManifestIdentities',
      'postManifestIdentity','postCatalogDigest','transitionSha256']
    OR jsonb_typeof(transition->'schemaVersion') IS DISTINCT FROM 'number'
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['commitSha','releaseImageDigest',
      'migrationArtifactDigest','preManifestIdentity','orderedPendingEntriesSha256',
      'migrationBundleSha256','postManifestIdentity','postCatalogDigest','transitionSha256']) key
      WHERE jsonb_typeof(transition->key) IS DISTINCT FROM 'string')
    OR jsonb_typeof(transition->'orderedMigrationEntries') IS DISTINCT FROM 'array'
    OR jsonb_typeof(transition->'allowedResumeManifestIdentities') IS DISTINCT FROM 'array'
    OR jsonb_array_length(transition->'orderedMigrationEntries') < 1
    OR jsonb_array_length(transition->'allowedResumeManifestIdentities') < 1
  THEN RAISE EXCEPTION 'release migration transition claim invalid'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(transition->'orderedMigrationEntries') entry
      WHERE jsonb_typeof(entry) IS DISTINCT FROM 'object'
        OR (SELECT count(*) FROM jsonb_object_keys(entry)) IS DISTINCT FROM 2::bigint
        OR NOT entry ?& ARRAY['migrationName','migrationSqlSha256']
        OR jsonb_typeof(entry->'migrationName') IS DISTINCT FROM 'string'
        OR jsonb_typeof(entry->'migrationSqlSha256') IS DISTINCT FROM 'string'
        OR entry->>'migrationName' !~ '^[0-9]{6}_[a-z0-9_]+$'
        OR entry->>'migrationSqlSha256' !~ '^[a-f0-9]{64}$')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(transition->'allowedResumeManifestIdentities') item
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
        OR item#>>'{}' !~ '^sha256:[a-f0-9]{64}$')
    OR p_input->>'rolloutId' !~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$'
    OR p_input->>'expectedCommitSha' !~ '^[a-f0-9]{40}$'
    OR p_input->>'runId' !~ '^[1-9][0-9]*$' OR p_input->'runAttempt' IS DISTINCT FROM '1'::jsonb
    OR p_input->>'sourceSystemIdentifier' !~ '^[1-9][0-9]{0,19}$'
    OR p_input->>'targetSystemIdentifier' !~ '^[1-9][0-9]{0,19}$'
    OR p_input->>'sourceSystemIdentifier' IS NOT DISTINCT FROM p_input->>'targetSystemIdentifier'
    OR p_input->>'targetRecoveryWitnessSha256' !~ '^[a-f0-9]{64}$'
    OR transition->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR transition->>'commitSha' IS DISTINCT FROM p_input->>'expectedCommitSha'
    OR transition->>'transitionSha256' !~ '^sha256:[a-f0-9]{64}$'
    OR transition->>'preManifestIdentity' !~ '^sha256:[a-f0-9]{64}$'
    OR transition->>'postManifestIdentity' !~ '^sha256:[a-f0-9]{64}$'
    OR transition->>'preManifestIdentity' IS NOT DISTINCT FROM transition->>'postManifestIdentity'
    OR transition->>'migrationArtifactDigest' !~ '^sha256:[a-f0-9]{64}$'
    OR transition->>'migrationBundleSha256' !~ '^sha256:[a-f0-9]{64}$'
    OR transition->>'postCatalogDigest' !~ '^sha256:[a-f0-9]{64}$'
    OR transition->>'transitionSha256' IS DISTINCT FROM 'sha256:'||encode(sha256(convert_to(
      release_authority.release_canonical_json(transition-'transitionSha256'),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'release migration transition claim invalid'; END IF;

  INSERT INTO release_authority.rollout(
    rollout_id,expected_commit_sha,run_id,run_attempt,source_system_identifier,
    target_system_identifier,authoritative_system_identifier,activation_boundary,
    source_permanently_ineligible,last_receipt_sha256,migration_transition,
    migration_transition_sha256,target_recovery_witness_sha256,target_manifest_phase)
  VALUES (p_input->>'rolloutId',p_input->>'expectedCommitSha',p_input->>'runId',1,
    p_input->>'sourceSystemIdentifier',p_input->>'targetSystemIdentifier',
    p_input->>'sourceSystemIdentifier','before',false,'sha256:'||repeat('0',64),
    transition,transition->>'transitionSha256',p_input->>'targetRecoveryWitnessSha256','pre_migration')
  ON CONFLICT (rollout_id) DO NOTHING;
  IF FOUND THEN
    INSERT INTO release_authority.target_generation_claim(
      target_system_identifier,target_recovery_witness_sha256,rollout_id,transition_sha256)
    VALUES (p_input->>'targetSystemIdentifier',p_input->>'targetRecoveryWitnessSha256',
      p_input->>'rolloutId',transition->>'transitionSha256');
    RETURN 'claimed';
  END IF;
  SELECT * INTO STRICT current_row FROM release_authority.rollout
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  IF current_row.expected_commit_sha IS DISTINCT FROM p_input->>'expectedCommitSha'
    OR current_row.run_id IS DISTINCT FROM p_input->>'runId' OR current_row.run_attempt IS DISTINCT FROM 1
    OR current_row.source_system_identifier IS DISTINCT FROM p_input->>'sourceSystemIdentifier'
    OR current_row.target_system_identifier IS DISTINCT FROM p_input->>'targetSystemIdentifier'
    OR current_row.target_recovery_witness_sha256 IS DISTINCT FROM p_input->>'targetRecoveryWitnessSha256'
    OR current_row.migration_transition IS DISTINCT FROM transition
  THEN RAISE EXCEPTION 'release rollout claim identity conflict'; END IF;
  RETURN 'duplicate';
END $body$;

CREATE FUNCTION release_authority.release_migration_begin(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE current_row release_authority.rollout%ROWTYPE;
DECLARE permit jsonb;
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'release migration begin shape invalid'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_input)) IS DISTINCT FROM 9::bigint
    OR NOT p_input ?& ARRAY['rolloutId','expectedCommitSha','runId','runAttempt',
      'sourceSystemIdentifier','targetSystemIdentifier','targetRecoveryWitnessSha256',
      'transitionSha256','expectedPreviousReceiptSha256']
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['rolloutId','expectedCommitSha','runId',
      'sourceSystemIdentifier','targetSystemIdentifier','targetRecoveryWitnessSha256',
      'transitionSha256','expectedPreviousReceiptSha256']) key
      WHERE jsonb_typeof(p_input->key) IS DISTINCT FROM 'string')
    OR jsonb_typeof(p_input->'runAttempt') IS DISTINCT FROM 'number'
    OR p_input->>'rolloutId' !~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$'
    OR p_input->>'expectedCommitSha' !~ '^[a-f0-9]{40}$'
    OR p_input->>'runId' !~ '^[1-9][0-9]*$'
    OR p_input->'runAttempt' IS DISTINCT FROM '1'::jsonb
    OR p_input->>'sourceSystemIdentifier' !~ '^[1-9][0-9]{0,19}$'
    OR p_input->>'targetSystemIdentifier' !~ '^[1-9][0-9]{0,19}$'
    OR p_input->>'sourceSystemIdentifier' IS NOT DISTINCT FROM p_input->>'targetSystemIdentifier'
    OR p_input->>'targetRecoveryWitnessSha256' !~ '^[a-f0-9]{64}$'
    OR p_input->>'transitionSha256' !~ '^sha256:[a-f0-9]{64}$'
    OR p_input->>'expectedPreviousReceiptSha256' !~ '^sha256:[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'release migration begin shape invalid'; END IF;
  SELECT * INTO STRICT current_row FROM release_authority.rollout
    WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;
  IF current_row.expected_commit_sha IS DISTINCT FROM p_input->>'expectedCommitSha'
    OR current_row.run_id IS DISTINCT FROM p_input->>'runId'
    OR current_row.run_attempt IS DISTINCT FROM (p_input->>'runAttempt')::integer
    OR current_row.source_system_identifier IS DISTINCT FROM p_input->>'sourceSystemIdentifier'
    OR current_row.target_system_identifier IS DISTINCT FROM p_input->>'targetSystemIdentifier'
    OR current_row.target_recovery_witness_sha256 IS DISTINCT FROM p_input->>'targetRecoveryWitnessSha256'
    OR current_row.migration_transition_sha256 IS DISTINCT FROM p_input->>'transitionSha256'
    OR current_row.last_receipt_sha256 IS DISTINCT FROM p_input->>'expectedPreviousReceiptSha256'
    OR current_row.activation_boundary IS DISTINCT FROM 'before'
    OR current_row.state IS DISTINCT FROM 'pre_activation'
    OR NOT EXISTS (SELECT 1 FROM release_authority.receipt WHERE rollout_id=current_row.rollout_id
      AND step='provision_cutover_runner' AND receipt_sha256=current_row.last_receipt_sha256)
  THEN RAISE EXCEPTION 'release migration begin binding conflict'; END IF;
  IF current_row.target_manifest_phase='migrating' THEN RETURN current_row.migration_permit; END IF;
  IF current_row.target_manifest_phase IS DISTINCT FROM 'pre_migration'
    THEN RAISE EXCEPTION 'release migration begin phase conflict'; END IF;
  permit := jsonb_build_object('schemaVersion',1,'rolloutId',current_row.rollout_id,
    'runId',current_row.run_id,'runAttempt',current_row.run_attempt,
    'targetSystemIdentifier',current_row.target_system_identifier,
    'targetRecoveryWitnessSha256',current_row.target_recovery_witness_sha256,
    'transitionSha256',current_row.migration_transition_sha256,
    'expectedPreviousReceiptSha256',current_row.last_receipt_sha256,
    'epoch',current_row.migration_permit_epoch+1,
    'nonce',replace(gen_random_uuid()::text,'-',''));
  UPDATE release_authority.rollout SET target_manifest_phase='migrating',
    migration_permit=permit,migration_permit_epoch=(permit->>'epoch')::bigint,
    migration_permit_nonce=permit->>'nonce',
    migration_previous_receipt_sha256=last_receipt_sha256,updated_at=clock_timestamp()
  WHERE rollout_id=current_row.rollout_id;
  RETURN permit;
END $body$;

CREATE FUNCTION release_authority.release_migration_complete(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE current_row release_authority.rollout%ROWTYPE;
DECLARE receipt jsonb := p_input->'receipt';
DECLARE permit jsonb := p_input->'permit';
DECLARE fingerprint text;
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'release migration completion shape invalid'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_input)) IS DISTINCT FROM 2::bigint
    OR NOT p_input ?& ARRAY['permit','receipt']
    OR jsonb_typeof(permit) IS DISTINCT FROM 'object'
    OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'release migration completion shape invalid'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(permit)) IS DISTINCT FROM 10::bigint
    OR NOT permit ?& ARRAY['schemaVersion','rolloutId','runId','runAttempt',
      'targetSystemIdentifier','targetRecoveryWitnessSha256','transitionSha256',
      'expectedPreviousReceiptSha256','epoch','nonce']
    OR jsonb_typeof(permit->'schemaVersion') IS DISTINCT FROM 'number'
    OR jsonb_typeof(permit->'runAttempt') IS DISTINCT FROM 'number'
    OR jsonb_typeof(permit->'epoch') IS DISTINCT FROM 'number'
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['rolloutId','runId','targetSystemIdentifier',
      'targetRecoveryWitnessSha256','transitionSha256','expectedPreviousReceiptSha256','nonce']) key
      WHERE jsonb_typeof(permit->key) IS DISTINCT FROM 'string')
    OR permit->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR permit->'runAttempt' IS DISTINCT FROM '1'::jsonb
    OR permit->>'rolloutId' !~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$'
    OR permit->>'runId' !~ '^[1-9][0-9]*$'
    OR permit->>'targetSystemIdentifier' !~ '^[1-9][0-9]{0,19}$'
    OR permit->>'targetRecoveryWitnessSha256' !~ '^[a-f0-9]{64}$'
    OR permit->>'transitionSha256' !~ '^sha256:[a-f0-9]{64}$'
    OR permit->>'expectedPreviousReceiptSha256' !~ '^sha256:[a-f0-9]{64}$'
    OR permit->>'epoch' !~ '^[1-9][0-9]{0,18}$'
    OR permit->>'nonce' !~ '^[a-f0-9]{32}$'
  THEN RAISE EXCEPTION 'release migration completion permit invalid'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(receipt)) NOT IN (23,24)
    OR NOT receipt ?& ARRAY['step','receiptId','observedAt','rolloutId','expectedCommitSha',
      'runId','runAttempt','sourceSystemIdentifier','targetSystemIdentifier',
      'observationSha256','previousReceiptSha256','receiptSha256','migrationChecksum',
      'transitionSha256','migrationArtifactDigest','migrationBundleSha256',
      'preManifestIdentity','postManifestIdentity','postCatalogDigest',
      'permitEpoch','permitNonce','targetMigrationReceiptSha256',
      'targetMigrationEffectFingerprint']
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(receipt) key WHERE NOT key=ANY(ARRAY[
      'step','receiptId','observedAt','rolloutId','expectedCommitSha','runId','runAttempt',
      'sourceSystemIdentifier','targetSystemIdentifier','provider','observationSha256',
      'previousReceiptSha256','receiptSha256','migrationChecksum','transitionSha256',
      'migrationArtifactDigest','migrationBundleSha256','preManifestIdentity',
      'postManifestIdentity','postCatalogDigest','permitEpoch','permitNonce',
      'targetMigrationReceiptSha256','targetMigrationEffectFingerprint']))
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['step','receiptId','observedAt','rolloutId',
      'expectedCommitSha','runId','sourceSystemIdentifier','targetSystemIdentifier',
      'observationSha256','previousReceiptSha256','receiptSha256','migrationChecksum',
      'transitionSha256','migrationArtifactDigest','migrationBundleSha256',
      'preManifestIdentity','postManifestIdentity','postCatalogDigest','permitNonce',
      'targetMigrationReceiptSha256','targetMigrationEffectFingerprint']) key
      WHERE jsonb_typeof(receipt->key) IS DISTINCT FROM 'string')
    OR jsonb_typeof(receipt->'runAttempt') IS DISTINCT FROM 'number'
    OR jsonb_typeof(receipt->'permitEpoch') IS DISTINCT FROM 'number'
    OR (receipt ? 'provider' AND jsonb_typeof(receipt->'provider') IS DISTINCT FROM 'null')
    OR receipt->>'step' IS DISTINCT FROM 'run_release_migration'
    OR char_length(receipt->>'receiptId') NOT BETWEEN 3 AND 512
    OR receipt->>'receiptId' !~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]*$'
    OR receipt->>'observedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    OR NOT pg_catalog.pg_input_is_valid(receipt->>'observedAt','timestamptz')
    OR receipt->>'rolloutId' !~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$'
    OR receipt->>'expectedCommitSha' !~ '^[a-f0-9]{40}$'
    OR receipt->>'runId' !~ '^[1-9][0-9]*$'
    OR receipt->'runAttempt' IS DISTINCT FROM '1'::jsonb
    OR receipt->>'sourceSystemIdentifier' !~ '^[1-9][0-9]{0,19}$'
    OR receipt->>'targetSystemIdentifier' !~ '^[1-9][0-9]{0,19}$'
    OR receipt->>'sourceSystemIdentifier' IS NOT DISTINCT FROM receipt->>'targetSystemIdentifier'
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['observationSha256','previousReceiptSha256',
      'receiptSha256','migrationChecksum','transitionSha256','migrationArtifactDigest',
      'migrationBundleSha256','preManifestIdentity','postManifestIdentity','postCatalogDigest',
      'targetMigrationReceiptSha256','targetMigrationEffectFingerprint']) key
      WHERE receipt->>key !~ '^sha256:[a-f0-9]{64}$')
    OR receipt->>'permitEpoch' !~ '^[1-9][0-9]{0,18}$'
    OR receipt->>'permitNonce' !~ '^[a-f0-9]{32}$'
    OR receipt->>'receiptSha256' IS DISTINCT FROM 'sha256:'||encode(sha256(convert_to(
      release_authority.release_canonical_json(receipt-'receiptSha256'),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'release migration completion receipt invalid'; END IF;
  SELECT * INTO STRICT current_row FROM release_authority.rollout
    WHERE rollout_id=permit->>'rolloutId' FOR UPDATE;
  fingerprint := 'sha256:'||encode(sha256(convert_to(
    release_authority.release_canonical_json(jsonb_build_object(
      'rolloutId',current_row.rollout_id,
      'expectedCommitSha',current_row.expected_commit_sha,
      'runId',current_row.run_id,
      'runAttempt',current_row.run_attempt,
      'sourceSystemIdentifier',current_row.source_system_identifier,
      'targetSystemIdentifier',current_row.target_system_identifier,
      'targetRecoveryWitnessSha256',current_row.target_recovery_witness_sha256,
      'expectedPreviousReceiptSha256',current_row.migration_previous_receipt_sha256,
      'observationSha256',receipt->>'observationSha256',
      'migrationChecksum',receipt->>'migrationChecksum',
      'transitionSha256',receipt->>'transitionSha256',
      'migrationArtifactDigest',receipt->>'migrationArtifactDigest',
      'migrationBundleSha256',receipt->>'migrationBundleSha256',
      'preManifestIdentity',receipt->>'preManifestIdentity',
      'postManifestIdentity',receipt->>'postManifestIdentity',
      'postCatalogDigest',receipt->>'postCatalogDigest',
      'targetMigrationReceiptSha256',receipt->>'targetMigrationReceiptSha256',
      'targetMigrationEffectFingerprint',receipt->>'targetMigrationEffectFingerprint',
      'permitEpoch',permit->'epoch','permitNonce',permit->>'nonce')),'UTF8')),'hex');
  IF current_row.target_manifest_phase='post_migration' THEN
    IF current_row.migration_permit IS DISTINCT FROM permit
      OR current_row.migration_effect_fingerprint IS DISTINCT FROM fingerprint
      THEN RAISE EXCEPTION 'release migration completion replay conflict'; END IF;
    RETURN current_row.migration_receipt;
  END IF;
  IF current_row.target_manifest_phase IS DISTINCT FROM 'migrating'
    OR current_row.migration_permit IS DISTINCT FROM permit
    OR receipt->>'rolloutId' IS DISTINCT FROM current_row.rollout_id
    OR receipt->>'expectedCommitSha' IS DISTINCT FROM current_row.expected_commit_sha
    OR receipt->>'runId' IS DISTINCT FROM current_row.run_id
    OR (receipt->>'runAttempt')::integer IS DISTINCT FROM current_row.run_attempt
    OR receipt->>'sourceSystemIdentifier' IS DISTINCT FROM current_row.source_system_identifier
    OR receipt->>'targetSystemIdentifier' IS DISTINCT FROM current_row.target_system_identifier
    OR receipt->>'previousReceiptSha256' IS DISTINCT FROM current_row.migration_previous_receipt_sha256
    OR receipt->>'transitionSha256' IS DISTINCT FROM current_row.migration_transition_sha256
    OR receipt->>'migrationChecksum' IS DISTINCT FROM current_row.migration_transition->>'postManifestIdentity'
    OR receipt->>'migrationArtifactDigest' IS DISTINCT FROM current_row.migration_transition->>'migrationArtifactDigest'
    OR receipt->>'migrationBundleSha256' IS DISTINCT FROM current_row.migration_transition->>'migrationBundleSha256'
    OR receipt->>'preManifestIdentity' IS DISTINCT FROM current_row.migration_transition->>'preManifestIdentity'
    OR receipt->>'postManifestIdentity' IS DISTINCT FROM current_row.migration_transition->>'postManifestIdentity'
    OR receipt->>'postCatalogDigest' IS DISTINCT FROM current_row.migration_transition->>'postCatalogDigest'
    OR receipt->'permitEpoch' IS DISTINCT FROM permit->'epoch'
    OR receipt->>'permitNonce' IS DISTINCT FROM permit->>'nonce'
  THEN RAISE EXCEPTION 'release migration completion binding conflict'; END IF;
  INSERT INTO release_authority.receipt(receipt_sha256,rollout_id,step,provider_binding,
    previous_receipt_sha256,activation_boundary)
  VALUES(receipt->>'receiptSha256',current_row.rollout_id,'run_release_migration',
    receipt->'provider',current_row.last_receipt_sha256,'before');
  UPDATE release_authority.rollout SET target_manifest_phase='post_migration',
    migration_effect_fingerprint=fingerprint,migration_receipt=receipt,
    last_receipt_sha256=receipt->>'receiptSha256',updated_at=clock_timestamp()
  WHERE rollout_id=current_row.rollout_id;
  RETURN receipt;
END $body$;

CREATE FUNCTION release_authority.release_migration_fail(p_input jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE current_row release_authority.rollout%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'release migration failure shape invalid'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_input)) IS DISTINCT FROM 2::bigint
    OR NOT p_input ?& ARRAY['permit','reasonSha256']
    OR jsonb_typeof(p_input->'permit') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_input->'reasonSha256') IS DISTINCT FROM 'string'
  THEN RAISE EXCEPTION 'release migration failure shape invalid'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_input->'permit')) IS DISTINCT FROM 10::bigint
    OR NOT p_input->'permit' ?& ARRAY['schemaVersion','rolloutId','runId','runAttempt',
      'targetSystemIdentifier','targetRecoveryWitnessSha256','transitionSha256',
      'expectedPreviousReceiptSha256','epoch','nonce']
    OR jsonb_typeof(p_input->'permit'->'schemaVersion') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_input->'permit'->'runAttempt') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_input->'permit'->'epoch') IS DISTINCT FROM 'number'
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['rolloutId','runId','targetSystemIdentifier',
      'targetRecoveryWitnessSha256','transitionSha256','expectedPreviousReceiptSha256','nonce']) key
      WHERE jsonb_typeof(p_input->'permit'->key) IS DISTINCT FROM 'string')
    OR p_input->'permit'->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR p_input->'permit'->'runAttempt' IS DISTINCT FROM '1'::jsonb
    OR p_input->'permit'->>'rolloutId' !~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$'
    OR p_input->'permit'->>'runId' !~ '^[1-9][0-9]*$'
    OR p_input->'permit'->>'targetSystemIdentifier' !~ '^[1-9][0-9]{0,19}$'
    OR p_input->'permit'->>'targetRecoveryWitnessSha256' !~ '^[a-f0-9]{64}$'
    OR p_input->'permit'->>'transitionSha256' !~ '^sha256:[a-f0-9]{64}$'
    OR p_input->'permit'->>'expectedPreviousReceiptSha256' !~ '^sha256:[a-f0-9]{64}$'
    OR p_input->'permit'->>'epoch' !~ '^[1-9][0-9]{0,18}$'
    OR p_input->'permit'->>'nonce' !~ '^[a-f0-9]{32}$'
    OR p_input->>'reasonSha256' !~ '^sha256:[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'release migration failure shape invalid'; END IF;
  SELECT * INTO STRICT current_row FROM release_authority.rollout
    WHERE rollout_id=p_input->'permit'->>'rolloutId' FOR UPDATE;
  IF current_row.target_manifest_phase='quarantined' THEN
    IF current_row.migration_permit IS DISTINCT FROM p_input->'permit'
      OR current_row.migration_failure_sha256 IS DISTINCT FROM p_input->>'reasonSha256'
      THEN RAISE EXCEPTION 'release migration failure replay conflict'; END IF;
    RETURN true;
  END IF;
  IF current_row.target_manifest_phase IS DISTINCT FROM 'migrating'
    OR current_row.migration_permit IS DISTINCT FROM p_input->'permit'
    OR p_input->>'reasonSha256' !~ '^sha256:[a-f0-9]{64}$'
    THEN RAISE EXCEPTION 'release migration failure binding conflict'; END IF;
  UPDATE release_authority.rollout SET target_manifest_phase='quarantined',
    migration_failure_sha256=p_input->>'reasonSha256',updated_at=clock_timestamp()
  WHERE rollout_id=current_row.rollout_id;
  RETURN true;
END $body$;

CREATE FUNCTION release_authority.release_migration_checkpoint(
  p_rollout_id text,p_target_system_identifier text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog AS $body$
DECLARE current_row release_authority.rollout%ROWTYPE;
BEGIN
  SELECT * INTO STRICT current_row FROM release_authority.rollout
    WHERE rollout_id=p_rollout_id AND target_system_identifier=p_target_system_identifier;
  RETURN jsonb_build_object('targetManifestPhase',current_row.target_manifest_phase,
    'permit',current_row.migration_permit,'receipt',current_row.migration_receipt);
END $body$;

REVOKE ALL ON FUNCTION release_authority.release_rollout_claim_transition(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_canonical_json(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_migration_begin(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_migration_complete(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_migration_fail(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_migration_checkpoint(text,text) FROM PUBLIC;
REVOKE ALL ON TABLE release_authority.target_generation_claim FROM PUBLIC;

DO $operational_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'reviewrouter_release_control') THEN
    REVOKE ALL ON FUNCTION release_authority.release_rollout_claim(text,text,text,integer,text,text) FROM reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_rollout_claim_transition(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_migration_begin(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_migration_complete(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_migration_fail(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_migration_checkpoint(text,text) TO reviewrouter_release_control;
  END IF;
END $operational_acl$;

COMMIT;
