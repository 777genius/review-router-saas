import type { Metadata } from "next";
import { Badge, Card, CodeBlock, LinkButton } from "@reviewrouter/ui";
import { resolveCodexSeedScriptUrl } from "@/server/codex-seed-script-url";
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
    label: "Code custody",
    title: "Review execution stays in customer CI.",
    body: "ReviewRouter v1 manages metadata, workflow setup, model settings, health, and audit. It does not store repository code, pull request diffs, prompts, or model responses by default.",
  },
  {
    label: "Provider secrets",
    title: "Codex OAuth and API keys stay out of the SaaS.",
    body: "Provider credentials are stored directly in GitHub Actions secrets or on a trusted self-hosted runner. The dashboard only shows setup guidance and provider health metadata.",
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

const permissionRows = [
  ["metadata: read", "Discover repository identity and default branch."],
  [
    "actions: read",
    "Read workflow run metadata for live setup and health state.",
  ],
  [
    "checks: write",
    "Publish ReviewRouter-owned check runs when direct GitHub check integration is enabled.",
  ],
  ["contents: write", "Create workflow setup branches and commits."],
  [
    "workflows: write",
    "Open PRs that add or update the ReviewRouter workflow.",
  ],
  ["pull_requests: write", "Create setup PRs and read setup PR state."],
  [
    "secrets: read",
    "Verify required GitHub Actions secret names exist after provider setup. Secret values are never readable.",
  ],
  [
    "organization_secrets: read",
    "Verify selected-repository organization secret metadata exists for organization-owned repositories. Secret values are never readable.",
  ],
  [
    "statuses: write",
    "Publish ReviewRouter-owned commit statuses when direct GitHub status integration is enabled.",
  ],
  [
    "issues: write",
    "Support setup/help comments and issue-style PR conversations when the SaaS needs to guide maintainers. Review execution still runs from CI.",
  ],
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
            Designed to avoid code and secret custody.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            ReviewRouter is a control plane. It helps install, configure, and
            monitor AI review, while review workloads execute inside GitHub
            Actions under the repository owner&apos;s control.
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
            selected-repo Actions secrets through <code>gh</code>. It does not
            send auth JSON to ReviewRouter SaaS.
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
              {permissionRows.map(([permission, reason]) => (
                <tr key={permission}>
                  <td className="border-b border-cyan-200/10 px-3 py-3 font-mono text-cyan-50">
                    {permission}
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
