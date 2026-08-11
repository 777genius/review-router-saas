#!/usr/bin/env bash
# Seed ReviewRouter rotating Codex OAuth auth into one repository secret.
# This mode is intentionally separate from scripts/seed-codex-auth.sh.

# A claim id is a 122-bit continuation bearer capability. Disable inherited or
# caller-requested xtrace before any manifest, response, or journal is read.
set +x
set -Eeuo pipefail

PRODUCT_NAME="ReviewRouter"
SECRET_NAME=""
MANIFEST_B64="${REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64:-}"
SETUP_URL="${REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL:-}"
SETUP_PREPARE_URL="${REVIEW_ROUTER_CODEX_ROTATING_SETUP_PREPARE_URL:-}"
SETUP_DISPATCH_URL="${REVIEW_ROUTER_CODEX_ROTATING_SETUP_DISPATCH_URL:-}"
SETUP_DISPATCH_OUTCOME_URL="${REVIEW_ROUTER_CODEX_ROTATING_SETUP_DISPATCH_OUTCOME_URL:-}"
SETUP_STATUS_URL="${REVIEW_ROUTER_CODEX_ROTATING_SETUP_STATUS_URL:-}"
SETUP_NONCE="${REVIEW_ROUTER_CODEX_ROTATING_SETUP_NONCE:-}"
EXPECTED_PROVIDER_INSTANCE_ID="${REVIEW_ROUTER_CODEX_ROTATING_PROVIDER_INSTANCE_ID:-}"
INSTALLER_URL="${REVIEW_ROUTER_INSTALLER_URL:-}"
INSTALLER_VERSION="${REVIEW_ROUTER_INSTALLER_VERSION:-}"
INSTALLER_SHA256="${REVIEW_ROUTER_INSTALLER_SHA256:-}"
SCRIPT_SELF_PATH="${BASH_SOURCE[0]:-$0}"
TARGET_REPO="${REVIEW_ROUTER_REPO:-}"
AUTH_FILE="${REVIEW_ROUTER_CODEX_AUTH_FILE:-}"
CODEX_HOME_OVERRIDE="${REVIEW_ROUTER_CODEX_HOME:-}"
ALLOW_EXTERNAL_AUTH_FILE="${REVIEW_ROUTER_ALLOW_EXTERNAL_CODEX_AUTH_FILE:-0}"
DRY_RUN="${REVIEW_ROUTER_DRY_RUN:-0}"
CURL_TEST_UNIX_SOCKET="${REVIEW_ROUTER_CODEX_ROTATING_CURL_TEST_UNIX_SOCKET:-}"
CURL_TEST_MAX_TIME="${REVIEW_ROUTER_CODEX_ROTATING_CURL_TEST_MAX_TIME:-}"
CONFIRM_WRITE="${REVIEW_ROUTER_CONFIRM_WRITE:-${REVIEW_ROUTER_YES:-0}}"
SKIP_LOGIN="${REVIEW_ROUTER_SKIP_CODEX_LOGIN:-0}"
FORCE_RESEED="${REVIEW_ROUTER_FORCE_CODEX_RESEED:-0}"
REUSE_EXISTING_AUTH="${REVIEW_ROUTER_REUSE_EXISTING_CODEX_AUTH_I_KNOW_IT_IS_CURRENT:-0}"
CODEX_LOGIN_METHOD="${REVIEW_ROUTER_CODEX_LOGIN_METHOD:-auto}"
LOGIN_CREATED_AUTH="0"
RECOVERY_EXPIRES_AT=""
ATTEMPT_ID=""
NAMESPACE_ID=""
NAMESPACE_EPOCH=""
PREPARE_STATUS=""
PROVIDER_PUT_STATUS=""
REMOTE_PAYLOAD_CLAIMED="0"
RETRY_EXISTING_PAYLOAD="0"
SECRET_DISPATCH_REQUIRED="1"
RECOVERY_EPOCH=""

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
ReviewRouter rotating Codex OAuth setup

Usage:
  bash scripts/seed-codex-rotating-auth.sh --confirm-write

Options:
  --manifest-b64 value     Base64url setup manifest from ReviewRouter.
  --setup-url value        HTTPS URL used to fetch a short-lived setup manifest.
  --setup-prepare-url val  HTTPS URL used to claim the exact payload before dispatch.
  --setup-nonce value      Short-lived ReviewRouter setup nonce.
  --repo owner/repo        Expected repository. Must match the setup manifest.
  --auth-file path         Choose an explicit auth JSON file inside the dedicated CODEX_HOME.
  --codex-home path        Dedicated ReviewRouter Codex home. Defaults to ~/.reviewrouter/codex/<owner-repo>.
  --skip-login             Do not run codex login when auth is missing.
  --force-reseed           Quarantine existing dedicated auth and perform a fresh Codex login.
  --reuse-existing-auth-i-know-it-is-current
                           Reuse an existing auth file. Unsafe unless it is known to be current.
  --login-method value     auto, browser, or device. Defaults to auto.
  --dry-run                Validate and print the gh command without writing.
  --yes, --confirm-write   Allow non-interactive repository secret write.
  -h, --help               Show this help.

The installer is repo-scoped and writes one never-reused versioned
REVIEWROUTER_CODEX_AUTH_JSON_R<repository-id>_P<provider-hash>_E<epoch>_<entropy> name directly to GitHub
Actions secrets through gh. ReviewRouter SaaS does not receive plaintext
auth.json. The exact destination name is accepted only from the server's
dispatch authorization.

External --auth-file paths are blocked by default because rotating refresh
tokens must not be copied across repositories. For one-off recovery only, set
REVIEW_ROUTER_ALLOW_EXTERNAL_CODEX_AUTH_FILE=1.
EOF
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|y|Y) return 0 ;;
    *) return 1 ;;
  esac
}

is_http_success() {
  case "${1:-}" in
    2??) return 0 ;;
    *) return 1 ;;
  esac
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fatal "Missing required command: $1"
}

require_checksum_tool() {
  command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || fatal "Missing required checksum command: shasum or sha256sum"
}

sha256_file() {
  file_path="$1"
  if command -v shasum >/dev/null 2>&1; then
    if actual_hash="$(shasum -a 256 "$file_path" 2>/dev/null | sed 's/[[:space:]].*$//' | tr '[:upper:]' '[:lower:]')" && [ -n "$actual_hash" ]; then
      printf '%s\n' "$actual_hash"
      return 0
    fi
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    if actual_hash="$(sha256sum "$file_path" 2>/dev/null | sed 's/[[:space:]].*$//' | tr '[:upper:]' '[:lower:]')" && [ -n "$actual_hash" ]; then
      printf '%s\n' "$actual_hash"
      return 0
    fi
  fi
  fatal "Could not compute SHA256. Install shasum or sha256sum and retry."
}

require_arg() {
  option="$1"
  value="${2:-}"
  [ -n "$value" ] || fatal "$option requires a value"
}

verify_installer_self_hash() {
  if [ -z "$INSTALLER_SHA256" ]; then
    return
  fi
  [ -r "$SCRIPT_SELF_PATH" ] || fatal "Cannot verify installer SHA256 because the script path is not readable: $SCRIPT_SELF_PATH"

  actual_hash="$(sha256_file "$SCRIPT_SELF_PATH")"
  expected_hash="$(printf '%s' "$INSTALLER_SHA256" | tr '[:upper:]' '[:lower:]')"
  if [ "$actual_hash" != "$expected_hash" ]; then
    fatal "Installer SHA256 mismatch. Expected $expected_hash but got $actual_hash. Reopen the ReviewRouter dashboard and copy a fresh command."
  fi
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --manifest-b64)
        shift
        require_arg "--manifest-b64" "${1:-}"
        MANIFEST_B64="$1"
        ;;
      --setup-url)
        shift
        require_arg "--setup-url" "${1:-}"
        SETUP_URL="$1"
        ;;
      --setup-prepare-url)
        shift
        require_arg "--setup-prepare-url" "${1:-}"
        SETUP_PREPARE_URL="$1"
        ;;
      --setup-nonce)
        shift
        require_arg "--setup-nonce" "${1:-}"
        SETUP_NONCE="$1"
        ;;
      --repo)
        shift
        require_arg "--repo" "${1:-}"
        TARGET_REPO="$1"
        ;;
      --auth-file)
        shift
        require_arg "--auth-file" "${1:-}"
        AUTH_FILE="$1"
        ;;
      --codex-home)
        shift
        require_arg "--codex-home" "${1:-}"
        CODEX_HOME_OVERRIDE="$1"
        ;;
      --skip-login)
        SKIP_LOGIN="1"
        ;;
      --force-reseed)
        FORCE_RESEED="1"
        ;;
      --reuse-existing-auth-i-know-it-is-current)
        REUSE_EXISTING_AUTH="1"
        ;;
      --login-method)
        shift
        require_arg "--login-method" "${1:-}"
        CODEX_LOGIN_METHOD="$1"
        ;;
      --dry-run)
        DRY_RUN="1"
        ;;
      --yes|--confirm-write)
        CONFIRM_WRITE="1"
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

validate_seed_options() {
  case "$CODEX_LOGIN_METHOD" in
    auto|browser|device) ;;
    *) fatal "--login-method must be auto, browser, or device. Got: $CODEX_LOGIN_METHOD" ;;
  esac
  if is_true "$FORCE_RESEED" && [ -n "$AUTH_FILE" ]; then
    fatal "--force-reseed cannot be combined with --auth-file. Remove --auth-file and let the installer create a fresh dedicated Codex login."
  fi
  if is_true "$FORCE_RESEED" && is_true "$SKIP_LOGIN"; then
    fatal "--force-reseed cannot be combined with --skip-login."
  fi
}

resolve_versioned_ledger_urls() {
  if [ -n "$SETUP_PREPARE_URL" ]; then
    setup_api_base="${SETUP_PREPARE_URL%/prepare}"
    SETUP_DISPATCH_URL="${SETUP_DISPATCH_URL:-$setup_api_base/dispatch}"
    SETUP_DISPATCH_OUTCOME_URL="${SETUP_DISPATCH_OUTCOME_URL:-$setup_api_base/confirm}"
    SETUP_STATUS_URL="${SETUP_STATUS_URL:-$setup_api_base/status}"
  fi
  validate_versioned_ledger_urls
}

validate_versioned_ledger_urls() {
  if ! node - "$SETUP_URL" "$SETUP_PREPARE_URL" "$SETUP_DISPATCH_URL" "$SETUP_DISPATCH_OUTCOME_URL" "$SETUP_STATUS_URL" <<'NODE'
const [manifest, prepare, dispatch, dispatchOutcome, status] = process.argv.slice(2);
const endpoints = { manifest, prepare, dispatch, dispatchOutcome, status };
const continuationEndpoints = Object.entries(endpoints).filter(([name]) => name !== "manifest");

function fail() {
  process.exit(1);
}

function parseEndpoint(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail();
  }
  if (parsed.username || parsed.password || parsed.hash) fail();
  const loopbackHostname =
    parsed.hostname === "localhost" ||
    parsed.hostname.endsWith(".localhost") ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  const approvedLoopback =
    parsed.protocol === "http:" && loopbackHostname && parsed.port !== "";
  if (parsed.protocol !== "https:" && !approvedLoopback) fail();
  return parsed;
}

if (!manifest) {
  if (continuationEndpoints.some(([, value]) => value)) fail();
  process.exit(0);
}

const manifestEndpoint = parseEndpoint(manifest);
for (const [, value] of continuationEndpoints) {
  if (!value) continue;
  if (parseEndpoint(value).origin !== manifestEndpoint.origin) fail();
}
NODE
  then
    fatal "Setup ledger URLs must use one HTTPS origin or one explicit loopback test origin."
  fi
}

validate_repo_name() {
  case "$1" in
    */*) ;;
    *) fatal "Repository must be owner/repo. Got: $1" ;;
  esac
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || fatal "Invalid repository name: $1"
}

repo_slug() {
  printf '%s' "$1" | tr '/[:upper:]' '-[:lower:]' | tr -cd 'a-z0-9_.-'
}

decode_manifest() {
  [ -n "$MANIFEST_B64" ] || fatal "Missing setup manifest. Reopen the ReviewRouter dashboard and copy the current rotating Codex command."

  node - "$MANIFEST_B64" "$TARGET_REPO" "$INSTALLER_URL" "$INSTALLER_VERSION" "$INSTALLER_SHA256" "$EXPECTED_PROVIDER_INSTANCE_ID" "$RECOVERY_EXPIRES_AT" <<'NODE'
const encoded = process.argv[2];
const expectedRepo = process.argv[3] || "";
const installerUrl = process.argv[4] || "";
const installerVersion = process.argv[5] || "";
const installerSha256 = (process.argv[6] || "").toLowerCase();
const expectedProviderInstanceId = process.argv[7] || "";
const recoveryExpiresAt = process.argv[8] || "";
function fail(message) {
  console.error(message);
  process.exit(1);
}
let manifest;
try {
  manifest = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
} catch {
  fail("setup manifest is not valid base64url JSON");
}
if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
  fail("setup manifest must be an object");
}
const required = [
  "protocolVersion",
  "repositoryFullName",
  "repositoryId",
  "providerInstanceId",
  "setupNonce",
  "authMode",
  "generatedAt",
  "expiresAt",
  "installer",
  "generationHashSalt",
  "accountFingerprintSalt",
];
for (const key of required) {
  if (!(key in manifest)) fail(`setup manifest missing ${key}`);
}
const allowed = new Set(required);
if (Object.keys(manifest).some((key) => !allowed.has(key))) fail("setup manifest contains unsupported fields");
if (manifest.protocolVersion !== 2) fail("setup manifest protocol version is unsupported");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(manifest.repositoryFullName)) fail("setup manifest repository is invalid");
if (expectedRepo && manifest.repositoryFullName !== expectedRepo) fail("setup manifest repository does not match --repo");
if (!/^[1-9][0-9]*$/.test(manifest.repositoryId)) fail("setup manifest repository id is invalid");
if (manifest.providerInstanceId !== `codex-rotating:${manifest.repositoryId}`) fail("setup manifest provider identity is invalid");
if (expectedProviderInstanceId && manifest.providerInstanceId !== expectedProviderInstanceId) fail("setup manifest provider does not match installer command");
if (manifest.authMode !== "codex_subscription_oauth_rotating") fail("setup manifest auth mode is invalid");
if (!manifest.installer || typeof manifest.installer !== "object" || Array.isArray(manifest.installer)) fail("setup manifest installer is invalid");
if (Object.keys(manifest.installer).some((key) => !new Set(["url", "version", "sha256"]).has(key))) fail("setup manifest installer contains unsupported fields");
if (installerUrl && manifest.installer.url !== installerUrl) fail("setup manifest installer URL mismatch");
if (installerVersion && manifest.installer.version !== installerVersion) fail("setup manifest installer version mismatch");
if (installerSha256 && String(manifest.installer.sha256).toLowerCase() !== installerSha256) fail("setup manifest installer SHA256 mismatch");
const expiresAt = Date.parse(manifest.expiresAt);
const recoveryExpiry = Date.parse(recoveryExpiresAt);
if (!Number.isFinite(expiresAt) || (expiresAt <= Date.now() && (!Number.isFinite(recoveryExpiry) || recoveryExpiry <= Date.now()))) {
  fail("setup manifest recovery window expired; use a versioned-secret/manual recovery path");
}
if (!/^[A-Za-z0-9_-]{22,}$/.test(manifest.generationHashSalt)) fail("setup manifest generation salt is invalid");
if (!/^[A-Za-z0-9_-]{22,}$/.test(manifest.accountFingerprintSalt)) fail("setup manifest account salt is invalid");
console.log(JSON.stringify(manifest));
NODE
}

fetch_setup_manifest() {
  [ -n "$SETUP_URL" ] || fatal "Missing setup manifest URL. Reopen the ReviewRouter dashboard and copy the current rotating Codex command."
  [ -n "$SETUP_NONCE" ] || fatal "Missing setup nonce. Reopen the ReviewRouter dashboard and copy the current rotating Codex command."

  SETUP_RESPONSE_FILE="$(mktemp)"
  fetch_attempt=1
  while [ "$fetch_attempt" -le 3 ]; do
    if fetch_status="$(curl -q -fsS --max-redirs 0 --connect-timeout 10 --max-time 30 --get \
      --data-urlencode "nonce=$SETUP_NONCE" "$SETUP_URL" \
      -o "$SETUP_RESPONSE_FILE" --write-out '%{http_code}')"; then
      case "$fetch_status" in
        2??) break ;;
      esac
    fi
    if [ "$fetch_attempt" -eq 3 ]; then
      fatal "Could not fetch the setup manifest after retrying the same nonce."
    fi
    warn "ReviewRouter manifest delivery did not complete. Retrying the same idempotent fetch."
    sleep "$fetch_attempt"
    fetch_attempt=$((fetch_attempt + 1))
  done
  fetch_metadata="$(node - "$SETUP_RESPONSE_FILE" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
function fail(message) {
  console.error(message);
  process.exit(1);
}
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(path, "utf8"));
} catch {
  fail("setup manifest response is not valid JSON");
}
if (!parsed || typeof parsed.manifestBase64 !== "string" || parsed.manifestBase64.length === 0 ||
    typeof parsed.recoveryExpiresAt !== "string" || typeof parsed.payloadClaimed !== "boolean" ||
    !/^[0-9]+$/.test(parsed.recoveryEpoch)) {
  fail("setup manifest response is missing manifestBase64");
}
console.log([parsed.manifestBase64, parsed.recoveryExpiresAt, parsed.payloadClaimed ? "1" : "0", parsed.recoveryEpoch].join("\t"));
NODE
  )"
  IFS="$(printf '\t')" read -r MANIFEST_B64 RECOVERY_EXPIRES_AT REMOTE_PAYLOAD_CLAIMED RECOVERY_EPOCH <<EOF
$fetch_metadata
EOF
  rm -f "$SETUP_RESPONSE_FILE"
  SETUP_RESPONSE_FILE=""
}

payload_retry_state_path() {
  marker_path="$(manifest_nonce_marker_path)"
  marker_name="$(basename "$marker_path")"
  printf '%s\n' "$CODEX_HOME_DIR/pending-secret-payloads/$marker_name"
}

manifest_value() {
  printf '%s' "$MANIFEST_JSON" | node -e "const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync(0,'utf8')); console.log(m[process.argv[1]] ?? '')" "$1"
}

manifest_nonce_marker_path() {
  node - "$CODEX_HOME_DIR" "$MANIFEST_JSON" <<'NODE'
const crypto = require("node:crypto");
const path = require("node:path");
const codexHome = process.argv[2];
const manifest = JSON.parse(process.argv[3]);
const markerId = crypto
  .createHash("sha256")
  .update(`${manifest.repositoryFullName}\0${manifest.providerInstanceId}\0${manifest.setupNonce}`)
  .digest("hex");
console.log(path.join(codexHome, "used-setup-nonces", `${markerId}.json`));
NODE
}

repository_setup_lock_path() {
  node - "$CODEX_HOME_DIR" "$TARGET_REPO" <<'NODE'
const crypto = require("node:crypto");
const path = require("node:path");
const [codexHome, repository] = process.argv.slice(2);
const lockId = crypto
  .createHash("sha256")
  .update(repository)
  .digest("hex");
console.log(path.join(codexHome, "active-repository-setups", `${lockId}.lock`));
NODE
}

acquire_repository_setup_lock() {
  REPOSITORY_SETUP_LOCK_PATH="$(repository_setup_lock_path)"
  lock_parent="$(dirname "$REPOSITORY_SETUP_LOCK_PATH")"
  mkdir -p "$lock_parent"
  chmod 700 "$lock_parent"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$REPOSITORY_SETUP_LOCK_PATH"
    if ! flock -n 9; then
      fatal "A rotating Codex setup is already running for $TARGET_REPO in this CODEX_HOME. Wait for it to finish before starting another."
    fi
    REPOSITORY_SETUP_LOCK_KIND="flock"
  elif command -v shlock >/dev/null 2>&1; then
    if ! shlock -f "$REPOSITORY_SETUP_LOCK_PATH" -p "$$"; then
      fatal "A rotating Codex setup is already running for $TARGET_REPO in this CODEX_HOME. Wait for it to finish before starting another."
    fi
    REPOSITORY_SETUP_LOCK_KIND="shlock"
  else
    fatal "Missing an automatically released file-lock command. Install flock, or use macOS shlock."
  fi
  if [ ! -f "$REPOSITORY_SETUP_LOCK_PATH" ]; then
    fatal "A rotating Codex setup is already running for $TARGET_REPO in this CODEX_HOME. Wait for it to finish before starting another."
  fi
  chmod 600 "$REPOSITORY_SETUP_LOCK_PATH"
}

assert_manifest_not_reused() {
  SETUP_NONCE_MARKER="$(manifest_nonce_marker_path)"
  marker_dir="$(dirname "$SETUP_NONCE_MARKER")"
  mkdir -p "$marker_dir"
  chmod 700 "$marker_dir"
  if [ -e "$SETUP_NONCE_MARKER" ]; then
    fatal "This rotating Codex setup command was already used on this CODEX_HOME. Reopen the ReviewRouter dashboard and copy a fresh command."
  fi
  SETUP_NONCE_LOCK_DIR="${SETUP_NONCE_MARKER}.lock"
  if ! mkdir "$SETUP_NONCE_LOCK_DIR" 2>/dev/null; then
    fatal "This rotating Codex setup command is already running for this CODEX_HOME. Wait for it to finish or copy a fresh command."
  fi
  chmod 700 "$SETUP_NONCE_LOCK_DIR"
}

assert_manifest_write_window() {
  node - "$MANIFEST_JSON" "$RECOVERY_EXPIRES_AT" "$RETRY_EXISTING_PAYLOAD" <<'NODE'
const manifest = JSON.parse(process.argv[2]);
const expiresAt = Date.parse(process.argv[4] === "1" ? process.argv[3] : manifest.expiresAt);
const minimumWriteWindowMs = 60_000;
if (!Number.isFinite(expiresAt) || expiresAt - Date.now() < minimumWriteWindowMs) {
  console.error("Setup recovery window has too little time remaining for a fresh versioned dispatch authorization.");
  process.exit(1);
}
NODE
}

mark_manifest_used() {
  if is_true "$DRY_RUN"; then
    return
  fi
  [ -n "${SETUP_NONCE_MARKER:-}" ] || SETUP_NONCE_MARKER="$(manifest_nonce_marker_path)"
  marker_dir="$(dirname "$SETUP_NONCE_MARKER")"
  mkdir -p "$marker_dir"
  chmod 700 "$marker_dir"
  node - "$SETUP_NONCE_MARKER" "$MANIFEST_JSON" <<'NODE'
const fs = require("node:fs");
const markerPath = process.argv[2];
const manifest = JSON.parse(process.argv[3]);
const marker = {
  repositoryFullName: manifest.repositoryFullName,
  providerInstanceId: manifest.providerInstanceId,
  setupNonce: manifest.setupNonce,
  usedAt: new Date().toISOString(),
};
fs.writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600, flag: "wx" });
NODE
  if [ -n "${PAYLOAD_RETRY_STATE:-}" ] && [ -f "$PAYLOAD_RETRY_STATE" ]; then
    rm -f "$PAYLOAD_RETRY_STATE"
  fi
  if [ -n "${SETUP_NONCE_LOCK_DIR:-}" ] && [ -d "$SETUP_NONCE_LOCK_DIR" ]; then
    rmdir "$SETUP_NONCE_LOCK_DIR" 2>/dev/null || true
    SETUP_NONCE_LOCK_DIR=""
  fi
}

ci_owned_auth_state_path() {
  printf '%s\n' "$CODEX_HOME_DIR/reviewrouter-codex-auth-state.json"
}

mark_ci_owned_auth_state() {
  if is_true "$DRY_RUN"; then
    return
  fi
  [ -n "${AUTH_GENERATION_HASH:-}" ] || fatal "Missing generation hash for local auth state marker."
  [ -n "${AUTH_ACCOUNT_FINGERPRINT:-}" ] || fatal "Missing account fingerprint for local auth state marker."
  state_path="$(ci_owned_auth_state_path)"
  node - "$state_path" "$MANIFEST_JSON" "$SECRET_NAME" "$AUTH_GENERATION_HASH" "$AUTH_ACCOUNT_FINGERPRINT" "$LOGIN_CREATED_AUTH" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [
  statePath,
  manifestJson,
  secretName,
  generationHash,
  accountFingerprint,
  loginCreatedAuth,
] = process.argv.slice(2);
const manifest = JSON.parse(manifestJson);
fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
const state = {
  stateVersion: 1,
  ciOwnsTokenChain: true,
  repositoryFullName: manifest.repositoryFullName,
  providerInstanceId: manifest.providerInstanceId,
  secretName,
  setupNonce: manifest.setupNonce,
  generationHash,
  accountFingerprint,
  seededAt: new Date().toISOString(),
  authSource: loginCreatedAuth === "1" ? "fresh-login" : "explicit-reuse",
};
fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
NODE
}

resolve_codex_home() {
  if [ -n "$CODEX_HOME_OVERRIDE" ]; then
    CODEX_HOME_DIR="$CODEX_HOME_OVERRIDE"
    return
  fi
  CODEX_HOME_DIR="$HOME/.reviewrouter/codex/$(repo_slug "$TARGET_REPO")"
}

write_dedicated_codex_config() {
  mkdir -p "$CODEX_HOME_DIR"
  chmod 700 "$CODEX_HOME_DIR"
  config_path="$CODEX_HOME_DIR/config.toml"
  if [ ! -f "$config_path" ]; then
    cat >"$config_path" <<'EOF'
cli_auth_credentials_store = "file"
EOF
    chmod 600 "$config_path"
  elif ! grep -Eq '^[[:space:]]*cli_auth_credentials_store[[:space:]]*=[[:space:]]*"file"' "$config_path"; then
    fatal "Dedicated CODEX_HOME already has config.toml without cli_auth_credentials_store = \"file\": $config_path"
  fi
}

assert_auth_file_is_repo_scoped() {
  if [ -z "$AUTH_FILE" ]; then
    return
  fi
  [ -f "$AUTH_FILE" ] || fatal "Codex auth file not found: $AUTH_FILE"

  if is_true "$ALLOW_EXTERNAL_AUTH_FILE"; then
    warn "Using external Codex auth file because REVIEW_ROUTER_ALLOW_EXTERNAL_CODEX_AUTH_FILE=1. Do not reuse one rotating auth.json across repositories."
    return
  fi

  node - "$AUTH_FILE" "$CODEX_HOME_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const authPath = process.argv[2];
const codexHome = process.argv[3];
function fail(message) {
  fs.writeSync(2, `${message}\n`);
  process.exit(1);
}
let authRealPath;
let codexHomeRealPath;
try {
  authRealPath = fs.realpathSync(authPath);
} catch {
  fail(`Codex auth file not found: ${authPath}`);
}
try {
  codexHomeRealPath = fs.realpathSync(codexHome);
} catch {
  fail(`Dedicated CODEX_HOME not found: ${codexHome}`);
}
const relative = path.relative(codexHomeRealPath, authRealPath);
if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
  process.exit(0);
}
fail(
  [
    `Refusing --auth-file outside dedicated CODEX_HOME: ${authPath}.`,
    `Run codex login with CODEX_HOME=${codexHome}, choose a file under that directory,`,
    "or set REVIEW_ROUTER_ALLOW_EXTERNAL_CODEX_AUTH_FILE=1 for a one-off recovery.",
    "Do not reuse one rotating auth.json across repositories.",
  ].join(" "),
);
NODE
}

run_codex_login_if_needed() {
  if is_true "$FORCE_RESEED"; then
    quarantine_existing_codex_auth
    run_codex_login
    return
  fi

  set +e
  existing_auth_file="$(find_auth_file 2>/dev/null)"
  find_status="$?"
  set -e

  if [ "$find_status" -eq 0 ] || [ "$find_status" -eq 2 ]; then
    if is_true "$REUSE_EXISTING_AUTH"; then
      warn "Reusing an existing Codex auth file only because --reuse-existing-auth-i-know-it-is-current was set."
      return
    fi
    refuse_existing_auth_reuse "$find_status" "$existing_auth_file"
  fi

  if is_true "$SKIP_LOGIN"; then
    fatal "No Codex auth file found in $CODEX_HOME_DIR and --skip-login is set."
  fi

  run_codex_login
}

refuse_existing_auth_reuse() {
  find_status="$1"
  existing_auth_file="${2:-}"
  if [ "$find_status" -eq 2 ]; then
    existing_auth_file="multiple Codex account auth files"
  fi
  state_hint=""
  if [ -f "$(ci_owned_auth_state_path)" ]; then
    state_hint=" This CODEX_HOME is marked as CI-owned after a previous ReviewRouter setup."
  fi
  fatal "Refusing to reuse existing Codex auth from $CODEX_HOME_DIR by default.${state_hint} The GitHub Actions secret may have been refreshed after this local file was created, so reusing it can overwrite the active rotating token chain. Use --force-reseed for a fresh login, or --reuse-existing-auth-i-know-it-is-current only if you know ${existing_auth_file:-the auth file} is current."
}

quarantine_existing_codex_auth() {
  node - "$CODEX_HOME_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const codexHome = process.argv[2];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const quarantineRoot = path.join(codexHome, "quarantined-auth", stamp);
const candidates = [path.join(codexHome, "auth.json")];
const accountsDir = path.join(codexHome, "accounts");
if (fs.existsSync(accountsDir)) {
  for (const entry of fs.readdirSync(accountsDir)) {
    if (entry.endsWith(".auth.json") || entry === "registry.json") {
      candidates.push(path.join(accountsDir, entry));
    }
  }
}
let moved = 0;
for (const source of candidates) {
  if (!fs.existsSync(source)) continue;
  const relative = path.relative(codexHome, source);
  if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
  const target = path.join(quarantineRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.renameSync(source, target);
  moved += 1;
}
if (moved > 0) {
  fs.writeFileSync(
    path.join(quarantineRoot, "README.txt"),
    [
      "ReviewRouter quarantined these Codex auth files before a forced reseed.",
      "They are not used automatically because GitHub Actions may own a newer rotating token chain.",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}
NODE
  info "Quarantined existing dedicated Codex auth before fresh reseed."
}

run_codex_login() {
  if is_true "$SKIP_LOGIN"; then
    fatal "No Codex auth file found in $CODEX_HOME_DIR and --skip-login is set."
  fi
  info "No reusable ReviewRouter Codex auth found. Starting Codex login."
  info "This uses $CODEX_HOME_DIR, not your normal ~/.codex session."
  case "$CODEX_LOGIN_METHOD" in
    browser)
      CODEX_HOME="$CODEX_HOME_DIR" HOME="$HOME" codex login
      ;;
    device)
      CODEX_HOME="$CODEX_HOME_DIR" HOME="$HOME" codex login --device-auth
      ;;
    auto)
      if [ -t 0 ] && [ -t 1 ] && [ -z "${SSH_CONNECTION:-}${SSH_TTY:-}" ]; then
        if CODEX_HOME="$CODEX_HOME_DIR" HOME="$HOME" codex login; then
          LOGIN_CREATED_AUTH="1"
          return
        fi
        warn "Codex browser login did not complete. Falling back to device login."
      fi
      CODEX_HOME="$CODEX_HOME_DIR" HOME="$HOME" codex login --device-auth
      ;;
    *)
      fatal "--login-method must be auto, browser, or device. Got: $CODEX_LOGIN_METHOD"
      ;;
  esac
  LOGIN_CREATED_AUTH="1"
}

find_auth_file() {
  if [ -n "$AUTH_FILE" ]; then
    [ -f "$AUTH_FILE" ] || return 1
    printf '%s\n' "$AUTH_FILE"
    return
  fi

  if [ -f "$CODEX_HOME_DIR/auth.json" ]; then
    printf '%s\n' "$CODEX_HOME_DIR/auth.json"
    return 0
  fi

  node - "$CODEX_HOME_DIR" <<'NODE' 2>/dev/null
const fs = require("node:fs");
const path = require("node:path");
const codexHome = process.argv[2];
const accountsDir = path.join(codexHome, "accounts");
const registryPath = path.join(accountsDir, "registry.json");
function authPathForAccountKey(accountKey) {
  return path.join(accountsDir, `${Buffer.from(accountKey, "utf8").toString("base64url")}.auth.json`);
}
if (fs.existsSync(registryPath)) {
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  if (typeof registry.active_account_key === "string") {
    const candidate = authPathForAccountKey(registry.active_account_key);
    if (fs.existsSync(candidate)) {
      console.log(candidate);
      process.exit(0);
    }
  }
}
if (fs.existsSync(accountsDir)) {
  const candidates = fs.readdirSync(accountsDir)
    .filter((entry) => entry.endsWith(".auth.json"))
    .map((entry) => path.join(accountsDir, entry));
  if (candidates.length === 1) {
    console.log(candidates[0]);
    process.exit(0);
  }
  if (candidates.length > 1) {
    process.exit(2);
  }
}
process.exit(1);
NODE
}

list_valid_auth_candidates() {
  node - "$CODEX_HOME_DIR" <<'NODE' 2>/dev/null
const fs = require("node:fs");
const path = require("node:path");
const codexHome = process.argv[2];
const accountsDir = path.join(codexHome, "accounts");
function isValidAuthFile(candidate) {
  try {
    const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
    return parsed?.auth_mode === "chatgpt" &&
      typeof parsed?.tokens?.refresh_token === "string" &&
      parsed.tokens.refresh_token.length > 0;
  } catch {
    return false;
  }
}
if (!fs.existsSync(accountsDir)) {
  process.exit(1);
}
const candidates = fs.readdirSync(accountsDir)
  .filter((entry) => entry.endsWith(".auth.json"))
  .map((entry) => path.join(accountsDir, entry))
  .filter(isValidAuthFile)
  .sort();
for (const candidate of candidates) {
  console.log(candidate);
}
process.exit(candidates.length > 0 ? 0 : 1);
NODE
}

resolve_auth_file() {
  set +e
  found_auth_file="$(find_auth_file 2>/dev/null)"
  find_status="$?"
  set -e
  if [ "$find_status" -eq 0 ]; then
    printf '%s\n' "$found_auth_file"
    return 0
  fi
  if [ "$find_status" -ne 2 ]; then
    return 1
  fi

  AUTH_CANDIDATES_FILE="$(mktemp)"
  list_valid_auth_candidates > "$AUTH_CANDIDATES_FILE" || fatal "Multiple Codex account files exist in $CODEX_HOME_DIR, but none are valid ChatGPT auth files. Re-run with --auth-file."
  candidate_count="$(wc -l < "$AUTH_CANDIDATES_FILE" | tr -d '[:space:]')"
  if [ "$candidate_count" = "1" ]; then
    selected_candidate="$(sed -n '1p' "$AUTH_CANDIDATES_FILE")"
    rm -f "$AUTH_CANDIDATES_FILE"
    AUTH_CANDIDATES_FILE=""
    printf '%s\n' "$selected_candidate"
    return 0
  fi
  if [ ! -t 0 ]; then
    fatal "Multiple valid Codex auth files found in $CODEX_HOME_DIR. Re-run with --auth-file <path> to choose one explicitly."
  fi

  warn "Multiple valid Codex auth files found. Choose the account file to store for this repository."
  index=1
  while IFS= read -r candidate; do
    printf '  %s) %s\n' "$index" "$(basename "$candidate")" >&2
    index=$((index + 1))
  done < "$AUTH_CANDIDATES_FILE"
  printf 'Select account number: ' >&2
  read -r selected_index
  case "$selected_index" in
    ''|*[!0-9]*) fatal "Invalid account selection." ;;
  esac
  if [ "$selected_index" -lt 1 ] || [ "$selected_index" -gt "$candidate_count" ]; then
    fatal "Invalid account selection."
  fi
  selected_candidate="$(sed -n "${selected_index}p" "$AUTH_CANDIDATES_FILE")"
  rm -f "$AUTH_CANDIDATES_FILE"
  AUTH_CANDIDATES_FILE=""
  printf '%s\n' "$selected_candidate"
}

validate_and_compact_auth() {
  auth_file="$1"
  [ -f "$auth_file" ] || fatal "Codex auth file not found: $auth_file"
  [ -r "$auth_file" ] || fatal "Codex auth file is not readable: $auth_file"

  compact_file="$(mktemp)"
  auth_metadata="$(node - "$auth_file" "$compact_file" "$MANIFEST_JSON" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const sourcePath = process.argv[2];
const compactPath = process.argv[3];
const manifest = JSON.parse(process.argv[4]);
function fail(message) {
  console.error(message);
  process.exit(1);
}
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
} catch {
  fail("auth.json is not valid JSON");
}
if (parsed.auth_mode !== "chatgpt") fail("auth.json auth_mode must be chatgpt");
if (!parsed.tokens || typeof parsed.tokens.refresh_token !== "string" || parsed.tokens.refresh_token.length === 0) {
  fail("auth.json tokens.refresh_token is missing");
}
const compact = JSON.stringify(parsed);
const byteLength = Buffer.byteLength(compact, "utf8");
if (byteLength > 32 * 1024) fail("auth.json is larger than the rotating beta 32 KiB limit");
const salt = Buffer.from(manifest.generationHashSalt, "base64url");
if (salt.length < 16) fail("setup manifest generation salt is too short");
const generationHash = crypto.createHmac("sha256", salt).update(compact, "utf8").digest("base64url");
const accountSalt = Buffer.from(manifest.accountFingerprintSalt, "base64url");
if (accountSalt.length < 16) fail("setup manifest account salt is too short");
if (typeof parsed.tokens.id_token !== "string") fail("auth.json id_token is required for stable account identity");
let identity;
try {
  const parts = parsed.tokens.id_token.split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  const encodedClaims = parts[1];
  if (
    !encodedClaims ||
    !/^[A-Za-z0-9_-]+$/.test(encodedClaims) ||
    encodedClaims.length % 4 === 1
  ) throw new Error("JWT payload is not valid base64url");
  const claimsBytes = Buffer.from(encodedClaims, "base64url");
  if (claimsBytes.toString("base64url") !== encodedClaims) {
    throw new Error("JWT payload is not valid base64url");
  }
  let claims;
  try {
    claims = JSON.parse(claimsBytes.toString("utf8"));
  } catch {
    throw new Error("JWT payload is not valid JSON");
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    throw new Error("issuer, subject, or account id is missing");
  }
  const authClaims = claims["https://api.openai.com/auth"] || {};
  const issuer = claims.iss;
  const subject = claims.sub;
  const accountIds = [claims.chatgpt_account_id, claims.account_id, authClaims.chatgpt_account_id, authClaims.account_id]
    .filter((value) => typeof value === "string" && value.length > 0);
  if (typeof issuer !== "string" || typeof subject !== "string" || !issuer || !subject || new Set(accountIds).size !== 1) {
    throw new Error("issuer, subject, or account id is missing");
  }
  identity = JSON.stringify({ issuer, subject, chatgptAccountId: accountIds[0] });
} catch (error) {
  if (process.env.REVIEW_ROUTER_DRY_RUN === "1") {
    identity = JSON.stringify({ issuer: "dry-run", subject: "dry-run", chatgptAccountId: "dry-run" });
  } else {
    const safeIdentityDiagnostics = new Set([
      "not a JWT",
      "JWT payload is not valid base64url",
      "JWT payload is not valid JSON",
      "issuer, subject, or account id is missing",
    ]);
    const diagnostic = error instanceof Error && safeIdentityDiagnostics.has(error.message)
      ? error.message
      : "token validation failed";
    fail(`auth.json cannot establish stable provider account identity: ${diagnostic}`);
  }
}
const accountFingerprint = crypto.createHmac("sha256", accountSalt).update(identity, "utf8").digest("base64url");
fs.writeFileSync(compactPath, compact, { mode: 0o600 });
console.log(JSON.stringify({ byteLength, generationHash, accountFingerprint }));
NODE
  )"
  AUTH_COMPACT_FILE="$compact_file"
  AUTH_BYTE_LENGTH="$(printf '%s' "$auth_metadata" | node -e "const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync(0,'utf8')); console.log(m.byteLength)")"
  AUTH_GENERATION_HASH="$(printf '%s' "$auth_metadata" | node -e "const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync(0,'utf8')); console.log(m.generationHash)")"
  AUTH_ACCOUNT_FINGERPRINT="$(printf '%s' "$auth_metadata" | node -e "const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync(0,'utf8')); console.log(m.accountFingerprint)")"
}

confirm_secret_write() {
  if is_true "$DRY_RUN" || is_true "$CONFIRM_WRITE"; then
    return
  fi
  warn "This will create one server-authorized, never-reused versioned secret for $TARGET_REPO."
  warn "The secret is written directly to GitHub Actions through gh."
  if [ ! -t 0 ]; then
    fatal "Refusing non-interactive write without --confirm-write."
  fi
  printf 'Type "write rotating codex" to continue: ' >&2
  read -r answer
  if [ "$answer" != "write rotating codex" ]; then
    fatal "Secret write cancelled."
  fi
}

assert_versioned_secret_name() {
  node -e 'if (!/^REVIEWROUTER_CODEX_AUTH_JSON_R[1-9][0-9]*_P[a-f0-9]{16}_E[1-9][0-9]*_[a-f0-9]{32}$/.test(process.argv[1] || "")) process.exit(1)' "$SECRET_NAME" \
    || fatal "Missing or invalid server-authorized versioned secret name."
}

write_github_secret() {
  assert_versioned_secret_name
  if is_true "$DRY_RUN"; then
    log "[dry-run] one-shot encrypted GitHub PUT for $SECRET_NAME in $TARGET_REPO"
    return
  fi

  # gh is deliberately used only as a local sealed-box implementation. Its
  # HTTP transport may retry idempotent PUT requests, so it must never perform
  # the provider write for a never-reused namespace.
  key_before="$(mktemp)"
  key_after="$(mktemp)"
  encrypted_value="$(mktemp)"
  provider_body="$(mktemp)"
  if ! gh api --hostname github.com "repos/$TARGET_REPO/actions/secrets/public-key" >"$key_before"; then
    rm -f "$key_before" "$key_after" "$encrypted_value" "$provider_body"
    return 1
  fi
  if ! gh secret set "$SECRET_NAME" --repo "github.com/$TARGET_REPO" --app actions --no-store \
    <"$AUTH_COMPACT_FILE" >"$encrypted_value"; then
    rm -f "$key_before" "$key_after" "$encrypted_value" "$provider_body"
    return 1
  fi
  if ! gh api --hostname github.com "repos/$TARGET_REPO/actions/secrets/public-key" >"$key_after"; then
    rm -f "$key_before" "$key_after" "$encrypted_value" "$provider_body"
    return 1
  fi
  if ! node - "$key_before" "$key_after" "$encrypted_value" "$provider_body" <<'NODE'
const fs = require("node:fs");
const [beforePath, afterPath, encryptedPath, bodyPath] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));
const encrypted = fs.readFileSync(encryptedPath, "utf8").trim();
const validKey = (value) => value && typeof value.key_id === "string" && value.key_id.length > 0 &&
  typeof value.key === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value.key);
if (!validKey(before) || !validKey(after) || before.key_id !== after.key_id || before.key !== after.key ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) process.exit(1);
fs.writeFileSync(bodyPath, JSON.stringify({ encrypted_value: encrypted, key_id: before.key_id }), { mode: 0o600 });
NODE
  then
    rm -f "$key_before" "$key_after" "$encrypted_value" "$provider_body"
    return 1
  fi
  rm -f "$key_before" "$key_after" "$encrypted_value"

  # The token exists only in this anonymous pipe. It is never placed in argv,
  # the environment, a shell variable, a log, or a file. A fresh curl process
  # performs exactly one HTTP/1.1 request with retries and redirects disabled.
  if [ -n "$CURL_TEST_UNIX_SOCKET" ]; then
    [ "${REVIEW_ROUTER_SEED_LIBRARY_ONLY:-0}" = "1" ] || fatal "The curl Unix socket is test-only."
    case "$CURL_TEST_UNIX_SOCKET" in
      /*) ;;
      *) fatal "The curl test Unix socket must be an absolute path." ;;
    esac
    case "$CURL_TEST_UNIX_SOCKET" in
      *[!A-Za-z0-9_./-]*) fatal "The curl test Unix socket contains unsafe characters." ;;
    esac
  fi
  curl_max_time=30
  if [ -n "$CURL_TEST_MAX_TIME" ]; then
    [ "${REVIEW_ROUTER_SEED_LIBRARY_ONLY:-0}" = "1" ] || fatal "The curl max-time override is test-only."
    case "$CURL_TEST_MAX_TIME" in
      ''|*[!0-9]*) fatal "The curl test max-time must be an integer." ;;
      *) curl_max_time="$CURL_TEST_MAX_TIME" ;;
    esac
    [ "$curl_max_time" -ge 1 ] || fatal "The curl test max-time must be positive."
  fi
  provider_status="$({
    if [ -n "$CURL_TEST_UNIX_SOCKET" ]; then
      printf 'unix-socket = "%s"\n' "$CURL_TEST_UNIX_SOCKET"
    fi
    printf '%s\n' 'silent' 'show-error' 'request = "PUT"' \
      'url = "https://api.github.com/repos/'"$TARGET_REPO"'/actions/secrets/'"$SECRET_NAME"'"' \
      'http1.1' 'no-location' 'no-keepalive' 'retry = 0' 'proto = "=https"' \
      'connect-timeout = 10' 'max-time = '"$curl_max_time" 'output = "/dev/null"' \
      'header = "Accept: application/vnd.github+json"' \
      'header = "X-GitHub-Api-Version: 2022-11-28"'
    printf 'header = "Authorization: Bearer '
    gh auth token --hostname github.com | tr -d '\r\n'
    printf '"\n'
    printf '%s\n' 'header = "Content-Type: application/json"' \
      'write-out = "%{http_code}"'
  } | curl -q --config - --data-binary "@$provider_body")" || {
    rm -f "$provider_body"
    return 1
  }
  rm -f "$provider_body"
  case "$provider_status" in
    201|204) PROVIDER_PUT_STATUS="$provider_status"; return 0 ;;
    *) return 1 ;;
  esac
}

verify_github_repository_identity() {
  expected_repository_id="$(manifest_value repositoryId)"
  if [ -z "$expected_repository_id" ]; then
    return
  fi
  actual_repository_id="$(gh api "repos/$TARGET_REPO" --jq .id 2>/dev/null || true)"
  [ -n "$actual_repository_id" ] || fatal "Could not verify GitHub repository id for $TARGET_REPO with gh."
  if [ "$actual_repository_id" != "$expected_repository_id" ]; then
    fatal "GitHub repository id mismatch for $TARGET_REPO. Expected $expected_repository_id but got $actual_repository_id."
  fi
}

# Versioned namespace recovery journal. Plaintext exists only in the repo-scoped
# 0600 staged payload; the JSON journal contains hashes, ids, and lifecycle state.
journal_atomic_write() {
  target="$1"
  source="$2"
  node - "$target" "$source" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [target, source] = process.argv.slice(2);
const dir = path.dirname(target);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const existingDir = fs.lstatSync(dir);
if (!existingDir.isDirectory() || existingDir.isSymbolicLink()) throw new Error("unsafe journal directory");
const temporary = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
const bytes = fs.readFileSync(source);
const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
fs.renameSync(temporary, target);
const directoryFd = fs.openSync(dir, fs.constants.O_RDONLY);
try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
NODE
}

journal_assert_safe_file() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const stat = fs.lstatSync(file);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
  process.exit(1);
}
NODE
}

journal_metadata_path() { payload_retry_state_path; }
journal_payload_path() { printf '%s.payload\n' "$(payload_retry_state_path)"; }

journal_read_field() {
  node - "$PAYLOAD_RETRY_STATE" "$1" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))[process.argv[3]];
if (value !== undefined && value !== null) process.stdout.write(String(value));
NODE
}

inspect_payload_retry_state() {
  PAYLOAD_RETRY_STATE="$(journal_metadata_path)"
  STAGED_PAYLOAD_FILE="$(journal_payload_path)"
  if [ ! -e "$PAYLOAD_RETRY_STATE" ]; then
    [ "$REMOTE_PAYLOAD_CLAIMED" != "1" ] || fatal "Server claim exists but the local journal is missing. No PUT will be retried; request a new recovery epoch."
    RETRY_EXISTING_PAYLOAD="0"
    return
  fi
  journal_assert_safe_file "$PAYLOAD_RETRY_STATE" || fatal "Local recovery journal is unsafe or tampered. No secret write was attempted."
  if ! node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(v.stateVersion!==2)process.exit(1)' "$PAYLOAD_RETRY_STATE" 2>/dev/null; then
    fatal "Local recovery journal is tampered; no PUT is allowed. A fresh recovery epoch will retire any authorized namespace permanently."
  fi
  JOURNAL_MAY_HAVE_DISPATCHED="$(journal_read_field mayHaveDispatched)"
  if [ ! -e "$STAGED_PAYLOAD_FILE" ] || ! journal_assert_safe_file "$STAGED_PAYLOAD_FILE"; then
    if [ "$JOURNAL_MAY_HAVE_DISPATCHED" = "true" ]; then
      retire_journal_attempt_or_fail
    fi
    fatal "Staged payload is missing or tampered. The old namespace is retired permanently; request a new recovery epoch."
  fi
  if ! node - "$PAYLOAD_RETRY_STATE" "$STAGED_PAYLOAD_FILE" "$MANIFEST_JSON" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const [journalPath, payloadPath, manifestJson] = process.argv.slice(2);
const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
const manifest = JSON.parse(manifestJson);
const payload = fs.readFileSync(payloadPath);
const digest = crypto.createHash("sha256").update(payload).digest("hex");
if (journal.stateVersion !== 2 || journal.repositoryId !== manifest.repositoryId ||
    journal.providerInstanceId !== manifest.providerInstanceId || journal.setupNonce !== manifest.setupNonce ||
    journal.payloadSha256 !== digest || journal.authByteSize !== payload.length) process.exit(1);
NODE
  then
    if [ "$JOURNAL_MAY_HAVE_DISPATCHED" = "true" ]; then
      retire_journal_attempt_or_fail
    fi
    fatal "Local recovery journal does not match its immutable staged payload; the namespace is retired permanently."
  fi
  AUTH_COMPACT_FILE="$STAGED_PAYLOAD_FILE"
  AUTH_BYTE_LENGTH="$(journal_read_field authByteSize)"
  AUTH_GENERATION_HASH="$(journal_read_field generationHash)"
  AUTH_ACCOUNT_FINGERPRINT="$(journal_read_field accountIdentityHash)"
  OPERATION_ID="$(journal_read_field operationId)"
  ATTEMPT_ID="$(journal_read_field attemptId)"
  SECRET_NAME="$(journal_read_field secretName)"
  RETRY_EXISTING_PAYLOAD="1"
}

stage_payload_and_create_journal() {
  PAYLOAD_RETRY_STATE="$(journal_metadata_path)"
  STAGED_PAYLOAD_FILE="$(journal_payload_path)"
  payload_source="$AUTH_COMPACT_FILE"
  journal_atomic_write "$STAGED_PAYLOAD_FILE" "$payload_source"
  rm -f "$payload_source"
  AUTH_COMPACT_FILE="$STAGED_PAYLOAD_FILE"
  OPERATION_ID="op:$(node -e 'console.log(require("node:crypto").randomUUID())')"
  journal_tmp="$(mktemp)"
  node - "$journal_tmp" "$MANIFEST_JSON" "$STAGED_PAYLOAD_FILE" "$OPERATION_ID" "$AUTH_GENERATION_HASH" "$AUTH_ACCOUNT_FINGERPRINT" "$AUTH_BYTE_LENGTH" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const [out, manifestJson, payloadPath, operationId, generationHash, accountIdentityHash, authByteSize] = process.argv.slice(2);
const manifest = JSON.parse(manifestJson);
const payload = fs.readFileSync(payloadPath);
fs.writeFileSync(out, JSON.stringify({
  stateVersion: 2, payloadVersion: 2, canonicalizationVersion: 1, operationId,
  repositoryFullName: manifest.repositoryFullName, repositoryId: manifest.repositoryId,
  providerInstanceId: manifest.providerInstanceId, setupNonce: manifest.setupNonce,
  generationHash, accountIdentityHash,
  accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
  authByteSize: Number(authByteSize), payloadSha256: crypto.createHash("sha256").update(payload).digest("hex"),
  installerVersion: manifest.installer.version, installerDigest: manifest.installer.sha256,
  lifecycle: "payload_staged", mayHaveDispatched: false,
}), { mode: 0o600 });
NODE
  journal_atomic_write "$PAYLOAD_RETRY_STATE" "$journal_tmp"
  rm -f "$journal_tmp"
}

journal_update() {
  update_kind="$1"
  shift
  journal_tmp="$(mktemp)"
  node - "$PAYLOAD_RETRY_STATE" "$journal_tmp" "$update_kind" "$@" <<'NODE'
const fs = require("node:fs");
const [source, target, kind, ...args] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(source, "utf8"));
if (kind === "claim_response") {
  const response = JSON.parse(fs.readFileSync(args[0], "utf8"));
  if (!/^codex_claim_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(response.claimId)) {
    throw new Error("invalid claim capability");
  }
  Object.assign(state, { claimId: response.claimId, lifecycle: "prepared" });
}
if (kind === "dispatch_request") Object.assign(state, { idempotencyKey: args[0], lifecycle: "dispatch_requested", mayHaveDispatched: false });
if (kind === "attempt") Object.assign(state, { attemptId: args[0], namespaceId: args[1], namespaceEpoch: args[2], secretName: args[3], idempotencyKey: args[4], lifecycle: "dispatch_authorized", mayHaveDispatched: true });
if (kind === "retired") Object.assign(state, { lifecycle: "retired_ambiguous", mayHaveDispatched: true });
if (kind === "confirmed") Object.assign(state, { lifecycle: "confirmed_candidate", mayHaveDispatched: true });
fs.writeFileSync(target, JSON.stringify(state), { mode: 0o600 });
NODE
  journal_atomic_write "$PAYLOAD_RETRY_STATE" "$journal_tmp"
  rm -f "$journal_tmp"
}

compute_manifest_digest() {
  printf '%s' "$MANIFEST_JSON" | node -e 'const crypto=require("node:crypto"),fs=require("node:fs"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(0)).digest("hex"))'
}

prepare_secret_payload_v2() {
  [ -n "$SETUP_PREPARE_URL" ] || fatal "Missing payload prepare URL."
  [ -n "$RECOVERY_EPOCH" ] || fatal "Missing immutable recovery epoch."
  request="$(mktemp)"
  response="$(mktemp)"
  node - "$request" "$MANIFEST_JSON" "$OPERATION_ID" "$(compute_manifest_digest)" "$RECOVERY_EPOCH" "$AUTH_GENERATION_HASH" "$AUTH_ACCOUNT_FINGERPRINT" "$AUTH_BYTE_LENGTH" <<'NODE'
const fs = require("node:fs");
const [out, manifestJson, operationId, manifestDigest, recoveryEpoch, generationHash, accountIdentityHash, authByteSize] = process.argv.slice(2);
const manifest = JSON.parse(manifestJson);
fs.writeFileSync(out, JSON.stringify({ payloadVersion: 2, canonicalizationVersion: 1, operationId,
  repositoryId: manifest.repositoryId, providerInstanceId: manifest.providerInstanceId,
  setupNonce: manifest.setupNonce, manifestDigest, recoveryEpoch, generationHash,
  accountIdentityHash, accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
  authByteSize: Number(authByteSize), installerVersion: manifest.installer.version,
  installerDigest: String(manifest.installer.sha256).toLowerCase() }), { mode: 0o600 });
NODE
  attempt=1
  while [ "$attempt" -le 3 ]; do
    if prepare_http_status="$(curl -q -fsS --max-redirs 0 --connect-timeout 10 --max-time 30 -X POST -H 'content-type: application/json' --data-binary "@$request" "$SETUP_PREPARE_URL" -o "$response" --write-out '%{http_code}')" && is_http_success "$prepare_http_status"; then
      prepare_values="$(node - "$response" <<'NODE'
const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
if (!["prepared","prepared_replay","confirmed_candidate","active"].includes(r.status) ||
    !/^codex_claim_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(r.claimId)) process.exit(1);
process.stdout.write(r.status);
NODE
)" || true
      PREPARE_STATUS="$prepare_values"
      if [ -n "$PREPARE_STATUS" ]; then
        journal_update claim_response "$response"
        rm -f "$request" "$response"
        return
      fi
    fi
    attempt=$((attempt + 1))
  done
  rm -f "$request" "$response"
  fatal "Payload prepare response could not be recovered. No GitHub PUT was authorized."
}

setup_claim_status() {
  [ -n "$SETUP_STATUS_URL" ] || return 1
  status_request="$(mktemp)"
  status_file="$(mktemp)"
  node - "$status_request" "$PAYLOAD_RETRY_STATE" <<'NODE'
const fs=require("node:fs");
const state=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));
if (!/^codex_claim_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(state.claimId)) process.exit(1);
fs.writeFileSync(process.argv[2],JSON.stringify({claimId:state.claimId}),{mode:0o600});
NODE
  if status_http_status="$(curl -q -fsS --max-redirs 0 --connect-timeout 10 --max-time 30 -X POST -H 'content-type: application/json' --data-binary "@$status_request" "$SETUP_STATUS_URL" -o "$status_file" --write-out '%{http_code}')" && is_http_success "$status_http_status"; then
    node - "$status_file" <<'NODE'
const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
if (!["prepared","confirmed_candidate","active"].includes(r.status)) process.exit(1); process.stdout.write(r.status);
NODE
    result="$?"; rm -f "$status_request" "$status_file"; return "$result"
  fi
  rm -f "$status_request" "$status_file"; return 1
}

retire_journal_attempt_or_fail() {
  outcome="$(mktemp)"
  node - "$outcome" "$PAYLOAD_RETRY_STATE" <<'NODE'
const fs=require("node:fs"); const state=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));
if (typeof state.claimId!=="string" || typeof state.attemptId!=="string") process.exit(1);
fs.writeFileSync(process.argv[2], JSON.stringify({claimId:state.claimId,attemptId:state.attemptId,outcome:"unknown"}),{mode:0o600});
NODE
  outcome_http_status="$(curl -q -fsS --max-redirs 0 --connect-timeout 10 --max-time 30 -X POST -H 'content-type: application/json' --data-binary "@$outcome" "$SETUP_DISPATCH_OUTCOME_URL" --output /dev/null --write-out '%{http_code}')" || { rm -f "$outcome"; fatal "Could not durably retire the ambiguous namespace."; }
  case "$outcome_http_status" in
    2??) ;;
    *) rm -f "$outcome"; fatal "Could not durably retire the ambiguous namespace." ;;
  esac
  rm -f "$outcome"
  journal_update retired
}

authorize_new_dispatch() {
  if [ "${PREPARE_STATUS:-}" = "confirmed_candidate" ] || [ "${PREPARE_STATUS:-}" = "active" ]; then
    SECRET_DISPATCH_REQUIRED="0"
    return
  fi
  [ -n "$SETUP_DISPATCH_URL" ] || fatal "Missing dispatch authorization URL."
  if [ -n "${ATTEMPT_ID:-}" ] && [ "$(journal_read_field mayHaveDispatched)" = "true" ]; then
    current_status="$(setup_claim_status || true)"
    if [ "$current_status" = "confirmed_candidate" ] || [ "$current_status" = "active" ]; then
      SECRET_DISPATCH_REQUIRED="0"; return
    fi
    retire_journal_attempt_or_fail
  fi
  idempotency_key="$(journal_read_field idempotencyKey)"
  if [ -z "$idempotency_key" ] || [ "$(journal_read_field lifecycle)" = "retired_ambiguous" ]; then
    idempotency_key="dispatch:$(node -e 'console.log(require("node:crypto").randomUUID())')"
    journal_update dispatch_request "$idempotency_key"
  fi
  request="$(mktemp)"; response="$(mktemp)"
  node - "$request" "$PAYLOAD_RETRY_STATE" <<'NODE'
const fs=require("node:fs"); const state=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));
if (typeof state.claimId!=="string" || typeof state.idempotencyKey!=="string") process.exit(1);
fs.writeFileSync(process.argv[2],JSON.stringify({claimId:state.claimId,idempotencyKey:state.idempotencyKey}),{mode:0o600});
NODE
  dispatch_http_status="$(curl -q -fsS --max-redirs 0 --connect-timeout 10 --max-time 30 -X POST -H 'content-type: application/json' --data-binary "@$request" "$SETUP_DISPATCH_URL" -o "$response" --write-out '%{http_code}')" || { rm -f "$request" "$response"; fatal "Dispatch authorization was not recovered. No PUT was attempted."; }
  case "$dispatch_http_status" in
    2??) ;;
    *) rm -f "$request" "$response"; fatal "Dispatch authorization was not recovered. No PUT was attempted." ;;
  esac
  dispatch_values="$(node - "$response" <<'NODE'
const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
if (r.status!=="dispatch_authorized" || !/^REVIEWROUTER_CODEX_AUTH_JSON_R[1-9][0-9]*_P[a-f0-9]{16}_E[1-9][0-9]*_[a-f0-9]{32}$/.test(r.secretName)) process.exit(1);
console.log([r.attemptId,r.namespaceId,r.namespaceEpoch,r.secretName].join("\t"));
NODE
)" || fatal "Invalid dispatch authorization."
  IFS="$(printf '\t')" read -r ATTEMPT_ID NAMESPACE_ID NAMESPACE_EPOCH SECRET_NAME <<EOF
$dispatch_values
EOF
  journal_update attempt "$ATTEMPT_ID" "$NAMESPACE_ID" "$NAMESPACE_EPOCH" "$SECRET_NAME" "$idempotency_key"
  rm -f "$request" "$response"
}

record_definite_dispatch_success() {
  outcome="$(mktemp)"
  node - "$outcome" "$PAYLOAD_RETRY_STATE" "$PROVIDER_PUT_STATUS" <<'NODE'
const fs=require("node:fs"); const state=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));
if (typeof state.claimId!=="string" || typeof state.attemptId!=="string") process.exit(1);
fs.writeFileSync(process.argv[2],JSON.stringify({claimId:state.claimId,attemptId:state.attemptId,outcome:"definite_success",responseCode:Number(process.argv[4])}),{mode:0o600});
NODE
  attempt=1
  while [ "$attempt" -le 3 ]; do
    if confirmation_http_status="$(curl -q -fsS --max-redirs 0 --connect-timeout 10 --max-time 30 -X POST -H 'content-type: application/json' --data-binary "@$outcome" "$SETUP_DISPATCH_OUTCOME_URL" --output /dev/null --write-out '%{http_code}')"; then
      case "$confirmation_http_status" in
        2??) rm -f "$outcome"; journal_update confirmed; return ;;
      esac
    fi
    attempt=$((attempt + 1))
  done
  rm -f "$outcome"
  fatal "GitHub confirmed the PUT but the confirmation response was lost. Re-run this command; it will use status/confirm only and never repeat the PUT."
}

cleanup() {
  if [ -n "${AUTH_COMPACT_FILE:-}" ] && [ -f "$AUTH_COMPACT_FILE" ] && [ "$AUTH_COMPACT_FILE" != "${STAGED_PAYLOAD_FILE:-}" ]; then
    rm -f "$AUTH_COMPACT_FILE"
  fi
  if [ -n "${AUTH_CANDIDATES_FILE:-}" ] && [ -f "$AUTH_CANDIDATES_FILE" ]; then
    rm -f "$AUTH_CANDIDATES_FILE"
  fi
  if [ -n "${SETUP_RESPONSE_FILE:-}" ] && [ -f "$SETUP_RESPONSE_FILE" ]; then
    rm -f "$SETUP_RESPONSE_FILE"
  fi
  if [ -n "${PREPARE_PAYLOAD_FILE:-}" ] && [ -f "$PREPARE_PAYLOAD_FILE" ]; then
    rm -f "$PREPARE_PAYLOAD_FILE"
  fi
  if [ -n "${PREPARE_RESPONSE_FILE:-}" ] && [ -f "$PREPARE_RESPONSE_FILE" ]; then
    rm -f "$PREPARE_RESPONSE_FILE"
  fi
  if [ -n "${SETUP_NONCE_LOCK_DIR:-}" ] && [ -d "$SETUP_NONCE_LOCK_DIR" ]; then
    rmdir "$SETUP_NONCE_LOCK_DIR" 2>/dev/null || true
  fi
  if [ "${REPOSITORY_SETUP_LOCK_KIND:-}" = "flock" ]; then
    flock -u 9 2>/dev/null || true
    exec 9>&-
  elif [ "${REPOSITORY_SETUP_LOCK_KIND:-}" = "shlock" ] && [ -n "${REPOSITORY_SETUP_LOCK_PATH:-}" ]; then
    rm -f "$REPOSITORY_SETUP_LOCK_PATH"
  fi
}

main() {
  trap cleanup EXIT
  parse_args "$@"
  validate_seed_options
  log "${PRODUCT_NAME} rotating Codex OAuth setup"
  require_cmd node
  require_cmd gh
  require_cmd codex
  require_checksum_tool
  require_cmd curl
  resolve_versioned_ledger_urls
  verify_installer_self_hash
  gh auth status >/dev/null 2>&1 || fatal "gh is not authenticated. Run: gh auth login"
  if [ -n "$MANIFEST_B64" ]; then
    MANIFEST_JSON="$(decode_manifest)"
    TARGET_REPO="$(manifest_value repositoryFullName)"
    if [ -z "$EXPECTED_PROVIDER_INSTANCE_ID" ]; then
      EXPECTED_PROVIDER_INSTANCE_ID="$(manifest_value providerInstanceId)"
    fi
  fi
  [ -n "$TARGET_REPO" ] || fatal "Missing repository. Reopen the ReviewRouter dashboard and copy a fresh setup command."
  validate_repo_name "$TARGET_REPO"

  resolve_codex_home
  acquire_repository_setup_lock
  if [ -z "$MANIFEST_B64" ]; then
    fetch_setup_manifest
    MANIFEST_JSON="$(decode_manifest)"
    TARGET_REPO="$(manifest_value repositoryFullName)"
    if [ -z "$EXPECTED_PROVIDER_INSTANCE_ID" ]; then
      EXPECTED_PROVIDER_INSTANCE_ID="$(manifest_value providerInstanceId)"
    fi
  fi
  write_dedicated_codex_config
  assert_auth_file_is_repo_scoped
  assert_manifest_not_reused
  inspect_payload_retry_state
  if [ "$RETRY_EXISTING_PAYLOAD" != "1" ]; then
    run_codex_login_if_needed
  fi
  TARGET_REPO="$(manifest_value repositoryFullName)"
  verify_github_repository_identity
  if [ "$RETRY_EXISTING_PAYLOAD" != "1" ]; then
    resolved_auth_file="$(resolve_auth_file)" || fatal "Could not find a Codex auth file in $CODEX_HOME_DIR. Run codex login with the dedicated CODEX_HOME and retry."
    validate_and_compact_auth "$resolved_auth_file"
    if is_true "$DRY_RUN"; then
      log "[dry-run] one-shot encrypted GitHub PUT for a server-authorized versioned namespace in $TARGET_REPO"
      ok "Validated versioned rotating auth payload for $TARGET_REPO (dry run)."
      return
    fi
    stage_payload_and_create_journal
  fi
  confirm_secret_write
  assert_manifest_write_window
  prepare_secret_payload_v2
  authorize_new_dispatch
  if [ "$SECRET_DISPATCH_REQUIRED" = "1" ]; then
    if ! write_github_secret; then
      retire_journal_attempt_or_fail
      fatal "GitHub PUT outcome is unknown. That versioned secret name is permanently retired; rerun to allocate a never-used name."
    fi
    mark_ci_owned_auth_state
    record_definite_dispatch_success
  fi
  mark_manifest_used

  if [ -n "${STAGED_PAYLOAD_FILE:-}" ] && [ -f "$STAGED_PAYLOAD_FILE" ]; then
    rm -f "$STAGED_PAYLOAD_FILE"
    node - "$(dirname "$STAGED_PAYLOAD_FILE")" <<'NODE'
const fs=require("node:fs"); const fd=fs.openSync(process.argv[2],fs.constants.O_RDONLY); try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
NODE
    AUTH_COMPACT_FILE=""
  fi

  ok "Stored versioned namespace $SECRET_NAME for $TARGET_REPO; workflow attestation is required before activation."
  info "Dedicated CODEX_HOME: $CODEX_HOME_DIR"
  info "Next step: open or update a private same-repository pull request. The beta workflow is advisory-only."
}

if [ "${REVIEW_ROUTER_SEED_LIBRARY_ONLY:-0}" != "1" ]; then
  main "$@"
fi
