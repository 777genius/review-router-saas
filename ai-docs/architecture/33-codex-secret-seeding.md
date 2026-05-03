# Codex Secret Seeding

## Goal

Make Codex OAuth setup convenient without sending `auth.json` to ReviewRouter SaaS.

## Decision

Ship a separate narrow `curl | bash` secret-seeding script for Codex OAuth.

The script:

- finds `~/.codex/auth.json` or `$CODEX_HOME/auth.json`
- validates `auth_mode=chatgpt`
- validates `tokens.refresh_token` exists
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
curl -fsSL https://app.reviewrouter.dev/install/codex | REVIEW_ROUTER_REPO=owner/repo bash
```

## Repo Secret Flow

```bash
curl -fsSL https://app.reviewrouter.dev/install/codex | \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_SECRET_SCOPE=repo \
  bash
```

Equivalent direct command:

```bash
gh secret set CODEX_AUTH_JSON --repo owner/repo < ~/.codex/auth.json
```

## Org Selected-Repositories Flow

```bash
curl -fsSL https://app.reviewrouter.dev/install/codex | \
  REVIEW_ROUTER_SECRET_SCOPE=org \
  REVIEW_ROUTER_ORG=my-org \
  REVIEW_ROUTER_ORG_SECRET_REPOS=repo-a,repo-b \
  bash
```

Equivalent direct command:

```bash
gh secret set CODEX_AUTH_JSON --org my-org --repos repo-a,repo-b --app actions < ~/.codex/auth.json
```

The selected-repositories scope is important. Do not use organization `visibility=all` for personal Codex OAuth credentials.

## Cross-Platform Scope

v1 script target:

```text
macOS
Linux
Windows Git Bash / WSL where gh and bash are available
```

Future PowerShell script:

```text
irm https://app.reviewrouter.dev/install/codex.ps1 | iex
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
