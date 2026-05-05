import { Badge, Card, CodeBlock, LinkButton } from "@reviewrouter/ui";
import { reviewRouterApiDemoUrl } from "../public-urls";

const verificationGates = `pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm web:smoke
pnpm hosted:ui-audit
REVIEW_ROUTER_FRESH_E2E_MODE=review pnpm spike:github:fresh-repo:e2e`;

const statusTiers = [
  {
    label: "Customer CI runtime",
    state: "Review runs outside SaaS",
    tone: "success" as const,
    body: "The setup PR installs a GitHub Actions workflow. Provider credentials, pull request diffs, prompts, and model execution stay in the customer's repository workflow.",
  },
  {
    label: "Hosted control plane",
    state: "Live on Render",
    tone: "success" as const,
    body: "The public web and API surfaces expose onboarding, health, readiness, OpenAPI, JSON, Markdown, and browser demo endpoints with hosted smoke checks passing.",
  },
  {
    label: "GitHub App lifecycle",
    state: "Install and selected-repo sync",
    tone: "success" as const,
    body: "Personal-account installs are verified end to end. Organization installs use the same installation and selected-repository lifecycle, with owner approval handled by GitHub.",
  },
  {
    label: "Production hardening",
    state: "Roadmap, not setup blocker",
    tone: "neutral" as const,
    body: "The remaining work is operational polish: hosted OIDC E2E expansion, support operations, release compatibility policy, and production observability.",
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

const hardeningRoadmap = [
  "Expand live organization-install E2E with selected repositories and owner approval.",
  "Add a public changelog and release compatibility policy for customers pinned to stable versions.",
  "Formalize support operations, incident response, and legal copy review before broad launch.",
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
    body: "Current status is backed by automated gates and real GitHub smoke runs. A full uptime status page belongs in the production operations package.",
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
            Hosted demo is live. Reviews still run in customer CI.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            ReviewRouter has a live hosted control plane, GitHub App onboarding,
            setup PR provisioning, and metadata-only health surfaces. Reviews
            and provider credentials still stay inside the customer GitHub
            Actions workflow.
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
              Privacy
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
            The demo is checked with repeatable local, hosted, visual, and real
            GitHub pull request tests before changes are shipped.
          </p>
          <CodeBlock code={verificationGates} />
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
          <Badge tone="warning">Hardening roadmap</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            What improves confidence next.
          </h2>
          <ul className="grid gap-3 text-sm leading-6 text-slate-300">
            {hardeningRoadmap.map((item) => (
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
