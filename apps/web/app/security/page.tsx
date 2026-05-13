import type { Metadata } from "next";
import { Badge, Card, CodeBlock, LinkButton } from "@reviewrouter/ui";
import { resolveCodexSeedScriptUrl } from "@/server/codex-seed-script-url";
import { githubSecretPermissionDocs } from "../github-app-permission-doc-links";
import { createPublicPageMetadata } from "../seo";

export const metadata: Metadata = createPublicPageMetadata({
  title: "Security model for AI code review",
  description:
    "ReviewRouter security model for privacy-first AI code review: GitHub App setup, GitHub Actions execution, OIDC runtime config, and secret boundaries.",
  path: "/security",
});

const secretCommand = `curl -fsSL ${resolveCodexSeedScriptUrl()} | REVIEW_ROUTER_CONFIRM_WRITE=1 REVIEW_ROUTER_REPO=owner/repo bash`;

const securitySections = [
  {
    label: "Code storage",
    title: "Review execution runs inside customer GitHub Actions.",
    body: "ReviewRouter manages metadata, workflow setup, model settings, health, and audit. Repository checkout, diff analysis, prompts, and model responses stay out of ReviewRouter cloud by default.",
  },
  {
    label: "Provider secrets",
    title: "Provider OAuth tokens and API keys stay in your boundary.",
    body: "Codex OAuth, Claude Code OAuth, OpenAI API keys, and OpenRouter keys are stored directly in GitHub Actions secrets or on a trusted self-hosted runner. The dashboard only shows setup guidance and safe provider health metadata.",
  },
  {
    label: "Fork safety",
    title: "Secret-backed review is skipped for fork PRs by default.",
    body: "The generated workflow avoids automatically exposing secrets to untrusted fork code. Trusted rerun flows should be explicit maintainer actions, not implicit defaults.",
  },
  {
    label: "Action config",
    title: "OIDC avoids long-lived ReviewRouter API tokens in repos.",
    body: "GitHub Actions can request short-lived runtime config through OIDC. Static fallback exists for local beta, but production should prefer OIDC.",
  },
] as const;

const boundaryRows = [
  {
    layer: "ReviewRunner",
    ownedBy: "Customer repository CI",
    sensitiveData:
      "Repository checkout, PR diff, prompts, model output, provider calls",
  },
  {
    layer: "Provider credentials",
    ownedBy: "GitHub Actions secrets or trusted runner",
    sensitiveData:
      "Codex auth.json, Claude Code OAuth token, OpenAI key, OpenRouter key",
  },
  {
    layer: "ReviewRouter SaaS",
    ownedBy: "ReviewRouter control plane",
    sensitiveData:
      "Installation metadata, setup PR state, policy config, audit events, health summaries",
  },
] as const;

const permissionRows: readonly {
  readonly permission: string;
  readonly reason: string;
  readonly docs?: readonly {
    readonly label: string;
    readonly href: string;
  }[];
}[] = [
  {
    permission: "metadata: read",
    reason: "Discover repository identity and default branch.",
  },
  {
    permission: "actions: read",
    reason: "Read workflow run metadata for live setup and health state.",
  },
  {
    permission: "checks: write",
    reason:
      "Publish ReviewRouter-owned check runs when direct GitHub check integration is enabled.",
  },
  {
    permission: "contents: write",
    reason: "Create workflow setup branches and commits.",
  },
  {
    permission: "workflows: write",
    reason: "Open PRs that add or update the ReviewRouter workflow.",
  },
  {
    permission: "pull_requests: write",
    reason: "Create setup PRs and read setup PR state.",
  },
  {
    permission: "secrets: read",
    reason:
      "Verify required GitHub Actions secret metadata after provider setup: name, timestamps, visibility, and selected repository access. GitHub does not expose decrypted secret values through this API.",
    docs: [
      {
        label: "GitHub Docs: Get a repository secret",
        href: githubSecretPermissionDocs.repositorySecret,
      },
    ],
  },
  {
    permission: "organization_secrets: read",
    reason:
      "Verify org-level selected-repository secret metadata for organization-owned repos. ReviewRouter checks whether the current repository is allowed to use the secret; GitHub does not expose decrypted values.",
    docs: [
      {
        label: "GitHub Docs: Get an organization secret",
        href: githubSecretPermissionDocs.organizationSecret,
      },
      {
        label: "GitHub Docs: List selected repositories",
        href: githubSecretPermissionDocs.organizationSecretRepositories,
      },
    ],
  },
  {
    permission: "organization_plan: read",
    reason:
      "Detect whether organization-level Actions secrets can be used for private repositories, so the setup UI can recommend repository secrets when the GitHub plan does not support org secrets for private repos.",
  },
  {
    permission: "statuses: write",
    reason:
      "Publish ReviewRouter-owned commit statuses when direct GitHub status integration is enabled.",
  },
  {
    permission: "issues: write",
    reason:
      "Support setup/help comments and issue-style PR conversations when the SaaS needs to guide maintainers. Review execution still runs from CI.",
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
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <div className="space-y-5">
          <Badge tone="accent">Security model</Badge>
          <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-cyan-50 md:text-7xl">
            Code and secrets stay under your control.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            ReviewRouter is a control plane for complex private codebases. It
            helps install, configure, and monitor AI review, while source code,
            PR diffs, prompts, model responses, and provider credentials stay
            out of ReviewRouter cloud by default.
          </p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href="/" variant="outline">
              Back to overview
            </LinkButton>
            <LinkButton href="/dashboard">Open dashboard</LinkButton>
          </div>
        </div>

        <Card className="space-y-4">
          <Badge tone="success">Credential boundary</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Seed secrets directly to GitHub.
          </h2>
          <p className="text-sm leading-6 text-slate-300">
            The local helper validates Codex ChatGPT subscription auth and
            writes <code>CODEX_AUTH_JSON</code> to repository or organization
            selected-repo Actions secrets through <code>gh</code>. Claude Code
            subscription OAuth uses <code>CLAUDE_CODE_OAUTH_TOKEN</code> from{" "}
            <code>claude setup-token</code>. Neither token is sent to
            ReviewRouter SaaS.
          </p>
          <CodeBlock code={secretCommand} />
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {securitySections.map((section) => (
          <Card key={section.title} className="space-y-3">
            <Badge tone="neutral">{section.label}</Badge>
            <h2 className="text-xl font-semibold text-cyan-50">
              {section.title}
            </h2>
            <p className="text-sm leading-6 text-slate-300">{section.body}</p>
          </Card>
        ))}
      </section>

      <Card className="space-y-4 border-lime-300/20">
        <Badge tone="success">Privacy boundary</Badge>
        <h2 className="text-2xl font-semibold text-cyan-50">
          The SaaS configures review. Your CI performs review.
        </h2>
        <p className="text-sm leading-6 text-slate-300">
          ReviewRouter cloud should not sit in the source-code path by default.
          When an AI model is used, the review action calls the provider you
          selected from your GitHub Actions job using credentials you control.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] border-collapse text-left text-sm">
            <thead className="text-cyan-100">
              <tr>
                <th className="border-b border-cyan-200/15 px-3 py-2">Layer</th>
                <th className="border-b border-cyan-200/15 px-3 py-2">
                  Owned by
                </th>
                <th className="border-b border-cyan-200/15 px-3 py-2">
                  Data handled
                </th>
              </tr>
            </thead>
            <tbody className="text-slate-300">
              {boundaryRows.map((row) => (
                <tr key={row.layer}>
                  <td className="border-b border-cyan-200/10 px-3 py-3 font-mono text-cyan-50">
                    {row.layer}
                  </td>
                  <td className="border-b border-cyan-200/10 px-3 py-3">
                    {row.ownedBy}
                  </td>
                  <td className="border-b border-cyan-200/10 px-3 py-3">
                    {row.sensitiveData}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="space-y-4">
        <Badge tone="warning">GitHub App permissions</Badge>
        <h2 className="text-2xl font-semibold text-cyan-50">
          Permissions are for setup and maintenance, not code execution.
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead className="text-cyan-100">
              <tr>
                <th className="border-b border-cyan-200/15 px-3 py-2">
                  Permission
                </th>
                <th className="border-b border-cyan-200/15 px-3 py-2">
                  Why it exists
                </th>
              </tr>
            </thead>
            <tbody className="text-slate-300">
              {permissionRows.map((row) => (
                <tr key={row.permission}>
                  <td className="border-b border-cyan-200/10 px-3 py-3 font-mono text-cyan-50">
                    {row.permission}
                  </td>
                  <td className="border-b border-cyan-200/10 px-3 py-3">
                    <p>{row.reason}</p>
                    {row.docs?.length ? (
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                        {row.docs.map((doc) => (
                          <a
                            key={doc.href}
                            href={doc.href}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-h-11 items-center text-cyan-200 underline decoration-cyan-300/40 underline-offset-4 hover:text-cyan-50"
                          >
                            {doc.label}
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
        <p className="text-sm leading-6 text-slate-400">
          GitHub&apos;s repository and organization secret endpoints return
          metadata without revealing encrypted values. ReviewRouter uses those
          metadata checks only for setup verification.
        </p>
      </Card>

      <Card className="space-y-4">
        <Badge tone="warning">GitHub App webhooks</Badge>
        <h2 className="text-2xl font-semibold text-cyan-50">
          Hosted beta requires lifecycle event subscriptions.
        </h2>
        <p className="text-sm leading-6 text-slate-300">
          Local setup PR E2E can pass without webhooks, but hosted SaaS needs
          these events to keep installations and selected repositories current.
          The public-beta doctor fails until they are enabled.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead className="text-cyan-100">
              <tr>
                <th className="border-b border-cyan-200/15 px-3 py-2">Event</th>
                <th className="border-b border-cyan-200/15 px-3 py-2">
                  Why it exists
                </th>
              </tr>
            </thead>
            <tbody className="text-slate-300">
              {webhookRows.map(([eventName, reason]) => (
                <tr key={eventName}>
                  <td className="border-b border-cyan-200/10 px-3 py-3 font-mono text-cyan-50">
                    {eventName}
                  </td>
                  <td className="border-b border-cyan-200/10 px-3 py-3">
                    {reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </main>
  );
}
