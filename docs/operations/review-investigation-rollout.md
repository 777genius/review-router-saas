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

All capabilities default to disabled. The dependency graph is fail-closed:

- shadow requires recording;
- context critic requires shadow;
- production effects require shadow and context critic;
- verified clean requires context critic and production effects;
- cross-revision replay requires shadow and is promoted independently.

An invalid combination must fail composition rather than silently weaken a gate.

## Cohorts

Each capability may be restricted by workspace, repository connection, provider,
trust domain, and producer release. An empty selector list means the enabled
capability is global. Multiple selectors are OR-ed; fields inside one selector
are AND-ed. Unknown providers never match a Codex or Claude selector.

## Emergency rollback

Emergency disable has precedence over flags and selectors. Re-evaluate policy:

- before authorization and turn planning;
- before critic and certificate issuance;
- before evidence acceptance and finalization;
- immediately before any SCM mutation.

Rollback is flag-first. Keep additive tables and protocol operations in place,
disable effects, and continue the legacy review path. Do not destructively roll
back schema during incident containment.

Recommended order:

1. disable production effects and verified clean;
2. disable cross-revision replay;
3. leave shadow recording on only if the incident is not privacy/security related;
4. use emergency disable when the failure boundary is uncertain;
5. preserve immutable telemetry and promotion reports for diagnosis.

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
