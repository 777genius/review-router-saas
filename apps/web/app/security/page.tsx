import type { Metadata } from "next";
import {
  AlertTriangle,
  BookOpen,
  Cloud,
  Code2,
  Database,
  ExternalLink,
  KeyRound,
  LockKeyhole,
  Network,
  RadioTower,
  ShieldCheck,
  Terminal,
  Webhook,
  Workflow,
} from "lucide-react";
import { Badge, CodeBlock, LinkButton } from "@reviewrouter/ui";
import { resolveCodexSeedScriptUrl } from "@/server/codex-seed-script-url";
import { githubSecretPermissionDocs } from "../github-app-permission-doc-links";
import { LogoMark } from "../logo-mark";
import { createPublicPageMetadata } from "../seo";

export const metadata: Metadata = createPublicPageMetadata({
  title: "Security model for AI code review",
  description:
    "ReviewRouter security model for privacy-first AI code review: GitHub App setup, GitHub Actions execution, OIDC runtime config, and secret boundaries.",
  path: "/security",
});

const secretCommand = `# Copy the full repo-scoped Codex command from the ReviewRouter dashboard.
# It uses ${resolveCodexSeedScriptUrl()} with a short-lived setup nonce and writes REVIEWROUTER_CODEX_AUTH_JSON directly to GitHub Actions secrets.`;

const securitySignals = [
  {
    label: "Code storage",
    title: "Review execution runs inside customer GitHub Actions.",
    body: "ReviewRouter manages metadata, workflow setup, model settings, health, and audit. Repository checkout, diff analysis, prompts, and model responses stay out of ReviewRouter cloud by default.",
    icon: Code2,
    tone: "cyan",
  },
  {
    label: "Provider secrets",
    title: "OAuth tokens and API keys stay in your boundary.",
    body: "Codex rotating OAuth, Claude Code OAuth, and OpenRouter keys are stored directly in GitHub Actions secrets. ReviewRouter cloud never receives plaintext provider credentials.",
    icon: KeyRound,
    tone: "lime",
  },
  {
    label: "Fork safety",
    title: "Secret-backed review is skipped for fork PRs by default.",
    body: "The generated workflow avoids automatically exposing secrets to untrusted fork code. Trusted rerun flows should be explicit maintainer actions.",
    icon: AlertTriangle,
    tone: "magenta",
  },
  {
    label: "Runtime config",
    title: "OIDC avoids long-lived ReviewRouter API tokens in repos.",
    body: "GitHub Actions requests short-lived runtime config through OIDC. Production Codex OAuth rotating runs fail closed if the control plane cannot validate the run.",
    icon: RadioTower,
    tone: "cyan",
  },
] as const;

const boundaryRows = [
  {
    layer: "ReviewRunner",
    icon: Workflow,
    ownedBy: "Customer repository runtime",
    sensitiveData:
      "Repository checkout, PR diff, prompts, model output, provider calls",
    custody: "Customer",
  },
  {
    layer: "Provider credentials",
    icon: KeyRound,
    ownedBy: "GitHub Actions secrets or trusted runner",
    sensitiveData:
      "Codex rotating auth.json, Claude Code OAuth token, OpenRouter key",
    custody: "Customer",
  },
  {
    layer: "ReviewRouter SaaS",
    icon: Cloud,
    ownedBy: "ReviewRouter control plane",
    sensitiveData:
      "Installation metadata, setup PR state, policy config, audit events, health summaries",
    custody: "ReviewRouter",
  },
] as const;

const permissionRows: readonly {
  readonly permission: string;
  readonly className: string;
  readonly reason: string;
  readonly docs?: readonly {
    readonly label: string;
    readonly href: string;
  }[];
}[] = [
  {
    permission: "metadata: read",
    className: "Read",
    reason: "Discover repository identity and default branch.",
  },
  {
    permission: "actions: write",
    className: "Write",
    reason:
      "Dispatch exact-revision review runs and read their metadata for durable request tracking.",
  },
  {
    permission: "checks: write",
    className: "Write",
    reason:
      "Publish ReviewRouter-owned check runs when direct GitHub check integration is enabled.",
  },
  {
    permission: "contents: write",
    className: "Write",
    reason: "Create workflow setup branches and commits.",
  },
  {
    permission: "workflows: write",
    className: "Write",
    reason: "Open PRs that add or update the ReviewRouter workflow.",
  },
  {
    permission: "pull_requests: write",
    className: "Write",
    reason: "Create setup PRs and read setup PR state.",
  },
  {
    permission: "secrets: write",
    className: "Write",
    reason:
      "Verify required GitHub Actions secret metadata and write encrypted rotating Codex OAuth payloads after OIDC/writeback checks. GitHub does not expose decrypted secret values.",
    docs: [
      {
        label: "Repository secret docs",
        href: githubSecretPermissionDocs.repositorySecret,
      },
    ],
  },
  {
    permission: "organization_secrets: read",
    className: "Metadata",
    reason:
      "Verify org-level selected-repository secret metadata for organization-owned repos. ReviewRouter checks whether the current repository is allowed to use the secret.",
    docs: [
      {
        label: "Organization secret docs",
        href: githubSecretPermissionDocs.organizationSecret,
      },
      {
        label: "Selected repository docs",
        href: githubSecretPermissionDocs.organizationSecretRepositories,
      },
    ],
  },
  {
    permission: "organization_plan: read",
    className: "Read",
    reason:
      "Detect whether organization-level Actions secrets can be used for private repositories, so setup can recommend repository secrets when needed.",
  },
  {
    permission: "statuses: write",
    className: "Write",
    reason:
      "Publish ReviewRouter-owned commit statuses when direct GitHub status integration is enabled.",
  },
  {
    permission: "issues: write",
    className: "Write",
    reason:
      "Support setup/help comments and issue-style PR conversations. Review execution still runs from customer runtime.",
  },
] as const;

const webhookRows = [
  [
    "installation",
    "Create, suspend, unsuspend, and uninstall lifecycle events for workspace and installation state.",
  ],
  [
    "installation_repositories",
    "Repository added/removed events so selected-repository installs stay in sync without manual refresh.",
  ],
  [
    "pull_request",
    "Detect when setup PRs are merged and advance repository setup state automatically.",
  ],
  [
    "repository",
    "Refresh repository metadata such as rename, archived state, visibility, and default branch.",
  ],
  [
    "workflow_job",
    "Track job-level Actions state for runner and review diagnostics.",
  ],
  [
    "workflow_run",
    "Track workflow completion metadata for live health/status updates.",
  ],
  [
    "check_run",
    "Receive ReviewRouter-owned check run lifecycle events and rerun requests.",
  ],
  [
    "issue_comment",
    "Support future slash-command workflows such as rerun or enable review.",
  ],
  [
    "status",
    "Track commit status updates when direct status integration is enabled.",
  ],
] as const;

export default function SecurityPage(): React.ReactElement {
  return (
    <main className="home-shell min-h-screen w-full overflow-hidden py-8 md:py-10">
      <section className="mx-auto w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)]">
        <div className="relative isolate overflow-hidden rounded-[2rem] border border-cyan-200/12 bg-[var(--rr-surface-card-strong)] p-4 shadow-[0_28px_120px_-70px_rgba(0,240,255,0.95)] sm:p-6 lg:p-7">
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10 bg-[linear-gradient(rgba(103,232,249,0.055)_1px,transparent_1px),linear-gradient(90deg,rgba(103,232,249,0.035)_1px,transparent_1px),radial-gradient(circle_at_70%_7%,rgba(163,230,53,0.13),transparent_24rem),radial-gradient(circle_at_18%_34%,rgba(0,240,255,0.12),transparent_23rem),linear-gradient(180deg,rgba(2,6,12,0.1),rgba(0,0,0,0.28))] bg-[size:56px_56px,56px_56px,auto,auto,auto]"
          />
          <div
            aria-hidden="true"
            className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-cyan-200/70 to-transparent"
          />

          <div className="grid gap-6 lg:grid-cols-[minmax(0,0.82fr)_minmax(430px,1.18fr)] lg:items-stretch">
            <div className="flex min-w-0 flex-col justify-center py-2 lg:py-4">
              <Badge tone="accent">Security model</Badge>
              <h1 className="mt-6 max-w-3xl text-4xl font-semibold tracking-tight text-cyan-50 sm:text-5xl lg:text-6xl">
                Code and secrets stay under your control.
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-slate-300 sm:text-lg sm:leading-8 lg:max-w-xl">
                ReviewRouter installs, configures, and monitors AI review
                without becoming the default path for source code, PR diffs,
                prompts, model responses, or provider credentials.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <LinkButton href="/#compare" variant="soft" tone="success">
                  <Network aria-hidden="true" className="size-5" />
                  Compare boundary
                </LinkButton>
                <LinkButton href="/getting-started" variant="outline">
                  <BookOpen aria-hidden="true" className="size-5" />
                  Setup guide
                </LinkButton>
              </div>
            </div>

            <CredentialPanel />
          </div>

          <section
            aria-labelledby="security-signal-title"
            className="mt-7 grid gap-4 md:grid-cols-2 xl:grid-cols-4"
          >
            <h2 id="security-signal-title" className="sr-only">
              Security boundary signals
            </h2>
            {securitySignals.map((signal) => (
              <SignalCard key={signal.title} {...signal} />
            ))}
          </section>

          <section className="mt-8" aria-labelledby="security-boundary-title">
            <SectionHeading
              icon={LockKeyhole}
              title="Privacy boundary"
              subtitle="The SaaS configures review. Your runtime performs review."
              id="security-boundary-title"
            />
            <BoundaryTable />
          </section>

          <section className="mt-8" aria-labelledby="security-permission-title">
            <SectionHeading
              icon={ShieldCheck}
              title="GitHub App permissions"
              subtitle="Permissions support setup and maintenance, not hosted code execution."
              id="security-permission-title"
              meta="Least-privilege map"
            />
            <PermissionTable />
            <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-slate-500">
              <Database
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-cyan-300"
              />
              GitHub repository and organization secret endpoints return
              metadata only. ReviewRouter uses those checks for setup
              verification, not decrypted secret access.
            </p>
          </section>

          <section className="mt-8" aria-labelledby="security-webhook-title">
            <SectionHeading
              icon={Webhook}
              title="GitHub App webhooks"
              subtitle="Hosted beta needs lifecycle events to keep installations current."
              id="security-webhook-title"
            />
            <WebhookTable />
          </section>

          <div className="rr-accent-callout mt-7 grid gap-5 rounded-2xl border border-fuchsia-400/30 bg-[linear-gradient(90deg,rgba(217,70,239,0.08),rgba(0,240,255,0.055),rgba(163,230,53,0.05))] p-5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
            <div className="grid h-14 w-14 place-items-center rounded-2xl border border-lime-300/30 bg-lime-300/[0.08] text-lime-200">
              <ShieldCheck aria-hidden="true" className="size-6" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-cyan-50">
                Strong claim, narrow boundary.
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-300">
                ReviewRouter should not claim code goes nowhere. It should claim
                code skips ReviewRouter cloud by default.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 sm:justify-end">
              <LinkButton href="/dashboard" variant="soft" tone="success">
                Open dashboard
              </LinkButton>
              <LinkButton href="/" variant="outline">
                Back to overview
              </LinkButton>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function CredentialPanel(): React.ReactElement {
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
      <Badge tone="success">Credential boundary</Badge>
      <h2 className="mt-5 text-2xl font-semibold leading-tight text-cyan-50 sm:text-3xl">
        Seed secrets directly to GitHub.{" "}
        <span className="text-lime-300">ReviewRouter never receives them.</span>
      </h2>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-300">
        The helper validates provider auth locally and writes required secrets
        through <code>gh</code>. Dashboard state only tracks safe setup
        metadata.
      </p>

      <div className="mt-7 grid gap-4 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center">
        <BoundaryNode
          title="ReviewRouter control plane"
          body="Policy, setup, audit"
          icon={<LogoMark size="sm" className="h-12 w-12 rounded-xl" />}
        />
        <BoundaryConnector />
        <BoundaryNode
          title="GitHub Actions secrets"
          body="Customer-owned custody"
          icon={
            <KeyRound aria-hidden="true" className="size-7 text-lime-200" />
          }
        />
        <BoundaryConnector />
        <BoundaryNode
          title="Selected model provider"
          body="Called from your runtime"
          icon={
            <Cloud aria-hidden="true" className="size-7 text-fuchsia-300" />
          }
        />
      </div>

      <div className="mt-7 rounded-2xl border border-cyan-200/12 bg-[var(--rr-surface-panel)] p-3">
        <div className="mb-3 flex items-center gap-2 font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-cyan-100">
          <Terminal aria-hidden="true" className="size-4" />
          Secret seed command
        </div>
        <CodeBlock code={secretCommand} />
      </div>
    </div>
  );
}

function SignalCard({
  label,
  title,
  body,
  icon: Icon,
  tone,
}: (typeof securitySignals)[number]): React.ReactElement {
  return (
    <article className="relative min-h-full overflow-hidden rounded-2xl border border-cyan-200/10 bg-[var(--rr-surface-panel)] p-5 shadow-[inset_0_1px_0_rgba(103,232,249,0.08)]">
      <div
        aria-hidden="true"
        className={cx(
          "absolute inset-x-0 top-0 h-px",
          tone === "lime"
            ? "bg-lime-300/45"
            : tone === "magenta"
              ? "bg-fuchsia-300/45"
              : "bg-cyan-300/45",
        )}
      />
      <div className="mb-4 flex items-center gap-3">
        <span
          className={cx(
            "grid h-11 w-11 shrink-0 place-items-center rounded-xl border bg-cyan-300/[0.08]",
            tone === "lime"
              ? "border-lime-300/30 text-lime-200"
              : tone === "magenta"
                ? "border-fuchsia-300/30 text-fuchsia-200"
                : "border-cyan-300/30 text-cyan-200",
          )}
        >
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <Badge tone="neutral">{label}</Badge>
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

function BoundaryTable(): React.ReactElement {
  return (
    <div className="overflow-x-auto rounded-2xl border border-cyan-200/12 bg-[var(--rr-surface-panel)] shadow-[inset_0_1px_0_rgba(103,232,249,0.09)]">
      <table className="w-full min-w-[860px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-cyan-200/10 font-mono text-[0.68rem] uppercase tracking-[0.18em] text-slate-400">
            <th className="px-5 py-4 font-semibold">Layer</th>
            <th className="px-5 py-4 font-semibold">Owned by</th>
            <th className="px-5 py-4 font-semibold">Data handled</th>
            <th className="px-5 py-4 font-semibold">Custody</th>
          </tr>
        </thead>
        <tbody className="text-slate-300">
          {boundaryRows.map((row) => {
            const Icon = row.icon;
            const customerCustody = row.custody === "Customer";

            return (
              <tr
                key={row.layer}
                className="border-b border-cyan-200/10 last:border-b-0"
              >
                <td className="px-5 py-4">
                  <div className="flex items-center gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-200">
                      <Icon aria-hidden="true" className="size-5" />
                    </span>
                    <span className="font-semibold text-cyan-50">
                      {row.layer}
                    </span>
                  </div>
                </td>
                <td className="px-5 py-4">{row.ownedBy}</td>
                <td className="max-w-[32rem] px-5 py-4 leading-6">
                  {row.sensitiveData}
                </td>
                <td className="px-5 py-4">
                  <span
                    className={cx(
                      "font-semibold",
                      customerCustody ? "text-lime-300" : "text-cyan-200",
                    )}
                  >
                    {row.custody}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PermissionTable(): React.ReactElement {
  return (
    <div className="overflow-x-auto rounded-2xl border border-cyan-200/12 bg-[var(--rr-surface-panel)] shadow-[inset_0_1px_0_rgba(103,232,249,0.09)]">
      <table className="w-full min-w-[920px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-cyan-200/10 font-mono text-[0.68rem] uppercase tracking-[0.18em] text-slate-400">
            <th className="px-5 py-4 font-semibold">Permission</th>
            <th className="px-5 py-4 font-semibold">Class</th>
            <th className="px-5 py-4 font-semibold">Why it exists</th>
          </tr>
        </thead>
        <tbody className="text-slate-300">
          {permissionRows.map((row) => (
            <tr
              key={row.permission}
              className="border-b border-cyan-200/10 last:border-b-0"
            >
              <td className="px-5 py-4 font-mono text-cyan-50">
                {row.permission}
              </td>
              <td className="px-5 py-4">
                <TablePill tone={row.className}>{row.className}</TablePill>
              </td>
              <td className="px-5 py-4 leading-6">
                <p>{row.reason}</p>
                {row.docs?.length ? (
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {row.docs.map((doc) => (
                      <a
                        key={doc.href}
                        href={doc.href}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-h-11 items-center gap-1.5 text-cyan-200 underline decoration-cyan-300/40 underline-offset-4 hover:text-cyan-50"
                      >
                        {doc.label}
                        <ExternalLink aria-hidden="true" className="size-3.5" />
                      </a>
                    ))}
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WebhookTable(): React.ReactElement {
  return (
    <div className="overflow-x-auto rounded-2xl border border-cyan-200/12 bg-[var(--rr-surface-panel)] shadow-[inset_0_1px_0_rgba(103,232,249,0.09)]">
      <table className="w-full min-w-[760px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-cyan-200/10 font-mono text-[0.68rem] uppercase tracking-[0.18em] text-slate-400">
            <th className="px-5 py-4 font-semibold">Event</th>
            <th className="px-5 py-4 font-semibold">Why it exists</th>
          </tr>
        </thead>
        <tbody className="text-slate-300">
          {webhookRows.map(([eventName, reason]) => (
            <tr
              key={eventName}
              className="border-b border-cyan-200/10 last:border-b-0"
            >
              <td className="px-5 py-4 font-mono text-cyan-50">{eventName}</td>
              <td className="px-5 py-4 leading-6">{reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BoundaryNode({
  title,
  body,
  icon,
}: {
  readonly title: string;
  readonly body: string;
  readonly icon: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="min-w-0 text-center">
      <div className="mx-auto grid h-20 w-20 place-items-center rounded-[1.4rem] border border-cyan-300/30 bg-cyan-300/[0.06] shadow-[inset_0_0_28px_rgba(0,240,255,0.08),0_0_32px_-20px_rgba(0,240,255,0.95)]">
        {icon}
      </div>
      <h3 className="mt-3 text-sm font-semibold leading-5 text-cyan-50">
        {title}
      </h3>
      <p className="mt-1 text-xs leading-5 text-slate-500">{body}</p>
    </div>
  );
}

function BoundaryConnector(): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      className="hidden h-px w-14 bg-gradient-to-r from-cyan-300 via-lime-300 to-cyan-300 shadow-[0_0_18px_rgba(163,230,53,0.5)] md:block"
    />
  );
}

function TablePill({
  tone,
  children,
}: {
  readonly tone: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <span
      className={cx(
        "inline-flex rounded-full border px-3 py-1 font-mono text-[0.66rem] font-semibold uppercase tracking-[0.08em]",
        tone === "Write"
          ? "border-fuchsia-300/30 bg-fuchsia-300/[0.07] text-fuchsia-200"
          : tone === "Metadata"
            ? "border-lime-300/35 bg-lime-300/[0.09] text-lime-200"
            : "border-cyan-300/30 bg-cyan-300/[0.07] text-cyan-200",
      )}
    >
      {children}
    </span>
  );
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
