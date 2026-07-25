# Dependency-attested review reuse

Status: accepted for implementation. Production attachment is disabled by
default until shadow verification passes.

## Decision

ReviewRouter may reuse a completed provider observation across pull request
revisions only after a trusted context gateway has:

1. confined every provider context access to a versioned allowlist;
2. sealed an immutable source dependency attestation;
3. replayed that attestation against the target revision;
4. proved that every observable result is identical; and
5. issued a short-lived capability bound to the current target execution.

This is evidence reuse, not execution migration. Revision-specific executions,
work slots, leases, credentials, lifecycle state, and publication authority are
never transferred.

Arbitrary shell, direct filesystem access, network access, browser tools,
plugins, unregistered MCP servers, incomplete telemetry, or an unproven model
make an invocation ineligible for cross-revision reuse.

## Invariants

1. A superseded execution cannot publish, advance a snapshot, or mutate live
   review lifecycle state.
2. A revision-specific work slot never moves between executions.
3. Cross-revision reuse consumes only an accepted immutable observation.
4. Stable review-unit identity excludes revision, execution, lease, attempt,
   runner, and ordering data.
5. A provider-visible prompt for a reusable invocation excludes revision,
   execution, work-slot, lease, and runner identifiers.
6. The source and target must match repository, pull request, trust domain,
   provider vote lane, proven actual model, producer release, runtime contract,
   prompt envelope, output schema, configuration, capability profile, and tool
   policy.
7. Physical provider confinement is the primary proof. Provider-reported
   operation hashes are not trusted as attestation.
8. Every context operation is captured by a trusted gateway session and bound
   to the source attempt, lease, fencing token, checkout tree, gateway binary,
   and gateway policy.
9. Empty, partial, malformed, truncated, over-budget, unsupported, or unsealed
   attestations deny cross-revision reuse.
10. Directory listing, search, and Git operations depend on their complete
    result sets, not only on files subsequently opened.
11. Cross-revision in-flight join is forbidden because dependencies are unknown
    until the source invocation is sealed. Same-revision duplicate work may
    join one invocation flight.
12. A superseded confined invocation may finish within a bounded drain window.
    Its result remains historical until target replay succeeds.
13. Lifecycle conclusions are projected again from fresh live state.
14. Failed, timed-out, cancelled, quota-limited, schema-invalid, low-confidence,
    or policy-warning attempts cannot produce reusable evidence in the initial
    production policy.
15. Reuse policy is revalidated at finalization and immediately before every
    external SCM mutation. Disable always wins.
16. Raw credentials, auth payloads, cookies, environment values, raw search
    queries, repository contents, and unrestricted command output are not
    persisted in the control plane.
17. A durably admitted request reserves its revision handoff until run-control
    linkage or its persisted deadline. Newer revisions queue as successors;
    registration and pre-admission cancellation cannot discard admitted work.
18. A T0 review dispatch is distinguished from direct OAuth maintenance by the
    GitHub-signed immutable reusable-workflow identity. Missing or mismatched
    review identity fails closed before nonce or provider lease acquisition.

## Bounded contexts

### Review Run Control

Owns release trust, authorization, source-run identity, revision binding, and
the outer safety decision. It does not decide provider scheduling or evidence
reuse.

### Review Executions

Owns revision streams, generations, work slots, attempts, leases, fencing,
supersession, and `InvocationFlight`.

`InvocationFlight` provides:

- same-revision single-flight;
- durable owner restoration from the provider-execution lease;
- fenced takeover after lease expiry.

It does not schedule account capacity, own a queue, decide whether an
observation is reusable, or control supersession drain behavior.

### Context Attestation

Owns:

- `GatewaySession`;
- `AcceptedDependencyAttestation`;
- canonical dependency operation and result contracts;
- `TargetReplayProof`;
- gateway confinement and binding validation.

It exposes application ports for trusted gateway event ingestion, sealing, and
target replay. SCM, checkout, MCP, and storage details remain adapters.

### Review Evidence

Owns immutable observations, candidate lookup, quality eligibility, retention,
and target-bound reusable attachment authorization.

It refers to an accepted attestation by identifier and digest through an
anti-corruption port. It does not import Context Attestation domain objects,
inspect checkouts, execute Git, or schedule providers.

### Review Projection

Owns consensus, lineage, current-revision placement, and fresh lifecycle
reconciliation. Source observations are facts, never current state.

### Review Publishing

Owns publication plans, permits, external effects, receipts, and compensation.
Every permit binds the target execution, target revision, and projection
digest. The current reuse policy vector and HEAD are checked again during
finalization and as part of the freshness tuple immediately before SCM
mutation.

### Action Review Planning

The public Action owns deterministic extraction, stable content-defined review
units, risk priority, and invocation-envelope construction. This is an Action
domain module, not a server bounded context.

It emits:

- `StableReviewUnitKey`, independent of revision and plan order;
- `PreparedInvocationFingerprint`, independent of execution metadata;
- `ReviewWorkSlotPlan`, bound to one revision;
- `planOrdinal`, used only for scheduling.

## Stable identity

`StableReviewUnitKey` is the SHA-256 digest of canonical JSON containing:

- task kind;
- assigned patch content and required metadata;
- semantic prompt template;
- output schema;
- requested provider and exact model policy;
- capability and execution profile;
- review configuration;
- runtime compatibility and producer release;
- tool policy;
- declared memory or code-graph inputs.

It excludes `headSha`, execution ID, generation, work-slot ID, source run,
attempt, lease, fencing token, plan ordinal, and timestamps.

Stable units use deterministic content-defined boundaries. Risk ordering changes
`planOrdinal`, not unit identity. A unit is split when any configured hard size
limit would be exceeded.

`PreparedInvocationFingerprint` additionally binds the exact provider envelope
and provider vote identity. Same-revision single-flight is keyed by this
fingerprint plus revision and trust domain.

## Trusted context protocol

### Gateway session

Before provider launch, the control plane creates a `GatewaySession` bound to:

- repository and pull request;
- source revision and checkout tree OID;
- execution, work slot, attempt, lease, and fencing token;
- provider, requested model, and capability profile;
- gateway binary digest and gateway policy version;
- producer release and protocol version;
- monotonic event-chain seed and expiry.

The runner must prove that:

- shell and direct filesystem tools are disabled;
- network, browser, web, plugins, tool search, and unrelated MCP servers are
  disabled;
- the ReviewRouter gateway is required and exposes the exact allowlist;
- the checkout is read-only to the provider;
- gateway and provider processes use an ephemeral session.

If confinement cannot be proved, the invocation either fails closed or runs as
`agentic_unbounded_v1`, which is not reusable across revisions.

### Dependency operations

The first protocol supports:

- `file_read`: normalized path, file type, mode, blob OID, symlink target,
  byte range, EOF state, content digest, and byte count;
- `directory_list`: normalized root, tree OID, depth, hidden-file policy,
  ignore-policy digest, case policy, ordered entry digest, and entry count;
- `text_search`: keyed query digest, roots, include/exclude globs, ignore and
  binary policies, case and encoding policies, ordered match digest, match
  count, scanned-tree witness, and complete-result marker;
- `git_fact`: allowlisted operation, canonical operands including relevant
  OIDs, and canonical result digest.

Raw search queries are retained only inside the ephemeral gateway session. The
sealed control-plane record stores a keyed digest and replay-safe encrypted
material or an opaque replay handle with bounded retention.

Each event includes sequence, previous event digest, operation digest, result
digest, accounting, and truncation state. The gateway signs or authenticates
the chain using session-scoped material unavailable to the provider.

### Accepted attestation

A session can be sealed exactly once. Acceptance requires:

- the complete ordered event chain;
- at least one context dependency;
- no unsupported, failed, truncated, or over-budget operation;
- matching attempt, lease, fencing, checkout, gateway, and capability facts;
- terminal provider success with schema-validated complete output;
- proven actual model from trusted runtime telemetry;
- no reuse-denying quality flag.

The accepted attestation is a separate immutable aggregate and persistence
record. An observation stores only its attestation ID and digest. Persistence
enforces referential integrity. Gateway-session expiry closes ingestion and
sealing authority; it does not shorten an already accepted attestation. The
accepted attestation and observation reuse expiries remain the authoritative
reuse lifetime.

### Target replay

Replay executes the source operation sequence through a target checkout adapter.
It never asks the provider to reinterpret operations. A replay succeeds only
when every operation identity, result digest, count, completeness marker, file
metadata, and tree witness matches.

Success creates an immutable `TargetReplayProof` bound to:

- source attestation;
- target revision and checkout tree;
- target execution and work slot;
- replay binary and policy;
- completion time and expiry.

Any mismatch is a normal reuse miss and schedules fresh provider work.

## Reuse flow

1. Plan stable units for the target revision.
2. Attach exact-revision accepted evidence when current policy permits.
3. Probe cross-revision candidates by stable unit, provider vote, and trust
   compatibility.
4. If a compatible source invocation is draining, wait only within the bounded
   salvage budget. Never join it as target work.
5. Replay the accepted source attestation on the target revision.
6. Ask Review Evidence to authorize reuse through its Context Attestation
   anti-corruption port.
7. Issue a one-use, short-lived capability bound to the target execution, slot,
   revision, observation, replay proof, and current `ReusePolicyVector`.
8. Attach an evidence reference without moving the source observation.
9. Project findings and lifecycle conclusions against current revision state.
10. Recheck target currency, policy vector, projection digest, and permit
    immediately before each external mutation.

The API and worker use the same canonical policy-vector representation. The
worker rebuilds that vector from current safety decisions, producer-release
registration, gateway policy, and gateway binary facts. Missing or changed
facts fail closed before the SCM credential can be used.

If any step fails, normal fresh invocation continues. Reuse denial is not a
provider failure.

## Invocation flights and capacity

Cross-revision reuse does not require cross-revision single-flight.

`InvocationFlight` supports same-revision duplicate join by observing the
durable provider-execution lease. Exact identity includes revision, provider
invocation, prepared manifest, vote identity, runtime compatibility, and safety
policy. A join never creates a second provider call.

The existing provider-vote lane remains conservatively serialized. This is an
admission safety boundary, not an account-capacity model. Credential/account
selection, quota reset parking, weighted fairness, and multi-account
parallelism belong to a separate Provider Capacity bounded context and require
an explicit capacity identity. They must not be inferred from
`providerVoteIdentityHash`.

The Action uses bounded exponential polling with evidence rechecks. Workflow
concurrency keeps the active run and at most the newest pending run. There is no
unpersisted in-process scheduler or fairness cursor in this decision. Leases
use fencing; stale owners cannot report or seal attestations.

On supersession:

1. publication authority is revoked immediately;
2. no new source slots are admitted;
3. unbounded invocations are aborted;
4. confined invocations may drain within a configured budget;
5. successful drained results are stored as historical evidence;
6. target reuse still requires target replay and fresh authorization.

## State models

Gateway session:

```text
opened -> active -> sealed -> accepted
                 -> rejected
                 -> expired
       -> revoked
```

Invocation flight:

```text
absent -> owned -> joined
              -> released
              -> expired -> taken_over
```

Target attachment:

```text
candidate -> replaying -> authorized -> attached -> projected -> publishable
                      -> denied
```

## Reuse policy vector

Every lookup, replay proof, attachment capability, projection, and publication
permit binds the effective policy vector:

- global emergency stop generation;
- workspace and repository policy versions;
- producer release registry generation;
- gateway and replay policy versions;
- eligibility policy version;
- trusted capability profile version;
- provider/model allowlist generation.

A vector change invalidates unused capabilities. Disable or trust downgrade also
blocks finalization and publication of already attached reused evidence until
fresh policy evaluation succeeds.

## Resource policy

- Debounce review admission with a short repository-configurable settle window.
- Bound units, attempts, provider duration, drain duration, gateway operations,
  result bytes, search results, replay work, evidence size, and queue wait.
- Never retry authentication, quota, billing, invalid configuration, or
  deterministic policy failures in a tight loop.
- Apply the server-owned changed-line cap before nonce, credential lease, or
  provider work, with a bounded durable-intent binding wait.
- Treat quota/authentication failures as bounded terminal outcomes for the
  current Action run. Quota parking belongs to Provider Capacity.
- Report partial coverage explicitly when time or slot budgets are exhausted.
- Keep an emergency stop for new sessions, joins, replay, attachment, and
  publication.

## Rollout

1. `disabled`: current exact-revision behavior only.
2. `record_only`: run confined sessions and validate attestations.
3. `shadow_replay`: replay candidates, still run fresh provider work, and
   compare normalized outcomes.
4. `allowlisted`: attach only for explicitly selected repositories and models.
5. `enabled`: repository policy may opt in.

Promotion requires:

- zero stale publications;
- zero accepted unconfined sessions;
- zero fencing violations;
- shadow disagreement below an approved threshold by severity;
- bounded admission wait and replay latency;
- tested emergency disable and rollback.

## Required telemetry

- stable-unit hit and miss;
- attestation accepted and denied by bounded reason;
- replay matched and denied by bounded reason;
- exact-revision and cross-revision attachment;
- same-revision joins and wait duration;
- drained, aborted, expired, and fenced attempts;
- provider calls and estimated tokens avoided;
- admission wait and provider-lane utilization;
- stale publication attempts;
- reused-versus-fresh shadow disagreement;
- policy-vector invalidation.

Telemetry contains identifiers and bounded reason enums, never repository
content, raw queries, prompts, provider output, or credentials.

## Required verification

- push before admission and during first, middle, and final unit;
- two and three rapid pushes;
- same-revision duplicate delivery;
- unchanged unit plus unrelated file;
- changed dependency outside assigned patch;
- new search match outside previously opened files;
- rename, delete, executable-bit change, symlink, submodule, LFS, and binary file;
- base update, rebase, force push, and merge-base change;
- provider, actual model, prompt, schema, configuration, release, gateway, and
  tool-policy drift;
- empty, partial, truncated, reordered, forged, and oversized event chains;
- crash before seal, after seal, before observation, after observation, during
  replay, and after external SCM mutation;
- lease expiry, takeover, and stale owner report;
- auth, quota, timeout, malformed output, and partial coverage;
- lifecycle state change while provider evidence is reused;
- fork and trust-domain mismatch;
- same-revision duplicate work competing with unrelated work;
- policy disable before lookup, replay, attachment, finalization, and SCM write.

End-to-end provider tests run only in disposable sandbox repositories.

## Non-goals

- Reusing arbitrary shell-based or network-dependent agent output
- Reusing evidence across repositories or pull requests
- Treating model output as deterministic
- Persisting repository contents in the control plane
- Letting an old execution publish because its evidence was reusable
- Cross-revision joining before source dependencies are known
