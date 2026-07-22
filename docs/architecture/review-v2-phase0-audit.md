# Review v2 Phase 0 correctness audit

Status: implementation input. This document records observed behavior; it does not
enable v2 or claim production SLO approval.

## Audited baselines

- SaaS source baseline: `bbecfbc45269c29535e18dcf49ef0bde93be375f`.
- Public Action baseline: `be133b013c4a648964906c9a2619580c36cb6ed0`.
- Hosted composite entrypoint: SaaS `action-dist/index.cjs` plus the managed
  workflow/bootstrap bridge.
- Public reusable entrypoint: public Action `dist/index.js`.
- The two distribution kinds have distinct release identities. Contract handoff
  and runtime release manifests bind full commit SHAs and entrypoint digests.

## Current correctness results

| Surface                             | Evidence                                                                                                                                               | Decision                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| OAuth writeback revision            | The public Action now carries `reviewedHeadSha`, reloads the PR before posting, writes summary metadata, and uses the reviewed SHA for inline comments | Stale output is not rebound to a newer head                              |
| Exact-revision snapshot replay      | Replay reloads current comments, dismissals, lifecycle inventory, and gate inputs before projection                                                    | Provider work may be reused; lifecycle projection is always current      |
| Partial provider checkpoint         | A v1 batch is reusable only when every planned provider has one successful result                                                                      | Partial v1 rows are rerun; v2 stores per-provider work slots             |
| Partial file/provider coverage      | Only complete coverage can advance a completed snapshot                                                                                                | Deterministic omissions remain partial and cannot masquerade as complete |
| GraphQL lifecycle inventory failure | Failed inventory passes `undefined`, preserving REST/current-comment dedupe                                                                            | Failure does not silently disable the safer fallback                     |
| Summary marker lookup               | Comment/status lookup is paginated up to its bounded budget and fails closed when pagination is incomplete                                             | No create occurs after an incomplete ownership search                    |
| Timeout after summary POST          | A reserved intent becomes `ambiguous`; retry searches the deterministic marker before creating                                                         | Commit ambiguity is reconciled, not blindly retried                      |
| v1 credential lifetime              | Action session: 15 minutes; conflict posting session: 5 minutes; completed Codex OAuth comment refresh window: 6 hours                                 | Drain must retain original expiries and deny new mutation authority      |

Regression evidence lives in the affected public Action and SaaS tests. Secret-like
values in ambiguous error summaries are redacted.

## Workflow inventory and commit-storm decision

| Official lane                  | Effective concurrency                              | Commit-storm behavior                                                                                         | Phase 1 requirement                                                               |
| ------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Public reusable workflow       | repository + PR + head, `cancel-in-progress: true` | New head cancels only the same PR/head lane; other PRs are independent                                        | Cooperative supersession later replaces hard cancellation                         |
| Generic SaaS reusable workflow | run identity when conflict fallback is active      | No repository-wide pending queue                                                                              | Keep exact revision fencing                                                       |
| Managed Codex OAuth workflow   | repository + provider, `cancel-in-progress: false` | GitHub retains at most one pending run per group; a later PR can replace another PR before provider admission | Durable independently ingested `ReviewRequested` is mandatory before v2 execution |

The managed lane deliberately remains provider-serialized until server-side account
leases exist. Changing it to PR-scoped concurrency first would permit concurrent use
of the same OAuth auth surface. Instead, a verified webhook/request ingress stores
`ReviewRequested` by repository, PR, head, event delivery, and request body hash.
Worker admission consumes that durable intent under account/stream leases. Duplicate
delivery restores the same intent; the same delivery identity with another body is a
hard conflict. Superseded heads remain audit history and cannot allocate a newer
generation after delayed admission.

## Limits versus SLOs

Protocol byte/count/deadline maxima are hard safety bounds and are versioned in the
generated contract. They are not operational SLOs. Delivery latency, claim age,
process recovery, reconciliation, v1 drain, slot count, payload, finding, chunk, and
deadline SLOs require production-shaped telemetry approval before cohort activation.
Until an immutable promotion report records those measurements and owner approval,
all v2 behavior capabilities remain disabled.
