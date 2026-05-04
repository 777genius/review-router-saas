#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HOSTED_ENV_FILE="${REVIEW_ROUTER_HOSTED_ENV_FILE:-.env.production}"

info() {
  printf '\n==> %s\n' "$1"
}

info "hosted environment readiness"
REVIEW_ROUTER_HOSTED_ENV_FILE="$HOSTED_ENV_FILE" \
  node scripts/check-hosted-readiness.mjs

info "GitHub App hosted readiness"
REVIEW_ROUTER_GITHUB_APP_CHECK_MODE=hosted \
  REVIEW_ROUTER_GITHUB_APP_ENV_FILE="$HOSTED_ENV_FILE" \
  node scripts/check-github-app-readiness.mjs

info "production runtime smoke"
pnpm build
pnpm runtime:smoke

printf '\nReviewRouter public beta readiness checks passed.\n'
