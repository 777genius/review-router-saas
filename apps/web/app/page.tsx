import { Badge, Card, CodeBlock } from "@reviewrouter/ui";

const readinessCommand =
  "pnpm local:check && pnpm test && pnpm typecheck && pnpm build";

export default function HomePage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-6">
          <Badge tone="accent">Control plane</Badge>
          <div className="space-y-4">
            <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-cyan-50 md:text-7xl">
              Review routing for AI pull request checks.
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-slate-300">
              Configure GitHub App onboarding, provider policy, workflow setup
              PRs, audit, and health while reviews execute inside customer CI.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <a
              href="/dashboard"
              className="inline-flex h-10 items-center justify-center rounded-lg border border-cyan-300/50 bg-cyan-300 px-4 text-sm font-medium tracking-wide text-slate-950 shadow-[var(--rr-shadow-glow-cyan)] transition hover:bg-cyan-200"
            >
              Open dashboard
            </a>
            <a
              href="https://github.com/777genius/review-router/tree/main/ai-docs"
              className="inline-flex h-10 items-center justify-center rounded-lg border border-cyan-300/40 bg-transparent px-4 text-sm font-medium tracking-wide text-cyan-100 transition hover:bg-cyan-300/10"
            >
              View architecture
            </a>
          </div>
        </div>
        <Card className="space-y-4">
          <Badge tone="success">Local foundation</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Local beta baseline
          </h2>
          <p className="text-sm leading-6 text-slate-300">
            The control plane now covers GitHub App webhooks, repository sync,
            workflow setup PRs, OIDC runtime config, metadata-only health,
            provider setup guidance, entitlements, and worker outbox recovery.
          </p>
          <CodeBlock code={readinessCommand} />
        </Card>
      </section>
    </main>
  );
}
