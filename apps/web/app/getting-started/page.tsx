import type { Metadata } from "next";
import { Badge, Card, CodeBlock, LinkButton } from "@reviewrouter/ui";
import { resolveCodexSeedScriptUrl } from "@/server/codex-seed-script-url";
import { createPublicPageMetadata } from "../seo";

export const metadata: Metadata = createPublicPageMetadata({
  title: "Set up AI code review in GitHub Actions",
  description:
    "Install ReviewRouter on GitHub, merge a setup PR, and run Codex, Claude Code, OpenAI, or OpenRouter code review inside your own GitHub Actions environment.",
  path: "/getting-started",
});

const seedScriptUrl = resolveCodexSeedScriptUrl();
const repoCodexCommand = `curl -fsSL ${seedScriptUrl} | bash -s -- --confirm-write --scope repo --repo owner/repo`;
const orgCodexCommand = `curl -fsSL ${seedScriptUrl} | bash -s -- --confirm-write --scope org --org acme --visibility selected --repos repo-a,repo-b`;
const openAiKeyCommand =
  "gh secret set OPENAI_API_KEY --repo owner/repo --app actions";
const claudeCodeOAuthCommand =
  "gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo owner/repo --app actions";
const openRouterKeyCommand =
  "gh secret set OPENROUTER_API_KEY --repo owner/repo --app actions";

const installSteps = [
  {
    label: "1",
    title: "Install the GitHub App",
    body: "Install ReviewRouter on selected repositories only. The App is used for repository sync, workflow setup PRs, metadata health, and audit.",
  },
  {
    label: "2",
    title: "Choose one repo in the dashboard",
    body: "Search synced repositories in the dashboard, create the setup PR for one repo, then merge it. The small workflow caller runs review inside GitHub Actions and avoids pull_request_target for default review execution.",
  },
  {
    label: "3",
    title: "Connect provider credentials from your machine",
    body: "After the setup PR is merged, open the repository in the dashboard and use Enable review. The command writes Codex OAuth, Claude Code OAuth, OpenAI, or OpenRouter credentials directly to GitHub Actions secrets.",
  },
  {
    label: "4",
    title: "Open a pull request",
    body: "The workflow fetches metadata-only runtime config through OIDC when available, falls back to static workflow config when needed, and posts review results from customer CI.",
  },
] as const;

export default function GettingStartedPage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <div className="space-y-5">
          <Badge tone="accent">Getting started</Badge>
          <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-cyan-50 md:text-7xl">
            Install once, keep review execution in your CI.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            The fastest safe path is explicit: install the App on selected
            repositories, choose one repo in the dashboard, merge the setup PR,
            then connect provider credentials directly into GitHub Actions
            secrets.
          </p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href="/dashboard">Open dashboard</LinkButton>
            <LinkButton href="/security" variant="soft" tone="success">
              Security model
            </LinkButton>
            <LinkButton href="/support" variant="ghost">
              Support
            </LinkButton>
            <LinkButton href="/privacy" variant="ghost">
              Privacy
            </LinkButton>
          </div>
        </div>

        <Card className="space-y-4">
          <Badge tone="warning">Trust boundary</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Secrets never route through the SaaS.
          </h2>
          <p className="text-sm leading-6 text-slate-300">
            Provider credentials are written from the user&apos;s machine to
            GitHub Actions secrets with <code>gh</code>. For organization usage,
            prefer selected repositories so only approved repos can access Codex
            OAuth or Claude Code OAuth.
          </p>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {installSteps.map((step) => (
          <Card key={step.title} className="space-y-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-cyan-300/30 bg-cyan-300/10 text-sm font-semibold text-cyan-100">
              {step.label}
            </span>
            <h2 className="text-xl font-semibold text-cyan-50">{step.title}</h2>
            <p className="text-sm leading-6 text-slate-300">{step.body}</p>
          </Card>
        ))}
      </section>

      <section
        id="codex-oauth"
        className="grid scroll-mt-28 gap-6 lg:grid-cols-2"
      >
        <Card className="space-y-4">
          <Badge tone="success">Codex subscription</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Repository secret
          </h2>
          <p className="text-sm leading-6 text-slate-300">
            Use this when only one repository needs the reviewer. Developers
            with ordinary repository access cannot read GitHub Actions secret
            values back through the UI or API.
          </p>
          <CodeBlock code={repoCodexCommand} />
        </Card>

        <Card className="space-y-4">
          <Badge tone="success">Codex subscription</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Organization selected repos
          </h2>
          <p className="text-sm leading-6 text-slate-300">
            Use this when several repos should share the same Codex OAuth secret
            without granting it to every repository in the organization.
          </p>
          <CodeBlock code={orgCodexCommand} />
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card className="space-y-4">
          <Badge tone="success">Claude Code subscription</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Claude Code OAuth
          </h2>
          <p className="text-sm leading-6 text-slate-300">
            Run <code>claude setup-token</code> on a trusted machine, then store
            only the printed token as a GitHub Actions secret. Do not store{" "}
            <code>ANTHROPIC_API_KEY</code> for subscription OAuth.
          </p>
          <CodeBlock code={claudeCodeOAuthCommand} />
        </Card>

        <Card className="space-y-4">
          <Badge tone="neutral">API key mode</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">OpenAI API</h2>
          <p className="text-sm leading-6 text-slate-300">
            If a team does not want Codex subscription OAuth, store an API key
            directly in GitHub Actions secrets and select API-key auth in the
            repository config.
          </p>
          <CodeBlock code={openAiKeyCommand} />
        </Card>

        <Card className="space-y-4">
          <Badge tone="neutral">Router mode</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">OpenRouter</h2>
          <p className="text-sm leading-6 text-slate-300">
            OpenRouter follows the same rule: the key belongs in GitHub Actions
            secrets, not in ReviewRouter SaaS.
          </p>
          <CodeBlock code={openRouterKeyCommand} />
        </Card>
      </section>
    </main>
  );
}
