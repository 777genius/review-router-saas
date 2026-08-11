# Codex Secret Seeding

## Status

Superseded.

This document originally selected a stable `CODEX_AUTH_JSON` secret and
`curl | bash` installer. Neither is a supported SaaS setup path. It is retained
only as the record of that retired decision; do not use its old commands or
secret model for onboarding, recovery, testing, or compatibility.

## Current Decision

Start Codex setup or recovery from **Dashboard → Enable review → Codex**. The
dashboard issues the complete command for the selected repository. That command
uses the current control-plane setup protocol and a repository-scoped,
versioned secret namespace; it does not install or preserve the stable
`CODEX_AUTH_JSON` secret.

The dashboard command pins the installer to the exact 40-character Action
commit configured for the repository and includes an independently issued
SHA-256 digest. On the trusted operator machine it downloads to a private
temporary file with ambient curl configuration disabled, rejects redirects and
non-HTTPS URLs, applies connection and total deadlines with retries disabled,
verifies the digest, and only then executes the file. A command using a branch,
tag, `main`, an unverified local script, or a curl-to-shell pipe is not an
equivalent setup path.

The setup performs a fresh Codex login inside the repository's dedicated
ReviewRouter `CODEX_HOME`. It uses the operator's current GitHub CLI identity
for the scoped permission and secret-write steps while keeping plaintext Codex
credentials off ReviewRouter SaaS. The control plane confirms the versioned
generation before enabling work.

## Security Boundary

- Never upload `auth.json` to ReviewRouter SaaS.
- Never restore the retired stable `CODEX_AUTH_JSON` secret as a compatibility
  shortcut.
- Never widen a personal Codex credential to organization-wide visibility.
- Protect `.github/workflows/**` with branch protection and CODEOWNERS because
  trusted same-repository workflow changes can consume Actions secrets.
- Fork pull requests do not receive Actions secrets by default, and
  ReviewRouter skips secret-backed fork review.

If setup reports stale or invalid Codex authentication, run `codex login` when
prompted by the verified dashboard installer. Do not copy a guessed Codex
account-file path or hand-author a `gh secret set` command.
