# ReviewRouter AI Docs

This folder is the canonical planning and architecture knowledge base for ReviewRouter.

## Reading Order

1. [Agent Start Here](./AGENT_START_HERE.md)
2. [Root Plan](./ROOT_PLAN.md)
3. [Implementation Playbook](./IMPLEMENTATION_PLAYBOOK.md)
4. [Local Setup Checklist](./LOCAL_SETUP_CHECKLIST.md)
5. [Context Summary](./context-summary.md)
6. [Architecture Overview](./architecture/01-system-overview.md)
7. [Implementation Principles](./appendices/implementation-principles.md)
8. [Blocker Handling](./appendices/blocker-handling.md)
9. [Iteration Roadmap](./iterations/00-roadmap.md)
10. [Decision Records](./decisions/README.md)
11. [Control Plane Protocol](./architecture/10-control-plane-protocol.md)
12. [Generated Workflow Security](./architecture/15-generated-workflow-security.md)
13. [Secret and Trust Model](./architecture/20-secret-and-trust-model.md)
14. [Data Classification](./architecture/22-data-classification.md)
15. [Control Plane Outage Mode](./architecture/27-control-plane-outage-mode.md)
16. [Product Positioning](./product/01-positioning.md)
17. [Risk Register](./risks/01-risk-register.md)
18. [GitHub/OIDC Reality Spike](./spikes/github-app-oidc-reality-spike.md)
19. [Review Agent Runtime Architecture](./architecture/31-review-agent-runtime-architecture.md)
20. [Provider Config Control Plane](./architecture/32-provider-config-control-plane.md)
21. [Codex Secret Seeding](./architecture/33-codex-secret-seeding.md)
22. [Tenant Isolation Invariants](./architecture/34-tenant-isolation-invariants.md)
23. [Dashboard Frontend Architecture](./architecture/35-dashboard-frontend-architecture.md)
24. [UI Component Wrapper Conventions](./architecture/36-ui-component-wrapper-conventions.md)
25. [Frontend Clean Architecture](./architecture/37-frontend-clean-architecture.md)
26. [Visual Direction](./product/08-visual-direction.md)

## Folder Map

- `architecture/` - technical architecture, DDD boundaries, scalability, data, GitHub integration, data classification.
- `product/` - product strategy, UX, packaging, monetization path, beta readiness.
- `decisions/` - important architecture/product decision records.
- `iterations/` - execution plan split into sequential implementation iterations.
- `risks/` - product, security, technical, and operational risks.
- `operations/` - deployment, observability, runbooks, support model, incident response, supply chain security, telemetry privacy, quotas, privacy/legal launch checklist.
- `appendices/` - glossary, open questions, existing action context, quality bar.
- `spikes/` - reality checks against external systems before full implementation.

## Implementation Handoff

New agents should start with [Agent Start Here](./AGENT_START_HERE.md), then follow [Implementation Playbook](./IMPLEMENTATION_PLAYBOOK.md). Together they summarize the current repo state, locked decisions, implementation order, forbidden work, commands, and definition of done.

If an agent is blocked by a missing external action, it should follow [Blocker Handling](./appendices/blocker-handling.md) and continue with unblocked useful work.

## Frontend Implementation Map

Use these documents together:

- [ADR-015: Dashboard Frontend Stack](./decisions/015-dashboard-frontend-stack.md) - selected libraries and ownership rules.
- [ADR-016: Cyberpunk-Future Visual Direction](./decisions/016-cyberpunk-future-visual-direction.md) - accepted brand direction.
- [Dashboard Frontend Architecture](./architecture/35-dashboard-frontend-architecture.md) - app structure and state categories.
- [UI Component Wrapper Conventions](./architecture/36-ui-component-wrapper-conventions.md) - how `packages/ui` wraps Base UI.
- [Frontend Clean Architecture](./architecture/37-frontend-clean-architecture.md) - DDD, ports/adapters, SOLID, dependency direction.
- [Visual Direction](./product/08-visual-direction.md) - tokens, typography, motion, accessibility, and first screens.

Frontend defaults:

```text
Next.js App Router
Base UI through packages/ui
Tailwind CSS
Zustand for client UI state
TanStack Query through tRPC for server state
nuqs for URL state
React Hook Form + Zod for forms
```
