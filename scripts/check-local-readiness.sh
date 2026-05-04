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

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "${name} is missing in environment or .env.local"
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

require_env DATABASE_URL
require_env TEST_DATABASE_URL
require_env AUTH_SECRET
require_env GITHUB_APP_CLIENT_ID
require_env GITHUB_APP_CLIENT_SECRET
require_env GITHUB_APP_ID
require_env GITHUB_APP_SLUG
require_env GITHUB_WEBHOOK_SECRET

[[ "${#AUTH_SECRET}" -ge 16 ]] || fail "AUTH_SECRET must be at least 16 characters"
[[ "$GITHUB_APP_ID" =~ ^[0-9]+$ ]] || fail "GITHUB_APP_ID must be numeric"

if [[ "${REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING:-0}" != "1" ]]; then
  fail "REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING=1 is required for local/private beta setup PR testing"
fi

info "Checking dev database..."
psql "$(psql_url "$DATABASE_URL")" -v ON_ERROR_STOP=1 -Atc "select current_database()" >/dev/null

info "Checking dev migration status..."
pnpm --filter @reviewrouter/platform-db db:migrate:status >/dev/null

info "Checking test database..."
psql "$(psql_url "$TEST_DATABASE_URL")" -v ON_ERROR_STOP=1 -Atc "select current_database()" >/dev/null

info "Checking test migration status..."
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @reviewrouter/platform-db db:migrate:status >/dev/null

if [[ -n "${GITHUB_APP_PRIVATE_KEY:-}" ]]; then
  printf '%b' "$GITHUB_APP_PRIVATE_KEY" | grep -q "BEGIN .*PRIVATE KEY" || fail "GITHUB_APP_PRIVATE_KEY does not look like a PEM private key"
elif [[ -n "${GITHUB_APP_PRIVATE_KEY_FILE:-}" ]]; then
  [[ -f "$GITHUB_APP_PRIVATE_KEY_FILE" ]] || fail "GITHUB_APP_PRIVATE_KEY_FILE does not exist: $GITHUB_APP_PRIVATE_KEY_FILE"
  [[ -r "$GITHUB_APP_PRIVATE_KEY_FILE" ]] || fail "GITHUB_APP_PRIVATE_KEY_FILE is not readable: $GITHUB_APP_PRIVATE_KEY_FILE"
  grep -q "BEGIN .*PRIVATE KEY" "$GITHUB_APP_PRIVATE_KEY_FILE" || fail "GITHUB_APP_PRIVATE_KEY_FILE does not look like a PEM private key"
else
  fail "GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE is required"
fi

if [[ -n "${GITHUB_APP_PRIVATE_KEY_FILE:-}" ]]; then
  case "$GITHUB_APP_PRIVATE_KEY_FILE" in
    "$ROOT_DIR/.local-secrets/"*) ;;
    *) info "Warning: private key is outside .local-secrets. Ensure it is ignored by git." ;;
  esac
fi

info "Local readiness check passed."
