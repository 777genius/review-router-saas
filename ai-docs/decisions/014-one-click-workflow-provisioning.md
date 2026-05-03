# ADR-014: One-Click Workflow Provisioning With Workflows Write

## Status

Accepted.

## Decision

ReviewRouter SaaS v1 will request the GitHub App permissions required to create setup and update pull requests for workflow files.

Required repository permissions:

```text
metadata: read
contents: write
workflows: write
pull_requests: write
```

`workflows: write` is needed only because ReviewRouter writes `.github/workflows/reviewrouter.yml`. It is not needed for the review engine itself.

`issues: write` and `actions: write` are not required for minimal v1
provisioning. Only add them later behind a specific product feature and updated
permission copy.

## Rationale

The product goal is low-friction SaaS onboarding. A dashboard button should be able to create a setup PR without requiring the user to run a local `curl` installer.

GitHub protects workflow files separately. Updating `.github/workflows/*` through the contents API requires workflow permission in addition to contents write permission.

References:

- [GitHub REST repository contents API](https://docs.github.com/en/rest/repos/contents)
- [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)

## Onboarding Flow

```text
1. User signs in with GitHub.
2. User installs the ReviewRouter GitHub App on selected repositories.
3. Dashboard shows selected repositories and install health.
4. User clicks Create setup PR.
5. SaaS uses the App installation token to create branch reviewrouter/setup.
6. SaaS commits .github/workflows/reviewrouter.yml.
7. SaaS opens a setup PR.
8. User reviews and merges the PR.
9. Pull requests run ReviewRouter inside customer CI.
```

No direct push to default branch.

## Codex Auth Boundary

Even with `workflows: write`, SaaS does not take custody of Codex OAuth credentials.

SaaS provisions workflow files and config metadata only. Codex auth is seeded separately into the customer's environment:

```text
repo secret CODEX_AUTH_JSON
org selected-repos secret CODEX_AUTH_JSON
trusted self-hosted runner persistent CODEX_HOME
OpenAI/OpenRouter API key secret instead of Codex OAuth
```

## Secret Setup UX

Default UX:

```text
Dashboard creates workflow PR.
Dashboard then shows Provider auth setup.
User chooses Codex OAuth, OpenAI API key, or OpenRouter API key.
For Codex OAuth, user runs a short local command that writes CODEX_AUTH_JSON directly to GitHub Secrets.
SaaS never receives the auth.json contents.
```

Optional future UX:

```text
Client-side secret seeding in browser.
Browser reads local file only via user file picker.
Browser encrypts the secret using GitHub repository/org public key.
Browser sends encrypted_value directly to GitHub API.
SaaS still never receives plaintext.
```

This requires careful GitHub token/permission handling and is not required for first beta.

## Why Not Store Codex Auth in SaaS

Codex ChatGPT OAuth credentials are personal account credentials. Storing them in SaaS would materially weaken the privacy and trust model.

ReviewRouter's trust claim is:

```text
SaaS provisions and observes metadata.
Customer CI owns code, diffs, provider credentials, and review execution.
```

## Consequences

Positive:

- true one-click workflow provisioning
- easier update PRs
- better SaaS onboarding
- fewer local prerequisites for basic install

Negative:

- GitHub App permission prompt is stronger
- public security copy must explain why `workflows: write` exists
- App compromise risk is higher than read/comment-only App
- requires stronger internal audit and least-privilege implementation

## Required Safeguards

- App creates PRs only, never pushes to default branch.
- Generated branch name is deterministic and scoped per repository.
- Setup PR contents are reproducible from a signed template version.
- Every workflow provisioning action is audited.
- Only workspace admins can request setup/update PRs.
- UI explains `workflows: write` before GitHub redirects to install.
- App token is never exposed to provider subprocesses.
- Action workflow uses `pull_request`, not `pull_request_target`, for default review execution.
