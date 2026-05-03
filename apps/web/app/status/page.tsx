import { Badge, Card, CodeBlock, LinkButton } from "@reviewrouter/ui";

const localChecks = `pnpm beta:check
REVIEW_ROUTER_BETA_CHECK_DB_E2E=1 pnpm beta:check
REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check`;

const incidentClasses = [
  {
    title: "Security critical",
    body: "Invalid webhook/OIDC acceptance, tenant isolation bugs, secret/code logging, leaked GitHub App key, or workflow secret exposure.",
    tone: "danger" as const,
  },
  {
    title: "Reliability high",
    body: "Global setup PR failures, webhook processing outage, stuck worker queue, config fetch outage, or bad action release.",
    tone: "warning" as const,
  },
  {
    title: "Beta notice",
    body: "Local beta status is currently manual. Production launch needs a hosted status page or dashboard status section.",
    tone: "neutral" as const,
  },
] as const;

export default function StatusPage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <div className="space-y-5">
          <Badge tone="accent">Status draft</Badge>
          <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-cyan-50 md:text-7xl">
            Operational status path for trusted beta.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            This page defines how testers should reason about ReviewRouter
            status before production hosting exists. It is intentionally honest:
            status is manual until a hosted status channel is configured.
          </p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href="/support">Report issue</LinkButton>
            <LinkButton href="/security" variant="soft" tone="success">
              Security model
            </LinkButton>
            <LinkButton href="/privacy" variant="outline">
              Privacy draft
            </LinkButton>
            <LinkButton href="/fair-use" variant="ghost">
              Fair use
            </LinkButton>
          </div>
        </div>

        <Card className="space-y-4">
          <Badge tone="success">Readiness commands</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Current health is verified by gates.
          </h2>
          <p className="text-sm leading-6 text-slate-300">
            For trusted beta, the current source of truth is the latest passing
            local and real GitHub smoke run recorded in the readiness docs.
          </p>
          <CodeBlock code={localChecks} />
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {incidentClasses.map((item) => (
          <Card key={item.title} className="space-y-3">
            <Badge tone={item.tone}>{item.title}</Badge>
            <p className="text-sm leading-6 text-slate-300">{item.body}</p>
          </Card>
        ))}
      </section>
    </main>
  );
}
