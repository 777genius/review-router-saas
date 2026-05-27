# Agent Instructions

- Release process, `v1` tag handling, and git flow are documented in [`ai-docs/operations/07-environments-and-release-management.md`](./ai-docs/operations/07-environments-and-release-management.md). Use that file as the source of truth instead of duplicating release steps here.
- Do not deploy on every small change. Build, test, and inspect locally first.
- Deploy only at the end of a coherent batch or when the user explicitly asks for a deploy.
- Before any deploy, verify the local commit with the relevant checks and summarize what changed.
- If hosted deployment is blocked by provider quota or infrastructure state, stop deploying and report the blocker instead of retrying repeatedly.
- UI design: avoid unnecessary nested cards, heavy frames, and stacked background blocks. Prefer clear sections, dividers, tabs, and inline stats; use a bordered card only when it adds real structure.
- UI implementation: reuse existing shared components and Radix-based primitives before adding bespoke controls; extend the shared component layer when the pattern is reusable.
- Data fetching architecture: prefer Next.js Server Components or server-side loaders for first paint, SEO, and authorization-sensitive reads. Use `@tanstack/react-query` for new client-side interactive data flows that need cache reuse, background refetching, polling, optimistic updates, mutations, or invalidation after user actions.
- React Query usage: create query keys as small typed arrays near the feature, keep query/mutation functions in a server/API adapter layer instead of inline in components, set deliberate `staleTime` values, invalidate or update exact affected queries after mutations, and avoid duplicating the same server-read data in both React Query and local component state.
- Do not use React Query for static Server Component content, one-off form submissions with no client cache benefit, or secrets/authorization checks that must stay exclusively server-side.
- E2E repository hygiene: reuse existing disposable test repositories whenever possible. Do not create many one-off GitHub repositories for repeated smoke tests. Create a new test repository only when isolation is required, name it clearly as disposable, record why it exists, and clean it up after the test batch.
