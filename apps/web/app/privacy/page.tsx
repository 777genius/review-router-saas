import type { Metadata } from "next";
import { Badge, Card, LinkButton } from "@reviewrouter/ui";
import {
  reviewRouterContactEmail,
  reviewRouterContactMailto,
} from "../public-urls";
import { createPublicPageMetadata } from "../seo";

export const metadata: Metadata = createPublicPageMetadata({
  title: "Privacy-first AI code review",
  description:
    "Privacy model for ReviewRouter: AI pull request review runs in customer CI while code, PR diffs, prompts, and provider secrets stay out of the SaaS by default.",
  path: "/privacy",
});

const collectedMetadata = [
  "GitHub account login, avatar URL, and GitHub user id after sign-in",
  "workspace, installation, repository, and selected-repository metadata",
  "workflow setup PR URLs, action refs, config versions, and safe health summaries",
  "audit events for setup, config, support diagnostics, and operational actions",
  "user-confirmed Balanced Memory snippets and safe memory metadata when Memory is enabled",
] as const;

const notCollectedByDefault = [
  "repository source code",
  "pull request diffs, prompts, or model responses",
  "Codex auth.json, Claude Code OAuth tokens, OpenAI API keys, or OpenRouter keys",
  "raw GitHub webhook payload bodies after normalization",
  "raw memory source comments, embeddings, or deleted memory bodies in exports",
] as const;

const memoryPrivacyControls = [
  {
    title: "Confirmation required",
    body: "Repository and workspace memory is saved only after an authorized maintainer, repository admin, or workspace admin confirms it.",
  },
  {
    title: "Distilled text only",
    body: "Memory stores short confirmed guidance, preferences, or project facts. Raw code, diffs, prompt text, model output, and secrets are rejected before storage.",
  },
  {
    title: "Scoped retrieval",
    body: "Repository memory is scoped to that repository. Workspace memory stays inside the workspace. User preference memory is limited to safe response preferences.",
  },
  {
    title: "Admin export",
    body: "Workspace memory export is admin-only, audited, size bounded, and excludes deleted rows, embeddings, raw source excerpts, and source hashes.",
  },
] as const;

const memoryLifecycleRows = [
  ["Pending suggestions", "expire if not confirmed", "not used at runtime"],
  [
    "Active memory",
    "kept until disabled, deleted, or TTL-expired",
    "retrievable when scope policy allows",
  ],
  ["Disabled memory", "kept for admin inspection", "not used at runtime"],
  [
    "Deleted memory",
    "redacted immediately, then pruned after retention",
    "not used at runtime",
  ],
] as const;

const privacyBoundary = [
  {
    title: "Code path",
    body: "The repository checkout and review prompt are created inside the customer's GitHub Actions job, not inside ReviewRouter cloud.",
  },
  {
    title: "Model path",
    body: "When AI review runs, the action calls the provider selected by the customer using credentials controlled by the customer.",
  },
  {
    title: "Control path",
    body: "ReviewRouter cloud keeps setup metadata, policy, audit, and health state so teams can operate reviews across many repositories.",
  },
] as const;

export default function PrivacyPage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <div className="space-y-5">
          <Badge tone="accent">Privacy</Badge>
          <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-cyan-50 md:text-7xl">
            Your code stays in your CI.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            ReviewRouter is designed for complex private codebases where code
            review needs central policy without centralizing source code. The
            SaaS keeps setup, model settings, health, and audit state while
            repository code, provider credentials, and review execution stay in
            customer GitHub Actions by default.
          </p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href="/security" variant="soft" tone="success">
              Security model
            </LinkButton>
            <LinkButton href="/terms" variant="outline">
              Terms
            </LinkButton>
            <LinkButton href="/support" variant="ghost">
              Support
            </LinkButton>
          </div>
        </div>

        <Card className="space-y-4">
          <Badge tone="success">Core claim</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Review execution stays in customer CI by default.
          </h2>
          <p className="text-sm leading-6 text-slate-300">
            ReviewRouter SaaS stores metadata needed for setup, config, health,
            audit, and support diagnostics. Source code, PR diffs, prompts,
            model responses, provider credentials, and review workloads stay out
            of ReviewRouter cloud by default.
          </p>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {privacyBoundary.map((item) => (
          <Card key={item.title} className="space-y-3 border-lime-300/20">
            <Badge tone="success">{item.title}</Badge>
            <p className="text-sm leading-6 text-slate-300">{item.body}</p>
          </Card>
        ))}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card className="space-y-4">
          <Badge tone="neutral">Stored metadata</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            What the SaaS may store
          </h2>
          <ul className="grid gap-3 text-sm leading-6 text-slate-300">
            {collectedMetadata.map((item) => (
              <li
                key={item}
                className="rounded-xl border border-cyan-200/10 bg-cyan-300/5 p-3"
              >
                {item}
              </li>
            ))}
          </ul>
        </Card>

        <Card className="space-y-4 border-lime-300/20">
          <Badge tone="success">Not stored by default</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            What should not enter the SaaS
          </h2>
          <ul className="grid gap-3 text-sm leading-6 text-slate-300">
            {notCollectedByDefault.map((item) => (
              <li
                key={item}
                className="rounded-xl border border-lime-300/10 bg-lime-300/5 p-3"
              >
                {item}
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <Card className="space-y-3">
          <Badge tone="warning">Retention</Badge>
          <p className="text-sm leading-6 text-slate-300">
            Beta metadata is retained for setup, audit, support, and health
            operations. Balanced Memory usage telemetry is pruned on a bounded
            retention schedule, and deleted memory is removed from runtime
            retrieval immediately before later hard-delete maintenance.
          </p>
        </Card>
        <Card className="space-y-3">
          <Badge tone="warning">Deletion</Badge>
          <p className="text-sm leading-6 text-slate-300">
            Uninstalling the GitHub App stops future access. Workspace metadata
            deletion should be requested through{" "}
            <a
              href={reviewRouterContactMailto}
              className="inline-flex min-h-11 items-center align-middle text-cyan-100 underline decoration-cyan-300/50 underline-offset-4"
            >
              {reviewRouterContactEmail}
            </a>{" "}
            until an owner self-serve deletion flow exists.
          </p>
        </Card>
        <Card className="space-y-3">
          <Badge tone="warning">Subprocessors</Badge>
          <p className="text-sm leading-6 text-slate-300">
            Hosted beta uses the production hosting, database, and GitHub
            integration stack. A formal subprocessor list belongs in the
            production legal package.
          </p>
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
        <Card className="space-y-4 border-cyan-300/20">
          <Badge tone="accent">Balanced Memory</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Memory is confirmed knowledge, not conversation custody.
          </h2>
          <p className="text-sm leading-6 text-slate-300">
            When Memory is enabled, ReviewRouter may store short distilled
            snippets that a user explicitly asks to remember or that a model
            suggests for maintainer approval. Raw discussion threads, repository
            code, pull request diffs, prompts, model responses, and provider
            credentials are outside the Memory storage boundary.
          </p>
          <div className="grid gap-3">
            {memoryPrivacyControls.map((control) => (
              <div
                key={control.title}
                className="rounded-xl border border-cyan-200/10 bg-cyan-300/5 p-3"
              >
                <h3 className="text-sm font-semibold text-cyan-50">
                  {control.title}
                </h3>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  {control.body}
                </p>
              </div>
            ))}
          </div>
        </Card>

        <Card className="space-y-4">
          <Badge tone="warning">Memory lifecycle</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Runtime access stops before hard delete.
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-left text-sm">
              <thead className="text-cyan-100">
                <tr>
                  <th className="border-b border-cyan-200/15 px-3 py-2">
                    Object
                  </th>
                  <th className="border-b border-cyan-200/15 px-3 py-2">
                    Retention behavior
                  </th>
                  <th className="border-b border-cyan-200/15 px-3 py-2">
                    Runtime exposure
                  </th>
                </tr>
              </thead>
              <tbody className="text-slate-300">
                {memoryLifecycleRows.map(([object, retention, runtime]) => (
                  <tr key={object}>
                    <td className="border-b border-cyan-200/10 px-3 py-3 text-cyan-50">
                      {object}
                    </td>
                    <td className="border-b border-cyan-200/10 px-3 py-3">
                      {retention}
                    </td>
                    <td className="border-b border-cyan-200/10 px-3 py-3">
                      {runtime}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs leading-5 text-slate-400">
            Workspace admins can export active, disabled, and expired memory as
            JSON. Deleted memory is excluded from export and runtime retrieval.
          </p>
        </Card>
      </section>
    </main>
  );
}
