import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@reviewrouter/platform-db";
import type { ReleaseAuthorityDatabaseReadiness } from "../application/readiness.js";

export async function observeReleaseAuthorityDatabaseReadiness(
  prisma: PrismaClient,
): Promise<ReleaseAuthorityDatabaseReadiness> {
  const rows = await prisma.$queryRaw<ReleaseAuthorityDatabaseReadiness[]>(
    Prisma.sql`
      WITH facts AS (
        SELECT
          to_regprocedure('release_authority.release_service_transition_append(jsonb)') AS recovery_append,
          to_regprocedure('release_authority.release_service_transition_complete(jsonb)') AS recovery_complete,
          to_regprocedure('release_authority.release_source_resume_is_rollout_owned()') AS recovery_guard,
          to_regprocedure('release_authority.release_runner_persist_job(jsonb)') AS persist_job,
          to_regprocedure('release_authority.release_runner_reconcile_effect(jsonb)') AS reconcile_effect,
          to_regprocedure('release_authority.release_runner_compensation_gate()') AS compensation_gate,
          to_regprocedure('release_authority.release_compensation_effects_are_safe(text)') AS compensation_effects_safe,
          to_regprocedure('release_authority.release_compensation_receipt_effect_gate()') AS compensation_receipt_gate,
          to_regprocedure('release_authority.release_compensation_source_recovery_gate()') AS compensation_recovery_gate,
          to_regprocedure('release_authority.release_provider_authority_decide(jsonb)') AS provider_decide,
          to_regprocedure('release_authority.release_rollout_reconcile(text,jsonb)') AS rollout_reconcile,
          to_regprocedure('release_authority.release_rollout_compensation_checkpoint(text,text,text)') AS compensation_checkpoint,
          to_regprocedure('release_authority.release_schema_migration_manifest()') AS migration_manifest,
          to_regprocedure('release_authority.release_runner_persist_cleanup_witness(text,jsonb)') AS persist_cleanup_witness,
          to_regprocedure('release_authority.release_recovery_effect_intend(jsonb)') AS recovery_effect_intend,
          to_regprocedure('release_authority.release_recovery_effect_claim(jsonb)') AS recovery_effect_claim,
          to_regprocedure('release_authority.release_recovery_effect_consume(jsonb)') AS recovery_effect_consume,
          to_regprocedure('release_authority.release_recovery_effect_validate_execution(jsonb)') AS recovery_effect_validate_execution,
          to_regprocedure('release_authority.release_recovery_effect_reconcile(jsonb)') AS recovery_effect_reconcile,
          to_regprocedure('release_authority.release_recovery_effect_complete(jsonb)') AS recovery_effect_complete
      ), definitions AS (
        SELECT facts.*,
          coalesce(pg_get_functiondef(recovery_append), '') AS recovery_append_definition,
          coalesce(pg_get_functiondef(recovery_complete), '') AS recovery_complete_definition,
          coalesce(pg_get_functiondef(recovery_guard), '') AS recovery_guard_definition,
          coalesce(pg_get_functiondef(persist_job), '') AS persist_job_definition,
          coalesce(pg_get_functiondef(reconcile_effect), '') AS reconcile_effect_definition,
          coalesce(pg_get_functiondef(compensation_gate), '') AS compensation_gate_definition,
          coalesce(pg_get_functiondef(compensation_effects_safe), '') AS compensation_effects_safe_definition,
          coalesce(pg_get_functiondef(compensation_receipt_gate), '') AS compensation_receipt_gate_definition,
          coalesce(pg_get_functiondef(compensation_recovery_gate), '') AS compensation_recovery_gate_definition,
          coalesce(pg_get_functiondef(provider_decide), '') AS provider_decide_definition,
          coalesce(pg_get_functiondef(rollout_reconcile), '') AS rollout_reconcile_definition,
          coalesce(pg_get_functiondef(compensation_checkpoint), '') AS compensation_checkpoint_definition
          ,coalesce(pg_get_functiondef(persist_cleanup_witness), '') AS persist_cleanup_witness_definition
        FROM facts
      ), authority_functions AS (
        SELECT procedure.oid
        FROM pg_catalog.pg_proc procedure
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'release_authority'
      ), expected_acl(role_name, allowed, denied) AS (
        VALUES
          ('reviewrouter_release_control', ARRAY[
            to_regprocedure('release_authority.release_rollout_claim(text,text,text,integer,text,text)'),
            to_regprocedure('release_authority.release_rollout_append_receipt(text,text,text,integer,text,text,text,text,text,text,text,text,jsonb)'),
            to_regprocedure('release_authority.release_rollout_fence_target_switch(text,text,text,integer,text,text,text)'),
            to_regprocedure('release_authority.authorize_activation(text,text,text,integer,text,text,text,text,jsonb,integer,text)'),
            to_regprocedure('release_authority.observe_state(text,text,text)'),
            to_regprocedure('release_authority.release_runner_persist_registration(text,text,text,bigint,bigint,text[],text,text)'),
            to_regprocedure('release_authority.release_rollout_mark_activation_uncertain(text,text,text,integer,text,text)'),
            to_regprocedure('release_authority.release_rollout_activation_state(text,text,text)'),
            to_regprocedure('release_authority.release_rollout_verify_final_authority(text,text,text,integer,text,text,text,jsonb)'),
            to_regprocedure('release_authority.release_rollout_finalize_activation(jsonb,jsonb,text,jsonb)'),
            to_regprocedure('release_authority.release_runner_list_intents(text)'),
            to_regprocedure('release_authority.release_runner_persist_job(jsonb)'),
            to_regprocedure('release_authority.release_runner_list_open_jobs(text)'),
            to_regprocedure('release_authority.release_runner_persist_identity(text,jsonb,jsonb)'),
            to_regprocedure('release_authority.release_runner_current(text,text)'),
            to_regprocedure('release_authority.release_runner_mark_terminal(text,jsonb)'),
            to_regprocedure('release_authority.release_runner_cleanup_observation(text)'),
            to_regprocedure('release_authority.release_runner_cleanup_witness(text)'),
            to_regprocedure('release_authority.release_runner_terminal_cleanup_fact(text,text)'),
            to_regprocedure('release_authority.release_rollout_reconciliation_context(text)'),
            to_regprocedure('release_authority.release_rollout_compensation_checkpoint(text,text,text)'),
            to_regprocedure('release_authority.release_rollout_reconcile(text,jsonb)'),
            to_regprocedure('release_authority.release_runner_prepare_effect(jsonb)'),
            to_regprocedure('release_authority.release_runner_acquire_dispatch_permit(jsonb)'),
            to_regprocedure('release_authority.release_runner_reconcile_effect(jsonb)'),
            to_regprocedure('release_authority.release_runner_abandon_prepared(text,text,bigint)'),
            to_regprocedure('release_authority.release_service_transition_begin(jsonb)'),
            to_regprocedure('release_authority.release_service_transition_append(jsonb)'),
            to_regprocedure('release_authority.release_service_transition_read(text)'),
            to_regprocedure('release_authority.release_service_transition_contract(text)'),
            to_regprocedure('release_authority.release_service_transition_complete(jsonb)'),
            to_regprocedure('release_authority.release_service_transition_activation_gate(text,jsonb)'),
            to_regprocedure('release_authority.release_source_freeze_prepare(text,text,text,integer,text,text,text,text,timestamptz,jsonb,boolean)'),
            to_regprocedure('release_authority.release_source_freeze_record(text,text,text,integer,text,text,text,text,timestamptz,jsonb)'),
            to_regprocedure('release_authority.release_source_freeze_complete(text,text,text,integer,text,text,jsonb,timestamptz)'),
            to_regprocedure('release_authority.release_schema_migration_manifest()'),
            to_regprocedure('release_authority.release_recovery_effect_intend(jsonb)'),
            to_regprocedure('release_authority.release_recovery_effect_claim(jsonb)'),
            to_regprocedure('release_authority.release_recovery_effect_consume(jsonb)'),
            to_regprocedure('release_authority.release_recovery_effect_validate_execution(jsonb)'),
            to_regprocedure('release_authority.release_recovery_effect_complete(jsonb)'),
            to_regprocedure('release_authority.release_recovery_effect_reconcile(jsonb)')
          ]::oid[], ARRAY[
            to_regprocedure('release_authority.release_service_transition_immutable()')
          ]::oid[]),
          ('reviewrouter_provider_authority', ARRAY[
            to_regprocedure('release_authority.release_provider_authority_decide(jsonb)')
            ,to_regprocedure('release_authority.release_schema_migration_manifest()')
          ]::oid[], ARRAY[
            to_regprocedure('release_authority.release_service_transition_immutable()')
          ]::oid[]),
          ('reviewrouter_release_witness', ARRAY[
            to_regprocedure('release_authority.release_runner_cleanup_observation_seed(text)'),
            to_regprocedure('release_authority.release_runner_persist_cleanup_witness(text,jsonb)')
            ,to_regprocedure('release_authority.release_schema_migration_manifest()')
          ]::oid[], ARRAY[
            to_regprocedure('release_authority.release_service_transition_immutable()')
          ]::oid[])
      ), expected_function_acl AS (
        SELECT roles.oid AS grantee, allowed_function.object_oid,
          'EXECUTE'::text AS privilege_type, false AS is_grantable
        FROM expected_acl
        JOIN pg_catalog.pg_roles roles ON roles.rolname=expected_acl.role_name
        CROSS JOIN LATERAL unnest(expected_acl.allowed)
          AS allowed_function(object_oid)
      ), actual_function_acl AS (
        SELECT acl.grantee, procedure.oid AS object_oid,
          acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_proc procedure
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=procedure.pronamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
          procedure.proacl,pg_catalog.acldefault('f',procedure.proowner)
        )) acl
        WHERE namespace.nspname='release_authority'
          AND acl.grantee <> procedure.proowner
      ), expected_schema_acl AS (
        SELECT roles.oid AS grantee, 'USAGE'::text AS privilege_type,
          false AS is_grantable
        FROM expected_acl
        JOIN pg_catalog.pg_roles roles ON roles.rolname=expected_acl.role_name
      ), actual_schema_acl AS (
        SELECT acl.grantee,acl.privilege_type,acl.is_grantable
        FROM pg_catalog.pg_namespace namespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
          namespace.nspacl,pg_catalog.acldefault('n',namespace.nspowner)
        )) acl
        WHERE namespace.nspname='release_authority'
          AND acl.grantee <> namespace.nspowner
      ), unexpected_relation_acl AS (
        SELECT 1
        FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
          relation.relacl,pg_catalog.acldefault(
            CASE WHEN relation.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,
            relation.relowner
          )
        )) acl
        WHERE namespace.nspname='release_authority'
          AND relation.relkind IN ('r','p','v','m','S','f')
          AND acl.grantee <> relation.relowner
      ), acl_posture AS (
        SELECT
          (SELECT count(*)=3 AND bool_and(array_position(allowed,NULL) IS NULL)
             AND bool_and(array_position(denied,NULL) IS NULL) FROM expected_acl)
          AND (SELECT count(*)=3 FROM expected_acl
            JOIN pg_catalog.pg_roles roles ON roles.rolname=expected_acl.role_name)
          AND NOT EXISTS (
            (SELECT * FROM actual_function_acl EXCEPT SELECT * FROM expected_function_acl)
            UNION ALL
            (SELECT * FROM expected_function_acl EXCEPT SELECT * FROM actual_function_acl)
          )
          AND NOT EXISTS (
            (SELECT * FROM actual_schema_acl EXCEPT SELECT * FROM expected_schema_acl)
            UNION ALL
            (SELECT * FROM expected_schema_acl EXCEPT SELECT * FROM actual_schema_acl)
          )
          AND NOT EXISTS (SELECT 1 FROM unexpected_relation_acl)
          AS exact
      )
      SELECT current_user AS "roleName",
        (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier",
        current_setting('server_version_num')::integer / 10000 AS "postgresMajor",
        CASE WHEN definitions.recovery_append IS NOT NULL
          AND definitions.recovery_guard IS NOT NULL
          AND definitions.recovery_complete IS NOT NULL
          AND definitions.persist_job IS NOT NULL
          AND definitions.reconcile_effect IS NOT NULL
          AND definitions.compensation_gate IS NOT NULL
          AND definitions.compensation_effects_safe IS NOT NULL
          AND definitions.compensation_receipt_gate IS NOT NULL
          AND definitions.compensation_recovery_gate IS NOT NULL
          AND definitions.provider_decide IS NOT NULL
          AND definitions.rollout_reconcile IS NOT NULL
          AND definitions.compensation_checkpoint IS NOT NULL
          AND definitions.migration_manifest IS NOT NULL
          AND definitions.recovery_effect_intend IS NOT NULL
          AND definitions.recovery_effect_claim IS NOT NULL
          AND definitions.recovery_effect_consume IS NOT NULL
          AND definitions.recovery_effect_validate_execution IS NOT NULL
          AND definitions.recovery_effect_reconcile IS NOT NULL
          AND definitions.recovery_effect_complete IS NOT NULL
          AND (SELECT count(*) = 10 FROM pg_catalog.pg_class relation
            JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'release_authority'
              AND relation.relkind IN ('r','p')
              AND relation.relname IN (
                'rollout','receipt','runner_intent','runner_job',
                'provider_authority_decision','service_transition',
                'service_transition_checkpoint','source_freeze_observation',
                'source_freeze_completion','recovery_effect'
              ))
          AND (SELECT count(*) = 8 FROM pg_catalog.pg_attribute attribute
            JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
            JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'release_authority'
              AND relation.relname = 'runner_intent'
              AND attribute.attnum > 0 AND NOT attribute.attisdropped
              AND attribute.attname IN (
                'effect_state','effect_epoch','effect_owner',
                'effect_lease_expires_at','effect_dispatch_started_at',
                'effect_discovery_deadline','effect_safe_for_compensation',
                'effect_block_reason'
              ))
          THEN 10 ELSE 0 END AS "schemaVersion",
          '[]'::jsonb AS "migrationManifest",
        to_regprocedure('release_authority.release_rollout_claim(text,text,text,integer,text,text)') IS NOT NULL AS "controlRoutine",
        to_regprocedure('release_authority.release_provider_authority_decide(jsonb)') IS NOT NULL AS "providerRoutine",
        to_regprocedure('reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text)') IS NOT NULL AS "installerRoutine",
        to_regprocedure('reviewrouter_activation.read_activation_receipt(text)') IS NOT NULL AS "readerRoutine",
        to_regprocedure('release_authority.release_runner_prepare_effect(jsonb)') IS NOT NULL
          AND to_regprocedure('release_authority.release_runner_acquire_dispatch_permit(jsonb)') IS NOT NULL
          AND to_regprocedure('release_authority.release_runner_abandon_prepared(text,text,bigint)') IS NOT NULL
          AS "externalEffectProtocol",
        to_regprocedure('release_authority.release_source_freeze_prepare(text,text,text,integer,text,text,text,text,timestamptz,jsonb,boolean)') IS NOT NULL
          AND to_regprocedure('release_authority.release_source_freeze_record(text,text,text,integer,text,text,text,text,timestamptz,jsonb)') IS NOT NULL
          AND to_regprocedure('release_authority.release_source_freeze_complete(text,text,text,integer,text,text,jsonb,timestamptz)') IS NOT NULL
          AS "sourceFreezeProtocol",
        definitions.recovery_guard IS NOT NULL
          AND definitions.recovery_guard_definition LIKE '%NEW.step%source_resumed%'
          AND definitions.recovery_guard_definition LIKE '%phase%suspended%'
          AND definitions.recovery_guard_definition LIKE '%release source resume lacks rollout suspension evidence%'
          AND definitions.recovery_complete_definition LIKE '%release source recovery manifest mismatch%'
          AND definitions.recovery_complete_definition LIKE '%source_acl_restored%'
          AND definitions.recovery_complete_definition LIKE '%source_verified%'
          AND definitions.recovery_complete_definition LIKE '%source_resumed%'
          AS "selectiveRecoveryProtocol",
        definitions.persist_job_definition LIKE '%rolloutStateAtPersistence%'
          AND definitions.persist_job_definition LIKE '%rollout.state <> ''pre_activation''%'
          AND definitions.reconcile_effect_definition LIKE '%release runner reconciliation frozen%'
          AND definitions.reconcile_effect_definition LIKE '%unresolved_legacy%'
          AND definitions.compensation_gate_definition LIKE '%release runner duplicate effects unsafe for activation%'
          AND definitions.compensation_gate_definition LIKE '%release runner effects unsafe for compensation%'
          AND definitions.compensation_gate_definition LIKE '%release_compensation_effects_are_safe%'
          AND definitions.compensation_effects_safe_definition LIKE '%effect_safe_for_compensation%'
          AND definitions.compensation_effects_safe_definition LIKE '%count(*) > 1%'
          AND definitions.compensation_receipt_gate_definition LIKE '%effect_compensation%complete_compensation%'
          AND definitions.compensation_recovery_gate_definition LIKE '%restore_config_intent%source_resumed%'
          AND definitions.recovery_append_definition LIKE '%release_compensation_effects_are_safe%'
          AND definitions.recovery_append_definition LIKE '%rollout_row.state <> ''compensating''%'
          AND definitions.provider_decide_definition LIKE '%provider authority runner effects changed during compensation%'
          AND definitions.rollout_reconcile_definition LIKE '%release_compensation_effects_are_safe%'
          AND definitions.rollout_reconcile_definition LIKE '%sourceEligible%false%'
          AS "lateRunnerEffectProtocol",
        definitions.compensation_checkpoint_definition LIKE '%freeze_inventory_complete%'
          AND definitions.compensation_checkpoint_definition LIKE '%source_freeze_completion%'
          AND definitions.compensation_checkpoint_definition LIKE '%sourceFreeze%'
          AND definitions.compensation_checkpoint_definition LIKE '%phase%intent%'
          AND definitions.compensation_checkpoint_definition LIKE '%phase%suspended%'
          AND (SELECT procedure.prosecdef AND procedure.provolatile = 's'
            AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
            FROM pg_catalog.pg_proc procedure
            WHERE procedure.oid = definitions.compensation_checkpoint)
          AS "compensationCheckpointDefinition",
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute attribute
          JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'release_authority'
            AND relation.relname = 'runner_job'
            AND attribute.attname = 'provider_creation_not_before'
            AND attribute.attnotnull
            AND NOT attribute.attisdropped
        ) AND EXISTS (
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
        ) AS "runnerProviderBoundary",
        definitions.persist_cleanup_witness IS NOT NULL
          AND definitions.persist_cleanup_witness_definition
            LIKE '%providerCreatedAt%provider_creation_not_before%'
          AND definitions.persist_cleanup_witness_definition
            LIKE '%providerObservedAt%providerCreatedAt%'
          AND definitions.persist_cleanup_witness_definition
            LIKE '%providerObservedAt%clock_timestamp()%5 minutes%'
          AS "cleanupWitnessTemporalSemantics",
        definitions.recovery_effect_intend IS NOT NULL
          AND definitions.recovery_effect_claim IS NOT NULL
          AND definitions.recovery_effect_consume IS NOT NULL
          AND definitions.recovery_effect_validate_execution IS NOT NULL
          AND definitions.recovery_effect_reconcile IS NOT NULL
          AND definitions.recovery_effect_complete IS NOT NULL
          AND pg_get_functiondef(definitions.recovery_effect_consume) LIKE '%FOR UPDATE%'
          AND pg_get_functiondef(definitions.recovery_effect_consume) LIKE '%executionAuthorization%'
          AND pg_get_functiondef(definitions.recovery_effect_consume) LIKE '%execution_receipt%'
          AND pg_get_functiondef(definitions.recovery_effect_validate_execution) LIKE '%state=''executing''%'
          AND pg_get_functiondef(definitions.recovery_effect_validate_execution) LIKE '%execution_receipt_sha256%'
          AND pg_get_functiondef(definitions.recovery_effect_complete) LIKE '%state <> ''executing''%'
          AND pg_get_functiondef(definitions.recovery_effect_complete) LIKE '%execution_receipt_sha256%'
          AND pg_get_functiondef(definitions.recovery_effect_reconcile) LIKE '%state=''forward_repair''%'
          AND pg_get_functiondef(definitions.recovery_effect_consume) LIKE '%release_compensation_effects_are_safe%'
          AS "recoveryEffectProtocol",
        (SELECT count(*) = 12 AND bool_and(trigger.tgenabled = 'O')
          FROM pg_catalog.pg_trigger trigger
          JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'release_authority'
            AND NOT trigger.tgisinternal
            AND (relation.relname, trigger.tgname, trigger.tgfoid) IN (
              ('receipt', 'release_rollout_receipt_immutable_guard',
                to_regprocedure('release_authority.release_rollout_receipt_immutable()')),
              ('provider_authority_decision', 'release_provider_authority_decision_immutable_guard',
                to_regprocedure('release_authority.release_rollout_receipt_immutable()')),
              ('service_transition_checkpoint', 'release_service_transition_checkpoint_immutable_guard',
                to_regprocedure('release_authority.release_service_transition_immutable()')),
              ('runner_job', 'release_runner_terminal_effect_trigger',
                to_regprocedure('release_authority.release_runner_terminal_effect()')),
              ('rollout', 'release_runner_compensation_gate_trigger',
                definitions.compensation_gate),
              ('source_freeze_observation', 'release_source_freeze_immutable_guard',
                to_regprocedure('release_authority.release_source_freeze_immutable()')),
              ('source_freeze_completion', 'release_source_freeze_completion_immutable_guard',
                to_regprocedure('release_authority.release_source_freeze_immutable()')),
              ('service_transition_checkpoint', 'release_source_resume_rollout_ownership_guard',
                definitions.recovery_guard),
              ('receipt', 'release_compensation_receipt_effect_gate_trigger',
                definitions.compensation_receipt_gate),
              ('service_transition_checkpoint', 'release_compensation_source_recovery_gate_trigger',
                definitions.compensation_recovery_gate),
              ('runner_job', 'release_late_job_recovery_effect_gate_trigger',
                to_regprocedure('release_authority.release_late_job_recovery_effect_gate()')),
              ('service_transition_checkpoint', 'release_recovery_checkpoint_permit_gate_trigger',
                to_regprocedure('release_authority.release_recovery_checkpoint_permit_gate()'))
            )
        ) AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_trigger trigger
          JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'release_authority'
            AND relation.relname = 'service_transition_checkpoint'
            AND trigger.tgname = 'release_source_resume_rollout_ownership_guard'
            AND trigger.tgfoid = definitions.recovery_guard
            AND trigger.tgenabled = 'O' AND NOT trigger.tgisinternal
            AND pg_get_triggerdef(trigger.oid) LIKE '%BEFORE INSERT%FOR EACH ROW%'
        ) AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_trigger trigger
          JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'release_authority'
            AND relation.relname = 'rollout'
            AND trigger.tgname = 'release_runner_compensation_gate_trigger'
            AND trigger.tgfoid = definitions.compensation_gate
            AND trigger.tgenabled = 'O' AND NOT trigger.tgisinternal
            AND pg_get_triggerdef(trigger.oid) LIKE '%BEFORE UPDATE OF state%FOR EACH ROW%'
        ) AS "requiredTriggers",
        coalesce(acl_posture.exact, false) AS "authorityAclExact",
        (SELECT count(*) > 1 AND bool_and(object_owner = schema_owner)
          FROM (
            SELECT namespace.nspowner AS schema_owner,
              namespace.nspowner AS object_owner
            FROM pg_catalog.pg_namespace namespace
            WHERE namespace.nspname = 'release_authority'
            UNION ALL
            SELECT namespace.nspowner, relation.relowner
            FROM pg_catalog.pg_class relation
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'release_authority'
            UNION ALL
            SELECT namespace.nspowner, procedure.proowner
            FROM pg_catalog.pg_proc procedure
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'release_authority'
            UNION ALL
            SELECT namespace.nspowner, type_record.typowner
            FROM pg_catalog.pg_type type_record
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid = type_record.typnamespace
            WHERE namespace.nspname = 'release_authority'
          ) ownership
        ) AS "authorityOwnershipExact",
        NOT EXISTS (
          SELECT 1 FROM authority_functions functions
          CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
            (SELECT procedure.proacl FROM pg_catalog.pg_proc procedure WHERE procedure.oid = functions.oid),
            pg_catalog.acldefault('f', (SELECT procedure.proowner FROM pg_catalog.pg_proc procedure WHERE procedure.oid = functions.oid))
          )) acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_namespace namespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
            namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner)
          )) acl
          WHERE namespace.nspname = 'release_authority'
            AND acl.grantee = 0 AND acl.privilege_type IN ('USAGE','CREATE')
        )
          AS "publicAuthorityRevoked",
        NOT EXISTS (
          SELECT 1 FROM unexpected_relation_acl
        ) AS "authorityTablesRevoked"
      FROM definitions CROSS JOIN acl_posture
    `,
  );
  if (rows.length !== 1 || !rows[0])
    throw new Error("release_control_database_identity_unavailable");
  const readiness = rows[0];
  if (
    readiness.schemaVersion === 10 &&
    readiness.migrationManifest.length === 0
  ) {
    const manifestRows = await prisma.$queryRaw<
      Pick<ReleaseAuthorityDatabaseReadiness, "migrationManifest">[]
    >(Prisma.sql`
      SELECT release_authority.release_schema_migration_manifest()
        AS "migrationManifest"
    `);
    if (manifestRows.length !== 1 || !manifestRows[0])
      throw new Error("release_control_database_migration_history_unavailable");
    return {
      ...readiness,
      migrationManifest: manifestRows[0].migrationManifest,
    };
  }
  return readiness;
}
