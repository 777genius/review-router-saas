# ADR-028: Revision-Aware Review Evidence

Status: Accepted for additive implementation. Runtime capabilities remain disabled.

## Context

Exact-head checkpoint recovery currently stores a mixed-provider batch result, and
completed snapshots store a cross-head projection. Neither artifact proves that a
single provider invocation had identical observable inputs, nor may either reuse
old lifecycle or publication decisions on a new revision.

## Decision

Store reusable provider observations as immutable evidence and always rebuild the
current finding projection for the exact canonical review revision. Historical
evidence cannot publish, resolve a thread, or contribute directly to the merge
gate.

The bounded contexts are:

- Review Run Control: permanent SCM identity, producer release, authorization,
  mutation epoch, protocol/SLO profiles and safety decisions.
- Review Executions: generation, work slots, attempts, leases, observation
  references, finalized artifact and publication permit.
- Review Evidence: canonical invocation identity, immutable observations and reuse
  eligibility.
- Review Publishing: immutable mutation plans, attempts, fenced claims, effects,
  reconciliation and receipts.
- Review Snapshots: one completed projection and bounded lineage hints per PR.
- Review Processes: completion orchestration only. It owns no review policy.
- Public Action Review Projection: current lifecycle inventory, consensus,
  lineage, placement and merge-gate projection.

Contexts exchange immutable anti-corruption DTOs and opaque identities through
application ports. Domain/application code imports no Prisma, HTTP, SCM SDK,
provider SDK, OAuth implementation or another context's infrastructure.

## Reuse Tiers

- T0 exact-revision resume: eligible after v2 hardening.
- T1 prompt-only cross-revision evidence: shadow first, then explicit allowlist.
- T2 agentic cross-revision evidence: disabled until a separate Context Gateway
  ADR proves complete positive and negative dependency tracking.

## Canonical Release Profiles

The initial protocol-limits profile is `review-action-v2-initial`. Canonical keys
are sorted UTF-8 JSON and the SHA-256 digest is:

```text
e77add11b9869b148dd3a9eb2f50f4a9b68eccae8f7d1ed80998a8cda9d5d1cc
```

| Limit                                    |                  Value |
| ---------------------------------------- | ---------------------: |
| Work slots                               |                    200 |
| Attempts per slot                        |                      4 |
| Observation bytes/findings               |      1,000,000 / 1,000 |
| Projection bytes/findings                |      2,000,000 / 2,000 |
| Publication operations/chunks/body bytes |  500 / 500 / 2,000,000 |
| Request batch size                       |                    100 |
| Lease/report/reconciliation              | 600s / 1,200s / 3,600s |

Registration recomputes this digest from canonical values. A caller-supplied
digest mismatch is an immutable conflict, and a release can only narrow generated
absolute protocol maxima.

The initial operational profile is `review-action-v2-initial-slo`, owned by
`team-reviewrouter` with runbook `operations/review-v2`. Its canonical SHA-256 is:

```text
af502af3c3d7165e15f388faf89c246152dfdd1708347b3810bff61cbc793417
```

| SLO                            |       Value |
| ------------------------------ | ----------: |
| Integration-event delivery     |         60s |
| Outbox claim age               |        120s |
| Missing/due completion process | 300s / 300s |
| Publication reconciliation     |        600s |
| V1 drain                       |      3,600s |
| Admission                      |         30s |
| Pruning backlog age            |     86,400s |

These values are release-bound rollout ceilings, not permission to enable a
repository. Production telemetry may justify a new immutable profile; existing
profile IDs are never rebound.

## Atomicity And Delivery

Every business state transition that emits an integration event uses one
operation-specific atomic command port. The implementation owns one database
transaction for aggregate CAS and outbox insert. There is no generic cross-context
unit of work and an outbox replay cannot invent business terminal state.

Outbox claims, execution leases, publication claims and completion-process claims
use never-reused `bigint` fencing terms. A stale owner cannot acknowledge work
after takeover. Unknown SCM effects reconcile to a receipt or a visible bounded
manual terminal state.

## Queue Admission

Managed workflows must use PR-scoped concurrency before provider work. A durable
`ReviewRequestedIntent` also records the webhook/manual trigger independently of a
runner so cross-PR cancellation before runner allocation cannot lose pending work.
Duplicate delivery identities restore one intent; a distinct manual trigger keeps
its own identity even at the same SHA.

## Mutation And Rollout

The hosted ReviewRouter App lane has one repository mutation authority and
monotonic epoch. Rollout order is expand, backfill, validate, deploy disabled
readers, drain v1, prove no static write-enabled lane, then activate v2 as the final
command. Post-activation failure pauses v2 and never reopens v1.

All v2 capabilities and completion schedulers default to disabled. The additive
migration seeds the global emergency stop as enabled. T1 promotion additionally
requires the documented shadow sample, zero confirmed false eligibility, an
immutable gate report and a successful rollback drill.

## Consequences

- More records and mappings are required, but ownership and replay semantics are
  explicit and testable.
- V1 checkpoint rows remain isolated and expire normally; they are not converted.
- Raw prompts, source, credentials and provider responses do not cross the SaaS
  persistence boundary.
- The SaaS and public Action repositories share only deterministic generated
  Published Language artifacts and immutable release manifests.

The detailed model, edge cases, delivery graph and acceptance criteria remain in
[`48-revision-aware-review-evidence-plan.md`](../architecture/48-revision-aware-review-evidence-plan.md).
