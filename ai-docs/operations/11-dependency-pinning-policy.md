# Dependency Pinning Policy

## Why This Matters

ReviewRouter generates workflows that run in customer repositories. Dependencies in generated workflows are part of the customer's supply chain.

## Generated Workflow Defaults

For SaaS-generated workflows:

- ReviewRouter Action should be pinned to an explicit release tag by default
- third-party actions should use stable version tags initially for usability
- offer a stricter pin-to-SHA mode later for enterprise/security-focused users
- never default customer workflows to ReviewRouter `main`

## Critical Actions

Critical actions include:

```text
actions/checkout
actions/setup-node
actions/create-github-app-token
ReviewRouter Action
```

Policy:

- ReviewRouter Action: explicit vetted release tag by default
- GitHub-owned actions: major version tags acceptable for beta, document tradeoff
- third-party non-GitHub actions: avoid unless necessary; prefer first-party or inline code

## Lockfiles and App Dependencies

SaaS repo:

- lockfile committed
- dependency updates through PR
- CI runs tests/typecheck/build
- dependency review before public launch

## Future Enterprise Mode

Offer generated workflow option:

```text
pinActionsToSha: true
```

This should resolve action versions to full commit SHA and show update PRs when SHA changes.

## Tests

- generated workflow uses explicit ReviewRouter release tag by default
- `main` requires explicit opt-in
- dependency update changes workflow snapshot intentionally
