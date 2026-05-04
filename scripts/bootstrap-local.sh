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

require_cmd node
require_cmd pnpm
require_cmd psql

if [[ ! -f .env.local ]]; then
  if [[ ! -f .env.example ]]; then
    fail ".env.example is missing"
  fi
  cp .env.example .env.local
  chmod 600 .env.local
  info "Created .env.local from .env.example. Fill GitHub App values before full local readiness."
fi

if ! grep -q '^AUTH_SECRET="replace-with-local-random-secret"' .env.local; then
  :
elif command -v openssl >/dev/null 2>&1; then
  secret="$(openssl rand -hex 32)"
  tmp_file="$(mktemp)"
  sed "s/^AUTH_SECRET=.*/AUTH_SECRET=\"${secret}\"/" .env.local > "$tmp_file"
  mv "$tmp_file" .env.local
  chmod 600 .env.local
  info "Generated local AUTH_SECRET in .env.local."
fi

info "Installing dependencies..."
pnpm install --frozen-lockfile

info "Ensuring local databases exist..."
node scripts/ensure-local-databases.mjs

info "Generating Prisma client..."
pnpm db:generate

info "Applying migrations to dev database..."
pnpm db:migrate:deploy

info "Applying migrations to test database..."
set -a
# shellcheck disable=SC1091
. ./.env.local
set +a
DATABASE_URL="$TEST_DATABASE_URL" pnpm --dir packages/platform/db db:migrate:deploy

if pnpm local:check; then
  info "Local bootstrap completed and readiness passed."
else
  info "Local databases and dependencies are ready, but full readiness still needs GitHub App credentials in .env.local."
  info "Follow ai-docs/LOCAL_SETUP_CHECKLIST.md, then rerun: pnpm local:check"
fi
