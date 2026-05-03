import { Badge, Card, CodeBlock, LinkButton } from "@reviewrouter/ui";

const uninstallPath =
  "GitHub -> Settings -> Applications -> Installed GitHub Apps -> ReviewRouter -> Configure -> Uninstall";
const removeSecrets = `gh secret delete CODEX_AUTH_JSON --repo owner/repo
# optional, only if it was intentionally stored
gh secret delete CODEX_CONFIG_TOML --repo owner/repo`;
const orgRemoveSecrets = `gh secret delete CODEX_AUTH_JSON --org acme --app actions
# verify selected repositories before deleting shared org secrets`;

const disconnectSteps = [
  {
    title: "Uninstall the GitHub App",
    body: "This stops future ReviewRouter App access to selected repositories. Existing workflow files and GitHub Actions secrets are not automatically deleted by GitHub App uninstall.",
  },
  {
    title: "Remove or update workflow files",
    body: "Delete `.github/workflows/reviewrouter.yml` through a normal pull request, or leave it disabled until the team decides whether to reconnect.",
  },
  {
    title: "Rotate or delete provider secrets",
    body: "Repository and organization Actions secrets live in GitHub, not in ReviewRouter SaaS. Remove them in GitHub if the reviewer should no longer use them.",
  },
  {
    title: "Request workspace metadata deletion",
    body: "For trusted beta, request deletion through the support path. Production should replace this with an owner self-service deletion flow and a published retention window.",
  },
] as const;

export default function DisconnectPage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <div className="space-y-5">
          <Badge tone="accent">Disconnect</Badge>
          <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-cyan-50 md:text-7xl">
            Leave cleanly without guessing where secrets live.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            Disconnecting ReviewRouter has two parts: revoke the GitHub App and
            clean up assets that belong to the customer repository, such as
            workflow files and Actions secrets.
          </p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href="/support">Support</LinkButton>
            <LinkButton href="/privacy" variant="soft" tone="success">
              Privacy draft
            </LinkButton>
            <LinkButton href="/security" variant="outline">
              Security model
            </LinkButton>
          </div>
        </div>

        <Card className="space-y-4">
          <Badge tone="warning">Uninstall path</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            GitHub owns App uninstallation.
          </h2>
          <p className="text-sm leading-6 text-slate-300">
            Use this path for local beta until the dashboard exposes a direct
            GitHub uninstall link for each installation.
          </p>
          <CodeBlock code={uninstallPath} />
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {disconnectSteps.map((step) => (
          <Card key={step.title} className="space-y-3">
            <Badge tone="neutral">Disconnect step</Badge>
            <h2 className="text-xl font-semibold text-cyan-50">{step.title}</h2>
            <p className="text-sm leading-6 text-slate-300">{step.body}</p>
          </Card>
        ))}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card className="space-y-4">
          <Badge tone="danger">Repository secrets</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Remove repo-scoped Codex OAuth secrets
          </h2>
          <CodeBlock code={removeSecrets} />
        </Card>
        <Card className="space-y-4">
          <Badge tone="danger">Organization secrets</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Remove org selected-repo secrets carefully
          </h2>
          <CodeBlock code={orgRemoveSecrets} />
        </Card>
      </section>
    </main>
  );
}
