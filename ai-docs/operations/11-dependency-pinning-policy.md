# Dependency Pinning Policy

## Why This Matters

ReviewRouter generates workflows that run in customer repositories. Dependencies in generated workflows are part of the customer's supply chain.

## Generated Workflow Defaults

For public production SaaS-generated workflows:

- ReviewRouter Action should be pinned to an explicit release tag by default
- third-party actions should use stable version tags initially for usability
- offer a stricter pin-to-SHA mode later for enterprise/security-focused users
- never default production customer workflows to ReviewRouter `main`

For local/private beta smoke installs:

- default ReviewRouter Action to `777genius/review-router@main`
- reason: the current runtime is still moving quickly, and test installs must pick up bug fixes without a release cut
- make this beta exception explicit in `.env.example`, docs, and generated setup output
- switch the production default back to a vetted release tag before public launch

## Critical Actions

Critical actions include:

```text
actions/checkout
actions/setup-node
actions/create-github-app-token
ReviewRouter Action
```

Production policy:

- ReviewRouter Action: explicit vetted release tag by default
- GitHub-owned actions: major version tags acceptable for beta, document tradeoff
- third-party non-GitHub actions: avoid unless necessary; prefer first-party or inline code

Local beta policy:

- ReviewRouter Action: `777genius/review-router@main` unless `REVIEW_ROUTER_ACTION_REF` or `REVIEW_ROUTER_ACTION_VERSION` overrides it
- GitHub-owned actions: major version tags acceptable
- every real smoke should record which action ref was generated

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

- production generated workflow uses explicit ReviewRouter release tag by default
- local beta generated workflow uses `777genius/review-router@main` by default
- `main` requires explicit opt-in after production launch
- dependency update changes workflow snapshot intentionally
