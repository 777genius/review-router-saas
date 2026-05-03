import { Badge, Card, CodeBlock, LinkButton } from "@reviewrouter/ui";

const readinessCommand = "pnpm beta:check";
const fullSmokeCommand =
  "REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check";

const trustCards = [
  {
    title: "Reviews run in your CI",
    body: "ReviewRouter manages setup, policy, health, and audit. The model process runs inside your GitHub Actions workflow.",
    badge: "CI execution",
  },
  {
    title: "No Codex OAuth custody",
    body: "Codex subscription auth stays in repository or organization Actions secrets, or on a trusted persistent runner.",
    badge: "Secret boundary",
  },
  {
    title: "Metadata-only control plane",
    body: "The SaaS path tracks repository metadata, config versions, audit events, health, and setup state. It does not store code or PR diffs in v1.",
    badge: "Privacy model",
  },
] as const;

const setupSteps = [
  "Install the GitHub App on selected repositories.",
  "Open and merge the generated ReviewRouter workflow PR.",
  "Seed provider credentials directly into GitHub Actions secrets.",
  "Open a pull request and let the review run in customer CI.",
] as const;

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
            <LinkButton href="/dashboard">Open dashboard</LinkButton>
            <LinkButton href="/getting-started" variant="outline">
              Getting started
            </LinkButton>
            <LinkButton
              href="https://github.com/777genius/review-router/tree/main/ai-docs"
              variant="outline"
            >
              View architecture
            </LinkButton>
            <LinkButton href="/security" variant="soft" tone="success">
              Security model
            </LinkButton>
            <LinkButton href="/support" variant="ghost">
              Support
            </LinkButton>
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

      <section className="grid gap-4 md:grid-cols-3">
        {trustCards.map((item) => (
          <Card key={item.title} className="space-y-3">
            <Badge tone="neutral">{item.badge}</Badge>
            <h2 className="text-xl font-semibold text-cyan-50">{item.title}</h2>
            <p className="text-sm leading-6 text-slate-300">{item.body}</p>
          </Card>
        ))}
      </section>

      <section className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <Card className="space-y-4 border-lime-300/20 shadow-[var(--rr-shadow-glow-cyan)]">
          <Badge tone="success">Verified path</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Real GitHub smoke, not just mocks.
          </h2>
          <p className="text-sm leading-6 text-slate-300">
            The current beta gate can create a disposable repository, provision
            the workflow through the App, seed Codex OAuth directly into GitHub
            Actions secrets, open a pull request with a known bug, and verify
            the inline ReviewRouter comment.
          </p>
          <CodeBlock code={fullSmokeCommand} />
        </Card>

        <Card className="space-y-4">
          <Badge tone="warning">Install flow</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Four explicit trust steps.
          </h2>
          <ol className="grid gap-3 text-sm leading-6 text-slate-300">
            {setupSteps.map((step, index) => (
              <li
                key={step}
                className="grid grid-cols-[2rem_1fr] items-start gap-3 rounded-xl border border-cyan-200/10 bg-cyan-300/5 p-3"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full border border-cyan-300/30 bg-cyan-300/10 text-xs font-semibold text-cyan-100">
                  {index + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <p className="text-xs leading-5 text-slate-400">
            Fork pull requests skip secret-backed review by default. Workflow
            files should still be protected with branch rules and CODEOWNERS on
            shared repositories.
          </p>
        </Card>
      </section>
    </main>
  );
}
