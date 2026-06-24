#!/usr/bin/env bash
# Seed ReviewRouter rotating Codex OAuth auth into one repository secret.
# This mode is intentionally separate from scripts/seed-codex-auth.sh.

set -Eeuo pipefail

PRODUCT_NAME="ReviewRouter"
SECRET_NAME="REVIEWROUTER_CODEX_AUTH_JSON"
MANIFEST_B64="${REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64:-}"
SETUP_URL="${REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL:-}"
SETUP_CONFIRM_URL="${REVIEW_ROUTER_CODEX_ROTATING_SETUP_CONFIRM_URL:-}"
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
CONFIRM_WRITE="${REVIEW_ROUTER_CONFIRM_WRITE:-${REVIEW_ROUTER_YES:-0}}"
SKIP_LOGIN="${REVIEW_ROUTER_SKIP_CODEX_LOGIN:-0}"
FORCE_RESEED="${REVIEW_ROUTER_FORCE_CODEX_RESEED:-0}"
REUSE_EXISTING_AUTH="${REVIEW_ROUTER_REUSE_EXISTING_CODEX_AUTH_I_KNOW_IT_IS_CURRENT:-0}"
CODEX_LOGIN_METHOD="${REVIEW_ROUTER_CODEX_LOGIN_METHOD:-auto}"
LOGIN_CREATED_AUTH="0"

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
  --setup-confirm-url val  HTTPS URL used to confirm a successful setup.
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

The installer is repo-scoped only and writes REVIEWROUTER_CODEX_AUTH_JSON
directly to GitHub Actions secrets through gh. ReviewRouter SaaS does not
receive plaintext auth.json.

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
      --setup-confirm-url)
        shift
        require_arg "--setup-confirm-url" "${1:-}"
        SETUP_CONFIRM_URL="$1"
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
  if [ -z "$MANIFEST_B64" ]; then
    fetch_setup_manifest
  fi
  [ -n "$MANIFEST_B64" ] || fatal "Missing setup manifest. Reopen the ReviewRouter dashboard and copy the current rotating Codex command."

  node - "$MANIFEST_B64" "$TARGET_REPO" "$INSTALLER_URL" "$INSTALLER_VERSION" "$INSTALLER_SHA256" "$EXPECTED_PROVIDER_INSTANCE_ID" <<'NODE'
const encoded = process.argv[2];
const expectedRepo = process.argv[3] || "";
const installerUrl = process.argv[4] || "";
const installerVersion = process.argv[5] || "";
const installerSha256 = (process.argv[6] || "").toLowerCase();
const expectedProviderInstanceId = process.argv[7] || "";
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
const required = [
  "protocolVersion",
  "repositoryFullName",
  "providerInstanceId",
  "setupNonce",
  "secretName",
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
if (manifest.protocolVersion !== 1) fail("setup manifest protocol version is unsupported");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(manifest.repositoryFullName)) fail("setup manifest repository is invalid");
if (expectedRepo && manifest.repositoryFullName !== expectedRepo) fail("setup manifest repository does not match --repo");
if (expectedProviderInstanceId && manifest.providerInstanceId !== expectedProviderInstanceId) fail("setup manifest provider does not match installer command");
if (manifest.secretName !== "REVIEWROUTER_CODEX_AUTH_JSON") fail("setup manifest secret name is invalid");
if (manifest.authMode !== "codex_subscription_oauth_rotating") fail("setup manifest auth mode is invalid");
if (!manifest.installer || typeof manifest.installer !== "object") fail("setup manifest installer is invalid");
if (installerUrl && manifest.installer.url !== installerUrl) fail("setup manifest installer URL mismatch");
if (installerVersion && manifest.installer.version !== installerVersion) fail("setup manifest installer version mismatch");
if (installerSha256 && String(manifest.installer.sha256).toLowerCase() !== installerSha256) fail("setup manifest installer SHA256 mismatch");
const expiresAt = Date.parse(manifest.expiresAt);
if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) fail("setup manifest expired; reopen the dashboard and copy a fresh command");
if (!/^[A-Za-z0-9_-]{22,}$/.test(manifest.generationHashSalt)) fail("setup manifest generation salt is invalid");
if (!/^[A-Za-z0-9_-]{22,}$/.test(manifest.accountFingerprintSalt)) fail("setup manifest account salt is invalid");
console.log(JSON.stringify(manifest));
NODE
}

fetch_setup_manifest() {
  [ -n "$SETUP_URL" ] || fatal "Missing setup manifest URL. Reopen the ReviewRouter dashboard and copy the current rotating Codex command."
  [ -n "$SETUP_NONCE" ] || fatal "Missing setup nonce. Reopen the ReviewRouter dashboard and copy the current rotating Codex command."
  case "$SETUP_URL" in
    https://*|http://localhost:*|http://127.0.0.1:*|http://*.localhost:*) ;;
    *) fatal "Setup manifest URL must be HTTPS or localhost HTTP." ;;
  esac

  SETUP_RESPONSE_FILE="$(mktemp)"
  curl -fsSL --get --data-urlencode "nonce=$SETUP_NONCE" "$SETUP_URL" -o "$SETUP_RESPONSE_FILE"
  MANIFEST_B64="$(node - "$SETUP_RESPONSE_FILE" <<'NODE'
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
if (!parsed || typeof parsed.manifestBase64 !== "string" || parsed.manifestBase64.length === 0) {
  fail("setup manifest response is missing manifestBase64");
}
console.log(parsed.manifestBase64);
NODE
  )"
  rm -f "$SETUP_RESPONSE_FILE"
  SETUP_RESPONSE_FILE=""
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
  console.error(message);
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
} catch (error) {
  fail(`auth.json is not valid JSON: ${error.message}`);
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
const accountInput = parsed.tokens.id_token || parsed.tokens.refresh_token;
const accountFingerprint = crypto.createHmac("sha256", accountSalt).update(accountInput, "utf8").digest("base64url");
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
  warn "This will create or overwrite $SECRET_NAME for $TARGET_REPO."
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

write_github_secret() {
  if is_true "$DRY_RUN"; then
    log "[dry-run] gh secret set $SECRET_NAME --repo $TARGET_REPO --app actions < $AUTH_COMPACT_FILE"
    return
  fi
  gh secret set "$SECRET_NAME" --repo "$TARGET_REPO" --app actions < "$AUTH_COMPACT_FILE" >/dev/null
}

auth_size_bucket() {
  size="$1"
  if [ "$size" -le 4096 ]; then
    printf '0-4KiB'
  elif [ "$size" -le 8192 ]; then
    printf '4-8KiB'
  elif [ "$size" -le 16384 ]; then
    printf '8-16KiB'
  else
    printf '16-32KiB'
  fi
}

confirm_setup_success() {
  if is_true "$DRY_RUN" || [ -z "$SETUP_CONFIRM_URL" ]; then
    return
  fi
  [ -n "${AUTH_GENERATION_HASH:-}" ] || fatal "Missing generation hash for setup confirmation."
  [ -n "${AUTH_ACCOUNT_FINGERPRINT:-}" ] || fatal "Missing account fingerprint for setup confirmation."
  repository_id="$(manifest_value repositoryId)"
  provider_instance_id="$(manifest_value providerInstanceId)"
  setup_nonce="$(manifest_value setupNonce)"
  size_bucket="$(auth_size_bucket "$AUTH_BYTE_LENGTH")"
  SETUP_CONFIRM_PAYLOAD_FILE="$(mktemp)"
  node - "$SETUP_CONFIRM_PAYLOAD_FILE" "$repository_id" "$provider_instance_id" "$setup_nonce" "$SECRET_NAME" "$AUTH_GENERATION_HASH" "$AUTH_ACCOUNT_FINGERPRINT" "$size_bucket" "$INSTALLER_VERSION" <<'NODE'
const fs = require("node:fs");
const [
  path,
  repositoryId,
  providerInstanceId,
  setupNonce,
  secretName,
  generationHash,
  accountFingerprint,
  authByteSizeBucket,
  installerVersion,
] = process.argv.slice(2);
fs.writeFileSync(
  path,
  JSON.stringify({
    protocolVersion: 1,
    repositoryId,
    providerInstanceId,
    setupNonce,
    secretName,
    generationHash,
    accountFingerprint,
    authByteSizeBucket,
    installerVersion,
  }),
  { mode: 0o600 },
);
NODE
  curl -fsSL -X POST \
    -H 'content-type: application/json' \
    --data-binary "@$SETUP_CONFIRM_PAYLOAD_FILE" \
    "$SETUP_CONFIRM_URL" >/dev/null
  rm -f "$SETUP_CONFIRM_PAYLOAD_FILE"
  SETUP_CONFIRM_PAYLOAD_FILE=""
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

cleanup() {
  if [ -n "${AUTH_COMPACT_FILE:-}" ] && [ -f "$AUTH_COMPACT_FILE" ]; then
    rm -f "$AUTH_COMPACT_FILE"
  fi
  if [ -n "${AUTH_CANDIDATES_FILE:-}" ] && [ -f "$AUTH_CANDIDATES_FILE" ]; then
    rm -f "$AUTH_CANDIDATES_FILE"
  fi
  if [ -n "${SETUP_RESPONSE_FILE:-}" ] && [ -f "$SETUP_RESPONSE_FILE" ]; then
    rm -f "$SETUP_RESPONSE_FILE"
  fi
  if [ -n "${SETUP_CONFIRM_PAYLOAD_FILE:-}" ] && [ -f "$SETUP_CONFIRM_PAYLOAD_FILE" ]; then
    rm -f "$SETUP_CONFIRM_PAYLOAD_FILE"
  fi
  if [ -n "${SETUP_NONCE_LOCK_DIR:-}" ] && [ -d "$SETUP_NONCE_LOCK_DIR" ]; then
    rmdir "$SETUP_NONCE_LOCK_DIR" 2>/dev/null || true
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
  verify_installer_self_hash
  gh auth status >/dev/null 2>&1 || fatal "gh is not authenticated. Run: gh auth login"
  MANIFEST_JSON="$(decode_manifest)"
  TARGET_REPO="$(manifest_value repositoryFullName)"
  validate_repo_name "$TARGET_REPO"
  verify_github_repository_identity

  resolve_codex_home
  write_dedicated_codex_config
  assert_auth_file_is_repo_scoped
  assert_manifest_not_reused
  run_codex_login_if_needed
  resolved_auth_file="$(resolve_auth_file)" || fatal "Could not find a Codex auth file in $CODEX_HOME_DIR. Run codex login with the dedicated CODEX_HOME and retry."
  validate_and_compact_auth "$resolved_auth_file"
  confirm_secret_write
  write_github_secret
  mark_ci_owned_auth_state
  confirm_setup_success
  mark_manifest_used

  ok "Stored $SECRET_NAME for $TARGET_REPO"
  info "Dedicated CODEX_HOME: $CODEX_HOME_DIR"
  info "Next step: open or update a private same-repository pull request. The beta workflow is advisory-only."
}

main "$@"
