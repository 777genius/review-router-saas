# Security and Secrets

## v1 Security Posture

ReviewRouter v1 should minimize custody:

- no repository code storage
- no pull request diff storage
- no Codex OAuth storage
- no model API key storage by default

The SaaS stores metadata and configuration only.

## Secret Handling Modes

### Codex OAuth Subscription

Recommended v1 mode:

- stored in customer GitHub repo/org secrets
- used by ReviewRouter Action in customer GitHub Actions
- optional self-hosted runner with persistent `CODEX_HOME`

SaaS sees only setup state.

### OpenAI/OpenRouter API Keys

Recommended v1 mode:

- stored in customer GitHub repo/org secrets
- SaaS tracks setup state only

Future optional BYOK mode:

- encrypted with KMS
- tenant-scoped data keys
- explicit opt-in
- strict audit and access controls

### Our Cloud Managed Credentials

Not v1.

If added later:

- use our provider accounts/managed credits
- hard per-tenant rate limits
- usage metering
- abuse controls

## Public Repo and Fork PR Risk

Public repositories can receive pull requests from untrusted contributors. Secret-backed workflows must not expose secrets to fork PRs.

ReviewRouter workflow defaults should:

- skip secret-backed review for fork PRs by default
- show clear status explaining why review was skipped
- provide maintainers a manual trusted rerun path if needed

## GitHub Permissions

Principles:

- request least privilege
- explain every permission in onboarding
- prefer creating setup/update PRs instead of direct commits to default branch
- use short-lived GitHub App installation tokens

Likely v1 permissions:

```text
metadata: read
contents: write
workflows: write
pull_requests: write
issues: write
actions: write
```

These permissions are for the shared GitHub App control plane. Review execution still runs in the customer's workflow. The App creates setup/update PRs and should never push directly to the default branch.

## Logging Rules

Never log:

- secret values
- OAuth tokens
- private keys
- model API keys
- full webhook payloads if they can contain sensitive data
- repository diffs

Logs should include safe correlation fields:

```text
requestId
workspaceId
installationId
repoId
githubDeliveryId
jobId
```

## Threats to Track

- malicious fork PR trying to exfiltrate secrets
- compromised GitHub App private key
- webhook spoofing without signature verification
- replayed webhook deliveries
- over-permissioned GitHub App
- accidental logging of secrets
- user confusion around where Codex OAuth is stored

## Codex OAuth in SaaS Setup

ReviewRouter SaaS must not receive `~/.codex/auth.json` plaintext.

One-click SaaS setup creates workflow PRs, but provider authentication is still customer-side:

```text
Codex OAuth -> GitHub repo/org secret CODEX_AUTH_JSON or persistent self-hosted CODEX_HOME
OpenAI API -> GitHub repo/org secret OPENAI_API_KEY
OpenRouter -> GitHub repo/org secret OPENROUTER_API_KEY
```

The first beta should seed Codex OAuth with a local command that writes directly to GitHub Secrets through `gh`, not through ReviewRouter SaaS.

Future browser-based secret seeding is allowed only if plaintext never reaches SaaS: the browser encrypts with the GitHub Actions public key and sends only encrypted values directly to GitHub.
