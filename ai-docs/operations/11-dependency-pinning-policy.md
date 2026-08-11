# Dependency Pinning Policy

## Why This Matters

ReviewRouter generates workflows that run in customer repositories. Dependencies in generated workflows are part of the customer's supply chain.

## Generated Workflow Defaults

For public production SaaS-generated workflows other than rotating Codex OAuth:

- ReviewRouter Action defaults to `777genius/review-router@main` during hosted beta
- third-party actions should use stable version tags initially for usability
- offer a stricter pin-to-SHA mode later for enterprise/security-focused users
- offer explicit `v1.0.x` pinning for customers who do not want automatic
  compatible updates

For local/private beta smoke installs other than rotating Codex OAuth:

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

Production hosted beta policy:

- General/non-rotating ReviewRouter Action: `777genius/review-router@main` by
  default so fixes reach generated workflows without setup PR churn
- Rotating Codex OAuth Action: the mandatory
  `REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF=owner/repo@<40-character-SHA>`;
  never inherit `REVIEW_ROUTER_ACTION_REF`
- GitHub-owned actions: major version tags acceptable for beta, document tradeoff
- third-party non-GitHub actions: avoid unless necessary; prefer first-party or inline code
- Conservative customer option: explicit `v1.0.x` release tag

Local beta policy:

- General/non-rotating ReviewRouter Action: `777genius/review-router@main`
  unless `REVIEW_ROUTER_ACTION_REF` or `REVIEW_ROUTER_ACTION_VERSION` overrides
  it
- Rotating Codex OAuth Action: require the same exact-SHA rotating contract as
  production
- GitHub-owned actions: major version tags acceptable
- every real smoke should record which action ref was generated

## Lockfiles and App Dependencies

SaaS repo:

- lockfile committed
- dependency updates through PR
- CI runs tests/typecheck/build
- dependency review before public launch

## Future Enterprise Mode

For general/non-rotating generated workflows, offer:

```text
pinActionsToSha: true
```

This should resolve action versions to full commit SHA and show update PRs when SHA changes.

## Tests

- production general/non-rotating generated workflow uses
  `777genius/review-router@main` by default
- local beta general/non-rotating generated workflow uses
  `777genius/review-router@main` by default
- rotating Codex OAuth generation fails closed without the separate exact-SHA
  rotating ref; the same-repository overlap contains only explicitly trusted
  old SHAs during a drained A -> B transition
- full-SHA or `v1.0.x` pinning for general workflows requires explicit opt-in
  during hosted beta
- dependency update changes workflow snapshot intentionally

## Stable Major Channel

`v1` is a mutable stable channel, not an immutable release. It must point to the
latest vetted compatible `v1.0.x` release in both ReviewRouter repositories:

- `777genius/review-router@v1` - customer workflow/reusable workflow entrypoint
- `777genius/review-router-saas@v1` - trusted runtime checkout used by reusable workflows

Move `v1` only through the release workflows documented in
[`07-environments-and-release-management.md`](./07-environments-and-release-management.md).

Do not move `v1` for breaking workflow input changes, protocol breaks, or
un-smoked runtime changes. Cut a fixed `v1.0.x` first, smoke it, then let the
release workflow move `v1`.
