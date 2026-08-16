# ADR-029: Opt-in Hosted Workspace Account Pool

## Status

Accepted as a gated architecture decision. This record authorizes implementation
behind feature flags; it does not authorize broad availability until the
compliance and acceptance gates pass.

## Context

The default ReviewRouter mode keeps Codex subscription credentials in a
repository-owned GitHub secret or trusted runner. Some trusted/private-repository
customers need a centrally managed workspace pool while retaining GitHub Actions
for checkout, tools, and agent execution.

That mode changes the v1 privacy boundary. The SaaS becomes credential custodian
and an invocation-scoped Responses relay. It therefore transiently processes
prompts, tool outputs, and model responses, even though it must not retain them.

## Decision

Add a separate, explicitly enabled `hosted_workspace_account_pool` provider mode:

- a workspace admin opts in and explicitly binds each eligible repository;
- legacy repository-owned authentication remains the default and is unchanged;
- Codex `auth.json`, refresh tokens, and access tokens are encrypted and used only
  in SaaS; they never enter the Action, repository secrets, logs, or artifacts;
- the Action receives only a revocable, multi-use, bounded run grant. The grant is
  scoped to tenant, repository, workflow/run/attempt, selected account, expiry,
  request/budget ceilings, and the relay audience;
- checkout, agent loop, and tools remain in GitHub Actions. The Action streams
  Responses requests and tool results through SaaS, and SaaS streams upstream
  response events back for that invocation;
- SaaS must not durably store relay bodies. Only bounded metadata such as IDs,
  byte/token counts, latency, outcome, classification, and redaction counters may
  be retained;
- account selection is sticky for the invocation. A backup account may be used
  only for a classified authentication or quota failure before the first
  successful upstream response, and at most once;
- there is no `executionSlotsPerAccount` setting and no account-wide full-run
  mutex. Parallel inference is allowed. The account-wide mutation fence covers
  only credential refresh/writeback and generation compare-and-swap;
- encrypted account state uses envelope encryption through a keyring/KMS port.
  AEAD AAD binds tenant ID, account ID, credential generation, and active database
  incarnation;
- restored credential rows start quarantined. A restore cannot serve credentials
  until the externally anchored database incarnation is verified and an audited
  rewrap/promotion establishes a new active incarnation;
- rollout starts with explicitly trusted private repositories and remains
  kill-switchable at global, workspace, account, and repository levels.

## Runtime Reuse and Boundaries

Reuse the subscription-runtime contracts rather than introduce a second OAuth
state machine:

- `CodexCliSessionDriver` supplies lazy refresh behavior and the existing Codex
  session validation/failure classification;
- SaaS adapters implement `SessionStorePort` and `LeaseStorePort` with shared,
  transactional storage and generation CAS;
- validation and classified auth/quota outcomes drive the one-backup rule;
- a narrow KMS/keyring port owns wrap, unwrap, rotate, and rewrap operations;
- the relay owns streaming and grant enforcement, not checkout, tools, or the
  agent loop.

`FileBackend` workers and local-file session/lease stores are forbidden in the
multi-replica SaaS path. They remain valid for disposable local certification and
single-host products, but cannot provide this deployment's shared correctness.

## Compliance Gate

The internal ChatGPT Responses subscription endpoint is not a formally stable
delegation contract. Before any customer rollout, product/legal/security owners
must confirm that the intended credential custody and relaying are permitted for
the enabled account types and current terms. Compatibility monitoring and a
tested global kill switch are mandatory. Failure or uncertainty at this gate
keeps the mode off; it does not fall back silently to another account or API.

## Consequences

Positive:

- centralized workspace account lifecycle without moving repository execution;
- credentials never reach customer workflows;
- account refresh is shared safely across replicas without serializing inference;
- legacy customers receive no behavioral or privacy-boundary change.

Negative:

- ReviewRouter assumes high-sensitivity credential custody;
- relay traffic transiently exposes customer prompts, tool output, and responses
  to ReviewRouter infrastructure;
- deployment requires KMS, restore quarantine, streaming backpressure, and
  stronger incident/compliance controls;
- an unstable upstream contract can require immediate feature shutdown.

## Supersedes and Scope

This ADR narrows, but does not erase, earlier decisions:

- [ADR-001](./001-saas-control-plane-only.md) remains true for the default legacy
  mode. Hosted pool mode adds credential custody and a relay, but execution still
  runs in GitHub Actions.
- [ADR-006](./006-no-codex-oauth-custody.md) remains true for legacy v1 mode. It
  does not apply after an admin explicitly enables hosted pool mode for a bound
  repository.

The implementation and rollout contract is in
[Hosted Workspace Account Pool Plan](../architecture/49-hosted-workspace-account-pool-plan.md).
