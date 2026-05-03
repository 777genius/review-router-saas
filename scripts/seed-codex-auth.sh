#!/usr/bin/env bash
# Seed Codex ChatGPT OAuth auth into GitHub Actions secrets without sending it to ReviewRouter SaaS.
# Usage examples:
#   curl -fsSL https://app.reviewrouter.dev/install/codex | REVIEW_ROUTER_REPO=owner/repo bash
#   REVIEW_ROUTER_SECRET_SCOPE=org REVIEW_ROUTER_ORG=my-org REVIEW_ROUTER_ORG_SECRET_REPOS=repo-a,repo-b bash scripts/seed-codex-auth.sh

set -Eeuo pipefail

PRODUCT_NAME="ReviewRouter"
TARGET_REPO="${REVIEW_ROUTER_REPO:-}"
SECRET_SCOPE="${REVIEW_ROUTER_SECRET_SCOPE:-repo}"
ORG_NAME="${REVIEW_ROUTER_ORG:-}"
ORG_SELECTED_REPOS="${REVIEW_ROUTER_ORG_SECRET_REPOS:-}"
INCLUDE_CODEX_CONFIG="${REVIEW_ROUTER_INCLUDE_CODEX_CONFIG:-0}"
DRY_RUN="${REVIEW_ROUTER_DRY_RUN:-0}"
CODEX_BASE_HOME="${REVIEW_ROUTER_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"
CODEX_AUTH_FILE="${REVIEW_ROUTER_CODEX_AUTH_FILE:-$CODEX_BASE_HOME/auth.json}"
CODEX_CONFIG_FILE="${REVIEW_ROUTER_CODEX_CONFIG_FILE:-$CODEX_BASE_HOME/config.toml}"

if [ -t 1 ]; then
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  RED='\033[0;31m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  GREEN=''
  YELLOW=''
  RED=''
  BLUE=''
  NC=''
fi

log() { printf '%b\n' "$*"; }
info() { log "${BLUE}==>${NC} $*"; }
ok() { log "${GREEN}OK${NC} $*"; }
warn() { log "${YELLOW}WARN${NC} $*"; }
fatal() { log "${RED}ERROR${NC} $*" >&2; exit 1; }

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|y|Y) return 0 ;;
    *) return 1 ;;
  esac
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fatal "Missing required command: $1"
}

normalize_remote_repo() {
  remote="$1"
  remote="${remote#git@github.com:}"
  remote="${remote#https://github.com/}"
  remote="${remote#http://github.com/}"
  remote="${remote%.git}"
  case "$remote" in
    */*) printf '%s' "$remote" ;;
    *) return 1 ;;
  esac
}

validate_repo() {
  case "$1" in
    */*) ;;
    *) fatal "Repository must be owner/repo. Got: $1" ;;
  esac
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || fatal "Invalid repository name: $1"
}

repo_owner() { printf '%s' "$1" | cut -d/ -f1; }
repo_name() { printf '%s' "$1" | cut -d/ -f2-; }

normalize_secret_scope() {
  case "$SECRET_SCOPE" in
    repo|repository) SECRET_SCOPE="repo" ;;
    org|organization|org-selected|org_selected) SECRET_SCOPE="org" ;;
    *) fatal "REVIEW_ROUTER_SECRET_SCOPE must be repo or org. Got: $SECRET_SCOPE" ;;
  esac
}

detect_repo() {
  if [ -n "$TARGET_REPO" ]; then
    validate_repo "$TARGET_REPO"
    return
  fi

  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    remote_url="$(git config --get remote.origin.url || true)"
    if [ -n "$remote_url" ] && detected="$(normalize_remote_repo "$remote_url")"; then
      TARGET_REPO="$detected"
      validate_repo "$TARGET_REPO"
      return
    fi
  fi

  if command -v gh >/dev/null 2>&1; then
    detected="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
    if [ -n "$detected" ]; then
      TARGET_REPO="$detected"
      validate_repo "$TARGET_REPO"
      return
    fi
  fi

  fatal "Could not detect repository. Set REVIEW_ROUTER_REPO=owner/repo."
}

normalize_org_repos() {
  if [ -z "$ORG_NAME" ]; then
    if [ -n "$TARGET_REPO" ]; then
      ORG_NAME="$(repo_owner "$TARGET_REPO")"
    else
      fatal "Set REVIEW_ROUTER_ORG for org-level secrets."
    fi
  fi

  if [ -z "$ORG_SELECTED_REPOS" ]; then
    if [ -n "$TARGET_REPO" ] && [ "$(repo_owner "$TARGET_REPO")" = "$ORG_NAME" ]; then
      ORG_SELECTED_REPOS="$(repo_name "$TARGET_REPO")"
    else
      fatal "Set REVIEW_ROUTER_ORG_SECRET_REPOS=repo-a,repo-b for org-level selected repositories."
    fi
  fi

  normalized=""
  old_ifs="$IFS"
  IFS=','
  for item in $ORG_SELECTED_REPOS; do
    repo="$(printf '%s' "$item" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "$repo" ] || continue
    case "$repo" in
      */*)
        owner_part="${repo%%/*}"
        repo_part="${repo#*/}"
        if [ "$owner_part" != "$ORG_NAME" ]; then
          IFS="$old_ifs"
          fatal "Selected repo $repo must belong to org $ORG_NAME."
        fi
        repo="$repo_part"
        ;;
    esac
    printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9_.-]+$' || {
      IFS="$old_ifs"
      fatal "Invalid selected repository name: $repo"
    }
    if [ -n "$normalized" ]; then
      normalized="$normalized,$repo"
    else
      normalized="$repo"
    fi
  done
  IFS="$old_ifs"

  [ -n "$normalized" ] || fatal "At least one selected repository is required for org-level secrets."
  ORG_SELECTED_REPOS="$normalized"
}

validate_codex_auth_file() {
  [ -f "$CODEX_AUTH_FILE" ] || fatal "Codex auth file not found: $CODEX_AUTH_FILE. Run: codex login"
  [ -r "$CODEX_AUTH_FILE" ] || fatal "Codex auth file is not readable: $CODEX_AUTH_FILE"

  if command -v node >/dev/null 2>&1; then
    node - "$CODEX_AUTH_FILE" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
function fail(message) {
  console.error(message);
  process.exit(1);
}
let data;
try {
  data = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch (error) {
  fail(`auth.json is not valid JSON: ${error.message}`);
}
if (data.auth_mode !== 'chatgpt') fail('auth.json auth_mode must be chatgpt');
if (!data.tokens || !data.tokens.refresh_token) fail('auth.json tokens.refresh_token is missing');
NODE
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$CODEX_AUTH_FILE" <<'PY'
import json
import sys
path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
    data = json.load(f)
if data.get('auth_mode') != 'chatgpt':
    raise SystemExit('auth.json auth_mode must be chatgpt')
if not ((data.get('tokens') or {}).get('refresh_token')):
    raise SystemExit('auth.json tokens.refresh_token is missing')
PY
  else
    fatal "Need node or python3 to validate auth.json safely."
  fi
}

store_secret_from_file() {
  name="$1"
  file_path="$2"
  [ -f "$file_path" ] || fatal "Secret file not found for $name: $file_path"

  if is_true "$DRY_RUN"; then
    if [ "$SECRET_SCOPE" = "org" ]; then
      log "[dry-run] gh secret set $name --org $ORG_NAME --repos $ORG_SELECTED_REPOS --app actions < $file_path"
    else
      log "[dry-run] gh secret set $name --repo $TARGET_REPO < $file_path"
    fi
    return
  fi

  if [ "$SECRET_SCOPE" = "org" ]; then
    gh secret set "$name" --org "$ORG_NAME" --repos "$ORG_SELECTED_REPOS" --app actions < "$file_path" >/dev/null
    ok "Stored org selected-repo secret $name for $ORG_NAME repos: $ORG_SELECTED_REPOS"
  else
    gh secret set "$name" --repo "$TARGET_REPO" < "$file_path" >/dev/null
    ok "Stored repo secret $name for $TARGET_REPO"
  fi
}

main() {
  log "${PRODUCT_NAME} Codex OAuth secret seeding"
  require_cmd gh
  normalize_secret_scope
  detect_repo
  if [ "$SECRET_SCOPE" = "org" ]; then
    normalize_org_repos
  fi

  gh auth status >/dev/null 2>&1 || fatal "gh is not authenticated. Run: gh auth login"
  validate_codex_auth_file

  info "Target repo: $TARGET_REPO"
  if [ "$SECRET_SCOPE" = "org" ]; then
    info "Secret scope: org $ORG_NAME, selected repos: $ORG_SELECTED_REPOS"
  else
    info "Secret scope: repo $TARGET_REPO"
  fi
  info "Codex auth file: $CODEX_AUTH_FILE"

  store_secret_from_file CODEX_AUTH_JSON "$CODEX_AUTH_FILE"

  if is_true "$INCLUDE_CODEX_CONFIG"; then
    [ -f "$CODEX_CONFIG_FILE" ] || fatal "Codex config file not found: $CODEX_CONFIG_FILE"
    warn "Including CODEX_CONFIG_TOML can carry local config into CI. Only do this if you intentionally need it."
    store_secret_from_file CODEX_CONFIG_TOML "$CODEX_CONFIG_FILE"
  else
    warn "Skipped CODEX_CONFIG_TOML by default. Set REVIEW_ROUTER_INCLUDE_CODEX_CONFIG=1 only if needed."
  fi

  ok "Codex OAuth secret seeding complete"
}

main "$@"
