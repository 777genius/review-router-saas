# Codex Secret Seeding

## Goal

Make Codex OAuth setup convenient without sending `auth.json` to ReviewRouter SaaS.

## Decision

Ship a separate narrow `curl | bash` secret-seeding script for Codex OAuth.

The script:

- finds legacy `~/.codex/auth.json`, `$CODEX_HOME/auth.json`, or the active Codex account auth under `$CODEX_HOME/accounts/*.auth.json`
- validates `auth_mode=chatgpt`
- validates `tokens.refresh_token` exists
- fails with a clear `reseed auth.json` recovery hint before any `gh secret set`
- warns when `last_refresh` is missing, unparsable, or older than the configured freshness window
- stores `CODEX_AUTH_JSON` directly in GitHub Actions secrets using `gh secret set`
- supports repository secrets and organization selected-repository secrets
- skips `CODEX_CONFIG_TOML` by default
- never sends the secret to ReviewRouter SaaS

Local scaffold:

```text
scripts/seed-codex-auth.sh
```

Future hosted command:

```bash
curl -fsSL https://reviewrouter.site/install/codex | bash -s -- --confirm-write --scope repo --repo owner/repo
```

## Repo Secret Flow

```bash
curl -fsSL https://reviewrouter.site/install/codex | \
  bash -s -- --confirm-write --scope repo --repo owner/repo
```

Legacy-only direct command:

```bash
gh secret set CODEX_AUTH_JSON --repo owner/repo < ~/.codex/auth.json
```

For newer Codex CLI installs, the source file may instead be the active account auth resolved from:

```text
~/.codex/accounts/registry.json
~/.codex/accounts/<active-account>.auth.json
```

Do not hand-build this path in user-facing docs. Prefer `scripts/seed-codex-auth.sh`, because it validates the active account and avoids printing secrets.

Direct local dry-run:

```bash
bash scripts/seed-codex-auth.sh --dry-run --repo owner/repo
```

If a team wants a stricter warning threshold during onboarding:

```bash
bash scripts/seed-codex-auth.sh --dry-run --repo owner/repo --stale-days 7
```

## Org Selected-Repositories Flow

```bash
curl -fsSL https://reviewrouter.site/install/codex | \
  bash -s -- --confirm-write --scope org --org my-org --visibility selected --repos repo-a,repo-b
```

Legacy-only direct command:

```bash
gh secret set CODEX_AUTH_JSON --org my-org --repos repo-a,repo-b --app actions < ~/.codex/auth.json
```

Direct local confirmed write:

```bash
bash scripts/seed-codex-auth.sh --confirm-write --scope org --org my-org --repos repo-a,repo-b
```

The selected-repositories scope is important. Do not use organization `visibility=all` for personal Codex OAuth credentials.

Dashboard and setup pages must show the exact selected repositories before displaying the command. For organization installs the recommended command should default to:

```text
--scope org
--org <org>
--visibility selected
--repos <selected repo names>
```

This prevents accidental all-organization secret exposure.

## Cross-Platform Scope

v1 script target:

```text
macOS
Linux
Windows Git Bash / WSL where gh and bash are available
```

Future PowerShell script:

```text
irm https://reviewrouter.site/install/codex.ps1 | iex
```

Do not block beta on PowerShell if bash flow is documented clearly.

## Why Not Browser Upload First

Browser-side encrypted upload can be a better UX later, but it is riskier:

- browser file handling for personal OAuth credentials
- GitHub public-key encryption implementation
- token permission confusion
- more security review before public launch

The CLI script is simpler and keeps the plaintext secret local.

## Existing Code Reuse

The current open-source installer already has useful logic:

```text
verify_codex_auth_file
set_repo_secret_from_file
org selected-repo secret support
CODEX_CONFIG_TOML disabled by default
org selected-repo e2e smoke checks
```

The old `scripts/setup-cli-secrets.sh` should not be reused as-is because it can set organization secrets with broad visibility and mixes Claude/Gemini/Codex. The SaaS seeding script must stay narrow and conservative.

## Auth Freshness

GitHub-hosted runners are ephemeral. If Codex refreshes `auth.json` during a run, the refreshed file disappears after the job.

The seeding script and generated workflow preflight intentionally do not fail only because `last_refresh` is old. They warn first, because a refresh token can still work even when the access token metadata is old. Hard failure is reserved for malformed JSON, non-ChatGPT auth mode, or missing refresh token.

User-facing guidance:

```text
If ReviewRouter says Codex auth is stale, run codex login on a trusted machine and rerun the secret seeding command.
```

For fully automatic long-lived refresh:

```text
trusted self-hosted runner with persistent CODEX_HOME
```

## Security Notes

- Fork PRs do not receive Actions secrets by default, and ReviewRouter also skips secret-backed fork review.
- Same-repository workflow changes can access secrets after merge or trusted execution. Protect `.github/workflows/**` with branch protection and CODEOWNERS.
- Repository collaborators normally cannot read secret values in GitHub UI, but malicious workflow changes are the practical risk.
