# ReviewRouter

ReviewRouter SaaS planning and spike repository.

This repo starts as a documentation-first project. The implementation will be built from the plans and architecture notes in [`ai-docs`](./ai-docs/README.md).

Current product direction: ReviewRouter is a SaaS control plane for AI pull request review. Review execution runs in the customer's CI/CD by default, while the SaaS owns onboarding, GitHub App integration, policies, workflow provisioning, audit, and configuration.

## Start Here

New implementation agents should read:

1. [`ai-docs/AGENT_START_HERE.md`](./ai-docs/AGENT_START_HERE.md)
2. [`ai-docs/ROOT_PLAN.md`](./ai-docs/ROOT_PLAN.md)
3. [`ai-docs/IMPLEMENTATION_PLAYBOOK.md`](./ai-docs/IMPLEMENTATION_PLAYBOOK.md)
4. [`ai-docs/LOCAL_SETUP_CHECKLIST.md`](./ai-docs/LOCAL_SETUP_CHECKLIST.md)
5. [`ai-docs/appendices/blocker-handling.md`](./ai-docs/appendices/blocker-handling.md)
6. [`ai-docs/iterations/00-roadmap.md`](./ai-docs/iterations/00-roadmap.md)

The next implementation phase is [`Iteration 01 - Foundation`](./ai-docs/iterations/01-foundation.md).

## Current Checks

```bash
pnpm db:migrate:deploy
pnpm db:migrate:smoke
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm spike:test
pnpm local:check
git diff --check
```
