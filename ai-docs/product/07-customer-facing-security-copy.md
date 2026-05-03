# Customer-Facing Security Copy

## Short Privacy Copy

ReviewRouter manages configuration and setup. Your code review runs inside your GitHub Actions workflow. In v1, ReviewRouter SaaS does not store your repository code, pull request diffs, Codex OAuth files, or model API keys.

## Codex OAuth Copy

Codex subscription auth stays in your GitHub repo/org secrets or trusted self-hosted runner. ReviewRouter SaaS only tracks setup status and health metadata.

## Fork PR Copy

For security, ReviewRouter skips secret-backed AI review on fork pull requests by default. A maintainer-controlled trusted rerun flow can be added later, but it is intentionally not automatic.

## Same-Repository PR Copy

Same-repository pull requests can access more CI capabilities than fork pull requests. Protect workflow files with branch protection and CODEOWNERS if your repository has many contributors.

## Permission Copy

ReviewRouter opens pull requests to add or update its workflow. It does not push directly to your default branch by default.

## OIDC Copy

ReviewRouter uses GitHub Actions OIDC so the workflow can fetch current ReviewRouter configuration without storing a long-lived ReviewRouter API token in your repository.

## Uninstall Copy

Uninstalling the GitHub App disconnects ReviewRouter from your repositories. Existing workflow files remain in your repository until you remove them through a pull request.
