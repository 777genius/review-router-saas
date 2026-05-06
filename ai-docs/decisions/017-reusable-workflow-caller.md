# ADR-017: Reusable Workflow Caller Strategy

## Status

Proposed for v1.1, not a v1 beta blocker.

## Context

Generated setup PRs currently write explicit workflow files into each connected repository. This is transparent and reliable, but the YAML is visually large because it includes:

- safe pull request triggers
- fork PR secret skipping
- Codex CLI install
- `CODEX_AUTH_JSON` validation and restore
- OIDC runtime config
- App comment token mode
- interaction workflow for `/rr` commands

Reusable workflows can reduce the generated YAML, but they do not remove the security and permission surface. GitHub still requires the caller workflow to define the trigger, permissions, inputs, and secret passing.

## GitHub Constraints

- A reusable workflow must live in `.github/workflows` and expose `on.workflow_call`.
- The caller references it with `jobs.<job_id>.uses`, not as a normal step.
- Secrets must be passed explicitly or with `secrets: inherit`; environment secrets do not pass through `workflow_call`.
- The caller job controls `permissions`; the called workflow cannot elevate `GITHUB_TOKEN` permissions.
- Public called workflows are accessible if the repository/org allows public reusable workflows; private called workflows need an explicit access policy.
- GitHub does not support redirects for actions or reusable workflow references, so repository renames can break consumers.

## Options

### 1. Keep Explicit Generated Workflows

🎯 9   🛡️ 9   🧠 3   ~0-100 LOC

Keep the current generated `reviewrouter.yml` and `reviewrouter-interaction.yml`.

Pros:

- Maximum transparency for early users.
- No extra reusable workflow access policy edge cases.
- Easier debugging because every command is visible in the user repository.

Cons:

- YAML looks large.
- Updates require setup PR updates.

### 2. Thin Caller + Public Reusable Review Workflows

🎯 8   🛡️ 8   🧠 6   ~400-800 LOC

Generate thin caller workflows in user repositories:

```yaml
jobs:
  reviewrouter:
    permissions:
      contents: read
      pull-requests: write
      issues: write
      id-token: write
    uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1
    secrets:
      CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

Pros:

- User repo workflow becomes much smaller.
- Runtime improvements can ship inside the action/reusable workflow repo.
- Still keeps explicit caller permissions and secret mapping visible.

Cons:

- Caller still needs workflow files.
- Called workflow cannot elevate permissions, so the caller must list permissions.
- Secret handling becomes slightly less obvious to users.
- Need careful versioning and migration because reusable workflow refs can break on repo rename.

### 3. Org Required Workflow + Reusable Runtime

🎯 6   🛡️ 8   🧠 8   ~1000+ LOC

Use GitHub organization rulesets required workflow where supported, then call ReviewRouter reusable runtime from the central source workflow.

Pros:

- One org-level workflow can cover many repos.
- Strong enterprise story for teams with the right GitHub plan.

Cons:

- Requires GitHub Team/Enterprise capability and organization administration permissions.
- Not available to many free org users.
- More moving parts and harder support path.

## Decision

Do not replace the explicit generated workflows before beta.

Implement option 2 as a later migration when the core product flow is stable:

1. Keep explicit workflows as the fallback and debug mode.
2. Add an installer/dashboard option: `Workflow style: explicit | thin reusable`.
3. Default existing users to explicit until thin reusable has real E2E coverage.
4. Keep all secret mapping and permissions visible in the caller workflow.

## Non-Goals

- Reusable workflows are not a way to hide secrets from the caller repository. The caller still owns the secrets.
- Reusable workflows are not a way to avoid a workflow file entirely. For free organizations, per-repo workflow files remain the reliable path.
- Reusable workflows should not replace the optional org ruleset path for paid organizations.
