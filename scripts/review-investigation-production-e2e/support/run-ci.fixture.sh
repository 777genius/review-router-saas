#!/usr/bin/env bash
# Only the CI PostgreSQL service. Keep the shared test database and legacy tests
# unchanged; assign a freshly CREATED database to the process-restart scenario.
set -euo pipefail
# pnpm run forwards its optional separator; Vitest must not receive it.
if [[ "${1:-}" == -- ]]; then shift; fi
pnpm exec tsc --noEmit -p scripts/review-investigation-production-e2e/tsconfig.json
node --test scripts/review-investigation-production-e2e/support/*.test.mjs
run_tests() {
  REVIEW_ROUTER_REVIEW_INVESTIGATION_E2E=1 pnpm exec vitest run scripts/review-investigation-production-e2e/review-investigation-production.e2e.test.ts "$@"
}
# Local callers retain their configured database and optional Vitest arguments.
if [[ "${CI:-}" != true ]]; then
  node --input-type=module -e 'import { item11Enabled } from "./scripts/review-investigation-production-e2e/support/item11-gate.fixture.mjs"; item11Enabled(process.env);'
  run_tests "$@"
  exit $?
fi
# Parse only an explicit loopback URL; never echo parser errors or credentials.
item11_connection="$(node --input-type=module -e '
  try {
    const u = new URL(process.env.REVIEW_ROUTER_TEST_DATABASE_URL);
    const user = decodeURIComponent(u.username), password = decodeURIComponent(u.password);
    if (!["postgres:", "postgresql:"].includes(u.protocol) ||
        !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
        (u.search && u.search !== "?schema=public") || u.hash || !user || /[\r\n\0]/.test(user + password) ||
        (u.port && (!/^\d+$/.test(u.port) || +u.port < 1 || +u.port > 65535))) throw 0;
    process.stdout.write([u.hostname.replace(/^\[|\]$/g, ""), u.port || "5432", user, password, "end"].join("\n"));
  } catch { process.stderr.write("item11_invalid_test_database_url\n"); process.exit(1); }
')"
mapfile -t item11_connection_fields <<< "$item11_connection"
export PGHOST="${item11_connection_fields[0]}" PGPORT="${item11_connection_fields[1]}"
export PGUSER="${item11_connection_fields[2]}" PGPASSWORD="${item11_connection_fields[3]}"
unset item11_connection item11_connection_fields
export PGDATABASE=postgres PGCONNECT_TIMEOUT=5
export REVIEW_ROUTER_ITEM11_RUN_ID
REVIEW_ROUTER_ITEM11_RUN_ID="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
[[ "$REVIEW_ROUTER_ITEM11_RUN_ID" =~ ^[a-f0-9]{32}$ ]]
item11_database="item11_test_${REVIEW_ROUTER_ITEM11_RUN_ID}"
item11_created=0
item11_create_attempted=0
export REVIEW_ROUTER_ITEM11_CHILD_PROOF_DIR
REVIEW_ROUTER_ITEM11_CHILD_PROOF_DIR="$(mktemp -d "${TMPDIR:-/tmp}/item11-child-proof.XXXXXXXX")"
# Exact-name catalog lookup also identifies the database owner; never broad matching.
lookup_database() {
  psql -X -At -v ON_ERROR_STOP=1 -c "SELECT CASE WHEN datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user) THEN 'owned' ELSE 'foreign' END FROM pg_database WHERE datname = '$item11_database'"
}
cleanup() {
  local result=$? state
  local -a pending_children
  shopt -s nullglob dotglob
  pending_children=("$REVIEW_ROUTER_ITEM11_CHILD_PROOF_DIR"/*)
  trap - EXIT
  if [[ "$item11_created" == 1 ]]; then
    # Empty ledger proves every spawned child emitted close. Uncertain close,
    # parent death, or spawn failure leaves a marker and retains the database.
    if [[ ! -d "$REVIEW_ROUTER_ITEM11_CHILD_PROOF_DIR" ]] ||
       (( ${#pending_children[@]} > 0 )); then
      echo "item11_child_cleanup_unproven_retained database=$item11_database" >&2
      result=1
    elif [[ "$(lookup_database)" != owned ]]; then
      echo "item11_database_ownership_unproven_retained database=$item11_database" >&2
      result=1
    elif ! dropdb "$item11_database"; then
      echo "item11_ci_cleanup_failed_retained database=$item11_database" >&2
      result=1
    fi
  elif [[ "$item11_create_attempted" == 1 ]]; then
    # A failed client may have committed CREATE. Reconcile the exact name and
    # owner, but absence of acknowledged CREATE never grants deletion authority.
    if state="$(lookup_database)"; then
      if [[ -n "$state" ]]; then
        echo "item11_create_outcome_uncertain_retained database=$item11_database ownership=$state" >&2
      else
        echo "item11_create_reconciled_absent database=$item11_database" >&2
      fi
    else
      echo "item11_create_reconciliation_failed database=$item11_database" >&2
    fi
    result=1
  fi
  rmdir "$REVIEW_ROUTER_ITEM11_CHILD_PROOF_DIR" 2>/dev/null || true
  exit "$result"
}
trap cleanup EXIT
# No reuse, even if a generated name unexpectedly already exists.
item11_existing="$(lookup_database)"
[[ -z "$item11_existing" ]] || { echo 'item11_database_already_exists' >&2; exit 1; }
item11_create_attempted=1
createdb "$item11_database"
item11_created=1
export REVIEW_ROUTER_ITEM11_DATABASE_URL
REVIEW_ROUTER_ITEM11_DATABASE_URL="$(node -e '
  const url = new URL(process.env.REVIEW_ROUTER_TEST_DATABASE_URL);
  url.username = process.env.PGUSER;
  url.password = process.env.PGPASSWORD;
  url.pathname = process.argv[1];
  url.search = "";
  process.stdout.write(url.href);
' "$item11_database")"
DATABASE_URL="$REVIEW_ROUTER_ITEM11_DATABASE_URL" pnpm --dir packages/platform/db db:migrate:deploy
psql -d "$item11_database" -v ON_ERROR_STOP=1 -v run_id="$REVIEW_ROUTER_ITEM11_RUN_ID" <<'SQL'
CREATE TABLE item11_fixture_owner (
  run_id text PRIMARY KEY CHECK (run_id ~ '^[a-f0-9]{32}$'),
  claim_token text
);
INSERT INTO item11_fixture_owner (run_id) VALUES (:'run_id');
SQL
export REVIEW_ROUTER_ITEM11_E2E=1
run_tests "$@"
