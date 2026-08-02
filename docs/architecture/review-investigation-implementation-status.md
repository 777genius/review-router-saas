# Review Investigation implementation status

Updated: 2026-08-02

## Implemented locally

- Phases 0-8: bounded context, persistence/recovery, protocol, Context Gateway
  v4, Codex/Claude adapters, multi-turn orchestration, critic, certificate, and
  shadow projection.
- Phase 9: selective cross-revision receipt replay, exact coverage-contract
  binding, fresh target critic, supersession checks, and disposable Git E2E.
- Phase 10 code: sanitized telemetry model, append-only Prisma adapter, operator
  read model, alerts, deterministic promotion reports, and disposable corpus.
- Phase 11 safeguards: six-capability dependency policy, cohort selector domain,
  emergency override, separate verified-clean effects gate, migration smoke, and
  rollout/rollback documentation.

## Deliberately not enabled

All investigation capabilities remain disabled by default. This implementation
does not claim production promotion because no approved real shadow cohort was
run during local development.

The following Definition of Done items remain operational gates:

1. collect approved shadow samples with trusted usage/model attribution;
2. archive an immutable promotion report that meets production thresholds;
3. verify hosted and self-hosted disposable E2E against registered release IDs;
4. obtain owner approval and enable one internal/test cohort;
5. re-evaluate emergency/cohort policy at every server-side semantic and SCM
   mutation gate before broader rollout;
6. merge, release, and deploy the paired SaaS and public Action changes in the
   documented order.

Until those gates are complete, findings effects, verified clean, and
cross-revision replay must remain off in production.
