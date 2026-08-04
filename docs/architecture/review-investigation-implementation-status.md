# Review Investigation implementation status

Updated: 2026-08-04

## Implemented locally

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

## Locally proven

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

## Deliberately not enabled

All investigation capabilities remain disabled by default. This implementation
does not claim production promotion because no approved real shadow cohort was
run during local development.

The following Definition of Done items remain operational release gates:

1. collect approved shadow samples with trusted usage/model attribution and
   externally evaluated ground truth;
2. archive an immutable promotion report that meets production thresholds;
3. archive a live sandbox GitHub E2E for hosted and self-hosted deployments
   against the same registered paired release IDs;
4. obtain owner approval and enable one internal/test cohort;
5. merge, release, and deploy the paired SaaS and public Action changes in the
   documented order.

Until those gates are complete, findings effects, verified clean, and
cross-revision replay must remain off in production.

The Claude Code adapter and provider-neutral contract tests are implemented,
but Claude is not a production investigation or independent-critic lane yet.
Activation requires a separately fenced producer manifest that binds the exact
Claude provider/model authority, a matching capability descriptor, and an
approved shadow cohort. A Codex parent manifest must never authorize a Claude
critic implicitly.
