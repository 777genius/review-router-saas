# Supply Chain Security

## Why This Matters

ReviewRouter provisions CI workflows into customer repositories. A compromised dependency, release, or action tag could affect customer CI environments.

## Dependency Policy

- use lockfiles
- use Renovate or Dependabot
- review dependency updates
- avoid unnecessary runtime dependencies
- pin critical GitHub Actions by version or digest where practical
- track licenses before public launch

## Release Policy

For ReviewRouter Action:

- publish release tags intentionally
- avoid force-moving release tags
- keep `main` available for users who opt into live updates
- default SaaS install should use stable/release channel unless user chooses main

For SaaS:

- deploy from protected branch
- require CI green before deploy
- keep rollback path
- separate staging and production GitHub Apps if possible

## Secrets in CI

- never echo secrets
- redact known secret patterns
- generated workflows should use least privileges
- fork PRs skip secret-backed review by default

## GitHub App Key Handling

- store App private key only in deployment secret manager
- rotate key with runbook
- do not store key in repo
- do not expose key to frontend

## Future Hardening

- SLSA/provenance for action releases
- artifact signing
- dependency review gate
- secret scanning
- CodeQL or equivalent static analysis
- branch protection for release branches/tags
