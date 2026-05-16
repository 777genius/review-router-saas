import type { Metadata } from "next";
import { freeBetaLimits } from "@reviewrouter/features-entitlements";
import { Badge, Card, CodeBlock, LinkButton } from "@reviewrouter/ui";
import { createPublicPageMetadata } from "../seo";

export const metadata: Metadata = createPublicPageMetadata({
  title: "Fair use limits",
  description:
    "ReviewRouter fair use limits for beta workspaces, repository sync, setup PRs, OIDC exchange, health reports, and dashboard writes.",
  path: "/fair-use",
});

const freeLimits = [
  ["Workspaces per GitHub user", String(freeBetaLimits.maxWorkspacesPerUser)],
  ["Repositories per workspace sync", String(freeBetaLimits.maxRepositories)],
  [
    "Setup PR attempts",
    `${freeBetaLimits.setupPrAttemptsPerRepositoryPerHour} per repository per hour`,
  ],
  [
    "Manual installation sync",
    `${freeBetaLimits.installationSyncsPerInstallationPer15Minutes} per installation per 15 minutes`,
  ],
  [
    "Review config saves",
    `${freeBetaLimits.reviewConfigSavesPerWorkspacePerHour} per workspace per hour`,
  ],
  [
    "Active memory items",
    `${freeBetaLimits.maxActiveMemoryItemsPerWorkspace} per workspace`,
  ],
  [
    "Pending memory suggestions",
    `${freeBetaLimits.maxPendingMemorySuggestionsPerWorkspace} per workspace`,
  ],
  [
    "Action OIDC exchange and health reports",
    "DB-backed per repository/run limits",
  ],
] as const;

const workerLimit = `# Default local beta repository sync cap
REVIEW_ROUTER_MAX_REPOSITORIES_PER_SYNC=${freeBetaLimits.maxRepositories}`;

export default function FairUsePage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <div className="space-y-5">
          <Badge tone="accent">Fair use</Badge>
          <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-cyan-50 md:text-7xl">
            Fair beta access with clear limits.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            ReviewRouter does not run model workloads in the SaaS by default,
            but the control plane still needs quotas for repository sync,
            workflow setup, OIDC exchange, health reports, and dashboard writes.
          </p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href="/terms">Terms</LinkButton>
            <LinkButton href="/support" variant="ghost">
              Support
            </LinkButton>
          </div>
        </div>

        <Card className="space-y-4">
          <Badge tone="success">Implemented cap</Badge>
          <h2 className="text-2xl font-semibold text-cyan-50">
            Repository sync has a worker-level cap.
          </h2>
          <p className="text-sm leading-6 text-slate-300">
            The worker applies a deterministic repository sync limit before
            persistence. If a GitHub installation returns more repositories than
            the cap, ReviewRouter keeps the first repositories by full name and
            reports how many were skipped.
          </p>
          <CodeBlock code={workerLimit} />
        </Card>
      </section>

      <Card className="space-y-4">
        <Badge tone="warning">Free beta limits</Badge>
        <h2 className="text-2xl font-semibold text-cyan-50">
          Current public-facing defaults
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead className="text-cyan-100">
              <tr>
                <th className="border-b border-cyan-200/15 px-3 py-2">Limit</th>
                <th className="border-b border-cyan-200/15 px-3 py-2">
                  Default
                </th>
              </tr>
            </thead>
            <tbody className="text-slate-300">
              {freeLimits.map(([limit, value]) => (
                <tr key={limit}>
                  <td className="border-b border-cyan-200/10 px-3 py-3 text-cyan-50">
                    {limit}
                  </td>
                  <td className="border-b border-cyan-200/10 px-3 py-3 font-mono">
                    {value}
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
