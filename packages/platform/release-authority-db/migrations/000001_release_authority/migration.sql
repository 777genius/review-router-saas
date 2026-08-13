BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

CREATE SCHEMA release_authority;
REVOKE ALL ON SCHEMA release_authority FROM PUBLIC;

CREATE TYPE release_authority.aggregate_state AS ENUM (
  'pre_activation', 'compensating', 'compensated',
  'activation_authorized', 'activated', 'outcome_unknown',
  'forward_repair_required'
);

CREATE TABLE release_authority.rollout (
  "rollout_id" text PRIMARY KEY,
  "expected_commit_sha" text NOT NULL CHECK ("expected_commit_sha" ~ '^[a-f0-9]{40}$'),
  "run_id" text NOT NULL CHECK ("run_id" ~ '^[1-9][0-9]*$'),
  "run_attempt" integer NOT NULL CHECK ("run_attempt" = 1),
  "source_system_identifier" text NOT NULL CHECK ("source_system_identifier" ~ '^[0-9]+$'),
  "target_system_identifier" text NOT NULL CHECK ("target_system_identifier" ~ '^[0-9]+$'),
  "authoritative_system_identifier" text NOT NULL,
  "state" release_authority.aggregate_state NOT NULL DEFAULT 'pre_activation',
  "activation_boundary" text NOT NULL CHECK ("activation_boundary" IN ('before','uncertain','activated')),
  "source_permanently_ineligible" boolean NOT NULL DEFAULT false,
  "last_receipt_sha256" text NOT NULL CHECK ("last_receipt_sha256" ~ '^sha256:[a-f0-9]{64}$'),
  "claim_version" integer NOT NULL DEFAULT 1 CHECK ("claim_version" > 0),
  "target_switch_nonce" text CHECK ("target_switch_nonce" ~ '^[a-f0-9]{32}$'),
  "target_switch_version" integer NOT NULL DEFAULT 0 CHECK ("target_switch_version" >= 0),
  "target_switch_fenced_at" timestamptz(3),
  "activation_permit_nonce" text CHECK ("activation_permit_nonce" ~ '^[a-f0-9]{32}$'),
  "activation_epoch" bigint NOT NULL DEFAULT 0 CHECK ("activation_epoch" >= 0),
  "activation_job_id" text CHECK ("activation_job_id" ~ '^[1-9][0-9]*$'),
  "activation_previous_receipt_sha256" text CHECK ("activation_previous_receipt_sha256" ~ '^sha256:[a-f0-9]{64}$'),
  "activation_target_deploy_ids" jsonb,
  "activation_postgres_major" integer CHECK ("activation_postgres_major" = 17),
  "activation_migration_checksum" text CHECK ("activation_migration_checksum" ~ '^sha256:[a-f0-9]{64}$'),
  "activation_authorized_at" timestamptz(3),
  "activation_receipt" jsonb,
  "claimed_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CHECK ("source_system_identifier" <> "target_system_identifier"),
  CHECK ("authoritative_system_identifier" IN ("source_system_identifier","target_system_identifier")),
  CHECK (NOT "source_permanently_ineligible" OR "authoritative_system_identifier" = "target_system_identifier"),
  CHECK (
    ("state" IN ('pre_activation','compensating','compensated') AND
      "activation_boundary" = 'before' AND NOT "source_permanently_ineligible") OR
    ("state" IN ('activation_authorized','outcome_unknown','forward_repair_required') AND
      "activation_boundary" = 'uncertain' AND "source_permanently_ineligible") OR
    ("state" = 'activated' AND "activation_boundary" = 'activated' AND
      "source_permanently_ineligible")
  )
);

CREATE TABLE release_authority.receipt (
  "receipt_sha256" text PRIMARY KEY CHECK ("receipt_sha256" ~ '^sha256:[a-f0-9]{64}$'),
  "rollout_id" text NOT NULL REFERENCES release_authority.rollout("rollout_id") ON DELETE RESTRICT,
  "step" text NOT NULL,
  "provider_binding" jsonb,
  "previous_receipt_sha256" text NOT NULL CHECK ("previous_receipt_sha256" ~ '^sha256:[a-f0-9]{64}$'),
  "activation_boundary" text NOT NULL CHECK ("activation_boundary" IN ('before','activated')),
  "recorded_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("rollout_id","step")
);

CREATE TABLE release_authority.runner_intent (
  "intent_id" text PRIMARY KEY CHECK ("intent_id" ~ '^rri-[a-f0-9]{64}$'),
  "rollout_id" text NOT NULL REFERENCES release_authority.rollout("rollout_id") ON DELETE RESTRICT,
  "service_id" text NOT NULL,
  "lifecycle" text NOT NULL CHECK ("lifecycle" IN ('role','cutover')),
  "workflow_job_id" text NOT NULL CHECK ("workflow_job_id" ~ '^[1-9][0-9]*$'),
  "runner_name" text NOT NULL,
  "created_at" timestamptz(3) NOT NULL,
  "start_command_sha256" text NOT NULL CHECK ("start_command_sha256" ~ '^sha256:[a-f0-9]{64}$'),
  "creation_lease_owner" text,
  "creation_lease_expires_at" timestamptz(3),
  "first_no_match_observed_at" timestamptz(3),
  "last_no_match_observed_at" timestamptz(3),
  "no_match_probe_count" integer NOT NULL DEFAULT 0 CHECK ("no_match_probe_count" BETWEEN 0 AND 1000),
  "provider_job_id" text,
  "outcome" text CHECK ("outcome" IN ('bound','persistence_failed_cleaned','persistence_failed_unknown')),
  "reconciliation_observation" jsonb,
  "reconciled_at" timestamptz(3),
  "registration_runner_id" bigint CHECK ("registration_runner_id" > 0),
  "registration_runner_group_id" bigint CHECK ("registration_runner_group_id" > 0),
  "registration_labels" text[] NOT NULL DEFAULT '{}',
  "registration_unique_label" text,
  "registration_work_folder" text,
  UNIQUE ("rollout_id","lifecycle"),
  CHECK (("creation_lease_owner" IS NULL) = ("creation_lease_expires_at" IS NULL)),
  CHECK (("first_no_match_observed_at" IS NULL) = ("last_no_match_observed_at" IS NULL)),
  CHECK (("first_no_match_observed_at" IS NULL) = ("no_match_probe_count" = 0)),
  CHECK (
    ("registration_runner_id" IS NULL AND "registration_runner_group_id" IS NULL AND
     cardinality("registration_labels") = 0 AND "registration_unique_label" IS NULL AND
     "registration_work_folder" IS NULL) OR
    ("registration_runner_id" IS NOT NULL AND "registration_runner_group_id" IS NOT NULL AND
     cardinality("registration_labels") BETWEEN 1 AND 32 AND
     "registration_unique_label" ~ '^rr-[A-Za-z0-9][A-Za-z0-9._-]{1,125}$' AND
     "registration_unique_label" = ANY("registration_labels") AND
     "registration_work_folder" ~ '^_work/rr-[A-Za-z0-9][A-Za-z0-9._/-]{1,220}$')
  )
);

CREATE TABLE release_authority.runner_job (
  "job_id" text PRIMARY KEY,
  "rollout_id" text NOT NULL REFERENCES release_authority.rollout("rollout_id") ON DELETE RESTRICT,
  "provisioning_intent_id" text NOT NULL REFERENCES release_authority.runner_intent("intent_id") ON DELETE RESTRICT,
  "service_id" text NOT NULL,
  "observed_at" timestamptz(3) NOT NULL,
  "cleanup_canary" text NOT NULL,
  "lifecycle" text NOT NULL CHECK ("lifecycle" IN ('role','cutover')),
  "terminal_at" timestamptz(3),
  "cleanup_observation" jsonb,
  "cleanup_provider_witness" jsonb,
  "runner_identity" jsonb,
  "provision_observation" jsonb,
  UNIQUE ("rollout_id","lifecycle"),
  CHECK ("terminal_at" IS NULL OR "terminal_at" >= "observed_at"),
  CHECK ("terminal_at" IS NULL OR
    ("cleanup_observation" IS NOT NULL AND "cleanup_provider_witness" IS NOT NULL))
);

CREATE TABLE release_authority.provider_authority_decision (
  "decision_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "rollout_id" text NOT NULL REFERENCES release_authority.rollout("rollout_id") ON DELETE RESTRICT,
  "operation" text NOT NULL CHECK ("operation" IN ('deploy_target','resume_target','resume_source')),
  "source_system_identifier" text NOT NULL,
  "target_system_identifier" text NOT NULL,
  "expected_receipt_sha256" text NOT NULL CHECK ("expected_receipt_sha256" ~ '^sha256:[a-f0-9]{64}$'),
  "activation_boundary" text NOT NULL CHECK ("activation_boundary" IN ('before','activated')),
  "decided_at" timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  UNIQUE ("rollout_id", "operation"),
  CHECK ("source_system_identifier" <> "target_system_identifier")
);

CREATE FUNCTION release_authority.release_rollout_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $receipt_guard$
BEGIN
  RAISE EXCEPTION 'release rollout receipts are immutable';
END
$receipt_guard$;

CREATE TRIGGER "release_rollout_receipt_immutable_guard"
BEFORE UPDATE OR DELETE ON release_authority.receipt
FOR EACH ROW EXECUTE FUNCTION release_authority.release_rollout_receipt_immutable();

CREATE TRIGGER "release_provider_authority_decision_immutable_guard"
BEFORE UPDATE OR DELETE ON release_authority.provider_authority_decision
FOR EACH ROW EXECUTE FUNCTION release_authority.release_rollout_receipt_immutable();

CREATE FUNCTION release_authority.release_rollout_claim(
  p_rollout_id text,
  p_expected_commit_sha text,
  p_run_id text,
  p_run_attempt integer,
  p_source_system_identifier text,
  p_target_system_identifier text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $claim$
DECLARE existing release_authority.rollout%ROWTYPE;
BEGIN
  INSERT INTO release_authority.rollout (
    rollout_id, expected_commit_sha, run_id, run_attempt,
    source_system_identifier, target_system_identifier,
    authoritative_system_identifier, activation_boundary,
    source_permanently_ineligible, last_receipt_sha256
  ) VALUES (
    p_rollout_id, p_expected_commit_sha, p_run_id, p_run_attempt,
    p_source_system_identifier, p_target_system_identifier,
    p_source_system_identifier, 'before', false,
    'sha256:' || repeat('0', 64)
  ) ON CONFLICT (rollout_id) DO NOTHING;
  IF FOUND THEN RETURN 'claimed'; END IF;
  SELECT * INTO existing FROM release_authority.rollout
    WHERE rollout_id = p_rollout_id FOR UPDATE;
  IF existing.expected_commit_sha <> p_expected_commit_sha OR
     existing.run_id <> p_run_id OR existing.run_attempt <> p_run_attempt OR
     existing.source_system_identifier <> p_source_system_identifier OR
     existing.target_system_identifier <> p_target_system_identifier THEN
    RAISE EXCEPTION 'release rollout claim identity conflict';
  END IF;
  RETURN 'duplicate';
END
$claim$;

CREATE FUNCTION release_authority.release_rollout_append_receipt(
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
      'provision_role_runner', 'capture_source_backup', 'quiesce_source',
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

CREATE FUNCTION release_authority.release_rollout_fence_target_switch(
  p_rollout_id text,
  p_expected_commit_sha text,
  p_run_id text,
  p_run_attempt integer,
  p_source_system_identifier text,
  p_target_system_identifier text,
  p_expected_receipt_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $fence$
DECLARE current_row release_authority.rollout%ROWTYPE;
BEGIN
  SELECT * INTO current_row FROM release_authority.rollout
    WHERE rollout_id = p_rollout_id FOR UPDATE;
  IF NOT FOUND OR current_row.last_receipt_sha256 <> p_expected_receipt_sha256 OR
     current_row.activation_boundary <> 'before' OR current_row.target_switch_nonce IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF current_row.expected_commit_sha <> p_expected_commit_sha OR
     current_row.run_id <> p_run_id OR current_row.run_attempt <> p_run_attempt OR
     current_row.source_system_identifier <> p_source_system_identifier OR
     current_row.target_system_identifier <> p_target_system_identifier THEN RETURN NULL; END IF;
  current_row.target_switch_nonce := replace(pg_catalog.gen_random_uuid()::text, '-', '');
  current_row.target_switch_version := current_row.target_switch_version + 1;
  current_row.target_switch_fenced_at := clock_timestamp();
  UPDATE release_authority.rollout SET target_switch_nonce = current_row.target_switch_nonce,
    target_switch_version = current_row.target_switch_version,
    target_switch_fenced_at = current_row.target_switch_fenced_at,
    updated_at = current_row.target_switch_fenced_at WHERE rollout_id = p_rollout_id;
  RETURN jsonb_build_object('schemaVersion',1,'rolloutId',current_row.rollout_id,
    'expectedCommitSha',current_row.expected_commit_sha,'runId',current_row.run_id,
    'runAttempt',current_row.run_attempt,'sourceSystemIdentifier',current_row.source_system_identifier,
    'targetSystemIdentifier',current_row.target_system_identifier,
    'previousReceiptSha256',current_row.last_receipt_sha256,'nonce',current_row.target_switch_nonce,
    'version',current_row.target_switch_version,'fencedAt',current_row.target_switch_fenced_at);
END
$fence$;

CREATE FUNCTION release_authority.authorize_activation(
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
     current_row.authoritative_system_identifier <> current_row.source_system_identifier OR
     current_row.source_permanently_ineligible OR
     EXISTS (
       WITH required(step, ordinal) AS (VALUES
         ('claim_rollout', 1), ('verify_protected_environment', 2),
         ('freeze_provider_services', 3), ('provision_role_runner', 4),
         ('capture_source_backup', 5), ('quiesce_source', 6),
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

CREATE FUNCTION release_authority.observe_state(
  p_rollout_id text,
  p_source_system_identifier text,
  p_target_system_identifier text
) RETURNS text
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog
AS $state$
  SELECT state::text FROM release_authority.rollout
  WHERE rollout_id = p_rollout_id
    AND source_system_identifier = p_source_system_identifier
    AND target_system_identifier = p_target_system_identifier
$state$;

CREATE FUNCTION release_authority.release_provider_authority_decide(
  p_request jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $decision$
DECLARE current_row release_authority.rollout%ROWTYPE;
DECLARE existing release_authority.provider_authority_decision%ROWTYPE;
DECLARE required_state release_authority.aggregate_state;
DECLARE required_boundary text;
BEGIN
  IF jsonb_typeof(p_request) <> 'object' OR
     (SELECT count(*) FROM jsonb_object_keys(p_request)) <> 6 OR
     coalesce(p_request->>'rolloutId','') = '' OR
     coalesce(p_request->>'sourceSystemIdentifier','') = '' OR
     coalesce(p_request->>'targetSystemIdentifier','') = '' OR
     coalesce(p_request->>'expectedReceiptSha256','') !~ '^sha256:[a-f0-9]{64}$' OR
     p_request->>'operation' NOT IN ('deploy_target','resume_target','resume_source') OR
     p_request->>'activationBoundary' NOT IN ('before','activated') THEN
    RAISE EXCEPTION 'provider authority request invalid';
  END IF;
  SELECT * INTO current_row FROM release_authority.rollout
    WHERE rollout_id = p_request->>'rolloutId' FOR UPDATE;
  IF NOT FOUND OR current_row.source_system_identifier <> p_request->>'sourceSystemIdentifier' OR
     current_row.target_system_identifier <> p_request->>'targetSystemIdentifier' THEN
    RAISE EXCEPTION 'provider authority binding denied';
  END IF;
  SELECT * INTO existing FROM release_authority.provider_authority_decision
    WHERE rollout_id = current_row.rollout_id AND operation = p_request->>'operation';
  IF current_row.last_receipt_sha256 <> p_request->>'expectedReceiptSha256' THEN
    RAISE EXCEPTION 'provider authority receipt denied';
  END IF;
  required_state := CASE p_request->>'operation'
    WHEN 'deploy_target' THEN 'pre_activation'::release_authority.aggregate_state
    WHEN 'resume_target' THEN 'activated'::release_authority.aggregate_state
    WHEN 'resume_source' THEN 'compensating'::release_authority.aggregate_state
  END;
  required_boundary := CASE p_request->>'operation'
    WHEN 'resume_target' THEN 'activated' ELSE 'before' END;
  IF current_row.state <> required_state OR
     current_row.activation_boundary <> required_boundary OR
     p_request->>'activationBoundary' <> required_boundary OR
     (p_request->>'operation' = 'resume_source' AND current_row.authoritative_system_identifier <> current_row.source_system_identifier) THEN
    RAISE EXCEPTION 'provider authority state denied';
  END IF;
  IF existing.decision_id IS NOT NULL THEN
    IF existing.source_system_identifier <> p_request->>'sourceSystemIdentifier' OR
       existing.target_system_identifier <> p_request->>'targetSystemIdentifier' OR
       existing.expected_receipt_sha256 <> p_request->>'expectedReceiptSha256' OR
       existing.activation_boundary <> p_request->>'activationBoundary' THEN
      RAISE EXCEPTION 'provider authority replay conflict';
    END IF;
    RETURN p_request || jsonb_build_object('decision','allow',
      'decisionId',existing.decision_id,'decidedAt',existing.decided_at);
  END IF;
  INSERT INTO release_authority.provider_authority_decision
    (rollout_id, operation, source_system_identifier, target_system_identifier,
     expected_receipt_sha256, activation_boundary)
  VALUES (current_row.rollout_id, p_request->>'operation',
    current_row.source_system_identifier, current_row.target_system_identifier,
    current_row.last_receipt_sha256, required_boundary)
  RETURNING * INTO existing;
  RETURN p_request || jsonb_build_object('decision','allow',
    'decisionId',existing.decision_id,'decidedAt',existing.decided_at);
END
$decision$;

CREATE FUNCTION release_authority.release_runner_persist_registration(
  p_rollout_id text,
  p_lifecycle text,
  p_workflow_job_id text,
  p_runner_id bigint,
  p_runner_group_id bigint,
  p_labels text[],
  p_unique_label text,
  p_work_folder text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $registration$
DECLARE current_row release_authority.runner_intent%ROWTYPE;
BEGIN
  SELECT * INTO current_row FROM release_authority.runner_intent
    WHERE rollout_id = p_rollout_id AND lifecycle = p_lifecycle
      AND workflow_job_id = p_workflow_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF current_row.registration_runner_id IS NOT NULL THEN
    RETURN current_row.registration_runner_id = p_runner_id AND
      current_row.registration_runner_group_id = p_runner_group_id AND
      current_row.registration_labels = p_labels AND
      current_row.registration_unique_label = p_unique_label AND
      current_row.registration_work_folder = p_work_folder;
  END IF;
  UPDATE release_authority.runner_intent SET
    registration_runner_id = p_runner_id,
    registration_runner_group_id = p_runner_group_id,
    registration_labels = p_labels,
    registration_unique_label = p_unique_label,
    registration_work_folder = p_work_folder
  WHERE intent_id = current_row.intent_id;
  RETURN true;
END
$registration$;

CREATE FUNCTION release_authority.release_runner_cleanup_observation_seed(
  p_job_id text
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog
AS $seed$
  SELECT jsonb_build_object(
    'jobId', job_id,
    'serviceId', service_id,
    'cleanupCanary', cleanup_canary,
    'observedAt', to_char(observed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  FROM release_authority.runner_job
  WHERE job_id = p_job_id
$seed$;

CREATE FUNCTION release_authority.release_runner_persist_cleanup_witness(
  p_job_id text,
  p_witness jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $witness$
DECLARE current_row release_authority.runner_job%ROWTYPE;
BEGIN
  SELECT * INTO current_row FROM release_authority.runner_job
    WHERE job_id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF current_row.cleanup_provider_witness IS NOT NULL THEN
    RETURN current_row.cleanup_provider_witness = p_witness;
  END IF;
  IF p_witness->>'jobId' <> p_job_id OR p_witness->>'canary' <> current_row.cleanup_canary OR
     coalesce(p_witness->>'providerStatus','') NOT IN ('succeeded','failed','canceled') OR
     p_witness->>'containerTerminated' <> 'true' OR
     jsonb_typeof(p_witness->'removedPaths') <> 'array' OR
     jsonb_array_length(p_witness->'removedPaths') = 0 OR
     jsonb_typeof(p_witness->'remainingPaths') <> 'array' OR
     jsonb_array_length(p_witness->'remainingPaths') <> 0 OR
     coalesce(p_witness->>'logSha256','') !~ '^sha256:[a-f0-9]{64}$' OR
     coalesce(p_witness->>'providerLogId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' OR
     coalesce(p_witness->>'providerObservedAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$' OR
     (p_witness->>'providerObservedAt')::timestamptz < current_row.observed_at OR
     (p_witness->>'providerObservedAt')::timestamptz > clock_timestamp() + interval '5 minutes' OR
     EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_witness->'removedPaths') AS path
       WHERE path !~ '^/runner/_work/rr-[A-Za-z0-9][A-Za-z0-9._-]{1,125}(/[A-Za-z0-9][A-Za-z0-9._-]{0,127})*$') THEN
    RAISE EXCEPTION 'release runner cleanup witness invalid';
  END IF;
  UPDATE release_authority.runner_job
    SET cleanup_provider_witness = p_witness WHERE job_id = p_job_id;
  RETURN true;
END
$witness$;

CREATE FUNCTION release_authority.release_rollout_mark_activation_uncertain(
  p_rollout_id text, p_expected_commit_sha text, p_run_id text,
  p_run_attempt integer, p_source_system_identifier text,
  p_target_system_identifier text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
BEGIN
  UPDATE release_authority.rollout SET
    state = 'outcome_unknown',
    activation_boundary = 'uncertain',
    authoritative_system_identifier = target_system_identifier,
    source_permanently_ineligible = true, updated_at = clock_timestamp()
  WHERE rollout_id = p_rollout_id AND expected_commit_sha = p_expected_commit_sha
    AND run_id = p_run_id AND run_attempt = p_run_attempt
    AND source_system_identifier = p_source_system_identifier
    AND target_system_identifier = p_target_system_identifier
    AND state IN ('activation_authorized','outcome_unknown');
  RETURN FOUND;
END $body$;

CREATE FUNCTION release_authority.release_rollout_activation_state(
  p_rollout_id text, p_source_system_identifier text,
  p_target_system_identifier text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog
AS $body$
DECLARE result text;
BEGIN
  SELECT activation_boundary INTO STRICT result
  FROM release_authority.rollout
  WHERE rollout_id = p_rollout_id
    AND source_system_identifier = p_source_system_identifier
    AND target_system_identifier = p_target_system_identifier;
  RETURN result;
END $body$;

CREATE FUNCTION release_authority.release_rollout_verify_final_authority(
  p_rollout_id text, p_expected_commit_sha text, p_run_id text,
  p_run_attempt integer, p_source_system_identifier text,
  p_target_system_identifier text, p_expected_receipt_sha256 text,
  p_activation_receipt jsonb
) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog
AS $body$
  SELECT EXISTS (
    SELECT 1 FROM release_authority.rollout
    WHERE rollout_id = p_rollout_id AND expected_commit_sha = p_expected_commit_sha
      AND run_id = p_run_id AND run_attempt = p_run_attempt
      AND source_system_identifier = p_source_system_identifier
      AND target_system_identifier = p_target_system_identifier
      AND activation_boundary = 'activated' AND source_permanently_ineligible
      AND authoritative_system_identifier = p_target_system_identifier
      AND last_receipt_sha256 = p_expected_receipt_sha256
      AND activation_receipt = p_activation_receipt
  )
$body$;

CREATE FUNCTION release_authority.release_rollout_finalize_activation(
  p_authorization jsonb, p_provider jsonb, p_next_receipt_sha256 text,
  p_activation_receipt jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE current_row release_authority.rollout%ROWTYPE;
BEGIN
  SELECT * INTO current_row FROM release_authority.rollout
  WHERE rollout_id = p_authorization->>'rolloutId' FOR UPDATE;
  IF current_row.state = 'activated' THEN
    RETURN current_row.activation_epoch = (p_authorization->>'epoch')::bigint
      AND current_row.activation_permit_nonce = p_authorization->>'nonce'
      AND current_row.expected_commit_sha = p_authorization->>'expectedCommitSha'
      AND current_row.activation_postgres_major = (p_authorization->>'postgresMajor')::integer
      AND current_row.activation_migration_checksum = p_authorization->>'migrationChecksum'
      AND current_row.last_receipt_sha256 = p_next_receipt_sha256
      AND current_row.activation_target_deploy_ids = p_authorization->'targetDeployIds'
      AND current_row.activation_receipt = p_activation_receipt
      AND EXISTS (SELECT 1 FROM release_authority.receipt WHERE rollout_id = current_row.rollout_id
        AND step = 'activate_target_generation' AND receipt_sha256 = p_next_receipt_sha256
        AND provider_binding IS NOT DISTINCT FROM p_provider);
  END IF;
  IF NOT FOUND OR current_row.state NOT IN ('activation_authorized','outcome_unknown','forward_repair_required')
    OR current_row.source_system_identifier <> p_authorization->>'sourceSystemIdentifier'
    OR current_row.target_system_identifier <> p_authorization->>'targetSystemIdentifier'
    OR current_row.last_receipt_sha256 <> p_authorization->>'previousReceiptSha256'
    OR current_row.activation_boundary <> 'uncertain'
    OR current_row.activation_permit_nonce <> p_authorization->>'nonce'
    OR current_row.activation_epoch <> (p_authorization->>'epoch')::bigint
    OR current_row.expected_commit_sha <> p_authorization->>'expectedCommitSha'
    OR current_row.activation_postgres_major <> (p_authorization->>'postgresMajor')::integer
    OR current_row.activation_migration_checksum <> p_authorization->>'migrationChecksum'
    OR current_row.activation_target_deploy_ids <> p_authorization->'targetDeployIds'
    OR p_activation_receipt->>'permitNonce' <> p_authorization->>'nonce'
    OR (p_activation_receipt->>'permitEpoch')::bigint <> (p_authorization->>'epoch')::bigint
    OR p_activation_receipt->>'previousReceiptSha256' <> p_authorization->>'previousReceiptSha256'
    OR p_activation_receipt->'targetDeployIds' <> p_authorization->'targetDeployIds'
    OR coalesce(p_next_receipt_sha256,'') !~ '^sha256:[a-f0-9]{64}$'
  THEN RETURN false; END IF;
  INSERT INTO release_authority.receipt
    (receipt_sha256, rollout_id, step, provider_binding,
     previous_receipt_sha256, activation_boundary)
  VALUES (p_next_receipt_sha256, current_row.rollout_id,
    'activate_target_generation', p_provider, current_row.last_receipt_sha256,
    'activated');
  UPDATE release_authority.rollout SET state = 'activated', activation_boundary = 'activated',
    last_receipt_sha256 = p_next_receipt_sha256,
    activation_receipt = p_activation_receipt, updated_at = clock_timestamp()
  WHERE rollout_id = current_row.rollout_id;
  RETURN true;
END $body$;

CREATE FUNCTION release_authority.release_runner_persist_intent(p_intent jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE existing release_authority.runner_intent%ROWTYPE;
BEGIN
  IF coalesce(p_intent->>'creationLeaseOwner','') !~ '^rrc-[0-9a-f-]{36}$'
    OR coalesce(p_intent->>'startCommandSha256','') !~ '^sha256:[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'release runner intent creation lease invalid'; END IF;
  INSERT INTO release_authority.runner_intent
    (intent_id, rollout_id, service_id, lifecycle, workflow_job_id,
     runner_name, created_at, start_command_sha256, creation_lease_owner,
     creation_lease_expires_at)
  VALUES (p_intent->>'id', p_intent->>'rolloutId', p_intent->>'serviceId',
    p_intent->>'lifecycle', p_intent->>'workflowJobId',
    p_intent->>'runnerName', (p_intent->>'createdAt')::timestamptz,
    p_intent->>'startCommandSha256', p_intent->>'creationLeaseOwner',
    clock_timestamp() + interval '120 seconds')
  ON CONFLICT (intent_id) DO NOTHING;
  IF FOUND THEN RETURN 'created'; END IF;
  SELECT * INTO STRICT existing FROM release_authority.runner_intent
    WHERE intent_id = p_intent->>'id' FOR UPDATE;
  IF existing.rollout_id <> p_intent->>'rolloutId'
    OR existing.service_id <> p_intent->>'serviceId'
    OR existing.lifecycle <> p_intent->>'lifecycle'
    OR existing.workflow_job_id <> p_intent->>'workflowJobId'
    OR existing.runner_name <> p_intent->>'runnerName'
    OR existing.start_command_sha256 <> p_intent->>'startCommandSha256'
  THEN RAISE EXCEPTION 'release runner intent identity conflict'; END IF;
  RETURN 'existing';
END $body$;

CREATE FUNCTION release_authority.release_runner_list_intents(p_rollout_id text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog
AS $body$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', intent_id, 'rolloutId', rollout_id, 'serviceId', service_id,
    'lifecycle', lifecycle, 'workflowJobId', workflow_job_id,
    'runnerName', runner_name, 'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'startCommandSha256', start_command_sha256,
    'creationLeaseOwner', creation_lease_owner,
    'creationLeaseExpiresAt', to_char(creation_lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    ORDER BY created_at), '[]'::jsonb)
  FROM release_authority.runner_intent WHERE rollout_id = p_rollout_id
$body$;

CREATE FUNCTION release_authority.release_runner_claim_provider_creation(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE
  current_row release_authority.runner_intent%ROWTYPE;
  now_at timestamptz(3) := clock_timestamp();
  observed_at timestamptz(3) := (p_input->>'observedNoMatchAt')::timestamptz;
  lease_seconds integer := (p_input->>'leaseSeconds')::integer;
  grace_seconds integer := (p_input->>'discoveryGraceSeconds')::integer;
  next_expiry timestamptz(3);
BEGIN
  IF coalesce(p_input->>'claimantId','') !~ '^rrc-[0-9a-f-]{36}$'
    OR coalesce(p_input->>'startCommandSha256','') !~ '^sha256:[a-f0-9]{64}$'
    OR lease_seconds NOT BETWEEN 30 AND 300
    OR grace_seconds NOT BETWEEN 60 AND 600
    OR observed_at < now_at - interval '2 minutes'
    OR observed_at > now_at + interval '30 seconds'
  THEN RAISE EXCEPTION 'release runner provider creation claim invalid'; END IF;

  SELECT * INTO STRICT current_row FROM release_authority.runner_intent
    WHERE intent_id = p_input->>'intentId' FOR UPDATE;
  IF current_row.start_command_sha256 <> p_input->>'startCommandSha256'
  THEN RAISE EXCEPTION 'release runner provider creation command conflict'; END IF;
  IF current_row.provider_job_id IS NOT NULL
  THEN RETURN jsonb_build_object('result','bound'); END IF;
  IF current_row.creation_lease_expires_at IS NOT NULL
    AND current_row.creation_lease_expires_at > now_at
  THEN RETURN jsonb_build_object('result','held'); END IF;

  IF current_row.first_no_match_observed_at IS NULL THEN
    UPDATE release_authority.runner_intent SET
      first_no_match_observed_at = now_at,
      last_no_match_observed_at = now_at,
      no_match_probe_count = 1
    WHERE intent_id = current_row.intent_id;
    RETURN jsonb_build_object('result','discovery_grace');
  END IF;

  IF now_at < current_row.first_no_match_observed_at + make_interval(secs => grace_seconds) THEN
    UPDATE release_authority.runner_intent SET
      last_no_match_observed_at = now_at,
      no_match_probe_count = no_match_probe_count + 1
    WHERE intent_id = current_row.intent_id;
    RETURN jsonb_build_object('result','discovery_grace');
  END IF;

  next_expiry := now_at + make_interval(secs => lease_seconds);
  UPDATE release_authority.runner_intent SET
    creation_lease_owner = p_input->>'claimantId',
    creation_lease_expires_at = next_expiry,
    first_no_match_observed_at = NULL,
    last_no_match_observed_at = NULL,
    no_match_probe_count = 0
  WHERE intent_id = current_row.intent_id;
  RETURN jsonb_build_object(
    'result','acquired',
    'leaseExpiresAt',to_char(next_expiry AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $body$;

CREATE FUNCTION release_authority.release_runner_record_intent_outcome(p_input jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
BEGIN
  -- Exact deterministic provider discovery may bind after the creator crashed;
  -- job identity CAS, rather than stale lease ownership, authorizes reconciliation.
  UPDATE release_authority.runner_intent SET
    provider_job_id = p_input->>'jobId', outcome = p_input->>'outcome',
    reconciliation_observation = p_input->'observation',
    reconciled_at = clock_timestamp(), creation_lease_owner = NULL,
    creation_lease_expires_at = NULL, first_no_match_observed_at = NULL,
    last_no_match_observed_at = NULL, no_match_probe_count = 0
  WHERE intent_id = p_input->>'intentId'
    AND (provider_job_id IS NULL OR provider_job_id = p_input->>'jobId');
  IF NOT FOUND THEN RAISE EXCEPTION 'release runner intent outcome cas failed'; END IF;
  RETURN true;
END $body$;

CREATE FUNCTION release_authority.release_runner_persist_job(p_job jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
BEGIN
  INSERT INTO release_authority.runner_job
    (job_id, rollout_id, provisioning_intent_id, service_id, observed_at,
     cleanup_canary, lifecycle)
  VALUES (p_job->>'jobId', p_job->>'rolloutId', p_job->>'provisioningIntentId',
    p_job->>'serviceId', (p_job->>'observedAt')::timestamptz,
    p_job->>'cleanupCanary', p_job->>'lifecycle');
  RETURN true;
END $body$;

CREATE FUNCTION release_authority.release_runner_list_open_jobs(p_rollout_id text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog
AS $body$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'rolloutId', rollout_id, 'serviceId', service_id, 'jobId', job_id,
    'observedAt', to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'cleanupCanary', cleanup_canary, 'lifecycle', lifecycle,
    'provisioningIntentId', provisioning_intent_id) ORDER BY observed_at), '[]'::jsonb)
  FROM release_authority.runner_job
  WHERE rollout_id = p_rollout_id AND terminal_at IS NULL
$body$;

CREATE FUNCTION release_authority.release_runner_persist_identity(
  p_job_id text, p_identity jsonb, p_observation jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
BEGIN
  UPDATE release_authority.runner_job SET runner_identity = p_identity,
    provision_observation = p_observation
  WHERE job_id = p_job_id AND runner_identity IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'release runner identity cas failed'; END IF;
  RETURN true;
END $body$;

CREATE FUNCTION release_authority.release_runner_current(p_rollout_id text, p_lifecycle text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog
AS $body$
DECLARE result jsonb;
BEGIN
  SELECT jsonb_build_object('identity', runner_identity,
    'observation', provision_observation) INTO STRICT result
  FROM release_authority.runner_job
  WHERE rollout_id = p_rollout_id AND lifecycle = p_lifecycle;
  IF result->'identity' IS NULL OR result->'observation' IS NULL
    THEN RAISE EXCEPTION 'release runner identity missing'; END IF;
  RETURN result;
END $body$;

CREATE FUNCTION release_authority.release_runner_mark_terminal(p_job_id text, p_observation jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE job release_authority.runner_job%ROWTYPE; witness jsonb;
BEGIN
  SELECT * INTO job FROM release_authority.runner_job
  WHERE job_id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'release runner terminal job missing'; END IF;
  witness := job.cleanup_provider_witness;
  IF witness IS NULL OR witness->>'jobId' <> job.job_id
    OR witness->>'canary' <> job.cleanup_canary
    OR coalesce(witness->>'providerStatus','') NOT IN ('succeeded','failed','canceled')
    OR witness->>'containerTerminated' <> 'true'
    OR jsonb_typeof(witness->'removedPaths') <> 'array'
    OR jsonb_array_length(witness->'removedPaths') = 0
    OR jsonb_typeof(witness->'remainingPaths') <> 'array'
    OR jsonb_array_length(witness->'remainingPaths') <> 0
  THEN RAISE EXCEPTION 'release runner terminal cleanup witness unproven'; END IF;
  UPDATE release_authority.runner_job SET terminal_at = clock_timestamp(),
    cleanup_observation = p_observation
  WHERE job_id = p_job_id AND terminal_at IS NULL
    AND cleanup_provider_witness = witness;
  IF NOT FOUND THEN RAISE EXCEPTION 'release runner terminal cas failed'; END IF;
  RETURN true;
END $body$;

CREATE FUNCTION release_authority.release_runner_cleanup_observation(p_job_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog
AS $body$
DECLARE result jsonb;
BEGIN
  SELECT cleanup_observation INTO STRICT result
  FROM release_authority.runner_job WHERE job_id = p_job_id;
  IF result IS NULL THEN RAISE EXCEPTION 'release runner cleanup observation missing'; END IF;
  RETURN result;
END $body$;

CREATE FUNCTION release_authority.release_runner_cleanup_witness(p_job_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog
AS $body$
DECLARE job release_authority.runner_job%ROWTYPE; witness jsonb;
BEGIN
  SELECT * INTO STRICT job FROM release_authority.runner_job WHERE job_id = p_job_id;
  witness := job.cleanup_provider_witness;
  IF witness IS NULL OR witness->>'jobId' <> p_job_id
    OR witness->>'canary' <> job.cleanup_canary
    OR witness->>'containerTerminated' <> 'true'
    OR jsonb_array_length(witness->'remainingPaths') <> 0
  THEN RAISE EXCEPTION 'release runner independent cleanup witness unproven'; END IF;
  RETURN jsonb_build_object('providerStatus', witness->>'providerStatus',
    'listenerStopped', true, 'workspaceRemoved', true,
    'credentialProcessGone', true, 'canary', job.cleanup_canary,
    'observedAt', witness->>'providerObservedAt',
    'providerLogSha256', witness->>'logSha256',
    'removedPaths', witness->'removedPaths', 'remainingPaths', '[]'::jsonb);
END $body$;

CREATE FUNCTION release_authority.release_runner_terminal_cleanup_fact(
  p_rollout_id text, p_lifecycle text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog
AS $body$
DECLARE job release_authority.runner_job%ROWTYPE; witness jsonb;
BEGIN
  IF p_lifecycle NOT IN ('role','cutover') THEN
    RAISE EXCEPTION 'release runner lifecycle invalid';
  END IF;
  SELECT * INTO STRICT job FROM release_authority.runner_job
  WHERE rollout_id = p_rollout_id AND lifecycle = p_lifecycle;
  witness := job.cleanup_provider_witness;
  IF job.terminal_at IS NULL OR job.cleanup_observation IS NULL
    OR witness IS NULL OR witness->>'jobId' <> job.job_id
    OR witness->>'canary' <> job.cleanup_canary
    OR coalesce(witness->>'providerStatus','') NOT IN ('succeeded','failed','canceled')
    OR witness->>'containerTerminated' <> 'true'
    OR jsonb_typeof(witness->'removedPaths') <> 'array'
    OR jsonb_array_length(witness->'removedPaths') = 0
    OR jsonb_typeof(witness->'remainingPaths') <> 'array'
    OR jsonb_array_length(witness->'remainingPaths') <> 0
  THEN RAISE EXCEPTION 'release runner witness gated terminal cleanup unproven'; END IF;
  RETURN jsonb_build_object(
    'jobId', job.job_id, 'lifecycle', job.lifecycle,
    'canary', job.cleanup_canary,
    'terminalAt', to_char(job.terminal_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'observation', job.cleanup_observation,
    'witness', release_authority.release_runner_cleanup_witness(job.job_id));
END $body$;

CREATE FUNCTION release_authority.release_rollout_reconciliation_context(
  p_rollout_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog
AS $body$
DECLARE current_row release_authority.rollout%ROWTYPE;
DECLARE authorization_value jsonb;
DECLARE receipt_ordinal integer;
BEGIN
  SELECT * INTO STRICT current_row FROM release_authority.rollout
    WHERE rollout_id = p_rollout_id;
  SELECT count(*)::integer INTO receipt_ordinal
    FROM release_authority.receipt WHERE rollout_id = p_rollout_id;
  authorization_value := CASE WHEN current_row.activation_permit_nonce IS NULL THEN NULL
    ELSE jsonb_build_object(
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
      'authorizedAt', current_row.activation_authorized_at)
    END;
  RETURN jsonb_build_object(
    'rolloutId', current_row.rollout_id,
    'runId', current_row.run_id,
    'runAttempt', current_row.run_attempt,
    'state', current_row.state,
    'activationBoundary', current_row.activation_boundary,
    'receiptOrdinal', receipt_ordinal,
    'authorization', authorization_value);
END $body$;

CREATE FUNCTION release_authority.release_rollout_compensation_checkpoint(
  p_rollout_id text, p_source_system_identifier text,
  p_target_system_identifier text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog
AS $body$
DECLARE current_row release_authority.rollout%ROWTYPE;
DECLARE latest_receipt release_authority.receipt%ROWTYPE;
DECLARE receipt_count integer;
BEGIN
  SELECT * INTO STRICT current_row FROM release_authority.rollout
    WHERE rollout_id = p_rollout_id
      AND source_system_identifier = p_source_system_identifier
      AND target_system_identifier = p_target_system_identifier;
  SELECT count(*)::integer INTO receipt_count FROM release_authority.receipt
    WHERE rollout_id = p_rollout_id;
  SELECT * INTO latest_receipt FROM release_authority.receipt
    WHERE rollout_id = p_rollout_id ORDER BY ordinal DESC LIMIT 1;
  RETURN jsonb_build_object(
    'activationBoundary', current_row.activation_boundary,
    'state', current_row.state,
    'lastReceiptSha256', current_row.last_receipt_sha256,
    'lastStep', latest_receipt.step,
    'receiptCount', receipt_count);
END $body$;

CREATE FUNCTION release_authority.release_rollout_reconcile(
  p_rollout_id text, p_target_observation jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE current_row release_authority.rollout%ROWTYPE;
DECLARE open_jobs bigint; compensated boolean; finalized boolean;
BEGIN
  SELECT * INTO STRICT current_row FROM release_authority.rollout
    WHERE rollout_id = p_rollout_id FOR UPDATE;
  SELECT count(*) INTO open_jobs FROM release_authority.runner_job
    WHERE rollout_id = p_rollout_id AND terminal_at IS NULL;
  IF open_jobs <> 0 THEN RAISE EXCEPTION 'release rollout reconciliation open jobs'; END IF;
  IF current_row.activation_boundary = 'before' THEN
    IF current_row.state = 'compensating' THEN
      RETURN jsonb_build_object('state','pre_activation_recovery_required',
        'sourceEligible',false,'sourceAclRestored',false,
        'sourceServicesResumed',false,'openRunnerJobs',0);
    END IF;
    SELECT EXISTS (SELECT 1 FROM release_authority.receipt
      WHERE rollout_id = p_rollout_id AND step = 'complete_compensation') INTO compensated;
    IF NOT compensated THEN RAISE EXCEPTION 'release rollout compensation receipt missing'; END IF;
    RETURN jsonb_build_object('state','pre_activation_compensated','sourceEligible',true,
      'sourceAclRestored',true,'sourceServicesResumed',true,'openRunnerJobs',0);
  END IF;
  IF current_row.activation_boundary = 'uncertain' AND
     p_target_observation->>'kind' = 'matching_activation_receipt' THEN
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
      p_target_observation->'authorization',
      p_target_observation->'activationReceipt'->'provider',
      p_target_observation->>'nextReceiptSha256',
      p_target_observation->'activationReceipt') INTO finalized;
    IF NOT finalized THEN
      RAISE EXCEPTION 'release rollout reconciliation activation conflict';
    END IF;
    RETURN jsonb_build_object('state','activated','sourceEligible',false,
      'sourceAclRestored',false,'sourceServicesResumed',false,'openRunnerJobs',0);
  END IF;
  IF current_row.activation_boundary = 'uncertain' THEN
    UPDATE release_authority.rollout SET state = 'forward_repair_required',
      updated_at = clock_timestamp()
    WHERE rollout_id = p_rollout_id AND state IN (
      'activation_authorized','outcome_unknown');
  END IF;
  RETURN jsonb_build_object('state', CASE WHEN current_row.activation_boundary = 'activated'
    THEN 'activated' ELSE 'forward_repair_required' END,
    'reason', CASE WHEN current_row.activation_boundary = 'activated' THEN NULL
      ELSE p_target_observation->>'kind' END,
    'sourceEligible',false,'sourceAclRestored',false,
    'sourceServicesResumed',false,'openRunnerJobs',0);
END $body$;

REVOKE ALL ON TABLE release_authority.rollout FROM PUBLIC;
REVOKE ALL ON TABLE release_authority.receipt FROM PUBLIC;
REVOKE ALL ON TABLE release_authority.runner_intent FROM PUBLIC;
REVOKE ALL ON TABLE release_authority.runner_job FROM PUBLIC;
REVOKE ALL ON TABLE release_authority.provider_authority_decision FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_rollout_receipt_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_rollout_claim(text,text,text,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_rollout_append_receipt(text,text,text,integer,text,text,text,text,text,text,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_rollout_fence_target_switch(text,text,text,integer,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.authorize_activation(text,text,text,integer,text,text,text,text,jsonb,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.observe_state(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_provider_authority_decide(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_persist_registration(text,text,text,bigint,bigint,text[],text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_cleanup_observation_seed(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_persist_cleanup_witness(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_rollout_mark_activation_uncertain(text,text,text,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_rollout_activation_state(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_rollout_verify_final_authority(text,text,text,integer,text,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_rollout_finalize_activation(jsonb,jsonb,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_persist_intent(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_claim_provider_creation(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_list_intents(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_record_intent_outcome(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_persist_job(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_list_open_jobs(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_persist_identity(text,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_current(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_mark_terminal(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_cleanup_observation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_cleanup_witness(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_runner_terminal_cleanup_fact(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_rollout_reconciliation_context(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_rollout_compensation_checkpoint(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_authority.release_rollout_reconcile(text,jsonb) FROM PUBLIC;

DO $operational_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'reviewrouter_release_control') THEN
    GRANT USAGE ON SCHEMA release_authority TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_rollout_claim(text,text,text,integer,text,text) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_rollout_append_receipt(text,text,text,integer,text,text,text,text,text,text,text,text,jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_rollout_fence_target_switch(text,text,text,integer,text,text,text) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.authorize_activation(text,text,text,integer,text,text,text,text,jsonb,integer,text) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_persist_registration(text,text,text,bigint,bigint,text[],text,text) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_rollout_mark_activation_uncertain(text,text,text,integer,text,text) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_rollout_activation_state(text,text,text) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_rollout_verify_final_authority(text,text,text,integer,text,text,text,jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_rollout_finalize_activation(jsonb,jsonb,text,jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_persist_intent(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_claim_provider_creation(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_list_intents(text) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_record_intent_outcome(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_persist_job(jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_list_open_jobs(text) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_persist_identity(text,jsonb,jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_current(text,text) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_mark_terminal(text,jsonb) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_cleanup_observation(text) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_cleanup_witness(text) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_terminal_cleanup_fact(text,text) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_rollout_reconciliation_context(text) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_rollout_compensation_checkpoint(text,text,text) TO reviewrouter_release_control;
    GRANT EXECUTE ON FUNCTION release_authority.release_rollout_reconcile(text,jsonb) TO reviewrouter_release_control;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'reviewrouter_provider_authority') THEN
    GRANT USAGE ON SCHEMA release_authority TO reviewrouter_provider_authority;
    GRANT EXECUTE ON FUNCTION release_authority.release_provider_authority_decide(jsonb) TO reviewrouter_provider_authority;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'reviewrouter_release_witness') THEN
    GRANT USAGE ON SCHEMA release_authority TO reviewrouter_release_witness;
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_cleanup_observation_seed(text) TO reviewrouter_release_witness;
    GRANT EXECUTE ON FUNCTION release_authority.release_runner_persist_cleanup_witness(text,jsonb) TO reviewrouter_release_witness;
  END IF;
END
$operational_acl$;

COMMIT;
