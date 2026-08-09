# Review Investigation rollout and rollback

Status: dormant implementation. No production cohort is approved by this document.

## Ownership

The `review-investigations` bounded context owns semantic review state. The
`review-investigation-operations` bounded context owns sanitized telemetry,
operator projections, promotion reports, cohort selection, and rollback policy.
Provider adapters report facts; they do not decide rollout eligibility.

## Independent capabilities

1. `review_investigation_recording_enabled`
2. `review_investigation_shadow_enabled`
3. `review_investigation_context_critic_enabled`
4. `review_investigation_verified_clean_enabled`
5. `review_investigation_cross_revision_replay_enabled`
6. `review_investigation_production_effects_enabled`

The corresponding environment variables use the same order:

- `REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED`;
- `REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED`;
- `REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED`;
- `REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED`;
- `REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED`;
- `REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED`.

Recording also requires an independent rotating key ring for investigation
lease capabilities:

- `REVIEW_ROUTER_REVIEW_INVESTIGATION_LEASE_CAPABILITY_ACTIVE_KEY_ID`;
- `REVIEW_ROUTER_REVIEW_INVESTIGATION_LEASE_CAPABILITY_KEYS_JSON`.

The JSON value is a non-empty array of
`{"keyId":"...","secretBase64":"...","verifyUntil":null}` entries. The
active key must be present in the array. Generate a dedicated 32-byte secret;
do not reuse authorization, general Review V2 capability, context replay, or
private-material keys. Keep retired keys only through their bounded verification
window. Missing or malformed lease keys make recording composition fail closed.

`REVIEW_ROUTER_REVIEW_INVESTIGATION_EMERGENCY_DISABLED=1` overrides every
capability. Cohort selectors are supplied through
`REVIEW_ROUTER_REVIEW_INVESTIGATION_SELECTORS_JSON`.

All capabilities default to disabled. The dependency graph is fail-closed:

- shadow requires recording;
- context critic requires shadow;
- production effects require shadow and context critic;
- verified clean requires context critic and production effects;
- cross-revision replay requires shadow and is promoted independently.

An invalid combination must fail composition rather than silently weaken a gate.
Toggle values are strict: unset, empty, or `0` means disabled and `1` means
enabled. Any other value makes the current policy unavailable; this includes the
emergency flag, so a misspelled rollback value cannot silently enable effects.

The six local Action gates are persisted as typed booleans in the repository's
`ReviewConfiguration`, serialized only as exact `0`/`1` values, and delivered by
the existing OIDC runtime-config response. Missing fields migrate to `false`.
The Action intersects these local gates with the immutable server authorization
descriptor; neither side can enable a capability that the other side denied.

Capability negotiation also requires a registered producer release with an
exact `review_investigation_v1` profile. The release binds the generated
coverage-profile hash, policy hash, Context Gateway policy and bundle digest.
Legacy releases omit the profile and continue legacy review. Deploy the
capability-aware server and Action before registering this profile; old/new
mixed versions must never infer support from feature flags alone.

## Cohorts

Each capability may be restricted by workspace, repository connection, provider,
trust domain, and producer release. Recording, shadow, and context critic may use
an empty selector list for a deliberate global cohort. Production effects,
verified clean, and cross-revision replay require an explicit non-empty
allowlist; enabling one without its selector fails closed. Multiple selectors
are OR-ed; fields inside one selector are AND-ed. Unknown providers never match
a Codex or Claude selector.
Every dependency capability must also match the same target. For example,
`production_effects` cannot authorize a repository outside its recording,
shadow, or context-critic cohorts even when all four flags are globally enabled.

Configure selectors with
`REVIEW_ROUTER_REVIEW_INVESTIGATION_SELECTORS_JSON`. The value is an object
keyed by capability. Every value is a bounded selector array; unknown
capabilities, fields, providers, duplicate values, or malformed JSON fail
closed. Selector fields must contain at least one value. Use an empty selector
list only for a deliberate global recording/shadow/critic cohort; an empty
selector object or field is rejected as ambiguous. Example:

```json
{
  "production_effects": [
    {
      "workspaceIds": ["workspace-internal"],
      "repositoryConnectionIds": ["repository-test"],
      "providers": ["codex"],
      "trustDomains": ["trusted-managed"],
      "producerReleaseIds": ["reviewrouter-action.release-id"]
    }
  ]
}
```

The operations application service reads the capability policy and shared Review
Run Control emergency controls for every decision. Environment flags configure
capabilities and cohorts. The database-backed global/workspace/repository stop
is the live kill switch and is visible to already-running API and worker
processes; a missing or unreadable global emergency control fails closed.

## Effect gate matrix

| Effect boundary                                                   | Capability checked                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| Open an investigation                                             | `recording`                                                        |
| Plan/commit/abort a discovery turn                                | `recording`                                                        |
| Plan/commit a critic turn or issue a certificate                  | `context_critic`                                                   |
| Prepare or commit target-revision replay                          | `cross_revision_replay`                                            |
| Accept an investigation certificate into shadow evidence          | `shadow`                                                           |
| Finalize an authoritative investigation projection                | `production_effects`                                               |
| Finalize an authoritative verified-clean projection               | `production_effects` and `verified_clean`                          |
| Apply, clean up, or compensate an investigation-backed SCM effect | `production_effects`, plus `verified_clean` for clean certificates |

Read-only restore/status operations remain available during rollback. Legacy
review publication without an investigation certificate is not coupled to these
flags. A missing policy, malformed selector, missing observation/certificate,
or unavailable policy source denies the investigation effect without exposing
source, credentials, or raw provider output.

## Emergency rollback

### Evidence provenance rollback floor

Once a deployment containing the evidence-provenance writer has accepted a
turn with non-empty `acceptedOperationReceiptIds`, the oldest compatible
rollback target is commit
`a7b8d62824869d674c51d2effd14021b104e9181`. That reader-first release accepts
both legacy dossiers without the field and new dossiers with bound operation
receipt digests. Do not use Render native rollback, redeploy, or a manual image
pin below this SHA after the writer is enabled.

Before a code rollback, verify that the candidate contains the compatibility
floor:

```bash
git merge-base --is-ancestor \
  a7b8d62824869d674c51d2effd14021b104e9181 <candidate-sha>
```

A non-zero result denies the rollback. Code running below the floor cannot
protect itself from data written after its release, so this is a deployment
control-plane invariant rather than an application feature flag. Flag-first
rollback remains the incident response path.

Emergency disable has precedence over flags and selectors. The general review
authorization remains independent so disabling investigations cannot stop the
legacy reviewer. Investigation admission happens at `open`; every later turn
capability is issued only after another live rollout check. Re-evaluate policy:

- before investigation admission and turn-capability issuance;
- before critic and certificate issuance;
- before evidence acceptance and finalization;
- immediately before any SCM mutation.

The worker performs the final check after freshness and lease renewal and before
`applyOperation`, duplicate cleanup, or compensation. A disabled initial effect
is terminalized as no-effect; an unavailable policy is retried without acquiring
new semantic authority or mutating SCM.

Rollback is flag-first. Keep additive tables and protocol operations in place,
disable effects, and continue the legacy review path. Do not destructively roll
back schema during incident containment.

Recommended order:

1. disable production effects and verified clean;
2. disable cross-revision replay;
3. leave shadow recording on only if the incident is not privacy/security related;
4. use emergency disable when the failure boundary is uncertain;
5. preserve immutable telemetry and promotion reports for diagnosis.

## Retention maintenance

Investigation retention maintenance is disabled unless
`REVIEW_ROUTER_REVIEW_INVESTIGATION_MAINTENANCE_ENABLED=1`. The worker acquires
the `review-investigations:retention` lease and runs at most one private-material
batch followed by one terminal-dossier batch per interval. Configure the batch
sizes and schedule with:

Recording cannot be enabled while maintenance is disabled. Production API
composition rejects that configuration before accepting investigation work.

- `REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_PRUNE_BATCH_SIZE`;
- `REVIEW_ROUTER_REVIEW_INVESTIGATION_DOSSIER_PRUNE_BATCH_SIZE`;
- `REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_EVIDENCE_PRUNE_BATCH_SIZE`;
- `REVIEW_ROUTER_REVIEW_INVESTIGATION_PRUNE_INTERVAL_MS`;
- `REVIEW_ROUTER_REVIEW_INVESTIGATION_PRUNE_LOCK_TTL_MS`.

Both batch sizes must be between 1 and 1,000. The database transaction locks a
bounded deterministic set of terminal investigations and rechecks the same
cutoff while deleting. `concluded`, `inconclusive`, `superseded`, and `expired`
aggregates are eligible only after `retainUntil`. Any receipt, turn, or command
receipt with a later `retainUntil`, or any certificate or private-material row
with a later expiry, preserves the entire aggregate. Expired child rows and the
aggregate are removed in one transaction, so a partial graph is never committed.

Sanitized promotion telemetry and immutable promotion reports are not part of
this maintenance job. They remain available for rollout diagnosis and promotion
evidence.

## Operator status

The operator projection may expose investigation ID, scope/revision digests,
state, version, obligation counts, next action, capacity eligibility time, last
typed failure code, conclusion, and release/protocol/gateway compatibility.

It must never expose source code, prompts, search queries, canonical dossiers,
replay material, tokens, cookies, provider credentials, or raw model output.

## Promotion sequence

1. Run the disposable seeded corpus.
2. Collect shadow samples from an explicitly approved cohort.
3. Generate and archive the immutable promotion report.
4. Obtain owner approval and record report hash plus release IDs.
5. Enable findings effects for one internal/test cohort.
6. Enable verified clean separately.
7. Promote cross-revision replay only after independent equivalence evidence.

No live cohort may be enabled solely because unit tests or the disposable corpus
pass.
