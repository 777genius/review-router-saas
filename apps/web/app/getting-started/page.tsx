import type { Metadata } from "next";
import {
  CheckCircle2,
  CircleDotDashed,
  Cloud,
  Code2,
  FileCode2,
  GitBranch,
  GitPullRequestArrow,
  KeyRound,
  LockKeyhole,
  Network,
  ShieldCheck,
  Terminal,
  Webhook,
  Zap,
} from "lucide-react";
import { Badge, CodeBlock, LinkButton } from "@reviewrouter/ui";
import { LogoMark } from "../logo-mark";
import { createPublicPageMetadata } from "../seo";

export const metadata: Metadata = createPublicPageMetadata({
  title: "Getting started with ReviewRouter",
  description:
    "Install the ReviewRouter GitHub App, merge the current setup PR, connect Codex, Claude Code, or OpenRouter credentials into GitHub Actions secrets, and run AI review in your repository runtime.",
  path: "/getting-started",
});

const codexRepoCommand = `# Open Dashboard -> Enable review -> Codex for the repository.
# Copy and run the complete command generated there.
# It downloads an immutable installer to a temporary file, verifies its SHA-256,
# and only then executes it with a short-lived, repository-scoped setup nonce.`;

const claudeCommand = `claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo owner/repo --app actions`;

const apiKeyCommands = `gh secret set OPENROUTER_API_KEY --repo owner/repo --app actions`;

const workflowManifest = `.github/workflows/reviewrouter.yml
.github/workflows/reviewrouter-interaction.yml
.github/workflows/reviewrouter-codex.yml  # Codex OAuth rotating repos
branch: reviewrouter/setup
runtime: 777genius/review-router reusable workflows`;

const setupSteps = [
  {
    number: "01",
    title: "Install the GitHub App",
    body: "Install ReviewRouter on selected repositories or request organization approval. The App syncs installation metadata, selected repos, setup PR state, and health signals.",
    icon: GitPullRequestArrow,
    tone: "cyan",
  },
  {
    number: "02",
    title: "Create the setup PR",
    body: "From the dashboard, create the setup PR. It uses the reviewrouter/setup branch and adds compact caller workflows, not a hosted code execution path.",
    icon: GitBranch,
    tone: "lime",
  },
  {
    number: "03",
    title: "Merge on GitHub",
    body: "Merge the PR so the default branch owns the workflow. Dashboard progress advances from setup PR open to provider setup after GitHub metadata catches up.",
    icon: CheckCircle2,
    tone: "cyan",
  },
  {
    number: "04",
    title: "Enable review",
    body: "Seed provider access from your machine into GitHub Actions secrets. ReviewRouter records only setup confirmation and safe provider status metadata.",
    icon: KeyRound,
    tone: "magenta",
  },
] as const;

const flowNodes = [
  {
    title: "ReviewRouter",
    body: "Control plane, setup, policy",
    icon: "logo",
  },
  {
    title: "GitHub repo",
    body: "Setup PR and caller workflows",
    icon: FileCode2,
  },
  {
    title: "GitHub Actions",
    body: "Code checkout and review runtime",
    icon: Terminal,
  },
  {
    title: "Model provider",
    body: "Called from customer runtime",
    icon: Cloud,
  },
] as const;

const workflowRows = [
  {
    file: "reviewrouter.yml",
    trigger: "pull_request, merge_group, workflow_dispatch",
    job: "Runs the AI review gate through ReviewRouter reusable runtime.",
    boundary:
      "Top-level permissions are empty, job-level permissions are explicit.",
  },
  {
    file: "reviewrouter-interaction.yml",
    trigger: "review comments, issue comments, workflow_dispatch",
    job: "Handles /rr style interactions and discussion routing.",
    boundary:
      "Uses GitHub OIDC for runtime config and passes only required secrets.",
  },
] as const;

const providerRows = [
  {
    name: "Codex",
    auth: "Server-issued versioned namespace",
    model: "gpt-5.5 default",
    setup:
      "Copy the dashboard-generated command. It claims one exact versioned setup attempt, writes its encrypted payload directly to GitHub, and confirms activation before readiness.",
    icon: "openai",
    badge: "OAuth refresh",
  },
  {
    name: "Claude Code",
    auth: "CLAUDE_CODE_OAUTH_TOKEN",
    model: "sonnet default",
    setup: "Run claude setup-token, then store only the printed token.",
    icon: "claude",
    badge: "OAuth",
  },
  {
    name: "OpenRouter",
    auth: "OPENROUTER_API_KEY",
    model: "Dynamic model catalog",
    setup: "Store the OpenRouter key in GitHub Actions secrets.",
    icon: "openrouter",
    badge: "API key",
  },
] as const;

const boundaryRows = [
  {
    label: "Source code and PR diffs",
    value: "GitHub Actions runner",
    note: "ReviewRouter cloud skips code by default.",
    icon: Code2,
  },
  {
    label: "Provider credentials",
    value: "GitHub Actions secrets",
    note: "Seeded from your machine with gh.",
    icon: LockKeyhole,
  },
  {
    label: "Runtime config",
    value: "GitHub OIDC plus static fallback",
    note: "The workflow asks for metadata, not secret values.",
    icon: Network,
  },
  {
    label: "Fork pull requests",
    value: "Secret-backed review skipped",
    note: "Default workflow avoids exposing provider secrets to forks.",
    icon: ShieldCheck,
  },
] as const;

export default function GettingStartedPage(): React.ReactElement {
  return (
    <main className="home-shell min-h-screen w-full overflow-hidden py-8 md:py-10">
      <section className="mx-auto w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)]">
        <div className="relative isolate overflow-hidden rounded-[2rem] border border-cyan-200/12 bg-[var(--rr-surface-card-strong)] p-4 shadow-[0_28px_120px_-70px_rgba(0,240,255,0.95)] sm:p-6 lg:p-7">
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10 bg-[linear-gradient(rgba(103,232,249,0.055)_1px,transparent_1px),linear-gradient(90deg,rgba(103,232,249,0.035)_1px,transparent_1px),radial-gradient(circle_at_76%_8%,rgba(163,230,53,0.13),transparent_24rem),radial-gradient(circle_at_18%_34%,rgba(0,240,255,0.12),transparent_23rem),linear-gradient(180deg,rgba(2,6,12,0.1),rgba(0,0,0,0.28))] bg-[size:56px_56px,56px_56px,auto,auto,auto]"
          />
          <div
            aria-hidden="true"
            className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-cyan-200/70 to-transparent"
          />
          <div
            aria-hidden="true"
            className="absolute left-6 right-6 top-6 hidden h-px bg-[linear-gradient(90deg,transparent,rgba(0,240,255,0.32)_12%,rgba(163,230,53,0.2)_36%,transparent_37%,transparent_62%,rgba(0,240,255,0.28)_63%,rgba(217,70,239,0.24)_86%,transparent)] lg:block"
          />

          <div className="grid gap-6 lg:grid-cols-[minmax(0,0.82fr)_minmax(430px,1.18fr)] lg:items-stretch">
            <div className="flex min-w-0 flex-col justify-center py-2 lg:py-4">
              <Badge tone="accent">Getting started</Badge>
              <h1 className="mt-6 max-w-3xl text-4xl font-semibold text-cyan-50 sm:text-5xl lg:text-6xl">
                Install the control plane. Keep review execution in your repo.
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-slate-300 sm:text-lg sm:leading-8 lg:max-w-xl">
                The current setup path is four steps: install the GitHub App,
                merge the generated setup PR, seed provider access into GitHub
                Actions secrets, then open a pull request.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <LinkButton href="/dashboard" variant="soft" tone="success">
                  <Zap aria-hidden="true" className="size-5" />
                  Open dashboard
                </LinkButton>
                <LinkButton href="/security" variant="outline">
                  <ShieldCheck aria-hidden="true" className="size-5" />
                  Security model
                </LinkButton>
              </div>
            </div>

            <FlowPanel />
          </div>

          <section className="mt-7 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {setupSteps.map((step) => (
              <SetupStepCard key={step.title} {...step} />
            ))}
          </section>

          <section className="mt-8" aria-labelledby="workflow-title">
            <SectionHeading
              icon={FileCode2}
              title="What the setup PR installs"
              subtitle="The repo receives small caller workflows. The versioned runtime stays in the ReviewRouter repo."
              id="workflow-title"
              meta="Current workflow shape"
            />
            <WorkflowPanel />
          </section>

          <section
            id="codex-oauth-rotating"
            className="mt-8"
            aria-labelledby="provider-title"
          >
            <SectionHeading
              icon={KeyRound}
              title="Provider access"
              subtitle="Pick one auth mode first. You can adjust model, reasoning, fast mode, and provider config later in the dashboard."
              id="provider-title"
            />
            <ProviderMatrix />
          </section>

          <section className="mt-8" aria-labelledby="commands-title">
            <SectionHeading
              icon={Terminal}
              title="Credential commands"
              subtitle="Run these from your own machine. Secret values go directly to GitHub Actions."
              id="commands-title"
            />
            <CommandGrid />
          </section>

          <section className="mt-8" aria-labelledby="boundary-title">
            <SectionHeading
              icon={ShieldCheck}
              title="Operational boundary"
              subtitle="Use this as the mental model before enabling review on sensitive repositories."
              id="boundary-title"
            />
            <BoundaryGrid />
          </section>

          <div className="rr-accent-callout mt-7 grid gap-5 rounded-2xl border border-fuchsia-400/30 bg-[linear-gradient(90deg,rgba(217,70,239,0.08),rgba(0,240,255,0.055),rgba(163,230,53,0.05))] p-5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
            <div className="grid h-14 w-14 place-items-center rounded-2xl border border-lime-300/30 bg-lime-300/[0.08] text-lime-200">
              <CheckCircle2 aria-hidden="true" className="size-6" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-cyan-50">
                Ready means workflow current plus provider confirmed.
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-300">
                If a setup PR was closed or its branch was deleted, recreate it
                from the dashboard and merge the new PR before reseeding
                secrets.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 sm:justify-end">
              <LinkButton href="/dashboard" variant="soft" tone="success">
                Open dashboard
              </LinkButton>
              <LinkButton href="/#compare" variant="outline">
                Compare
              </LinkButton>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function FlowPanel(): React.ReactElement {
  return (
    <div className="relative overflow-hidden rounded-[1.5rem] border border-lime-300/28 bg-[var(--rr-surface-panel)] p-5 shadow-[inset_0_0_0_1px_rgba(190,242,100,0.04),0_0_70px_-42px_rgba(163,230,53,0.95)] sm:p-6">
      <div
        aria-hidden="true"
        className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-lime-200/60 to-transparent"
      />
      <div aria-hidden="true" className="absolute right-5 top-5 flex gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-lime-300 shadow-[0_0_10px_rgba(190,242,100,0.8)]" />
        <span className="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.8)]" />
        <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-400 shadow-[0_0_10px_rgba(217,70,239,0.8)]" />
      </div>
      <Badge tone="success">Current setup route</Badge>
      <h2 className="mt-5 text-2xl font-semibold leading-tight text-cyan-50 sm:text-3xl">
        Control plane hosted.{" "}
        <span className="text-lime-300">Review runtime is yours.</span>
      </h2>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-300">
        ReviewRouter creates and monitors setup, but checkout, PR diff analysis,
        provider calls, prompts, and model output happen inside GitHub Actions.
      </p>

      <div className="mt-7 grid gap-4 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] md:items-center">
        {flowNodes.map((node, index) => (
          <FlowNodeWithConnector
            key={node.title}
            node={node}
            showConnector={index < flowNodes.length - 1}
          />
        ))}
      </div>

      <div className="mt-7 rounded-2xl border border-cyan-200/12 bg-[var(--rr-surface-panel)] p-3">
        <div className="mb-3 flex items-center gap-2 font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-cyan-100">
          <Webhook aria-hidden="true" className="size-4" />
          Setup PR manifest
        </div>
        <CodeBlock code={workflowManifest} />
      </div>
    </div>
  );
}

function FlowNodeWithConnector({
  node,
  showConnector,
}: {
  readonly node: (typeof flowNodes)[number];
  readonly showConnector: boolean;
}): React.ReactElement {
  return (
    <>
      <div className="min-w-0 text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-cyan-300/28 bg-cyan-300/[0.075] text-cyan-100 shadow-[0_0_36px_-22px_rgba(0,240,255,1)]">
          {node.icon === "logo" ? (
            <LogoMark size="sm" className="h-12 w-12 rounded-xl" />
          ) : (
            <node.icon aria-hidden="true" className="size-7" />
          )}
        </div>
        <h3 className="mt-3 text-sm font-semibold leading-5 text-cyan-50">
          {node.title}
        </h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">{node.body}</p>
      </div>
      {showConnector ? <FlowConnector /> : null}
    </>
  );
}

function FlowConnector(): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      className="hidden h-px min-w-8 bg-[linear-gradient(90deg,rgba(163,230,53,0.15),rgba(163,230,53,0.9),rgba(0,240,255,0.35))] md:block"
    />
  );
}

function SetupStepCard({
  number,
  title,
  body,
  icon: Icon,
  tone,
}: (typeof setupSteps)[number]): React.ReactElement {
  return (
    <article className="relative min-h-full overflow-hidden rounded-2xl border border-cyan-200/10 bg-[var(--rr-surface-panel)] p-5 shadow-[inset_0_1px_0_rgba(103,232,249,0.08)]">
      <div
        aria-hidden="true"
        className={
          tone === "lime"
            ? "absolute inset-x-0 top-0 h-px bg-lime-300/45"
            : tone === "magenta"
              ? "absolute inset-x-0 top-0 h-px bg-fuchsia-300/45"
              : "absolute inset-x-0 top-0 h-px bg-cyan-300/45"
        }
      />
      <div className="mb-4 flex items-center justify-between gap-3">
        <span
          className={[
            "grid h-11 w-11 shrink-0 place-items-center rounded-xl border bg-cyan-300/[0.08]",
            tone === "lime"
              ? "border-lime-300/30 text-lime-200"
              : tone === "magenta"
                ? "border-fuchsia-300/30 text-fuchsia-200"
                : "border-cyan-300/30 text-cyan-200",
          ].join(" ")}
        >
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <span className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Step {number}
        </span>
      </div>
      <h3 className="text-lg font-semibold leading-6 text-cyan-50">{title}</h3>
      <p className="mt-3 text-sm leading-6 text-slate-400">{body}</p>
    </article>
  );
}

function SectionHeading({
  icon: Icon,
  id,
  title,
  subtitle,
  meta,
}: {
  readonly icon: typeof ShieldCheck;
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly meta?: string;
}): React.ReactElement {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-200 shadow-[0_0_28px_-16px_rgba(0,240,255,0.9)]">
          <Icon aria-hidden="true" className="size-5" />
        </div>
        <div className="min-w-0">
          <h2
            id={id}
            className="text-2xl font-semibold text-cyan-50 sm:text-3xl"
          >
            {title}
          </h2>
          <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
        </div>
      </div>
      {meta ? (
        <p className="font-mono text-[0.68rem] uppercase tracking-[0.18em] text-slate-500">
          {meta}
        </p>
      ) : null}
    </div>
  );
}

function WorkflowPanel(): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-2xl border border-cyan-200/12 bg-[var(--rr-surface-panel)] shadow-[inset_0_1px_0_rgba(103,232,249,0.08)]">
      <div className="overflow-x-auto">
        <table className="min-w-[760px] w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-cyan-200/14 bg-cyan-300/[0.035] font-mono text-[0.68rem] uppercase tracking-[0.18em] text-slate-400">
              <th className="px-4 py-4 font-semibold">File</th>
              <th className="px-4 py-4 font-semibold">Triggers</th>
              <th className="px-4 py-4 font-semibold">Job</th>
              <th className="px-4 py-4 font-semibold">Boundary</th>
            </tr>
          </thead>
          <tbody>
            {workflowRows.map((row) => (
              <tr
                key={row.file}
                className="border-b border-cyan-200/10 last:border-b-0"
              >
                <td className="px-4 py-5 font-mono text-cyan-100">
                  {row.file}
                </td>
                <td className="px-4 py-5 text-slate-300">{row.trigger}</td>
                <td className="px-4 py-5 text-slate-300">{row.job}</td>
                <td className="px-4 py-5 text-lime-200">{row.boundary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-4 border-t border-cyan-200/10 bg-[var(--rr-surface-panel-muted)] p-4 md:grid-cols-3">
        <InlineSignal
          icon={CircleDotDashed}
          title="No pull_request_target"
          body="Default review avoids the dangerous hosted-secret pattern."
        />
        <InlineSignal
          icon={ShieldCheck}
          title="Fork protection"
          body="Secret-backed provider execution is skipped for fork PRs."
        />
        <InlineSignal
          icon={Network}
          title="OIDC config"
          body="Runtime config is fetched through GitHub OIDC when available."
        />
      </div>
    </div>
  );
}

function ProviderMatrix(): React.ReactElement {
  return (
    <div className="grid gap-4 lg:grid-cols-4">
      {providerRows.map((provider) => (
        <article
          key={provider.name}
          className="relative min-h-full overflow-hidden rounded-2xl border border-cyan-200/10 bg-[var(--rr-surface-panel)] p-5 shadow-[inset_0_1px_0_rgba(103,232,249,0.08)]"
        >
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-px bg-cyan-300/45"
          />
          <div className="mb-4 flex items-center justify-between gap-3">
            <ProviderMark provider={provider.icon} />
            <Badge
              tone={provider.badge.includes("OAuth") ? "success" : "neutral"}
            >
              {provider.badge}
            </Badge>
          </div>
          <h3 className="text-lg font-semibold leading-6 text-cyan-50">
            {provider.name}
          </h3>
          <dl className="mt-4 grid gap-3 text-sm">
            <div>
              <dt className="font-mono text-[0.68rem] uppercase tracking-[0.18em] text-slate-500">
                Secret
              </dt>
              <dd className="mt-1 font-mono text-cyan-100">{provider.auth}</dd>
            </div>
            <div>
              <dt className="font-mono text-[0.68rem] uppercase tracking-[0.18em] text-slate-500">
                Model
              </dt>
              <dd className="mt-1 text-slate-300">{provider.model}</dd>
            </div>
          </dl>
          <p className="mt-4 text-sm leading-6 text-slate-400">
            {provider.setup}
          </p>
        </article>
      ))}
    </div>
  );
}

function CommandGrid(): React.ReactElement {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <CommandPanel
        badge="Recommended"
        title="Codex per repository"
        body="Use the dashboard-generated command for the selected repository. Generic Codex commands are intentionally disabled."
        code={codexRepoCommand}
      />
      <CommandPanel
        badge="Claude Code"
        title="Claude Code OAuth token"
        body="Store only the printed setup token. Do not paste local Claude config files."
        code={claudeCommand}
      />
      <CommandPanel
        badge="API keys"
        title="OpenRouter API key mode"
        body="Use normal provider billing when you do not want subscription OAuth."
        code={apiKeyCommands}
      />
    </div>
  );
}

function CommandPanel({
  badge,
  title,
  body,
  code,
}: {
  readonly badge: string;
  readonly title: string;
  readonly body: string;
  readonly code: string;
}): React.ReactElement {
  return (
    <article className="overflow-hidden rounded-2xl border border-cyan-200/12 bg-[var(--rr-surface-panel)] p-4 shadow-[inset_0_1px_0_rgba(103,232,249,0.08)]">
      <Badge tone={badge === "Recommended" ? "success" : "neutral"}>
        {badge}
      </Badge>
      <h3 className="mt-4 text-lg font-semibold text-cyan-50">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-400">{body}</p>
      <div className="mt-4">
        <CodeBlock code={code} />
      </div>
    </article>
  );
}

function BoundaryGrid(): React.ReactElement {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {boundaryRows.map((row) => (
        <InlineSignal
          key={row.label}
          icon={row.icon}
          title={row.label}
          body={`${row.value}. ${row.note}`}
        />
      ))}
    </div>
  );
}

function InlineSignal({
  icon: Icon,
  title,
  body,
}: {
  readonly icon: typeof ShieldCheck;
  readonly title: string;
  readonly body: string;
}): React.ReactElement {
  return (
    <article className="rounded-2xl border border-cyan-200/10 bg-[var(--rr-surface-panel)] p-4">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-200">
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-5 text-cyan-50">
            {title}
          </h3>
          <p className="mt-1 text-xs leading-5 text-slate-400">{body}</p>
        </div>
      </div>
    </article>
  );
}

function ProviderMark({
  provider,
}: {
  readonly provider: (typeof providerRows)[number]["icon"];
}): React.ReactElement {
  return (
    <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-100">
      {provider === "claude" ? (
        <img
          alt=""
          aria-hidden="true"
          className="h-7 w-7"
          src="/service-icons/claude.svg"
        />
      ) : provider === "openrouter" ? (
        <OpenRouterMark />
      ) : (
        <OpenAIMark />
      )}
    </span>
  );
}

function OpenAIMark(): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-7 w-7"
      viewBox="0 0 256 260"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
    </svg>
  );
}

function OpenRouterMark(): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-7 w-7"
      viewBox="0 0 512 512"
      fill="currentColor"
      stroke="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M3 248.945C18 248.945 76 236 106 219C136 202 136 202 198 158C276.497 102.293 332 120.945 423 120.945"
        strokeWidth="90"
      />
      <path d="M511 121.5L357.25 210.268L357.25 32.7324L511 121.5Z" />
      <path
        d="M0 249C15 249 73 261.945 103 278.945C133 295.945 133 295.945 195 339.945C273.497 395.652 329 377 420 377"
        strokeWidth="90"
      />
      <path d="M508 376.445L354.25 287.678L354.25 465.213L508 376.445Z" />
    </svg>
  );
}
