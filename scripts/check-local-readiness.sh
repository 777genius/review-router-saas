#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

info() {
  printf '%s\n' "$1"
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_cmd psql
require_cmd pg_isready
require_cmd node
require_cmd pnpm
require_cmd git

psql_url() {
  printf '%s' "$1" | sed -E 's/[?&]schema=[^&]*//'
}

if [[ "${REVIEW_ROUTER_SKIP_ENV_FILE:-0}" != "1" && -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
else
  info ".env.local is not loaded; using existing environment variables."
fi

[[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL is missing in environment or .env.local"
[[ -n "${TEST_DATABASE_URL:-}" ]] || fail "TEST_DATABASE_URL is missing in environment or .env.local"
[[ -n "${AUTH_SECRET:-}" ]] || fail "AUTH_SECRET is missing in environment or .env.local"
[[ -n "${GITHUB_WEBHOOK_SECRET:-}" ]] || fail "GITHUB_WEBHOOK_SECRET is missing in environment or .env.local"

info "Checking dev database..."
psql "$(psql_url "$DATABASE_URL")" -v ON_ERROR_STOP=1 -Atc "select current_database()" >/dev/null

info "Checking dev migration status..."
pnpm --filter @reviewrouter/platform-db db:migrate:status >/dev/null

info "Checking test database..."
psql "$(psql_url "$TEST_DATABASE_URL")" -v ON_ERROR_STOP=1 -Atc "select current_database()" >/dev/null

info "Checking test migration status..."
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @reviewrouter/platform-db db:migrate:status >/dev/null

if [[ -n "${GITHUB_APP_PRIVATE_KEY_FILE:-}" ]]; then
  [[ -f "$GITHUB_APP_PRIVATE_KEY_FILE" ]] || fail "GITHUB_APP_PRIVATE_KEY_FILE does not exist: $GITHUB_APP_PRIVATE_KEY_FILE"
  case "$GITHUB_APP_PRIVATE_KEY_FILE" in
    "$ROOT_DIR/.local-secrets/"*) ;;
    *) info "Warning: private key is outside .local-secrets. Ensure it is ignored by git." ;;
  esac
fi

info "Local readiness check passed."
