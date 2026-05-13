import type { Metadata } from "next";
import { Badge, Card, LinkButton } from "@reviewrouter/ui";
import { createPublicPageMetadata } from "../seo";

export const metadata: Metadata = createPublicPageMetadata({
  title: "ReviewRouter vs cloud AI code reviewers",
  description:
    "Compare ReviewRouter with hosted AI code review tools. ReviewRouter keeps review execution, source code, PR diffs, prompts, and provider credentials out of ReviewRouter cloud by default.",
  path: "/compare",
});

const comparisonRows = [
  {
    tool: "ReviewRouter",
    execution: "Customer GitHub Actions by default",
    codePath:
      "The SaaS stores metadata, policy, audit, and health state. Source code, PR diffs, prompts, model responses, and provider credentials stay out of ReviewRouter cloud by default.",
    privacyFit:
      "Best fit when private codebases need centralized review policy without routing code through a reviewer SaaS.",
    operations:
      "GitHub App onboarding, setup PRs, OIDC runtime config, provider setup guidance, repo health, and audit.",
    accent: true,
  },
  {
    tool: "Cubic",
    execution: "Hosted short-lived sandbox",
    codePath:
      "Cubic says it fetches code into an isolated short-lived sandbox, deletes it after review, and sends minimal snippets to AI subprocessors.",
    privacyFit:
      "Strong hosted reviewer story, but not the same boundary as customer-CI execution.",
    operations:
      "Mature PR review product with CLI, custom agents, background fixes, codebase scans, wiki, and analytics.",
  },
  {
    tool: "CodeRabbit",
    execution: "Hosted reviewer across pull requests, IDE, and CLI",
    codePath:
      "CodeRabbit documents code/dependency caching and knowledge-base context. Data retention and cache settings can be disabled.",
    privacyFit:
      "Strong hosted workflow for teams comfortable with a managed review service handling context.",
    operations:
      "PR reviews, linters and SAST, analytics, MCP connections, multi-repo analysis, issue context, and agent workflows.",
  },
  {
    tool: "Qodo",
    execution: "Platform-managed review, with enterprise deployment options",
    codePath:
      "Qodo builds persistent codebase understanding for complex environments. Enterprise offers SaaS, single-tenant, on-prem, and air-gapped options.",
    privacyFit:
      "Strong enterprise platform story, especially when on-prem or air-gapped deployment is available.",
    operations:
      "PR review, IDE plugin, CLI workflows, context engine, rule system, governance, analytics, and enterprise controls.",
  },
  {
    tool: "Pullfrog",
    execution: "GitHub Actions agent runs",
    codePath:
      "Pullfrog says agent runs happen in the repository's GitHub Actions workflow. Provider keys can live in GitHub secrets, Pullfrog secrets, or Pullfrog Router.",
    privacyFit:
      "Closest architectural neighbor for customer-CI agent execution, with a broader agent automation scope.",
    operations:
      "GitHub App console, configurable automations, PR reviews, issue work, CI fixes, BYOK, Router, and run billing.",
  },
] as const;

const sourceLinks = [
  {
    label: "Cubic privacy and sandbox model",
    href: "https://docs.cubic.dev/account/privacy-security",
  },
  {
    label: "Cubic pricing and product tiers",
    href: "https://www.cubic.dev/pricing-plans",
  },
  {
    label: "CodeRabbit caching and retention controls",
    href: "https://docs.coderabbit.ai/reference/caching",
  },
  {
    label: "CodeRabbit knowledge base context",
    href: "https://docs.coderabbit.ai/knowledge-base",
  },
  {
    label: "Qodo platform overview",
    href: "https://docs.qodo.ai/qodo-platform-overview",
  },
  {
    label: "Qodo pricing and deployment options",
    href: "https://www.qodo.ai/pricing/",
  },
  {
    label: "Pullfrog GitHub Actions architecture",
    href: "https://pullfrog.com/",
  },
  {
    label: "Pullfrog security model",
    href: "https://docs.pullfrog.com/security",
  },
] as const;

const positioningPoints = [
  "ReviewRouter should not claim that AI review sends code nowhere. If an AI model is used, review context can go from customer CI to the provider the customer selected.",
  "The stronger claim is narrower and more defensible: source code, PR diffs, prompts, model output, and provider credentials do not pass through ReviewRouter cloud by default.",
  "That makes ReviewRouter a privacy-first managed control plane, not just another hosted reviewer.",
] as const;

export default function ComparePage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <div className="space-y-5">
          <Badge tone="accent">Comparison</Badge>
          <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-cyan-50 md:text-7xl">
            ReviewRouter vs cloud AI code reviewers
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            ReviewRouter is built for complex private codebases that need AI PR
            review without moving source code, diffs, prompts, model output, or
            provider credentials into a review vendor&apos;s cloud by default.
          </p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href="/security" variant="soft" tone="success">
              Security model
            </LinkButton>
            <LinkButton href="/getting-started" variant="outline">
              Setup guide
            </LinkButton>
          </div>
        </div>

        <Card className="space-y-4 border-lime-300/20">
          <Badge tone="success">Core difference</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            The control plane is hosted. The review workload is yours.
          </h2>
          <p className="text-sm leading-6 text-slate-300">
            Hosted reviewers usually optimize for a complete managed review
            engine. ReviewRouter optimizes for a smaller SaaS data boundary:
            configure review centrally, then run review inside customer GitHub
            Actions with customer-owned credentials.
          </p>
        </Card>
      </section>

      <Card className="space-y-4">
        <Badge tone="warning">Positioning matrix</Badge>
        <h2 className="text-2xl font-semibold text-cyan-50">
          Compare by execution boundary, not just feature count.
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] border-collapse text-left text-sm">
            <thead className="text-cyan-100">
              <tr>
                <th className="border-b border-cyan-200/15 px-3 py-2">Tool</th>
                <th className="border-b border-cyan-200/15 px-3 py-2">
                  Default execution
                </th>
                <th className="border-b border-cyan-200/15 px-3 py-2">
                  Code and data path
                </th>
                <th className="border-b border-cyan-200/15 px-3 py-2">
                  Privacy fit
                </th>
                <th className="border-b border-cyan-200/15 px-3 py-2">
                  Operational surface
                </th>
              </tr>
            </thead>
            <tbody className="text-slate-300">
              {comparisonRows.map((row) => (
                <tr
                  key={row.tool}
                  className={
                    "accent" in row && row.accent
                      ? "bg-lime-300/[0.04] text-lime-50"
                      : undefined
                  }
                >
                  <td className="border-b border-cyan-200/10 px-3 py-4 font-mono text-cyan-50">
                    {row.tool}
                  </td>
                  <td className="border-b border-cyan-200/10 px-3 py-4">
                    {row.execution}
                  </td>
                  <td className="border-b border-cyan-200/10 px-3 py-4">
                    {row.codePath}
                  </td>
                  <td className="border-b border-cyan-200/10 px-3 py-4">
                    {row.privacyFit}
                  </td>
                  <td className="border-b border-cyan-200/10 px-3 py-4">
                    {row.operations}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <section className="grid gap-6 lg:grid-cols-[0.9fr_1fr]">
        <Card className="space-y-4 border-lime-300/20">
          <Badge tone="success">Messaging guardrail</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Say the narrow claim strongly.
          </h2>
          <ul className="grid gap-3 text-sm leading-6 text-slate-300">
            {positioningPoints.map((point) => (
              <li
                key={point}
                className="rounded-xl border border-lime-300/10 bg-lime-300/5 p-3"
              >
                {point}
              </li>
            ))}
          </ul>
        </Card>

        <Card className="space-y-4">
          <Badge tone="neutral">Research links</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Public sources used for this comparison
          </h2>
          <div className="grid gap-2 text-sm leading-6">
            {sourceLinks.map((source) => (
              <a
                key={source.href}
                href={source.href}
                target="_blank"
                rel="noreferrer"
                className="rounded-xl border border-cyan-200/10 bg-cyan-300/5 px-3 py-2 text-cyan-100 underline decoration-cyan-300/40 underline-offset-4 hover:text-cyan-50"
              >
                {source.label}
              </a>
            ))}
          </div>
        </Card>
      </section>
    </main>
  );
}
