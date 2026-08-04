# Review Investigation implementation status

Updated: 2026-08-04

## Implemented and merged

- Phases 0-8: bounded context, persistence/recovery, additive protocol, Context
  Gateway v4, provider-neutral Codex/Claude adapters, durable multi-turn
  orchestration, critic, certificate, and record-only shadow projection.
- Phase 9: selective cross-revision receipt replay, exact coverage-profile
  binding, deterministic server-owned probe/search expansion, operation-backed
  discovery claims, complete page/file-read closure, fresh target critic, and
  supersession checks.
- Phase 10: sanitized telemetry, append-only Prisma stores, operator read model,
  alerts, signed external-evaluation import, trust-profile verification,
  serialized promotion decisions, deterministic reports, and shadow evidence.
- Phase 11 safeguards: six-capability dependency policy, cohort selector domain,
  strict environment selector adapter, shared database-backed emergency stop,
  per-effect policy re-evaluation, explicit production allowlists, authoritative
  projection lineage, separate verified-clean effects gate, bounded fenced
  retention maintenance, migration smoke, and rollout/rollback documentation.

## Verification evidence

- The production-shaped disposable Git/API/Prisma/fake-agent lifecycle passes
  through restart, idempotent replay, relation expansion, signed evaluation,
  promotion, and superseded-head fail-closed behavior.
- All 55 migrations apply to a fresh disposable PostgreSQL database. Real Prisma
  contract tests pass for investigation state, run control, shadow evidence, and
  signed evaluations.
- The paired Action and SaaS coverage profile is canonicalized to SHA-256
  `4462900f2e610b2649101987f1131158312b2ad8d453e1fb5f048174f9fbfdc9`.
- Full architecture, type, unit/integration, build, protocol, formatting, and
  Compose readiness/fake-control-plane gates pass locally. The committed Action
  entrypoint is executed under a no-network fake boundary, and the paired
  source-level Action/SaaS harness binds the same artifact digests. Repository
  contents and provider credentials are not used by these disposable gates.

## Dormant production deployment

- Public Action PR `777genius/review-router#86` is merged. Immutable release
  commit `295e76f7777a995b8fd0b0bb0a36788429c89b83` is an ancestor of Action
  `main` merge commit `cde842c08ba0c58ca1d606beb8da86fd2eb089c2`.
- SaaS PR `777genius/review-router-saas#103` is merged at
  `126d0d13e38ba31112be85879e5b3429f4e5870d`. Its CI passed Quality Gates,
  paired Action/SaaS production-shaped E2E, hosted readiness, and disposable
  self-hosted E2E.
- Render web, API, and worker services are live on SaaS commit
  `126d0d13e38ba31112be85879e5b3429f4e5870d`. The production Action override is
  pinned to the immutable Action release commit above; the prior release remains
  in the bounded rollback allowlist.
- All six investigation rollout environment flags are unset, which is the
  fail-closed disabled state. No investigation comments, checks, merge signals,
  or cross-revision reuse are enabled by this deployment.

## Deliberately not enabled

All investigation capabilities remain disabled by default. This implementation
does not claim production promotion because no approved real shadow cohort was
run during release validation.

The merge and dormant deployment gate is complete. The following Definition of
Done items remain operational activation gates:

1. register the exact paired producer release and capability manifest for an
   explicitly approved test cohort;
2. archive a live sandbox GitHub E2E for hosted and self-hosted deployments
   against those same paired release IDs;
3. collect approved shadow samples with trusted usage/model attribution and
   externally evaluated ground truth;
4. archive an immutable promotion report that meets production thresholds;
5. obtain owner approval and enable one internal/test cohort.

Until those gates are complete, findings effects, verified clean, and
cross-revision replay must remain off in production.

The Claude Code adapter and provider-neutral contract tests are implemented,
but Claude is not a production investigation or independent-critic lane yet.
Activation requires a separately fenced producer manifest that binds the exact
Claude provider/model authority, a matching capability descriptor, and an
approved shadow cohort. A Codex parent manifest must never authorize a Claude
critic implicitly.
