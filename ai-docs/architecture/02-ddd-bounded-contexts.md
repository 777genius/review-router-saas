# DDD Bounded Contexts

## Architecture Style

ReviewRouter uses feature-first bounded contexts. Each feature owns its domain model, application use cases, ports, infrastructure adapters, and interface adapters.

## Bounded Contexts

### identity-access

Responsibilities:

- GitHub OAuth login
- users
- sessions
- workspace membership
- invitations and ownership transfer
- roles
- authorization policies

Core aggregates:

- User
- Workspace
- WorkspaceMember

Main invariants:

- a user can only manage a workspace if membership role allows it
- workspace ownership must not become empty
- invite tokens are single-use and expire
- GitHub user id is canonical, login is display metadata
- auth sessions must be scoped to user identity, not GitHub installation identity

### github-installations

Responsibilities:

- shared GitHub App installation records
- installation activation/suspension/deletion
- installation account metadata
- installation sync scheduling

Core aggregates:

- GitHubInstallation

Main invariants:

- installation belongs to one workspace
- installation has one GitHub installation id
- deleted/suspended installations cannot provision workflows
- sync state must be idempotent

### repository-management

Responsibilities:

- repositories available through installations
- selected repositories
- repo visibility/permissions
- health status summary

Core aggregates:

- RepositoryConnection

Main invariants:

- repository belongs to an active GitHub installation
- repository config inherits workspace config unless overridden
- private/public visibility affects secret guidance and fork PR warnings

### review-configuration

Responsibilities:

- ReviewRouter config schema
- presets
- model/provider settings
- blocking policies
- skip policy
- config versioning

Core aggregates:

- ReviewConfiguration
- ReviewConfigurationVersion

Main invariants:

- config changes are versioned
- config must validate before provisioning
- blocking policy must be explicit
- provider choice must match setup state guidance

### workflow-provisioning

Responsibilities:

- create setup/update branch
- create pull request with ReviewRouter workflow
- check installed workflow version
- update workflow to main/stable/release channel

Core aggregates:

- WorkflowProvisioning

Main invariants:

- only one active workflow provisioning operation per repo
- never overwrite user changes without explicit update flow
- setup/update should happen through PR, not direct push by default

### provider-setup

Responsibilities:

- provider setup state
- Codex OAuth guidance
- OpenAI/OpenRouter API key guidance
- org selected-repo secret guidance
- self-hosted runner guidance

Core aggregate:

- ProviderSetup

Main invariants:

- SaaS does not store Codex OAuth in v1
- provider setup state is metadata only
- secrets location must be explicit enough for user support

### webhook-ingestion

Responsibilities:

- GitHub webhook signature verification
- delivery idempotency
- event routing
- job enqueueing

Core models:

- GitHubWebhookDelivery
- WebhookProcessingResult

Main invariants:

- duplicate delivery id must not reprocess side effects
- invalid signatures are rejected
- webhook processing must be fast and enqueue work

### action-control-plane

Responsibilities:

- GitHub Actions OIDC token exchange
- short-lived action session tokens
- runtime config fetch
- metadata-only health reports
- action protocol version compatibility

Core models:

- ActionSession
- ActionRunReport
- ActionProtocolVersion

Main invariants:

- OIDC token repository must map to active selected repository
- action session cannot access dashboard/user APIs
- action session cannot fetch secrets
- health reports cannot include code, diffs, prompts, raw model output, or secret values
- protocol version must be compatible with installed action version

### audit-log

Responsibilities:

- append-only audit events
- config change history
- workflow provisioning events
- provider setup state changes
- skip/override related product events if reported

Core model:

- AuditEvent

Main invariants:

- audit records are append-only
- audit records include actor, workspace, repo where relevant
- sensitive secrets are never logged

### billing-entitlements

Responsibilities:

- free plan now
- future paid plan boundary
- feature entitlements
- usage/limits later

Core aggregates:

- Plan
- Entitlement

Main invariants:

- features check entitlement through policy service
- no billing-specific checks scattered in UI/controllers
