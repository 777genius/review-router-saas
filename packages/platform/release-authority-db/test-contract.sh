#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../../.." && pwd)
name="rr-release-authority-pg17-$$"
docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=test postgres:17-alpine >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "CREATE ROLE reviewrouter_release_control LOGIN PASSWORD 'control'; CREATE ROLE reviewrouter_provider_authority LOGIN PASSWORD 'provider'; CREATE ROLE reviewrouter_release_witness LOGIN PASSWORD 'witness';"
docker cp "$root/packages/platform/release-authority-db/migrations/000001_release_authority/migration.sql" \
  "$name:/tmp/migration.sql" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/migration.sql >/dev/null

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
           THEN '{\"renderDeployIds\":[\"dep\"]}'::jsonb ELSE NULL END) THEN
         RAISE EXCEPTION 'legal receipt sequence rejected at %', steps[index];
       END IF;
       previous_sha := next_sha;
     END LOOP;
   END \$\$;
   INSERT INTO release_authority.runner_intent(
     intent_id,rollout_id,service_id,lifecycle,workflow_job_id,runner_name,created_at,
     registration_runner_id,registration_runner_group_id,registration_labels,
     registration_unique_label,registration_work_folder)
   VALUES ('rri-'||repeat('1',64),'r1','svc','cutover','9','rr-cutover','$now',
     91,92,ARRAY['self-hosted','rr-cutover'],'rr-cutover','_work/rr-cutover');
   INSERT INTO release_authority.runner_job(
     job_id,rollout_id,provisioning_intent_id,service_id,observed_at,cleanup_canary,
     lifecycle,runner_identity,provision_observation)
   VALUES ('job-cutover','r1','rri-'||repeat('1',64),'svc','$now','canary','cutover',
     '{\"workflowJobId\":\"9\"}','{\"step\":\"provision_cutover_runner\"}');" >/dev/null
stage_receipt="sha256:$(printf '%064d' 13)"
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.authorize_activation('r1', repeat('a',40), '1', 1, '100', '200', '10', '$stage_receipt', '[\"dep\"]', 17, 'sha256:'||repeat('7',64))" >/dev/null 2>&1; then
  echo "activation with an unbound cutover workflow job unexpectedly succeeded" >&2
  exit 1
fi
authorization=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.authorize_activation('r1', repeat('a',40), '1', 1, '100', '200', '9', '$stage_receipt', '[\"dep\"]', 17, 'sha256:'||repeat('7',64))")
replay=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.authorize_activation('r1', repeat('a',40), '1', 1, '100', '200', '9', '$stage_receipt', '[\"dep\"]', 17, 'sha256:'||repeat('7',64))")
state=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT state||':'||activation_epoch||':'||source_permanently_ineligible FROM release_authority.rollout WHERE rollout_id='r1'")

test "$first" = claimed
test "$duplicate" = duplicate
test "$authorization" = "$replay"
test "$state" = activation_authorized:1:true

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
  "SELECT release_authority.authorize_activation('r1', repeat('a',40), '1', 1, '100', '200', '9', '$stage_receipt', '[\"dep\"]', 17, 'sha256:'||repeat('7',64))")
test "$finalized" = t
test "$finalize_replay" = t
test "$authorization_after_finalize" = "$authorization"

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

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT release_authority.release_rollout_claim('r3', repeat('c',40), '3', 1, '102', '202');
   SELECT release_authority.release_rollout_append_receipt('r3',repeat('c',40),'3',1,'102','202',
    'begin_compensation','sha256:'||repeat('0',64),'sha256:'||repeat('2',64),'102','before','before',NULL)" >/dev/null
resume_source_request='{"rolloutId":"r3","operation":"resume_source","sourceSystemIdentifier":"102","targetSystemIdentifier":"202","expectedReceiptSha256":"sha256:'$(printf '2%.0s' $(seq 1 64))'","activationBoundary":"before"}'
docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d postgres -Atc \
  "SELECT release_authority.release_provider_authority_decide('$resume_source_request')" >/dev/null

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "INSERT INTO release_authority.runner_intent(intent_id,rollout_id,service_id,lifecycle,workflow_job_id,runner_name,created_at)
   VALUES ('rri-'||repeat('3',64),'r3','svc','role','30','rr-test','$now');
   INSERT INTO release_authority.runner_job(job_id,rollout_id,provisioning_intent_id,service_id,observed_at,cleanup_canary,lifecycle)
   VALUES ('job-clean','r3','rri-'||repeat('3',64),'svc','$now','canary','role');" >/dev/null
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc   "SELECT release_authority.release_runner_mark_terminal('job-clean','{\"step\":\"cleanup_role_runner\"}')" >/dev/null 2>&1; then
  echo "terminal CAS without provider cleanup witness unexpectedly succeeded" >&2
  exit 1
fi
cleanup_seed=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d postgres -Atc \
  "SELECT release_authority.release_runner_cleanup_observation_seed('job-clean') =
    jsonb_build_object('jobId','job-clean','serviceId','svc',
      'cleanupCanary','canary','observedAt','$now')")
test "$cleanup_seed" = t
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc \
  "SELECT release_authority.release_runner_cleanup_observation_seed('job-clean')" >/dev/null 2>&1; then
  echo "control role unexpectedly has witness seed execution" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-clean','{\"jobId\":\"job-clean\",\"canary\":\"canary\",\"providerStatus\":\"failed\",\"containerTerminated\":true,\"logSha256\":\"sha256:$(printf '4%.0s' $(seq 1 64))\",\"removedPaths\":[\"/runner/_work/rr-safe/../secret\"],\"remainingPaths\":[],\"providerLogId\":\"log-1\",\"providerObservedAt\":\"$now\"}')" >/dev/null 2>&1; then
  echo "unsafe cleanup witness unexpectedly succeeded" >&2
  exit 1
fi
cleanup_saved=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-clean','{\"jobId\":\"job-clean\",\"canary\":\"canary\",\"providerStatus\":\"succeeded\",\"containerTerminated\":true,\"logSha256\":\"sha256:$(printf '4%.0s' $(seq 1 64))\",\"removedPaths\":[\"/runner/_work/rr-safe/repo\"],\"remainingPaths\":[],\"providerLogId\":\"log-1\",\"providerObservedAt\":\"$now\"}')")
test "$cleanup_saved" = t
cleanup_replayed=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d postgres -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-clean','{\"jobId\":\"job-clean\",\"canary\":\"canary\",\"providerStatus\":\"succeeded\",\"containerTerminated\":true,\"logSha256\":\"sha256:$(printf '4%.0s' $(seq 1 64))\",\"removedPaths\":[\"/runner/_work/rr-safe/repo\"],\"remainingPaths\":[],\"providerLogId\":\"log-1\",\"providerObservedAt\":\"$now\"}')")
test "$cleanup_replayed" = t
terminal_saved=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc   "SELECT release_authority.release_runner_mark_terminal('job-clean','{\"step\":\"cleanup_role_runner\",\"observedAt\":\"$now\"}')")
test "$terminal_saved" = t
terminal_fact=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d postgres -Atc   "SELECT release_authority.release_runner_terminal_cleanup_fact('r3','role')->>'jobId'")
test "$terminal_fact" = job-clean

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
