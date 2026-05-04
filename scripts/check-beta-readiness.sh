#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${ROOT_DIR}"

run_step() {
  local title="$1"
  shift

  printf '\n==> %s\n' "${title}"
  "$@"
}

run_pnpm() {
  pnpm "$@"
}

run_with_env() {
  node scripts/run-with-env.mjs pnpm "$@"
}

run_step "local readiness" run_pnpm local:check
run_step "unit and integration tests" run_pnpm test
run_step "architecture boundaries" run_pnpm architecture:check
run_step "typecheck" run_pnpm typecheck
run_step "lint" run_pnpm lint
run_step "format check" run_pnpm format:check
run_step "production build" run_pnpm build
run_step "compiled runtime smoke" run_pnpm runtime:smoke
run_step "web page smoke" run_pnpm web:smoke
run_step "whitespace check" git diff --check
run_step "Codex secret seeding shell syntax" bash -n scripts/seed-codex-auth.sh
run_step "local bootstrap shell syntax" bash -n scripts/bootstrap-local.sh
run_step "public beta readiness shell syntax" bash -n scripts/check-public-beta-readiness.sh
run_step "GitHub App readiness script syntax" node --check scripts/check-github-app-readiness.mjs
run_step "GitHub App manifest smoke" run_pnpm github-app:manifest:smoke
run_step "hosted readiness smoke" run_pnpm hosted:check:smoke
run_step "public beta readiness smoke" run_pnpm public-beta:check:smoke

if [[ "${REVIEW_ROUTER_BETA_CHECK_DB_E2E:-0}" == "1" ]]; then
  run_step "migration smoke" run_pnpm db:migrate:smoke
  run_step "backup restore smoke" run_pnpm db:restore:smoke
  run_step "webhook lifecycle DB E2E" run_with_env spike:webhook-lifecycle:e2e
  run_step "outbox maintenance DB E2E" run_with_env spike:outbox-maintenance:e2e
  run_step "rate limit DB E2E" run_with_env spike:rate-limit:e2e
  run_step "distributed lock DB E2E" run_with_env spike:distributed-lock:e2e
  run_step "review config DB E2E" run_with_env spike:review-config:e2e
  run_step "action control plane DB E2E" run_with_env spike:action:e2e
  run_step "support diagnostics DB E2E" run_with_env spike:support-diagnostics:e2e
fi

case "${REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB:-none}" in
  none | 0 | false)
    ;;
  setup)
    run_step "fresh repository GitHub setup E2E" run_with_env spike:github:fresh-repo:e2e
    ;;
  review)
    run_step "fresh repository GitHub full review E2E" env REVIEW_ROUTER_FRESH_E2E_MODE=review node scripts/run-with-env.mjs pnpm spike:github:fresh-repo:e2e
    ;;
  *)
    printf 'REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB must be none, setup, or review\n' >&2
    exit 2
    ;;
esac

printf '\nReviewRouter beta readiness checks passed.\n'
