import { Badge, Button, Card, CodeBlock } from "@reviewrouter/ui";

const setupCommand = "pnpm local:check && pnpm typecheck && pnpm test";

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
            <Button>Start local setup</Button>
            <Button variant="outline">View architecture</Button>
          </div>
        </div>
        <Card className="space-y-4">
          <Badge tone="success">Local foundation</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Iteration 01 status
          </h2>
          <p className="text-sm leading-6 text-slate-300">
            The foundation slice proves the monorepo, UI tokens, Base UI
            wrappers, Zustand UI state, Fastify health route, and feature
            boundaries.
          </p>
          <CodeBlock code={setupCommand} />
        </Card>
      </section>
    </main>
  );
}
