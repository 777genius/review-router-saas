import { Badge, Card, CodeBlock, LinkButton } from "@reviewrouter/ui";

const safeReport = `Repository: owner/repo
Pull request: https://github.com/owner/repo/pull/123
Workflow run: https://github.com/owner/repo/actions/runs/123456
ReviewRouter action ref: 777genius/review-router@main
Safe error category: provider_auth_missing | codex_failed | no_inline_comments
What changed recently: setup PR merged, secret reseeded, config changed`;

const unsafeItems = [
  "Codex auth.json contents, refresh tokens, API keys, or GitHub tokens",
  "private source code snippets or full PR diffs",
  "raw prompts, model output dumps, or logs containing secrets",
  "GitHub App private keys or webhook secrets",
] as const;

const supportSteps = [
  {
    title: "Start with the workflow run URL",
    body: "The run URL gives enough metadata to identify action version, event type, and failure stage without copying secrets or source code.",
  },
  {
    title: "Use safe error categories",
    body: "Prefer categories like provider_auth_missing, codex_failed, workflow_missing, oidc_exchange_failed, or no_inline_comments instead of pasting full logs.",
  },
  {
    title: "Escalate security privately",
    body: "If a report could involve leaked credentials, tenant isolation, or workflow secret exposure, do not open a public issue. Use the private beta support channel agreed with the maintainer until the production security contact is published.",
  },
] as const;

export default function SupportPage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <div className="space-y-5">
          <Badge tone="accent">Trusted beta support</Badge>
          <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-cyan-50 md:text-7xl">
            Debug with metadata, not secrets.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            ReviewRouter support should be able to diagnose installation,
            workflow, provider, and health problems without seeing customer
            code, diffs, or provider credentials.
          </p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href="/getting-started">Getting started</LinkButton>
            <LinkButton href="/security" variant="soft" tone="success">
              Security model
            </LinkButton>
            <LinkButton href="/dashboard" variant="outline">
              Dashboard
            </LinkButton>
            <LinkButton href="/status" variant="ghost">
              Status
            </LinkButton>
          </div>
        </div>

        <Card className="space-y-4">
          <Badge tone="success">Safe report template</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Send links and categories first.
          </h2>
          <p className="text-sm leading-6 text-slate-300">
            For trusted beta, use the private support channel or GitHub issue
            only after redacting anything sensitive. Start with this shape:
          </p>
          <CodeBlock code={safeReport} />
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {supportSteps.map((step) => (
          <Card key={step.title} className="space-y-3">
            <Badge tone="neutral">Support path</Badge>
            <h2 className="text-xl font-semibold text-cyan-50">{step.title}</h2>
            <p className="text-sm leading-6 text-slate-300">{step.body}</p>
          </Card>
        ))}
      </section>

      <Card className="space-y-4 border-red-300/20">
        <Badge tone="danger">Do not paste</Badge>
        <h2 className="text-2xl font-semibold text-cyan-50">
          Keep these out of tickets and public issues.
        </h2>
        <ul className="grid gap-3 text-sm leading-6 text-slate-300 md:grid-cols-2">
          {unsafeItems.map((item) => (
            <li
              key={item}
              className="rounded-xl border border-red-300/10 bg-red-300/5 p-3"
            >
              {item}
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}
