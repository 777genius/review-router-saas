#!/usr/bin/env bash
# Seed Codex ChatGPT OAuth auth into GitLab CI/CD variables without sending it to ReviewRouter SaaS.

set -Eeuo pipefail

PRODUCT_NAME="ReviewRouter"
SECRET_NAME="CODEX_AUTH_JSON"
GITLAB_URL="${REVIEW_ROUTER_GITLAB_URL:-https://gitlab.com}"
GITLAB_TOKEN="${GITLAB_TOKEN:-${GITLAB_ACCESS_TOKEN:-${PRIVATE_TOKEN:-}}}"
SECRET_SCOPE="${REVIEW_ROUTER_GITLAB_SECRET_SCOPE:-group}"
GROUP_TARGET="${REVIEW_ROUTER_GITLAB_GROUP:-}"
PROJECT_IDS="${REVIEW_ROUTER_GITLAB_PROJECT_IDS:-}"
DRY_RUN="${REVIEW_ROUTER_DRY_RUN:-0}"
CONFIRM_WRITE="${REVIEW_ROUTER_CONFIRM_WRITE:-${REVIEW_ROUTER_YES:-0}}"
CODEX_BASE_HOME="${REVIEW_ROUTER_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"
CODEX_AUTH_FILE="${REVIEW_ROUTER_CODEX_AUTH_FILE:-}"
CODEX_AUTH_FILE_EXPLICIT="${REVIEW_ROUTER_CODEX_AUTH_FILE:+1}"
CODEX_AUTH_STALE_DAYS="${REVIEW_ROUTER_CODEX_AUTH_STALE_DAYS:-30}"
CURL_CONFIG=""

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

cleanup() {
  if [ -n "$CURL_CONFIG" ] && [ -f "$CURL_CONFIG" ]; then
    rm -f "$CURL_CONFIG"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
ReviewRouter GitLab Codex OAuth secret seeding

Usage:
  export GITLAB_TOKEN="glpat-..."
  curl -fsSL https://reviewrouter.site/install/codex-gitlab | bash -s -- --confirm-write --scope group --group my-group

Options:
  --dry-run                 Validate and print target writes without calling GitLab.
  --yes, --confirm-write    Allow non-interactive GitLab variable writes.
  --gitlab-url url          GitLab base URL. Defaults to https://gitlab.com.
  --scope group|project     Variable target scope. Defaults to group.
  --group path-or-id        Group path or numeric ID for group-scoped variables.
  --project-id id           Project ID for project-scoped variables. Repeatable.
  --project-ids ids         Comma-separated project IDs for project-scoped variables.
  --codex-home path         Codex home containing auth.json or accounts/registry.json.
  --auth-file path          Explicit Codex auth JSON path.
  --stale-days days         Warn when auth.json last_refresh is older than this. Defaults to 30.
  -h, --help                Show this help.

The script writes CODEX_AUTH_JSON directly to GitLab CI/CD variables through
the GitLab API. ReviewRouter SaaS never receives plaintext auth.json.
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

append_project_id() {
  value="$1"
  [ -n "$value" ] || return
  if [ -z "$PROJECT_IDS" ]; then
    PROJECT_IDS="$value"
  else
    PROJECT_IDS="$PROJECT_IDS,$value"
  fi
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
      --gitlab-url)
        shift
        require_arg "--gitlab-url" "${1:-}"
        GITLAB_URL="$1"
        ;;
      --scope)
        shift
        require_arg "--scope" "${1:-}"
        SECRET_SCOPE="$1"
        ;;
      --group)
        shift
        require_arg "--group" "${1:-}"
        GROUP_TARGET="$1"
        ;;
      --project-id)
        shift
        require_arg "--project-id" "${1:-}"
        append_project_id "$1"
        ;;
      --project-ids)
        shift
        require_arg "--project-ids" "${1:-}"
        append_project_id "$1"
        ;;
      --codex-home)
        shift
        require_arg "--codex-home" "${1:-}"
        CODEX_BASE_HOME="$1"
        if [ "${CODEX_AUTH_FILE_EXPLICIT:-0}" != "1" ]; then
          CODEX_AUTH_FILE=""
        fi
        ;;
      --auth-file)
        shift
        require_arg "--auth-file" "${1:-}"
        CODEX_AUTH_FILE="$1"
        CODEX_AUTH_FILE_EXPLICIT="1"
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

normalize_gitlab_url() {
  GITLAB_URL="$(printf '%s' "$GITLAB_URL" | sed 's#/*$##')"
  case "$GITLAB_URL" in
    https://*|http://localhost:*|http://127.0.0.1:*|http://*.localhost:*) ;;
    *) fatal "--gitlab-url must be HTTPS or localhost HTTP. Got: $GITLAB_URL" ;;
  esac
  GITLAB_API_URL="$GITLAB_URL/api/v4"
}

normalize_secret_scope() {
  case "$SECRET_SCOPE" in
    group|groups) SECRET_SCOPE="group" ;;
    project|projects|repo|repository) SECRET_SCOPE="project" ;;
    *) fatal "--scope must be group or project. Got: $SECRET_SCOPE" ;;
  esac

  if [ "$SECRET_SCOPE" = "group" ]; then
    [ -n "$GROUP_TARGET" ] || fatal "--group is required for group scope"
    return
  fi

  PROJECT_IDS="$(normalize_project_ids "$PROJECT_IDS")"
  [ -n "$PROJECT_IDS" ] || fatal "--project-id or --project-ids is required for project scope"
}

normalize_project_ids() {
  raw="$1"
  normalized=""
  old_ifs="$IFS"
  IFS=','
  for item in $raw; do
    project_id="$(printf '%s' "$item" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "$project_id" ] || continue
    printf '%s' "$project_id" | grep -Eq '^[1-9][0-9]*$' || fatal "Invalid GitLab project ID: $project_id"
    case ",$normalized," in
      *,"$project_id",*) ;;
      *)
        if [ -z "$normalized" ]; then
          normalized="$project_id"
        else
          normalized="$normalized,$project_id"
        fi
        ;;
    esac
  done
  IFS="$old_ifs"
  printf '%s' "$normalized"
}

urlencode() {
  value="$1"
  if command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$value"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""), end="")' "$value"
  else
    fatal "Need node or python3 to URL-encode GitLab paths."
  fi
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
  return path.join(accountsDir, `${Buffer.from(accountKey, 'utf8').toString('base64url')}.auth.json`);
}
try {
  if (fs.existsSync(registryPath)) {
    const active = JSON.parse(fs.readFileSync(registryPath, 'utf8')).active_account_key;
    if (typeof active === 'string' && active) {
      const activePath = authPathForAccountKey(active);
      if (fs.existsSync(activePath)) {
        console.log(activePath);
        process.exit(0);
      }
    }
  }
  if (fs.existsSync(accountsDir)) {
    const candidates = fs.readdirSync(accountsDir)
      .filter((entry) => entry.endsWith('.auth.json'))
      .map((entry) => path.join(accountsDir, entry));
    if (candidates.length === 1) console.log(candidates[0]);
  }
} catch {}
NODE
    )"
  elif command -v python3 >/dev/null 2>&1; then
    active_auth_file="$(
      python3 - "$CODEX_BASE_HOME" <<'PY' 2>/dev/null || true
import base64, json, os, sys
codex_home = sys.argv[1]
accounts_dir = os.path.join(codex_home, 'accounts')
registry_path = os.path.join(accounts_dir, 'registry.json')
def auth_path(account_key):
    encoded = base64.urlsafe_b64encode(account_key.encode()).decode().rstrip('=')
    return os.path.join(accounts_dir, f'{encoded}.auth.json')
try:
    if os.path.exists(registry_path):
        with open(registry_path, encoding='utf-8') as f:
            active = json.load(f).get('active_account_key')
        if isinstance(active, str) and active:
            path = auth_path(active)
            if os.path.exists(path):
                print(path)
                raise SystemExit(0)
    if os.path.isdir(accounts_dir):
        candidates = [os.path.join(accounts_dir, entry) for entry in os.listdir(accounts_dir) if entry.endswith('.auth.json')]
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
  } else if ((Date.now() - refreshedAt) / 86400000 > staleDays) {
    warn(`auth.json last_refresh is older than ${staleDays} days. Re-run codex login and reseed auth.json if CI reports Codex auth failures.`);
  }
}
NODE
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$CODEX_AUTH_FILE" "$CODEX_AUTH_STALE_DAYS" <<'PY'
from datetime import datetime, timezone
import json, sys
path = sys.argv[1]
stale_days = float(sys.argv[2] or '30')
def warn(message):
    print(f'WARN {message}', file=sys.stderr)
try:
    with open(path, encoding='utf-8') as f:
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
            warn(f'auth.json last_refresh is older than {stale_days:g} days. Re-run codex login and reseed auth.json if CI reports Codex auth failures.')
    except ValueError:
        warn('auth.json last_refresh is not parseable. If CI later reports Codex auth errors, run codex login and reseed auth.json.')
PY
  else
    fatal "Need node or python3 to validate auth.json safely."
  fi
}

prepare_curl_config() {
  [ -n "$GITLAB_TOKEN" ] || fatal "Set GITLAB_TOKEN to a GitLab access token with permission to edit CI/CD variables."
  case "$GITLAB_TOKEN" in
    *$'\n'*|*$'\r'*) fatal "GITLAB_TOKEN must be a single-line token" ;;
  esac
  CURL_CONFIG="$(mktemp)"
  chmod 600 "$CURL_CONFIG"
  printf 'header = "PRIVATE-TOKEN: %s"\n' "$GITLAB_TOKEN" > "$CURL_CONFIG"
}

confirm_secret_write() {
  if is_true "$DRY_RUN" || is_true "$CONFIRM_WRITE"; then
    return
  fi

  warn "This will create or overwrite GitLab CI/CD variable $SECRET_NAME for the target below."
  warn "ReviewRouter SaaS will not receive the secret value; this script writes directly to GitLab."

  if [ ! -t 0 ]; then
    fatal "Refusing to write variables in non-interactive mode without confirmation. Set REVIEW_ROUTER_CONFIRM_WRITE=1 after verifying the target."
  fi

  printf 'Type "write secrets" to continue: ' >&2
  read -r answer
  if [ "$answer" != "write secrets" ]; then
    fatal "Secret write cancelled."
  fi
}

gitlab_request_with_auth_file() {
  method="$1"
  path="$2"
  include_key="$3"
  response_file="$(mktemp)"
  status="$(
    curl --silent --show-error --output "$response_file" --write-out '%{http_code}' \
      --config "$CURL_CONFIG" \
      --request "$method" \
      --form "value=<$CODEX_AUTH_FILE" \
      --form "protected=false" \
      --form "masked=false" \
      --form "raw=true" \
      --form "variable_type=env_var" \
      ${include_key:+--form "key=$SECRET_NAME"} \
      "$GITLAB_API_URL$path"
  )" || {
    rm -f "$response_file"
    fatal "GitLab API request failed"
  }
  rm -f "$response_file"
  printf '%s' "$status"
}

upsert_variable() {
  target_kind="$1"
  target_value="$2"
  encoded_target="$(urlencode "$target_value")"
  if [ "$target_kind" = "group" ]; then
    endpoint="/groups/$encoded_target/variables"
  else
    endpoint="/projects/$encoded_target/variables"
  fi

  if is_true "$DRY_RUN"; then
    log "[dry-run] would upsert $SECRET_NAME for GitLab $target_kind $target_value"
    return
  fi

  status="$(gitlab_request_with_auth_file PUT "$endpoint/$SECRET_NAME" "")"
  case "$status" in
    200|201|204)
      ok "Updated $SECRET_NAME for GitLab $target_kind $target_value"
      return
      ;;
    404) ;;
    401|403)
      fatal "GitLab refused variable write for $target_kind $target_value. Check token permissions."
      ;;
    *)
      fatal "GitLab variable update failed for $target_kind $target_value with HTTP $status"
      ;;
  esac

  status="$(gitlab_request_with_auth_file POST "$endpoint" "1")"
  case "$status" in
    200|201|204)
      ok "Created $SECRET_NAME for GitLab $target_kind $target_value"
      ;;
    401|403)
      fatal "GitLab refused variable create for $target_kind $target_value. Check token permissions."
      ;;
    *)
      fatal "GitLab variable create failed for $target_kind $target_value with HTTP $status"
      ;;
  esac
}

write_targets() {
  if [ "$SECRET_SCOPE" = "group" ]; then
    upsert_variable group "$GROUP_TARGET"
    return
  fi

  old_ifs="$IFS"
  IFS=','
  for project_id in $PROJECT_IDS; do
    upsert_variable project "$project_id"
  done
  IFS="$old_ifs"
}

print_summary() {
  log ""
  if is_true "$DRY_RUN"; then
    ok "Dry run complete. No GitLab variables were written."
  else
    ok "ReviewRouter is ready to use Codex OAuth for this GitLab target."
  fi
  if [ "$SECRET_SCOPE" = "group" ]; then
    info "Ready target: GitLab group $GROUP_TARGET"
  else
    info "Ready target: GitLab projects $PROJECT_IDS"
  fi
  info "Stored secret name: $SECRET_NAME"
  info "Next step: open or update a merge request and let the ReviewRouter GitLab pipeline run."
}

main() {
  parse_args "$@"
  log "${PRODUCT_NAME} GitLab Codex OAuth secret seeding"
  require_cmd curl
  normalize_gitlab_url
  normalize_secret_scope
  resolve_codex_auth_file
  validate_codex_auth_file
  ok "Validated Codex auth JSON before writing GitLab variables"

  info "GitLab URL: $GITLAB_URL"
  if [ "$SECRET_SCOPE" = "group" ]; then
    info "Variable scope: group $GROUP_TARGET"
  else
    info "Variable scope: projects $PROJECT_IDS"
  fi
  info "Codex auth file: $CODEX_AUTH_FILE"
  confirm_secret_write
  if ! is_true "$DRY_RUN"; then
    prepare_curl_config
  fi
  write_targets
  print_summary
}

main "$@"
