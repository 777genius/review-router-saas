import { Badge, Card, LinkButton } from "@reviewrouter/ui";
import { getGitHubAppInstallUrl } from "../src/server/github-app-install-url";
import { reviewRouterApiDemoUrl } from "./public-urls";

const trustCards = [
  {
    title: "Install selected repos",
    body: "Choose a personal account or organization, then grant access only to repositories that should receive review.",
    badge: "Step 1",
  },
  {
    title: "Merge the setup PR",
    body: "ReviewRouter opens a workflow PR. Your repo controls exactly what runs before anything reviews code.",
    badge: "Step 2",
  },
  {
    title: "Seed provider secrets",
    body: "Codex OAuth, OpenAI, or OpenRouter credentials go directly into GitHub Actions secrets, not into SaaS.",
    badge: "Step 3",
  },
] as const;

export default function HomePage(): React.ReactElement {
  const appInstallUrl = getGitHubAppInstallUrl();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6 md:py-14">
      <section className="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(22rem,0.95fr)] lg:items-stretch">
        <div className="space-y-7 rounded-[2rem] border border-cyan-300/[0.12] bg-[#0a0a0f]/78 p-6 shadow-[0_24px_90px_rgba(0,0,0,0.48),0_0_110px_-56px_rgba(0,240,255,0.95)] backdrop-blur-2xl sm:p-8 lg:p-10">
          <Badge tone="accent">Control plane</Badge>
          <div className="space-y-4">
            <h1 className="max-w-3xl text-5xl font-extrabold leading-[0.95] tracking-[-0.06em] text-cyan-50 md:text-7xl">
              AI pull request review that runs in your CI.
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-slate-300 md:text-xl">
              Connect one repository, merge a setup PR, and keep model execution
              plus provider secrets inside your GitHub Actions.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <LinkButton
              href={appInstallUrl ?? "/dashboard"}
              size="lg"
              className="min-h-14 px-8 text-base"
            >
              Install GitHub App
            </LinkButton>
            <LinkButton
              href="/dashboard"
              variant="outline"
              size="lg"
              className="min-h-14 px-8 text-base"
            >
              Open dashboard
            </LinkButton>
          </div>
          <div className="flex flex-wrap gap-2 text-sm text-slate-400">
            <span className="rounded-full border border-cyan-200/10 bg-cyan-300/[0.04] px-3 py-1.5">
              Personal accounts
            </span>
            <span className="rounded-full border border-cyan-200/10 bg-cyan-300/[0.04] px-3 py-1.5">
              Organizations
            </span>
            <span className="rounded-full border border-cyan-200/10 bg-cyan-300/[0.04] px-3 py-1.5">
              Selected repositories
            </span>
          </div>
        </div>

        <Card className="flex flex-col justify-between gap-8 p-6 sm:p-8">
          <div className="space-y-4">
            <Badge tone="success">Runtime boundary</Badge>
            <h2 className="text-3xl font-semibold tracking-[-0.03em] text-cyan-50">
              SaaS configures. GitHub Actions executes.
            </h2>
            <p className="text-base leading-7 text-slate-300">
              ReviewRouter stores installation metadata, policy, health, and
              audit state. It does not store code, PR diffs, prompts, or Codex
              OAuth files in v1.
            </p>
          </div>
          <div className="grid gap-3">
            <LinkButton href="/security" variant="soft" tone="success">
              Read security model
            </LinkButton>
            <LinkButton href={reviewRouterApiDemoUrl} variant="outline">
              View API demo
            </LinkButton>
          </div>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {trustCards.map((item) => (
          <Card key={item.title} className="space-y-4 p-6">
            <Badge tone="neutral">{item.badge}</Badge>
            <h2 className="text-xl font-semibold text-cyan-50">{item.title}</h2>
            <p className="text-sm leading-6 text-slate-300">{item.body}</p>
          </Card>
        ))}
      </section>

      <section className="rounded-[2rem] border border-lime-300/15 bg-lime-300/[0.05] p-6 shadow-[0_20px_80px_-48px_rgba(190,255,61,0.7)] sm:p-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div>
            <Badge tone="success">Trusted beta path</Badge>
            <h2 className="mt-4 text-2xl font-semibold text-cyan-50">
              Start with one selected repository.
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
              For organizations, install the same App on the org and pick
              selected repositories. The dashboard separates user and org
              workspaces, but the review workflow stays the same.
            </p>
          </div>
          <LinkButton href="/getting-started" variant="outline" size="lg">
            Setup guide
          </LinkButton>
        </div>
      </section>
    </main>
  );
}
