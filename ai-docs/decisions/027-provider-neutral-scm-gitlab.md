# ADR-027: Provider-Neutral SCM Boundary For GitLab

## Status

Accepted.

## Decision

Add GitLab through provider-neutral boundaries instead of branching inside the
existing GitHub use cases.

The first production shape is:

```text
GitHub adapter -> provider-neutral contracts <- GitLab adapter
```

The common contracts cover only concepts that are truly shared:

- SCM provider identity: `github` or `gitlab`
- stable external repository identity
- stable change request identity
- CI run identity
- review findings artifact
- review publisher port
- CI provisioning port

Provider-specific behavior stays in adapters:

- GitHub App installation tokens, GitHub Actions OIDC, workflow files, and
  GitHub review comments.
- GitLab OAuth discovery, group/project variables, `ci_config_path`,
  GitLab CI ID tokens, and MR Discussions API. Draft Notes are an optional
  later batching strategy, not the MVP posting path.

## Rationale

ReviewRouter already follows feature-first Clean Architecture:

```text
domain <- application <- interface/adapters
application -> ports <- infrastructure
```

The current implementation is cleanly layered, but several domain/application
types use GitHub names because GitHub was the only SCM provider. A full rename
would be expensive and risky. Adding GitLab directly to those use cases would
create provider conditionals in application code.

The pragmatic path is to introduce neutral contracts at new seams while leaving
existing GitHub behavior stable.

## Scope

This ADR covers the architecture boundary for adding GitLab. It does not require
a full rename of GitHub-specific persistence, dashboard copy, or existing
GitHub use cases.

Provider-neutral means neutral at the seam, not generic everywhere.

## Implementation Rules

- Do not add `if provider === "gitlab"` to GitHub OIDC exchange, GitHub App
  token issuance, or GitHub workflow provisioning use cases.
- Add sibling GitLab use cases or provider-neutral use cases with provider
  adapters selected at the composition root.
- Use stable provider IDs for persistence. GitHub uses repository id. GitLab
  uses project id. Repository paths such as `owner/repo` or `group/project` are
  display/API coordinates and can change.
- Use provider-native change request ids at the boundary. GitHub uses PR
  number. GitLab uses merge request IID within the target project, not the
  global merge request id.
- Keep GitLab write tokens in GitLab CI/CD variables. ReviewRouter SaaS stores
  install metadata and health status, not GitLab write-token plaintext.
- Split GitLab provisioning credentials from review posting credentials. The
  installer token can edit project settings or variables; the review token can
  post MR notes. The analyze job receives neither when possible.
- Normal review runtime should cross providers through
  `reviewrouter-findings.json`, then a provider-specific publisher posts
  comments.
- `reviewrouter-findings.json` is CI-local execution data. It may contain
  finding bodies and file paths, so it must not be uploaded to the SaaS control
  plane by default.
- GitLab runtime images are product-owned GHCR packages published by GitHub
  Actions after the release CI passes on `main`. Release publishing uses the
  workflow `GITHUB_TOKEN` package permission, not a maintainer personal token.
- Publisher results must contain safe metadata only: counts, external comment
  ids, fingerprints, and reason codes. They must not return finding bodies,
  raw diffs, model responses, or source snippets to the control plane.
- GitLab inline comments use the MR Discussions API. Single-line inline
  comments are the MVP; unsupported positions fall back to summary.
- Shared inline eligibility must return false for GitLab unless `baseSha`,
  `startSha`, and `headSha` are present.
- Bound publication text before provider adapters run. Oversized markers,
  fingerprints, titles, or finding bodies must fail before any SCM API call.
- GitLab mass install defaults to a control project installer and
  `ci_config_path` after CI Lint dry-run. Setup MR remains the safe fallback.
- Do not overwrite an existing non-ReviewRouter `ci_config_path`. Use setup MR
  fallback unless the user explicitly chooses the advanced override.
- Skip GitLab fork MRs in MVP. Same-project MRs are the first supported trust
  boundary.
- GitLab CI identity must not rely on path claims alone. Prefer stable project
  ids from claims when available, then revalidate repository, MR IID, source
  project, target project, and head SHA through the GitLab API.

## Consequences

Positive:

- GitHub path remains stable while GitLab is added.
- Future Bitbucket or Azure DevOps support gets a real extension point.
- Provider API details stay out of domain/application services.
- The no-custody CI/CD execution story remains intact.

Negative:

- Some GitHub-named legacy fields remain during migration.
- There is a temporary adapter bridge between GitHub-specific persistence and
  provider-neutral contracts.
- More contracts exist before all adapters use them.

## Revised Migration Steps

1. Add provider-neutral identity and review-publishing contracts.
   - No behavior change.
   - Existing GitHub tests must stay green.

2. Extract normal review output into `reviewrouter-findings.json`.
   - Analyzer writes findings.
   - Existing GitHub posting can still consume the artifact through a bridge.
   - Do not add GitLab API calls in this phase.

3. Put current GitHub posting behind `ReviewPublisherPort`.
   - Keep output identical for existing GitHub review runs.
   - Add golden tests for summary marker, inline comment count, skipped
     findings, and duplicate prevention.
   - Keep the old GitHub path behind a kill switch until the adapter proves
     parity.

4. Add `GitLabPublisher` with fake findings first.
   - Fetch latest MR version before posting.
   - Revalidate target project id, MR IID, MR state, same-project source/target,
     head SHA, and diff refs.
   - Treat `baseSha`, `startSha`, and `headSha` as required for GitLab inline
     positions. If any are missing, publish summary only.
   - Use MR Discussions API for inline comments. Draft Notes may be evaluated
     later only if we need hidden draft creation plus bulk publish semantics.
   - If a position cannot be mapped, record fingerprint as skipped and include
     it in the summary.

5. Add GitLab CI identity exchange.
   - Separate GitLab ID token verifier from GitHub Actions OIDC verifier.
   - Store action session claims with provider-neutral run identity.
   - For older GitLab versions without newer job claims, compensate with API
     revalidation instead of trusting weak claims.

6. Add GitLab install service.
   - OAuth is for discovery and permission checks.
   - Installer runs in a GitLab control project.
   - Default rollout uses group variables plus `ci_config_path` only after CI
     Lint dry-run.
   - If the user lacks permission to edit project settings, fall back to setup
     MR instead of partially configuring a repo.
   - Fallback creates setup MRs with a small include.

7. Migrate persistence only when a phase needs it.
   - Add provider-neutral columns/tables alongside GitHub fields.
   - Backfill GitHub rows.
   - Switch reads through provider-neutral repository identity.
   - Drop or rename GitHub-only fields only in a later cleanup ADR.

## Acceptance Gates

- `pnpm architecture:check` keeps passing.
- GitHub setup PR, runtime config, normal review posting, conflict review, and
  health reports behave the same before and after the GitHub publisher adapter.
- GitLab publisher contract tests cover added, removed, and context lines.
- GitLab live smoke uses a disposable same-project MR and verifies no duplicate
  comments on rerun.
- Control-plane telemetry stores counts and safe reason codes only.

## References

- GitLab Projects API exposes stable project `id` and mutable
  `path_with_namespace`: https://docs.gitlab.com/api/projects/
- GitLab Merge Requests API uses `merge_request_iid` for project-scoped MR
  operations: https://docs.gitlab.com/api/merge_requests/
- GitLab Discussions API creates MR threads and supports positioned diff
  comments: https://docs.gitlab.com/api/discussions/
- GitLab Draft Notes API supports hidden draft notes and bulk publish, but is
  not the MVP posting path: https://docs.gitlab.com/api/draft_notes/
- GitLab custom CI configuration path supports files in another project:
  https://docs.gitlab.com/ci/pipelines/settings/
- GitHub Container registry supports publishing from GitHub Actions with
  `GITHUB_TOKEN` and public packages can be pulled anonymously:
  https://docs.github.com/packages/getting-started-with-github-container-registry/about-github-container-registry
