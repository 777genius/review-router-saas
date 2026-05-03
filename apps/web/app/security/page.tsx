import { Badge, Card, CodeBlock, LinkButton } from "@reviewrouter/ui";

const secretCommand = "bash scripts/seed-codex-auth.sh";

const securitySections = [
  {
    label: "Code custody",
    title: "Review execution stays in customer CI.",
    body: "ReviewRouter v1 manages metadata, workflow setup, policy, health, and audit. It does not store repository code, pull request diffs, prompts, or model responses by default.",
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
  ["contents: write", "Create workflow setup branches and commits."],
  [
    "workflows: write",
    "Open PRs that add or update the ReviewRouter workflow.",
  ],
  [
    "pull_requests: write",
    "Create setup PRs and future setup/update comments.",
  ],
  [
    "issues: write",
    "Support issue-style comments where GitHub models PR comments as issues.",
  ],
  [
    "actions: write",
    "Support action health and future workflow maintenance flows.",
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
            writes `CODEX_AUTH_JSON` to repository or organization selected-repo
            Actions secrets through `gh`. It does not send auth JSON to
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
    </main>
  );
}
