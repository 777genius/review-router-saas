BEGIN;

-- Persist the source fence receipt before any backup receipt. This forward-only
-- migration preserves the published 000001 bytes while correcting the
-- authoritative aggregate chronology for all new and resumed rollouts.
CREATE OR REPLACE FUNCTION release_authority.release_rollout_append_receipt(
  p_rollout_id text,
  p_expected_commit_sha text,
  p_run_id text,
  p_run_attempt integer,
  p_source_system_identifier text,
  p_target_system_identifier text,
  p_step text,
  p_expected_receipt_sha256 text,
  p_next_receipt_sha256 text,
  p_authoritative_system_identifier text,
  p_expected_activation_boundary text,
  p_next_activation_boundary text,
  p_provider_binding jsonb DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $append$
DECLARE current_row release_authority.rollout%ROWTYPE;
DECLARE existing_receipt release_authority.receipt%ROWTYPE;
DECLARE expected_step text;
DECLARE completed_steps integer;
BEGIN
  SELECT * INTO current_row FROM release_authority.rollout
    WHERE rollout_id = p_rollout_id FOR UPDATE;
  IF NOT FOUND OR current_row.expected_commit_sha <> p_expected_commit_sha OR
     current_row.run_id <> p_run_id OR current_row.run_attempt <> p_run_attempt OR
     current_row.source_system_identifier <> p_source_system_identifier OR
     current_row.target_system_identifier <> p_target_system_identifier THEN
    RETURN false;
  END IF;
  SELECT * INTO existing_receipt FROM release_authority.receipt
    WHERE rollout_id = p_rollout_id AND step = p_step;
  IF FOUND THEN
    IF existing_receipt.receipt_sha256 = p_next_receipt_sha256 AND
       existing_receipt.previous_receipt_sha256 = p_expected_receipt_sha256 AND
       existing_receipt.activation_boundary = p_next_activation_boundary AND
       existing_receipt.provider_binding IS NOT DISTINCT FROM p_provider_binding AND
       ((p_expected_activation_boundary = 'before' AND
         p_next_activation_boundary = 'before' AND
         p_authoritative_system_identifier = current_row.source_system_identifier AND
         current_row.activation_boundary = 'before') OR
        (p_expected_activation_boundary = 'activated' AND
         p_next_activation_boundary = 'activated' AND
         p_authoritative_system_identifier = current_row.target_system_identifier AND
         current_row.activation_boundary = 'activated')) THEN
      RETURN true;
    END IF;
    RAISE EXCEPTION 'release rollout receipt replay conflict';
  END IF;
  IF current_row.last_receipt_sha256 <> p_expected_receipt_sha256 OR
     current_row.activation_boundary <> p_expected_activation_boundary THEN
    RETURN false;
  END IF;
  IF p_next_activation_boundary NOT IN ('before','activated') OR
     (current_row.activation_boundary <> p_next_activation_boundary AND
      NOT (current_row.activation_boundary = 'uncertain' AND p_next_activation_boundary = 'activated')) THEN
    RAISE EXCEPTION 'release rollout receipt transition invalid';
  END IF;
  IF (p_step = 'begin_compensation' AND current_row.state <> 'pre_activation') OR
     (p_step = 'effect_compensation' AND current_row.state <> 'compensating') OR
     (p_step = 'complete_compensation' AND current_row.state <> 'compensating') OR
     (p_step = 'effect_compensation' AND NOT EXISTS (
       SELECT 1 FROM release_authority.receipt
       WHERE rollout_id = p_rollout_id AND step = 'begin_compensation'
         AND receipt_sha256 = current_row.last_receipt_sha256)) OR
     (p_step = 'complete_compensation' AND NOT EXISTS (
       SELECT 1 FROM release_authority.receipt
       WHERE rollout_id = p_rollout_id AND step = 'effect_compensation'
         AND receipt_sha256 = current_row.last_receipt_sha256)) OR
     (p_step IN ('begin_compensation','effect_compensation','complete_compensation') AND
       (p_expected_activation_boundary <> 'before' OR p_next_activation_boundary <> 'before' OR
        p_authoritative_system_identifier <> current_row.source_system_identifier)) THEN
    RAISE EXCEPTION 'release rollout compensation transition invalid';
  END IF;
  IF p_step NOT IN ('begin_compensation','effect_compensation','complete_compensation') AND
     current_row.state = 'pre_activation' THEN
    SELECT count(*)::integer INTO completed_steps
    FROM release_authority.receipt WHERE rollout_id = p_rollout_id;
    expected_step := (ARRAY[
      'claim_rollout', 'verify_protected_environment', 'freeze_provider_services',
      'provision_role_runner', 'quiesce_source', 'capture_source_backup',
      'copy_database_generation', 'bootstrap_target_roles',
      'verify_data_equivalence', 'cleanup_role_runner',
      'provision_cutover_runner', 'run_release_migration', 'stage_target_services'
    ])[completed_steps + 1];
    IF expected_step IS NULL OR p_step <> expected_step OR
       current_row.state <> 'pre_activation' OR
       p_expected_activation_boundary <> 'before' OR
       p_next_activation_boundary <> 'before' OR
       p_authoritative_system_identifier <> current_row.source_system_identifier THEN
      RAISE EXCEPTION 'release rollout pre-activation step out of order';
    END IF;
  ELSIF p_step NOT IN ('begin_compensation','effect_compensation','complete_compensation') AND
        current_row.state = 'activated' THEN
    SELECT count(*)::integer INTO completed_steps
    FROM release_authority.receipt WHERE rollout_id = p_rollout_id
      AND step IN ('cleanup_cutover_runner','resume_target_services',
        'verify_live_canary','verify_trusted_rollout');
    expected_step := (ARRAY[
      'cleanup_cutover_runner', 'resume_target_services',
      'verify_live_canary', 'verify_trusted_rollout'
    ])[completed_steps + 1];
    IF expected_step IS NULL OR p_step <> expected_step OR
       p_expected_activation_boundary <> 'activated' OR
       p_next_activation_boundary <> 'activated' OR
       p_authoritative_system_identifier <> current_row.target_system_identifier THEN
      RAISE EXCEPTION 'release rollout post-activation step out of order';
    END IF;
  ELSIF p_step NOT IN ('begin_compensation','effect_compensation','complete_compensation') THEN
    RAISE EXCEPTION 'release rollout step forbidden for authority state';
  END IF;
  INSERT INTO release_authority.receipt (
    receipt_sha256, rollout_id, step, provider_binding,
    previous_receipt_sha256, activation_boundary
  ) VALUES (
    p_next_receipt_sha256, p_rollout_id, p_step, p_provider_binding,
    p_expected_receipt_sha256, p_next_activation_boundary
  );
  UPDATE release_authority.rollout SET
    last_receipt_sha256 = p_next_receipt_sha256,
    authoritative_system_identifier = p_authoritative_system_identifier,
    state = CASE p_step
      WHEN 'begin_compensation' THEN 'compensating'::release_authority.aggregate_state
      WHEN 'complete_compensation' THEN 'compensated'::release_authority.aggregate_state
      ELSE current_row.state
    END,
    activation_boundary = p_next_activation_boundary,
    source_permanently_ineligible = p_next_activation_boundary <> 'before',
    updated_at = clock_timestamp()
  WHERE rollout_id = p_rollout_id;
  RETURN true;
END
$append$;

CREATE OR REPLACE FUNCTION release_authority.authorize_activation(
  p_rollout_id text,
  p_expected_commit_sha text,
  p_run_id text,
  p_run_attempt integer,
  p_source_system_identifier text,
  p_target_system_identifier text,
  p_job_id text,
  p_expected_receipt_sha256 text,
  p_target_deploy_ids jsonb,
  p_postgres_major integer,
  p_migration_checksum text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $authorize$
DECLARE current_row release_authority.rollout%ROWTYPE;
DECLARE authorization_result jsonb;
BEGIN
  SELECT * INTO current_row FROM release_authority.rollout
    WHERE rollout_id = p_rollout_id FOR UPDATE;
  IF NOT FOUND OR current_row.expected_commit_sha <> p_expected_commit_sha OR
     current_row.run_id <> p_run_id OR current_row.run_attempt <> p_run_attempt OR
     current_row.source_system_identifier <> p_source_system_identifier OR
     current_row.target_system_identifier <> p_target_system_identifier THEN
    RAISE EXCEPTION 'release authority activation identity conflict';
  END IF;
  IF jsonb_typeof(p_target_deploy_ids) <> 'array' OR
     jsonb_array_length(p_target_deploy_ids) = 0 OR
     p_postgres_major <> 17 OR
     coalesce(p_migration_checksum,'') !~ '^sha256:[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'release authority target deploy ids invalid';
  END IF;
  IF current_row.state <> 'pre_activation' THEN
    IF current_row.state IN ('activation_authorized','outcome_unknown','forward_repair_required','activated') AND
       current_row.activation_job_id = p_job_id AND
       current_row.activation_previous_receipt_sha256 = p_expected_receipt_sha256 AND
       current_row.activation_target_deploy_ids = p_target_deploy_ids AND
       current_row.activation_postgres_major = p_postgres_major AND
       current_row.activation_migration_checksum = p_migration_checksum THEN
      RETURN jsonb_build_object(
        'rolloutId', current_row.rollout_id,
        'expectedCommitSha', current_row.expected_commit_sha,
        'postgresMajor', current_row.activation_postgres_major,
        'migrationChecksum', current_row.activation_migration_checksum,
        'epoch', current_row.activation_epoch,
        'nonce', current_row.activation_permit_nonce,
        'sourceSystemIdentifier', current_row.source_system_identifier,
        'targetSystemIdentifier', current_row.target_system_identifier,
        'previousReceiptSha256', current_row.activation_previous_receipt_sha256,
        'targetDeployIds', current_row.activation_target_deploy_ids,
        'authorizedAt', current_row.activation_authorized_at
      );
    END IF;
    RAISE EXCEPTION 'release authority activation replay conflict';
  END IF;
  IF current_row.last_receipt_sha256 <> p_expected_receipt_sha256 THEN
    RAISE EXCEPTION 'release authority activation receipt conflict';
  END IF;
  IF current_row.activation_boundary <> 'before' OR
     to_regprocedure('release_authority.release_service_transition_activation_gate(text,jsonb)') IS NULL OR
     NOT release_authority.release_service_transition_activation_gate(p_rollout_id,p_target_deploy_ids) OR
     current_row.authoritative_system_identifier <> current_row.source_system_identifier OR
     current_row.source_permanently_ineligible OR
     EXISTS (
       WITH required(step, ordinal) AS (VALUES
         ('claim_rollout', 1), ('verify_protected_environment', 2),
         ('freeze_provider_services', 3), ('provision_role_runner', 4),
         ('quiesce_source', 5), ('capture_source_backup', 6),
         ('copy_database_generation', 7), ('bootstrap_target_roles', 8),
         ('verify_data_equivalence', 9), ('cleanup_role_runner', 10),
         ('provision_cutover_runner', 11), ('run_release_migration', 12),
         ('stage_target_services', 13)
       )
       SELECT 1 FROM required
       LEFT JOIN release_authority.receipt receipt
         ON receipt.rollout_id = current_row.rollout_id AND receipt.step = required.step
       LEFT JOIN release_authority.receipt previous
         ON previous.rollout_id = current_row.rollout_id
        AND previous.step = (SELECT step FROM required prior WHERE prior.ordinal = required.ordinal - 1)
       WHERE receipt.receipt_sha256 IS NULL OR
         receipt.previous_receipt_sha256 <> CASE WHEN required.ordinal = 1
           THEN 'sha256:' || repeat('0', 64) ELSE previous.receipt_sha256 END
     ) OR
     NOT EXISTS (
       SELECT 1 FROM release_authority.receipt
       WHERE rollout_id = current_row.rollout_id AND step = 'stage_target_services'
         AND receipt_sha256 = current_row.last_receipt_sha256
         AND provider_binding->'renderDeployIds' = p_target_deploy_ids
     ) THEN
    RAISE EXCEPTION 'release authority activation sequence incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM release_authority.runner_intent intent
    JOIN release_authority.runner_job job
      ON job.provisioning_intent_id = intent.intent_id
     AND job.rollout_id = intent.rollout_id
     AND job.lifecycle = intent.lifecycle
    WHERE intent.rollout_id = current_row.rollout_id
      AND intent.lifecycle = 'cutover'
      AND intent.workflow_job_id = p_job_id
      AND intent.registration_runner_id IS NOT NULL
      AND intent.registration_runner_group_id IS NOT NULL
      AND job.terminal_at IS NULL
      AND job.runner_identity IS NOT NULL
      AND job.provision_observation IS NOT NULL
      AND job.runner_identity->>'workflowJobId' = p_job_id
  ) THEN
    RAISE EXCEPTION 'release authority activation cutover runner binding denied';
  END IF;
  authorization_result := jsonb_build_object(
    'rolloutId', current_row.rollout_id,
    'expectedCommitSha', current_row.expected_commit_sha,
    'postgresMajor', p_postgres_major,
    'migrationChecksum', p_migration_checksum,
    'epoch', current_row.activation_epoch + 1,
    'nonce', replace(pg_catalog.gen_random_uuid()::text, '-', ''),
    'sourceSystemIdentifier', current_row.source_system_identifier,
    'targetSystemIdentifier', current_row.target_system_identifier,
    'previousReceiptSha256', current_row.last_receipt_sha256,
    'targetDeployIds', p_target_deploy_ids,
    'authorizedAt', date_trunc('milliseconds', clock_timestamp())
  );
  UPDATE release_authority.rollout SET
    state = 'activation_authorized',
    activation_boundary = 'uncertain',
    authoritative_system_identifier = target_system_identifier,
    source_permanently_ineligible = true,
    activation_epoch = (authorization_result->>'epoch')::bigint,
    activation_permit_nonce = authorization_result->>'nonce',
    activation_job_id = p_job_id,
    activation_previous_receipt_sha256 = p_expected_receipt_sha256,
    activation_target_deploy_ids = p_target_deploy_ids,
    activation_postgres_major = p_postgres_major,
    activation_migration_checksum = p_migration_checksum,
    activation_authorized_at = (authorization_result->>'authorizedAt')::timestamptz,
    updated_at = (authorization_result->>'authorizedAt')::timestamptz
  WHERE rollout_id = p_rollout_id;
  RETURN authorization_result;
END
$authorize$;

DO $schema_version_marker$
DECLARE marker jsonb := coalesce(pg_catalog.obj_description(
  'release_authority'::pg_catalog.regnamespace,'pg_namespace')::jsonb,'{}'::jsonb);
BEGIN
  EXECUTE pg_catalog.format('COMMENT ON SCHEMA release_authority IS %L',
    (marker||pg_catalog.jsonb_build_object('schemaVersion',16))::text);
END
$schema_version_marker$;

COMMIT;
