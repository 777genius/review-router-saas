# ADR-017: Reusable Workflow Caller Strategy

## Status

Validated with real GitHub Actions smoke runs on 2026-05-06.

Decision remains: proposed for v1.1, not a v1 beta blocker.

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

- A reusable workflow must live in `.github/workflows` and expose `on.workflow_call` ([GitHub reusable workflow docs](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)).
- The caller references it with `jobs.<job_id>.uses`, not as a normal step ([GitHub reusable workflow reference](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)).
- Secrets must be passed explicitly or with `secrets: inherit`; environment secrets do not pass through `workflow_call`.
- The caller job controls `permissions`; the called workflow cannot elevate `GITHUB_TOKEN` permissions.
- Public called workflows are accessible if the repository/org allows public reusable workflows; private called workflows need an explicit access policy.
- GitHub does not support redirects for actions or reusable workflow references, so repository renames can break consumers.
- OIDC exposes `job_workflow_ref` for jobs using reusable workflows, and GitHub documents it as the claim to bind trust to a specific reusable workflow ([GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)).
- Organizations can restrict which actions and reusable workflows are allowed; this may block `777genius/review-router/...@v1` in locked-down orgs unless explicitly allowed ([GitHub Actions org policy docs](https://docs.github.com/en/organizations/managing-organization-settings/disabling-or-limiting-github-actions-for-your-organization)).

## Prototype Results

Note: the disposable caller repository referenced in this section was deleted
during the May 8, 2026 cleanup. The result is retained as historical evidence;
new reusable-workflow validation should create a fresh disposable caller repo.

Prototype branch:

- `777genius/review-router@spike/reusable-workflow-prototype-20260506`
- reusable file: `.github/workflows/reviewrouter-reusable-prototype.yml`
- latest prototype commit: `ba1fe90923c57b48027993deafa75ec9658d888e`

Disposable caller repository:

- `777genius/reviewrouter-reusable-smoke-1778062110`
- caller workflow: `.github/workflows/reviewrouter-reusable-caller.yml`
- caller passes `CODEX_AUTH_JSON` explicitly and grants `contents: read`, `pull-requests: write`, `issues: write`, `id-token: write`

Real `workflow_dispatch` run:

- run: `https://github.com/777genius/reviewrouter-reusable-smoke-1778062110/actions/runs/25429322038`
- result: success
- checkout repository: `777genius/reviewrouter-reusable-smoke-1778062110`
- `workflow_ref`: `777genius/reviewrouter-reusable-smoke-1778062110/.github/workflows/reviewrouter-reusable-caller.yml@refs/heads/main`
- `job_workflow_ref`: `777genius/review-router/.github/workflows/reviewrouter-reusable-prototype.yml@refs/heads/spike/reusable-workflow-prototype-20260506`

Real `pull_request` run:

- run: `https://github.com/777genius/reviewrouter-reusable-smoke-1778062110/actions/runs/25429359648`
- result: success
- checkout repository: `777genius/reviewrouter-reusable-smoke-1778062110`
- `workflow_ref`: `777genius/reviewrouter-reusable-smoke-1778062110/.github/workflows/reviewrouter-reusable-caller.yml@refs/pull/1/merge`
- `job_workflow_ref`: `777genius/review-router/.github/workflows/reviewrouter-reusable-prototype.yml@refs/heads/spike/reusable-workflow-prototype-20260506`

Confirmed:

- The called reusable workflow executes in the caller repository context.
- Billing/runner context and checkout are caller-owned.
- Caller `GITHUB_TOKEN` permissions are the effective ceiling.
- Explicit secret mapping works; the secret is masked in logs.
- OIDC includes enough information to validate both the target repository and the reusable workflow identity.

Security implication:

- For `workflowStyle=reusable`, OIDC validation must require exact trusted `job_workflow_ref` in addition to validating the target repository installation.
- Only checking caller `workflow_ref` is not enough, because a caller workflow at an allowed path could be edited to call a different reusable workflow.
- For branch-based refs like `@main`, re-runs can pick up newer reusable workflow code; production default should prefer a release tag or commit SHA for stable behavior.

## Options

### 1. Keep Explicit Generated Workflows

🎯 9 🛡️ 9 🧠 3 ~0-100 LOC

Keep the current generated `reviewrouter.yml` and `reviewrouter-interaction.yml`.

Pros:

- Maximum transparency for early users.
- No extra reusable workflow access policy edge cases.
- Easier debugging because every command is visible in the user repository.

Cons:

- YAML looks large.
- Updates require setup PR updates.

### 2. Thin Caller + Public Reusable Review Workflows

🎯 8.5 🛡️ 8 🧠 6 ~900-1600 LOC

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
- OIDC can bind SaaS-issued runtime config to the exact reusable workflow via `job_workflow_ref`.

Cons:

- Caller still needs workflow files.
- Called workflow cannot elevate permissions, so the caller must list permissions.
- Secret handling becomes slightly less obvious to users.
- Need careful versioning and migration because reusable workflow refs can break on repo rename.
- Locked-down organizations may need to allow the external reusable workflow path.

### 3. Org Required Workflow + Reusable Runtime

🎯 6 🛡️ 8 🧠 8 ~1000+ LOC

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
3. Default existing users to explicit until thin reusable has full reviewer E2E coverage, not just smoke OIDC coverage.
4. Keep all secret mapping and permissions visible in the caller workflow.
5. Harden OIDC validation to require exact trusted `job_workflow_ref` for reusable style.
6. Use release tags for normal users and commit SHA for strict enterprise installs; keep `main` only for dogfood/dev mode.

## Production Implementation Checklist

- Add reusable review workflow in `777genius/review-router` with the same runtime safety as explicit workflow.
- Add reusable interaction workflow only if `/rr` interaction can be made smaller without obscuring permissions.
- Render thin caller workflows from SaaS/workflow provisioning.
- Store workflow style and trusted reusable ref in repository config.
- Extend OIDC validator to require exact `job_workflow_ref` for reusable style.
- Add tests for malicious caller workflow path that calls the wrong reusable workflow.
- Add dashboard copy explaining that secrets still live in the customer repo/org, not in ReviewRouter SaaS.
- Keep explicit workflow fallback for debugging, personal repos, locked-down orgs, and users who do not allow external reusable workflows.

## Non-Goals

- Reusable workflows are not a way to hide secrets from the caller repository. The caller still owns the secrets.
- Reusable workflows are not a way to avoid a workflow file entirely. For free organizations, per-repo workflow files remain the reliable path.
- Reusable workflows should not replace the optional org ruleset path for paid organizations.
