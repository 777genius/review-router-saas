# ADR-012: Generated Workflow Security Model

## Status

Accepted.

## Decision

ReviewRouter-generated workflows must use a conservative GitHub Actions security model:

- use `pull_request` for normal review execution
- do not use `pull_request_target` to checkout and review untrusted pull request code
- skip secret-backed provider execution for fork pull requests by default
- keep workflow permissions minimal
- prefer static fallback config if SaaS OIDC config fetch is unavailable

## Rationale

`pull_request_target` runs in the context of the base repository and can expose elevated permissions/secrets if combined with checking out untrusted code. ReviewRouter reviews arbitrary PR code, so it must not create a default workflow that makes this mistake.

## Default Workflow Policy

Default event:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
```

Default permissions:

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write
```

Rules:

- secret-backed review runs only for trusted same-repository PRs by default
- fork PRs get a clear skipped status/comment where possible
- manual trusted rerun can be added later as an explicit maintainer action
- generated workflow must not print secrets or env
- checkout should use least necessary token behavior

## GitHub App Token Use

If comments should come from the ReviewRouter GitHub App bot, the workflow may mint an installation token. This must be limited to the repository and permissions needed for comments/status, not broad org access.

## Consequences

Positive:

- strong default safety for public repositories
- clear behavior for forks
- avoids a common GitHub Actions footgun

Negative:

- fork PRs may not receive full secret-backed AI review automatically
- maintainers may need manual trusted paths for external contributors
- generated workflow is slightly more verbose
