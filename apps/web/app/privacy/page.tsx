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
] as const;

const notCollectedByDefault = [
  "repository source code",
  "pull request diffs, prompts, or model responses",
  "Codex auth.json, refresh tokens, OpenAI API keys, or OpenRouter keys",
  "raw GitHub webhook payload bodies after normalization",
] as const;

export default function PrivacyPage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <div className="space-y-5">
          <Badge tone="accent">Privacy</Badge>
          <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-cyan-50 md:text-7xl">
            Metadata control plane, not code custody.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            ReviewRouter is designed as a metadata control plane. It keeps
            setup, model settings, health, and audit state in SaaS while
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
            audit, and support diagnostics. Provider credentials and review
            workloads stay in GitHub Actions or a trusted customer runner.
          </p>
        </Card>
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
            Beta metadata is retained only for setup, audit, support, and health
            operations. A published retention window belongs in the production
            legal package.
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
    </main>
  );
}
