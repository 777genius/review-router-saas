# Review Investigation implementation status

Updated: 2026-08-06

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

## v1.0.77 release deployment

- Public Action release `v1.0.77` and moving tag `v1` resolve to immutable
  commit `31f01509879052d787d0d873d76d8f8e3f82c78c`. The exact release checkout
  passed 2,549 tests with 3 skips, typecheck, build, generated metadata checks,
  and an independent source/artifact audit.
- SaaS release fixes are merged through `777genius/review-router-saas#110` and
  `#111`. Render web, API, and worker are live on the same immutable commit
  `02c1ef15970ebf912a57d8f732f2238ebad8e3f3`; API health, readiness, and the
  database dependency report healthy. The exact SaaS tree passed 2,101 tests
  with 70 skips, 389 architecture checks, typecheck, lint, format, and build.
- The paired Action/SaaS release harness passed all 6 scenarios. The real
  PostgreSQL contract suite passed all 14 cases, including recovery and
  persistence boundaries.
- The final SaaS tree passed the disposable self-hosted E2E: all 58 migrations
  applied and reapplied idempotently, 7 production Review v2 scenarios passed,
  2 same-release investigation scenarios passed, the fake OIDC action path
  completed, logs stayed sanitized, and the harness removed its containers,
  network, and volume.
- Producer release `review-action-v2-31f01509-investigation` is registered with
  the `review_investigation_v1` profile, coverage-profile hash
  `4462900f2e610b2649101987f1131158312b2ad8d453e1fb5f048174f9fbfdc9`,
  Context Gateway v4, and the exact Action/runtime/schema digests. The malformed
  legacy-shaped registration `review-action-v2-31f01509` is now irrevocably
  revoked through the domain command.
- API and worker use the same canonical sandbox selector policy. Recording,
  shadow, context critic, and cross-revision replay are enabled only for
  `777genius/review-router-saas-e2e`; verified-clean and production effects stay
  disabled. The bounded Action rollback allowlist retains the previous release
  until old work drains.

## Deliberately not enabled

All investigation capabilities remain disabled by default outside the explicit
sandbox selector. This implementation does not claim production promotion.

The merge and dormant deployment gate is complete. The following Definition of
Done items remain operational activation gates:

1. archive a successful live hosted sandbox review against the exact paired
   release IDs;
2. prove live supersession, stale mutation denial, compatible evidence reuse,
   and rollback on controlled sandbox revisions;
3. collect approved shadow samples with trusted usage/model attribution and
   externally evaluated ground truth;
4. archive an immutable promotion report that meets production thresholds;
5. obtain owner approval before enabling any non-sandbox production effects.

At the 2026-08-06 checkpoint, GitHub reported a major Actions outage and did not
create runs for new sandbox revisions. This is an external availability blocker,
not provider-auth evidence; it must not trigger repeated login or tight-loop
reruns. Until the remaining gates are complete, findings effects and verified
clean must remain off. Cross-revision replay may stay enabled only for the
explicit sandbox selector and must be disabled again after rollback proof.

The Claude Code adapter and provider-neutral contract tests are implemented,
but Claude is not a production investigation or independent-critic lane yet.
Activation requires a separately fenced producer manifest that binds the exact
Claude provider/model authority, a matching capability descriptor, and an
approved shadow cohort. A Codex parent manifest must never authorize a Claude
critic implicitly.
