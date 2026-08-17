#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../../.." && pwd)
name="rr-release-authority-pg17-$$"
upgrade_name="rr-release-authority-upgrade-pg17-$$"
legacy_name="rr-release-authority-legacy-pg17-$$"
named_root_name="rr-release-authority-named-root-pg17-$$"
contract_tmp=$(mktemp -d)
pg17_image=${REVIEW_ROUTER_PG17_ADVERSARIAL_IMAGE:-postgres:17.5-alpine}
docker run -d --rm --name "$name" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD=test "$pg17_image" >/dev/null
trap 'docker rm -f "$name" "$upgrade_name" "$legacy_name" "$named_root_name" >/dev/null 2>&1 || true; rm -rf "$contract_tmp"' EXIT

probe_provider_root() {
  local container=$1
  local database=$2
  local output=$3
  local probe_sql="$contract_tmp/probe-$container-$database.sql"
  node -e "import('node:crypto').then(async c=>{const m=await import('./scripts/install-release-authority-db.mjs');process.stdout.write(m.releaseAuthorityProviderRootProbeSql('rr_root_probe_'+c.randomBytes(16).toString('hex')))})" > "$probe_sql"
  docker cp "$probe_sql" "$container:/tmp/provider-root-probe.sql" >/dev/null
  docker exec -e PGPASSWORD=bootstrap-admin "$container" psql -h 127.0.0.1 \
    -v ON_ERROR_STOP=1 -qAt -U reviewrouter_bootstrap_administrator \
    -d "$database" -f /tmp/provider-root-probe.sql > "$output"
  node -e "const p=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'));if(!p.systemIdentifier||!p.rootOid||p.providerName!=='reviewrouter_bootstrap_administrator')process.exit(1)" "$output"
}

render_bootstrap_sql() {
  local operation=$1 role=$2 password=$3 pin_file=$4 output=$5 lifecycle=${6:-fresh}
  node -e "const fs=require('node:fs');import('./scripts/install-release-authority-db.mjs').then(m=>{const pin=JSON.parse(fs.readFileSync(process.argv[4],'utf8'));const sql=process.argv[1]==='prepare'?m.releaseAuthorityBootstrapPreparationSql(process.argv[2],pin):m.releaseAuthorityBootstrapProvisioningSql(process.argv[2],process.argv[3],pin,process.argv[5]);process.stdout.write(sql)})" \
    "$operation" "$role" "$password" "$pin_file" "$lifecycle" > "$output"
}

for _ in $(seq 1 60); do
  # The official image briefly exposes an init-only Unix socket before it
  # restarts into the final server. TCP becomes ready only for the final server.
  if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
postgres_port=$(docker port "$name" 5432/tcp | sed 's/.*://')

# Root names are provider facts, never implementation constants.
docker run -d --rm --name "$named_root_name" \
  -e POSTGRES_USER=rr_named_provider_root -e POSTGRES_PASSWORD=test \
  "$pg17_image" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$named_root_name" pg_isready -h 127.0.0.1 \
      -U rr_named_provider_root >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$named_root_name" psql -v ON_ERROR_STOP=1 \
  -U rr_named_provider_root -d postgres -c \
  "CREATE ROLE reviewrouter_bootstrap_administrator LOGIN PASSWORD 'bootstrap-admin'
     NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1" >/dev/null
docker exec -e PGPASSWORD=bootstrap-admin "$named_root_name" psql -h 127.0.0.1 \
  -v ON_ERROR_STOP=1 -U reviewrouter_bootstrap_administrator -d postgres -c \
  "SET createrole_self_grant=''; CREATE ROLE rr_named_root_bootstrap NOLOGIN" >/dev/null
docker exec "$named_root_name" psql -v ON_ERROR_STOP=1 \
  -U rr_named_provider_root -d postgres -c \
  "CREATE DATABASE rr_named_root_contract OWNER rr_named_root_bootstrap" >/dev/null
probe_provider_root "$named_root_name" rr_named_root_contract \
  "$contract_tmp/named-provider-root.json"
test "$(node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).rootName)" \
  "$contract_tmp/named-provider-root.json")" = rr_named_provider_root
docker rm -f "$named_root_name" >/dev/null

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "CREATE ROLE reviewrouter_release_control LOGIN PASSWORD 'control';
   CREATE ROLE reviewrouter_provider_authority LOGIN PASSWORD 'provider';
   CREATE ROLE reviewrouter_release_witness LOGIN PASSWORD 'witness';
   CREATE ROLE reviewrouter_migration_issuer LOGIN PASSWORD 'issuer';
   CREATE ROLE reviewrouter_bootstrap_administrator LOGIN PASSWORD 'bootstrap-admin'
     NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1;
   GRANT pg_signal_backend TO reviewrouter_bootstrap_administrator;
   CREATE ROLE \"reviewrouter quoted acl probe\" NOLOGIN;"
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
docker cp "$root/packages/platform/release-authority-db/migrations/000003_partial_source_freeze/migration.sql" \
  "$name:/tmp/migration-000003.sql" >/dev/null
docker cp "$root/packages/platform/release-authority-db/migrations/000004_selective_source_recovery/migration.sql" \
  "$name:/tmp/migration-000004.sql" >/dev/null
docker cp "$root/packages/platform/release-authority-db/migrations/000005_late_runner_effects/migration.sql" \
  "$name:/tmp/migration-000005.sql" >/dev/null
docker cp "$root/packages/platform/release-authority-db/migrations/000006_runner_provider_creation_boundary/migration.sql" \
  "$name:/tmp/migration-000006.sql" >/dev/null
docker cp "$root/packages/platform/release-authority-db/migrations/000007_compensation_effect_fence/migration.sql" \
  "$name:/tmp/migration-000007.sql" >/dev/null
docker cp "$root/packages/platform/release-authority-db/migrations/000008_trigger_helper_acl/migration.sql" \
  "$name:/tmp/migration-000008.sql" >/dev/null

# The only ledgerless catalogs accepted below are exact two-file audit
# boundaries. Later migrations are applied only after that byte variant is
# identified, while both mixed pairs and every catalog modification fail
# before schema_migration exists.
node -e "import('./scripts/install-release-authority-db.mjs').then(m => process.stdout.write(m.releaseAuthorityMigrationBundle('incremental-upgrade',process.cwd())))" \
  > /tmp/release-authority-install-$$.sql
docker cp "/tmp/release-authority-install-$$.sql" "$name:/tmp/release-authority-install.sql" >/dev/null

# Exercise the production upgrade gate itself, independently of the authority
# routine contract below. These fixtures cover both explicit modes, concurrent
# callers, bounded lock waits, atomic failure, drift, and replay.
node -e "import('./scripts/install-release-authority-db.mjs').then(m => process.stdout.write(m.releaseAuthorityMigrationBundle('fresh-install',process.cwd())))" \
  > "$contract_tmp/fresh.sql"
node -e "import('./scripts/install-release-authority-db.mjs').then(m => process.stdout.write(m.releaseAuthorityMigrationBundle('incremental-upgrade',process.cwd(),{lockTimeoutMs:200,statementTimeoutMs:2000})))" \
  > "$contract_tmp/short-upgrade.sql"
node -e "import('./scripts/install-release-authority-db.mjs').then(m => process.stdout.write(m.releaseAuthorityMigrationBundle('fresh-install',process.cwd()).replace('\nCOMMIT;\n','\nSELECT definitely_missing_release_authority_probe();\nCOMMIT;\n')))" \
  > "$contract_tmp/failing-fresh.sql"
node -e "import('./scripts/install-release-authority-db.mjs').then(m => process.stdout.write(m.releaseAuthorityMigrationBundle('fresh-install',process.cwd()).replace('\n     \$upgrade_gate\$;','\n     \$upgrade_gate\$;\nSELECT pg_sleep(2);')))" \
  > "$contract_tmp/slow-fresh.sql"
node -e "import('./scripts/install-release-authority-db.mjs').then(m => process.stdout.write(m.releaseAuthorityMigrationBundle('incremental-upgrade',process.cwd()).replace('\n     \$upgrade_gate\$;','\n     \$upgrade_gate\$;\nSELECT pg_sleep(2);')))" \
  > "$contract_tmp/slow-upgrade.sql"
for gate_file in fresh short-upgrade failing-fresh slow-fresh slow-upgrade; do
  docker cp "$contract_tmp/$gate_file.sql" "$name:/tmp/$gate_file.sql" >/dev/null
done
docker exec -e PGPASSWORD=bootstrap-admin "$name" psql -h 127.0.0.1 \
  -v ON_ERROR_STOP=1 -U reviewrouter_bootstrap_administrator -d postgres -c \
  "SET createrole_self_grant='';
   CREATE ROLE rr_authority_gate_bootstrap LOGIN PASSWORD 'gate-bootstrap'
     NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "CREATE DATABASE rr_authority_gate OWNER rr_authority_gate_bootstrap" >/dev/null
probe_provider_root "$name" rr_authority_gate "$contract_tmp/gate-provider-root.json"
test "$(node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).rootName)" \
  "$contract_tmp/gate-provider-root.json")" = postgres
# PG17 does not let P normalize the implicit root edge by re-GRANTing it.
if docker exec -e PGPASSWORD=bootstrap-admin "$name" psql -h 127.0.0.1 \
    -v ON_ERROR_STOP=1 -U reviewrouter_bootstrap_administrator \
    -d rr_authority_gate -c \
    "GRANT rr_authority_gate_bootstrap TO reviewrouter_bootstrap_administrator
       WITH ADMIN TRUE, INHERIT FALSE, SET FALSE" >/dev/null 2>&1; then
  echo "provider bootstrap re-GRANT unexpectedly rewrote the root edge" >&2
  exit 1
fi
node -e "const fs=require('node:fs');import('./scripts/install-release-authority-db.mjs').then(m=>process.stdout.write(m.releaseAuthorityBootstrapLifecycleSql('rr_authority_gate_bootstrap',JSON.parse(fs.readFileSync(process.argv[1],'utf8')))))" \
  "$contract_tmp/gate-provider-root.json" > "$contract_tmp/gate-lifecycle.sql"
docker cp "$contract_tmp/gate-lifecycle.sql" "$name:/tmp/gate-lifecycle.sql" >/dev/null
# The pin is OID+name, not merely a catalog-present role. A provider-root
# rename is drift until an explicit re-enrollment ceremony supplies a new pin.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "CREATE ROLE rr_provider_root_operator LOGIN SUPERUSER PASSWORD 'root-operator'" >/dev/null
docker exec -e PGPASSWORD=root-operator "$name" psql -h 127.0.0.1 \
  -v ON_ERROR_STOP=1 -U rr_provider_root_operator -d postgres -c \
  "ALTER ROLE postgres RENAME TO rr_provider_root_renamed" >/dev/null
test "$(docker exec -e PGPASSWORD=bootstrap-admin "$name" psql -h 127.0.0.1 \
  -v ON_ERROR_STOP=1 -At -U reviewrouter_bootstrap_administrator \
  -d rr_authority_gate -f /tmp/gate-lifecycle.sql)" = drifted
docker exec -e PGPASSWORD=root-operator "$name" psql -h 127.0.0.1 \
  -v ON_ERROR_STOP=1 -U rr_provider_root_operator -d postgres -c \
  "ALTER ROLE rr_provider_root_renamed RENAME TO postgres" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "DROP ROLE rr_provider_root_operator" >/dev/null
# A second catalog grantor is not adoptable merely because it exists.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "CREATE ROLE rr_foreign_root NOLOGIN;
   GRANT rr_authority_gate_bootstrap TO rr_foreign_root
     WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
   SET ROLE rr_foreign_root;
   GRANT rr_authority_gate_bootstrap TO reviewrouter_bootstrap_administrator
     WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
   RESET ROLE" >/dev/null
test "$(docker exec -e PGPASSWORD=bootstrap-admin "$name" psql -h 127.0.0.1 \
  -v ON_ERROR_STOP=1 -At -U reviewrouter_bootstrap_administrator \
  -d rr_authority_gate -f /tmp/gate-lifecycle.sql)" = drifted
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "REVOKE rr_authority_gate_bootstrap FROM reviewrouter_bootstrap_administrator
     GRANTED BY rr_foreign_root RESTRICT;
   REVOKE rr_authority_gate_bootstrap FROM rr_foreign_root RESTRICT;
   DROP ROLE rr_foreign_root" >/dev/null
render_bootstrap_sql provision rr_authority_gate_bootstrap gate-bootstrap \
  "$contract_tmp/gate-provider-root.json" "$contract_tmp/gate-provision.sql"
render_bootstrap_sql prepare rr_authority_gate_bootstrap gate-bootstrap \
  "$contract_tmp/gate-provider-root.json" "$contract_tmp/gate-prepare.sql"
node -e "import('./scripts/install-release-authority-db.mjs').then(m => process.stdout.write(m.releaseAuthorityBootstrapRelinquishSql('rr_authority_gate_bootstrap')))" \
  > "$contract_tmp/gate-relinquish.sql"
docker cp "$contract_tmp/gate-provision.sql" "$name:/tmp/gate-provision.sql" >/dev/null
docker cp "$contract_tmp/gate-prepare.sql" "$name:/tmp/gate-prepare.sql" >/dev/null
docker cp "$contract_tmp/gate-relinquish.sql" "$name:/tmp/gate-relinquish.sql" >/dev/null
# Existing canonical roles created by any identity other than the provider lack
# PostgreSQL 17's exact shared provider-root ADMIN edge and must never be adopted.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "CREATE ROLE reviewrouter_authority_owner NOLOGIN;
   CREATE ROLE reviewrouter_migration_broker NOLOGIN CREATEROLE" >/dev/null
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_bootstrap_administrator \
  -d rr_authority_gate -f /tmp/gate-provision.sql >/dev/null 2>&1; then
  echo "provider adopted roles without exact implicit ADMIN authority" >&2
  exit 1
fi
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "DROP ROLE reviewrouter_migration_broker;
   DROP ROLE reviewrouter_authority_owner" >/dev/null
# A bootstrap-owned malicious preseed cannot be adopted, overwritten, or
# treated as a comment-only identity. Provisioning fails closed until the
# database owner explicitly removes it.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap \
  -d rr_authority_gate -c \
  "CREATE SCHEMA reviewrouter_migration_bootstrap;
   CREATE FUNCTION reviewrouter_migration_bootstrap.quiesce(name,name)
   RETURNS void LANGUAGE plpgsql AS \$\$BEGIN NULL; END\$\$" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap \
  -d rr_authority_gate -f /tmp/gate-prepare.sql >/dev/null
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_bootstrap_administrator \
  -d rr_authority_gate -f /tmp/gate-provision.sql >/dev/null 2>&1; then
  echo "provider adopted a bootstrap-owned malicious helper preseed" >&2
  exit 1
fi
docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap \
  -d rr_authority_gate -f /tmp/gate-relinquish.sql >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap \
  -d rr_authority_gate -c \
  "DROP FUNCTION reviewrouter_migration_bootstrap.quiesce(name,name) RESTRICT;
   DROP SCHEMA reviewrouter_migration_bootstrap RESTRICT" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap \
  -d rr_authority_gate -f /tmp/gate-prepare.sql >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_bootstrap_administrator \
  -d rr_authority_gate -f /tmp/gate-provision.sql >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap \
  -d rr_authority_gate -f /tmp/gate-relinquish.sql >/dev/null

# Every creating-owner default family, including PUBLIC and a quoted arbitrary
# role, must stop a fresh install before authority DDL. Restoring the empty
# canonical default permits the same bundle to proceed.
for default_case in \
  'TABLES|SELECT|PUBLIC' \
  'SEQUENCES|USAGE|"reviewrouter quoted acl probe"' \
  'FUNCTIONS|EXECUTE|"reviewrouter quoted acl probe"' \
  'TYPES|USAGE|"reviewrouter quoted acl probe"'; do
  IFS='|' read -r objects privilege grantee <<<"$default_case"
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap -d rr_authority_gate -c \
    "ALTER DEFAULT PRIVILEGES GRANT $privilege ON $objects TO $grantee" >/dev/null
  if docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap -d rr_authority_gate \
    -f /tmp/fresh.sql >/dev/null 2>&1; then
    echo "fresh authority install accepted malicious global $objects defaults" >&2
    exit 1
  fi
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap -d rr_authority_gate -c \
    "ALTER DEFAULT PRIVILEGES REVOKE $privilege ON $objects FROM $grantee" >/dev/null
done

if docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap -d rr_authority_gate \
  -f /tmp/release-authority-install.sql >/dev/null 2>&1; then
  echo "incremental authority upgrade admitted an absent authority schema" >&2
  exit 1
fi

# A failed fresh install is wholly rolled back, and a clean rerun succeeds.
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap -d rr_authority_gate \
  -f /tmp/failing-fresh.sql >/dev/null 2>&1; then
  echo "deliberately failed authority fresh install unexpectedly committed" >&2
  exit 1
fi
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT to_regnamespace('release_authority') IS NULL")" = t

bootstrap_provider_file="$contract_tmp/bootstrap-provider-url"
bootstrap_retry_file="$contract_tmp/bootstrap-retry-url"
printf '%s' "postgresql://reviewrouter_bootstrap_administrator:bootstrap-admin@127.0.0.1:$postgres_port/rr_authority_gate?sslmode=disable" \
  >"$bootstrap_provider_file"
printf '%s' "postgresql://rr_authority_gate_bootstrap:gate-bootstrap@127.0.0.1:$postgres_port/rr_authority_gate?sslmode=disable" \
  >"$bootstrap_retry_file"
chmod 600 "$bootstrap_provider_file" "$bootstrap_retry_file"
# Converge a real post-provisioning failure. Cleanup disables the database
# owner and removes its authority edges while retaining only the inert
# provider-admin recovery edge; provisioning then re-enables exactly that role
# and reconstructs the attested helper for retry.
REVIEW_ROUTER_RELEASE_AUTHORITY_PROVIDER_DATABASE_URL_FILE="$bootstrap_provider_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE="$bootstrap_retry_file" \
  node scripts/install-release-authority-db.mjs --cleanup-bootstrap
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT role.rolcanlogin::text||':'||count(membership.roleid)::text
   FROM pg_roles role LEFT JOIN pg_auth_members membership
     ON membership.roleid=role.oid OR membership.member=role.oid
   WHERE role.rolname='rr_authority_gate_bootstrap' GROUP BY role.rolcanlogin")" = \
  false:1
REVIEW_ROUTER_RELEASE_AUTHORITY_PROVIDER_DATABASE_URL_FILE="$bootstrap_provider_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE="$bootstrap_retry_file" \
  node scripts/install-release-authority-db.mjs --provision-bootstrap
render_bootstrap_sql provision rr_authority_gate_bootstrap gate-bootstrap \
  "$contract_tmp/gate-provider-root.json" "$contract_tmp/gate-provision.sql" retryable
docker cp "$contract_tmp/gate-provision.sql" "$name:/tmp/gate-provision.sql" >/dev/null
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap \
    -d rr_authority_gate -c \
    "CREATE OR REPLACE FUNCTION reviewrouter_migration_bootstrap.quiesce(p_bootstrap name,p_database name)
     RETURNS void LANGUAGE plpgsql AS \$\$BEGIN NULL; END\$\$" >/dev/null 2>&1; then
  echo "bootstrap replaced the provider-owned quiescence helper" >&2
  exit 1
fi
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap \
    -d rr_authority_gate -c \
    "CREATE FUNCTION reviewrouter_migration_bootstrap.quiesce(text,text)
     RETURNS void LANGUAGE plpgsql AS \$\$BEGIN NULL; END\$\$" >/dev/null 2>&1; then
  echo "bootstrap overloaded the provider-owned quiescence helper" >&2
  exit 1
fi

assert_helper_tamper_rejected() {
  local tamper_sql=$1
  docker exec "$name" psql -v ON_ERROR_STOP=1 \
    -U reviewrouter_bootstrap_administrator -d rr_authority_gate \
    -c "$tamper_sql" >/dev/null
  if docker exec "$name" psql -v ON_ERROR_STOP=1 \
      -U rr_authority_gate_bootstrap -d rr_authority_gate \
      -f /tmp/fresh.sql >/dev/null 2>&1; then
    echo "fresh authority install accepted a tampered quiescence helper" >&2
    exit 1
  fi
  docker exec "$name" psql -v ON_ERROR_STOP=1 \
    -U reviewrouter_bootstrap_administrator -d rr_authority_gate \
    -c "DROP SCHEMA reviewrouter_migration_bootstrap CASCADE" >/dev/null
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap \
    -d rr_authority_gate -f /tmp/gate-prepare.sql >/dev/null
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_bootstrap_administrator \
    -d rr_authority_gate -f /tmp/gate-provision.sql >/dev/null
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap \
    -d rr_authority_gate -f /tmp/gate-relinquish.sql >/dev/null
}
assert_helper_tamper_rejected \
  "CREATE OR REPLACE FUNCTION reviewrouter_migration_bootstrap.quiesce(p_bootstrap name,p_database name)
   RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
   AS \$\$BEGIN RAISE EXCEPTION 'malicious helper executed'; END\$\$"
assert_helper_tamper_rejected \
  "GRANT CREATE ON SCHEMA reviewrouter_migration_bootstrap TO rr_authority_gate_bootstrap;
   GRANT EXECUTE ON FUNCTION reviewrouter_migration_bootstrap.quiesce(name,name) TO PUBLIC"
assert_helper_tamper_rejected \
  "CREATE FUNCTION reviewrouter_migration_bootstrap.quiesce(text,text)
   RETURNS void LANGUAGE plpgsql AS \$\$BEGIN NULL; END\$\$"
assert_helper_tamper_rejected \
  "CREATE TABLE reviewrouter_migration_bootstrap.unexpected_object(value integer)"

# Global roles are cluster-wide. Cross-database ownership, role configuration,
# and an unrelated membership all stop migration before quiescence.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "CREATE DATABASE rr_cross_database_owner OWNER reviewrouter_authority_owner" >/dev/null
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap \
    -d rr_authority_gate -f /tmp/fresh.sql >/dev/null 2>&1; then
  echo "fresh install accepted cross-database owner authority" >&2
  exit 1
fi
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "DROP DATABASE rr_cross_database_owner" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "ALTER ROLE reviewrouter_authority_owner SET work_mem='1MB'" >/dev/null
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap \
    -d rr_authority_gate -f /tmp/fresh.sql >/dev/null 2>&1; then
  echo "fresh install accepted authority-owner role configuration" >&2
  exit 1
fi
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "ALTER ROLE reviewrouter_authority_owner RESET ALL;
   GRANT reviewrouter_authority_owner TO \"reviewrouter quoted acl probe\"" >/dev/null
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap \
    -d rr_authority_gate -f /tmp/fresh.sql >/dev/null 2>&1; then
  echo "fresh install accepted unrelated authority-owner membership" >&2
  exit 1
fi
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "REVOKE reviewrouter_authority_owner FROM \"reviewrouter quoted acl probe\"" >/dev/null

# Establish three bootstrap sessions under deliberate provider-induced drift,
# then restore the canonical connection limit before migration starts. Existing
# sessions survive the limit reduction: one has assumed the owner, one the
# broker, and a third races the winner. Migration must reject all foreign
# bootstrap sessions; only provider cleanup may terminate them, and terminal
# deletion happens after the final B session exits.
docker exec -e PGPASSWORD=bootstrap-admin "$name" psql -h 127.0.0.1 \
  -v ON_ERROR_STOP=1 -U reviewrouter_bootstrap_administrator -d postgres -c \
  "ALTER ROLE rr_authority_gate_bootstrap CONNECTION LIMIT 5" >/dev/null
owner_fifo="$contract_tmp/bootstrap-owner.fifo"
broker_fifo="$contract_tmp/bootstrap-broker.fifo"
loser_fifo="$contract_tmp/bootstrap-loser.fifo"
mkfifo "$owner_fifo" "$broker_fifo" "$loser_fifo"
exec 8<>"$owner_fifo" 9<>"$broker_fifo" 10<>"$loser_fifo"
docker exec -i "$name" psql -qAt -v ON_ERROR_STOP=1 \
  -U rr_authority_gate_bootstrap -d rr_authority_gate \
  <"$owner_fifo" >"$contract_tmp/bootstrap-owner.out" 2>&1 &
owner_backend_pid=$!
docker exec -i "$name" psql -qAt -v ON_ERROR_STOP=1 \
  -U rr_authority_gate_bootstrap -d rr_authority_gate \
  <"$broker_fifo" >"$contract_tmp/bootstrap-broker.out" 2>&1 &
broker_backend_pid=$!
docker exec -i "$name" psql -qAt -v ON_ERROR_STOP=1 \
  -U rr_authority_gate_bootstrap -d rr_authority_gate \
  <"$loser_fifo" >"$contract_tmp/bootstrap-loser.out" 2>&1 &
loser_backend_pid=$!
printf '%s\n' 'SET ROLE reviewrouter_authority_owner;' \
  'SELECT current_user;' 'SELECT pg_sleep(30);' >&8
printf '%s\n' 'SET ROLE reviewrouter_migration_broker;' \
  'SELECT current_user;' 'SELECT pg_sleep(30);' >&9
printf '%s\n' '\set ON_ERROR_STOP on' "SELECT 'bootstrap_loser_ready';" >&10
for _ in $(seq 1 40); do
  if grep -q '^reviewrouter_authority_owner$' "$contract_tmp/bootstrap-owner.out" \
      && grep -q '^reviewrouter_migration_broker$' "$contract_tmp/bootstrap-broker.out" \
      && grep -q '^bootstrap_loser_ready$' "$contract_tmp/bootstrap-loser.out"; then
    break
  fi
  sleep 0.05
done
grep -q '^reviewrouter_authority_owner$' "$contract_tmp/bootstrap-owner.out"
grep -q '^reviewrouter_migration_broker$' "$contract_tmp/bootstrap-broker.out"
grep -q '^bootstrap_loser_ready$' "$contract_tmp/bootstrap-loser.out"

docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap -d rr_authority_gate \
  -f /tmp/slow-fresh.sql >/dev/null &
fresh_gate_pid=$!
for _ in $(seq 1 40); do
  if test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
      "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=1381126735 AND objid=1381258071 AND granted)")" = t; then
    break
  fi
  sleep 0.05
done
docker exec -e PGPASSWORD=bootstrap-admin "$name" psql -h 127.0.0.1 \
  -v ON_ERROR_STOP=1 -U reviewrouter_bootstrap_administrator -d postgres -c \
  "ALTER ROLE rr_authority_gate_bootstrap CONNECTION LIMIT 1" >/dev/null
printf '%s\n' '\i /tmp/fresh.sql' >&10
if wait "$loser_backend_pid"; then
  echo "concurrent authority fresh installer was admitted" >&2
  exit 1
fi
if wait "$fresh_gate_pid"; then
  echo "migration quiesced bootstrap while foreign B sessions remained" >&2
  exit 1
fi
REVIEW_ROUTER_RELEASE_AUTHORITY_PROVIDER_DATABASE_URL_FILE="$bootstrap_provider_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE="$bootstrap_retry_file" \
  node scripts/install-release-authority-db.mjs --cleanup-bootstrap
wait "$owner_backend_pid" >/dev/null 2>&1 || true
wait "$broker_backend_pid" >/dev/null 2>&1 || true
exec 8>&- 9>&- 10>&-
REVIEW_ROUTER_RELEASE_AUTHORITY_PROVIDER_DATABASE_URL_FILE="$bootstrap_provider_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE="$bootstrap_retry_file" \
  node scripts/install-release-authority-db.mjs --provision-bootstrap
docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap \
  -d rr_authority_gate -f /tmp/fresh.sql >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT count(*) FROM pg_catalog.pg_stat_activity
   WHERE usename='rr_authority_gate_bootstrap'")" = 0
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT (pg_catalog.to_regnamespace('reviewrouter_migration_bootstrap') IS NULL)::text||':'||
     pg_catalog.has_database_privilege('reviewrouter_bootstrap_administrator',current_database(),'CREATE')::text||':'||
     pg_catalog.has_database_privilege('rr_authority_gate_bootstrap',current_database(),'CREATE')::text")" = \
  false:false:false
# An ambiguous successful bootstrap commit is recognized from terminal state;
# retry observes cleanup-pending and deletes the quiesced bootstrap role.
REVIEW_ROUTER_RELEASE_AUTHORITY_PROVIDER_DATABASE_URL_FILE="$bootstrap_provider_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE="$bootstrap_retry_file" \
  node scripts/install-release-authority-db.mjs --fresh-install
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT pg_catalog.to_regrole('rr_authority_gate_bootstrap') IS NULL")" = t
for _ in 1 2; do
  REVIEW_ROUTER_RELEASE_AUTHORITY_PROVIDER_DATABASE_URL_FILE="$bootstrap_provider_file" \
  REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE="$bootstrap_retry_file" \
    node scripts/install-release-authority-db.mjs --cleanup-bootstrap
done
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT pg_catalog.to_regrole('rr_authority_gate_bootstrap') IS NULL")" = t
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U rr_authority_gate_bootstrap -d rr_authority_gate \
  -f /tmp/fresh.sql >/dev/null 2>&1; then
  echo "fresh authority installer admitted an existing authority schema" >&2
  exit 1
fi

# Install the exact origin/main published history in a second disposable
# database, advance it through the 000012 boundary, then run the candidate
# append-only 000012 -> 000016 upgrade. Published bytes are pinned separately.
# intentionally sourced from git objects rather than the candidate worktree.
docker run -d --rm --name "$upgrade_name" -e POSTGRES_PASSWORD=test "$pg17_image" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$upgrade_name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$upgrade_name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "CREATE ROLE reviewrouter_release_control LOGIN PASSWORD 'control';
   CREATE ROLE reviewrouter_provider_authority LOGIN PASSWORD 'provider';
   CREATE ROLE reviewrouter_release_witness LOGIN PASSWORD 'witness';
   CREATE ROLE reviewrouter_migration_issuer LOGIN PASSWORD 'issuer';
   CREATE ROLE reviewrouter_bootstrap_administrator LOGIN PASSWORD 'bootstrap-admin'
     NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1;
   GRANT pg_signal_backend TO reviewrouter_bootstrap_administrator" >/dev/null
docker exec -e PGPASSWORD=bootstrap-admin "$upgrade_name" psql -h 127.0.0.1 \
  -v ON_ERROR_STOP=1 -U reviewrouter_bootstrap_administrator -d postgres -c \
  "SET createrole_self_grant=''; CREATE ROLE rr_origin_bootstrap LOGIN
    PASSWORD 'origin-bootstrap' NOSUPERUSER NOCREATEDB CREATEROLE
    NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1" >/dev/null
docker exec "$upgrade_name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "CREATE DATABASE rr_authority_origin_upgrade OWNER rr_origin_bootstrap" >/dev/null
probe_provider_root "$upgrade_name" rr_authority_origin_upgrade \
  "$contract_tmp/origin-provider-root.json"
render_bootstrap_sql prepare rr_origin_bootstrap origin-bootstrap \
  "$contract_tmp/origin-provider-root.json" "$contract_tmp/origin-prepare.sql"
render_bootstrap_sql provision rr_origin_bootstrap origin-bootstrap \
  "$contract_tmp/origin-provider-root.json" "$contract_tmp/origin-provision.sql"
node -e "import('./scripts/install-release-authority-db.mjs').then(m => process.stdout.write(m.releaseAuthorityBootstrapRelinquishSql('rr_origin_bootstrap')))" \
  > "$contract_tmp/origin-relinquish.sql"
for origin_bootstrap_file in prepare provision relinquish; do
  docker cp "$contract_tmp/origin-$origin_bootstrap_file.sql" \
    "$upgrade_name:/tmp/origin-$origin_bootstrap_file.sql" >/dev/null
done
docker exec "$upgrade_name" psql -v ON_ERROR_STOP=1 -U rr_origin_bootstrap \
  -d rr_authority_origin_upgrade -f /tmp/origin-prepare.sql >/dev/null
docker exec "$upgrade_name" psql -v ON_ERROR_STOP=1 -U reviewrouter_bootstrap_administrator \
  -d rr_authority_origin_upgrade -f /tmp/origin-provision.sql >/dev/null
docker exec "$upgrade_name" psql -v ON_ERROR_STOP=1 -U rr_origin_bootstrap \
  -d rr_authority_origin_upgrade -f /tmp/origin-relinquish.sql >/dev/null
docker cp "/tmp/release-authority-install-$$.sql" \
  "$upgrade_name:/tmp/release-authority-install.sql" >/dev/null
contract_baseline_ref=${REVIEW_ROUTER_RELEASE_AUTHORITY_CONTRACT_BASELINE_REF:-origin/main}
git cat-file -e "$contract_baseline_ref^{commit}"
while IFS= read -r published_migration; do
  published_copy="$contract_tmp/published-$(basename "$(dirname "$published_migration")").sql"
  git show "$contract_baseline_ref:$published_migration" > "$published_copy"
  cmp -s "$published_copy" "$root/$published_migration" || {
    echo "published authority migration drifted: $published_migration" >&2
    exit 1
  }
done < <(git ls-tree -r --name-only "$contract_baseline_ref" -- \
  packages/platform/release-authority-db/migrations | grep '/migration.sql$')
origin_migrations='000001_release_authority 000002_external_effect_protocol 000002_transactional_service_transition 000003_partial_source_freeze 000004_selective_source_recovery 000005_late_runner_effects 000006_runner_provider_creation_boundary 000007_compensation_effect_fence 000008_trigger_helper_acl 000009_authority_history_and_forward_repairs 000010_recovery_effect_permits'
for origin_migration in $origin_migrations; do
  git show "$contract_baseline_ref:packages/platform/release-authority-db/migrations/$origin_migration/migration.sql" \
    > "$contract_tmp/origin-$origin_migration.sql"
  docker cp "$contract_tmp/origin-$origin_migration.sql" \
    "$upgrade_name:/tmp/origin-$origin_migration.sql" >/dev/null
  docker exec "$upgrade_name" psql -v ON_ERROR_STOP=1 -U rr_origin_bootstrap \
    -d rr_authority_origin_upgrade \
    -f "/tmp/origin-$origin_migration.sql" >/dev/null
  if test "$origin_migration" = 000009_authority_history_and_forward_repairs; then
    docker exec "$upgrade_name" psql -v ON_ERROR_STOP=1 -U rr_origin_bootstrap \
      -d rr_authority_origin_upgrade -c \
      "INSERT INTO release_authority.schema_migration(position,migration_name,checksum_sha256,byte_variant) VALUES (10,'000009_authority_history_and_forward_repairs','sha256:bc2fb62a012ad9676ce696a5652abc8d29f2110243f0072dc75bcdcfb0ac8e25','canonical')" >/dev/null
  elif test "$origin_migration" = 000010_recovery_effect_permits; then
    docker exec "$upgrade_name" psql -v ON_ERROR_STOP=1 -U rr_origin_bootstrap \
      -d rr_authority_origin_upgrade -c \
      "INSERT INTO release_authority.schema_migration(position,migration_name,checksum_sha256,byte_variant) VALUES (11,'000010_recovery_effect_permits','sha256:a7f1f5063b83f53dfd95dda6bf70740fd2e586dbed368903d7098190cf6200fd','canonical')" >/dev/null
  fi
done
for boundary_migration in \
  000011_default_and_final_acl_exactness \
  000012_provider_mutation_resource_fence; do
  docker cp "$root/packages/platform/release-authority-db/migrations/$boundary_migration/migration.sql" \
    "$upgrade_name:/tmp/boundary-$boundary_migration.sql" >/dev/null
  docker exec "$upgrade_name" psql -v ON_ERROR_STOP=1 -U rr_origin_bootstrap \
    -d rr_authority_origin_upgrade \
    -f "/tmp/boundary-$boundary_migration.sql" >/dev/null
done
docker exec "$upgrade_name" psql -v ON_ERROR_STOP=1 -U rr_origin_bootstrap \
  -d rr_authority_origin_upgrade -c \
  "INSERT INTO release_authority.schema_migration(position,migration_name,checksum_sha256,byte_variant) VALUES
   (12,'000011_default_and_final_acl_exactness','sha256:727a6615bb6c1af3aee4e69ed33648726b581adb4f4b2f7610be9f5518347420','canonical'),
   (13,'000012_provider_mutation_resource_fence','sha256:095ce8c8859c8ddf51a526aeee2673f1f84853f2c479cef7cb92871ef749554a','canonical')" >/dev/null
docker exec "$upgrade_name" psql -v ON_ERROR_STOP=1 -U rr_origin_bootstrap \
  -d rr_authority_origin_upgrade -f /tmp/release-authority-install.sql >/dev/null
test "$(docker exec "$upgrade_name" psql -v ON_ERROR_STOP=1 -U postgres \
  -d rr_authority_origin_upgrade -Atc \
  "SELECT count(*)||':'||max(position) FROM release_authority.schema_migration")" = 17:17
fresh_catalog_identity=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres \
  -d rr_authority_gate -Atc \
  "SELECT obj_description('release_authority'::regnamespace,'pg_namespace')")
upgrade_catalog_identity=$(docker exec "$upgrade_name" psql -v ON_ERROR_STOP=1 -U postgres \
  -d rr_authority_origin_upgrade -Atc \
  "SELECT obj_description('release_authority'::regnamespace,'pg_namespace')")
test "$upgrade_catalog_identity" = "$fresh_catalog_identity"
# The catalog attestation above covers ACLs, but keep a focused normalized ACL
# projection so a fresh install and the 000012 -> 000016 path mechanically
# prove identical owners and explicit object edges as well.
cat > /tmp/release-authority-final-acl-state-$$.sql <<'SQL'
WITH target AS (
  SELECT oid FROM pg_catalog.pg_namespace WHERE nspname='release_authority'
), acl_state AS (
  SELECT 'schema'::text AS kind,nspname AS identity,
    pg_catalog.pg_get_userbyid(nspowner) AS owner,nspacl AS acl
  FROM pg_catalog.pg_namespace CROSS JOIN target
  WHERE pg_namespace.oid=target.oid
  UNION ALL
  SELECT 'relation',relation.oid::regclass::text,
    pg_catalog.pg_get_userbyid(relation.relowner),relation.relacl
  FROM pg_catalog.pg_class relation CROSS JOIN target
  WHERE relation.relnamespace=target.oid
  UNION ALL
  SELECT 'routine',procedure.oid::regprocedure::text,
    pg_catalog.pg_get_userbyid(procedure.proowner),procedure.proacl
  FROM pg_catalog.pg_proc procedure CROSS JOIN target
  WHERE procedure.pronamespace=target.oid
  UNION ALL
  SELECT 'column',relation.oid::regclass::text||'.'||attribute.attname,
    pg_catalog.pg_get_userbyid(relation.relowner),attribute.attacl
  FROM pg_catalog.pg_attribute attribute
  JOIN pg_catalog.pg_class relation ON relation.oid=attribute.attrelid
  CROSS JOIN target
  WHERE relation.relnamespace=target.oid AND attribute.attnum>0
    AND NOT attribute.attisdropped
  UNION ALL
  SELECT 'type',type_record.oid::regtype::text,
    pg_catalog.pg_get_userbyid(type_record.typowner),type_record.typacl
  FROM pg_catalog.pg_type type_record CROSS JOIN target
  WHERE type_record.typnamespace=target.oid
  UNION ALL
  SELECT 'default_acl',default_acl.defaclobjtype::text,
    pg_catalog.pg_get_userbyid(default_acl.defaclrole),default_acl.defaclacl
  FROM pg_catalog.pg_default_acl default_acl CROSS JOIN target
  WHERE default_acl.defaclnamespace IN (0,target.oid)
)
SELECT jsonb_agg(jsonb_build_object(
  'kind',kind,'identity',identity,'owner',owner,'acl',coalesce(
    (SELECT jsonb_agg(item::text ORDER BY item::text COLLATE "C")
     FROM pg_catalog.unnest(acl) item),'[]'::jsonb))
  ORDER BY kind COLLATE "C",identity COLLATE "C")::text
FROM acl_state;
SQL
docker cp "/tmp/release-authority-final-acl-state-$$.sql" \
  "$name:/tmp/release-authority-final-acl-state.sql" >/dev/null
docker cp "/tmp/release-authority-final-acl-state-$$.sql" \
  "$upgrade_name:/tmp/release-authority-final-acl-state.sql" >/dev/null
fresh_acl_state=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres \
  -d rr_authority_gate -qAtf /tmp/release-authority-final-acl-state.sql)
upgrade_acl_state=$(docker exec "$upgrade_name" psql -v ON_ERROR_STOP=1 -U postgres \
  -d rr_authority_origin_upgrade -qAtf /tmp/release-authority-final-acl-state.sql)
test "$upgrade_acl_state" = "$fresh_acl_state"
terminal_issuer_file="$contract_tmp/terminal-fixture-issuer-url"
terminal_lease_url_file="$contract_tmp/terminal-fixture-lease-url"
terminal_lease_file="$contract_tmp/terminal-fixture-lease.json"
printf '%s' "postgresql://reviewrouter_migration_issuer:issuer@127.0.0.1:$postgres_port/rr_authority_gate?sslmode=disable" \
  > "$terminal_issuer_file"
chmod 600 "$terminal_issuer_file"
REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE="$terminal_issuer_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE="$terminal_lease_url_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_LEASE_FILE="$terminal_lease_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_EXPECTED_SHA="$(printf '9%.0s' {1..40})" \
REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ID=90999 \
REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ATTEMPT=1 \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE=incremental-upgrade \
  node scripts/release-authority-migration-credential.mjs issue
LEASE_FILE="$terminal_lease_file" node -e \
  "import('./scripts/install-release-authority-db.mjs').then(m=>process.stdout.write(m.releaseAuthorityMigrationBundle('incremental-upgrade',process.cwd(),{lease:JSON.parse(require('node:fs').readFileSync(process.env.LEASE_FILE))})))" \
  > "$contract_tmp/terminal-upgrade.sql"
docker cp "$contract_tmp/terminal-upgrade.sql" "$name:/tmp/terminal-upgrade.sql" >/dev/null
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate \
  -f /tmp/terminal-upgrade.sql >"$contract_tmp/terminal-control.out" 2>&1; then
  echo "authority upgrade admitted a non-owner migration caller" >&2
  exit 1
fi
grep -q "permission denied for function consume" "$contract_tmp/terminal-control.out"

# Terminal upgrades are admitted only through a consumed same-transaction
# lease. Direct superuser and application-role attempts both fail closed; the
# lease race and retry contract is exercised below through the real adapter.
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate \
  -f /tmp/terminal-upgrade.sql >"$contract_tmp/terminal-superuser.out" 2>&1; then
  echo "authority upgrade admitted a direct superuser caller" >&2
  exit 1
fi
grep -q "migration credential consume rejected" "$contract_tmp/terminal-superuser.out"
REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE="$terminal_issuer_file" \
  node scripts/release-authority-migration-credential.mjs reconcile
terminal_fixture_role=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1])).loginRole)" \
  "$terminal_lease_file")
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT state||':'||(to_regrole(login_role) IS NULL)::text
   FROM reviewrouter_migration_credential.lease
   WHERE login_role='$terminal_fixture_role'")" = reconciled:true

# The runtime atomic-attestation protocol takes a shared transaction lock on
# the same key as the migration owner. Exercise both the authority-catalog and
# activation-catalog keys through independent sessions (the database-visible
# equivalent of concurrent replicas). A migration that races after evidence
# is read cannot drift the catalog until the protected mutation commits.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "CREATE TABLE public.atomic_attestation_catalog(value text NOT NULL);
   INSERT INTO public.atomic_attestation_catalog VALUES ('canonical');
   CREATE TABLE public.atomic_attestation_events(
     ordinal bigserial PRIMARY KEY, event text NOT NULL
   );" >/dev/null
for atomic_lock_objid in 1381258071 1129271120; do
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
    "TRUNCATE public.atomic_attestation_events;
     UPDATE public.atomic_attestation_catalog SET value='canonical';" >/dev/null
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
    "BEGIN;
     SET LOCAL lock_timeout='500ms';
     SET LOCAL statement_timeout='3000ms';
     SELECT pg_advisory_xact_lock_shared(1381126735,$atomic_lock_objid);
     DO \$attest\$ BEGIN
       IF (SELECT value FROM public.atomic_attestation_catalog) <> 'canonical'
       THEN RAISE EXCEPTION 'stale catalog evidence'; END IF;
     END \$attest\$;
     SELECT pg_sleep(0.5);
     INSERT INTO public.atomic_attestation_events(event) VALUES ('runtime_mutation');
     COMMIT;" >/dev/null &
  atomic_runtime_pid=$!
  for _ in $(seq 1 40); do
    if test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
        "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory'
         AND classid=1381126735 AND objid=$atomic_lock_objid
         AND mode='ShareLock' AND granted)")" = t; then
      break
    fi
    sleep 0.05
  done
  test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
    "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory'
     AND classid=1381126735 AND objid=$atomic_lock_objid
     AND mode='ShareLock' AND granted)")" = t
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
    "BEGIN;
     SET LOCAL lock_timeout='2000ms';
     SET LOCAL statement_timeout='3000ms';
     SELECT pg_advisory_xact_lock(1381126735,$atomic_lock_objid);
     UPDATE public.atomic_attestation_catalog SET value='drifted';
     INSERT INTO public.atomic_attestation_events(event) VALUES ('migration_drift');
     COMMIT;" >/dev/null &
  atomic_migration_pid=$!
  wait "$atomic_runtime_pid"
  wait "$atomic_migration_pid"
  test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
    "SELECT string_agg(event,',' ORDER BY ordinal) FROM public.atomic_attestation_events")" = \
    runtime_mutation,migration_drift

  # Runtime lock acquisition is bounded and fail-closed while a migration owns
  # the exclusive side of the protocol; its mutation statement never executes.
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
    "BEGIN; SELECT pg_advisory_xact_lock(1381126735,$atomic_lock_objid);
     SELECT pg_sleep(1); COMMIT;" >/dev/null &
  atomic_exclusive_pid=$!
  for _ in $(seq 1 40); do
    if test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
        "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory'
         AND classid=1381126735 AND objid=$atomic_lock_objid
         AND mode='ExclusiveLock' AND granted)")" = t; then
      break
    fi
    sleep 0.05
  done
  test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
    "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory'
     AND classid=1381126735 AND objid=$atomic_lock_objid
     AND mode='ExclusiveLock' AND granted)")" = t
  if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
    "BEGIN; SET LOCAL lock_timeout='100ms'; SET LOCAL statement_timeout='500ms';
     SELECT pg_advisory_xact_lock_shared(1381126735,$atomic_lock_objid);
     INSERT INTO public.atomic_attestation_events(event) VALUES ('forbidden_mutation');
     COMMIT;" >/dev/null 2>&1; then
    echo "runtime atomic attestation ignored its bounded migration lock" >&2
    exit 1
  fi
  wait "$atomic_exclusive_pid"
  test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
    "SELECT count(*) FROM public.atomic_attestation_events WHERE event='forbidden_mutation'")" = 0
done

# A mutation failure rolls back the callback write and releases its shared
# transaction lock; no partially authorized event survives.
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "BEGIN; SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='1000ms';
   SELECT pg_advisory_xact_lock_shared(1381126735,1381258071);
   INSERT INTO public.atomic_attestation_events(event) VALUES ('rolled_back_mutation');
   DO \$rollback\$ BEGIN RAISE EXCEPTION 'force atomic rollback'; END \$rollback\$;
   COMMIT;" >/dev/null 2>&1; then
  echo "failed atomic mutation unexpectedly committed" >&2
  exit 1
fi
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT count(*) FROM public.atomic_attestation_events WHERE event='rolled_back_mutation'")" = 0
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "DROP TABLE public.atomic_attestation_events, public.atomic_attestation_catalog" >/dev/null

# Schema-scoped defaults are equally noncanonical on upgrade and the failed
# transaction must leave the installed authority unchanged.
for default_case in \
  'TABLES|SELECT' 'SEQUENCES|USAGE' 'FUNCTIONS|EXECUTE' 'TYPES|USAGE'; do
  IFS='|' read -r objects privilege <<<"$default_case"
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
    "SET ROLE reviewrouter_authority_owner; ALTER DEFAULT PRIVILEGES IN SCHEMA release_authority GRANT $privilege ON $objects TO \"reviewrouter quoted acl probe\"" >/dev/null
  if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate \
    -f /tmp/release-authority-install.sql >/dev/null 2>&1; then
    echo "authority upgrade accepted malicious schema $objects defaults" >&2
    exit 1
  fi
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
    "SET ROLE reviewrouter_authority_owner; ALTER DEFAULT PRIVILEGES IN SCHEMA release_authority REVOKE $privilege ON $objects FROM \"reviewrouter quoted acl probe\"" >/dev/null
done

# A conflicting table lock is bounded by lock_timeout rather than waiting for
# the process timeout. No migration history changes on the failed attempt.
gate_manifest=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_schema_migration_manifest()")
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "BEGIN; LOCK TABLE release_authority.schema_migration IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(2); COMMIT" >/dev/null &
table_lock_pid=$!
for _ in $(seq 1 40); do
  if test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
      "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE relation='release_authority.schema_migration'::regclass AND mode='AccessExclusiveLock' AND granted)")" = t; then
    break
  fi
  sleep 0.05
done
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate \
  -f /tmp/short-upgrade.sql >/dev/null 2>&1; then
  echo "authority upgrade ignored its bounded lock timeout" >&2
  exit 1
fi
wait "$table_lock_pid"
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_schema_migration_manifest()")" = "$gate_manifest"

# Checksum drift fails before any forward work. Restoring the fixture permits
# two byte-identical idempotent reruns with unchanged catalog evidence.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "UPDATE release_authority.schema_migration SET checksum_sha256='sha256:'||repeat('0',64) WHERE position=11" >/dev/null
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate \
  -f /tmp/release-authority-install.sql >/dev/null 2>&1; then
  echo "authority upgrade accepted checksum drift" >&2
  exit 1
fi
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "UPDATE release_authority.schema_migration SET checksum_sha256='sha256:a7f1f5063b83f53dfd95dda6bf70740fd2e586dbed368903d7098190cf6200fd' WHERE position=11" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "UPDATE release_authority.schema_migration SET checksum_sha256='sha256:'||repeat('0',64) WHERE position=12" >/dev/null
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate \
  -f /tmp/release-authority-install.sql >/dev/null 2>&1; then
  echo "authority upgrade accepted ACL exactness checksum drift" >&2
  exit 1
fi
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "UPDATE release_authority.schema_migration SET checksum_sha256='sha256:727a6615bb6c1af3aee4e69ed33648726b581adb4f4b2f7610be9f5518347420' WHERE position=12" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "UPDATE release_authority.schema_migration SET checksum_sha256='sha256:'||repeat('0',64) WHERE position=13" >/dev/null
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate \
  -f /tmp/release-authority-install.sql >/dev/null 2>&1; then
  echo "authority upgrade accepted provider fence checksum drift" >&2
  exit 1
fi
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "UPDATE release_authority.schema_migration SET checksum_sha256='sha256:095ce8c8859c8ddf51a526aeee2673f1f84853f2c479cef7cb92871ef749554a' WHERE position=13" >/dev/null
first_gate_attestation=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_schema_migration_manifest()::text||':'||obj_description('release_authority'::regnamespace,'pg_namespace')")
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_schema_migration_manifest()::text||':'||obj_description('release_authority'::regnamespace,'pg_namespace')")" = "$first_gate_attestation"

# Exercise the canonical ACL serializer directly on PostgreSQL 17. Multiple
# rows must sort independently of input order, PUBLIC must remain explicit,
# default ACLs must be expanded, and null/zero-dimensional ACLs must be empty.
node -e 'import("./scripts/install-release-authority-db.mjs").then(m => process.stdout.write(m.releaseAuthorityAclFingerprintSql + String.raw`
WITH forward(value) AS (SELECT pg_temp.release_authority_acl_fingerprint(ARRAY[
  '\''postgres=arwdDxt/postgres'\''::aclitem,
  '\''=r/postgres'\''::aclitem,
  '\''reviewrouter_release_control=r*/postgres'\''::aclitem
])), reverse_order(value) AS (SELECT pg_temp.release_authority_acl_fingerprint(ARRAY[
  '\''reviewrouter_release_control=r*/postgres'\''::aclitem,
  '\''=r/postgres'\''::aclitem,
  '\''postgres=arwdDxt/postgres'\''::aclitem
]))
SELECT jsonb_array_length(forward.value)=9
  AND forward.value=reverse_order.value
  AND forward.value @> '\''[{"grantor":"postgres","grantee":"PUBLIC","privilege_type":"SELECT","is_grantable":false}]'\''::jsonb
  AND forward.value @> '\''[{"grantor":"postgres","grantee":"reviewrouter_release_control","privilege_type":"SELECT","is_grantable":true}]'\''::jsonb
FROM forward,reverse_order;
SELECT pg_temp.release_authority_acl_fingerprint(NULL::aclitem[])='\''[]'\''::jsonb
  AND pg_temp.release_authority_acl_fingerprint('\''{}'\''::aclitem[])='\''[]'\''::jsonb;
SELECT pg_temp.release_authority_acl_fingerprint(
  pg_catalog.acldefault('\''f'\'',(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='\''postgres'\'')))
  @> '\''[{"grantor":"postgres","grantee":"PUBLIC","privilege_type":"EXECUTE","is_grantable":false}]'\''::jsonb;
`))' > /tmp/release-authority-acl-regression-$$.sql
docker cp "/tmp/release-authority-acl-regression-$$.sql" \
  "$name:/tmp/release-authority-acl-regression.sql" >/dev/null
acl_regression=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -qAt \
  -f /tmp/release-authority-acl-regression.sql)
if test "$acl_regression" != $'t\nt\nt'; then
  printf 'authority ACL serializer regression mismatch: expected %q, got %q\n' \
    $'t\nt\nt' "$acl_regression" >&2
  exit 1
fi

for database in rr_modified_schema rr_modified_routine rr_disabled_trigger rr_owner_mismatch rr_acl_mismatch; do
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
    "CREATE DATABASE $database TEMPLATE postgres" >/dev/null
done
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_modified_schema -c \
  "ALTER TABLE release_authority.runner_intent
     ADD COLUMN unaudited_catalog_change boolean" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_modified_routine -c \
  "CREATE OR REPLACE FUNCTION release_authority.release_runner_terminal_effect()
   RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS \$\$
   BEGIN RETURN NEW; END \$\$" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_disabled_trigger -c \
  "ALTER TABLE release_authority.runner_job
     DISABLE TRIGGER release_runner_terminal_effect_trigger" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_owner_mismatch -c \
  "ALTER SCHEMA release_authority OWNER TO reviewrouter_release_control" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_acl_mismatch -c \
  "GRANT SELECT ON TABLE release_authority.runner_intent TO PUBLIC" >/dev/null
for database in rr_modified_schema rr_modified_routine rr_disabled_trigger rr_owner_mismatch rr_acl_mismatch; do
  if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" \
    -f /tmp/release-authority-install.sql >/dev/null 2>&1; then
    echo "modified authority catalog $database was stamped" >&2
    exit 1
  fi
  test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -Atc \
    "SELECT to_regclass('release_authority.schema_migration') IS NULL")" = t
done

for database in rr_mixed_legacy_current rr_mixed_current_legacy rr_mixed_erased_evidence rr_supported_legacy rr_partial_catalog; do
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
    "CREATE DATABASE $database" >/dev/null
done
docker cp "$root/packages/platform/release-authority-db/legacy-catalog/000001_release_authority/migration.sql" \
  "$name:/tmp/legacy-000001.sql" >/dev/null
docker cp "$root/packages/platform/release-authority-db/legacy-catalog/000002_external_effect_protocol/migration.sql" \
  "$name:/tmp/legacy-000002.sql" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_mixed_legacy_current \
  -f /tmp/legacy-000001.sql >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_mixed_legacy_current \
  -f /tmp/migration-000002.sql >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_mixed_current_legacy \
  -f /tmp/migration.sql >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_mixed_current_legacy \
  -f /tmp/legacy-000002.sql >/dev/null
for database in rr_mixed_legacy_current rr_mixed_current_legacy; do
  if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" \
    -f /tmp/release-authority-install.sql >/dev/null 2>&1; then
    echo "ambiguous mixed authority catalog $database was stamped" >&2
    exit 1
  fi
  test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -Atc \
    "SELECT to_regclass('release_authority.schema_migration') IS NULL")" = t
done

# Preserve the original adversarial reproduction. Migration 000003 overwrites
# the only remaining 000001 catalog difference, so a verifier that compares
# only the eventual through-000008 catalog will stamp this mixed history.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_mixed_erased_evidence \
  -f /tmp/legacy-000001.sql >/dev/null
for migration_file in \
  /tmp/migration-000002.sql \
  /tmp/service-transition.sql \
  /tmp/migration-000003.sql \
  /tmp/migration-000004.sql \
  /tmp/migration-000005.sql \
  /tmp/migration-000006.sql \
  /tmp/migration-000007.sql \
  /tmp/migration-000008.sql; do
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_mixed_erased_evidence \
    -f "$migration_file" >/dev/null
done
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_mixed_erased_evidence \
  -f /tmp/release-authority-install.sql >/dev/null 2>&1; then
  echo "ambiguous mixed legacy authority catalog was stamped canonical" >&2
  exit 1
fi
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_mixed_erased_evidence -Atc \
  "SELECT to_regclass('release_authority.schema_migration') IS NULL")" = t

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_partial_catalog \
  -f /tmp/migration.sql >/dev/null
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_partial_catalog \
  -f /tmp/release-authority-install.sql >/dev/null 2>&1; then
  echo "partial authority catalog was stamped" >&2
  exit 1
fi
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_partial_catalog -Atc \
  "SELECT to_regclass('release_authority.schema_migration') IS NULL")" = t

docker run -d --rm --name "$legacy_name" -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=test "$pg17_image" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$legacy_name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
legacy_postgres_port=$(docker port "$legacy_name" 5432/tcp | sed 's/.*://')
docker exec "$legacy_name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "CREATE ROLE reviewrouter_release_control LOGIN PASSWORD 'control';
   CREATE ROLE reviewrouter_provider_authority LOGIN PASSWORD 'provider';
   CREATE ROLE reviewrouter_release_witness LOGIN PASSWORD 'witness';
   CREATE ROLE reviewrouter_migration_issuer LOGIN PASSWORD 'issuer';
   CREATE ROLE reviewrouter_bootstrap_administrator LOGIN PASSWORD 'bootstrap-admin'
     NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1;
   GRANT pg_signal_backend TO reviewrouter_bootstrap_administrator" >/dev/null
docker exec -e PGPASSWORD=bootstrap-admin "$legacy_name" psql -h 127.0.0.1 \
  -v ON_ERROR_STOP=1 -U reviewrouter_bootstrap_administrator -d postgres -c \
  "SET createrole_self_grant=''; CREATE ROLE rr_legacy_bootstrap LOGIN
    PASSWORD 'legacy-bootstrap' NOSUPERUSER NOCREATEDB CREATEROLE
    NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1" >/dev/null
docker exec "$legacy_name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "CREATE DATABASE rr_supported_legacy OWNER rr_legacy_bootstrap" >/dev/null
for legacy_input in legacy-000001 legacy-000002 release-authority-install; do
  docker cp "$name:/tmp/$legacy_input.sql" "$contract_tmp/$legacy_input.sql"
  docker cp "$contract_tmp/$legacy_input.sql" "$legacy_name:/tmp/$legacy_input.sql" >/dev/null
done
probe_provider_root "$legacy_name" rr_supported_legacy \
  "$contract_tmp/legacy-provider-root.json"
render_bootstrap_sql prepare rr_legacy_bootstrap legacy-bootstrap \
  "$contract_tmp/legacy-provider-root.json" "$contract_tmp/legacy-prepare.sql"
render_bootstrap_sql provision rr_legacy_bootstrap legacy-bootstrap \
  "$contract_tmp/legacy-provider-root.json" "$contract_tmp/legacy-provision.sql"
node -e "import('./scripts/install-release-authority-db.mjs').then(m => process.stdout.write(m.releaseAuthorityBootstrapRelinquishSql('rr_legacy_bootstrap')))" \
  > "$contract_tmp/legacy-relinquish.sql"
for legacy_bootstrap_file in prepare provision relinquish; do
  docker cp "$contract_tmp/legacy-$legacy_bootstrap_file.sql" \
    "$legacy_name:/tmp/legacy-$legacy_bootstrap_file.sql" >/dev/null
done
docker exec "$legacy_name" psql -v ON_ERROR_STOP=1 -U rr_legacy_bootstrap \
  -d rr_supported_legacy -f /tmp/legacy-prepare.sql >/dev/null
docker exec "$legacy_name" psql -v ON_ERROR_STOP=1 -U reviewrouter_bootstrap_administrator \
  -d rr_supported_legacy -f /tmp/legacy-provision.sql >/dev/null
docker exec "$legacy_name" psql -v ON_ERROR_STOP=1 -U rr_legacy_bootstrap \
  -d rr_supported_legacy -f /tmp/legacy-relinquish.sql >/dev/null
docker exec "$legacy_name" psql -v ON_ERROR_STOP=1 -U rr_legacy_bootstrap \
  -d rr_supported_legacy -f /tmp/legacy-000001.sql >/dev/null
docker exec "$legacy_name" psql -v ON_ERROR_STOP=1 -U rr_legacy_bootstrap \
  -d rr_supported_legacy -f /tmp/legacy-000002.sql >/dev/null
docker exec "$legacy_name" psql -v ON_ERROR_STOP=1 -U rr_legacy_bootstrap \
  -d rr_supported_legacy -f /tmp/release-authority-install.sql >/dev/null
node -e "const fs=require('node:fs');import('./scripts/install-release-authority-db.mjs').then(m=>process.stdout.write(m.releaseAuthorityBootstrapCleanupSql('rr_legacy_bootstrap',JSON.parse(fs.readFileSync(process.argv[1],'utf8')))))" \
  "$contract_tmp/legacy-provider-root.json" > "$contract_tmp/legacy-cleanup.sql"
docker cp "$contract_tmp/legacy-cleanup.sql" \
  "$legacy_name:/tmp/legacy-cleanup.sql" >/dev/null
docker exec "$legacy_name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_bootstrap_administrator -d rr_supported_legacy \
  -f /tmp/legacy-cleanup.sql >/dev/null
test "$(docker exec "$legacy_name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_supported_legacy -Atc \
  "SELECT string_agg(position::text||':'||byte_variant,',' ORDER BY position)
     FROM release_authority.schema_migration WHERE position<=2")" = \
  "1:legacy_equivalent,2:legacy_equivalent"

rm -f "/tmp/release-authority-install-$$.sql" \
  "/tmp/release-authority-acl-regression-$$.sql" \
  "/tmp/release-authority-final-acl-state-$$.sql"
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT string_agg(position::text||':'||byte_variant,',' ORDER BY position)
     FROM release_authority.schema_migration WHERE position<=2")" = \
  "1:canonical,2:canonical"
# Capture both accepted manifests. Terminal idempotence is exercised through a
# newly issued migration lease below, never through a privileged bypass.
canonical_manifest=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_schema_migration_manifest()")
legacy_manifest=$(docker exec "$legacy_name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_supported_legacy -Atc \
  "SELECT release_authority.release_schema_migration_manifest()")
test -n "$canonical_manifest"
test -n "$legacy_manifest"

# Exercise the production credential adapter against PostgreSQL 17. The
# issuer never receives owner membership; the generated login becomes NOLOGIN
# during consume and loses its temporary owner edge before commit.
issuer_file="$contract_tmp/migration-issuer-url"
lease_url_file="$contract_tmp/migration-lease-url"
lease_file="$contract_tmp/migration-lease.json"
printf '%s' "postgresql://reviewrouter_migration_issuer:issuer@127.0.0.1:$postgres_port/rr_authority_gate?sslmode=disable" > "$issuer_file"
chmod 600 "$issuer_file"
REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE="$issuer_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE="$lease_url_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_LEASE_FILE="$lease_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_EXPECTED_SHA="$(printf 'a%.0s' {1..40})" \
REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ID=91001 \
REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ATTEMPT=1 \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE=incremental-upgrade \
  node scripts/release-authority-migration-credential.mjs issue
# Consume in an explicit transaction, attest that this is the only backend for
# the session role and that all timeout settings are bounded by absolute lease
# expiry, then terminate that exact backend. PostgreSQL must roll back NOLOGIN,
# the owner edge, and the consumed state together.
DATABASE_URL=$(cat "$lease_url_file") LEASE_JSON=$(cat "$lease_file") \
  BACKEND_EVIDENCE="$contract_tmp/lease-backend.json" node -e \
  "import('node:fs').then(async fs=>{const {default:pg}=await import('pg');const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('BEGIN');await c.query('SELECT reviewrouter_migration_credential.consume(\$1::jsonb)',[process.env.LEASE_JSON]);const q=await c.query(\"SELECT pg_backend_pid() pid,(SELECT count(*) FROM pg_stat_activity WHERE usename=session_user) sessions,(SELECT NOT rolcanlogin FROM pg_roles WHERE rolname=session_user) no_login,(SELECT setting::bigint FROM pg_settings WHERE name='transaction_timeout') transaction_timeout,(SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout') statement_timeout,(SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout') idle_timeout\");fs.writeFileSync(process.env.BACKEND_EVIDENCE,JSON.stringify(q.rows[0]),{mode:0o600});await c.query('SELECT pg_sleep(30)')})" \
  >"$contract_tmp/lease-backend.out" 2>&1 &
lease_backend_process=$!
for _ in $(seq 1 80); do
  test -s "$contract_tmp/lease-backend.json" && break
  sleep 0.05
done
test -s "$contract_tmp/lease-backend.json"
test "$(node -e "const x=require(process.argv[1]);process.stdout.write(x.sessions+':'+x.no_login+':'+([x.transaction_timeout,x.statement_timeout,x.idle_timeout].every(v=>Number(v)>0&&Number(v)<=600000)))" "$contract_tmp/lease-backend.json")" = \
  1:true:true
lease_backend=$(node -e "process.stdout.write(String(require(process.argv[1]).pid))" \
  "$contract_tmp/lease-backend.json")
if ! docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
    "SELECT pg_terminate_backend($lease_backend,5000)" | grep -qx t; then
  echo "failed to terminate the consumed migration backend" >&2
  exit 1
fi
if wait "$lease_backend_process"; then
  echo "terminated migration backend unexpectedly committed" >&2
  exit 1
fi
lease_login=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1])).loginRole)" "$lease_file")
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT lease.state||':'||role.rolcanlogin::text||':'||
     EXISTS(SELECT 1 FROM pg_auth_members WHERE member=role.oid
       AND roleid='reviewrouter_authority_owner'::regrole)::text
   FROM reviewrouter_migration_credential.lease lease JOIN pg_roles role
     ON role.rolname=lease.login_role WHERE lease.login_role='$lease_login'")" = \
  issued:true:false
if DATABASE_URL=$(cat "$lease_url_file") LEASE_JSON=$(cat "$lease_file") node -e \
  "import('pg').then(async ({default:pg})=>{const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('SELECT reviewrouter_migration_credential.consume(\$1::jsonb)',[process.env.LEASE_JSON]);await c.end()})" \
  >/dev/null 2>&1; then
  echo "credential consume committed without same-transaction finalize" >&2
  exit 1
fi
# Expiry is checked against the database clock even when the signed receipt
# still claims its original later instant.
expiry_binding=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -qAtc \
  "UPDATE reviewrouter_migration_credential.lease
   SET issued_at=clock_timestamp()-interval '11 minutes',
       expires_at=clock_timestamp()-interval '1 minute'
   WHERE workflow_run_id='91001';
   UPDATE reviewrouter_migration_credential.lease lease
   SET receipt_sha256=reviewrouter_migration_credential.canonical_receipt(lease)
   WHERE workflow_run_id='91001';
   SELECT receipt_sha256||'|'||to_char(expires_at AT TIME ZONE 'UTC',
     'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
   FROM reviewrouter_migration_credential.lease WHERE workflow_run_id='91001'")
IFS='|' read -r expired_receipt expired_at <<<"$expiry_binding"
LEASE_FILE="$lease_file" EXPIRED_RECEIPT="$expired_receipt" EXPIRED_AT="$expired_at" \
  node -e "const fs=require('node:fs');const lease=JSON.parse(fs.readFileSync(process.env.LEASE_FILE));lease.receiptSha256=process.env.EXPIRED_RECEIPT;lease.expiresAt=process.env.EXPIRED_AT;fs.writeFileSync(process.env.LEASE_FILE,JSON.stringify(lease),{mode:0o600})"
if DATABASE_URL=$(cat "$lease_url_file") LEASE_JSON=$(cat "$lease_file") node -e \
  "import('pg').then(async ({default:pg})=>{const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('BEGIN');await c.query('SELECT reviewrouter_migration_credential.consume(\$1::jsonb)',[process.env.LEASE_JSON]);await c.query('ROLLBACK');await c.end()})" \
  >/dev/null 2>&1; then
  echo "expired migration credential was consumed" >&2
  exit 1
fi
if ! REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE="$issuer_file" \
  REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE="$contract_tmp/parallel-url" \
  REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_LEASE_FILE="$contract_tmp/parallel-lease" \
  REVIEW_ROUTER_RELEASE_AUTHORITY_EXPECTED_SHA="$(printf 'b%.0s' {1..40})" \
  REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ID=91002 \
  REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ATTEMPT=1 \
  REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE=incremental-upgrade \
    node scripts/release-authority-migration-credential.mjs issue >/dev/null 2>&1; then
  echo "credential broker failed to reconcile an unfinished lease" >&2
  exit 1
fi
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT state FROM reviewrouter_migration_credential.lease
   WHERE workflow_run_id='91001'")" = reconciled
lease_url_file="$contract_tmp/parallel-url"
lease_file="$contract_tmp/parallel-lease"
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE="$lease_url_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_LEASE_FILE="$lease_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE=incremental-upgrade \
  node scripts/install-release-authority-db.mjs --incremental-upgrade
lease_role=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1])).loginRole)" "$lease_file")
lease_state=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT state||':'||(consumed_at IS NOT NULL)::text||':'||(finalized_at IS NOT NULL)::text
     FROM reviewrouter_migration_credential.lease WHERE login_role='$lease_role'")
test "$lease_state" = finalized:true:true
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -Atc \
  "SELECT rolcanlogin::text||':'||EXISTS(SELECT 1 FROM pg_auth_members
     WHERE member='$lease_role'::regrole AND roleid='reviewrouter_authority_owner'::regrole)::text
   FROM pg_roles WHERE rolname='$lease_role'")" = false:false
if DATABASE_URL=$(cat "$lease_url_file") node -e \
  "import('pg').then(async ({default:pg})=>{const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect()})" \
  >/dev/null 2>&1; then
  echo "consumed migration credential authenticated a second connection" >&2
  exit 1
fi
REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE="$issuer_file" \
  node scripts/release-authority-migration-credential.mjs reconcile
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT state||':'||(to_regrole(login_role) IS NULL)::text
   FROM reviewrouter_migration_credential.lease
   WHERE workflow_run_id='91002'")" = finalized:true

# Model a lost success response by discarding the prior command result, issuing
# a fresh lease, and replaying the already-terminal upgrade. The new lease is
# independently consumed and finalized without changing the manifest.
retry_url_file="$contract_tmp/lost-response-url"
retry_lease_file="$contract_tmp/lost-response-lease.json"
REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE="$issuer_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE="$retry_url_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_LEASE_FILE="$retry_lease_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_EXPECTED_SHA="$(printf 'c%.0s' {1..40})" \
REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ID=91003 \
REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ATTEMPT=2 \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE=incremental-upgrade \
  node scripts/release-authority-migration-credential.mjs issue
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE="$retry_url_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_LEASE_FILE="$retry_lease_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE=incremental-upgrade \
  node scripts/install-release-authority-db.mjs --incremental-upgrade
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT state FROM reviewrouter_migration_credential.lease
   WHERE workflow_run_id='91003'")" = finalized
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_schema_migration_manifest()")" = "$canonical_manifest"

# Reconciliation must durably terminalize an authenticated PG17 backend
# without making physical DROP ROLE a prerequisite for the commit. A later
# issuance remains available; once that backend disconnects, reconciliation
# deletes both inert terminal roles explicitly.
connected_url_file="$contract_tmp/connected-url"
connected_lease_file="$contract_tmp/connected-lease.json"
REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE="$issuer_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE="$connected_url_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_LEASE_FILE="$connected_lease_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_EXPECTED_SHA="$(printf '6%.0s' {1..40})" \
REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ID=91006 \
REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ATTEMPT=1 \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE=incremental-upgrade \
  node scripts/release-authority-migration-credential.mjs issue
CONNECTED_URL="$(cat "$connected_url_file")" \
CONNECTED_READY="$contract_tmp/connected-ready" \
CONNECTED_RELEASE="$contract_tmp/connected-release" node -e \
  "import('node:fs').then(async fs=>{const {default:pg}=await import('pg');const c=new pg.Client({connectionString:process.env.CONNECTED_URL});await c.connect();fs.writeFileSync(process.env.CONNECTED_READY,'ready');while(!fs.existsSync(process.env.CONNECTED_RELEASE))await new Promise(r=>setTimeout(r,25));await c.end()})" \
  >"$contract_tmp/connected-backend.out" 2>&1 &
connected_backend_process=$!
for _ in $(seq 1 80); do
  test -s "$contract_tmp/connected-ready" && break
  sleep 0.05
done
test -s "$contract_tmp/connected-ready"
connected_role=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1])).loginRole)" \
  "$connected_lease_file")
REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE="$issuer_file" \
  node scripts/release-authority-migration-credential.mjs reconcile
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT lease.state||':'||role.rolcanlogin::text||':'||
     pg_catalog.has_schema_privilege(role.oid,'reviewrouter_migration_credential','USAGE')::text||':'||
     pg_catalog.has_function_privilege(role.oid,
       'reviewrouter_migration_credential.consume(jsonb)','EXECUTE')::text||':'||
     EXISTS(SELECT 1 FROM pg_auth_members WHERE member=role.oid
       AND roleid='reviewrouter_authority_owner'::regrole)::text
   FROM reviewrouter_migration_credential.lease lease JOIN pg_roles role
     ON role.rolname=lease.login_role WHERE lease.login_role='$connected_role'")" = \
  reconciled:false:false:false:false
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT reviewrouter_migration_credential.login_role_is_inert('$connected_role')")" = t
CONNECTED_CONTROL_URL="postgresql://reviewrouter_release_control:control@127.0.0.1:$postgres_port/rr_authority_gate" \
  node --import tsx -e '
    Promise.all([
      import("./packages/platform/db/src/index.ts"),
      import("./apps/api/src/release-authority/adapters/postgres-readiness.ts"),
    ]).then(async ([database, readiness]) => {
      const client = database.createPrismaClient({
        databaseUrl: process.env.CONNECTED_CONTROL_URL,
      });
      try {
        const observed = await readiness.observeReleaseAuthorityDatabaseReadiness(client);
        if (!observed.catalogExact || !observed.finalAclExact || observed.schemaVersion !== 16)
          throw new Error("connected terminal role made readiness noncanonical");
      } finally {
        await client.$disconnect();
      }
    });
  '
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "GRANT USAGE ON SCHEMA reviewrouter_migration_credential TO $connected_role" >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT reviewrouter_migration_credential.login_role_is_inert('$connected_role')")" = f
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "REVOKE USAGE ON SCHEMA reviewrouter_migration_credential FROM $connected_role" >/dev/null

successor_url_file="$contract_tmp/connected-successor-url"
successor_lease_file="$contract_tmp/connected-successor-lease.json"
REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE="$issuer_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE="$successor_url_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_LEASE_FILE="$successor_lease_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_EXPECTED_SHA="$(printf '7%.0s' {1..40})" \
REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ID=91007 \
REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ATTEMPT=1 \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE=incremental-upgrade \
  node scripts/release-authority-migration-credential.mjs issue
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT to_regrole('$connected_role') IS NOT NULL")" = t
touch "$contract_tmp/connected-release"
wait "$connected_backend_process"
REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE="$issuer_file" \
  node scripts/release-authority-migration-credential.mjs reconcile
successor_role=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1])).loginRole)" \
  "$successor_lease_file")
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT (to_regrole('$connected_role') IS NULL)::text||':'||
     (to_regrole('$successor_role') IS NULL)::text")" = true:true

# A failure after consume is transaction-atomic. Reconciliation then removes
# the still-issued login even when the caller cannot know whether COMMIT ran.
failure_url_file="$contract_tmp/failure-url"
failure_lease_file="$contract_tmp/failure-lease.json"
REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE="$issuer_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE="$failure_url_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_LEASE_FILE="$failure_lease_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_EXPECTED_SHA="$(printf 'd%.0s' {1..40})" \
REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ID=91004 \
REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ATTEMPT=1 \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE=incremental-upgrade \
  node scripts/release-authority-migration-credential.mjs issue
LEASE_FILE="$failure_lease_file" node -e \
  "import('./scripts/install-release-authority-db.mjs').then(m=>{const lease=JSON.parse(require('node:fs').readFileSync(process.env.LEASE_FILE));process.stdout.write(m.releaseAuthorityMigrationBundle('incremental-upgrade',process.cwd(),{lease}).replace(/\nCOMMIT;\n$/u,'\nSELECT definitely_missing_lease_failure();\nCOMMIT;\n'))})" \
  >"$contract_tmp/failing-lease.sql"
docker cp "$contract_tmp/failing-lease.sql" "$name:/tmp/failing-lease.sql" >/dev/null
if PGPASSWORD=$(node -e "process.stdout.write(new URL(require('fs').readFileSync(process.argv[1],'utf8')).password)" "$failure_url_file") \
  psql "$(cat "$failure_url_file")" -v ON_ERROR_STOP=1 \
    -f "$contract_tmp/failing-lease.sql" >/dev/null 2>&1; then
  echo "failed same-transaction lease migration unexpectedly committed" >&2
  exit 1
fi
failure_role=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1])).loginRole)" "$failure_lease_file")
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT lease.state||':'||role.rolcanlogin::text||':'||
     EXISTS(SELECT 1 FROM pg_auth_members WHERE member=role.oid
       AND roleid='reviewrouter_authority_owner'::regrole)::text
   FROM reviewrouter_migration_credential.lease lease JOIN pg_roles role
     ON role.rolname=lease.login_role WHERE lease.login_role='$failure_role'")" = \
  issued:true:false
REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE="$issuer_file" \
  node scripts/release-authority-migration-credential.mjs reconcile
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT lease.state||':'||(to_regrole(lease.login_role) IS NULL)::text
   FROM reviewrouter_migration_credential.lease lease
   WHERE lease.login_role='$failure_role'")" = reconciled:true

# Issue/reconcile races serialize on the broker advisory lock. A final
# reconciliation converges either ordering and leaves no usable unfinished
# credential or owner membership.
race_url_file="$contract_tmp/race-url"
race_lease_file="$contract_tmp/race-lease.json"
REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE="$issuer_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE="$race_url_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_LEASE_FILE="$race_lease_file" \
REVIEW_ROUTER_RELEASE_AUTHORITY_EXPECTED_SHA="$(printf 'e%.0s' {1..40})" \
REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ID=91005 \
REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ATTEMPT=1 \
REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE=incremental-upgrade \
  node scripts/release-authority-migration-credential.mjs issue &
race_issue_pid=$!
REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE="$issuer_file" \
  node scripts/release-authority-migration-credential.mjs reconcile &
race_reconcile_pid=$!
wait "$race_issue_pid" "$race_reconcile_pid"
REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE="$issuer_file" \
  node scripts/release-authority-migration-credential.mjs reconcile
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT count(*) FROM reviewrouter_migration_credential.lease
   WHERE state IN ('issued','consumed')")" = 0
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT count(*) FROM pg_auth_members membership
   JOIN pg_roles granted ON granted.oid=membership.roleid
   JOIN pg_roles member ON member.oid=membership.member
   WHERE (member.rolname LIKE 'rr_migration_%'
       AND granted.rolname='reviewrouter_authority_owner')
      OR (granted.rolname LIKE 'rr_migration_%'
       AND member.rolname='reviewrouter_migration_broker')")" = 0

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "CREATE DATABASE rr_mixed_ledger TEMPLATE rr_authority_gate" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_mixed_ledger -c \
  "UPDATE release_authority.schema_migration
     SET checksum_sha256='sha256:e88a7cc8f29e91a86434bf14b4051f1fb17b5df02f8fc2dae6ec63d5792b398b',
         byte_variant='legacy_equivalent'
   WHERE position=1" >/dev/null
mixed_ledger_before=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_mixed_ledger -Atc \
  "SELECT release_authority.release_schema_migration_manifest()")
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_mixed_ledger \
  -f /tmp/release-authority-install.sql >/dev/null 2>&1; then
  echo "mixed existing migration ledger was accepted" >&2
  exit 1
fi
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_mixed_ledger -Atc \
  "SELECT release_authority.release_schema_migration_manifest()")" = "$mixed_ledger_before"
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "DROP DATABASE rr_mixed_ledger WITH (FORCE)" >/dev/null

# Build a separate activation target in the same disposable cluster. The
# system identifier is shared only because this contract tests catalog and role
# adversaries; application tests independently prove configured generation
# identity must differ and match its trusted value.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "CREATE ROLE reviewrouter_activation_receipt_guard NOLOGIN;
   CREATE ROLE reviewrouter_activation_permit_installer LOGIN PASSWORD 'installer';
   CREATE ROLE reviewrouter_activation_receipt_reader LOGIN PASSWORD 'reader';
   CREATE ROLE reviewrouter_api LOGIN PASSWORD 'api';
   CREATE ROLE reviewrouter_web LOGIN PASSWORD 'web';
   CREATE ROLE reviewrouter_worker LOGIN PASSWORD 'worker';
   CREATE ROLE reviewrouter_codex_effect_authority LOGIN PASSWORD 'effect';
   CREATE ROLE reviewrouter_release_migration LOGIN PASSWORD 'migration';
   CREATE ROLE reviewrouter_role_bootstrap LOGIN PASSWORD 'bootstrap' NOCREATEDB CREATEROLE;
   GRANT reviewrouter_api TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
   GRANT reviewrouter_web TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
   GRANT reviewrouter_worker TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
   GRANT reviewrouter_codex_effect_authority TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
   GRANT reviewrouter_release_migration TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "CREATE DATABASE rr_activation_target OWNER reviewrouter_role_bootstrap" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "COMMENT ON DATABASE rr_activation_target IS '{\"recoveryWitnessSha256\":\"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\"}'" >/dev/null

# Provision the same pre-release application catalog used by the canonical
# PG16 -> PG17 rehearsal. The shared boundary helper keeps this fixture at the
# exact through-000059 plus retained-000067/000068 boundary; Prisma supplies
# both the real application objects and its canonical migration history.
RR_FIXTURE_SOURCE="$root/packages/platform/db/prisma" \
RR_FIXTURE_TARGET="$contract_tmp/pre-release-prisma" \
RR_FIXTURE_CONFIG="$contract_tmp/pre-release-prisma.config.mjs" \
  node --import tsx -e '
    import { cpSync, readdirSync, rmSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { resolvePreReleaseMigrationExclusions } from "./scripts/rehearse-private-pg17-rollout.mjs";
    const source = process.env.RR_FIXTURE_SOURCE;
    const target = process.env.RR_FIXTURE_TARGET;
    const config = process.env.RR_FIXTURE_CONFIG;
    if (!source || !target || !config) throw new Error("activation fixture path missing");
    cpSync(source, target, { recursive: true });
    const migrations = join(target, "migrations");
    const names = readdirSync(migrations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const name of resolvePreReleaseMigrationExclusions(names))
      rmSync(join(migrations, name), { recursive: true });
    writeFileSync(config, `export default {
      schema: ${JSON.stringify(join(target, "schema.prisma"))},
      migrations: { path: ${JSON.stringify(migrations)} },
      datasource: { url: process.env.REVIEW_ROUTER_ACTIVATION_FIXTURE_DATABASE_URL },
    };\n`);
  '
REVIEW_ROUTER_ACTIVATION_FIXTURE_DATABASE_URL="postgresql://reviewrouter_role_bootstrap:bootstrap@127.0.0.1:$postgres_port/rr_activation_target" \
  pnpm --filter @reviewrouter/platform-db exec prisma migrate deploy \
    --config "$contract_tmp/pre-release-prisma.config.mjs" >/dev/null
node --import tsx -e "import('./scripts/run-codex-rotating-release-migration.mjs').then(m => process.stdout.write(m.activationAuthorityProvisioningSql()))" \
  > "$contract_tmp/activation-authority.sql"
docker cp "$contract_tmp/activation-authority.sql" \
  "$name:/tmp/activation-authority.sql" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_activation_target \
  -f /tmp/activation-authority.sql >/dev/null

# Exercise the same trusted-bootstrap convergence used by production before
# asserting the final activation readiness contract. Provider authority is
# temporary; the provisioning transaction transfers ownership, removes the
# schema-owner handoff, and self-demotes bootstrap before commit.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "ALTER ROLE reviewrouter_role_bootstrap SUPERUSER CREATEROLE" >/dev/null
node --import tsx -e "Promise.all([import('./scripts/run-codex-rotating-release-migration.mjs'),import('./scripts/rehearse-private-pg17-rollout.mjs')]).then(([migration,rehearsal]) => { const configuration={...rehearsal.disposableSqlConfiguration(),releaseUrl:'postgresql://reviewrouter_release_migration:migration@127.0.0.1:5432/rr_activation_target'}; process.stdout.write(migration.roleProvisioningSql(configuration,{ownerAuthorizedInitialRuntimeGateClosed:false})); })" \
  > "$contract_tmp/activation-role-provisioning.sql"
docker cp "$contract_tmp/activation-role-provisioning.sql" \
  "$name:/tmp/activation-role-provisioning.sql" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_role_bootstrap \
  -d rr_activation_target -f /tmp/activation-role-provisioning.sql >/dev/null

# The credential bootstrap deliberately nulls the original authority owner
# password. This disposable cluster reuses postgres for unrelated activation
# adapter fixtures below, so restore only the fixture password over its local
# trusted socket after the revocation assertions have completed.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "ALTER ROLE postgres PASSWORD 'test'" >/dev/null

REVIEW_ROUTER_RELEASE_AUTHORITY_CONTROL_TEST_URL="postgresql://reviewrouter_release_control:control@127.0.0.1:$postgres_port/rr_authority_gate" \
REVIEW_ROUTER_RELEASE_AUTHORITY_WITNESS_TEST_URL="postgresql://reviewrouter_release_witness:witness@127.0.0.1:$postgres_port/rr_authority_gate" \
REVIEW_ROUTER_RELEASE_AUTHORITY_ADMIN_TEST_URL="postgresql://postgres:test@127.0.0.1:$postgres_port/rr_authority_gate" \
REVIEW_ROUTER_RELEASE_AUTHORITY_LEGACY_CONTROL_TEST_URL="postgresql://reviewrouter_release_control:control@127.0.0.1:$legacy_postgres_port/rr_supported_legacy" \
REVIEW_ROUTER_ACTIVATION_TARGET_ADMIN_TEST_URL="postgresql://postgres:test@127.0.0.1:$postgres_port/rr_activation_target" \
REVIEW_ROUTER_ACTIVATION_PERMIT_INSTALLER_TEST_URL="postgresql://reviewrouter_activation_permit_installer:installer@127.0.0.1:$postgres_port/rr_activation_target" \
REVIEW_ROUTER_ACTIVATION_RECEIPT_READER_TEST_URL="postgresql://reviewrouter_activation_receipt_reader:reader@127.0.0.1:$postgres_port/rr_activation_target" \
  pnpm exec vitest --configLoader runner run \
    apps/api/src/release-authority/adapters/postgres.real.test.ts \
    apps/api/src/release-authority/adapters/postgres-readiness.real.test.ts

legacy_effect=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc \
  "SELECT effect_state||':'||effect_safe_for_compensation||':'||effect_block_reason||':'||
    (release_authority.release_runner_effect_snapshot(r)->'reconciliation'->>'result')
   FROM release_authority.runner_intent r WHERE intent_id='rri-'||repeat('9',64)")
test "$legacy_effect" = blocked:false:unresolved_legacy:blocked
legacy_claimed_clean=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc \
  "SELECT effect_state||':'||effect_safe_for_compensation||':'||effect_block_reason
   FROM release_authority.runner_intent WHERE intent_id='rri-'||repeat('8',64)")
test "$legacy_claimed_clean" = blocked:false:unresolved_legacy

first=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_claim('r1', repeat('a',40), '1', 1, '100', '200')")
duplicate=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_claim('r1', repeat('a',40), '1', 1, '100', '200')")
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "DO \$\$
   DECLARE steps text[] := ARRAY[
     'claim_rollout','verify_protected_environment','freeze_provider_services',
     'provision_role_runner','quiesce_source','capture_source_backup',
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
transition_created=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_service_transition_begin('$transition_input')")
test "$transition_created" = created
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_service_transition_contract('missing') IS NULL")" = t
for service in srv-a srv-b srv-c; do
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
    "SELECT release_authority.release_service_transition_append(jsonb_build_object('rolloutId','r1','manifestSha256','$manifest_sha','targetContractSha256','$target_contract_sha','serviceId','$service','step','suspend_intent'))" >/dev/null
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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
    docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
      "SELECT release_authority.release_service_transition_append(jsonb_build_object('rolloutId','r1','manifestSha256','$manifest_sha','targetContractSha256','$target_contract_sha','serviceId','$service','step','$step','deployId',$deploy_id,'observedContractSha256',$observed_contract,'observedEnvSha256',$observed_env))" >/dev/null
  done
done
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_service_transition_complete('{\"rolloutId\":\"r1\",\"outcome\":\"target_staged\"}')" >/dev/null
stage_receipt="sha256:$(printf '%064d' 13)"
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.authorize_activation('r1', repeat('a',40), '1', 1, '100', '200', '10', '$stage_receipt', '[\"dep-srv-a\",\"dep-srv-b\",\"dep-srv-c\"]', 17, 'sha256:'||repeat('7',64))" >/dev/null 2>&1; then
  echo "activation with an unbound cutover workflow job unexpectedly succeeded" >&2
  exit 1
fi
authorization=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.authorize_activation('r1', repeat('a',40), '1', 1, '100', '200', '9', '$stage_receipt', '[\"dep-srv-a\",\"dep-srv-b\",\"dep-srv-c\"]', 17, 'sha256:'||repeat('7',64))")
replay=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.authorize_activation('r1', repeat('a',40), '1', 1, '100', '200', '9', '$stage_receipt', '[\"dep-srv-a\",\"dep-srv-b\",\"dep-srv-c\"]', 17, 'sha256:'||repeat('7',64))")
state=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT state||':'||activation_epoch||':'||source_permanently_ineligible FROM release_authority.rollout WHERE rollout_id='r1'")

test "$first" = claimed
test "$duplicate" = duplicate
test "$authorization" = "$replay"
test "$state" = activation_authorized:1:true

# Adversarial external-effect state machine: the durable permit is the only POST authority.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_claim('r-effect', repeat('e',40), '81', 1, '181', '281')" >/dev/null
effect_intent='{"id":"rri-'$(printf '2%.0s' $(seq 1 64))'","rolloutId":"r-effect","serviceId":"svc-effect","lifecycle":"role","workflowJobId":"811","runnerName":"rr-effect","createdAt":"'$now'","startCommandSha256":"sha256:'$(printf '3%.0s' $(seq 1 64))'","creationLeaseOwner":"rrc-00000000-0000-4000-8000-000000000011"}'
prepared_effect=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_prepare_effect('$effect_intent')->>'state'")
test "$prepared_effect" = prepared
prepared_listing=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
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
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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
  if test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks
      WHERE locktype='advisory' AND objid=810001 AND granted)")" = t; then
    acquire_order_ready=true
    break
  fi
  sleep 0.05
done
test "$acquire_order_ready" = true
permit_a=$(docker exec -e PGPASSWORD=control -e PGOPTIONS='-c lock_timeout=10s' "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (release_authority.release_runner_acquire_dispatch_permit('$permit_input_a')->>'state')||':'||(release_authority.release_runner_acquire_dispatch_permit('$permit_input_a')->>'ownerId')")
wait "$acquire_order_pid"
test "$permit_a" = dispatching:rrc-00000000-0000-4000-8000-000000000011
dispatching_listing=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (intent->>'state')||':'||(listed->>'creationLeaseOwner')||':'||
      ((listed->>'creationLeaseExpiresAt') IS NOT NULL)
   FROM (SELECT release_authority.release_runner_list_intents('r-effect')->0 listed) value,
        LATERAL (SELECT listed->'effect' intent) effect")
test "$dispatching_listing" = dispatching:rrc-00000000-0000-4000-8000-000000000011:false
permit_b=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (release_authority.release_runner_acquire_dispatch_permit('$permit_input_b')->>'state')||':'||(release_authority.release_runner_acquire_dispatch_permit('$permit_input_b')->>'ownerId')")
test "$permit_b" = dispatching:rrc-00000000-0000-4000-8000-000000000011

# A lost/delayed response remains dispatching; discovery may bind, but no lease can redrive POST.
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-effect','rolloutId','r-effect','provisioningIntentId','rri-'||repeat('2',64),
    'serviceId','svc-effect','observedAt','$now','providerCreationNotBefore','$now','cleanupCanary','rr-cleanup:r-effect:rr-effect',
    'lifecycle','role'))" >/dev/null
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-effect','rolloutId','r-effect','provisioningIntentId','rri-'||repeat('2',64),
    'serviceId','svc-effect','observedAt','$now','providerCreationNotBefore','2000-01-01T00:00:00.000Z',
    'cleanupCanary','rr-cleanup:r-effect:rr-effect','lifecycle','role'))" >/dev/null 2>&1; then
  echo "runner job replay weakened its provider creation boundary" >&2
  exit 1
fi
# A lost HTTP response may replay the identical durable job write, but a
# conflicting identity must remain impossible.
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-effect','rolloutId','r-effect','provisioningIntentId','rri-'||repeat('2',64),
    'serviceId','svc-effect','observedAt','$now','providerCreationNotBefore','$now','cleanupCanary','rr-cleanup:r-effect:rr-effect',
    'lifecycle','role'))" >/dev/null
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-effect','rolloutId','r-effect','provisioningIntentId','rri-'||repeat('2',64),
    'serviceId','svc-effect','observedAt','$now','providerCreationNotBefore','$now','cleanupCanary','rr-cleanup:r-effect:conflict',
    'lifecycle','role'))" >/dev/null 2>&1; then
  echo "conflicting runner job replay unexpectedly succeeded" >&2
  exit 1
fi
bound_effect=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_reconcile_effect(
    '{\"intentId\":\"rri-$(printf '2%.0s' $(seq 1 64))\",\"claimantId\":\"rrc-00000000-0000-4000-8000-000000000099\",\"expectedEpoch\":1,\"jobId\":\"job-effect\",\"reconciliation\":{\"result\":\"pending\",\"safeForCompensation\":false}}')->>'state'")
test "$bound_effect" = bound
bound_listing=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (intent->>'state')||':'||(listed->>'creationLeaseOwner')||':'||
      ((listed->>'creationLeaseExpiresAt') IS NOT NULL)
   FROM (SELECT release_authority.release_runner_list_intents('r-effect')->0 listed) value,
        LATERAL (SELECT listed->'effect' intent) effect")
test "$bound_listing" = bound:rrc-00000000-0000-4000-8000-000000000011:false
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
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
unsafe_effect=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT effect_state||':'||effect_safe_for_compensation
   FROM release_authority.runner_intent WHERE intent_id='rri-'||repeat('2',64)")
test "$unsafe_effect" = bound:false
effect_witness=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_witness -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness(
    'job-effect',jsonb_build_object('jobId','job-effect',
      'canary','rr-cleanup:r-effect:rr-effect','providerStatus','succeeded',
      'containerTerminated',true,'logSha256','sha256:'||repeat('3',64),
      'removedPaths',jsonb_build_array('/runner/_work/rr-effect/repo'),
      'remainingPaths','[]'::jsonb,'providerLogId','log-effect',
      'providerCreatedAt','$now','providerObservedAt','$now'))")
test "$effect_witness" = t
effect_terminal=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_mark_terminal(
    'job-effect',jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))")
test "$effect_terminal" = t
clean_effect=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT effect_state||':'||effect_safe_for_compensation
   FROM release_authority.runner_intent WHERE intent_id='rri-'||repeat('2',64)")
test "$clean_effect" = cleaned:true
cleaned_listing=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (intent->>'state')||':'||(listed->>'creationLeaseOwner')||':'||
      ((listed->>'creationLeaseExpiresAt') IS NOT NULL)
   FROM (SELECT release_authority.release_runner_list_intents('r-effect')->0 listed) value,
        LATERAL (SELECT listed->'effect' intent) effect")
test "$cleaned_listing" = cleaned:rrc-00000000-0000-4000-8000-000000000011:false

# Discovery remains authoritative after cleanup: a provider job that appears
# late must be durably witnessable and must revoke compensation safety.
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-effect-late','rolloutId','r-effect','provisioningIntentId','rri-'||repeat('2',64),
    'serviceId','svc-effect','observedAt','$now','providerCreationNotBefore','$now','cleanupCanary','rr-cleanup:r-effect:rr-effect',
    'lifecycle','role'))" >/dev/null
late_duplicate_effect=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (snapshot->>'state')||':'||(snapshot->'reconciliation'->>'reason')||':'||(snapshot->>'safeForCompensation')
   FROM (SELECT release_authority.release_runner_reconcile_effect(jsonb_build_object(
     'intentId','rri-'||repeat('2',64),'claimantId','rrc-00000000-0000-4000-8000-000000000099',
     'expectedEpoch',1,'jobId','job-effect-late','reconciliation',jsonb_build_object(
       'result','blocked','safeForCompensation',false,'reason','duplicate'))) snapshot) blocked")
test "$late_duplicate_effect" = blocked:duplicate:false
docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_witness -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness(
    'job-effect-late',jsonb_build_object('jobId','job-effect-late',
      'canary','rr-cleanup:r-effect:rr-effect','providerStatus','succeeded',
      'containerTerminated',true,'logSha256','sha256:'||repeat('4',64),
      'removedPaths',jsonb_build_array('/runner/_work/rr-effect/late'),
      'remainingPaths','[]'::jsonb,'providerLogId','log-effect-late',
      'providerCreatedAt','$now','providerObservedAt','$now'))" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_mark_terminal(
    'job-effect-late',jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))" >/dev/null
blocked_after_late_cleanup=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT effect_state||':'||effect_safe_for_compensation
   FROM release_authority.runner_intent WHERE intent_id='rri-'||repeat('2',64)")
test "$blocked_after_late_cleanup" = blocked:false
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "UPDATE release_authority.rollout SET state='compensating' WHERE rollout_id='r-effect'" \
  >/dev/null 2>&1; then
  echo "late duplicate unexpectedly preserved compensation safety" >&2
  exit 1
fi

# A terminal fact independently written through the witness credential repairs
# historical transient blocks, but only when there is one durable identity.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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
retryable_witness=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness(
    'job-retryable-clean',jsonb_build_object('jobId','job-retryable-clean',
      'canary','rr-cleanup:r-retryable-clean:rr-retryable','providerStatus','succeeded',
      'containerTerminated',true,'logSha256','sha256:'||repeat('e',64),
      'removedPaths',jsonb_build_array('/runner/_work/rr-retryable/repo'),
      'remainingPaths','[]'::jsonb,'providerLogId','log-retryable',
      'providerCreatedAt','$now','providerObservedAt','$now'))")
test "$retryable_witness" = t
retryable_terminal=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_mark_terminal(
    'job-retryable-clean',jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))")
test "$retryable_terminal" = t
retryable_repaired=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT effect_state||':'||effect_safe_for_compensation
   FROM release_authority.runner_intent WHERE intent_id='rri-'||repeat('e',64)")
test "$retryable_repaired" = cleaned:true

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_claim('r-order', repeat('d',40), '4', 1, '103', '203')" >/dev/null
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-order',repeat('d',40),'4',1,'103','203','stage_target_services',
    'sha256:'||repeat('0',64),'sha256:'||repeat('6',64),'103','before','before',
    '{\"renderDeployIds\":[\"dep\"]}')" >/dev/null 2>&1; then
  echo "out-of-order pre-activation receipt unexpectedly succeeded" >&2
  exit 1
fi

finalized=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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
finalize_replay=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_finalize_activation(
    jsonb_build_object('rolloutId','r1','expectedCommitSha',expected_commit_sha,
      'postgresMajor',activation_postgres_major,'migrationChecksum',activation_migration_checksum,
      'epoch',activation_epoch,'nonce',activation_permit_nonce,
      'sourceSystemIdentifier','100','targetSystemIdentifier','200',
      'previousReceiptSha256',activation_previous_receipt_sha256,'targetDeployIds',activation_target_deploy_ids),
    '{\"deploy\":\"dep\"}', 'sha256:'||repeat('1',64), activation_receipt)
   FROM release_authority.rollout WHERE rollout_id='r1'")
authorization_after_finalize=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.authorize_activation('r1', repeat('a',40), '1', 1, '100', '200', '9', '$stage_receipt', '[\"dep-srv-a\",\"dep-srv-b\",\"dep-srv-c\"]', 17, 'sha256:'||repeat('7',64))")
test "$finalized" = t
test "$finalize_replay" = t
test "$authorization_after_finalize" = "$authorization"

if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r1',repeat('a',40),'1',1,'100','200','verify_live_canary',
    'sha256:'||repeat('1',64),'sha256:'||repeat('2',64),'200',
    'activated','activated',NULL)" >/dev/null 2>&1; then
  echo "out-of-order post-activation receipt unexpectedly succeeded" >&2
  exit 1
fi
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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
post_activation_state=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT state||':'||activation_boundary||':'||source_permanently_ineligible||':'||authoritative_system_identifier
   FROM release_authority.rollout WHERE rollout_id='r1'")
test "$post_activation_state" = activated:activated:true:200

conflicting_finalize=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_finalize_activation(
    jsonb_build_object('rolloutId','r1','expectedCommitSha',expected_commit_sha,
      'postgresMajor',activation_postgres_major,'migrationChecksum',activation_migration_checksum,
      'epoch',activation_epoch,'nonce',repeat('f',32),
      'sourceSystemIdentifier','100','targetSystemIdentifier','200',
      'previousReceiptSha256',activation_previous_receipt_sha256,'targetDeployIds',activation_target_deploy_ids),
    '{\"deploy\":\"dep\"}', 'sha256:'||repeat('1',64), activation_receipt)
   FROM release_authority.rollout WHERE rollout_id='r1'")
test "$conflicting_finalize" = f

if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.authorize_activation('r1', repeat('a',40), '1', 1, '100', '200', '10', '$stage_receipt', '[\"dep\"]', 17, 'sha256:'||repeat('7',64))" >/dev/null 2>&1; then
  echo "conflicting authorization replay unexpectedly succeeded" >&2
  exit 1
fi

if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.authorize_activation('r1', repeat('a',40), '1', 1, '100', '200', '9', '$stage_receipt', '[\"dep\"]', 17, 'sha256:'||repeat('8',64))" >/dev/null 2>&1; then
  echo "conflicting migration checksum replay unexpectedly succeeded" >&2
  exit 1
fi

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_claim('r2', repeat('b',40), '2', 1, '101', '201')" >/dev/null
deploy_request='{"rolloutId":"r2","operation":"deploy_target","sourceSystemIdentifier":"101","targetSystemIdentifier":"201","expectedReceiptSha256":"sha256:'$(printf '0%.0s' $(seq 1 64))'","activationBoundary":"before"}'
decision=$(docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_authority_decide('$deploy_request')")
decision_replay=$(docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_authority_decide('$deploy_request')")
test "$decision" = "$decision_replay"
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r2',repeat('b',40),'2',1,'101','201','claim_rollout',
    'sha256:'||repeat('0',64),'sha256:'||repeat('5',64),'101','before','before',NULL)" >/dev/null
if docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_authority_decide('$deploy_request')" >/dev/null 2>&1; then
  echo "stale provider decision replay unexpectedly succeeded after receipt change" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_authority_decide(jsonb_set('$deploy_request','{expectedReceiptSha256}','\"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\"'))" >/dev/null 2>&1; then
  echo "conflicting provider decision replay unexpectedly succeeded" >&2
  exit 1
fi

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_claim('r-state', repeat('e',40), '5', 1, '104', '204')" >/dev/null
state_request='{"rolloutId":"r-state","operation":"deploy_target","sourceSystemIdentifier":"104","targetSystemIdentifier":"204","expectedReceiptSha256":"sha256:'$(printf '0%.0s' $(seq 1 64))'","activationBoundary":"before"}'
docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_authority_decide('$state_request')" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "UPDATE release_authority.rollout SET state='activated', activation_boundary='activated',
     authoritative_system_identifier=target_system_identifier, source_permanently_ineligible=true
   WHERE rollout_id='r-state'" >/dev/null
if docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_authority_decide('$state_request')" >/dev/null 2>&1; then
  echo "stale provider decision replay unexpectedly succeeded after state change" >&2
  exit 1
fi

# Provider mutation recovery is durable and fail-closed across every crash
# boundary. Only stale pre-validation consumption may rotate to a new owner.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_claim('r-pm-recover', repeat('7',40), '51', 1, '151', '251')" >/dev/null
pm_request='{"rolloutId":"r-pm-recover","operation":"freeze:srv-pm","resource":{"provider":"render","kind":"service","id":"srv-pm"},"ownerId":"actor-pm-one","expected":{"fingerprint":"sha256:'$(printf '7%.0s' $(seq 1 64))'","version":null},"leaseSeconds":60}'
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_mutation_issue('$pm_request')" >/dev/null 2>&1; then
  echo "provider mutation issued without a state-bound provider decision" >&2
  exit 1
fi
pm_decision_request='{"rolloutId":"r-pm-recover","operation":"freeze_source","sourceSystemIdentifier":"151","targetSystemIdentifier":"251","expectedReceiptSha256":"sha256:'$(printf '0%.0s' $(seq 1 64))'","activationBoundary":"before"}'
docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_authority_decide('$pm_decision_request')" >/dev/null
pm_permit=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_mutation_issue('$pm_request')")
pm_claimed_recovery=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_mutation_recover('$pm_request')->>'status'")
test "$pm_claimed_recovery" = permit
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_mutation_recover(jsonb_set('$pm_request','{ownerId}','\"actor-pm-conflict\"'))" >/dev/null 2>&1; then
  echo "fresh provider mutation conflicting-owner recovery unexpectedly succeeded" >&2
  exit 1
fi
pm_receipt=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_mutation_consume('$pm_permit')")
pm_consumed_recovery=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (value->>'phase')||':'||(value->>'reconciliationOnly') FROM
    (SELECT release_authority.release_provider_mutation_recover('$pm_request') value) recovered")
test "$pm_consumed_recovery" = consumed:false
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "UPDATE release_authority.provider_mutation SET expires_at=clock_timestamp()-interval '1 second'
   WHERE rollout_id='r-pm-recover' AND operation='freeze:srv-pm'" >/dev/null
pm_takeover_request=$(printf '%s' "$pm_request" | /usr/bin/sed 's/actor-pm-one/actor-pm-two/')
pm_takeover=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_mutation_recover('$pm_takeover_request')->'permit'")
test "$(printf '%s' "$pm_takeover" | /usr/bin/sed -n 's/.*"ownerId": "\([^"]*\)".*/\1/p')" = actor-pm-two
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_mutation_validate_execution('$pm_receipt')" >/dev/null 2>&1; then
  echo "rotated provider mutation receipt unexpectedly remained executable" >&2
  exit 1
fi
pm_takeover_receipt=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_mutation_consume('$pm_takeover')")
pm_authorized=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_mutation_validate_execution('$pm_takeover_receipt')")
test "$pm_authorized" = t
pm_concurrent_replay=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_mutation_validate_execution('$pm_takeover_receipt')")
test "$pm_concurrent_replay" = f
pm_active_fence=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT mutation.state||':'||lease.active_state||':'||
      (lease.active_permit_id=mutation.permit_id)::text||':'||
      (mutation.completed_at IS NULL)::text
   FROM release_authority.provider_mutation mutation
   JOIN release_authority.provider_resource_lease lease USING(provider,resource_kind,resource_id)
   WHERE mutation.rollout_id='r-pm-recover' AND mutation.operation='freeze:srv-pm'")
test "$pm_active_fence" = executing:executing:true:true
pm_executing_recovery=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (value->>'phase')||':'||(value->>'reconciliationOnly') FROM
    (SELECT release_authority.release_provider_mutation_recover('$pm_takeover_request') value) recovered")
test "$pm_executing_recovery" = executing:false
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "UPDATE release_authority.provider_mutation SET expires_at=clock_timestamp()-interval '1 second'
   WHERE rollout_id='r-pm-recover' AND operation='freeze:srv-pm'" >/dev/null
pm_expired_executing_recovery=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (value->>'phase')||':'||(value->>'reconciliationOnly') FROM
    (SELECT release_authority.release_provider_mutation_recover('$pm_takeover_request') value) recovered")
test "$pm_expired_executing_recovery" = executing:true
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_mutation_recover(jsonb_set('$pm_takeover_request','{ownerId}','\"actor-pm-conflict\"'))" >/dev/null 2>&1; then
  echo "ambiguous executing provider mutation was unsafely taken over" >&2
  exit 1
fi
pm_observation='{"resource":{"provider":"render","kind":"service","id":"srv-pm"},"state":{"fingerprint":"sha256:'$(printf '8%.0s' $(seq 1 64))'","version":null},"observedAt":"2026-08-14T00:00:00.000Z"}'
pm_payload_observation='{"resource":{"provider":"render","kind":"service","id":"srv-pm"},"state":{"fingerprint":"sha256:'$(printf '8%.0s' $(seq 1 64))'","version":null},"observedAt":"2026-08-14T00:00:00.000Z","providerPayload":{"token":"must-not-persist"}}'
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_mutation_reconcile(jsonb_build_object(
    'result','exact_postcondition','receipt','$pm_takeover_receipt'::jsonb,
    'observation','$pm_payload_observation'::jsonb))" >/dev/null 2>&1; then
  echo "provider mutation observation unexpectedly persisted provider payload" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_mutation_reconcile(jsonb_build_object(
    'result','exact_postcondition','receipt','$pm_takeover_receipt'::jsonb,
    'observation','$pm_observation'::jsonb))" >/dev/null 2>&1; then
  echo "executing provider mutation was terminalized through repair" >&2
  exit 1
fi
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_mutation_complete(jsonb_build_object(
    'receipt','$pm_takeover_receipt'::jsonb,
    'observation','$pm_observation'::jsonb))" >/dev/null
pm_terminal_recovery=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (value->>'status')||':'||(value->'outcome'->>'result') FROM
    (SELECT release_authority.release_provider_mutation_recover('$pm_takeover_request') value) recovered")
test "$pm_terminal_recovery" = terminal:exact_postcondition

# Compensation must fail closed when runner-effect evidence is absent or unsafe.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_claim('r-comp-no-intent', repeat('5',40), '6', 1, '105', '205')" >/dev/null
empty_checkpoint=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (checkpoint->>'activationBoundary')||':'||(checkpoint->>'state')||':'||
      (checkpoint->>'lastReceiptSha256')||':'||coalesce(checkpoint->>'lastStep','null')||':'||
      (checkpoint->>'receiptCount')
   FROM (SELECT release_authority.release_rollout_compensation_checkpoint(
      'r-comp-no-intent','105','205') checkpoint) value")
test "$empty_checkpoint" = "before:pre_activation:sha256:$(printf '0%.0s' $(seq 1 64)):null:0"
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-comp-no-intent',repeat('5',40),'6',1,'105','205','begin_compensation',
    'sha256:'||repeat('0',64),'sha256:'||repeat('5',64),'105','before','before',NULL)" >/dev/null 2>&1; then
  echo "compensation without runner intents unexpectedly succeeded" >&2
  exit 1
fi
no_intent_compensation_fence=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT state||':'||activation_boundary||':'||authoritative_system_identifier||':'||source_permanently_ineligible
   FROM release_authority.rollout WHERE rollout_id='r-comp-no-intent'")
test "$no_intent_compensation_fence" = pre_activation:before:105:false

# Zero runner intents are safe only when the provider mutation intent and its
# completed suspension observation are both durable.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_claim('r-comp-zero-safe', repeat('4',40), '8', 1, '108', '208')" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_source_freeze_prepare(
      'r-comp-zero-safe',repeat('4',40),'8',1,'108','208','srv-zero-safe','dep-zero-safe',
      '$now','[\"srv-zero-safe\"]'::jsonb,false);
   SELECT release_authority.release_source_freeze_record(
      'r-comp-zero-safe',repeat('4',40),'8',1,'108','208','srv-zero-safe','dep-zero-safe',
      '$now','[\"srv-zero-safe\"]'::jsonb);
   SELECT release_authority.release_rollout_append_receipt(
      'r-comp-zero-safe',repeat('4',40),'8',1,'108','208','begin_compensation',
      'sha256:'||repeat('0',64),'sha256:'||repeat('e',64),'108','before','before',NULL)" >/dev/null
zero_intent_safe_state=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT state FROM release_authority.rollout WHERE rollout_id='r-comp-zero-safe'")
test "$zero_intent_safe_state" = compensating

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_claim('r-comp-freeze-unknown', repeat('3',40), '9', 1, '109', '209')" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_source_freeze_prepare(
      'r-comp-freeze-unknown',repeat('3',40),'9',1,'109','209','srv-first','dep-first',
      '$now','[\"srv-first\",\"srv-second\"]'::jsonb,false);
   SELECT release_authority.release_source_freeze_record(
      'r-comp-freeze-unknown',repeat('3',40),'9',1,'109','209','srv-first','dep-first',
      '$now','[\"srv-first\",\"srv-second\"]'::jsonb);
   SELECT release_authority.release_source_freeze_prepare(
      'r-comp-freeze-unknown',repeat('3',40),'9',1,'109','209','srv-second','dep-second',
      '$now','[\"srv-first\",\"srv-second\"]'::jsonb,false)" >/dev/null
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-comp-freeze-unknown',repeat('3',40),'9',1,'109','209','begin_compensation',
    'sha256:'||repeat('0',64),'sha256:'||repeat('3',64),'109','before','before',NULL)" >/dev/null 2>&1; then
  echo "compensation with an unresolved source freeze effect unexpectedly succeeded" >&2
  exit 1
fi

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_claim('r-comp-unsafe', repeat('6',40), '7', 1, '106', '206')" >/dev/null
unsafe_compensation_intent=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (snapshot->>'state')||':'||(snapshot->'reconciliation'->>'result')||':'||(snapshot->>'safeForCompensation')
   FROM (SELECT release_authority.release_runner_prepare_effect(jsonb_build_object(
     'id','rri-'||repeat('5',64),'rolloutId','r-comp-unsafe','serviceId','svc-comp-unsafe',
     'lifecycle','role','workflowJobId','70','runnerName','rr-comp-unsafe','createdAt','$now',
     'startCommandSha256','sha256:'||repeat('5',64),
     'creationLeaseOwner','rrc-00000000-0000-4000-8000-000000000051')) snapshot) prepared")
test "$unsafe_compensation_intent" = prepared:pending:false
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-comp-unsafe',repeat('6',40),'7',1,'106','206','begin_compensation',
    'sha256:'||repeat('0',64),'sha256:'||repeat('6',64),'106','before','before',NULL)" >/dev/null 2>&1; then
  echo "compensation with a pending runner intent unexpectedly succeeded" >&2
  exit 1
fi
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_acquire_dispatch_permit(jsonb_build_object(
    'intentId','rri-'||repeat('5',64),'claimantId','rrc-00000000-0000-4000-8000-000000000051',
    'startCommandSha256','sha256:'||repeat('5',64),'expectedEpoch',0,'leaseSeconds',120))" >/dev/null
blocked_compensation_intent=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (snapshot->>'state')||':'||(snapshot->'reconciliation'->>'result')||':'||(snapshot->>'safeForCompensation')
   FROM (SELECT release_authority.release_runner_reconcile_effect(jsonb_build_object(
     'intentId','rri-'||repeat('5',64),'claimantId','rrc-00000000-0000-4000-8000-000000000051',
     'expectedEpoch',1,'reconciliation',jsonb_build_object(
       'result','blocked','safeForCompensation',false,'reason','unknown'))) snapshot) blocked")
test "$blocked_compensation_intent" = dispatching:pending:false
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-comp-unsafe',repeat('6',40),'7',1,'106','206','begin_compensation',
    'sha256:'||repeat('0',64),'sha256:'||repeat('6',64),'106','before','before',NULL)" >/dev/null 2>&1; then
  echo "compensation with a blocked runner intent unexpectedly succeeded" >&2
  exit 1
fi
unsafe_compensation_fence=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT state||':'||activation_boundary||':'||authoritative_system_identifier||':'||source_permanently_ineligible
   FROM release_authority.rollout WHERE rollout_id='r-comp-unsafe'")
test "$unsafe_compensation_fence" = pre_activation:before:106:false

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_claim('r3', repeat('c',40), '3', 1, '102', '202')" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_source_freeze_prepare(
      'r3',repeat('c',40),'3',1,'102','202','srv-compensation','dep-compensation',
      '$now','[\"srv-compensation\"]'::jsonb,false);
   SELECT release_authority.release_source_freeze_record(
      'r3',repeat('c',40),'3',1,'102','202','srv-compensation','dep-compensation',
      '$now','[\"srv-compensation\"]'::jsonb)" >/dev/null
r3_compensation_intent=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_prepare_effect(jsonb_build_object(
    'id','rri-'||repeat('0',64),'rolloutId','r3','serviceId','svc-compensation',
    'lifecycle','cutover','workflowJobId','31','runnerName','rr-compensation','createdAt','$now',
    'startCommandSha256','sha256:'||repeat('0',64),
    'creationLeaseOwner','rrc-00000000-0000-4000-8000-000000000061'))->>'state'")
test "$r3_compensation_intent" = prepared
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_abandon_prepared(
    'rri-'||repeat('0',64),'rrc-00000000-0000-4000-8000-000000000061',0)" \
  >/dev/null 2>&1; then
  echo "unexpired prepared lease was abandoned" >&2
  exit 1
fi
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "UPDATE release_authority.runner_intent
   SET effect_lease_expires_at=clock_timestamp()-interval '1 second'
   WHERE intent_id='rri-'||repeat('0',64)" >/dev/null
r3_abandoned_intent=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (snapshot->>'state')||':'||(snapshot->>'safeForCompensation')
   FROM (SELECT release_authority.release_runner_abandon_prepared(
     'rri-'||repeat('0',64),'rrc-00000000-0000-4000-8000-000000000061',0) snapshot) abandoned")
test "$r3_abandoned_intent" = abandoned:true
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_append_receipt('r3',repeat('c',40),'3',1,'102','202',
    'begin_compensation','sha256:'||repeat('0',64),'sha256:'||repeat('2',64),'102','before','before',NULL)" >/dev/null
compensation_checkpoint=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (checkpoint->>'activationBoundary')||':'||(checkpoint->>'state')||':'||
      (checkpoint->>'lastReceiptSha256')||':'||(checkpoint->>'lastStep')||':'||
      (checkpoint->>'receiptCount')
   FROM (SELECT release_authority.release_rollout_compensation_checkpoint(
      'r3','102','202') checkpoint) value")
test "$compensation_checkpoint" = "before:compensating:sha256:$(printf '2%.0s' $(seq 1 64)):begin_compensation:1"
resume_source_request='{"rolloutId":"r3","operation":"resume_source","sourceSystemIdentifier":"102","targetSystemIdentifier":"202","expectedReceiptSha256":"sha256:'$(printf '2%.0s' $(seq 1 64))'","activationBoundary":"before"}'
docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_authority_decide('$resume_source_request')" >/dev/null

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "INSERT INTO release_authority.runner_intent(intent_id,rollout_id,service_id,lifecycle,workflow_job_id,runner_name,created_at,start_command_sha256)
   VALUES ('rri-'||repeat('3',64),'r3','svc','role','30','rr-test','$now','sha256:'||repeat('3',64));
   INSERT INTO release_authority.runner_job(job_id,rollout_id,provisioning_intent_id,service_id,observed_at,provider_creation_not_before,cleanup_canary,lifecycle)
   VALUES ('job-clean','r3','rri-'||repeat('3',64),'svc','$now','$now','canary','role');" >/dev/null
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc   "SELECT release_authority.release_runner_mark_terminal('job-clean','{\"step\":\"cleanup_role_runner\"}')" >/dev/null 2>&1; then
  echo "terminal CAS without provider cleanup witness unexpectedly succeeded" >&2
  exit 1
fi
cleanup_seed=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_cleanup_observation_seed('job-clean') =
    jsonb_build_object('jobId','job-clean','serviceId','svc',
      'cleanupCanary','canary','observedAt','$now','providerCreationNotBefore','$now')")
test "$cleanup_seed" = t
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_cleanup_observation_seed('job-clean')" >/dev/null 2>&1; then
  echo "control role unexpectedly has witness seed execution" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-clean','{\"jobId\":\"job-clean\",\"canary\":\"canary\",\"providerStatus\":\"failed\",\"containerTerminated\":true,\"logSha256\":\"sha256:$(printf '4%.0s' $(seq 1 64))\",\"removedPaths\":[\"/runner/_work/rr-safe/../secret\"],\"remainingPaths\":[],\"providerLogId\":\"log-1\",\"providerCreatedAt\":\"$now\",\"providerObservedAt\":\"$now\"}')" >/dev/null 2>&1; then
  echo "unsafe cleanup witness unexpectedly succeeded" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-clean','{\"jobId\":\"job-clean\",\"canary\":\"canary\",\"providerStatus\":\"succeeded\",\"containerTerminated\":true,\"logSha256\":\"sha256:$(printf '4%.0s' $(seq 1 64))\",\"removedPaths\":[\"/runner/_work/rr-safe/repo\"],\"remainingPaths\":[],\"providerLogId\":\"log-old\",\"providerCreatedAt\":\"2000-01-01T00:00:00.000Z\",\"providerObservedAt\":\"$now\"}')" >/dev/null 2>&1; then
  echo "provider resource older than the request boundary satisfied cleanup witness" >&2
  exit 1
fi
cleanup_saved=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-clean','{\"jobId\":\"job-clean\",\"canary\":\"canary\",\"providerStatus\":\"succeeded\",\"containerTerminated\":true,\"logSha256\":\"sha256:$(printf '4%.0s' $(seq 1 64))\",\"removedPaths\":[\"/runner/_work/rr-safe/repo\"],\"remainingPaths\":[],\"providerLogId\":\"log-1\",\"providerCreatedAt\":\"$now\",\"providerObservedAt\":\"$now\"}')")
test "$cleanup_saved" = t
cleanup_replayed=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-clean','{\"jobId\":\"job-clean\",\"canary\":\"canary\",\"providerStatus\":\"succeeded\",\"containerTerminated\":true,\"logSha256\":\"sha256:$(printf '4%.0s' $(seq 1 64))\",\"removedPaths\":[\"/runner/_work/rr-safe/repo\"],\"remainingPaths\":[],\"providerLogId\":\"log-1\",\"providerCreatedAt\":\"$now\",\"providerObservedAt\":\"$now\"}')")
test "$cleanup_replayed" = t
# A terminal recovery must also wait parent-first. The adversary holds rollout
# and intent, then reaches for the job; a job-first terminal path deadlocks it.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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
  if test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks
      WHERE locktype='advisory' AND objid=810002 AND granted)")" = t; then
    terminal_order_ready=true
    break
  fi
  sleep 0.05
done
test "$terminal_order_ready" = true
terminal_saved=$(docker exec -e PGPASSWORD=control -e PGOPTIONS='-c lock_timeout=10s' "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_mark_terminal('job-clean','{\"step\":\"cleanup_role_runner\",\"observedAt\":\"$now\"}')")
wait "$terminal_order_pid"
test "$terminal_saved" = t
terminal_replayed=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc   "SELECT release_authority.release_runner_mark_terminal('job-clean','{\"step\":\"cleanup_role_runner\",\"observedAt\":\"$now\"}')")
test "$terminal_replayed" = t
terminal_fact=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc   "SELECT release_authority.release_runner_terminal_cleanup_fact('r3','role')->>'jobId'")
test "$terminal_fact" = job-clean

# A provider identity discovered after the original effect was independently
# witnessed and cleaned must be retained before cleanup and must permanently
# revoke the pre-activation compensation gate.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_claim('r-late-duplicate',repeat('b',40),'81',1,'181','281')" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
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
      -U reviewrouter_release_control -d rr_authority_gate -Atc \
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
      if test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks
          WHERE locktype='advisory' AND objid=810081 AND granted)")" = t; then
        late_persist_ready=true
        break
      fi
      sleep 0.05
    done
    test "$late_persist_ready" = true
    if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
      -U reviewrouter_release_control -d rr_authority_gate -Atc \
      "SELECT release_authority.release_rollout_append_receipt(
        'r-late-duplicate',repeat('b',40),'81',1,'181','281','begin_compensation',
        'sha256:'||repeat('0',64),'sha256:'||repeat('b',64),'181','before','before',NULL)" \
      >/dev/null 2>&1; then
      echo "concurrent compensation raced a late duplicate persistence" >&2
      exit 1
    fi
    wait "$late_persist_pid"
  fi
  late_witness=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d rr_authority_gate -Atc \
    "SELECT release_authority.release_runner_persist_cleanup_witness('$late_job',jsonb_build_object(
      'jobId','$late_job','canary','rr-cleanup:r-late-duplicate:rr-late-dupe',
      'providerStatus','succeeded','containerTerminated',true,'logSha256','sha256:'||repeat('b',64),
      'removedPaths',jsonb_build_array('/runner/_work/rr-late-dupe/repo'),'remainingPaths','[]'::jsonb,
      'providerLogId','log-'||'$late_job','providerCreatedAt','$now','providerObservedAt','$now'))")
  test "$late_witness" = t
  late_terminal=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
    "SELECT release_authority.release_runner_mark_terminal('$late_job',jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))")
  test "$late_terminal" = t
done
late_duplicate_state=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (snapshot->'effect'->>'state')||':'||(snapshot->'effect'->>'safeForCompensation')
   FROM (SELECT release_authority.release_runner_list_intents('r-late-duplicate')->0 AS snapshot) state")
test "$late_duplicate_state" = blocked:false
late_duplicate_count=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT count(*) FROM release_authority.runner_job WHERE rollout_id='r-late-duplicate'")
test "$late_duplicate_count" = 2
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-late-duplicate',repeat('b',40),'81',1,'181','281','begin_compensation',
    'sha256:'||repeat('0',64),'sha256:'||repeat('b',64),'181','before','before',NULL)" >/dev/null 2>&1; then
  echo "compensation after a durably cleaned late duplicate unexpectedly succeeded" >&2
  exit 1
fi
late_terminal_replayed=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_mark_terminal('job-late-after-clean',jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))")
test "$late_terminal_replayed" = t

# A duplicate that is durable before the activation state write must fence the
# write even when the caller already holds the rollout lock.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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
if docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "UPDATE release_authority.rollout SET state='activation_authorized',activation_boundary='uncertain',
     source_permanently_ineligible=true,authoritative_system_identifier=target_system_identifier
   WHERE rollout_id='r-activation-fenced'" >/dev/null 2>&1; then
  echo "known duplicate unexpectedly crossed activation" >&2
  exit 1
fi
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT state||':'||activation_boundary FROM release_authority.rollout
   WHERE rollout_id='r-activation-fenced'")" = pre_activation:before

# The opposite race is forward-only: activation commits first, then late
# discovery persists, acknowledges the durable duplicate fence, and completes
# both independently witnessed cleanups without rolling activation back.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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
docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-activation-first',jsonb_build_object(
    'jobId','job-activation-first','canary','rr-cleanup:r-activation-wins:rr-activation-wins',
    'providerStatus','succeeded','containerTerminated',true,'logSha256','sha256:'||repeat('6',64),
    'removedPaths',jsonb_build_array('/runner/_work/rr-activation-wins/original'),'remainingPaths','[]'::jsonb,
    'providerLogId','log-activation-first','providerCreatedAt','$now','providerObservedAt','$now'))" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_mark_terminal('job-activation-first',
    jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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
  if test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND objid=810087 AND granted)")" = t; then
    activation_winner_ready=true
    break
  fi
  sleep 0.05
done
test "$activation_winner_ready" = true
docker exec -e PGPASSWORD=control -e PGOPTIONS='-c lock_timeout=10s' "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-activation-late','rolloutId','r-activation-wins',
    'provisioningIntentId','rri-'||repeat('6',63)||'7','serviceId','svc-activation-wins','observedAt','$now','providerCreationNotBefore','$now',
    'cleanupCanary','rr-cleanup:r-activation-wins:rr-activation-wins','lifecycle','role'));
   SELECT release_authority.release_runner_reconcile_effect(jsonb_build_object(
    'intentId','rri-'||repeat('6',63)||'7','claimantId','rrc-00000000-0000-4000-8000-000000000087',
    'expectedEpoch',1,'reconciliation',jsonb_build_object(
      'result','blocked','safeForCompensation',false,'reason','duplicate')))" >/dev/null
wait "$activation_winner_pid"
docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-activation-late',jsonb_build_object(
    'jobId','job-activation-late','canary','rr-cleanup:r-activation-wins:rr-activation-wins',
    'providerStatus','succeeded','containerTerminated',true,'logSha256','sha256:'||repeat('6',64),
    'removedPaths',jsonb_build_array('/runner/_work/rr-activation-wins/late'),'remainingPaths','[]'::jsonb,
    'providerLogId','log-activation-late','providerCreatedAt','$now','providerObservedAt','$now'))" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_mark_terminal('job-activation-late',
    jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-activation-late','rolloutId','r-activation-wins',
    'provisioningIntentId','rri-'||repeat('6',63)||'7','serviceId','svc-activation-wins','observedAt','$now','providerCreationNotBefore','$now',
    'cleanupCanary','rr-cleanup:r-activation-wins:rr-activation-wins','lifecycle','role'));
   SELECT release_authority.release_runner_mark_terminal('job-activation-late',
    jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))" >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
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
  if test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND objid=810088 AND granted)")" = t; then
    compensation_winner_ready=true
    break
  fi
  sleep 0.05
done
test "$compensation_winner_ready" = true
docker exec -e PGPASSWORD=control -e PGOPTIONS='-c lock_timeout=10s' "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-compensation-late','rolloutId','r-compensation-wins',
    'provisioningIntentId','rri-'||repeat('5',63)||'8','serviceId','svc-compensation-wins','observedAt','$now','providerCreationNotBefore','$now',
    'cleanupCanary','rr-cleanup:r-compensation-wins:rr-compensation-wins','lifecycle','role'))" >/dev/null
wait "$compensation_winner_pid"
docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-compensation-late',jsonb_build_object(
    'jobId','job-compensation-late','canary','rr-cleanup:r-compensation-wins:rr-compensation-wins',
    'providerStatus','succeeded','containerTerminated',true,'logSha256','sha256:'||repeat('5',64),
    'removedPaths',jsonb_build_array('/runner/_work/rr-compensation-wins/late'),'remainingPaths','[]'::jsonb,
    'providerLogId','log-compensation-late','providerCreatedAt','$now','providerObservedAt','$now'))" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_mark_terminal('job-compensation-late',
    jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))" >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT rollout.state||':'||rollout.last_receipt_sha256||':'||intent.effect_state||':'||
     intent.effect_safe_for_compensation||':'||(job.terminal_at IS NOT NULL)
   FROM release_authority.rollout rollout
   JOIN release_authority.runner_intent intent USING (rollout_id)
   JOIN release_authority.runner_job job USING (rollout_id)
   WHERE rollout.rollout_id='r-compensation-wins'")" \
  = "compensating:sha256:$(printf 'f%.0s' $(seq 1 64)):blocked:false:true"

# Late identity wins the next boundary: neither an authority replay nor effect
# or completion receipt may use the clean snapshot captured by begin.
if docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_provider_authority -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_authority_decide(jsonb_build_object(
    'rolloutId','r-compensation-wins','operation','resume_source',
    'sourceSystemIdentifier','188','targetSystemIdentifier','288',
    'expectedReceiptSha256','sha256:'||repeat('f',64),'activationBoundary','before'))" \
  >/dev/null 2>&1; then
  echo "late runner effect reused source recovery authority" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-compensation-wins',repeat('5',40),'88',1,'188','288','effect_compensation',
    'sha256:'||repeat('f',64),'sha256:'||repeat('e',64),'188','before','before',NULL)" \
  >/dev/null 2>&1; then
  echo "late runner effect crossed effect_compensation" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-compensation-wins',repeat('5',40),'88',1,'188','288','complete_compensation',
    'sha256:'||repeat('f',64),'sha256:'||repeat('d',64),'188','before','before',NULL)" \
  >/dev/null 2>&1; then
  echo "late runner effect crossed complete_compensation" >&2
  exit 1
fi
test "$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT (result->>'state')||':'||(result->>'sourceEligible')
   FROM (SELECT release_authority.release_rollout_reconcile(
     'r-compensation-wins','{}'::jsonb) result) reconciled")" \
  = pre_activation_recovery_required:false

# Opposite ordering: effect_compensation owns the rollout lock first. The late
# identity waits, is then persisted as unsafe, and fences completion and source
# eligibility without deadlocking the rollout -> intent -> job order.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_service_transition_begin(jsonb_build_object(
    'rolloutId','r-effect-wins','manifestSha256','sha256:'||repeat('4',64),
    'targetContractSha256','sha256:'||repeat('3',64),
    'serviceIds',jsonb_build_array('srv-effect','srv-effect-b','srv-effect-c'),
    'sourceManifest',jsonb_build_object('manifestSha256','sha256:'||repeat('4',64),'services','[]'::jsonb),
    'targetContracts',jsonb_build_array(jsonb_build_object('serviceId','srv-effect'),
      jsonb_build_object('serviceId','srv-effect-b'),jsonb_build_object('serviceId','srv-effect-c'))))" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-effect-wins',repeat('4',40),'89',1,'189','289','begin_compensation',
    'sha256:'||repeat('0',64),'sha256:'||repeat('a',64),'189','before','before',NULL)" >/dev/null
recovery_intent_first=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_service_transition_append(jsonb_build_object(
    'rolloutId','r-effect-wins','manifestSha256','sha256:'||repeat('4',64),
    'targetContractSha256','sha256:'||repeat('3',64),'serviceId','srv-effect',
    'step','restore_config_intent'))->>'sequence'")
test "$recovery_intent_first" = 2
recovery_intent_replay=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_service_transition_append(jsonb_build_object(
    'rolloutId','r-effect-wins','manifestSha256','sha256:'||repeat('4',64),
    'targetContractSha256','sha256:'||repeat('3',64),'serviceId','srv-effect',
    'step','restore_config_intent'))->>'sequence'")
test "$recovery_intent_replay" = 2
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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
  if test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND objid=810089 AND granted)")" = t; then
    effect_winner_ready=true
    break
  fi
  sleep 0.05
done
test "$effect_winner_ready" = true
docker exec -e PGPASSWORD=control -e PGOPTIONS='-c lock_timeout=10s' "$name" \
  psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-effect-wins-late','rolloutId','r-effect-wins',
    'provisioningIntentId','rri-'||repeat('4',63)||'9','serviceId','svc-effect-wins','observedAt','$now',
    'providerCreationNotBefore','$now',
    'cleanupCanary','rr-cleanup:r-effect-wins:rr-effect-wins','lifecycle','role'))" >/dev/null
wait "$effect_winner_pid"
docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_witness -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_cleanup_witness('job-effect-wins-late',jsonb_build_object(
    'jobId','job-effect-wins-late','canary','rr-cleanup:r-effect-wins:rr-effect-wins',
    'providerStatus','succeeded','containerTerminated',true,'logSha256','sha256:'||repeat('4',64),
    'removedPaths',jsonb_build_array('/runner/_work/rr-effect-wins/late'),'remainingPaths','[]'::jsonb,
    'providerLogId','log-effect-wins-late','providerCreatedAt','$now','providerObservedAt','$now'))" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_mark_terminal('job-effect-wins-late',
    jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))" >/dev/null
if docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_provider_authority -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_authority_decide(jsonb_build_object(
    'rolloutId','r-effect-wins','operation','resume_source',
    'sourceSystemIdentifier','189','targetSystemIdentifier','289',
    'expectedReceiptSha256','sha256:'||repeat('b',64),'activationBoundary','before'))" \
  >/dev/null 2>&1; then
  echo "effect-first late runner reused source recovery authority" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_service_transition_append(jsonb_build_object(
    'rolloutId','r-effect-wins','manifestSha256','sha256:'||repeat('4',64),
    'targetContractSha256','sha256:'||repeat('3',64),'serviceId','srv-effect',
    'step','restore_config_intent'))" >/dev/null 2>&1; then
  echo "late runner effect reused a source recovery intent" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_append_receipt(
    'r-effect-wins',repeat('4',40),'89',1,'189','289','complete_compensation',
    'sha256:'||repeat('b',64),'sha256:'||repeat('c',64),'189','before','before',NULL)" \
  >/dev/null 2>&1; then
  echo "effect-first late runner crossed complete_compensation" >&2
  exit 1
fi
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 \
  -U postgres -d rr_authority_gate -Atc \
  "SELECT rollout.state||':'||rollout.last_receipt_sha256||':'||
     (reconciled.result->>'sourceEligible')
   FROM release_authority.rollout rollout
   CROSS JOIN LATERAL (SELECT release_authority.release_rollout_reconcile(
     rollout.rollout_id,'{}'::jsonb) result) reconciled
   WHERE rollout.rollout_id='r-effect-wins'")" \
  = "compensating:sha256:$(printf 'b%.0s' $(seq 1 64)):false"

for provider_status in failed canceled; do
  rollout="r-clean-$provider_status"
  suffix=f
  test "$provider_status" = canceled && suffix=c
  runner_label="rr-${suffix}${suffix}"
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
    "SELECT release_authority.release_rollout_claim('$rollout',repeat('$suffix',40),'7',1,'170','270');
     INSERT INTO release_authority.runner_intent(intent_id,rollout_id,service_id,lifecycle,workflow_job_id,runner_name,created_at,start_command_sha256)
     VALUES ('rri-'||repeat('$suffix',64),'$rollout','svc-$suffix','role','70','$runner_label','$now','sha256:'||repeat('$suffix',64));
     INSERT INTO release_authority.runner_job(job_id,rollout_id,provisioning_intent_id,service_id,observed_at,provider_creation_not_before,cleanup_canary,lifecycle)
     VALUES ('job-$provider_status','$rollout','rri-'||repeat('$suffix',64),'svc-$suffix','$now','$now','canary-$suffix','role');" >/dev/null
  terminal_witness=$(docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d rr_authority_gate -Atc \
    "SELECT release_authority.release_runner_persist_cleanup_witness('job-$provider_status',jsonb_build_object('jobId','job-$provider_status','canary','canary-$suffix','providerStatus','$provider_status','containerTerminated',true,'logSha256','sha256:'||repeat('$suffix',64),'removedPaths',jsonb_build_array('/runner/_work/$runner_label/repo'),'remainingPaths','[]'::jsonb,'providerLogId','log-$suffix','providerCreatedAt','$now','providerObservedAt','$now'))")
  test "$terminal_witness" = t
  terminal_result=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
    "SELECT release_authority.release_runner_mark_terminal('job-$provider_status',jsonb_build_object('step','cleanup_role_runner','observedAt','$now'))")
  test "$terminal_result" = t
done

rejected_index=0
for rejected_status in pending running unknown; do
  rejected_index=$((rejected_index + 1))
  rejected_rollout="r-clean-rejected-$rejected_status"
  rejected_job="job-rejected-$rejected_status"
  rejected_label="rr-rejected-$rejected_status"
  docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
    "SELECT release_authority.release_rollout_claim('$rejected_rollout',repeat('8',39)||'$rejected_index','8',1,'18$rejected_index','28$rejected_index');
     INSERT INTO release_authority.runner_intent(intent_id,rollout_id,service_id,lifecycle,workflow_job_id,runner_name,created_at,start_command_sha256)
     VALUES ('rri-'||repeat('9',63)||'$rejected_index','$rejected_rollout','svc-rejected-$rejected_index','role','8$rejected_index','$rejected_label','$now','sha256:'||repeat('9',63)||'$rejected_index');
     INSERT INTO release_authority.runner_job(job_id,rollout_id,provisioning_intent_id,service_id,observed_at,provider_creation_not_before,cleanup_canary,lifecycle)
     VALUES ('$rejected_job','$rejected_rollout','rri-'||repeat('9',63)||'$rejected_index','svc-rejected-$rejected_index','$now','$now','canary-rejected-$rejected_index','role');" >/dev/null
  if docker exec -e PGPASSWORD=witness "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_witness -d rr_authority_gate -Atc \
    "SELECT release_authority.release_runner_persist_cleanup_witness('$rejected_job',jsonb_build_object('jobId','$rejected_job','canary','canary-rejected-$rejected_index','providerStatus','$rejected_status','containerTerminated',true,'logSha256','sha256:'||repeat('9',63)||'$rejected_index','removedPaths',jsonb_build_array('/runner/_work/$rejected_label/repo'),'remainingPaths','[]'::jsonb,'providerLogId','log-rejected-$rejected_status','providerCreatedAt','$now','providerObservedAt','$now'))" >/dev/null 2>&1; then
    echo "nonterminal provider status $rejected_status unexpectedly satisfied cleanup witness" >&2
    exit 1
  fi
done

# A recovery claim is only a lease. Expiry advances the epoch and fences the
# old token; consumption is single-use. A job persisted after completion makes
# the rollout and effect monotonically forward-only rather than undoing it.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_recovery_effect_intend(jsonb_build_object(
    'rolloutId','r-recovery-permit','effectKey','restore_database_writes',
    'kind','restore_database_writes'))->>'state'")
test "$recovery_intent" = intended
first_claim=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_recovery_effect_claim(jsonb_build_object(
    'rolloutId','r-recovery-permit','effectKey','restore_database_writes',
    'kind','restore_database_writes','ownerId','recovery_worker_1','leaseSeconds',5))")
first_epoch=$(printf '%s' "$first_claim" | sed -n 's/.*"epoch": \([0-9]*\).*/\1/p')
first_token=$(printf '%s' "$first_claim" | sed -n 's/.*"permitToken": "\([a-f0-9]*\)".*/\1/p')
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "UPDATE release_authority.recovery_effect SET lease_expires_at=clock_timestamp()-interval '1 second'
   WHERE rollout_id='r-recovery-permit' AND effect_key='restore_database_writes'" >/dev/null
second_claim=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_recovery_effect_claim(jsonb_build_object(
    'rolloutId','r-recovery-permit','effectKey','restore_database_writes',
    'kind','restore_database_writes','ownerId','recovery_worker_2','leaseSeconds',30))")
second_epoch=$(printf '%s' "$second_claim" | sed -n 's/.*"epoch": \([0-9]*\).*/\1/p')
second_token=$(printf '%s' "$second_claim" | sed -n 's/.*"permitToken": "\([a-f0-9]*\)".*/\1/p')
test "$second_epoch" -gt "$first_epoch"
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_recovery_effect_consume(jsonb_build_object(
    'rolloutId','r-recovery-permit','effectKey','restore_database_writes',
    'ownerId','recovery_worker_1','epoch',$first_epoch,'permitToken','$first_token'))" >/dev/null 2>&1; then
  echo "expired recovery permit unexpectedly replayed" >&2
  exit 1
fi
recovery_consume_a="$contract_tmp/recovery-consume-a.json"
recovery_consume_b="$contract_tmp/recovery-consume-b.json"
(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_recovery_effect_consume(jsonb_build_object(
    'rolloutId','r-recovery-permit','effectKey','restore_database_writes',
    'kind','restore_database_writes','ownerId','recovery_worker_2',
    'epoch',$second_epoch,'permitToken','$second_token'))" >"$recovery_consume_a") &
consume_pid_a=$!
(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_recovery_effect_consume(jsonb_build_object(
    'rolloutId','r-recovery-permit','effectKey','restore_database_writes',
    'kind','restore_database_writes','ownerId','recovery_worker_2',
    'epoch',$second_epoch,'permitToken','$second_token'))" >"$recovery_consume_b") &
consume_pid_b=$!
wait "$consume_pid_a" "$consume_pid_b"
test "$(grep -h -c '"executionAuthorization": null' "$recovery_consume_a" "$recovery_consume_b" | awk '{sum += $1} END {print sum}')" = 1
test "$(grep -h -c '"executionAuthorization": {' "$recovery_consume_a" "$recovery_consume_b" | awk '{sum += $1} END {print sum}')" = 1
execution_receipt=$(grep -h '"executionAuthorization": {' "$recovery_consume_a" "$recovery_consume_b" |
  sed -n 's/.*"receipt": "\([a-f0-9]*\)".*/\1/p')
test "${#execution_receipt}" = 64
validated_execution=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_recovery_effect_validate_execution(jsonb_build_object(
    'rolloutId','r-recovery-permit','effectKey','restore_database_writes',
    'kind','restore_database_writes','ownerId','recovery_worker_2',
    'epoch',$second_epoch,'permitToken','$second_token','executionReceipt','$execution_receipt'))")
test "$(printf '%s' "$validated_execution" | grep -c '"executionAuthorization": {')" = 1
# Validation is one-shot just like consumption; replay never authorizes I/O.
validation_replay=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_recovery_effect_validate_execution(jsonb_build_object(
    'rolloutId','r-recovery-permit','effectKey','restore_database_writes',
    'kind','restore_database_writes','ownerId','recovery_worker_2',
    'epoch',$second_epoch,'permitToken','$second_token','executionReceipt','$execution_receipt'))")
test "$(printf '%s' "$validation_replay" | grep -c '"executionAuthorization": null')" = 1
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_recovery_effect_complete(jsonb_build_object(
    'rolloutId','r-recovery-permit','effectKey','restore_database_writes',
    'kind','restore_database_writes','ownerId','recovery_worker_2',
    'epoch',$second_epoch,'permitToken','$second_token','executionReceipt','$execution_receipt','observation',
    jsonb_build_object('sourceWritesRestored',true,'observedAt','$now',
      'environmentDelta',jsonb_build_object('PASSWORD','secret'))))" >/dev/null 2>&1; then
  echo "secret-bearing recovery observation unexpectedly persisted" >&2
  exit 1
fi
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT observation IS NULL FROM release_authority.recovery_effect
   WHERE rollout_id='r-recovery-permit' AND effect_key='restore_database_writes'")" = t
# Model a provider call in flight: validation committed, then a late runner job
# linearizes before completion. The trigger and completion share the rollout
# lock, so completion can only retain an observation as forward repair.
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_persist_job(jsonb_build_object(
    'jobId','job-recovery-late','rolloutId','r-recovery-permit',
    'provisioningIntentId','rri-'||repeat('3',63)||'2','serviceId','svc-recovery-permit',
    'observedAt','$now','providerCreationNotBefore','$now',
    'cleanupCanary','rr-cleanup:r-recovery-permit:rr-recovery-permit','lifecycle','role'))" >/dev/null
docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_recovery_effect_complete(jsonb_build_object(
    'rolloutId','r-recovery-permit','effectKey','restore_database_writes',
    'kind','restore_database_writes','ownerId','recovery_worker_2',
    'epoch',$second_epoch,'permitToken','$second_token','executionReceipt','$execution_receipt','observation',
    jsonb_build_object('sourceWritesRestored',true,'observedAt','$now')))" >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT rollout.recovery_forward_only||':'||effect.state||':'||effect.epoch||':'||
      (effect.observation->>'sourceWritesRestored')
   FROM release_authority.rollout rollout JOIN release_authority.recovery_effect effect USING (rollout_id)
   WHERE rollout.rollout_id='r-recovery-permit'")" = "true:forward_repair:$second_epoch:true"

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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
reconcile_context=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_reconciliation_context('r-reconcile')->'authorization'->>'nonce'")
test "$reconcile_context" = "$(printf '7%.0s' $(seq 1 32))"
matching_observation='{"kind":"matching_activation_receipt","authorization":{"rolloutId":"r-reconcile","expectedCommitSha":"'$(printf '5%.0s' $(seq 1 40))'","postgresMajor":17,"migrationChecksum":"sha256:'$(printf '8%.0s' $(seq 1 64))'","epoch":1,"nonce":"'$(printf '7%.0s' $(seq 1 32))'","sourceSystemIdentifier":"150","targetSystemIdentifier":"250","previousReceiptSha256":"sha256:'$(printf '6%.0s' $(seq 1 64))'","targetDeployIds":["dep-r"],"authorizedAt":"'$now'"},"nextReceiptSha256":"sha256:'$(printf 'd%.0s' $(seq 1 64))'","activationReceipt":{"rolloutId":"r-reconcile","expectedCommitSha":"'$(printf '5%.0s' $(seq 1 40))'","sourceSystemIdentifier":"150","targetSystemIdentifier":"250","receiptSha256":"sha256:'$(printf 'd%.0s' $(seq 1 64))'","permitEpoch":1,"permitNonce":"'$(printf '7%.0s' $(seq 1 32))'","previousReceiptSha256":"sha256:'$(printf '6%.0s' $(seq 1 64))'","targetDeployIds":["dep-r"]}}'
reconciled_activation=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_reconcile('r-reconcile','$matching_observation')->>'state'")
test "$reconciled_activation" = activated
reconciled_replay=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_reconcile('r-reconcile','{\"kind\":\"not_required\"}')->>'state'")
test "$reconciled_replay" = activated
absence_state=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_rollout_reconcile('r-absence','{\"kind\":\"activation_absent_without_revocation\"}')->>'state'")
test "$absence_state" = forward_repair_required
absence_fence=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT activation_boundary||':'||source_permanently_ineligible||':'||authoritative_system_identifier FROM release_authority.rollout WHERE rollout_id='r-absence'")
test "$absence_fence" = uncertain:true:260

control_acl=$(docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.observe_state('r1','100','200')")
test "$control_acl" = activated
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT count(*) FROM release_authority.rollout" >/dev/null 2>&1; then
  echo "control role unexpectedly has direct table access" >&2
  exit 1
fi
migration_acl=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
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
      ('release_source_freeze_inventory_canonical',false),
      ('release_source_freeze_prepare',true),
      ('release_source_freeze_record',true),
      ('release_source_freeze_complete',true),
      ('release_recovery_effect_snapshot',false),
      ('release_recovery_effect_intend',true),
      ('release_recovery_effect_claim',true),
      ('release_recovery_effect_consume',true),
      ('release_recovery_effect_validate_execution',true),
      ('release_recovery_effect_complete',true),
      ('release_recovery_effect_reconcile',true),
      ('release_late_job_recovery_effect_gate',false),
      ('release_recovery_checkpoint_permit_gate',false),
      ('release_provider_mutation_permit',false),
      ('release_provider_mutation_receipt',false),
      ('release_provider_mutation_outcome',false),
      ('release_provider_mutation_finish',false),
      ('release_provider_mutation_issue',true),
      ('release_provider_mutation_recover',true),
      ('release_provider_mutation_consume',true),
      ('release_provider_mutation_validate_execution',true),
      ('release_provider_mutation_complete',true),
      ('release_provider_mutation_reconcile',true)
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
test "$migration_acl" = 35:true:true:true:true:true
legacy_control_acl=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -Atc \
  "SELECT pg_catalog.has_function_privilege('reviewrouter_release_control',
      'release_authority.release_runner_persist_intent(jsonb)','EXECUTE')||':'||
    pg_catalog.has_function_privilege('reviewrouter_release_control',
      'release_authority.release_runner_claim_provider_creation(jsonb)','EXECUTE')||':'||
    pg_catalog.has_function_privilege('reviewrouter_release_control',
      'release_authority.release_runner_record_intent_outcome(jsonb)','EXECUTE')")
test "$legacy_control_acl" = false:false:false
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_effect_snapshot(
     NULL::release_authority.runner_intent)" >/dev/null 2>&1; then
  echo "control role unexpectedly executes private effect snapshot" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 \
  -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_runner_job_cleanup_proven(
     NULL::release_authority.runner_job)" >/dev/null 2>&1; then
  echo "control role unexpectedly executes private cleanup proof predicate" >&2
  exit 1
fi
for role_and_password in "reviewrouter_release_control:control" "reviewrouter_provider_authority:provider" "reviewrouter_release_witness:witness"; do
  role=${role_and_password%%:*}
  password=${role_and_password#*:}
  if docker exec -e PGPASSWORD="$password" "$name" psql -v ON_ERROR_STOP=1 -U "$role" -d rr_authority_gate -Atc \
    "SELECT count(*) FROM release_authority.provider_authority_decision" >/dev/null 2>&1; then
    echo "$role unexpectedly has direct decision table access" >&2
    exit 1
  fi
  for protected_relation in provider_mutation provider_resource_lease; do
    if docker exec -e PGPASSWORD="$password" "$name" psql -v ON_ERROR_STOP=1 -U "$role" -d rr_authority_gate -Atc \
      "SELECT count(*) FROM release_authority.$protected_relation" >/dev/null 2>&1; then
      echo "$role unexpectedly has direct $protected_relation access" >&2
      exit 1
    fi
  done
done
if docker exec -e PGPASSWORD=control "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_release_control -d rr_authority_gate -Atc \
  "SELECT release_authority.release_provider_authority_decide('$deploy_request')" >/dev/null 2>&1; then
  echo "control credential unexpectedly has provider authority execution" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=provider "$name" psql -v ON_ERROR_STOP=1 -U reviewrouter_provider_authority -d rr_authority_gate -Atc \
  "SELECT release_authority.observe_state('r1','100','200')" >/dev/null 2>&1; then
  echo "provider credential unexpectedly has control execution" >&2
  exit 1
fi

# Terminal readiness pins both cluster and provider identity. These destructive
# checks are last because provider replacement intentionally destroys the
# provider-root membership edges and requires a recovery ceremony.
node -e "const fs=require('node:fs');import('./scripts/install-release-authority-db.mjs').then(m=>process.stdout.write(m.releaseAuthorityBootstrapTerminalSql('rr_authority_gate_bootstrap',JSON.parse(fs.readFileSync(process.argv[1],'utf8')))))" \
  "$contract_tmp/gate-provider-root.json" > "$contract_tmp/gate-terminal.sql"
node -e "const fs=require('node:fs');import('./scripts/install-release-authority-db.mjs').then(m=>{const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));p.systemIdentifier=String(BigInt(p.systemIdentifier)+1n);process.stdout.write(m.releaseAuthorityBootstrapTerminalSql('rr_authority_gate_bootstrap',p))})" \
  "$contract_tmp/gate-provider-root.json" > "$contract_tmp/gate-restored-system.sql"
docker cp "$contract_tmp/gate-terminal.sql" "$name:/tmp/gate-terminal.sql" >/dev/null
docker cp "$contract_tmp/gate-restored-system.sql" "$name:/tmp/gate-restored-system.sql" >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres \
  -d rr_authority_gate -Atf /tmp/gate-terminal.sql)" = terminal
for provider_drift in \
  "ALTER ROLE reviewrouter_bootstrap_administrator CONNECTION LIMIT 2" \
  "ALTER ROLE reviewrouter_bootstrap_administrator VALID UNTIL '2030-01-01'" \
  "ALTER ROLE reviewrouter_bootstrap_administrator SET search_path TO pg_catalog" \
  "CREATE SCHEMA rr_provider_ownership_drift AUTHORIZATION reviewrouter_bootstrap_administrator"; do
  provider_topology_exact=$(docker exec "$name" psql -v ON_ERROR_STOP=1 -qAt \
    -U postgres -d rr_authority_gate -c \
    "BEGIN; $provider_drift;
     SELECT reviewrouter_migration_credential.provider_terminal_topology_is_exact();
     ROLLBACK;")
  test "$provider_topology_exact" = f
done
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "CREATE DATABASE rr_provider_ownership_drift
     OWNER reviewrouter_bootstrap_administrator" >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres \
  -d rr_authority_gate -Atf /tmp/gate-terminal.sql)" = requires-migration
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "DROP DATABASE rr_provider_ownership_drift" >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres \
  -d rr_authority_gate -Atf /tmp/gate-terminal.sql)" = terminal
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres \
  -d rr_authority_gate -Atf /tmp/gate-restored-system.sql)" = requires-migration
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "CREATE SCHEMA reviewrouter_migration_bootstrap" >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres \
  -d rr_authority_gate -Atf /tmp/gate-terminal.sql)" = requires-migration
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "DROP SCHEMA reviewrouter_migration_bootstrap" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "GRANT CREATE ON DATABASE rr_authority_gate TO reviewrouter_bootstrap_administrator" >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres \
  -d rr_authority_gate -Atf /tmp/gate-terminal.sql)" = requires-migration
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "REVOKE CREATE ON DATABASE rr_authority_gate FROM reviewrouter_bootstrap_administrator" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "CREATE ROLE rr_terminal_membership_drift NOLOGIN;
   GRANT reviewrouter_authority_owner TO rr_terminal_membership_drift" >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres \
  -d rr_authority_gate -Atf /tmp/gate-terminal.sql)" = requires-migration
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "REVOKE reviewrouter_authority_owner FROM rr_terminal_membership_drift;
   DROP ROLE rr_terminal_membership_drift" >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "UPDATE reviewrouter_migration_credential.bootstrap_retirement
   SET lifecycle_state='quiesced'" >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres \
  -d rr_authority_gate -Atf /tmp/gate-terminal.sql)" = requires-migration
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "UPDATE reviewrouter_migration_credential.bootstrap_retirement
   SET lifecycle_state='deleted'" >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres \
  -d rr_authority_gate -Atf /tmp/gate-terminal.sql)" = terminal
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d rr_authority_gate -c \
  "DROP OWNED BY reviewrouter_bootstrap_administrator;
   DROP ROLE reviewrouter_bootstrap_administrator;
   CREATE ROLE reviewrouter_bootstrap_administrator LOGIN CREATEROLE
     NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1" >/dev/null
test "$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres \
  -d rr_authority_gate -Atf /tmp/gate-terminal.sql)" = requires-migration

echo "release authority PG17 contract passed"
