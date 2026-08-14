-- Restore forward-only fixes that were accidentally folded into published
-- migrations, and establish durable ordered byte-identity evidence.
BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'release_authority'
      AND relation.relname = 'runner_job'
      AND attribute.attname = 'provider_creation_not_before'
      AND attribute.attnotnull
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint constraint_record
    JOIN pg_catalog.pg_class relation ON relation.oid = constraint_record.conrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'release_authority'
      AND relation.relname = 'runner_job'
      AND constraint_record.conname = 'runner_job_provider_creation_boundary'
      AND constraint_record.contype = 'c'
      AND constraint_record.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_record.oid)
        LIKE '%observed_at >= provider_creation_not_before%'
  ) OR to_regprocedure(
    'release_authority.release_compensation_effects_are_safe(text)'
  ) IS NULL OR to_regprocedure(
    'release_authority.release_compensation_receipt_effect_gate()'
  ) IS NULL OR to_regprocedure(
    'release_authority.release_compensation_source_recovery_gate()'
  ) IS NULL THEN
    RAISE EXCEPTION 'release authority migration 000009 prerequisite missing';
  END IF;
END
$preflight$;

CREATE TABLE release_authority.schema_migration (
  position integer PRIMARY KEY,
  migration_name text NOT NULL UNIQUE,
  checksum_sha256 text NOT NULL
    CHECK (checksum_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  byte_variant text NOT NULL CHECK (byte_variant IN ('canonical','legacy_equivalent')),
  applied_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON TABLE release_authority.schema_migration FROM PUBLIC;

DO $history$
DECLARE migration_000001_variant text;
DECLARE migration_000002_variant text;
BEGIN
  migration_000002_variant := CASE WHEN
    pg_catalog.pg_get_functiondef(to_regprocedure(
      'release_authority.release_runner_acquire_dispatch_permit(jsonb)'
    )) LIKE '%intent_rollout_id%'
    THEN 'legacy_equivalent' ELSE 'canonical' END;
  -- 000003 necessarily replaces the changed 000001 routine, so its final
  -- catalog text cannot identify the earlier bytes.  The two accidentally
  -- republished files were released as one pair; 000002 retains a durable
  -- distinguishing definition until this migration converges both repairs.
  migration_000001_variant := migration_000002_variant;

  INSERT INTO release_authority.schema_migration
    (position, migration_name, checksum_sha256, byte_variant)
  VALUES
    (1, '000001_release_authority',
      CASE migration_000001_variant WHEN 'legacy_equivalent'
        THEN 'sha256:e88a7cc8f29e91a86434bf14b4051f1fb17b5df02f8fc2dae6ec63d5792b398b'
        ELSE 'sha256:eb4039b43228a07c241593d4d6dd863eceac7731d5898b0264e9bc67b3d746cf' END,
      migration_000001_variant),
    (2, '000002_external_effect_protocol',
      CASE migration_000002_variant WHEN 'legacy_equivalent'
        THEN 'sha256:cd50e36c2b357fe03a81204b99f38c5c1e6b9ff94660dfecb9a2fccb782a512e'
        ELSE 'sha256:66a1cd48303f31691596ae4e64d952d0fe3543444d042b17243c1a60efb10201' END,
      migration_000002_variant),
    (3, '000002_transactional_service_transition',
      'sha256:5f52fdc1fcf6e37fabe9a69908d3c4e4bf82dfa6ab24c6b2ee9c4f3cda2a1099',
      'canonical'),
    (4, '000003_partial_source_freeze',
      'sha256:02dcd03e3d86c362598537e2ac7afc1dff2d20713fa01158f65e02db621d0da5',
      'canonical'),
    (5, '000004_selective_source_recovery',
      'sha256:c86e2546a9e135f5b23142a2ef1eb70bc12a0b41345f29abd5d2e5b7cbcaed97',
      'canonical'),
    (6, '000005_late_runner_effects',
      'sha256:35db45ebd364e6f8cbeafbfb0ab6ac0056fe7e51de2b5fe844b91f1207ba1cfb',
      'canonical'),
    (7, '000006_runner_provider_creation_boundary',
      'sha256:4ee3a75a1528870df6d66a24eded9fc588aed2681b82aef57335ad7bbadf1260',
      'canonical'),
    (8, '000007_compensation_effect_fence',
      'sha256:99e384395f93e2c82ea900fdfd86a810f5067bfafec5c32fe5ccd7d51a8d93a9',
      'canonical'),
    (9, '000008_trigger_helper_acl',
      'sha256:550e7c1e5f11bd795a867c03873d09a6b681c559f07b2101b8e8a3dbea3408c8',
      'canonical');
END
$history$;

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

CREATE OR REPLACE FUNCTION release_authority.release_runner_acquire_dispatch_permit(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE current_row release_authority.runner_intent%ROWTYPE;
DECLARE rollout_row release_authority.rollout%ROWTYPE;
DECLARE intent_rollout_id text;
BEGIN
  IF coalesce(p_input->>'claimantId','') !~ '^rrc-[0-9a-f-]{36}$'
    OR coalesce(p_input->>'startCommandSha256','') !~ '^sha256:[a-f0-9]{64}$'
    OR (p_input->>'expectedEpoch')::bigint < 0
    OR (p_input->>'leaseSeconds')::integer NOT BETWEEN 30 AND 300
  THEN RAISE EXCEPTION 'release runner dispatch permit invalid'; END IF;
  -- Resolve the parent without taking a row lock, then serialize every effect
  -- mutation in the single rollout -> intent order used by compensation.
  SELECT rollout_id INTO STRICT intent_rollout_id
    FROM release_authority.runner_intent WHERE intent_id = p_input->>'intentId';
  SELECT * INTO STRICT rollout_row FROM release_authority.rollout
    WHERE rollout_id = intent_rollout_id FOR UPDATE;
  SELECT * INTO STRICT current_row FROM release_authority.runner_intent
    WHERE intent_id = p_input->>'intentId' FOR UPDATE;
  IF current_row.rollout_id <> rollout_row.rollout_id
    THEN RAISE EXCEPTION 'release runner dispatch rollout conflict'; END IF;
  IF rollout_row.state <> 'pre_activation'
    THEN RAISE EXCEPTION 'release runner dispatch frozen'; END IF;
  IF current_row.start_command_sha256 <> p_input->>'startCommandSha256'
    THEN RAISE EXCEPTION 'release runner dispatch command conflict'; END IF;
  IF current_row.effect_state = 'prepared'
    AND current_row.effect_epoch = (p_input->>'expectedEpoch')::bigint
    AND current_row.effect_owner = p_input->>'claimantId'
    AND current_row.effect_lease_expires_at > clock_timestamp() THEN
    UPDATE release_authority.runner_intent SET
      effect_state = 'dispatching',
      effect_epoch = effect_epoch + 1,
      effect_dispatch_started_at = clock_timestamp(),
      effect_discovery_deadline = clock_timestamp() + interval '120 seconds',
      effect_lease_expires_at = NULL
    WHERE intent_id = current_row.intent_id RETURNING * INTO current_row;
  END IF;
  RETURN release_authority.release_runner_effect_snapshot(current_row);
END $body$;

CREATE OR REPLACE FUNCTION release_authority.release_runner_reconcile_effect(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE current_row release_authority.runner_intent%ROWTYPE;
DECLARE rollout_row release_authority.rollout%ROWTYPE;
DECLARE intent_rollout_id text;
DECLARE result text := p_input->'reconciliation'->>'result';
DECLARE reason text := p_input->'reconciliation'->>'reason';
BEGIN
  IF result IS NULL OR result NOT IN ('pending','blocked')
    OR p_input->'reconciliation'->>'safeForCompensation' IS DISTINCT FROM 'false'
  THEN RAISE EXCEPTION 'release runner reconciliation safety invalid'; END IF;
  SELECT rollout_id INTO STRICT intent_rollout_id
    FROM release_authority.runner_intent WHERE intent_id = p_input->>'intentId';
  SELECT * INTO STRICT rollout_row FROM release_authority.rollout
    WHERE rollout_id = intent_rollout_id FOR UPDATE;
  SELECT * INTO STRICT current_row FROM release_authority.runner_intent
    WHERE intent_id = p_input->>'intentId' FOR UPDATE;

  -- A late durable identity already projected its permanent safety fence.
  -- Permit only the exact idempotent blocked acknowledgement after activation
  -- or compensation; no bind, clean, or state restoration is reopened.
  IF current_row.effect_state = 'blocked'
    AND current_row.effect_block_reason IN ('duplicate','unresolved_legacy') THEN
    IF (result = 'blocked' AND reason = current_row.effect_block_reason)
      OR (result = 'pending' AND current_row.effect_block_reason = 'duplicate') THEN
      RETURN release_authority.release_runner_effect_snapshot(current_row);
    END IF;
    RAISE EXCEPTION 'release runner reconciliation frozen';
  END IF;
  IF current_row.effect_state = 'abandoned' THEN
    RETURN release_authority.release_runner_effect_snapshot(current_row);
  END IF;
  IF rollout_row.state <> 'pre_activation'
    THEN RAISE EXCEPTION 'release runner reconciliation frozen'; END IF;
  IF current_row.effect_state = 'cleaned'
    AND (result <> 'blocked' OR reason IN ('unknown','timeout'))
    THEN RETURN release_authority.release_runner_effect_snapshot(current_row); END IF;
  IF current_row.effect_state NOT IN ('dispatching','bound','cleaned','blocked')
    OR current_row.effect_epoch <> (p_input->>'expectedEpoch')::bigint
  THEN RAISE EXCEPTION 'release runner reconciliation fence conflict'; END IF;
  IF current_row.effect_state = 'blocked'
    AND current_row.effect_block_reason IN ('unknown','timeout') THEN
    UPDATE release_authority.runner_intent SET
      effect_state = CASE WHEN provider_job_id IS NULL THEN 'dispatching' ELSE 'bound' END,
      effect_safe_for_compensation = false, effect_block_reason = NULL
    WHERE intent_id = current_row.intent_id RETURNING * INTO current_row;
  END IF;

  IF result = 'blocked' THEN
    IF reason IS NULL OR reason NOT IN ('unknown','duplicate','timeout','unresolved_legacy')
      THEN RAISE EXCEPTION 'release runner reconciliation reason invalid'; END IF;
    IF reason IN ('duplicate','unresolved_legacy') THEN
      UPDATE release_authority.runner_intent SET effect_state = 'blocked',
        effect_safe_for_compensation = false, effect_block_reason = reason,
        reconciliation_observation = coalesce(p_input->'observation',
          jsonb_build_object('reason',reason,'lateProviderJobId',p_input->>'jobId')),
        reconciled_at = clock_timestamp()
      WHERE intent_id = current_row.intent_id RETURNING * INTO current_row;
    ELSE
      UPDATE release_authority.runner_intent SET
        effect_state = CASE WHEN provider_job_id IS NULL THEN 'dispatching' ELSE 'bound' END,
        effect_safe_for_compensation = false, effect_block_reason = NULL,
        reconciliation_observation = coalesce(p_input->'observation',
          jsonb_build_object('reason',reason,'lateProviderJobId',p_input->>'jobId')),
        reconciled_at = clock_timestamp()
      WHERE intent_id = current_row.intent_id RETURNING * INTO current_row;
    END IF;
  ELSIF result = 'pending' AND nullif(p_input->>'jobId','') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM release_authority.runner_job
      WHERE job_id = p_input->>'jobId'
        AND provisioning_intent_id = current_row.intent_id
        AND rollout_id = current_row.rollout_id
        AND service_id = current_row.service_id
        AND lifecycle = current_row.lifecycle
    ) THEN RAISE EXCEPTION 'release runner bind requires durable job'; END IF;
    UPDATE release_authority.runner_intent SET effect_state = 'bound',
      provider_job_id = p_input->>'jobId', outcome = 'bound',
      effect_safe_for_compensation = false, reconciled_at = clock_timestamp()
    WHERE intent_id = current_row.intent_id
      AND (provider_job_id IS NULL OR provider_job_id = p_input->>'jobId')
    RETURNING * INTO current_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'release runner reconciliation provider conflict'; END IF;
  ELSIF result = 'pending' THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'release runner reconciliation result invalid';
  END IF;
  RETURN release_authority.release_runner_effect_snapshot(current_row);
END $body$;

CREATE OR REPLACE FUNCTION release_authority.release_runner_abandon_prepared(
  p_intent_id text, p_owner text, p_expected_epoch bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE current_row release_authority.runner_intent%ROWTYPE;
DECLARE rollout_row release_authority.rollout%ROWTYPE;
DECLARE intent_rollout_id text;
BEGIN
  SELECT rollout_id INTO intent_rollout_id
    FROM release_authority.runner_intent WHERE intent_id = p_intent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'release runner prepared abandon conflict'; END IF;
  SELECT * INTO STRICT rollout_row FROM release_authority.rollout
    WHERE rollout_id = intent_rollout_id FOR UPDATE;
  SELECT * INTO STRICT current_row FROM release_authority.runner_intent
    WHERE intent_id = p_intent_id FOR UPDATE;
  IF current_row.rollout_id <> rollout_row.rollout_id
    OR rollout_row.state <> 'pre_activation'
    OR current_row.effect_state <> 'prepared'
    OR current_row.effect_owner <> p_owner
    OR current_row.effect_epoch <> p_expected_epoch
    OR current_row.effect_lease_expires_at > clock_timestamp()
  THEN RAISE EXCEPTION 'release runner prepared abandon conflict'; END IF;
  UPDATE release_authority.runner_intent SET effect_state = 'abandoned',
    effect_safe_for_compensation = true, effect_lease_expires_at = NULL
  WHERE intent_id = current_row.intent_id RETURNING * INTO current_row;
  RETURN release_authority.release_runner_effect_snapshot(current_row);
END $body$;

CREATE OR REPLACE FUNCTION release_authority.release_runner_terminal_effect() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF OLD.terminal_at IS NULL AND NEW.terminal_at IS NOT NULL THEN
    IF NOT release_authority.release_runner_job_cleanup_proven(NEW) THEN
      RAISE EXCEPTION 'release runner terminal cleanup witness unproven';
    END IF;
  END IF;
  RETURN NEW;
END $body$;

CREATE OR REPLACE FUNCTION release_authority.release_runner_mark_terminal(
  p_job_id text, p_observation jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE job release_authority.runner_job%ROWTYPE;
DECLARE intent release_authority.runner_intent%ROWTYPE;
DECLARE rollout release_authority.rollout%ROWTYPE;
DECLARE witness jsonb;
DECLARE job_rollout_id text;
DECLARE job_intent_id text;
BEGIN
  -- Read identifiers without locking, then take the canonical rollout ->
  -- intent -> job order.  The trigger only validates the witnessed transition;
  -- projection happens here while the parent locks are already held.
  SELECT rollout_id, provisioning_intent_id
    INTO job_rollout_id, job_intent_id
    FROM release_authority.runner_job WHERE job_id = p_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'release runner terminal job missing'; END IF;
  SELECT * INTO STRICT rollout FROM release_authority.rollout
    WHERE rollout_id = job_rollout_id FOR UPDATE;
  SELECT * INTO STRICT intent FROM release_authority.runner_intent
    WHERE intent_id = job_intent_id FOR UPDATE;
  SELECT * INTO job FROM release_authority.runner_job
    WHERE job_id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'release runner terminal job missing'; END IF;
  IF job.rollout_id <> rollout.rollout_id
    OR job.provisioning_intent_id <> intent.intent_id
    OR intent.rollout_id <> rollout.rollout_id
  THEN RAISE EXCEPTION 'release runner terminal identity conflict'; END IF;
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
  IF job.terminal_at IS NULL THEN
    UPDATE release_authority.runner_job SET terminal_at = clock_timestamp(),
      cleanup_observation = p_observation
    WHERE job_id = p_job_id AND terminal_at IS NULL
      AND cleanup_provider_witness = witness;
    IF NOT FOUND THEN RAISE EXCEPTION 'release runner terminal cas failed'; END IF;
  END IF;
  -- Independent terminal proof repairs retryable dispatch/bind and historical
  -- transient blocks.  Duplicate and unresolved legacy effects, or any intent
  -- with another durable provider identity, remain permanently fail-closed.
  UPDATE release_authority.runner_intent SET effect_state = 'cleaned',
    effect_safe_for_compensation = true, effect_block_reason = NULL,
    reconciled_at = clock_timestamp()
  WHERE intent_id = intent.intent_id
    AND (effect_state IN ('dispatching','bound') OR
      (effect_state = 'blocked' AND effect_block_reason IN ('unknown','timeout')))
    AND NOT EXISTS (
      SELECT 1 FROM release_authority.runner_job other
      WHERE other.provisioning_intent_id = intent.intent_id
        AND other.job_id <> job.job_id
    );
  RETURN true;
END $body$;

CREATE FUNCTION release_authority.release_schema_migration_manifest()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog
AS $manifest$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'position', position,
    'migrationName', migration_name,
    'checksumSha256', checksum_sha256,
    'byteVariant', byte_variant
  ) ORDER BY position), '[]'::jsonb)
  FROM release_authority.schema_migration
$manifest$;

REVOKE ALL ON FUNCTION
  release_authority.release_schema_migration_manifest() FROM PUBLIC;

DO $grants$
BEGIN
  IF to_regrole('reviewrouter_release_control') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION
      release_authority.release_schema_migration_manifest()
      TO reviewrouter_release_control;
  END IF;
  IF to_regrole('reviewrouter_provider_authority') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION
      release_authority.release_schema_migration_manifest()
      TO reviewrouter_provider_authority;
  END IF;
  IF to_regrole('reviewrouter_release_witness') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION
      release_authority.release_schema_migration_manifest()
      TO reviewrouter_release_witness;
  END IF;
END
$grants$;

COMMIT;
