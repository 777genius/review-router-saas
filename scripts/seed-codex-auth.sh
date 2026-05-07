#!/usr/bin/env bash
# Seed Codex ChatGPT OAuth auth into GitHub Actions secrets without sending it to ReviewRouter SaaS.
# Usage examples:
#   curl -fsSL https://reviewrouter.site/install/codex | REVIEW_ROUTER_CONFIRM_WRITE=1 REVIEW_ROUTER_REPO=owner/repo bash
#   REVIEW_ROUTER_CONFIRM_WRITE=1 REVIEW_ROUTER_SECRET_SCOPE=org REVIEW_ROUTER_ORG=my-org REVIEW_ROUTER_ORG_SECRET_REPOS=repo-a,repo-b bash scripts/seed-codex-auth.sh

set -Eeuo pipefail

PRODUCT_NAME="ReviewRouter"
TARGET_REPO="${REVIEW_ROUTER_REPO:-}"
SECRET_SCOPE="${REVIEW_ROUTER_SECRET_SCOPE:-repo}"
ORG_NAME="${REVIEW_ROUTER_ORG:-}"
ORG_SELECTED_REPOS="${REVIEW_ROUTER_ORG_SECRET_REPOS:-}"
INCLUDE_CODEX_CONFIG="${REVIEW_ROUTER_INCLUDE_CODEX_CONFIG:-0}"
DRY_RUN="${REVIEW_ROUTER_DRY_RUN:-0}"
CONFIRM_WRITE="${REVIEW_ROUTER_CONFIRM_WRITE:-${REVIEW_ROUTER_YES:-0}}"
CODEX_BASE_HOME="${REVIEW_ROUTER_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"
CODEX_AUTH_FILE="${REVIEW_ROUTER_CODEX_AUTH_FILE:-}"
CODEX_AUTH_FILE_EXPLICIT="${REVIEW_ROUTER_CODEX_AUTH_FILE:+1}"
CODEX_CONFIG_FILE="${REVIEW_ROUTER_CODEX_CONFIG_FILE:-$CODEX_BASE_HOME/config.toml}"
CODEX_AUTH_STALE_DAYS="${REVIEW_ROUTER_CODEX_AUTH_STALE_DAYS:-30}"

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

usage() {
  cat <<'EOF'
ReviewRouter Codex OAuth secret seeding

Usage:
  bash scripts/seed-codex-auth.sh [options]

Options:
  --dry-run                 Print gh secret commands without writing secrets.
  --yes, --confirm-write    Allow non-interactive secret writes after verifying the target.
  --repo owner/repo         Target repository for repo-scoped secrets.
  --scope repo|org          Secret scope. Defaults to repo.
  --org org                 Organization for org selected-repository secrets.
  --repos repo-a,repo-b     Selected repositories for org-scoped secrets.
  --include-config          Also write CODEX_CONFIG_TOML.
  --codex-home path         Codex home containing auth.json or accounts/registry.json.
  --auth-file path          Explicit Codex auth JSON path.
  --config-file path        Explicit Codex config.toml path.
  --stale-days days         Warn when auth.json last_refresh is older than this. Defaults to 30.
  -h, --help                Show this help.

Environment variables with the same REVIEW_ROUTER_* names are still supported.
EOF
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|y|Y) return 0 ;;
    *) return 1 ;;
  esac
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fatal "Missing required command: $1"
}

require_arg() {
  option="$1"
  value="${2:-}"
  [ -n "$value" ] || fatal "$option requires a value"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run)
        DRY_RUN="1"
        ;;
      --yes|--confirm-write)
        CONFIRM_WRITE="1"
        ;;
      --repo)
        shift
        require_arg "--repo" "${1:-}"
        TARGET_REPO="$1"
        ;;
      --scope)
        shift
        require_arg "--scope" "${1:-}"
        SECRET_SCOPE="$1"
        ;;
      --org)
        shift
        require_arg "--org" "${1:-}"
        ORG_NAME="$1"
        ;;
      --repos|--selected-repos)
        shift
        require_arg "--repos" "${1:-}"
        ORG_SELECTED_REPOS="$1"
        ;;
      --include-config)
        INCLUDE_CODEX_CONFIG="1"
        ;;
      --codex-home)
        shift
        require_arg "--codex-home" "${1:-}"
        CODEX_BASE_HOME="$1"
        if [ "${CODEX_AUTH_FILE_EXPLICIT:-0}" != "1" ]; then
          CODEX_AUTH_FILE=""
        fi
        CODEX_CONFIG_FILE="$CODEX_BASE_HOME/config.toml"
        ;;
      --auth-file)
        shift
        require_arg "--auth-file" "${1:-}"
        CODEX_AUTH_FILE="$1"
        CODEX_AUTH_FILE_EXPLICIT="1"
        ;;
      --config-file)
        shift
        require_arg "--config-file" "${1:-}"
        CODEX_CONFIG_FILE="$1"
        ;;
      --stale-days)
        shift
        require_arg "--stale-days" "${1:-}"
        CODEX_AUTH_STALE_DAYS="$1"
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      --)
        shift
        break
        ;;
      *)
        fatal "Unknown option: $1"
        ;;
    esac
    shift
  done
}

confirm_secret_write() {
  if is_true "$DRY_RUN" || is_true "$CONFIRM_WRITE"; then
    return
  fi

  warn "This will create or overwrite GitHub Actions secrets for the target below."
  warn "ReviewRouter SaaS will not receive the secret value; gh writes it directly to GitHub."

  if [ ! -t 0 ]; then
    fatal "Refusing to write secrets in non-interactive mode without confirmation. Set REVIEW_ROUTER_CONFIRM_WRITE=1 after verifying the target."
  fi

  printf 'Type "write secrets" to continue: ' >&2
  read -r answer
  if [ "$answer" != "write secrets" ]; then
    fatal "Secret write cancelled."
  fi
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

resolve_codex_auth_file() {
  if [ -n "$CODEX_AUTH_FILE" ]; then
    return
  fi

  legacy_auth_file="$CODEX_BASE_HOME/auth.json"
  if [ -f "$legacy_auth_file" ]; then
    CODEX_AUTH_FILE="$legacy_auth_file"
    return
  fi

  active_auth_file=""
  if command -v node >/dev/null 2>&1; then
    active_auth_file="$(
      node - "$CODEX_BASE_HOME" <<'NODE' 2>/dev/null || true
const fs = require('node:fs');
const path = require('node:path');

const codexHome = process.argv[2];
const accountsDir = path.join(codexHome, 'accounts');
const registryPath = path.join(accountsDir, 'registry.json');

function authPathForAccountKey(accountKey) {
  const encoded = Buffer.from(accountKey, 'utf8').toString('base64url');
  return path.join(accountsDir, `${encoded}.auth.json`);
}

try {
  if (fs.existsSync(registryPath)) {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const activeAccountKey = registry.active_account_key;
    if (typeof activeAccountKey === 'string' && activeAccountKey.length > 0) {
      const activeAuthPath = authPathForAccountKey(activeAccountKey);
      if (fs.existsSync(activeAuthPath)) {
        console.log(activeAuthPath);
        process.exit(0);
      }
    }
  }

  if (fs.existsSync(accountsDir)) {
    const candidates = fs
      .readdirSync(accountsDir)
      .filter((entry) => entry.endsWith('.auth.json'))
      .map((entry) => path.join(accountsDir, entry));
    if (candidates.length === 1) {
      console.log(candidates[0]);
    }
  }
} catch {
  process.exit(0);
}
NODE
    )"
  elif command -v python3 >/dev/null 2>&1; then
    active_auth_file="$(
      python3 - "$CODEX_BASE_HOME" <<'PY' 2>/dev/null || true
import base64
import json
import os
import sys

codex_home = sys.argv[1]
accounts_dir = os.path.join(codex_home, 'accounts')
registry_path = os.path.join(accounts_dir, 'registry.json')

def auth_path_for_account_key(account_key):
    encoded = base64.urlsafe_b64encode(account_key.encode('utf-8')).decode('ascii').rstrip('=')
    return os.path.join(accounts_dir, f'{encoded}.auth.json')

try:
    if os.path.exists(registry_path):
        with open(registry_path, 'r', encoding='utf-8') as f:
            registry = json.load(f)
        active_account_key = registry.get('active_account_key')
        if isinstance(active_account_key, str) and active_account_key:
            active_auth_path = auth_path_for_account_key(active_account_key)
            if os.path.exists(active_auth_path):
                print(active_auth_path)
                raise SystemExit(0)

    if os.path.isdir(accounts_dir):
        candidates = [
            os.path.join(accounts_dir, entry)
            for entry in os.listdir(accounts_dir)
            if entry.endswith('.auth.json')
        ]
        if len(candidates) == 1:
            print(candidates[0])
except Exception:
    pass
PY
    )"
  fi

  if [ -n "$active_auth_file" ]; then
    CODEX_AUTH_FILE="$active_auth_file"
  else
    CODEX_AUTH_FILE="$legacy_auth_file"
  fi
}

validate_codex_auth_file() {
  [ -f "$CODEX_AUTH_FILE" ] || fatal "Codex auth file not found: $CODEX_AUTH_FILE. To reseed auth.json, run: codex login"
  [ -r "$CODEX_AUTH_FILE" ] || fatal "Codex auth file is not readable: $CODEX_AUTH_FILE. To reseed auth.json, run: codex login"

  if command -v node >/dev/null 2>&1; then
    node - "$CODEX_AUTH_FILE" "$CODEX_AUTH_STALE_DAYS" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const staleDays = Number(process.argv[3] || '30');
const staleDaysLabel = staleDays === 1 ? '1 day' : `${staleDays} days`;
function fail(message) {
  console.error(message);
  process.exit(1);
}
function warn(message) {
  console.error(`WARN ${message}`);
}
let data;
try {
  data = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch (error) {
  fail(`auth.json is not valid JSON: ${error.message}. To reseed auth.json, run codex login and rerun this command.`);
}
if (data.auth_mode !== 'chatgpt') fail('auth.json auth_mode must be chatgpt. To reseed auth.json, run codex login and rerun this command.');
if (!data.tokens || !data.tokens.refresh_token) fail('auth.json tokens.refresh_token is missing. To reseed auth.json, run codex login and rerun this command.');
if (!Number.isFinite(staleDays) || staleDays <= 0) fail('stale-days must be a positive number');
if (!data.last_refresh) {
  warn('auth.json last_refresh is missing. If CI later reports Codex auth errors, run codex login and reseed auth.json.');
} else {
  const refreshedAt = Date.parse(data.last_refresh);
  if (!Number.isFinite(refreshedAt)) {
    warn('auth.json last_refresh is not parseable. If CI later reports Codex auth errors, run codex login and reseed auth.json.');
  } else {
    const ageDays = (Date.now() - refreshedAt) / 86_400_000;
    if (ageDays > staleDays) {
      warn(`auth.json last_refresh is older than ${staleDaysLabel}. Re-run codex login and reseed auth.json if CI reports Codex auth failures.`);
    }
  }
}
NODE
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$CODEX_AUTH_FILE" "$CODEX_AUTH_STALE_DAYS" <<'PY'
from datetime import datetime, timezone
import json
import sys
path = sys.argv[1]
stale_days = float(sys.argv[2] or '30')
stale_days_label = '1 day' if stale_days == 1 else f'{stale_days:g} days'
def warn(message):
    print(f'WARN {message}', file=sys.stderr)
try:
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
except json.JSONDecodeError as exc:
    raise SystemExit(f'auth.json is not valid JSON: {exc}. To reseed auth.json, run codex login and rerun this command.')
if data.get('auth_mode') != 'chatgpt':
    raise SystemExit('auth.json auth_mode must be chatgpt. To reseed auth.json, run codex login and rerun this command.')
if not ((data.get('tokens') or {}).get('refresh_token')):
    raise SystemExit('auth.json tokens.refresh_token is missing. To reseed auth.json, run codex login and rerun this command.')
if stale_days <= 0:
    raise SystemExit('stale-days must be a positive number')
last_refresh = data.get('last_refresh')
if not last_refresh:
    warn('auth.json last_refresh is missing. If CI later reports Codex auth errors, run codex login and reseed auth.json.')
else:
    try:
        refreshed_at = datetime.fromisoformat(last_refresh.replace('Z', '+00:00'))
        age_days = (datetime.now(timezone.utc) - refreshed_at).total_seconds() / 86400
        if age_days > stale_days:
            warn(f'auth.json last_refresh is older than {stale_days_label}. Re-run codex login and reseed auth.json if CI reports Codex auth failures.')
    except ValueError:
        warn('auth.json last_refresh is not parseable. If CI later reports Codex auth errors, run codex login and reseed auth.json.')
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
  parse_args "$@"
  log "${PRODUCT_NAME} Codex OAuth secret seeding"
  require_cmd gh
  normalize_secret_scope
  detect_repo
  if [ "$SECRET_SCOPE" = "org" ]; then
    normalize_org_repos
  fi

  gh auth status >/dev/null 2>&1 || fatal "gh is not authenticated. Run: gh auth login"
  resolve_codex_auth_file
  validate_codex_auth_file
  ok "Validated Codex auth JSON before writing secrets"

  info "Target repo: $TARGET_REPO"
  if [ "$SECRET_SCOPE" = "org" ]; then
    info "Secret scope: org $ORG_NAME, selected repos: $ORG_SELECTED_REPOS"
  else
    info "Secret scope: repo $TARGET_REPO"
  fi
  info "Codex auth file: $CODEX_AUTH_FILE"
  confirm_secret_write

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
