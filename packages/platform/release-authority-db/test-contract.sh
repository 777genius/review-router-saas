#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../../.." && pwd)
name="rr-release-authority-pg17-$$"
docker run -d --rm --name "$name" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD=test postgres:17-alpine >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 60); do
  # The official image briefly exposes an init-only Unix socket before it
  # restarts into the final server. TCP becomes ready only for the final server.
  if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "CREATE ROLE reviewrouter_release_control LOGIN PASSWORD 'control'; CREATE ROLE reviewrouter_provider_authority LOGIN PASSWORD 'provider'; CREATE ROLE reviewrouter_release_witness LOGIN PASSWORD 'witness';"
docker cp "$root/packages/platform/release-authority-db/migrations/000001_release_authority/migration.sql" \
  "$name:/tmp/migration.sql" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/migration.sql >/dev/null
# Seed an unresolved v1 effect before the forward migration; it must fail closed.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r-legacy', repeat('9',40), '90', 1, '190', '290');
   SELECT release_authority.release_rollout_claim('r-legacy-cleaned', repeat('8',40), '89', 1, '189', '289');
   INSERT INTO release_authority.runner_intent(
     intent_id,rollout_id,service_id,lifecycle,workflow_job_id,runner_name,created_at,start_command_sha256)
   VALUES ('rri-'||repeat('9',64),'r-legacy','svc-legacy','role','990','rr-legacy',clock_timestamp(),'sha256:'||repeat('9',64));
   INSERT INTO release_authority.runner_intent(
     intent_id,rollout_id,service_id,lifecycle,workflow_job_id,runner_name,created_at,
     start_command_sha256,outcome,reconciliation_observation)
   VALUES ('rri-'||repeat('8',64),'r-legacy-cleaned','svc-legacy-cleaned','role','890',
     'rr-legacy-cleaned',clock_timestamp(),'sha256:'||repeat('8',64),
     'persistence_failed_cleaned',jsonb_build_object('safeForCompensation',true));" >/dev/null
docker cp "$root/packages/platform/release-authority-db/migrations/000002_external_effect_protocol/migration.sql" \
  "$name:/tmp/migration-000002.sql" >/dev/null

# A statement failure before COMMIT must leave none of migration 000002 behind.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c "CREATE DATABASE rr_atomic" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_atomic -f /tmp/migration.sql >/dev/null
docker exec "$name" sh -c \
  "sed 's/^COMMIT;$/SELECT definitely_missing_atomic_probe(); COMMIT;/' /tmp/migration-000002.sql > /tmp/migration-000002-fail.sql"
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_atomic \
  -f /tmp/migration-000002-fail.sql >/dev/null 2>&1; then
  echo "deliberately failed migration 000002 unexpectedly committed" >&2
  exit 1
fi
atomic_residue=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_atomic -Atc \
  "SELECT (SELECT count(*) FROM information_schema.columns
             WHERE table_schema='release_authority' AND table_name='runner_intent'
               AND column_name='effect_state')::text||':'||
          (SELECT count(*) FROM pg_catalog.pg_proc p
             JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='release_authority'
               AND p.proname IN ('release_runner_job_cleanup_proven',
                 'release_runner_effect_snapshot','release_runner_prepare_effect',
                 'release_runner_acquire_dispatch_permit','release_runner_reconcile_effect',
                 'release_runner_abandon_prepared','release_runner_terminal_effect',
                 'release_runner_compensation_gate'))::text||':'||
          (SELECT count(*) FROM pg_catalog.pg_trigger
             WHERE tgname IN ('release_runner_terminal_effect_trigger',
               'release_runner_compensation_gate_trigger'))::text||':'||
          (SELECT count(*) FROM pg_catalog.pg_indexes
             WHERE schemaname='release_authority'
               AND indexname='runner_job_rollout_id_lifecycle_idx')::text")
test "$atomic_residue" = 0:0:0:0

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/migration-000002.sql >/dev/null
docker cp "$root/packages/platform/release-authority-db/migrations/000002_transactional_service_transition/migration.sql" \
  "$name:/tmp/service-transition.sql" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/service-transition.sql >/dev/null
docker cp "$root/packages/platform/release-authority-db/migrations/000003_partial_source_freeze/migration.sql" \
  "$name:/tmp/migration-000003.sql" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/migration-000003.sql >/dev/null
docker cp "$root/packages/platform/release-authority-db/migrations/000004_selective_source_recovery/migration.sql" \
  "$name:/tmp/migration-000004.sql" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/migration-000004.sql >/dev/null
docker cp "$root/packages/platform/release-authority-db/migrations/000005_late_runner_effects/migration.sql" \
  "$name:/tmp/migration-000005.sql" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/migration-000005.sql >/dev/null
docker cp "$root/packages/platform/release-authority-db/migrations/000006_runner_provider_creation_boundary/migration.sql" \
  "$name:/tmp/migration-000006.sql" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/migration-000006.sql >/dev/null
docker cp "$root/packages/platform/release-authority-db/migrations/000007_compensation_effect_fence/migration.sql" \
  "$name:/tmp/migration-000007.sql" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/migration-000007.sql >/dev/null
docker cp "$root/packages/platform/release-authority-db/migrations/000008_trigger_helper_acl/migration.sql" \
  "$name:/tmp/migration-000008.sql" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/migration-000008.sql >/dev/null
docker cp "$root/packages/platform/release-authority-db/migrations/000009_authority_history_and_forward_repairs/migration.sql" \
  "$name:/tmp/migration-000009.sql" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/migration-000009.sql >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "INSERT INTO release_authority.schema_migration
     (position,migration_name,checksum_sha256,byte_variant)
   VALUES (10,'000009_authority_history_and_forward_repairs',
     'sha256:14ce6300054668f4bba3d9c7415ba34217791892bce86dc9d7dbe9203f8efaa7',
     'canonical')" >/dev/null
docker cp "$root/packages/platform/release-authority-db/migrations/000010_recovery_effect_permits/migration.sql" \
  "$name:/tmp/migration-000010.sql" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/migration-000010.sql >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "INSERT INTO release_authority.schema_migration
     (position,migration_name,checksum_sha256,byte_variant)
   VALUES (11,'000010_recovery_effect_permits',
     'sha256:a7f1f5063b83f53dfd95dda6bf70740fd2e586dbed368903d7098190cf6200fd',
     'canonical')" >/dev/null

postgres_port=$(docker port "$name" 5432/tcp | sed 's/.*://')
REVIEW_ROUTER_RELEASE_AUTHORITY_CONTROL_TEST_URL="postgresql://reviewrouter_release_control:control@127.0.0.1:$postgres_port/postgres" \
REVIEW_ROUTER_RELEASE_AUTHORITY_WITNESS_TEST_URL="postgresql://reviewrouter_release_witness:witness@127.0.0.1:$postgres_port/postgres" \
  pnpm exec vitest --configLoader runner run \
    apps/api/src/release-authority/adapters/postgres.real.test.ts

legacy_effect=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT effect_state||':'||effect_safe_for_compensation||':'||effect_block_reason||':'||
    (release_authority.release_runner_effect_snapshot(r)->'reconciliation'->>'result')
   FROM release_authority.runner_intent r WHERE intent_id='rri-'||repeat('9',64)")
test "$legacy_effect" = blocked:false:unresolved_legacy:blocked
legacy_claimed_clean=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT effect_state||':'||effect_safe_for_compensation||':'||effect_block_reason
   FROM release_authority.runner_intent WHERE intent_id='rri-'||repeat('8',64)")
test "$legacy_claimed_clean" = blocked:false:unresolved_legacy

first=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r1', repeat('a',40), '1', 1, '100', '200')")
duplicate=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r1', repeat('a',40), '1', 1, '100', '200')")
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "DO \$\$
   DECLARE steps text[] := ARRAY[
     'claim_rollout','verify_protected_environment','freeze_provider_services',
     'provision_role_runner','capture_source_backup','quiesce_source',
     'copy_database_generation','bootstrap_target_roles','verify_data_equivalence',
     'cleanup_role_runner','provision_cutover_runner','run_release_migration',
     'stage_target_services'];
   DECLARE previous_sha text := 'sha256:'||repeat('0',64);
   DECLARE next_sha text;
   BEGIN
     FOR index IN 1..cardinality(steps) LOOP
       next_sha := 'sha256:'||lpad(index::text,64,'0');
       IF NOT release_authority.release_rollout_append_receipt(
         'r1',repeat('a',40),'1',1,'100','200',steps[index],previous_sha,next_sha,
         '100','before','before',CASE WHEN steps[index] = 'stage_target_services'
           THEN jsonb_build_object(
             'renderDeployIds','[\"dep-srv-a\",\"dep-srv-b\",\"dep-srv-c\"]'::jsonb,
             'serviceRecoveryManifestSha256','sha256:'||repeat('a',64),
             'targetServiceContractSha256','sha256:'||repeat('b',64))
           ELSE NULL END) THEN
         RAISE EXCEPTION 'legal receipt sequence rejected at %', steps[index];
       END IF;
       previous_sha := next_sha;
     END LOOP;
   END \$\$;
   INSERT INTO release_authority.runner_intent(
     intent_id,rollout_id,service_id,lifecycle,workflow_job_id,runner_name,created_at,
     start_command_sha256,
     registration_runner_id,registration_runner_group_id,registration_labels,
     registration_unique_label,registration_work_folder)
   VALUES ('rri-'||repeat('1',64),'r1','svc','cutover','9','rr-cutover','$now',
     'sha256:'||repeat('1',64),
     91,92,ARRAY['self-hosted','rr-cutover'],'rr-cutover','_work/rr-cutover');
   INSERT INTO release_authority.runner_job(
     job_id,rollout_id,provisioning_intent_id,service_id,observed_at,provider_creation_not_before,cleanup_canary,
     lifecycle,runner_identity,provision_observation)
   VALUES ('job-cutover','r1','rri-'||repeat('1',64),'svc','$now','$now','canary','cutover',
     '{\"workflowJobId\":\"9\"}','{\"step\":\"provision_cutover_runner\"}');" >/dev/null
manifest_sha="sha256:$(printf 'a%.0s' $(seq 1 64))"
target_contract_sha="sha256:$(printf 'b%.0s' $(seq 1 64))"
transition_input='{"rolloutId":"r1","manifestSha256":"'$manifest_sha'","targetContractSha256":"'$target_contract_sha'","serviceIds":["srv-a","srv-b","srv-c"],"sourceManifest":{"manifestSha256":"'$manifest_sha'","services":[]},"targetContracts":[{"serviceId":"srv-a"},{"serviceId":"srv-b"},{"serviceId":"srv-c"}]}'
transition_created=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_service_transition_begin('$transition_input')")
test "$transition_created" = created
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_service_transition_contract('missing') IS NULL")" = t
for service in srv-a srv-b srv-c; do
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
    "SELECT release_authority.release_service_transition_append(jsonb_build_object('rolloutId','r1','manifestSha256','$manifest_sha','targetContractSha256','$target_contract_sha','serviceId','$service','step','suspend_intent'))" >/dev/null
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
    "SELECT release_authority.release_service_transition_append(jsonb_build_object('rolloutId','r1','manifestSha256','$manifest_sha','targetContractSha256','$target_contract_sha','serviceId','$service','step','suspended'))" >/dev/null
  for step in target_config_intent target_configured target_env_intent target_env_applied target_deploy_intent target_deployed target_verified; do
    deploy_id=NULL
    observed_contract=NULL
    observed_env=NULL
    if [ "$step" = target_deployed ] || [ "$step" = target_verified ]; then deploy_id="to_jsonb('dep-$service'::text)"; fi
    if [ "$step" = target_verified ]; then
      observed_contract="to_jsonb('sha256:$(printf 'c%.0s' $(seq 1 64))'::text)"
      observed_env="to_jsonb('sha256:$(printf 'd%.0s' $(seq 1 64))'::text)"
    fi
    docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
      "SELECT release_authority.release_service_transition_append(jsonb_build_object('rolloutId','r1','manifestSha256','$manifest_sha','targetContractSha256','$target_contract_sha','serviceId','$service','step','$step','deployId',$deploy_id,'observedContractSha256',$observed_contract,'observedEnvSha256',$observed_env))" >/dev/null
  done
done
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_service_transition_complete('{\"rolloutId\":\"r1\",\"outcome\":\"target_staged\"}')" >/dev/null
stage_receipt="sha256:$(printf '%064d' 13)"
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.authorize_activation('r1', repeat('a',40), '1', 1, '100', '200', '10', '$stage_receipt', '[\"dep-srv-a\",\"dep-srv-b\",\"dep-srv-c\"]', 17, 'sha256:'||repeat('7',64))" >/dev/null 2>&1; then
  echo "activation with an unbound cutover workflow job unexpectedly succeeded" >&2
  exit 1
fi
authorization=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.authorize_activation('r1', repeat('a',40), '1', 1, '100', '200', '9', '$stage_receipt', '[\"dep-srv-a\",\"dep-srv-b\",\"dep-srv-c\"]', 17, 'sha256:'||repeat('7',64))")
replay=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.authorize_activation('r1', repeat('a',40), '1', 1, '100', '200', '9', '$stage_receipt', '[\"dep-srv-a\",\"dep-srv-b\",\"dep-srv-c\"]', 17, 'sha256:'||repeat('7',64))")
state=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT state||':'||activation_epoch||':'||source_permanently_ineligible FROM release_authority.rollout WHERE rollout_id='r1'")

test "$first" = claimed
test "$duplicate" = duplicate
test "$authorization" = "$replay"
test "$state" = activation_authorized:1:true

# Adversarial external-effect state machine: the durable permit is the only POST authority.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r-effect', repeat('e',40), '81', 1, '181', '281')" >/dev/null
effect_intent='{"id":"rri-'$(printf '2%.0s' $(seq 1 64))'","rolloutId":"r-effect","serviceId":"svc-effect","lifecycle":"role","workflowJobId":"811","runnerName":"rr-effect","createdAt":"'$now'","startCommandSha256":"sha256:'$(printf '3%.0s' $(seq 1 64))'","creationLeaseOwner":"rrc-00000000-0000-4000-8000-000000000011"}'
prepared_effect=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_prepare_effect('$effect_intent')->>'state'")
test "$prepared_effect" = prepared
prepared_listing=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT (intent->>'state')||':'||(listed->>'creationLeaseOwner')||':'||
      ((listed->>'creationLeaseExpiresAt') IS NOT NULL)
   FROM (SELECT release_authority.release_runner_list_intents('r-effect')->0 listed) value,
        LATERAL (SELECT listed->'effect' intent) effect")
test "$prepared_listing" = prepared:rrc-00000000-0000-4000-8000-000000000011:true
permit_input_a='{"intentId":"rri-'$(printf '2%.0s' $(seq 1 64))'","claimantId":"rrc-00000000-0000-4000-8000-000000000011","startCommandSha256":"sha256:'$(printf '3%.0s' $(seq 1 64))'","expectedEpoch":0,"leaseSeconds":120}'
permit_input_b='{"intentId":"rri-'$(printf '2%.0s' $(seq 1 64))'","claimantId":"rrc-00000000-0000-4000-8000-000000000012","startCommandSha256":"sha256:'$(printf '3%.0s' $(seq 1 64))'","expectedEpoch":0,"leaseSeconds":120}'
# Hold the parent lock, then reach for the child. A routine that takes the
# intent first deadlocks this adversary; rollout-first waits without retaining
# a conflicting child lock and completes on PostgreSQL 17.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc \
  "BEGIN;
   SELECT 1 FROM release_authority.rollout WHERE rollout_id='r-effect' FOR UPDATE;
   SELECT pg_catalog.pg_advisory_xact_lock(810001);
   SELECT pg_catalog.pg_sleep(2);
   SELECT 1 FROM release_authority.runner_intent
     WHERE intent_id='rri-'||repeat('2',64) FOR UPDATE;
   COMMIT" >/dev/null &
acquire_order_pid=$!
acquire_order_ready=false
for _ in $(seq 1 100); do
  if test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks
      WHERE locktype='advisory' AND objid=810001 AND granted)")" = t; then
    acquire_order_ready=true
    break
  fi
  sleep 0.05
done
test "$acquire_order_ready" = true
permit_a=$(docker exec -e PGPASSWORD=control -e PGOPTIONS='-c lock_timeout=10s' "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT (release_authority.release_runner_acquire_dispatch_permit('$permit_input_a')->>'state')||':'||(release_authority.release_runner_acquire_dispatch_permit('$permit_input_a')->>'ownerId')")
wait "$acquire_order_pid"
test "$permit_a" = dispatching:rrc-00000000-0000-4000-8000-000000000011
dispatching_listing=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT (intent->>'state')||':'||(listed->>'creationLeaseOwner')||':'||
      ((listed->>'creationLeaseExpiresAt') IS NOT NULL)
   FROM (SELECT release_authority.release_runner_list_intents('r-effect')->0 listed) value,
        LATERAL (SELECT listed->'effect' intent) effect")
test "$dispatching_listing" = dispatching:rrc-00000000-0000-4000-8000-000000000011:false
permit_b=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT (release_authority.release_runner_acquire_dispatch_permit('$permit_input_b')->>'state')||':'||(release_authority.release_runner_acquire_dispatch_permit('$permit_input_b')->>'ownerId')")
test "$permit_b" = dispatching:rrc-00000000-0000-4000-8000-000000000011

# A lost/delayed response remains dispatching; discovery may bind, but no lease can redrive POST.
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-effect','rolloutId','r-effect','provisioningIntentId','rri-'||repeat('2',64),
    'serviceId','svc-effect','observedAt','$now','providerCreationNotBefore','$now','cleanupCanary','rr-cleanup:r-effect:rr-effect',
    'lifecycle','role'))" >/dev/null
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-effect','rolloutId','r-effect','provisioningIntentId','rri-'||repeat('2',64),
    'serviceId','svc-effect','observedAt','$now','providerCreationNotBefore','2000-01-01T00:00:00.000Z',
    'cleanupCanary','rr-cleanup:r-effect:rr-effect','lifecycle','role'))" >/dev/null 2>&1; then
  echo "runner job replay weakened its provider creation boundary" >&2
  exit 1
fi
# A lost HTTP response may replay the identical durable job write, but a
# conflicting identity must remain impossible.
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-effect','rolloutId','r-effect','provisioningIntentId','rri-'||repeat('2',64),
    'serviceId','svc-effect','observedAt','$now','providerCreationNotBefore','$now','cleanupCanary','rr-cleanup:r-effect:rr-effect',
    'lifecycle','role'))" >/dev/null
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-effect','rolloutId','r-effect','provisioningIntentId','rri-'||repeat('2',64),
    'serviceId','svc-effect','observedAt','$now','providerCreationNotBefore','$now','cleanupCanary','rr-cleanup:r-effect:conflict',
    'lifecycle','role'))" >/dev/null 2>&1; then
  echo "conflicting runner job replay unexpectedly succeeded" >&2
  exit 1
fi
bound_effect=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_reconcile_effect(
    '{\"intentId\":\"rri-$(printf '2%.0s' $(seq 1 64))\",\"claimantId\":\"rrc-00000000-0000-4000-8000-000000000099\",\"expectedEpoch\":1,\"jobId\":\"job-effect\",\"reconciliation\":{\"result\":\"pending\",\"safeForCompensation\":false}}')->>'state'")
test "$bound_effect" = bound
bound_listing=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT (intent->>'state')||':'||(listed->>'creationLeaseOwner')||':'||
      ((listed->>'creationLeaseExpiresAt') IS NOT NULL)
   FROM (SELECT release_authority.release_runner_list_intents('r-effect')->0 listed) value,
        LATERAL (SELECT listed->'effect' intent) effect")
test "$bound_listing" = bound:rrc-00000000-0000-4000-8000-000000000011:false
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_reconcile_effect(jsonb_build_object(
    'intentId','rri-'||repeat('2',64),'claimantId','rrc-00000000-0000-4000-8000-000000000099',
    'expectedEpoch',1,'jobId','job-effect',
    'reconciliation',jsonb_build_object('result','clean','safeForCompensation',true),
    'observation',jsonb_build_object('step','cleanup_role_runner',
      'provider',jsonb_build_object('renderJobId','job-effect'),
      'facts',jsonb_build_object(
        'provider',jsonb_build_object('id','job-effect','serviceId','svc-effect','status','succeeded'),
        'runner',jsonb_build_object('listenerStopped',true,'workspaceRemoved',true,
          'credentialProcessGone',true,'canary','rr-cleanup:r-effect:rr-effect')))))->>'safeForCompensation'" \
  >/dev/null 2>&1; then
  echo "control-supplied cleanup booleans unexpectedly forged safe cleanup" >&2
  exit 1
fi
unsafe_effect=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT effect_state||':'||effect_safe_for_compensation
   FROM release_authority.runner_intent WHERE intent_id='rri-'||repeat('2',64)")
test "$unsafe_effect" = bound:false
effect_witness=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_witness -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness(
    'job-effect',jsonb_build_object('jobId','job-effect',
      'canary','rr-cleanup:r-effect:rr-effect','providerStatus','succeeded',
      'containerTerminated',true,'logSha256','sha256:'||repeat('3',64),
      'removedPaths',jsonb_build_array('/runner/_work/rr-effect/repo'),
      'remainingPaths','[]'::jsonb,'providerLogId','log-effect',
      'providerCreatedAt','$now','providerObservedAt','$now'))")
test "$effect_witness" = t
effect_terminal=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_mark_terminal(
    'job-effect',jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))")
test "$effect_terminal" = t
clean_effect=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT effect_state||':'||effect_safe_for_compensation
   FROM release_authority.runner_intent WHERE intent_id='rri-'||repeat('2',64)")
test "$clean_effect" = cleaned:true
cleaned_listing=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT (intent->>'state')||':'||(listed->>'creationLeaseOwner')||':'||
      ((listed->>'creationLeaseExpiresAt') IS NOT NULL)
   FROM (SELECT release_authority.release_runner_list_intents('r-effect')->0 listed) value,
        LATERAL (SELECT listed->'effect' intent) effect")
test "$cleaned_listing" = cleaned:rrc-00000000-0000-4000-8000-000000000011:false

# Discovery remains authoritative after cleanup: a provider job that appears
# late must be durably witnessable and must revoke compensation safety.
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-effect-late','rolloutId','r-effect','provisioningIntentId','rri-'||repeat('2',64),
    'serviceId','svc-effect','observedAt','$now','providerCreationNotBefore','$now','cleanupCanary','rr-cleanup:r-effect:rr-effect',
    'lifecycle','role'))" >/dev/null
late_duplicate_effect=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT (snapshot->>'state')||':'||(snapshot->'reconciliation'->>'reason')||':'||(snapshot->>'safeForCompensation')
   FROM (SELECT release_authority.release_runner_reconcile_effect(jsonb_build_object(
     'intentId','rri-'||repeat('2',64),'claimantId','rrc-00000000-0000-4000-8000-000000000099',
     'expectedEpoch',1,'jobId','job-effect-late','reconciliation',jsonb_build_object(
       'result','blocked','safeForCompensation',false,'reason','duplicate'))) snapshot) blocked")
test "$late_duplicate_effect" = blocked:duplicate:false
docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_witness -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness(
    'job-effect-late',jsonb_build_object('jobId','job-effect-late',
      'canary','rr-cleanup:r-effect:rr-effect','providerStatus','succeeded',
      'containerTerminated',true,'logSha256','sha256:'||repeat('4',64),
      'removedPaths',jsonb_build_array('/runner/_work/rr-effect/late'),
      'remainingPaths','[]'::jsonb,'providerLogId','log-effect-late',
      'providerCreatedAt','$now','providerObservedAt','$now'))" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_mark_terminal(
    'job-effect-late',jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))" >/dev/null
blocked_after_late_cleanup=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT effect_state||':'||effect_safe_for_compensation
   FROM release_authority.runner_intent WHERE intent_id='rri-'||repeat('2',64)")
test "$blocked_after_late_cleanup" = blocked:false
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "UPDATE release_authority.rollout SET state='compensating' WHERE rollout_id='r-effect'" \
  >/dev/null 2>&1; then
  echo "late duplicate unexpectedly preserved compensation safety" >&2
  exit 1
fi

# A terminal fact independently written through the witness credential repairs
# historical transient blocks, but only when there is one durable identity.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r-retryable-clean',repeat('4',40),'85',1,'185','285');
   SELECT release_authority.release_runner_prepare_effect(jsonb_build_object(
     'id','rri-'||repeat('e',64),'rolloutId','r-retryable-clean','serviceId','svc-retryable',
     'lifecycle','role','workflowJobId','851','runnerName','rr-retryable','createdAt','$now',
     'startCommandSha256','sha256:'||repeat('e',64),
     'creationLeaseOwner','rrc-00000000-0000-4000-8000-000000000085'));
   SELECT release_authority.release_runner_acquire_dispatch_permit(jsonb_build_object(
     'intentId','rri-'||repeat('e',64),'claimantId','rrc-00000000-0000-4000-8000-000000000085',
     'startCommandSha256','sha256:'||repeat('e',64),'expectedEpoch',0,'leaseSeconds',120));
   SELECT release_authority.release_runner_persist_job(jsonb_build_object(
     'jobId','job-retryable-clean','rolloutId','r-retryable-clean',
     'provisioningIntentId','rri-'||repeat('e',64),'serviceId','svc-retryable','observedAt','$now','providerCreationNotBefore','$now',
     'cleanupCanary','rr-cleanup:r-retryable-clean:rr-retryable','lifecycle','role'));
   UPDATE release_authority.runner_intent SET effect_state='blocked',
     effect_block_reason='unknown',effect_safe_for_compensation=false
   WHERE intent_id='rri-'||repeat('e',64)" >/dev/null
retryable_witness=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness(
    'job-retryable-clean',jsonb_build_object('jobId','job-retryable-clean',
      'canary','rr-cleanup:r-retryable-clean:rr-retryable','providerStatus','succeeded',
      'containerTerminated',true,'logSha256','sha256:'||repeat('e',64),
      'removedPaths',jsonb_build_array('/runner/_work/rr-retryable/repo'),
      'remainingPaths','[]'::jsonb,'providerLogId','log-retryable',
      'providerCreatedAt','$now','providerObservedAt','$now'))")
test "$retryable_witness" = t
retryable_terminal=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_mark_terminal(
    'job-retryable-clean',jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))")
test "$retryable_terminal" = t
retryable_repaired=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT effect_state||':'||effect_safe_for_compensation
   FROM release_authority.runner_intent WHERE intent_id='rri-'||repeat('e',64)")
test "$retryable_repaired" = cleaned:true

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "DO \$\$
   DECLARE base jsonb; snapshot jsonb;
   BEGIN
     PERFORM release_authority.release_rollout_claim('r-before',repeat('b',40),'82',1,'182','282');
     base := jsonb_build_object('id','rri-'||repeat('4',64),'rolloutId','r-before',
       'serviceId','svc-before','lifecycle','role','workflowJobId','821','runnerName','rr-before',
       'createdAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
       'startCommandSha256','sha256:'||repeat('5',64),
       'creationLeaseOwner','rrc-00000000-0000-4000-8000-000000000021');
     PERFORM release_authority.release_runner_prepare_effect(base);
     UPDATE release_authority.runner_intent SET effect_lease_expires_at=clock_timestamp()-interval '1 second'
       WHERE intent_id='rri-'||repeat('4',64);
     base := jsonb_set(base,'{creationLeaseOwner}','\"rrc-00000000-0000-4000-8000-000000000022\"');
     snapshot := release_authority.release_runner_prepare_effect(base);
     IF snapshot->>'state' <> 'prepared' OR snapshot->>'ownerId' <> 'rrc-00000000-0000-4000-8000-000000000022'
       THEN RAISE EXCEPTION 'crash-before-permit prepared lease did not redrive'; END IF;
     snapshot := release_authority.release_runner_acquire_dispatch_permit(jsonb_build_object(
       'intentId','rri-'||repeat('4',64),'claimantId','rrc-00000000-0000-4000-8000-000000000022',
       'startCommandSha256','sha256:'||repeat('5',64),'expectedEpoch',0,'leaseSeconds',120));
     IF snapshot->>'state' <> 'dispatching' OR (snapshot->>'epoch')::integer <> 1
       THEN RAISE EXCEPTION 'crash-before-permit redrive was not permitted'; END IF;

     PERFORM release_authority.release_rollout_claim('r-duplicate',repeat('c',40),'83',1,'183','283');
     base := jsonb_build_object('id','rri-'||repeat('6',64),'rolloutId','r-duplicate',
       'serviceId','svc-duplicate','lifecycle','role','workflowJobId','831','runnerName','rr-duplicate',
       'createdAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
       'startCommandSha256','sha256:'||repeat('7',64),
       'creationLeaseOwner','rrc-00000000-0000-4000-8000-000000000031');
     PERFORM release_authority.release_runner_prepare_effect(base);
     PERFORM release_authority.release_runner_acquire_dispatch_permit(jsonb_build_object(
       'intentId','rri-'||repeat('6',64),'claimantId','rrc-00000000-0000-4000-8000-000000000031',
       'startCommandSha256','sha256:'||repeat('7',64),'expectedEpoch',0,'leaseSeconds',120));
     snapshot := release_authority.release_runner_reconcile_effect(jsonb_build_object(
       'intentId','rri-'||repeat('6',64),'claimantId','rrc-00000000-0000-4000-8000-000000000031',
       'expectedEpoch',1,'reconciliation',jsonb_build_object('result','blocked','safeForCompensation',false,'reason','duplicate')));
     IF snapshot->>'state' <> 'blocked' OR (snapshot->>'safeForCompensation')::boolean
       THEN RAISE EXCEPTION 'duplicate effect was not blocked unsafe'; END IF;

     PERFORM release_authority.release_rollout_claim('r-timeout',repeat('d',40),'84',1,'184','284');
     base := jsonb_build_object('id','rri-'||repeat('d',64),'rolloutId','r-timeout',
       'serviceId','svc-timeout','lifecycle','role','workflowJobId','841','runnerName','rr-timeout',
       'createdAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
       'startCommandSha256','sha256:'||repeat('a',64),
       'creationLeaseOwner','rrc-00000000-0000-4000-8000-000000000041');
     PERFORM release_authority.release_runner_prepare_effect(base);
     PERFORM release_authority.release_runner_acquire_dispatch_permit(jsonb_build_object(
       'intentId','rri-'||repeat('d',64),'claimantId','rrc-00000000-0000-4000-8000-000000000041',
       'startCommandSha256','sha256:'||repeat('a',64),'expectedEpoch',0,'leaseSeconds',120));
     UPDATE release_authority.runner_intent SET effect_discovery_deadline=clock_timestamp()-interval '1 second'
       WHERE intent_id='rri-'||repeat('d',64);
     snapshot := release_authority.release_runner_reconcile_effect(jsonb_build_object(
       'intentId','rri-'||repeat('d',64),'claimantId','rrc-00000000-0000-4000-8000-000000000041',
       'expectedEpoch',1,'reconciliation',jsonb_build_object('result','pending','safeForCompensation',false)));
     IF snapshot->>'state' <> 'dispatching' OR (snapshot->>'safeForCompensation')::boolean
       THEN RAISE EXCEPTION 'discovery timeout was not retryable and unsafe'; END IF;
   END \$\$;" >/dev/null

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r-order', repeat('d',40), '4', 1, '103', '203')" >/dev/null
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-order',repeat('d',40),'4',1,'103','203','stage_target_services',
    'sha256:'||repeat('0',64),'sha256:'||repeat('6',64),'103','before','before',
    '{\"renderDeployIds\":[\"dep\"]}')" >/dev/null 2>&1; then
  echo "out-of-order pre-activation receipt unexpectedly succeeded" >&2
  exit 1
fi

finalized=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_finalize_activation(
    jsonb_build_object('rolloutId','r1','expectedCommitSha',expected_commit_sha,
      'postgresMajor',activation_postgres_major,'migrationChecksum',activation_migration_checksum,
      'epoch',activation_epoch,'nonce',activation_permit_nonce,
      'sourceSystemIdentifier','100','targetSystemIdentifier','200',
      'previousReceiptSha256',activation_previous_receipt_sha256,'targetDeployIds',activation_target_deploy_ids),
    '{\"deploy\":\"dep\"}', 'sha256:'||repeat('1',64),
    jsonb_build_object('permitEpoch',activation_epoch,'permitNonce',activation_permit_nonce,
      'previousReceiptSha256',activation_previous_receipt_sha256,'targetDeployIds',activation_target_deploy_ids))
   FROM release_authority.rollout WHERE rollout_id='r1'")
finalize_replay=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_finalize_activation(
    jsonb_build_object('rolloutId','r1','expectedCommitSha',expected_commit_sha,
      'postgresMajor',activation_postgres_major,'migrationChecksum',activation_migration_checksum,
      'epoch',activation_epoch,'nonce',activation_permit_nonce,
      'sourceSystemIdentifier','100','targetSystemIdentifier','200',
      'previousReceiptSha256',activation_previous_receipt_sha256,'targetDeployIds',activation_target_deploy_ids),
    '{\"deploy\":\"dep\"}', 'sha256:'||repeat('1',64), activation_receipt)
   FROM release_authority.rollout WHERE rollout_id='r1'")
authorization_after_finalize=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.authorize_activation('r1', repeat('a',40), '1', 1, '100', '200', '9', '$stage_receipt', '[\"dep-srv-a\",\"dep-srv-b\",\"dep-srv-c\"]', 17, 'sha256:'||repeat('7',64))")
test "$finalized" = t
test "$finalize_replay" = t
test "$authorization_after_finalize" = "$authorization"

if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r1',repeat('a',40),'1',1,'100','200','verify_live_canary',
    'sha256:'||repeat('1',64),'sha256:'||repeat('2',64),'200',
    'activated','activated',NULL)" >/dev/null 2>&1; then
  echo "out-of-order post-activation receipt unexpectedly succeeded" >&2
  exit 1
fi
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "DO \$\$
   DECLARE steps text[] := ARRAY[
     'cleanup_cutover_runner','resume_target_services',
     'verify_live_canary','verify_trusted_rollout'];
   DECLARE previous_sha text := 'sha256:'||repeat('1',64);
   DECLARE next_sha text;
   BEGIN
     FOR index IN 1..cardinality(steps) LOOP
       next_sha := 'sha256:'||md5('r1-post-'||index)||md5('post-r1-'||index);
       IF NOT release_authority.release_rollout_append_receipt(
         'r1',repeat('a',40),'1',1,'100','200',steps[index],previous_sha,next_sha,
         '200','activated','activated',NULL) THEN
         RAISE EXCEPTION 'legal post-activation receipt rejected at %', steps[index];
       END IF;
       previous_sha := next_sha;
     END LOOP;
   END \$\$;" >/dev/null
post_activation_state=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT state||':'||activation_boundary||':'||source_permanently_ineligible||':'||authoritative_system_identifier
   FROM release_authority.rollout WHERE rollout_id='r1'")
test "$post_activation_state" = activated:activated:true:200

conflicting_finalize=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_finalize_activation(
    jsonb_build_object('rolloutId','r1','expectedCommitSha',expected_commit_sha,
      'postgresMajor',activation_postgres_major,'migrationChecksum',activation_migration_checksum,
      'epoch',activation_epoch,'nonce',repeat('f',32),
      'sourceSystemIdentifier','100','targetSystemIdentifier','200',
      'previousReceiptSha256',activation_previous_receipt_sha256,'targetDeployIds',activation_target_deploy_ids),
    '{\"deploy\":\"dep\"}', 'sha256:'||repeat('1',64), activation_receipt)
   FROM release_authority.rollout WHERE rollout_id='r1'")
test "$conflicting_finalize" = f

if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.authorize_activation('r1', repeat('a',40), '1', 1, '100', '200', '10', '$stage_receipt', '[\"dep\"]', 17, 'sha256:'||repeat('7',64))" >/dev/null 2>&1; then
  echo "conflicting authorization replay unexpectedly succeeded" >&2
  exit 1
fi

if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.authorize_activation('r1', repeat('a',40), '1', 1, '100', '200', '9', '$stage_receipt', '[\"dep\"]', 17, 'sha256:'||repeat('8',64))" >/dev/null 2>&1; then
  echo "conflicting migration checksum replay unexpectedly succeeded" >&2
  exit 1
fi

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r2', repeat('b',40), '2', 1, '101', '201')" >/dev/null
deploy_request='{"rolloutId":"r2","operation":"deploy_target","sourceSystemIdentifier":"101","targetSystemIdentifier":"201","expectedReceiptSha256":"sha256:'$(printf '0%.0s' $(seq 1 64))'","activationBoundary":"before"}'
decision=$(docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d postgres -Atc \
  "SELECT release_authority.release_provider_authority_decide('$deploy_request')")
decision_replay=$(docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d postgres -Atc \
  "SELECT release_authority.release_provider_authority_decide('$deploy_request')")
test "$decision" = "$decision_replay"
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r2',repeat('b',40),'2',1,'101','201','claim_rollout',
    'sha256:'||repeat('0',64),'sha256:'||repeat('5',64),'101','before','before',NULL)" >/dev/null
if docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d postgres -Atc \
  "SELECT release_authority.release_provider_authority_decide('$deploy_request')" >/dev/null 2>&1; then
  echo "stale provider decision replay unexpectedly succeeded after receipt change" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d postgres -Atc \
  "SELECT release_authority.release_provider_authority_decide(jsonb_set('$deploy_request','{expectedReceiptSha256}','\"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\"'))" >/dev/null 2>&1; then
  echo "conflicting provider decision replay unexpectedly succeeded" >&2
  exit 1
fi

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r-state', repeat('e',40), '5', 1, '104', '204')" >/dev/null
state_request='{"rolloutId":"r-state","operation":"deploy_target","sourceSystemIdentifier":"104","targetSystemIdentifier":"204","expectedReceiptSha256":"sha256:'$(printf '0%.0s' $(seq 1 64))'","activationBoundary":"before"}'
docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d postgres -Atc \
  "SELECT release_authority.release_provider_authority_decide('$state_request')" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "UPDATE release_authority.rollout SET state='activated', activation_boundary='activated',
     authoritative_system_identifier=target_system_identifier, source_permanently_ineligible=true
   WHERE rollout_id='r-state'" >/dev/null
if docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d postgres -Atc \
  "SELECT release_authority.release_provider_authority_decide('$state_request')" >/dev/null 2>&1; then
  echo "stale provider decision replay unexpectedly succeeded after state change" >&2
  exit 1
fi

# Compensation must fail closed when runner-effect evidence is absent or unsafe.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r-comp-no-intent', repeat('5',40), '6', 1, '105', '205')" >/dev/null
empty_checkpoint=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT (checkpoint->>'activationBoundary')||':'||(checkpoint->>'state')||':'||
      (checkpoint->>'lastReceiptSha256')||':'||coalesce(checkpoint->>'lastStep','null')||':'||
      (checkpoint->>'receiptCount')
   FROM (SELECT release_authority.release_rollout_compensation_checkpoint(
      'r-comp-no-intent','105','205') checkpoint) value")
test "$empty_checkpoint" = before:pre_activation:sha256:$(printf '0%.0s' $(seq 1 64)):null:0
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-comp-no-intent',repeat('5',40),'6',1,'105','205','begin_compensation',
    'sha256:'||repeat('0',64),'sha256:'||repeat('5',64),'105','before','before',NULL)" >/dev/null 2>&1; then
  echo "compensation without runner intents unexpectedly succeeded" >&2
  exit 1
fi
no_intent_compensation_fence=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT state||':'||activation_boundary||':'||authoritative_system_identifier||':'||source_permanently_ineligible
   FROM release_authority.rollout WHERE rollout_id='r-comp-no-intent'")
test "$no_intent_compensation_fence" = pre_activation:before:105:false

# Zero runner intents are safe only when the provider mutation intent and its
# completed suspension observation are both durable.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r-comp-zero-safe', repeat('4',40), '8', 1, '108', '208')" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_source_freeze_prepare(
      'r-comp-zero-safe',repeat('4',40),'8',1,'108','208','srv-zero-safe','dep-zero-safe',
      '$now','[\"srv-zero-safe\"]'::jsonb,false);
   SELECT release_authority.release_source_freeze_record(
      'r-comp-zero-safe',repeat('4',40),'8',1,'108','208','srv-zero-safe','dep-zero-safe',
      '$now','[\"srv-zero-safe\"]'::jsonb);
   SELECT release_authority.release_rollout_append_receipt(
      'r-comp-zero-safe',repeat('4',40),'8',1,'108','208','begin_compensation',
      'sha256:'||repeat('0',64),'sha256:'||repeat('e',64),'108','before','before',NULL)" >/dev/null
zero_intent_safe_state=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT state FROM release_authority.rollout WHERE rollout_id='r-comp-zero-safe'")
test "$zero_intent_safe_state" = compensating

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r-comp-freeze-unknown', repeat('3',40), '9', 1, '109', '209')" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_source_freeze_prepare(
      'r-comp-freeze-unknown',repeat('3',40),'9',1,'109','209','srv-first','dep-first',
      '$now','[\"srv-first\",\"srv-second\"]'::jsonb,false);
   SELECT release_authority.release_source_freeze_record(
      'r-comp-freeze-unknown',repeat('3',40),'9',1,'109','209','srv-first','dep-first',
      '$now','[\"srv-first\",\"srv-second\"]'::jsonb);
   SELECT release_authority.release_source_freeze_prepare(
      'r-comp-freeze-unknown',repeat('3',40),'9',1,'109','209','srv-second','dep-second',
      '$now','[\"srv-first\",\"srv-second\"]'::jsonb,false)" >/dev/null
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-comp-freeze-unknown',repeat('3',40),'9',1,'109','209','begin_compensation',
    'sha256:'||repeat('0',64),'sha256:'||repeat('3',64),'109','before','before',NULL)" >/dev/null 2>&1; then
  echo "compensation with an unresolved source freeze effect unexpectedly succeeded" >&2
  exit 1
fi

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r-comp-unsafe', repeat('6',40), '7', 1, '106', '206')" >/dev/null
unsafe_compensation_intent=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT (snapshot->>'state')||':'||(snapshot->'reconciliation'->>'result')||':'||(snapshot->>'safeForCompensation')
   FROM (SELECT release_authority.release_runner_prepare_effect(jsonb_build_object(
     'id','rri-'||repeat('5',64),'rolloutId','r-comp-unsafe','serviceId','svc-comp-unsafe',
     'lifecycle','role','workflowJobId','70','runnerName','rr-comp-unsafe','createdAt','$now',
     'startCommandSha256','sha256:'||repeat('5',64),
     'creationLeaseOwner','rrc-00000000-0000-4000-8000-000000000051')) snapshot) prepared")
test "$unsafe_compensation_intent" = prepared:pending:false
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-comp-unsafe',repeat('6',40),'7',1,'106','206','begin_compensation',
    'sha256:'||repeat('0',64),'sha256:'||repeat('6',64),'106','before','before',NULL)" >/dev/null 2>&1; then
  echo "compensation with a pending runner intent unexpectedly succeeded" >&2
  exit 1
fi
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_acquire_dispatch_permit(jsonb_build_object(
    'intentId','rri-'||repeat('5',64),'claimantId','rrc-00000000-0000-4000-8000-000000000051',
    'startCommandSha256','sha256:'||repeat('5',64),'expectedEpoch',0,'leaseSeconds',120))" >/dev/null
blocked_compensation_intent=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT (snapshot->>'state')||':'||(snapshot->'reconciliation'->>'result')||':'||(snapshot->>'safeForCompensation')
   FROM (SELECT release_authority.release_runner_reconcile_effect(jsonb_build_object(
     'intentId','rri-'||repeat('5',64),'claimantId','rrc-00000000-0000-4000-8000-000000000051',
     'expectedEpoch',1,'reconciliation',jsonb_build_object(
       'result','blocked','safeForCompensation',false,'reason','unknown'))) snapshot) blocked")
test "$blocked_compensation_intent" = dispatching:pending:false
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-comp-unsafe',repeat('6',40),'7',1,'106','206','begin_compensation',
    'sha256:'||repeat('0',64),'sha256:'||repeat('6',64),'106','before','before',NULL)" >/dev/null 2>&1; then
  echo "compensation with a blocked runner intent unexpectedly succeeded" >&2
  exit 1
fi
unsafe_compensation_fence=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT state||':'||activation_boundary||':'||authoritative_system_identifier||':'||source_permanently_ineligible
   FROM release_authority.rollout WHERE rollout_id='r-comp-unsafe'")
test "$unsafe_compensation_fence" = pre_activation:before:106:false

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r3', repeat('c',40), '3', 1, '102', '202')" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_source_freeze_prepare(
      'r3',repeat('c',40),'3',1,'102','202','srv-compensation','dep-compensation',
      '$now','[\"srv-compensation\"]'::jsonb,false);
   SELECT release_authority.release_source_freeze_record(
      'r3',repeat('c',40),'3',1,'102','202','srv-compensation','dep-compensation',
      '$now','[\"srv-compensation\"]'::jsonb)" >/dev/null
r3_compensation_intent=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_prepare_effect(jsonb_build_object(
    'id','rri-'||repeat('0',64),'rolloutId','r3','serviceId','svc-compensation',
    'lifecycle','cutover','workflowJobId','31','runnerName','rr-compensation','createdAt','$now',
    'startCommandSha256','sha256:'||repeat('0',64),
    'creationLeaseOwner','rrc-00000000-0000-4000-8000-000000000061'))->>'state'")
test "$r3_compensation_intent" = prepared
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_abandon_prepared(
    'rri-'||repeat('0',64),'rrc-00000000-0000-4000-8000-000000000061',0)" \
  >/dev/null 2>&1; then
  echo "unexpired prepared lease was abandoned" >&2
  exit 1
fi
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "UPDATE release_authority.runner_intent
   SET effect_lease_expires_at=clock_timestamp()-interval '1 second'
   WHERE intent_id='rri-'||repeat('0',64)" >/dev/null
r3_abandoned_intent=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT (snapshot->>'state')||':'||(snapshot->>'safeForCompensation')
   FROM (SELECT release_authority.release_runner_abandon_prepared(
     'rri-'||repeat('0',64),'rrc-00000000-0000-4000-8000-000000000061',0) snapshot) abandoned")
test "$r3_abandoned_intent" = abandoned:true
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_append_receipt('r3',repeat('c',40),'3',1,'102','202',
    'begin_compensation','sha256:'||repeat('0',64),'sha256:'||repeat('2',64),'102','before','before',NULL)" >/dev/null
compensation_checkpoint=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT (checkpoint->>'activationBoundary')||':'||(checkpoint->>'state')||':'||
      (checkpoint->>'lastReceiptSha256')||':'||(checkpoint->>'lastStep')||':'||
      (checkpoint->>'receiptCount')
   FROM (SELECT release_authority.release_rollout_compensation_checkpoint(
      'r3','102','202') checkpoint) value")
test "$compensation_checkpoint" = before:compensating:sha256:$(printf '2%.0s' $(seq 1 64)):begin_compensation:1
resume_source_request='{"rolloutId":"r3","operation":"resume_source","sourceSystemIdentifier":"102","targetSystemIdentifier":"202","expectedReceiptSha256":"sha256:'$(printf '2%.0s' $(seq 1 64))'","activationBoundary":"before"}'
docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d postgres -Atc \
  "SELECT release_authority.release_provider_authority_decide('$resume_source_request')" >/dev/null

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "INSERT INTO release_authority.runner_intent(intent_id,rollout_id,service_id,lifecycle,workflow_job_id,runner_name,created_at,start_command_sha256)
   VALUES ('rri-'||repeat('3',64),'r3','svc','role','30','rr-test','$now','sha256:'||repeat('3',64));
   INSERT INTO release_authority.runner_job(job_id,rollout_id,provisioning_intent_id,service_id,observed_at,provider_creation_not_before,cleanup_canary,lifecycle)
   VALUES ('job-clean','r3','rri-'||repeat('3',64),'svc','$now','$now','canary','role');" >/dev/null
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc   "SELECT release_authority.release_runner_mark_terminal('job-clean','{\"step\":\"cleanup_role_runner\"}')" >/dev/null 2>&1; then
  echo "terminal CAS without provider cleanup witness unexpectedly succeeded" >&2
  exit 1
fi
cleanup_seed=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d postgres -Atc \
  "SELECT release_authority.release_runner_cleanup_observation_seed('job-clean') =
    jsonb_build_object('jobId','job-clean','serviceId','svc',
      'cleanupCanary','canary','observedAt','$now','providerCreationNotBefore','$now')")
test "$cleanup_seed" = t
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_cleanup_observation_seed('job-clean')" >/dev/null 2>&1; then
  echo "control role unexpectedly has witness seed execution" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-clean','{\"jobId\":\"job-clean\",\"canary\":\"canary\",\"providerStatus\":\"failed\",\"containerTerminated\":true,\"logSha256\":\"sha256:$(printf '4%.0s' $(seq 1 64))\",\"removedPaths\":[\"/runner/_work/rr-safe/../secret\"],\"remainingPaths\":[],\"providerLogId\":\"log-1\",\"providerCreatedAt\":\"$now\",\"providerObservedAt\":\"$now\"}')" >/dev/null 2>&1; then
  echo "unsafe cleanup witness unexpectedly succeeded" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-clean','{\"jobId\":\"job-clean\",\"canary\":\"canary\",\"providerStatus\":\"succeeded\",\"containerTerminated\":true,\"logSha256\":\"sha256:$(printf '4%.0s' $(seq 1 64))\",\"removedPaths\":[\"/runner/_work/rr-safe/repo\"],\"remainingPaths\":[],\"providerLogId\":\"log-old\",\"providerCreatedAt\":\"2000-01-01T00:00:00.000Z\",\"providerObservedAt\":\"$now\"}')" >/dev/null 2>&1; then
  echo "provider resource older than the request boundary satisfied cleanup witness" >&2
  exit 1
fi
cleanup_saved=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-clean','{\"jobId\":\"job-clean\",\"canary\":\"canary\",\"providerStatus\":\"succeeded\",\"containerTerminated\":true,\"logSha256\":\"sha256:$(printf '4%.0s' $(seq 1 64))\",\"removedPaths\":[\"/runner/_work/rr-safe/repo\"],\"remainingPaths\":[],\"providerLogId\":\"log-1\",\"providerCreatedAt\":\"$now\",\"providerObservedAt\":\"$now\"}')")
test "$cleanup_saved" = t
cleanup_replayed=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-clean','{\"jobId\":\"job-clean\",\"canary\":\"canary\",\"providerStatus\":\"succeeded\",\"containerTerminated\":true,\"logSha256\":\"sha256:$(printf '4%.0s' $(seq 1 64))\",\"removedPaths\":[\"/runner/_work/rr-safe/repo\"],\"remainingPaths\":[],\"providerLogId\":\"log-1\",\"providerCreatedAt\":\"$now\",\"providerObservedAt\":\"$now\"}')")
test "$cleanup_replayed" = t
# A terminal recovery must also wait parent-first. The adversary holds rollout
# and intent, then reaches for the job; a job-first terminal path deadlocks it.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc \
  "BEGIN;
   SELECT 1 FROM release_authority.rollout WHERE rollout_id='r3' FOR UPDATE;
   SELECT 1 FROM release_authority.runner_intent
     WHERE intent_id='rri-'||repeat('3',64) FOR UPDATE;
   SELECT pg_catalog.pg_advisory_xact_lock(810002);
   SELECT pg_catalog.pg_sleep(2);
   SELECT 1 FROM release_authority.runner_job WHERE job_id='job-clean' FOR UPDATE;
   COMMIT" >/dev/null &
terminal_order_pid=$!
terminal_order_ready=false
for _ in $(seq 1 100); do
  if test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks
      WHERE locktype='advisory' AND objid=810002 AND granted)")" = t; then
    terminal_order_ready=true
    break
  fi
  sleep 0.05
done
test "$terminal_order_ready" = true
terminal_saved=$(docker exec -e PGPASSWORD=control -e PGOPTIONS='-c lock_timeout=10s' "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_mark_terminal('job-clean','{\"step\":\"cleanup_role_runner\",\"observedAt\":\"$now\"}')")
wait "$terminal_order_pid"
test "$terminal_saved" = t
terminal_replayed=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc   "SELECT release_authority.release_runner_mark_terminal('job-clean','{\"step\":\"cleanup_role_runner\",\"observedAt\":\"$now\"}')")
test "$terminal_replayed" = t
terminal_fact=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc   "SELECT release_authority.release_runner_terminal_cleanup_fact('r3','role')->>'jobId'")
test "$terminal_fact" = job-clean

# A provider identity discovered after the original effect was independently
# witnessed and cleaned must be retained before cleanup and must permanently
# revoke the pre-activation compensation gate.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r-late-duplicate',repeat('b',40),'81',1,'181','281')" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_prepare_effect(jsonb_build_object(
     'id','rri-'||repeat('b',64),'rolloutId','r-late-duplicate','serviceId','svc-late',
     'lifecycle','role','workflowJobId','810','runnerName','rr-late-dupe','createdAt','$now',
     'startCommandSha256','sha256:'||repeat('b',64),
     'creationLeaseOwner','rrc-00000000-0000-4000-8000-000000000081'));
   SELECT release_authority.release_runner_acquire_dispatch_permit(jsonb_build_object(
     'intentId','rri-'||repeat('b',64),'claimantId','rrc-00000000-0000-4000-8000-000000000081',
     'startCommandSha256','sha256:'||repeat('b',64),'expectedEpoch',0,'leaseSeconds',120));
   SELECT release_authority.release_runner_persist_job(jsonb_build_object(
     'jobId','job-late-original','rolloutId','r-late-duplicate',
     'provisioningIntentId','rri-'||repeat('b',64),'serviceId','svc-late','observedAt','$now','providerCreationNotBefore','$now',
     'cleanupCanary','rr-cleanup:r-late-duplicate:rr-late-dupe','lifecycle','role'));
   SELECT release_authority.release_runner_reconcile_effect(jsonb_build_object(
     'intentId','rri-'||repeat('b',64),'claimantId','rrc-00000000-0000-4000-8000-000000000081',
     'expectedEpoch',1,'jobId','job-late-original','reconciliation',
     jsonb_build_object('result','pending','safeForCompensation',false)))" >/dev/null
for late_job in job-late-original job-late-after-clean; do
  if test "$late_job" = job-late-after-clean; then
    # Hold the persisting transaction open after the identity and unsafe state
    # are written. A concurrent compensation command must wait for the rollout
    # lock, observe the committed duplicate fence, and reject.
    docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
      -U reviewrouter_release_control -d postgres -Atc \
      "BEGIN;
       SELECT release_authority.release_runner_persist_job(jsonb_build_object(
         'jobId','$late_job','rolloutId','r-late-duplicate',
         'provisioningIntentId','rri-'||repeat('b',64),'serviceId','svc-late','observedAt','$now','providerCreationNotBefore','$now',
         'cleanupCanary','rr-cleanup:r-late-duplicate:rr-late-dupe','lifecycle','role'));
       SELECT pg_catalog.pg_advisory_xact_lock(810081);
       SELECT pg_catalog.pg_sleep(5);
       COMMIT" >/dev/null &
    late_persist_pid=$!
    late_persist_ready=false
    for _ in $(seq 1 100); do
      if test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks
          WHERE locktype='advisory' AND objid=810081 AND granted)")" = t; then
        late_persist_ready=true
        break
      fi
      sleep 0.05
    done
    test "$late_persist_ready" = true
    if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
      -U reviewrouter_release_control -d postgres -Atc \
      "SELECT release_authority.release_rollout_append_receipt(
        'r-late-duplicate',repeat('b',40),'81',1,'181','281','begin_compensation',
        'sha256:'||repeat('0',64),'sha256:'||repeat('b',64),'181','before','before',NULL)" \
      >/dev/null 2>&1; then
      echo "concurrent compensation raced a late duplicate persistence" >&2
      exit 1
    fi
    wait "$late_persist_pid"
  fi
  late_witness=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d postgres -Atc \
    "SELECT release_authority.release_runner_persist_cleanup_witness('$late_job',jsonb_build_object(
      'jobId','$late_job','canary','rr-cleanup:r-late-duplicate:rr-late-dupe',
      'providerStatus','succeeded','containerTerminated',true,'logSha256','sha256:'||repeat('b',64),
      'removedPaths',jsonb_build_array('/runner/_work/rr-late-dupe/repo'),'remainingPaths','[]'::jsonb,
      'providerLogId','log-'||'$late_job','providerCreatedAt','$now','providerObservedAt','$now'))")
  test "$late_witness" = t
  late_terminal=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
    "SELECT release_authority.release_runner_mark_terminal('$late_job',jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))")
  test "$late_terminal" = t
done
late_duplicate_state=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT (snapshot->'effect'->>'state')||':'||(snapshot->'effect'->>'safeForCompensation')
   FROM (SELECT release_authority.release_runner_list_intents('r-late-duplicate')->0 AS snapshot) state")
test "$late_duplicate_state" = blocked:false
late_duplicate_count=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT count(*) FROM release_authority.runner_job WHERE rollout_id='r-late-duplicate'")
test "$late_duplicate_count" = 2
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-late-duplicate',repeat('b',40),'81',1,'181','281','begin_compensation',
    'sha256:'||repeat('0',64),'sha256:'||repeat('b',64),'181','before','before',NULL)" >/dev/null 2>&1; then
  echo "compensation after a durably cleaned late duplicate unexpectedly succeeded" >&2
  exit 1
fi
late_terminal_replayed=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_mark_terminal('job-late-after-clean',jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))")
test "$late_terminal_replayed" = t

# A duplicate that is durable before the activation state write must fence the
# write even when the caller already holds the rollout lock.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r-activation-fenced',repeat('a',40),'86',1,'186','286');
   SELECT release_authority.release_runner_prepare_effect(jsonb_build_object(
     'id','rri-'||repeat('a',64),'rolloutId','r-activation-fenced','serviceId','svc-activation',
     'lifecycle','role','workflowJobId','861','runnerName','rr-activation-fenced','createdAt','$now',
     'startCommandSha256','sha256:'||repeat('a',64),
     'creationLeaseOwner','rrc-00000000-0000-4000-8000-000000000086'));
   SELECT release_authority.release_runner_acquire_dispatch_permit(jsonb_build_object(
     'intentId','rri-'||repeat('a',64),'claimantId','rrc-00000000-0000-4000-8000-000000000086',
     'startCommandSha256','sha256:'||repeat('a',64),'expectedEpoch',0,'leaseSeconds',120));
   SELECT release_authority.release_runner_persist_job(jsonb_build_object(
     'jobId','job-activation-known','rolloutId','r-activation-fenced',
     'provisioningIntentId','rri-'||repeat('a',64),'serviceId','svc-activation','observedAt','$now','providerCreationNotBefore','$now',
     'cleanupCanary','rr-cleanup:r-activation-fenced:rr-activation-fenced','lifecycle','role'));
   SELECT release_authority.release_runner_reconcile_effect(jsonb_build_object(
     'intentId','rri-'||repeat('a',64),'claimantId','rrc-00000000-0000-4000-8000-000000000086',
     'expectedEpoch',1,'jobId','job-activation-known','reconciliation',
     jsonb_build_object('result','pending','safeForCompensation',false)));
   SELECT release_authority.release_runner_persist_job(jsonb_build_object(
     'jobId','job-activation-known-duplicate','rolloutId','r-activation-fenced',
     'provisioningIntentId','rri-'||repeat('a',64),'serviceId','svc-activation','observedAt','$now','providerCreationNotBefore','$now',
     'cleanupCanary','rr-cleanup:r-activation-fenced:rr-activation-fenced','lifecycle','role'))" >/dev/null
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "UPDATE release_authority.rollout SET state='activation_authorized',activation_boundary='uncertain',
     source_permanently_ineligible=true,authoritative_system_identifier=target_system_identifier
   WHERE rollout_id='r-activation-fenced'" >/dev/null 2>&1; then
  echo "known duplicate unexpectedly crossed activation" >&2
  exit 1
fi
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT state||':'||activation_boundary FROM release_authority.rollout
   WHERE rollout_id='r-activation-fenced'")" = pre_activation:before

# The opposite race is forward-only: activation commits first, then late
# discovery persists, acknowledges the durable duplicate fence, and completes
# both independently witnessed cleanups without rolling activation back.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r-activation-wins',repeat('6',40),'87',1,'187','287');
   SELECT release_authority.release_runner_prepare_effect(jsonb_build_object(
     'id','rri-'||repeat('6',63)||'7','rolloutId','r-activation-wins','serviceId','svc-activation-wins',
     'lifecycle','role','workflowJobId','871','runnerName','rr-activation-wins','createdAt','$now',
     'startCommandSha256','sha256:'||repeat('6',64),
     'creationLeaseOwner','rrc-00000000-0000-4000-8000-000000000087'));
   SELECT release_authority.release_runner_acquire_dispatch_permit(jsonb_build_object(
     'intentId','rri-'||repeat('6',63)||'7','claimantId','rrc-00000000-0000-4000-8000-000000000087',
     'startCommandSha256','sha256:'||repeat('6',64),'expectedEpoch',0,'leaseSeconds',120));
   SELECT release_authority.release_runner_persist_job(jsonb_build_object(
     'jobId','job-activation-first','rolloutId','r-activation-wins',
     'provisioningIntentId','rri-'||repeat('6',63)||'7','serviceId','svc-activation-wins','observedAt','$now','providerCreationNotBefore','$now',
     'cleanupCanary','rr-cleanup:r-activation-wins:rr-activation-wins','lifecycle','role'))" >/dev/null
docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-activation-first',jsonb_build_object(
    'jobId','job-activation-first','canary','rr-cleanup:r-activation-wins:rr-activation-wins',
    'providerStatus','succeeded','containerTerminated',true,'logSha256','sha256:'||repeat('6',64),
    'removedPaths',jsonb_build_array('/runner/_work/rr-activation-wins/original'),'remainingPaths','[]'::jsonb,
    'providerLogId','log-activation-first','providerCreatedAt','$now','providerObservedAt','$now'))" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_mark_terminal('job-activation-first',
    jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc \
  "BEGIN;
   UPDATE release_authority.rollout SET state='activation_authorized',activation_boundary='uncertain',
     source_permanently_ineligible=true,authoritative_system_identifier=target_system_identifier
   WHERE rollout_id='r-activation-wins';
   SELECT pg_catalog.pg_advisory_xact_lock(810087);
   SELECT pg_catalog.pg_sleep(3);
   COMMIT" >/dev/null &
activation_winner_pid=$!
activation_winner_ready=false
for _ in $(seq 1 100); do
  if test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND objid=810087 AND granted)")" = t; then
    activation_winner_ready=true
    break
  fi
  sleep 0.05
done
test "$activation_winner_ready" = true
docker exec -e PGPASSWORD=control -e PGOPTIONS='-c lock_timeout=10s' "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-activation-late','rolloutId','r-activation-wins',
    'provisioningIntentId','rri-'||repeat('6',63)||'7','serviceId','svc-activation-wins','observedAt','$now','providerCreationNotBefore','$now',
    'cleanupCanary','rr-cleanup:r-activation-wins:rr-activation-wins','lifecycle','role'));
   SELECT release_authority.release_runner_reconcile_effect(jsonb_build_object(
    'intentId','rri-'||repeat('6',63)||'7','claimantId','rrc-00000000-0000-4000-8000-000000000087',
    'expectedEpoch',1,'reconciliation',jsonb_build_object(
      'result','blocked','safeForCompensation',false,'reason','duplicate')))" >/dev/null
wait "$activation_winner_pid"
docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-activation-late',jsonb_build_object(
    'jobId','job-activation-late','canary','rr-cleanup:r-activation-wins:rr-activation-wins',
    'providerStatus','succeeded','containerTerminated',true,'logSha256','sha256:'||repeat('6',64),
    'removedPaths',jsonb_build_array('/runner/_work/rr-activation-wins/late'),'remainingPaths','[]'::jsonb,
    'providerLogId','log-activation-late','providerCreatedAt','$now','providerObservedAt','$now'))" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_mark_terminal('job-activation-late',
    jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-activation-late','rolloutId','r-activation-wins',
    'provisioningIntentId','rri-'||repeat('6',63)||'7','serviceId','svc-activation-wins','observedAt','$now','providerCreationNotBefore','$now',
    'cleanupCanary','rr-cleanup:r-activation-wins:rr-activation-wins','lifecycle','role'));
   SELECT release_authority.release_runner_mark_terminal('job-activation-late',
    jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))" >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT rollout.state||':'||rollout.activation_boundary||':'||intent.effect_state||':'||
     intent.effect_safe_for_compensation||':'||count(job.*)||':'||count(job.terminal_at)
   FROM release_authority.rollout rollout
   JOIN release_authority.runner_intent intent USING (rollout_id)
   JOIN release_authority.runner_job job USING (rollout_id)
   WHERE rollout.rollout_id='r-activation-wins'
   GROUP BY rollout.state,rollout.activation_boundary,intent.effect_state,intent.effect_safe_for_compensation")" \
  = activation_authorized:uncertain:blocked:false:2:2

# Compensation may likewise commit after an abandoned no-effect proof. A job
# discovered behind that lock invalidates the proof durably, but neither the
# receipt nor aggregate state is rewound while the late job is cleaned.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r-compensation-wins',repeat('5',40),'88',1,'188','288');
   SELECT release_authority.release_runner_prepare_effect(jsonb_build_object(
     'id','rri-'||repeat('5',63)||'8','rolloutId','r-compensation-wins','serviceId','svc-compensation-wins',
     'lifecycle','role','workflowJobId','881','runnerName','rr-compensation-wins','createdAt','$now',
     'startCommandSha256','sha256:'||repeat('5',64),
     'creationLeaseOwner','rrc-00000000-0000-4000-8000-000000000088'));
   UPDATE release_authority.runner_intent SET effect_lease_expires_at=clock_timestamp()-interval '1 second'
     WHERE intent_id='rri-'||repeat('5',63)||'8';
   SELECT release_authority.release_runner_abandon_prepared(
     'rri-'||repeat('5',63)||'8','rrc-00000000-0000-4000-8000-000000000088',0);
   INSERT INTO release_authority.source_freeze_observation(
     rollout_id,service_id,phase,latest_successful_deploy_id,observed_at,declared_service_ids)
   VALUES ('r-compensation-wins','srv-compensation','suspended','dep-compensation','$now',
     '[\"srv-compensation\"]'::jsonb)" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "BEGIN;
   SELECT release_authority.release_rollout_append_receipt(
     'r-compensation-wins',repeat('5',40),'88',1,'188','288','begin_compensation',
     'sha256:'||repeat('0',64),'sha256:'||repeat('f',64),'188','before','before',NULL);
   SELECT pg_catalog.pg_advisory_xact_lock(810088);
   SELECT pg_catalog.pg_sleep(3);
   COMMIT" >/dev/null &
compensation_winner_pid=$!
compensation_winner_ready=false
for _ in $(seq 1 100); do
  if test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND objid=810088 AND granted)")" = t; then
    compensation_winner_ready=true
    break
  fi
  sleep 0.05
done
test "$compensation_winner_ready" = true
docker exec -e PGPASSWORD=control -e PGOPTIONS='-c lock_timeout=10s' "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-compensation-late','rolloutId','r-compensation-wins',
    'provisioningIntentId','rri-'||repeat('5',63)||'8','serviceId','svc-compensation-wins','observedAt','$now','providerCreationNotBefore','$now',
    'cleanupCanary','rr-cleanup:r-compensation-wins:rr-compensation-wins','lifecycle','role'))" >/dev/null
wait "$compensation_winner_pid"
docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-compensation-late',jsonb_build_object(
    'jobId','job-compensation-late','canary','rr-cleanup:r-compensation-wins:rr-compensation-wins',
    'providerStatus','succeeded','containerTerminated',true,'logSha256','sha256:'||repeat('5',64),
    'removedPaths',jsonb_build_array('/runner/_work/rr-compensation-wins/late'),'remainingPaths','[]'::jsonb,
    'providerLogId','log-compensation-late','providerCreatedAt','$now','providerObservedAt','$now'))" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_mark_terminal('job-compensation-late',
    jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))" >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT rollout.state||':'||rollout.last_receipt_sha256||':'||intent.effect_state||':'||
     intent.effect_safe_for_compensation||':'||(job.terminal_at IS NOT NULL)
   FROM release_authority.rollout rollout
   JOIN release_authority.runner_intent intent USING (rollout_id)
   JOIN release_authority.runner_job job USING (rollout_id)
   WHERE rollout.rollout_id='r-compensation-wins'")" \
  = compensating:sha256:$(printf 'f%.0s' $(seq 1 64)):blocked:false:true

# Late identity wins the next boundary: neither an authority replay nor effect
# or completion receipt may use the clean snapshot captured by begin.
if docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_provider_authority -d postgres -Atc \
  "SELECT release_authority.release_provider_authority_decide(jsonb_build_object(
    'rolloutId','r-compensation-wins','operation','resume_source',
    'sourceSystemIdentifier','188','targetSystemIdentifier','288',
    'expectedReceiptSha256','sha256:'||repeat('f',64),'activationBoundary','before'))" \
  >/dev/null 2>&1; then
  echo "late runner effect reused source recovery authority" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-compensation-wins',repeat('5',40),'88',1,'188','288','effect_compensation',
    'sha256:'||repeat('f',64),'sha256:'||repeat('e',64),'188','before','before',NULL)" \
  >/dev/null 2>&1; then
  echo "late runner effect crossed effect_compensation" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-compensation-wins',repeat('5',40),'88',1,'188','288','complete_compensation',
    'sha256:'||repeat('f',64),'sha256:'||repeat('d',64),'188','before','before',NULL)" \
  >/dev/null 2>&1; then
  echo "late runner effect crossed complete_compensation" >&2
  exit 1
fi
test "$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT (result->>'state')||':'||(result->>'sourceEligible')
   FROM (SELECT release_authority.release_rollout_reconcile(
     'r-compensation-wins','{}'::jsonb) result) reconciled")" \
  = pre_activation_recovery_required:false

# Opposite ordering: effect_compensation owns the rollout lock first. The late
# identity waits, is then persisted as unsafe, and fences completion and source
# eligibility without deadlocking the rollout -> intent -> job order.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r-effect-wins',repeat('4',40),'89',1,'189','289');
   SELECT release_authority.release_runner_prepare_effect(jsonb_build_object(
     'id','rri-'||repeat('4',63)||'9','rolloutId','r-effect-wins','serviceId','svc-effect-wins',
     'lifecycle','role','workflowJobId','891','runnerName','rr-effect-wins','createdAt','$now',
     'startCommandSha256','sha256:'||repeat('4',64),
     'creationLeaseOwner','rrc-00000000-0000-4000-8000-000000000089'));
   UPDATE release_authority.runner_intent SET effect_lease_expires_at=clock_timestamp()-interval '1 second'
     WHERE intent_id='rri-'||repeat('4',63)||'9';
   SELECT release_authority.release_runner_abandon_prepared(
     'rri-'||repeat('4',63)||'9','rrc-00000000-0000-4000-8000-000000000089',0);
   INSERT INTO release_authority.source_freeze_observation(
     rollout_id,service_id,phase,latest_successful_deploy_id,observed_at,declared_service_ids)
   VALUES ('r-effect-wins','srv-effect','suspended','dep-effect','$now','[\"srv-effect\"]'::jsonb)" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_service_transition_begin(jsonb_build_object(
    'rolloutId','r-effect-wins','manifestSha256','sha256:'||repeat('4',64),
    'targetContractSha256','sha256:'||repeat('3',64),
    'serviceIds',jsonb_build_array('srv-effect','srv-effect-b','srv-effect-c'),
    'sourceManifest',jsonb_build_object('manifestSha256','sha256:'||repeat('4',64),'services','[]'::jsonb),
    'targetContracts',jsonb_build_array(jsonb_build_object('serviceId','srv-effect'),
      jsonb_build_object('serviceId','srv-effect-b'),jsonb_build_object('serviceId','srv-effect-c'))))" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-effect-wins',repeat('4',40),'89',1,'189','289','begin_compensation',
    'sha256:'||repeat('0',64),'sha256:'||repeat('a',64),'189','before','before',NULL)" >/dev/null
recovery_intent_first=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_service_transition_append(jsonb_build_object(
    'rolloutId','r-effect-wins','manifestSha256','sha256:'||repeat('4',64),
    'targetContractSha256','sha256:'||repeat('3',64),'serviceId','srv-effect',
    'step','restore_config_intent'))->>'sequence'")
test "$recovery_intent_first" = 2
recovery_intent_replay=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_service_transition_append(jsonb_build_object(
    'rolloutId','r-effect-wins','manifestSha256','sha256:'||repeat('4',64),
    'targetContractSha256','sha256:'||repeat('3',64),'serviceId','srv-effect',
    'step','restore_config_intent'))->>'sequence'")
test "$recovery_intent_replay" = 2
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc \
  "BEGIN;
   SELECT release_authority.release_rollout_append_receipt(
     'r-effect-wins',repeat('4',40),'89',1,'189','289','effect_compensation',
     'sha256:'||repeat('a',64),'sha256:'||repeat('b',64),'189','before','before',NULL);
   SELECT release_authority.release_provider_authority_decide(jsonb_build_object(
     'rolloutId','r-effect-wins','operation','resume_source',
     'sourceSystemIdentifier','189','targetSystemIdentifier','289',
     'expectedReceiptSha256','sha256:'||repeat('b',64),'activationBoundary','before'));
   SELECT pg_catalog.pg_advisory_xact_lock(810089);
   SELECT pg_catalog.pg_sleep(3);
   COMMIT" >/dev/null &
effect_winner_pid=$!
effect_winner_ready=false
for _ in $(seq 1 100); do
  if test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND objid=810089 AND granted)")" = t; then
    effect_winner_ready=true
    break
  fi
  sleep 0.05
done
test "$effect_winner_ready" = true
docker exec -e PGPASSWORD=control -e PGOPTIONS='-c lock_timeout=10s' "$name" \
  psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-effect-wins-late','rolloutId','r-effect-wins',
    'provisioningIntentId','rri-'||repeat('4',63)||'9','serviceId','svc-effect-wins','observedAt','$now',
    'providerCreationNotBefore','$now',
    'cleanupCanary','rr-cleanup:r-effect-wins:rr-effect-wins','lifecycle','role'))" >/dev/null
wait "$effect_winner_pid"
docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_witness -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-effect-wins-late',jsonb_build_object(
    'jobId','job-effect-wins-late','canary','rr-cleanup:r-effect-wins:rr-effect-wins',
    'providerStatus','succeeded','containerTerminated',true,'logSha256','sha256:'||repeat('4',64),
    'removedPaths',jsonb_build_array('/runner/_work/rr-effect-wins/late'),'remainingPaths','[]'::jsonb,
    'providerLogId','log-effect-wins-late','providerCreatedAt','$now','providerObservedAt','$now'))" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_mark_terminal('job-effect-wins-late',
    jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))" >/dev/null
if docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_provider_authority -d postgres -Atc \
  "SELECT release_authority.release_provider_authority_decide(jsonb_build_object(
    'rolloutId','r-effect-wins','operation','resume_source',
    'sourceSystemIdentifier','189','targetSystemIdentifier','289',
    'expectedReceiptSha256','sha256:'||repeat('b',64),'activationBoundary','before'))" \
  >/dev/null 2>&1; then
  echo "effect-first late runner reused source recovery authority" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_service_transition_append(jsonb_build_object(
    'rolloutId','r-effect-wins','manifestSha256','sha256:'||repeat('4',64),
    'targetContractSha256','sha256:'||repeat('3',64),'serviceId','srv-effect',
    'step','restore_config_intent'))" >/dev/null 2>&1; then
  echo "late runner effect reused a source recovery intent" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-effect-wins',repeat('4',40),'89',1,'189','289','complete_compensation',
    'sha256:'||repeat('b',64),'sha256:'||repeat('c',64),'189','before','before',NULL)" \
  >/dev/null 2>&1; then
  echo "effect-first late runner crossed complete_compensation" >&2
  exit 1
fi
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 \
  -U postgres -d postgres -Atc \
  "SELECT rollout.state||':'||rollout.last_receipt_sha256||':'||
     (reconciled.result->>'sourceEligible')
   FROM release_authority.rollout rollout
   CROSS JOIN LATERAL (SELECT release_authority.release_rollout_reconcile(
     rollout.rollout_id,'{}'::jsonb) result) reconciled
   WHERE rollout.rollout_id='r-effect-wins'")" \
  = compensating:sha256:$(printf 'b%.0s' $(seq 1 64)):false

for provider_status in failed canceled; do
  rollout="r-clean-$provider_status"
  suffix=f
  test "$provider_status" = canceled && suffix=c
  runner_label="rr-${suffix}${suffix}"
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
    "SELECT release_authority.release_rollout_claim('$rollout',repeat('$suffix',40),'7',1,'170','270');
     INSERT INTO release_authority.runner_intent(intent_id,rollout_id,service_id,lifecycle,workflow_job_id,runner_name,created_at,start_command_sha256)
     VALUES ('rri-'||repeat('$suffix',64),'$rollout','svc-$suffix','role','70','$runner_label','$now','sha256:'||repeat('$suffix',64));
     INSERT INTO release_authority.runner_job(job_id,rollout_id,provisioning_intent_id,service_id,observed_at,provider_creation_not_before,cleanup_canary,lifecycle)
     VALUES ('job-$provider_status','$rollout','rri-'||repeat('$suffix',64),'svc-$suffix','$now','$now','canary-$suffix','role');" >/dev/null
  terminal_witness=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d postgres -Atc \
    "SELECT release_authority.release_runner_persist_cleanup_witness('job-$provider_status',jsonb_build_object('jobId','job-$provider_status','canary','canary-$suffix','providerStatus','$provider_status','containerTerminated',true,'logSha256','sha256:'||repeat('$suffix',64),'removedPaths',jsonb_build_array('/runner/_work/$runner_label/repo'),'remainingPaths','[]'::jsonb,'providerLogId','log-$suffix','providerCreatedAt','$now','providerObservedAt','$now'))")
  test "$terminal_witness" = t
  terminal_result=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
    "SELECT release_authority.release_runner_mark_terminal('job-$provider_status',jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))")
  test "$terminal_result" = t
done

rejected_index=0
for rejected_status in pending running unknown; do
  rejected_index=$((rejected_index + 1))
  rejected_rollout="r-clean-rejected-$rejected_status"
  rejected_job="job-rejected-$rejected_status"
  rejected_label="rr-rejected-$rejected_status"
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
    "SELECT release_authority.release_rollout_claim('$rejected_rollout',repeat('8',39)||'$rejected_index','8',1,'18$rejected_index','28$rejected_index');
     INSERT INTO release_authority.runner_intent(intent_id,rollout_id,service_id,lifecycle,workflow_job_id,runner_name,created_at,start_command_sha256)
     VALUES ('rri-'||repeat('9',63)||'$rejected_index','$rejected_rollout','svc-rejected-$rejected_index','role','8$rejected_index','$rejected_label','$now','sha256:'||repeat('9',63)||'$rejected_index');
     INSERT INTO release_authority.runner_job(job_id,rollout_id,provisioning_intent_id,service_id,observed_at,provider_creation_not_before,cleanup_canary,lifecycle)
     VALUES ('$rejected_job','$rejected_rollout','rri-'||repeat('9',63)||'$rejected_index','svc-rejected-$rejected_index','$now','$now','canary-rejected-$rejected_index','role');" >/dev/null
  if docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d postgres -Atc \
    "SELECT release_authority.release_runner_persist_cleanup_witness('$rejected_job',jsonb_build_object('jobId','$rejected_job','canary','canary-rejected-$rejected_index','providerStatus','$rejected_status','containerTerminated',true,'logSha256','sha256:'||repeat('9',63)||'$rejected_index','removedPaths',jsonb_build_array('/runner/_work/$rejected_label/repo'),'remainingPaths','[]'::jsonb,'providerLogId','log-rejected-$rejected_status','providerCreatedAt','$now','providerObservedAt','$now'))" >/dev/null 2>&1; then
    echo "nonterminal provider status $rejected_status unexpectedly satisfied cleanup witness" >&2
    exit 1
  fi
done

# A recovery claim is only a lease. Expiry advances the epoch and fences the
# old token; consumption is single-use. A job persisted after completion makes
# the rollout and effect monotonically forward-only rather than undoing it.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r-recovery-permit',repeat('2',40),'91',1,'191','291');
   SELECT release_authority.release_runner_prepare_effect(jsonb_build_object(
     'id','rri-'||repeat('3',63)||'2','rolloutId','r-recovery-permit','serviceId','svc-recovery-permit',
     'lifecycle','role','workflowJobId','911','runnerName','rr-recovery-permit','createdAt','$now',
     'startCommandSha256','sha256:'||repeat('3',63)||'2',
     'creationLeaseOwner','rrc-00000000-0000-4000-8000-000000000091'));
   UPDATE release_authority.runner_intent SET effect_lease_expires_at=clock_timestamp()-interval '1 second'
     WHERE intent_id='rri-'||repeat('3',63)||'2';
   SELECT release_authority.release_runner_abandon_prepared(
     'rri-'||repeat('3',63)||'2','rrc-00000000-0000-4000-8000-000000000091',0);
   INSERT INTO release_authority.source_freeze_observation(
     rollout_id,service_id,phase,latest_successful_deploy_id,observed_at,declared_service_ids)
   VALUES ('r-recovery-permit','srv-recovery','suspended','dep-recovery','$now','[\"srv-recovery\"]'::jsonb);
   SELECT release_authority.release_rollout_append_receipt(
     'r-recovery-permit',repeat('2',40),'91',1,'191','291','begin_compensation',
     'sha256:'||repeat('0',64),'sha256:'||repeat('3',63)||'2','191','before','before',NULL)" >/dev/null
recovery_intent=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_recovery_effect_intend(jsonb_build_object(
    'rolloutId','r-recovery-permit','effectKey','restore_database_writes',
    'kind','restore_database_writes'))->>'state'")
test "$recovery_intent" = intended
first_claim=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_recovery_effect_claim(jsonb_build_object(
    'rolloutId','r-recovery-permit','effectKey','restore_database_writes',
    'ownerId','recovery-worker-1','leaseSeconds',5))")
first_epoch=$(printf '%s' "$first_claim" | sed -n 's/.*"epoch": \([0-9]*\).*/\1/p')
first_token=$(printf '%s' "$first_claim" | sed -n 's/.*"permitToken": "\([a-f0-9]*\)".*/\1/p')
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "UPDATE release_authority.recovery_effect SET lease_expires_at=clock_timestamp()-interval '1 second'
   WHERE rollout_id='r-recovery-permit' AND effect_key='restore_database_writes'" >/dev/null
second_claim=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_recovery_effect_claim(jsonb_build_object(
    'rolloutId','r-recovery-permit','effectKey','restore_database_writes',
    'ownerId','recovery-worker-2','leaseSeconds',30))")
second_epoch=$(printf '%s' "$second_claim" | sed -n 's/.*"epoch": \([0-9]*\).*/\1/p')
second_token=$(printf '%s' "$second_claim" | sed -n 's/.*"permitToken": "\([a-f0-9]*\)".*/\1/p')
test "$second_epoch" -gt "$first_epoch"
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_recovery_effect_consume(jsonb_build_object(
    'rolloutId','r-recovery-permit','effectKey','restore_database_writes',
    'ownerId','recovery-worker-1','epoch',$first_epoch,'permitToken','$first_token'))" >/dev/null 2>&1; then
  echo "expired recovery permit unexpectedly replayed" >&2
  exit 1
fi
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_recovery_effect_consume(jsonb_build_object(
    'rolloutId','r-recovery-permit','effectKey','restore_database_writes',
    'ownerId','recovery-worker-2','epoch',$second_epoch,'permitToken','$second_token'));
   SELECT release_authority.release_recovery_effect_complete(jsonb_build_object(
    'rolloutId','r-recovery-permit','effectKey','restore_database_writes',
    'epoch',$second_epoch,'permitToken','$second_token','observation',
    jsonb_build_object('sourceWritesRestored',true,'aclSha256','sha256:'||repeat('2',64))))" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-recovery-late','rolloutId','r-recovery-permit',
    'provisioningIntentId','rri-'||repeat('3',63)||'2','serviceId','svc-recovery-permit',
    'observedAt','$now','providerCreationNotBefore','$now',
    'cleanupCanary','rr-cleanup:r-recovery-permit:rr-recovery-permit','lifecycle','role'))" >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT rollout.recovery_forward_only||':'||effect.state||':'||effect.epoch||':'||
      (effect.observation->>'sourceWritesRestored')
   FROM release_authority.rollout rollout JOIN release_authority.recovery_effect effect USING (rollout_id)
   WHERE rollout.rollout_id='r-recovery-permit'")" = "true:forward_repair:$second_epoch:true"

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "INSERT INTO release_authority.rollout(
     rollout_id,expected_commit_sha,run_id,run_attempt,
     source_system_identifier,target_system_identifier,
     authoritative_system_identifier,state,activation_boundary,
     source_permanently_ineligible,last_receipt_sha256,
     activation_permit_nonce,activation_epoch,activation_job_id,
     activation_previous_receipt_sha256,activation_target_deploy_ids,
     activation_postgres_major,activation_migration_checksum,activation_authorized_at)
   VALUES
    ('r-reconcile',repeat('5',40),'50',1,'150','250','250','outcome_unknown',
     'uncertain',true,'sha256:'||repeat('6',64),repeat('7',32),1,'51',
     'sha256:'||repeat('6',64),'[\"dep-r\"]',17,'sha256:'||repeat('8',64),'$now'),
    ('r-absence',repeat('9',40),'60',1,'160','260','260','outcome_unknown',
     'uncertain',true,'sha256:'||repeat('a',64),repeat('b',32),1,'61',
     'sha256:'||repeat('a',64),'[\"dep-a\"]',17,'sha256:'||repeat('c',64),'$now');" >/dev/null
reconcile_context=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_rollout_reconciliation_context('r-reconcile')->'authorization'->>'nonce'")
test "$reconcile_context" = "$(printf '7%.0s' $(seq 1 32))"
matching_observation='{"kind":"matching_activation_receipt","authorization":{"rolloutId":"r-reconcile","expectedCommitSha":"'$(printf '5%.0s' $(seq 1 40))'","postgresMajor":17,"migrationChecksum":"sha256:'$(printf '8%.0s' $(seq 1 64))'","epoch":1,"nonce":"'$(printf '7%.0s' $(seq 1 32))'","sourceSystemIdentifier":"150","targetSystemIdentifier":"250","previousReceiptSha256":"sha256:'$(printf '6%.0s' $(seq 1 64))'","targetDeployIds":["dep-r"],"authorizedAt":"'$now'"},"nextReceiptSha256":"sha256:'$(printf 'd%.0s' $(seq 1 64))'","activationReceipt":{"rolloutId":"r-reconcile","expectedCommitSha":"'$(printf '5%.0s' $(seq 1 40))'","sourceSystemIdentifier":"150","targetSystemIdentifier":"250","receiptSha256":"sha256:'$(printf 'd%.0s' $(seq 1 64))'","permitEpoch":1,"permitNonce":"'$(printf '7%.0s' $(seq 1 32))'","previousReceiptSha256":"sha256:'$(printf '6%.0s' $(seq 1 64))'","targetDeployIds":["dep-r"]}}'
reconciled_activation=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_rollout_reconcile('r-reconcile','$matching_observation')->>'state'")
test "$reconciled_activation" = activated
reconciled_replay=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_rollout_reconcile('r-reconcile','{\"kind\":\"not_required\"}')->>'state'")
test "$reconciled_replay" = activated
absence_state=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_rollout_reconcile('r-absence','{\"kind\":\"activation_absent_without_revocation\"}')->>'state'")
test "$absence_state" = forward_repair_required
absence_fence=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT activation_boundary||':'||source_permanently_ineligible||':'||authoritative_system_identifier FROM release_authority.rollout WHERE rollout_id='r-absence'")
test "$absence_fence" = uncertain:true:260

control_acl=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.observe_state('r1','100','200')")
test "$control_acl" = activated
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT count(*) FROM release_authority.rollout" >/dev/null 2>&1; then
  echo "control role unexpectedly has direct table access" >&2
  exit 1
fi
migration_acl=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "WITH migrated(proname,control_allowed) AS (VALUES
      ('release_service_transition_immutable',false),
      ('release_runner_job_cleanup_proven',false),
      ('release_runner_effect_snapshot',false),
      ('release_runner_list_intents',true),
      ('release_runner_prepare_effect',true),
      ('release_runner_acquire_dispatch_permit',true),
      ('release_runner_persist_job',true),
      ('release_runner_reconcile_effect',true),
      ('release_runner_abandon_prepared',true),
      ('release_runner_terminal_effect',false),
      ('release_runner_compensation_gate',false),
      ('release_source_freeze_immutable',false),
      ('release_source_freeze_prepare',true),
      ('release_source_freeze_record',true),
      ('release_source_freeze_complete',true),
      ('release_recovery_effect_snapshot',false),
      ('release_recovery_effect_intend',true),
      ('release_recovery_effect_claim',true),
      ('release_recovery_effect_consume',true),
      ('release_recovery_effect_complete',true),
      ('release_late_job_recovery_effect_gate',false),
      ('release_recovery_checkpoint_permit_gate',false)
    ), functions AS (
      SELECT p.oid,p.proname,m.control_allowed,p.proacl,p.proowner,p.proconfig
      FROM migrated m
      JOIN pg_catalog.pg_proc p ON p.proname=m.proname
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='release_authority'
    )
    SELECT count(*)||':'||
      bool_and(NOT EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(
          coalesce(functions.proacl,pg_catalog.acldefault('f',functions.proowner))) acl
        WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'))||':'||
      bool_and(pg_catalog.has_function_privilege(
        'reviewrouter_release_control',oid,'EXECUTE')=control_allowed)||':'||
      bool_and(NOT pg_catalog.has_function_privilege(
        'reviewrouter_provider_authority',oid,'EXECUTE'))||':'||
      bool_and(NOT pg_catalog.has_function_privilege(
        'reviewrouter_release_witness',oid,'EXECUTE'))||':'||
      bool_and(proconfig=ARRAY['search_path=pg_catalog']::text[])
    FROM functions")
test "$migration_acl" = 22:true:true:true:true:true
legacy_control_acl=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT pg_catalog.has_function_privilege('reviewrouter_release_control',
      'release_authority.release_runner_persist_intent(jsonb)','EXECUTE')||':'||
    pg_catalog.has_function_privilege('reviewrouter_release_control',
      'release_authority.release_runner_claim_provider_creation(jsonb)','EXECUTE')||':'||
    pg_catalog.has_function_privilege('reviewrouter_release_control',
      'release_authority.release_runner_record_intent_outcome(jsonb)','EXECUTE')")
test "$legacy_control_acl" = false:false:false
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_effect_snapshot(
     NULL::release_authority.runner_intent)" >/dev/null 2>&1; then
  echo "control role unexpectedly executes private effect snapshot" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_job_cleanup_proven(
     NULL::release_authority.runner_job)" >/dev/null 2>&1; then
  echo "control role unexpectedly executes private cleanup proof predicate" >&2
  exit 1
fi
for role_and_password in "reviewrouter_release_control:control" "reviewrouter_provider_authority:provider" "reviewrouter_release_witness:witness"; do
  role=${role_and_password%%:*}
  password=${role_and_password#*:}
  if docker exec -e PGPASSWORD="$password" "$name" psql -v ON_ERROR_STOP=1 -U "$role" -d postgres -Atc \
    "SELECT count(*) FROM release_authority.provider_authority_decision" >/dev/null 2>&1; then
    echo "$role unexpectedly has direct decision table access" >&2
    exit 1
  fi
done
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_provider_authority_decide('$deploy_request')" >/dev/null 2>&1; then
  echo "control credential unexpectedly has provider authority execution" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d postgres -Atc \
  "SELECT release_authority.observe_state('r1','100','200')" >/dev/null 2>&1; then
  echo "provider credential unexpectedly has control execution" >&2
  exit 1
fi

echo "release authority PG17 contract passed"
