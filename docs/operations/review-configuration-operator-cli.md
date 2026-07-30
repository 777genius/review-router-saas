# Review Configuration Operator CLI

Use the operator CLI to inspect or pin a repository's review reasoning effort
without opening the ReviewRouter dashboard or signing in to GitHub.

## Security Boundary

The CLI calls the ReviewRouter API over HTTPS. It does not use GitHub OAuth,
GitHub cookies, Prisma, or direct database access.

- The server stores only
  `REVIEW_ROUTER_REVIEW_CONFIG_OPERATOR_CREDENTIAL_SHA256`.
- The plaintext credential stays in a local mode-`0600` profile.
- The CLI rejects non-regular profiles or profiles readable by group/others on
  POSIX systems.
- The credential is bound to the API URL in that profile.
- Redirects, URL credentials, query strings, fragments, non-root base paths,
  and non-HTTPS remote URLs are rejected.
- The credential is never accepted as a command-line argument.
- Reads and writes are rate-limited and audited without credential values.
- Only selected, non-archived repositories with an active provider
  installation can be changed.

Do not reuse `REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL`. That credential can
control Review v2 rollout and emergency mutation authority and intentionally has
a separate trust boundary.

## Build And Install

From a trusted ReviewRouter checkout:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm link --global
reviewrouter --help
```

The `reviewrouter` binary runs the compiled thin client. It does not load the
server environment or connect to Postgres.

## Create A Host-Bound Profile

Generate a dedicated credential once:

```bash
set -euo pipefail
umask 077
profile_dir="${XDG_CONFIG_HOME:-$HOME/.config}/reviewrouter"
profile_path="$profile_dir/operator.json"
credential="$(openssl rand -base64 48 | tr -d '\n')"
mkdir -p "$profile_dir"
jq -n \
  --arg apiUrl "https://api.reviewrouter.example.com" \
  --arg credential "$credential" \
  '{apiUrl: $apiUrl, credential: $credential}' > "$profile_path"
chmod 600 "$profile_path"
printf %s "$credential" | shasum -a 256 | awk '{print $1}'
unset credential
```

Store only the printed digest in the API service as:

```text
REVIEW_ROUTER_REVIEW_CONFIG_OPERATOR_CREDENTIAL_SHA256=<sha256>
```

Restart or redeploy the API after setting it. Do not put the plaintext value in
Render, Compose `.env`, CI secrets, shell history, or GitHub secrets.

For isolated automation, the CLI also accepts
`REVIEW_ROUTER_REVIEW_CONFIG_OPERATOR_CREDENTIAL` together with an explicit
`REVIEW_ROUTER_API_URL`. Both must be set; there is no implicit hosted URL.

## Commands

Read the effective repository, workspace, or global-default result:

```bash
reviewrouter config get --repo 777genius/agent-teams-ai
```

Pin a repository-specific effort:

```bash
reviewrouter config set \
  --repo 777genius/agent-teams-ai \
  --effort xhigh
```

Allowed effort values are `low`, `medium`, `high`, and `xhigh`.

If the same repository exists in multiple workspaces, qualify it by workspace
ID or slug:

```bash
reviewrouter config set \
  --repo Padelapp-Club/monorepository \
  --workspace padelapp \
  --effort high
```

Use a non-default profile explicitly when operating another control plane:

```bash
reviewrouter config get \
  --repo OWNER/REPOSITORY \
  --profile ~/.config/reviewrouter/staging-operator.json
```

`config set` updates the complete repository configuration snapshot and is
idempotent when that explicit snapshot already has the requested effort. It
changes only the first Codex-backed provider selected by the runtime and leaves
all other provider rows untouched. A repository-level pin intentionally stops
inheriting later workspace/default effort changes.

## Error Contract

The CLI prints stable, sanitized error codes:

- `unauthorized` - profile and server digest do not match.
- `repository_not_found` - no active selected repository matches.
- `repository_ambiguous` - add `--workspace`.
- `rate_limited` - wait for the operator window to reset.
- `review_provider_not_found` - the effective config has no Codex-backed provider.
- `invalid_request` - command input is outside the API contract.

API responses use `Cache-Control: no-store`. Server logs and audit metadata must
never contain the Authorization header or profile contents.
