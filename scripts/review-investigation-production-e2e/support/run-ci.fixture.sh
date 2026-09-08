#!/usr/bin/env bash
# Only the CI PostgreSQL service. Keep the shared test database and legacy tests
# unchanged; assign a freshly CREATED database to the process-restart scenario.
set -euo pipefail
pnpm exec tsc --noEmit -p scripts/review-investigation-production-e2e/tsconfig.json
node --test scripts/review-investigation-production-e2e/support/*.test.mjs
run_tests() {
  REVIEW_ROUTER_REVIEW_INVESTIGATION_E2E=1 pnpm exec vitest run scripts/review-investigation-production-e2e/review-investigation-production.e2e.test.ts "$@"
}
# Local callers retain their configured database and optional Vitest arguments.
if [[ "${CI:-}" != true ]]; then
  run_tests "$@"
  exit $?
fi
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres
# Reuse the configured CI service credential without another stored literal.
export PGPASSWORD
PGPASSWORD="$(node -e '
  try {
    process.stdout.write(decodeURIComponent(new URL(process.env.REVIEW_ROUTER_TEST_DATABASE_URL).password));
  } catch { process.exit(1); }
')"
export REVIEW_ROUTER_ITEM11_RUN_ID
REVIEW_ROUTER_ITEM11_RUN_ID="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
[[ "$REVIEW_ROUTER_ITEM11_RUN_ID" =~ ^[a-f0-9]{32}$ ]]
item11_database="item11_test_${REVIEW_ROUTER_ITEM11_RUN_ID}"
item11_created=0
cleanup() {
  local result=$?
  trap - EXIT
  if [[ "$item11_created" == 1 ]]; then
    # Successful CREATE (without IF NOT EXISTS) is this wrapper's ownership
    # evidence, including when migration/marker setup fails partway through.
    if ! dropdb --force "$item11_database"; then
      echo 'item11_ci_cleanup_failed' >&2
      result=1
    fi
  fi
  exit "$result"
}
trap cleanup EXIT
createdb "$item11_database"
item11_created=1
export REVIEW_ROUTER_ITEM11_DATABASE_URL
REVIEW_ROUTER_ITEM11_DATABASE_URL="$(node -e '
  const url = new URL("postgresql://127.0.0.1:5432/");
  url.username = process.env.PGUSER;
  url.password = process.env.PGPASSWORD;
  url.pathname = process.argv[1];
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
run_tests "$@"
