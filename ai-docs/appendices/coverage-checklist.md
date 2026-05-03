# Documentation Coverage Checklist

This checklist is used to verify that the planning docs captured the current direction.

## Covered

- SaaS as control plane, not cloud execution.
- Customer CI/CD as execution plane.
- No Codex OAuth custody in SaaS v1.
- No repo code/diff custody in SaaS v1.
- TypeScript stack.
- Fastify + tRPC + Next.js.
- Prisma + Postgres.
- Feature-first DDD/Clean Architecture.
- Ports/adapters placement.
- Multi-tenant workspace model.
- GitHub OAuth vs GitHub App distinction.
- Shared GitHub App SaaS model.
- Curl/self-managed mode distinction.
- Provider setup state without secrets.
- Org selected-repo secrets guidance.
- Fork PR secret safety.
- Distributed locks.
- Idempotent webhooks.
- Outbox pattern.
- Multi-instance API/worker scaling.
- Config versioning.
- Audit log.
- Workflow provisioning through PR.
- Action version strategy stable/release/main.
- Free plan first with billing boundary.
- GitHub Actions OIDC action control plane protocol.
- Metadata-only action health reports.
- Tenant isolation and authorization policy service.
- Data retention and privacy defaults.
- Testing strategy.
- Backup, migration, and rate-limit operations.
- GitHub permission matrix.
- Supply chain security policy.
- Generated workflow security and `pull_request_target` ban.
- Static/runtime config resolution rules.
- Versioned action API contracts.
- Web auth, secure sessions, CSRF.
- Environment/release management.
- Beta readiness and launch blockers.
- Auth/OIDC/workflow risks added to risk register.
- GitHub installation lifecycle.
- Same-repository PR trust model.
- Action update compatibility and rollback.
- Incident response and kill switches.
- Support/admin access policy.
- Customer-facing security copy.
- Stable channel resolves to explicit release tag by default.
- Privacy/legal launch checklist.
- Data classification.
- Action payload privacy and size limits.
- Dependency pinning policy.
- Abuse quotas and fair-use.
- Database constraints and indexes.
- Webhook normalization without raw payload storage.
- OIDC JWKS/cache/clock-skew/action-session security.
- Control-plane outage mode and static fallback.
- Event versioning and poison job/dead-letter handling.
- Telemetry/tracing privacy.
- Workspace membership lifecycle and owner safety.
- Product positioning.
- Main risks.
- Iteration roadmap.
- Existing ReviewRouter Action context.
- Agent handoff guide for implementation agents.
- End-to-end implementation playbook from planning repo to public beta.
- Local setup checklist and local readiness check.
- Dashboard frontend stack.
- Base UI wrapper convention.
- Frontend Clean Architecture and SOLID boundaries.
- Zustand state ownership limits.
- Cyberpunk-future visual direction and design tokens.
- Auth.js behind auth ports.
- One-click workflow provisioning with `workflows: write`.

## Still Needs Decision Later

- beta free limits
- action-to-SaaS telemetry schema
- payment model
- exact production deployment topology for web/API split
- exact chart/table usage once dashboard analytics screens exist
