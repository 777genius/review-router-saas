import { Badge, Card, CodeBlock, LinkButton } from "@reviewrouter/ui";
import { reviewRouterApiDemoUrl } from "../public-urls";

const localChecks = `pnpm beta:check
REVIEW_ROUTER_BETA_CHECK_DB_E2E=1 pnpm beta:check
REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check
pnpm hosted:api-demo:check
REVIEW_ROUTER_HOSTED_ENV_FILE=.env.production pnpm hosted:check`;

const statusTiers = [
  {
    label: "Local/private beta",
    state: "Ready for trusted testers",
    tone: "success" as const,
    body: "Dashboard, GitHub App sync, setup PR provisioning, secret seeding guidance, static workflow config, and real GitHub fallback review smoke have passed.",
  },
  {
    label: "Hosted API demo",
    state: "Live on Render",
    tone: "success" as const,
    body: "The public API now exposes health, readiness, OpenAPI, JSON, Markdown, and browser demo endpoints with hosted smoke checks passing.",
  },
  {
    label: "GitHub App lifecycle",
    state: "One manual setting remains",
    tone: "warning" as const,
    body: "Full hosted install sync still depends on enabling installation and installation_repositories webhook events in the GitHub App settings.",
  },
  {
    label: "Production",
    state: "Not claimed",
    tone: "neutral" as const,
    body: "Production needs public beta feedback, billing/support/legal hardening, hosted observability, backup drills, and release compatibility policy.",
  },
] as const;

const provenCapabilities = [
  "GitHub App installation discovery and repository sync.",
  "Workflow setup PR creation through the App.",
  "Codex OAuth setup into GitHub Actions secrets, not SaaS storage.",
  "Real GitHub PR review smoke with inline finding from the action runtime.",
  "Static workflow fallback when local SaaS is not reachable from GitHub-hosted runners.",
  "Metadata-only health report path implemented for hosted OIDC sessions.",
  "Hosted API demo on Render with browser, Markdown, JSON, OpenAPI, health, and readiness checks.",
] as const;

const publicBetaBlockers = [
  "Enable GitHub App lifecycle webhook events: installation and installation_repositories.",
  "Run GitHub-hosted OIDC config fetch and health report E2E against hosted API.",
  "Pin the ReviewRouter Action to a release tag before broad public production installs.",
  "Provision production status/support channel, legal copy review, and incident process.",
] as const;

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
    title: "Beta limitation",
    body: "Local/private beta status is verified by gates and recorded smoke runs. Public status still needs a hosted status channel.",
    tone: "neutral" as const,
  },
] as const;

export default function StatusPage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <div className="space-y-5">
          <Badge tone="accent">Status</Badge>
          <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-cyan-50 md:text-7xl">
            Hosted API demo is live. GitHub App lifecycle is the remaining gate.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            ReviewRouter can be shown to trusted beta users with a live Render
            API demo today. The remaining broad-public gate is GitHub App
            lifecycle event configuration and full GitHub-hosted
            OIDC/config/health verification.
          </p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href="/getting-started">Start setup</LinkButton>
            <LinkButton href="/support">Report issue</LinkButton>
            <LinkButton
              href={reviewRouterApiDemoUrl}
              variant="soft"
              tone="success"
            >
              API demo
            </LinkButton>
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
        {statusTiers.map((item) => (
          <Card key={item.label} className="space-y-3">
            <Badge tone={item.tone}>{item.label}</Badge>
            <h2 className="text-xl font-semibold text-cyan-50">{item.state}</h2>
            <p className="text-sm leading-6 text-slate-300">{item.body}</p>
          </Card>
        ))}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card className="space-y-4">
          <Badge tone="success">Proven</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            What is already validated.
          </h2>
          <ul className="grid gap-3 text-sm leading-6 text-slate-300">
            {provenCapabilities.map((item) => (
              <li
                key={item}
                className="rounded-xl border border-lime-300/10 bg-lime-300/5 p-3"
              >
                {item}
              </li>
            ))}
          </ul>
        </Card>

        <Card className="space-y-4">
          <Badge tone="warning">Before public beta</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            What still must be proven.
          </h2>
          <ul className="grid gap-3 text-sm leading-6 text-slate-300">
            {publicBetaBlockers.map((item) => (
              <li
                key={item}
                className="rounded-xl border border-amber-300/10 bg-amber-300/5 p-3"
              >
                {item}
              </li>
            ))}
          </ul>
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
