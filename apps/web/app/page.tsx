import { Badge, LinkButton } from "@reviewrouter/ui";
import { LoadingLinkButton } from "./loading-link-button";
import {
  getDashboardMutationStatus,
  getDashboardWorkspaceScope,
} from "../src/server/dashboard-mutations";
import { countConnectedGitHubInstallations } from "../src/server/connected-installations";
import { getGitHubAppInstallUrl } from "../src/server/github-app-install-url";

const setupSteps = [
  {
    title: "Install GitHub App",
    body: "Choose one repository, selected repositories, or an organization. ReviewRouter only syncs metadata.",
    badge: "Step 1",
  },
  {
    title: "Merge setup PR",
    body: "A compact reusable workflow is added through a pull request, so your repository controls what runs.",
    badge: "Step 2",
  },
  {
    title: "Connect provider",
    body: "Run one local command to seed Codex OAuth or API keys directly into GitHub Actions secrets.",
    badge: "Step 3",
  },
] as const;

const supportBadges = [
  "Codex OAuth",
  "OpenAI API key",
  "OpenRouter",
  "Personal repos",
  "Organizations",
] as const;

export default async function HomePage(): Promise<React.ReactElement> {
  const appInstallUrl = getGitHubAppInstallUrl();
  const [mutationStatus, workspaceScope] = await Promise.all([
    getDashboardMutationStatus(),
    getDashboardWorkspaceScope(),
  ]);
  const connectedInstallations = mutationStatus.signedIn
    ? await countConnectedGitHubInstallations(workspaceScope)
    : 0;
  const hasConnectedApp = connectedInstallations > 0;
  const primaryHref = hasConnectedApp
    ? "/dashboard"
    : (appInstallUrl ?? "/setup");
  const primaryLabel = hasConnectedApp
    ? "Open dashboard"
    : "Install GitHub App";
  const secondaryHref =
    hasConnectedApp && appInstallUrl ? appInstallUrl : "/getting-started";
  const secondaryLabel =
    hasConnectedApp && appInstallUrl ? "Manage App access" : "See setup steps";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 md:py-10">
      <section className="relative px-1 py-8 sm:px-4 sm:py-10 lg:px-8">
        <div className="relative mx-auto flex max-w-5xl flex-col items-center text-center">
          <div className="pointer-events-none absolute left-1/2 top-0 h-72 w-72 -translate-x-1/2 rounded-full bg-cyan-300/12 blur-3xl" />
          <div className="pointer-events-none absolute right-4 top-44 h-56 w-56 rounded-full bg-fuchsia-400/10 blur-3xl" />
          <Badge tone="success">3 minute setup</Badge>
          <h1 className="mt-6 max-w-5xl text-4xl font-extrabold leading-[0.98] tracking-[-0.06em] text-cyan-50 [overflow-wrap:anywhere] sm:text-6xl md:text-7xl">
            AI code review that stays inside your CI
          </h1>
          <p className="mt-5 max-w-3xl text-base leading-7 text-slate-300 [overflow-wrap:anywhere] sm:text-xl sm:leading-8">
            Install the GitHub App, merge one compact workflow PR, then connect
            Codex or API keys directly to GitHub Actions secrets.
          </p>

          <div className="mt-7 grid w-full max-w-xl gap-3 sm:flex sm:justify-center">
            <LoadingLinkButton
              href={primaryHref}
              size="lg"
              className="min-h-14 w-full rounded-2xl px-8 text-base sm:w-auto"
              pendingLabel={
                hasConnectedApp ? "Opening dashboard..." : "Opening GitHub..."
              }
            >
              {primaryLabel}
            </LoadingLinkButton>
            <LoadingLinkButton
              href={secondaryHref}
              variant="outline"
              size="lg"
              className="min-h-14 w-full rounded-2xl px-8 text-base sm:w-auto"
              pendingLabel={
                hasConnectedApp && appInstallUrl
                  ? "Opening GitHub..."
                  : "Opening guide..."
              }
            >
              {secondaryLabel}
            </LoadingLinkButton>
          </div>

          <div className="mt-6 flex max-w-3xl flex-wrap justify-center gap-2 text-sm text-slate-400">
            {supportBadges.map((badge) => (
              <span
                key={badge}
                className="rounded-full border border-cyan-200/10 bg-cyan-300/[0.045] px-3 py-1.5"
              >
                {badge}
              </span>
            ))}
          </div>

          <div className="mt-9 grid w-full gap-4 md:grid-cols-3">
            {setupSteps.map((item) => (
              <div
                key={item.title}
                className="group min-h-56 rounded-[2rem] border border-white/10 bg-white/[0.035] p-6 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] transition hover:-translate-y-1 hover:border-cyan-200/25 hover:bg-cyan-300/[0.055] sm:p-7"
              >
                <Badge tone="neutral">{item.badge}</Badge>
                <h2 className="mt-6 text-2xl font-semibold tracking-[-0.03em] text-cyan-50">
                  {item.title}
                </h2>
                <p className="mt-4 text-base leading-7 text-slate-300">
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-[2rem] border border-cyan-300/[0.12] bg-[#0a0a0f]/72 p-6 shadow-[0_20px_90px_-58px_rgba(0,240,255,0.7)] sm:p-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="min-w-0">
            <Badge tone="accent">Runtime boundary</Badge>
            <h2 className="mt-4 text-2xl font-semibold tracking-[-0.03em] text-cyan-50">
              SaaS configures. GitHub Actions executes.
            </h2>
            <p className="mt-3 max-w-4xl text-sm leading-6 text-slate-300 sm:text-base sm:leading-7">
              ReviewRouter stores installation metadata, model settings, health,
              and audit state. It does not store code, PR diffs, prompts, Codex
              OAuth files, or provider API keys.
            </p>
          </div>
          <div className="grid gap-3 sm:flex lg:justify-end">
            <LinkButton href="/security" variant="outline" size="lg">
              Security model
            </LinkButton>
            <LinkButton href="/getting-started" variant="outline" size="lg">
              Setup guide
            </LinkButton>
          </div>
        </div>
      </section>
    </main>
  );
}
