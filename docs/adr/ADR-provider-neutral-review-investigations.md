# ADR: Provider-neutral Review Investigations

Status: accepted

Date: 2026-08-02

## Context

ReviewRouter can review changed patches, but a trustworthy clean result also
requires related callers, contracts, tests, configuration, generated sources,
and other repository context. Provider-native sessions are not durable enough
to own that proof, and provider-specific orchestration would duplicate policy
across Codex, Claude Code, and future agents.

The implementation contract is
`docs/architecture/provider-neutral-review-investigation-implementation-plan.md`.
The provider-neutral spikes named by that document establish feasibility but
are not production code.

## Decision

Create `Review Investigations` as a strict bounded context. It owns the coverage
contract, obligation ledger, durable dossier, turn state, fixed-point decision,
critic gate, conclusions, and investigation certificate. Its domain and
application layers depend only on their own types and ports.

Review Investigations does not own Git access, MCP/CLI syntax, provider account
selection, execution leases, Prisma, transport DTOs, projection, publication,
or SCM mutation. Those responsibilities remain in their existing bounded
contexts and communicate through consuming ports and explicit Published
Language.

The public Action runs provider processes and Context Gateway inside the
customer runner. The hosted or self-hosted control plane stores only canonical
metadata, hashes, typed obligations, encrypted private replay material,
findings, usage, and attestation references. Raw repository contents and
credentials do not enter immutable control-plane payloads.

The runner host, pinned Action release, and selected provider CLI executable
are the trusted computing base for local execution. The model and repository
content are untrusted. Gateway authentication prevents model-originated
transcript forgery, but it is not a sandbox against a malicious provider binary
that owns its process environment. A future credential-isolated broker is a
separate security boundary and ADR, not an implicit property of this design.

## Published Language

The initial Published Language freezes explicit enums for:

- investigation, obligation, turn, critic, and conclusion states;
- runtime profiles and provider-neutral next actions;
- context operation outcomes and failure classes;
- abort reasons and rollout flags.

Unknown values fail closed at anti-corruption boundaries. Generated transport
types may mirror this language but cannot contain domain decisions. Provider
adapters map their native errors and capabilities exhaustively.

## Rollout Authority

Review Run Control remains the rollout authority. The six investigation flags
are recording, shadow, critic, verified clean, cross-revision replay, and
production effects. `review-investigation-operations` owns their fail-closed
dependency graph, cohort selectors, emergency override, sanitized telemetry,
operator read model, and immutable promotion report. All flags default to
disabled.

Emergency disable wins before investigation admission, turn capability
issuance, certificate issuance, evidence acceptance, finalization, and SCM
mutation. It is read from shared Review Run Control state at each boundary, so
already-running API and worker processes observe it without a deploy. Generic
review authorization stays independent so rollback cannot disable the legacy
reviewer. Rollback disables behavior without destructively reverting additive
protocol or database state.

## Consequences

Positive:

- Coverage and clean authority are deterministic and provider-neutral.
- Codex, Claude Code, and future providers share one semantic contract suite.
- Durable dossiers survive provider process loss and control-plane restart.
- Strict boundaries prevent provider, transport, and persistence policy from
  leaking into the domain.

Tradeoffs:

- The feature requires coordinated, backward-compatible releases in the SaaS
  and public Action repositories.
- Verified clean is unavailable until gateway attestations, critic
  certificates, and fail-closed evidence acceptance are complete.
- Cross-provider continuation stays disabled until composite provenance and
  quorum semantics are designed separately.

## Implementation Gates

1. Server capabilities merge dormant before the Action advertises them.
2. Context Gateway v3 and legacy review behavior remain compatible.
3. Every clean-capable provider passes the same confinement and evidence suite.
4. Shadow runs cannot publish comments, checks, or merge signals.
5. Production effects require an allowlisted cohort, promotion report, tested
   kill switch, and no unresolved severity-1 rollout finding.
6. Agent execution and smoke tests use only disposable sandbox repositories.

## Paired implementation record

Recorded 2026-08-03:

- SaaS/control plane: `777genius/review-router-saas`, branch
  `feat/review-investigation-foundation`, baseline `f2283b4a`;
- public Action: `777genius/review-router`, branch
  `feat/review-investigation-protocol`, baseline `fb92cf4`.

These SHAs identify the reviewed development pair, not an approved release.
Neither branch may advertise or enable production investigation effects until a
registered Action release, matching server deployment, disposable hosted and
self-hosted E2E, promotion report, and owner approval satisfy the rollout
runbook. Server capability must merge dormant before the Action advertises it.
