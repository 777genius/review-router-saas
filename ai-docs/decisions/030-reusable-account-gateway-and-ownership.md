# ADR-030: Reusable Account Gateway and Credential Ownership

## Status

Accepted architecture and delivery sequence by the owner on 2026-10-02.
Implementation and production acceptance are pending. This record is not a
deployment, credential migration or passing compatibility receipt.

## Owner intent

Use Sub2API as a separately deployed account engine reusable by Review Router
and other products. Products keep their own UI and authorization. Users connect
credentials once; CI agents use them through a proxy without receiving provider
master credentials. Codex is required for the target integration; Claude is a
planned additional agent, with provider/protocol compatibility verified explicitly.

Prepare the distinction between account owner and consuming workspace in the
first integration. Deliver the personal-pool sharing UX separately: a user's
canonical accounts can be selected into several organization workspaces, while
organizations can also connect their own accounts. Rename and authorization
changes affect the canonical account and all active uses.

The full preserved vision and TS integration intent are in
[Reusable Account Gateway and Personal Pool](../architecture/50-reusable-account-gateway-and-personal-pool.md).
The executable delivery sequence is in the
[Modular Integration Plan](../architecture/51-account-gateway-modular-implementation-plan.md).

The sole normative implementation authority is
[contract 53](../architecture/53-account-gateway-implementation-contract.md).
The decisions below explain architecture; detailed runtime/fence/custody rules
are referenced there rather than independently edited here. DOC PLAN corrections
accepted 2026-10-03; no implementation/deployment acceptance is implied.

## Decision

1. Deploy one reusable `account-gateway` service unit: a pinned Sub2API fork and
   a narrow product-neutral control/execution adapter. `account-gateway` is the
   working service name, not a currently deployed product or published package.
2. Expose a versioned HTTP contract. Its vocabulary is consumer, owner reference,
   account reference, execution permission, profile, revision and limits. The
   service has no dependency on Review Router users, GitHub repositories, PR
   publishing, Next.js or tRPC.
3. Keep Sub2API group IDs, admin credentials, credential documents and native
   vendor account representations inside the service. Private account mapping
   and routing enforce consumer isolation; engine groups alone are not access
   control.
4. Use separate cohesive interfaces for account management and execution. RR
   application use cases depend on policy-facing ports. An infrastructure
   adapter translates them to the service HTTP contract; composition code wires
   the real client. No universal agent framework or generic plugin hierarchy is
   required.
5. Publish the HTTP schema as the authoritative wire contract with focused
   adapter/contract tests. Build a separate reusable TS package from the first
   slice: the owner has confirmed a need in at least two products. Its optional
   Get Modular integration owns declarations and construction, not product
   policy or agent execution. Keep the package outside Get Modular's neutral
   Core. Other languages use HTTP without depending on TS. Engineering
   Foundation and Docs Protocol are development tooling only.
6. Separate `CredentialOwner` from `ExecutionWorkspace` from the first data
   model. A physical account has one credential/refresh authority. Each
   workspace receives an explicit use binding, not a credential copy. Initially
   only the account's owner scope uses it; S adds explicit operator workspace
   grants after D, and H adds personal sharing as a separate follow-up (contract 53 §8).
7. New gateway connections for MiMo/OpenRouter keys and Codex/Claude
   subscriptions target Sub2API. Each supported provider/protocol/auth profile
   requires its own acceptance. The owner authorizes a breaking replacement:
   disable the old pool; require fresh account connections; do not migrate old
   credentials, grants or history, or build a coexistence layer. The owner states
   there are no users requiring compatibility. Retire old admission/refresh
   authority and classify in-flight effects before switching. One upstream
   identity must not have competing refresh writers.
8. RR validates workspace rights, repo/model policy and GitHub OIDC and gives CI
   a bounded RR run grant. Its relay calls the private gateway under a separate
   server identity and execution permission. CI sees neither the service admin
   credential nor the upstream master credential.
9. Account operations use stable operation IDs, revisions and status readback.
   Execution preserves protocol streams and cancellation and never replays a
   possibly dispatched paid request just because a client timed out. Product
   review state and gateway transport/account state have distinct ownership.
10. An invocation pins one canonical account/authority across its tool loop.
    A classified, freshly admitted backup can be activated at most once before
    first success. The gateway adapter owns paid inference retry/failover;
    native engine/SDK/CLI behavior must conform to that single authority and
    propagate safe dispatch/response/unknown-effect metadata. Routine fenced
    OAuth refresh advances only the engine credential version on the same
    physical birth UUID; owner authorization epoch remains separate (contract 53 §2).

## Clean Architecture, SOLID and DRY

- **SRP:** product policy, account lifecycle, vendor routing/refresh and agent
  execution evolve independently and have separate owners.
- **DIP:** product application policy owns the port it needs; concrete HTTP and
  Sub2API clients are outer adapters.
- **ISP:** account-management callers do not depend on streaming/CI APIs;
  execution callers do not receive admin or credential-export capabilities.
- **LSP/OCP:** a gateway adapter must honor its actual cancellation, revision and
  effect contracts. Adding a provider profile does not imply every agent or
  protocol is interchangeable. Unsupported combinations return an explicit
  failure, not a fake implementation.
- **DRY:** one credential owner, one wire schema, one engine refresh authority,
  one authoritative implementation of each policy. Generated types and caches
  are derived representations, not independently edited copies.

These boundaries protect concrete risks; they do not require a DI container,
repository interface for every table or a package for each method.

## Custody and existing decisions

ADR-005 remains the dependency-direction rule. This decision extends the
opt-in hosted architecture described in
[ADR-029 at inspected main](https://github.com/777genius/review-router-ai/blob/99f5e97c16b7bce47b4cfe196c1d8e462c92f6d3/ai-docs/decisions/029-opt-in-hosted-workspace-account-pool.md).

Moving the engine moves custody; it does not remove it. Managed BYOK at-rest
AEAD and transient create custody are specified by [contract 53 §7](../architecture/53-account-gateway-implementation-contract.md#7-custody-and-account-lifecycle).
F extends that proof to all OAuth refresh/cache/history/restore paths. Stock
JSONB/Redis and encrypted volumes are not application-envelope proof. Real-user
release is gated independently from the isolated canary; no alternative policy
amendment or memory-only downgrade is adopted by this DOC PLAN correction.

Legacy ADR-001/006 pool behavior is superseded for the replacement delivery;
there is no required account migration or permanent transition mode. No live
service is disabled by writing this ADR. Existing Codex tenant FKs/AAD remain
intact while that implementation exists; new custody needs its own accepted
equivalent. Memory/OAuth acceptance gaps are not declared closed.

## Consequences

- A second product can reuse the service without importing RR business models.
- Sub2API upgrades primarily affect one adapter and the compatibility canaries.
- A private service/server hop introduces availability, timeout and custody
  responsibilities; streaming and failure behavior need actual E2E proof.
- Personal-to-org sharing can be added without copying keys or merging user and
  workspace ownership. Its policy/UX is intentionally delivered after the first
  working slice.
- Old-pool migration and historical credential/evidence import are explicitly
  excluded. Codex-through-Sub2API qualification remains required.

## Delivery

First: owner/use contracts and one workspace-owned MiMo vertical slice, followed
by OpenRouter and Codex-through-Sub2API with their required gates. Explicit S operator grants follow D separately from own BYOK. Then H personal
sharing and remaining qualified Claude coverage. G retains D+E+F prerequisites. Keep dependency-safe bounded PRs and use existing
disposable test repositories. The detailed plan names acceptance and safe
suspension/recovery for the breaking replacement. No generic multi-project
platform is a prerequisite.
