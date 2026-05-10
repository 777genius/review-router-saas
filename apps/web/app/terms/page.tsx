import type { Metadata } from "next";
import { Badge, Card, LinkButton } from "@reviewrouter/ui";
import { reviewRouterContactEmail } from "../public-urls";
import { createPublicPageMetadata } from "../seo";

export const metadata: Metadata = createPublicPageMetadata({
  title: "Trusted beta terms",
  description:
    "Trusted beta usage guidelines for ReviewRouter AI code review, including customer responsibilities, CI execution boundaries, and support limitations.",
  path: "/terms",
});

const responsibilities = [
  "Install the GitHub App only on repositories you are authorized to manage.",
  "Review generated workflow PRs before merging them.",
  "Store provider credentials only in trusted GitHub Actions secrets or trusted self-hosted runners.",
  "Do not use ReviewRouter to process data you are not allowed to expose to the configured CI environment.",
] as const;

const limitations = [
  "AI review output can be incomplete or wrong and must not replace human code ownership.",
  "Critical findings can intentionally fail CI depending on repository policy.",
  `Trusted beta support is best-effort through ${reviewRouterContactEmail} and is not an uptime or incident-response SLA.`,
  "Public pricing, paid plans, enterprise terms, and managed cloud review are outside the local beta scope.",
] as const;

export default function TermsPage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <div className="space-y-5">
          <Badge tone="accent">Terms</Badge>
          <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-cyan-50 md:text-7xl">
            Trusted beta usage guidelines.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            These guidelines set operational expectations for early users:
            install only where authorized, review generated workflow PRs, and
            keep provider credentials in your own GitHub Actions secrets.
          </p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href="/privacy" variant="soft" tone="success">
              Privacy
            </LinkButton>
            <LinkButton href="/security" variant="outline">
              Security model
            </LinkButton>
            <LinkButton href="/support" variant="ghost">
              Support
            </LinkButton>
            <LinkButton href="/fair-use" variant="ghost">
              Fair use
            </LinkButton>
          </div>
        </div>

        <Card className="space-y-4">
          <Badge tone="warning">Beta scope</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            ReviewRouter configures review, CI executes review.
          </h2>
          <p className="text-sm leading-6 text-slate-300">
            The v1 control plane helps install, configure, audit, and monitor AI
            review workflows. It does not provide a warranty that every bug will
            be found or that every finding is correct.
          </p>
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card className="space-y-4">
          <Badge tone="neutral">Customer responsibilities</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            What testers must control
          </h2>
          <ul className="grid gap-3 text-sm leading-6 text-slate-300">
            {responsibilities.map((item) => (
              <li
                key={item}
                className="rounded-xl border border-cyan-200/10 bg-cyan-300/5 p-3"
              >
                {item}
              </li>
            ))}
          </ul>
        </Card>

        <Card className="space-y-4">
          <Badge tone="warning">Limitations</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            What the beta does not promise
          </h2>
          <ul className="grid gap-3 text-sm leading-6 text-slate-300">
            {limitations.map((item) => (
              <li
                key={item}
                className="rounded-xl border border-amber-300/10 bg-amber-300/5 p-3"
              >
                {item}
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </main>
  );
}
