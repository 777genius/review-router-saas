#!/usr/bin/env bash
set -euo pipefail

API_URL="${REVIEW_ROUTER_CODEX_RESEED_API_URL:-https://reviewrouter.site/api/codex-rotating/cli/setup-command}"
REPOSITORY=""
REUSE_CURRENT_AUTH="false"
TEMP_DIR=""

cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT HUP INT TERM

usage() {
  cat <<'USAGE'
Usage:
  reseed-codex-rotating-auth.sh --repo OWNER/REPO [--reuse-current-auth]

Options:
  --repo OWNER/REPO       GitHub repository connected to ReviewRouter.
  --reuse-current-auth    Reuse the dedicated ReviewRouter auth created locally.
                          Default behavior performs a fresh isolated Codex login.
USAGE
}

fatal() {
  printf 'ReviewRouter Codex reseed failed: %s\n' "$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      shift
      [ -n "${1:-}" ] || fatal "--repo requires OWNER/REPO"
      REPOSITORY="$1"
      ;;
    --reuse-current-auth)
      REUSE_CURRENT_AUTH="true"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fatal "Unknown option: $1"
      ;;
  esac
  shift
done

printf '%s' "$REPOSITORY" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || fatal "--repo must be OWNER/REPO"
command -v gh >/dev/null 2>&1 || fatal "gh is required"
command -v curl >/dev/null 2>&1 || fatal "curl is required"
command -v node >/dev/null 2>&1 || fatal "node is required"

if ! node - "$API_URL" <<'NODE'
const value = process.argv[2];
let url;
try {
  url = new URL(value);
} catch {
  process.exit(1);
}
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.hash
) {
  process.exit(1);
}
NODE
then
  fatal "setup API URL must be credential-free HTTPS"
fi

umask 077
TEMP_DIR="$(mktemp -d)"
HEADER_FILE="$TEMP_DIR/github-header"
BODY_FILE="$TEMP_DIR/request.json"
RESPONSE_FILE="$TEMP_DIR/response.json"
COMMAND_FILE="$TEMP_DIR/setup.sh"

GITHUB_TOKEN="$(gh auth token 2>/dev/null)" || fatal "gh is not authenticated"
[ -n "$GITHUB_TOKEN" ] || fatal "gh returned an empty token"
printf 'Authorization: Bearer %s\n' "$GITHUB_TOKEN" > "$HEADER_FILE"
unset GITHUB_TOKEN

node - "$BODY_FILE" "$REPOSITORY" "$REUSE_CURRENT_AUTH" <<'NODE'
const fs = require("node:fs");
const [path, repository, reuseCurrentAuth] = process.argv.slice(2);
fs.writeFileSync(path, JSON.stringify({
  repository,
  reuseCurrentAuth: reuseCurrentAuth === "true",
}));
NODE

http_status="$(curl -q --fail-with-body --silent --show-error \
  --proto '=https' \
  --max-redirs 0 \
  --connect-timeout 10 \
  --max-time 30 \
  --retry 0 \
  --output "$RESPONSE_FILE" \
  --write-out '%{http_code}' \
  --request POST \
  --header "@$HEADER_FILE" \
  --header 'Content-Type: application/json' \
  --data-binary "@$BODY_FILE" \
  "$API_URL")" || fatal "setup API request failed"

node - "$RESPONSE_FILE" "$COMMAND_FILE" "$http_status" <<'NODE'
const fs = require("node:fs");
const [responsePath, commandPath, status] = process.argv.slice(2);
let body;
try {
  body = JSON.parse(fs.readFileSync(responsePath, "utf8"));
} catch {
  console.error(`ReviewRouter setup API returned invalid JSON (HTTP ${status}).`);
  process.exit(1);
}
if (!/^2\d\d$/.test(status) || typeof body.command !== "string") {
  const code = typeof body.error === "string" ? body.error : "unknown_error";
  console.error(`ReviewRouter setup API rejected the request: ${code} (HTTP ${status}).`);
  process.exit(1);
}
fs.writeFileSync(commandPath, body.command, { mode: 0o700 });
NODE

rm -f "$HEADER_FILE" "$BODY_FILE" "$RESPONSE_FILE"
bash "$COMMAND_FILE"
