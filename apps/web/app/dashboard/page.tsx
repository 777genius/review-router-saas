import { Badge, Button, Card, LinkButton } from "@reviewrouter/ui";
import { resolveReviewRouterActionRef } from "@reviewrouter/platform-config";
import { PrismaRepositoryConnectionRepository } from "@reviewrouter/features-repositories";
import {
  listWorkspaceRepositoryHealth,
  OctokitRepositoryWorkflowProbe,
  PrismaRepositoryHealthRepository,
} from "@reviewrouter/features-repo-health";
import {
  freeBetaEntitlement,
  PrismaEntitlementRepository,
} from "@reviewrouter/features-entitlements";
import { PrismaAuditLogRepository } from "@reviewrouter/features-audit-log";
import { buildProviderSecretSetupGuidance } from "@reviewrouter/features-provider-setup";
import {
  listWorkspaceOutboxFailures,
  PrismaOutboxEventRepository,
} from "@reviewrouter/features-outbox";
import {
  listRepositoryWorkflowProvisioning,
  PrismaWorkflowProvisioningQuery,
} from "@reviewrouter/features-workflow-provisioning";
import {
  findReviewConfiguration,
  PrismaReviewConfigurationRepository,
  safeDefaultReviewConfiguration,
  type ReviewConfiguration,
} from "@reviewrouter/features-review-config";
import {
  getWorkspaceSupportDiagnostics,
  PrismaSupportDiagnosticsRepository,
} from "@reviewrouter/features-support-diagnostics";
import type { ProviderSecretKind } from "@reviewrouter/features-provider-setup";
import {
  createGitHubAppInstallationOctokit,
  getDashboardMutationStatus,
  getDashboardWorkspaceScope,
} from "../../src/server/dashboard-mutations";
import { getPrisma } from "../../src/server/prisma";
import {
  clearRepositoryReviewConfigAction,
  createSetupPullRequestAction,
  requestInstallationSyncAction,
  retryOutboxEventAction,
  saveRepositoryReviewConfigAction,
  saveWorkspaceReviewConfigAction,
} from "./actions";
import { getGitHubAppInstallUrl } from "../../src/server/github-app-install-url";
import { buildGitHubAppSetupNotice } from "../../src/server/github-app-setup-notice";
import { safeGitHubDashboardLink } from "../../src/server/safe-dashboard-link";
import {
  describeRepositoryHealth,
  summarizeWorkspaceHealth,
} from "../../src/server/repository-health-view";
import { resolveCodexSeedScriptUrl } from "../../src/server/codex-seed-script-url";

export const dynamic = "force-dynamic";

type DashboardWorkspace = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly installations: readonly {
    readonly accountLogin: string;
    readonly accountType: string;
    readonly githubInstallationId: string;
    readonly status: string;
    readonly repositorySelection: string;
  }[];
  readonly auditEvents: readonly {
    readonly action: string;
    readonly actor: string;
    readonly targetType: string;
    readonly createdAt: Date;
  }[];
};

async function loadDashboardData(
  scope: Awaited<ReturnType<typeof getDashboardWorkspaceScope>>,
  supportAudit?: {
    readonly actor: string;
    readonly reason: "local_admin_override" | "workspace_admin";
  },
) {
  if (scope.kind === "none") {
    return [];
  }
  if (scope.kind === "workspace_ids" && scope.workspaceIds.length === 0) {
    return [];
  }

  const prisma = getPrisma();
  const workspaceWhere =
    scope.kind === "workspace_ids"
      ? { id: { in: [...scope.workspaceIds] } }
      : undefined;
  const workspaces = await prisma.workspace.findMany({
    ...(workspaceWhere ? { where: workspaceWhere } : {}),
    orderBy: { createdAt: "desc" },
    take: 10,
    include: {
      installations: {
        orderBy: { updatedAt: "desc" },
        take: 3,
        select: {
          accountLogin: true,
          accountType: true,
          githubInstallationId: true,
          status: true,
          repositorySelection: true,
        },
      },
      auditEvents: {
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          action: true,
          actor: true,
          targetType: true,
          createdAt: true,
        },
      },
    },
  });
  const repositoryStore = new PrismaRepositoryConnectionRepository(prisma);
  const healthStore = new PrismaRepositoryHealthRepository(prisma);
  const workflowProbe = createDashboardWorkflowProbe();
  const entitlementStore = new PrismaEntitlementRepository(prisma);
  const reviewConfigStore = new PrismaReviewConfigurationRepository(prisma);
  const outboxStore = new PrismaOutboxEventRepository(prisma);
  const diagnosticsStore = new PrismaSupportDiagnosticsRepository(prisma);

  return Promise.all(
    workspaces.map(
      async (
        workspace,
      ): Promise<{
        workspace: DashboardWorkspace;
        repositoryCount: number;
        repositories: readonly Awaited<
          ReturnType<typeof repositoryStore.listWorkspaceRepositories>
        >[number][];
        health: readonly Awaited<
          ReturnType<typeof listWorkspaceRepositoryHealth>
        >[number][];
        provisioning: readonly Awaited<
          ReturnType<typeof listRepositoryWorkflowProvisioning>
        >[number][];
        entitlement: ReturnType<typeof freeBetaEntitlement>;
        reviewConfig: Awaited<ReturnType<typeof findReviewConfiguration>>;
        repositoryConfigs: readonly {
          readonly repositoryId: string;
          readonly config: Awaited<ReturnType<typeof findReviewConfiguration>>;
        }[];
        outboxFailures: Awaited<ReturnType<typeof listWorkspaceOutboxFailures>>;
        supportDiagnostics: Awaited<
          ReturnType<typeof getWorkspaceSupportDiagnostics>
        >;
      }> => {
        const repositories = await repositoryStore.listWorkspaceRepositories(
          workspace.id,
        );
        const entitlement =
          (await entitlementStore.findWorkspaceEntitlement(workspace.id)) ??
          freeBetaEntitlement(workspace.id);
        const health = await listWorkspaceRepositoryHealth(
          {
            workspaceId: workspace.id,
            expectedActionRef: resolveReviewRouterActionRef(),
            workflowProbeMaxRepositories: 8,
          },
          {
            repositories: healthStore,
            ...(workflowProbe ? { workflowProbe } : {}),
          },
        );
        const reviewConfig = await findReviewConfiguration(
          { scope: "workspace", workspaceId: workspace.id },
          { configurations: reviewConfigStore },
        );
        const repositoryConfigs = await Promise.all(
          repositories.map(async (repository) => ({
            repositoryId: repository.id,
            config: await findReviewConfiguration(
              {
                scope: "repository",
                workspaceId: workspace.id,
                repositoryId: repository.id,
              },
              { configurations: reviewConfigStore },
            ),
          })),
        );
        const outboxFailures = await listWorkspaceOutboxFailures(
          { workspaceId: workspace.id, limit: 5 },
          { outbox: outboxStore },
        );
        const provisioning = await listRepositoryWorkflowProvisioning(
          {
            workspaceId: workspace.id,
            repositoryIds: repositories.map((repository) => repository.id),
          },
          { provisioning: new PrismaWorkflowProvisioningQuery(prisma) },
        );
        const supportDiagnostics = await getWorkspaceSupportDiagnostics(
          {
            workspaceId: workspace.id,
            checkedAt: new Date(),
            ...(supportAudit ? { audit: supportAudit } : {}),
          },
          {
            diagnostics: diagnosticsStore,
            ...(supportAudit
              ? { auditLog: new PrismaAuditLogRepository(prisma) }
              : {}),
          },
        );

        return {
          workspace: {
            id: workspace.id,
            name: workspace.name,
            slug: workspace.slug,
            installations: workspace.installations.map((installation) => ({
              ...installation,
              githubInstallationId:
                installation.githubInstallationId.toString(),
            })),
            auditEvents: workspace.auditEvents,
          },
          repositoryCount: repositories.length,
          repositories: repositories.slice(0, 8),
          provisioning,
          entitlement,
          health,
          reviewConfig,
          repositoryConfigs,
          outboxFailures,
          supportDiagnostics,
        };
      },
    ),
  );
}

function createDashboardWorkflowProbe(): OctokitRepositoryWorkflowProbe | null {
  if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY_FILE) {
    return null;
  }
  return new OctokitRepositoryWorkflowProbe({
    createRequester: createGitHubAppInstallationOctokit,
  });
}

type DashboardWorkspaceData = Awaited<
  ReturnType<typeof loadDashboardData>
>[number];

type DashboardPageProps = {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
};

export default async function DashboardPage({
  searchParams,
}: DashboardPageProps): Promise<React.ReactElement> {
  const [mutationStatus, workspaceScope] = await Promise.all([
    getDashboardMutationStatus(),
    getDashboardWorkspaceScope(),
  ]);
  const supportAudit =
    workspaceScope.kind === "all" &&
    workspaceScope.reason === "local_admin_override" &&
    mutationStatus.githubLogin
      ? {
          actor: `support:${mutationStatus.githubLogin}`,
          reason: "local_admin_override" as const,
        }
      : undefined;
  const workspaces = await loadDashboardData(workspaceScope, supportAudit);
  const params = searchParams ? await searchParams : {};
  const appInstallUrl = getGitHubAppInstallUrl();

  if (workspaces.length === 0) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6 md:py-16">
        <OnboardingDashboard
          appInstallUrl={appInstallUrl}
          signedIn={mutationStatus.signedIn}
        />
        <DashboardNotice
          params={params}
          mutationStatus={mutationStatus}
          showReadOnlyHint={false}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-10 px-4 py-12 sm:px-6 md:py-16">
      <section className="grid min-w-0 gap-10 lg:min-h-[58vh] lg:grid-cols-[minmax(0,0.95fr)_minmax(360px,0.75fr)] lg:items-center">
        <div className="min-w-0 space-y-8">
          <div className="space-y-5">
            <div className="flex items-center gap-4">
              <span className="grid h-14 w-14 place-items-center rounded-2xl border border-white/[0.06] bg-white/[0.05] font-mono text-lg font-black text-cyan-100 shadow-[0_0_32px_rgba(0,240,255,0.12)]">
                RR
              </span>
              <Badge tone="accent">Dashboard</Badge>
            </div>
            <h1 className="max-w-3xl break-words bg-[image:var(--rr-gradient-brand)] bg-clip-text text-5xl font-extrabold leading-[1.05] tracking-[-0.04em] text-transparent md:text-7xl">
              Connected repositories
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-[#8892b0]">
              Repository sync is App-driven. The dashboard reads normalized
              installation and repository metadata, not code, diffs, PR bodies,
              or commit messages.
            </p>
          </div>

          <div className="flex max-w-2xl flex-wrap gap-3">
            {appInstallUrl ? (
              <LinkButton href={appInstallUrl} size="lg" className="min-w-44">
                Install GitHub App
              </LinkButton>
            ) : null}
            <LinkButton
              href="/getting-started"
              variant="outline"
              size="md"
              className="min-w-32"
            >
              Setup guide
            </LinkButton>
            <LinkButton
              href="/security"
              variant="outline"
              size="md"
              className="min-w-36"
            >
              Security model
            </LinkButton>
            <LinkButton
              href="/status"
              variant="outline"
              size="md"
              className="min-w-24"
            >
              Status
            </LinkButton>
          </div>

          <div className="flex flex-wrap items-center gap-4 font-mono text-xs text-[#8892b0]">
            <span className="text-cyan-100">CI runtime</span>
            <span className="h-4 w-px bg-cyan-300/20" />
            <span>No code custody</span>
            <span className="h-4 w-px bg-cyan-300/20" />
            <span>Metadata control plane</span>
          </div>
        </div>

        <DashboardHeroDemo />
      </section>

      <DashboardNotice params={params} mutationStatus={mutationStatus} />

      <section className="grid gap-5">
        {workspaces.map((workspace) => (
          <WorkspaceCard
            key={workspace.workspace.id}
            data={workspace}
            mutationsEnabled={mutationStatus.enabled}
          />
        ))}
      </section>
    </main>
  );
}

function OnboardingDashboard({
  appInstallUrl,
  signedIn,
}: {
  readonly appInstallUrl: string | null;
  readonly signedIn: boolean;
}): React.ReactElement {
  return (
    <section className="grid min-h-[72vh] items-center">
      <div className="relative">
        <div className="absolute -inset-6 rounded-[2.5rem] bg-[radial-gradient(circle_at_20%_20%,rgba(0,240,255,0.18),transparent_34%),radial-gradient(circle_at_80%_30%,rgba(255,0,255,0.16),transparent_30%),radial-gradient(circle_at_50%_90%,rgba(57,255,20,0.08),transparent_32%)] blur-2xl" />
        <Card className="relative overflow-hidden rounded-[2rem] border-cyan-300/[0.16] bg-[#0a0a0f]/90 p-6 shadow-[0_30px_90px_rgba(0,0,0,0.55),0_0_80px_-40px_rgba(0,240,255,0.85)] sm:p-10">
          <div className="absolute right-0 top-0 h-56 w-56 rounded-full bg-cyan-300/10 blur-3xl" />
          <div className="relative mx-auto grid max-w-3xl justify-items-center gap-8 text-center">
            <div className="grid justify-items-center gap-4">
              <span className="grid h-16 w-16 place-items-center rounded-2xl border border-white/[0.08] bg-white/[0.06] font-mono text-xl font-black text-cyan-100 shadow-[0_0_36px_rgba(0,240,255,0.18)]">
                RR
              </span>
              <Badge tone="accent">GitHub setup</Badge>
            </div>

            <div className="space-y-5">
              <h1 className="bg-[image:var(--rr-gradient-brand)] bg-clip-text text-5xl font-extrabold leading-[1.02] tracking-[-0.05em] text-transparent md:text-7xl">
                Connect ReviewRouter.
              </h1>
              <p className="mx-auto max-w-2xl text-lg leading-8 text-[#a0a8c0]">
                Install the GitHub App on selected repositories. ReviewRouter
                will sync metadata, create the setup PR, and keep provider
                secrets inside GitHub Actions.
              </p>
            </div>

            <div className="grid w-full max-w-xl gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
              {appInstallUrl ? (
                <LinkButton
                  href={appInstallUrl}
                  size="lg"
                  className="h-16 rounded-2xl px-8 text-lg font-semibold"
                >
                  Install GitHub App
                </LinkButton>
              ) : (
                <LinkButton
                  href="/api/auth/signin"
                  size="lg"
                  className="h-16 rounded-2xl px-8 text-lg font-semibold"
                >
                  Sign in with GitHub
                </LinkButton>
              )}
              {!signedIn ? (
                <LinkButton
                  href="/api/auth/signin"
                  variant="outline"
                  size="lg"
                  className="h-16 rounded-2xl px-8"
                >
                  Sign in
                </LinkButton>
              ) : (
                <LinkButton
                  href="/getting-started"
                  variant="outline"
                  size="lg"
                  className="h-16 rounded-2xl px-8"
                >
                  Setup guide
                </LinkButton>
              )}
            </div>

            <div className="grid w-full gap-3 text-left sm:grid-cols-3">
              {[
                ["1", "Install App", "Choose only the repositories to review."],
                ["2", "Create setup PR", "ReviewRouter opens a workflow PR."],
                ["3", "Seed provider", "Codex or API keys stay in GitHub."],
              ].map(([step, title, body]) => (
                <div
                  key={step}
                  className="rounded-2xl border border-white/[0.08] bg-white/[0.04] p-4"
                >
                  <span className="font-mono text-xs font-bold text-cyan-100">
                    STEP {step}
                  </span>
                  <h2 className="mt-3 text-base font-bold text-[#e0e6ff]">
                    {title}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-[#94a3b8]">
                    {body}
                  </p>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap justify-center gap-4 font-mono text-xs text-[#8892b0]">
              <span className="text-cyan-100">No code custody</span>
              <span>Runs in customer CI</span>
              <span>Selected repositories only</span>
            </div>
          </div>
        </Card>
      </div>
    </section>
  );
}

function DashboardHeroDemo(): React.ReactElement {
  const agents = [
    {
      name: "Codex",
      accent: "border-cyan-300 text-cyan-100",
      dot: "bg-cyan-300",
    },
    {
      name: "OpenRouter",
      accent: "border-fuchsia-400 text-fuchsia-200",
      dot: "bg-fuchsia-400",
    },
    {
      name: "Policy",
      accent: "border-lime-300 text-lime-100",
      dot: "bg-lime-300",
    },
  ] as const;
  const lanes = [
    { label: "Diff", color: "text-slate-400", cards: ["PR files"] },
    { label: "Review", color: "text-cyan-100", cards: ["Agent context"] },
    { label: "Gate", color: "text-amber-100", cards: ["Severity policy"] },
    { label: "Done", color: "text-lime-100", cards: ["Inline comments"] },
  ] as const;

  return (
    <div className="relative">
      <div className="absolute -inset-1 rounded-[1.4rem] bg-[linear-gradient(135deg,rgba(0,240,255,0.2),rgba(255,0,255,0.18),rgba(57,255,20,0.08))] opacity-50 blur-2xl" />
      <Card className="relative z-10 min-h-[330px] rounded-[1rem] border-cyan-300/[0.15] bg-[#0a0a0f]/95 p-4 shadow-[0_20px_60px_rgba(0,0,0,0.6),0_0_30px_rgba(0,240,255,0.05),inset_0_1px_0_rgba(0,240,255,0.1)]">
        <div className="flex min-h-[300px] flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-sm font-bold tracking-[0.08em] text-[#e0e6ff]">
              ReviewRouter
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-lime-300/20 bg-lime-300/10 px-3 py-1 font-mono text-[0.65rem] font-bold tracking-[0.12em] text-lime-100">
              <span className="h-1.5 w-1.5 rounded-full bg-lime-300 shadow-[0_0_8px_rgba(57,255,20,0.8)]" />
              LIVE
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {agents.map((agent) => (
              <div
                key={agent.name}
                className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2"
              >
                <span
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border ${agent.accent} bg-black/30`}
                >
                  <span className={`h-2 w-2 rounded-full ${agent.dot}`} />
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-[#a0a8c0]">
                  {agent.name}
                </span>
                <span className={`h-1.5 w-1.5 rounded-full ${agent.dot}`} />
              </div>
            ))}
          </div>

          <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
            {lanes.map((lane) => (
              <div key={lane.label} className="flex min-w-0 flex-col gap-2">
                <span
                  className={`font-mono text-[0.62rem] font-bold uppercase tracking-[0.1em] ${lane.color}`}
                >
                  {lane.label}
                </span>
                <div className="min-h-24 rounded-lg border border-white/[0.05] bg-white/[0.025] p-2">
                  {lane.cards.map((card) => (
                    <div
                      key={card}
                      className="rounded-md border-l-2 border-cyan-300 bg-white/[0.04] px-2 py-2 font-mono text-[0.68rem] leading-4 text-[#c8d6e5]"
                    >
                      {card}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-cyan-300/[0.08] bg-black/30 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="h-3.5 w-3.5 rounded-full border border-lime-300/50 bg-lime-300/10" />
              <span className="font-mono text-xs text-[#a0a8c0]">
                Waiting for selected repository...
              </span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function WorkspaceCard({
  data,
  mutationsEnabled,
}: {
  readonly data: DashboardWorkspaceData;
  readonly mutationsEnabled: boolean;
}): React.ReactElement {
  const {
    workspace,
    repositoryCount,
    repositories,
    entitlement,
    health,
    provisioning,
    repositoryConfigs,
    outboxFailures,
    supportDiagnostics,
  } = data;
  const activeConfig =
    data.reviewConfig?.config ?? safeDefaultReviewConfiguration;
  const activeConfigVersion = data.reviewConfig?.version ?? 1;
  const primaryRepository =
    repositories.find((repository) => repository.selected) ?? repositories[0];
  const primaryInstallation = workspace.installations[0];
  const primaryRepositoryConfig = primaryRepository
    ? repositoryConfigs.find(
        (item) => item.repositoryId === primaryRepository.id,
      )?.config
    : null;
  const primaryEffectiveConfig =
    primaryRepositoryConfig?.config ?? activeConfig;
  const providerGuidance = primaryRepository
    ? buildProviderSecretSetupGuidance({
        provider: providerSecretKindForAuthMode(
          primaryEffectiveConfig.provider.authMode,
        ),
        repoFullName: primaryRepository.fullName,
        seedScriptUrl: resolveCodexSeedScriptUrl(),
        organizationLogin:
          primaryInstallation?.accountType === "Organization"
            ? primaryInstallation.accountLogin
            : null,
      })
    : null;
  const workspaceHealth = summarizeWorkspaceHealth(
    repositories.map(
      (repository) =>
        health.find((item) => item.repositoryId === repository.id)?.status,
    ),
  );

  return (
    <Card className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-cyan-50">
            {workspace.name}
          </h2>
          <p className="text-sm text-slate-400">{workspace.slug}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone="success">{repositoryCount} repositories</Badge>
          <Badge tone={workspaceHealth.tone}>{workspaceHealth.label}</Badge>
          <Badge tone="accent">
            {entitlement.plan.replace("_", " ")} / {entitlement.status}
          </Badge>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {workspace.installations.map((installation) => (
          <div
            key={`${workspace.id}-${installation.githubInstallationId}`}
            className="space-y-3 rounded-xl border border-cyan-200/10 bg-cyan-300/5 p-3"
          >
            <div>
              <p className="text-sm font-semibold text-cyan-50">
                {installation.accountLogin}
              </p>
              <p className="text-xs uppercase tracking-[0.16em] text-slate-400">
                {installation.accountType} / {installation.status} /{" "}
                {installation.repositorySelection}
              </p>
            </div>
            <form action={requestInstallationSyncAction}>
              <input type="hidden" name="workspaceId" value={workspace.id} />
              <input
                type="hidden"
                name="githubInstallationId"
                value={installation.githubInstallationId}
              />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={!mutationsEnabled || installation.status !== "active"}
              >
                Sync repos
              </Button>
            </form>
          </div>
        ))}
      </div>

      {providerGuidance ? (
        <div className="rounded-xl border border-emerald-300/20 bg-emerald-300/10 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge tone="success">
              {providerSetupTitle(providerGuidance.provider)}
            </Badge>
            <span className="text-xs uppercase tracking-[0.16em] text-emerald-100">
              {providerGuidance.recommendedScope.replaceAll("_", " ")}
            </span>
          </div>
          <p className="mb-4 text-sm leading-6 text-emerald-50">
            {providerSetupIntro(providerGuidance.provider)}
          </p>
          {providerGuidance.warnings.length > 0 ? (
            <ul className="mb-4 list-disc space-y-1 pl-5 text-xs leading-5 text-emerald-100/90">
              {providerGuidance.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          <div className="grid gap-3">
            {providerGuidance.commands.map((command) => (
              <div
                key={command.title}
                className="rounded-lg border border-emerald-200/10 bg-slate-950/80 p-3"
              >
                <p className="text-sm font-semibold text-emerald-50">
                  {command.title}
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  {command.description}
                </p>
                <pre className="mt-3 overflow-x-auto rounded-md bg-black/40 p-3 text-xs text-cyan-100">
                  <code>{command.command}</code>
                </pre>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="rounded-xl border border-cyan-200/10 bg-cyan-300/5 p-4">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Badge tone="accent">Review config</Badge>
          <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
            workspace default / v{activeConfigVersion}
          </span>
        </div>
        <ReviewConfigForm
          action={saveWorkspaceReviewConfigAction}
          config={activeConfig}
          hiddenFields={[{ name: "workspaceId", value: workspace.id }]}
          mutationsEnabled={mutationsEnabled}
          submitLabel="Save workspace default"
        />
      </div>

      {repositories.length > 0 ? (
        <div className="rounded-xl border border-cyan-200/10 bg-slate-950/60 p-4">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge tone="accent">Repository overrides</Badge>
            <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
              optional per-repository provider/model/effort
            </span>
          </div>
          <div className="grid gap-3">
            {repositories.map((repository) => {
              const repositoryConfig = repositoryConfigs.find(
                (item) => item.repositoryId === repository.id,
              )?.config;
              const effectiveConfig = repositoryConfig?.config ?? activeConfig;
              const configVersion =
                repositoryConfig?.version ?? activeConfigVersion;

              return (
                <details
                  key={`${repository.id}-review-config`}
                  className="rounded-lg border border-cyan-200/10 bg-cyan-300/5 p-3"
                >
                  <summary className="cursor-pointer list-none">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-cyan-50">
                          {repository.fullName}
                        </p>
                        <p className="text-xs text-slate-400">
                          {repositoryConfig
                            ? `Repository override / v${configVersion}`
                            : `Inherits workspace default / v${configVersion}`}
                        </p>
                      </div>
                      <Badge tone={repositoryConfig ? "warning" : "success"}>
                        {repositoryConfig ? "override" : "inherits"}
                      </Badge>
                    </div>
                  </summary>
                  <div className="mt-4 space-y-3">
                    <ReviewConfigForm
                      action={saveRepositoryReviewConfigAction}
                      config={effectiveConfig}
                      hiddenFields={[
                        { name: "workspaceId", value: workspace.id },
                        { name: "repositoryId", value: repository.id },
                      ]}
                      mutationsEnabled={
                        mutationsEnabled &&
                        repository.selected &&
                        !repository.archived
                      }
                      submitLabel={
                        repositoryConfig ? "Update override" : "Save override"
                      }
                    />
                    {repositoryConfig ? (
                      <form action={clearRepositoryReviewConfigAction}>
                        <input
                          type="hidden"
                          name="workspaceId"
                          value={workspace.id}
                        />
                        <input
                          type="hidden"
                          name="repositoryId"
                          value={repository.id}
                        />
                        <Button
                          type="submit"
                          variant="outline"
                          size="sm"
                          disabled={
                            !mutationsEnabled ||
                            !repository.selected ||
                            repository.archived
                          }
                        >
                          Inherit workspace default
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </details>
              );
            })}
          </div>
        </div>
      ) : null}

      {repositories.some((repository) => repository.visibility === "public") ? (
        <div className="rounded-xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm leading-6 text-amber-100">
          Public repository warning: fork pull requests are skipped by default
          for secret-backed providers. Maintainers can add a trusted rerun flow
          later, but v1 keeps provider secrets out of untrusted fork code paths.
        </div>
      ) : null}

      <div className="rounded-xl border border-cyan-200/10 bg-slate-950/60 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge tone={workspaceHealth.tone}>Readiness</Badge>
          <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
            {workspaceHealth.ready} ready / {workspaceHealth.needsSetup} setup /{" "}
            {workspaceHealth.needsAttention} attention /{" "}
            {workspaceHealth.unknown} unknown
          </span>
        </div>
        <p className="text-sm leading-6 text-slate-300">
          This is metadata-only repository health. It does not include code,
          diffs, prompts, or provider output.
        </p>
      </div>

      {supportDiagnostics ? (
        <div className="rounded-xl border border-magenta-300/20 bg-fuchsia-400/10 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge tone="accent">Support diagnostics</Badge>
            <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
              metadata only / no code, diffs, prompts, or secrets
            </span>
          </div>
          <div className="grid gap-3 text-sm md:grid-cols-5">
            <SupportMetric
              label="Repositories"
              value={`${supportDiagnostics.repositoryCounts.selected}/${supportDiagnostics.repositoryCounts.total}`}
              hint={`${supportDiagnostics.repositoryCounts.notConfigured} missing workflow`}
            />
            <SupportMetric
              label="Provider"
              value={`${supportDiagnostics.providerCounts.configured} configured`}
              hint={`${supportDiagnostics.providerCounts.missing + supportDiagnostics.providerCounts.staleOrInvalid} need setup`}
            />
            <SupportMetric
              label="Outbox"
              value={`${supportDiagnostics.outboxCounts.deadLetter} dead-letter`}
              hint={`${supportDiagnostics.outboxCounts.pending} pending`}
            />
            <SupportMetric
              label="Workflow PRs"
              value={`${supportDiagnostics.workflowProvisioningCounts.setup_pr_open ?? 0} open`}
              hint={`${supportDiagnostics.workflowProvisioningCounts.failed ?? 0} failed`}
            />
            <SupportMetric
              label="Action runs"
              value={`${supportDiagnostics.actionRunCounts.repositoriesWithReports} reports`}
              hint={`${supportDiagnostics.actionRunCounts.criticalFindings} critical / ${supportDiagnostics.actionRunCounts.inlineComments} inline`}
            />
          </div>
          {supportDiagnostics.recentAuditActions.length > 0 ? (
            <p className="mt-3 text-xs leading-5 text-slate-400">
              Recent audit actions:{" "}
              {supportDiagnostics.recentAuditActions.slice(0, 4).join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-xl border border-cyan-200/10 bg-slate-950/60 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge tone={outboxFailures.length > 0 ? "warning" : "success"}>
            Operational queue
          </Badge>
          <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
            dead letters / retries
          </span>
        </div>
        {outboxFailures.length === 0 ? (
          <p className="text-sm leading-6 text-slate-400">
            No stuck or failed background events for this workspace.
          </p>
        ) : (
          <div className="grid gap-3">
            {outboxFailures.map((event) => (
              <div
                key={event.id}
                className="grid gap-3 rounded-lg border border-amber-200/10 bg-amber-300/10 p-3 md:grid-cols-[1fr_auto]"
              >
                <div>
                  <p className="text-sm font-semibold text-amber-50">
                    {event.type}@v{event.version} / {event.status}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-300">
                    Attempts {event.attempts}/{event.maxAttempts}
                    {event.lastErrorCode ? ` - ${event.lastErrorCode}` : ""}
                  </p>
                  {event.safeLastErrorSummary ? (
                    <p className="mt-1 text-xs leading-5 text-slate-400">
                      {event.safeLastErrorSummary}
                    </p>
                  ) : null}
                  <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-slate-500">
                    Updated {event.updatedAt.toISOString()}
                  </p>
                </div>
                <form action={retryOutboxEventAction} className="self-center">
                  <input
                    type="hidden"
                    name="workspaceId"
                    value={workspace.id}
                  />
                  <input type="hidden" name="eventId" value={event.id} />
                  <Button
                    type="submit"
                    variant="outline"
                    size="sm"
                    disabled={
                      !mutationsEnabled || event.status !== "dead_letter"
                    }
                  >
                    Retry
                  </Button>
                </form>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-cyan-200/10">
        <table className="w-full text-left text-sm">
          <thead className="bg-cyan-300/10 text-xs uppercase tracking-[0.16em] text-cyan-100">
            <tr>
              <th className="px-4 py-3">Repository</th>
              <th className="px-4 py-3">Visibility</th>
              <th className="px-4 py-3">Default branch</th>
              <th className="px-4 py-3">Setup</th>
              <th className="px-4 py-3">Health</th>
              <th className="px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cyan-200/10 text-slate-200">
            {repositories.map((repository) => {
              const repositoryHealth = health.find(
                (item) => item.repositoryId === repository.id,
              );
              const healthView = describeRepositoryHealth(
                repositoryHealth?.status,
                repositoryHealth?.summary,
              );
              const repositoryProvisioning = provisioning.find(
                (item) => item.repositoryId === repository.id,
              );
              const setupPullRequestUrl = safeGitHubDashboardLink(
                repositoryProvisioning?.pullRequestUrl ?? "",
              );
              const workflowCurrent = workflowSetupAlreadyCurrent(
                repositoryHealth?.status,
              );
              return (
                <tr
                  key={repository.id}
                  className={repository.selected ? "" : "opacity-50"}
                >
                  <td className="px-4 py-3 font-medium">
                    {repository.fullName}
                  </td>
                  <td className="px-4 py-3">{repository.visibility}</td>
                  <td className="px-4 py-3">{repository.defaultBranch}</td>
                  <td className="px-4 py-3">
                    <span className="block">{repository.setupStatus}</span>
                    {setupPullRequestUrl ? (
                      <a
                        className="text-xs text-cyan-100 underline decoration-cyan-300/50 underline-offset-4"
                        href={setupPullRequestUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open setup PR
                      </a>
                    ) : null}
                    {repositoryProvisioning?.errorMessage ? (
                      <span className="block text-xs text-red-200">
                        {repositoryProvisioning.errorMessage.slice(0, 120)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={healthView.tone}>{healthView.label}</Badge>
                    <span className="mt-2 block text-xs leading-5 text-slate-300">
                      {healthView.summary}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-slate-500">
                      Next: {healthView.nextAction}
                    </span>
                    {repositoryHealth?.latestActionHealthTelemetry ? (
                      <span className="mt-1 block text-[11px] leading-5 text-cyan-100/80">
                        Latest run:{" "}
                        {formatActionHealthTelemetry(
                          repositoryHealth.latestActionHealthTelemetry,
                        )}
                      </span>
                    ) : null}
                    {repositoryHealth?.latestActionHealthReceivedAt ? (
                      <span className="mt-1 block text-[11px] uppercase tracking-[0.12em] text-slate-500">
                        Reported{" "}
                        {repositoryHealth.latestActionHealthReceivedAt.toISOString()}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <form action={createSetupPullRequestAction}>
                      <input
                        type="hidden"
                        name="workspaceId"
                        value={workspace.id}
                      />
                      <input
                        type="hidden"
                        name="repositoryId"
                        value={repository.id}
                      />
                      <Button
                        type="submit"
                        variant="soft"
                        size="sm"
                        disabled={
                          !mutationsEnabled ||
                          !repository.selected ||
                          repository.archived ||
                          workflowCurrent
                        }
                      >
                        {workflowCurrent
                          ? "Installed"
                          : repository.setupStatus === "setup_pr_open"
                            ? "Update PR"
                            : "Setup PR"}
                      </Button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-cyan-200/10 bg-slate-950/60 p-4">
        <p className="mb-3 text-xs uppercase tracking-[0.16em] text-cyan-100">
          Recent audit
        </p>
        {workspace.auditEvents.length === 0 ? (
          <p className="text-sm text-slate-400">No audit events yet.</p>
        ) : (
          <ul className="space-y-2 text-sm text-slate-300">
            {workspace.auditEvents.map((event) => (
              <li
                key={`${event.action}-${event.targetType}-${event.createdAt.toISOString()}`}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <span>
                  {event.action} by {event.actor}
                </span>
                <span className="text-xs text-slate-500">
                  {event.createdAt.toISOString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function SupportMetric({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-fuchsia-200/10 bg-slate-950/70 p-3">
      <p className="text-xs uppercase tracking-[0.16em] text-fuchsia-100">
        {label}
      </p>
      <p className="mt-2 text-lg font-semibold text-cyan-50">{value}</p>
      <p className="mt-1 text-xs text-slate-400">{hint}</p>
    </div>
  );
}

type DashboardActionHealthTelemetry = NonNullable<
  Awaited<
    ReturnType<typeof listWorkspaceRepositoryHealth>
  >[number]["latestActionHealthTelemetry"]
>;

function formatActionHealthTelemetry(
  telemetry: DashboardActionHealthTelemetry,
): string {
  const findings = [
    countLabel(telemetry.findingCounts.critical, "critical"),
    countLabel(telemetry.findingCounts.major, "major"),
    countLabel(telemetry.findingCounts.minor, "minor"),
    countLabel(telemetry.findingCounts.info, "info"),
  ].filter(Boolean);
  const comments = [
    countLabel(telemetry.commentCounts.inline, "inline"),
    countLabel(telemetry.commentCounts.summary, "summary"),
  ].filter(Boolean);
  const source = telemetry.configSource
    ? telemetry.configSource.replaceAll("_", " ")
    : null;
  const skipped =
    telemetry.skippedReasonCategory &&
    telemetry.skippedReasonCategory !== "none"
      ? `skipped: ${telemetry.skippedReasonCategory.replaceAll("_", " ")}`
      : null;

  return [source, findings.join(" / "), comments.join(" / "), skipped]
    .filter(Boolean)
    .join(" - ");
}

function countLabel(value: number | null, label: string): string | null {
  if (typeof value !== "number" || value <= 0) {
    return null;
  }
  return `${value} ${label}`;
}

type DashboardFormAction = (formData: FormData) => void | Promise<void>;

function ReviewConfigForm({
  action,
  config,
  hiddenFields,
  mutationsEnabled,
  submitLabel,
}: {
  readonly action: DashboardFormAction;
  readonly config: ReviewConfiguration;
  readonly hiddenFields: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly mutationsEnabled: boolean;
  readonly submitLabel: string;
}): React.ReactElement {
  return (
    <form action={action} className="grid gap-3 md:grid-cols-3">
      {hiddenFields.map((field) => (
        <input
          key={`${field.name}:${field.value}`}
          type="hidden"
          name={field.name}
          value={field.value}
        />
      ))}
      <label className="space-y-1 text-sm text-slate-300">
        <span>Provider auth</span>
        <select
          name="providerAuthMode"
          defaultValue={config.provider.authMode}
          disabled={!mutationsEnabled}
          className="w-full rounded-lg border border-cyan-200/15 bg-slate-950 px-3 py-2 text-cyan-50"
        >
          <option value="codex_subscription_oauth">Codex OAuth</option>
          <option value="codex_openai_api_key">Codex API key</option>
          <option value="openrouter_api_key">OpenRouter API key</option>
        </select>
      </label>
      <label className="space-y-1 text-sm text-slate-300">
        <span>Model</span>
        <input
          name="model"
          defaultValue={config.provider.model}
          disabled={!mutationsEnabled}
          className="w-full rounded-lg border border-cyan-200/15 bg-slate-950 px-3 py-2 text-cyan-50"
        />
      </label>
      <label className="space-y-1 text-sm text-slate-300">
        <span>Reasoning effort</span>
        <select
          name="reasoningEffort"
          defaultValue={config.provider.reasoningEffort}
          disabled={!mutationsEnabled}
          className="w-full rounded-lg border border-cyan-200/15 bg-slate-950 px-3 py-2 text-cyan-50"
        >
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </label>
      <label className="space-y-1 text-sm text-slate-300">
        <span>Fail on severity</span>
        <select
          name="failOnSeverity"
          defaultValue={config.blockingPolicy.failOnSeverity}
          disabled={!mutationsEnabled}
          className="w-full rounded-lg border border-cyan-200/15 bg-slate-950 px-3 py-2 text-cyan-50"
        >
          <option value="off">off</option>
          <option value="critical">critical</option>
          <option value="major">major</option>
        </select>
      </label>
      <label className="space-y-1 text-sm text-slate-300">
        <span>Inline max comments</span>
        <input
          name="inlineMaxComments"
          type="number"
          min={0}
          max={50}
          defaultValue={config.limits.inlineMaxComments}
          disabled={!mutationsEnabled}
          className="w-full rounded-lg border border-cyan-200/15 bg-slate-950 px-3 py-2 text-cyan-50"
        />
      </label>
      <label className="space-y-1 text-sm text-slate-300">
        <span>Target tokens per batch</span>
        <input
          name="targetTokensPerBatch"
          type="number"
          min={4000}
          max={200000}
          step={1000}
          defaultValue={config.limits.targetTokensPerBatch}
          disabled={!mutationsEnabled}
          className="w-full rounded-lg border border-cyan-200/15 bg-slate-950 px-3 py-2 text-cyan-50"
        />
      </label>
      <label className="space-y-1 text-sm text-slate-300">
        <span>Agentic context</span>
        <select
          name="agenticContext"
          defaultValue={String(config.provider.agenticContext)}
          disabled={!mutationsEnabled}
          className="w-full rounded-lg border border-cyan-200/15 bg-slate-950 px-3 py-2 text-cyan-50"
        >
          <option value="true">enabled</option>
          <option value="false">disabled</option>
        </select>
      </label>
      <div className="flex items-end">
        <Button type="submit" variant="solid" disabled={!mutationsEnabled}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function providerSecretKindForAuthMode(
  authMode: ReviewConfiguration["provider"]["authMode"],
): ProviderSecretKind {
  switch (authMode) {
    case "codex_subscription_oauth":
      return "codex_oauth";
    case "codex_openai_api_key":
      return "openai_api_key";
    case "openrouter_api_key":
      return "openrouter_api_key";
  }
}

function providerSetupTitle(provider: ProviderSecretKind): string {
  switch (provider) {
    case "codex_oauth":
      return "Codex OAuth setup";
    case "openai_api_key":
      return "OpenAI API key setup";
    case "openrouter_api_key":
      return "OpenRouter API key setup";
  }
}

function providerSetupIntro(provider: ProviderSecretKind): React.ReactNode {
  switch (provider) {
    case "codex_oauth":
      return (
        <>
          Run this on a trusted machine where Codex CLI is already logged in.
          The command writes directly to GitHub Actions secrets through{" "}
          <code>gh</code>; ReviewRouter SaaS never receives{" "}
          <code>CODEX_AUTH_JSON</code>.
        </>
      );
    case "openai_api_key":
      return (
        <>
          Run this where <code>gh</code> is authenticated and paste the OpenAI
          key when prompted. ReviewRouter SaaS never receives{" "}
          <code>OPENAI_API_KEY</code>.
        </>
      );
    case "openrouter_api_key":
      return (
        <>
          Run this where <code>gh</code> is authenticated and paste the
          OpenRouter key when prompted. ReviewRouter SaaS never receives{" "}
          <code>OPENROUTER_API_KEY</code>.
        </>
      );
  }
}

function DashboardNotice({
  params,
  mutationStatus,
  showReadOnlyHint = true,
}: {
  readonly params: Record<string, string | string[] | undefined>;
  readonly mutationStatus: Awaited<
    ReturnType<typeof getDashboardMutationStatus>
  >;
  readonly showReadOnlyHint?: boolean;
}): React.ReactElement | null {
  const notice = readParam(params.notice);
  const error = readParam(params.error);
  const appSetupNotice = buildGitHubAppSetupNotice({
    installationId: readParam(params.installation_id),
    setupAction: readParam(params.setup_action),
    signedIn: mutationStatus.signedIn,
  });
  if (notice) {
    const pullRequestUrl = safeGitHubDashboardLink(readParam(params.pr));
    return (
      <Card className="rounded-[2rem] border-lime-300/25 bg-lime-300/10 p-6 shadow-[0_18px_58px_rgba(190,255,61,0.08)] sm:p-7">
        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
          <Badge tone="success">Done</Badge>
          <p className="text-sm leading-7 text-lime-50">
            {dashboardNoticeText(notice, readParam(params.repository))}
            {pullRequestUrl ? (
              <>
                {" "}
                <a
                  className="text-cyan-100 underline decoration-cyan-300/50 underline-offset-4"
                  href={pullRequestUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open pull request
                </a>
              </>
            ) : null}
          </p>
        </div>
      </Card>
    );
  }
  if (error) {
    return (
      <Card className="rounded-[2rem] border-red-300/25 bg-red-300/10 p-6 shadow-[0_18px_58px_rgba(248,113,113,0.08)] sm:p-7">
        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
          <Badge tone="danger">Action failed</Badge>
          <p className="text-sm leading-7 text-red-50">
            {dashboardErrorText(error)}
          </p>
        </div>
      </Card>
    );
  }
  if (appSetupNotice) {
    return (
      <Card className="rounded-[2rem] border-cyan-300/25 bg-cyan-300/10 p-6 shadow-[0_18px_58px_rgba(0,240,255,0.08)] sm:p-7">
        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
          <Badge tone="accent">{appSetupNotice.title}</Badge>
          <p className="text-sm leading-7 text-cyan-50">
            {appSetupNotice.body}
            {!mutationStatus.signedIn ? (
              <>
                {" "}
                <a
                  className="text-cyan-100 underline decoration-cyan-300/50 underline-offset-4"
                  href="/api/auth/signin"
                >
                  Sign in
                </a>
              </>
            ) : null}
          </p>
        </div>
      </Card>
    );
  }
  if (!mutationStatus.enabled && showReadOnlyHint) {
    return (
      <Card className="rounded-[2rem] border-amber-300/25 bg-amber-300/10 p-6 shadow-[0_18px_58px_rgba(251,191,36,0.08)] sm:p-7">
        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
          <Badge tone="warning">Read-only dashboard</Badge>
          <p className="text-sm leading-7 text-amber-50">
            {mutationStatus.reason === "signed_out"
              ? "Sign in with GitHub to request repository syncs or setup PRs."
              : mutationStatus.reason === "auth_misconfigured"
                ? "GitHub OAuth is not configured. Set AUTH_SECRET, GITHUB_APP_CLIENT_ID, and GITHUB_APP_CLIENT_SECRET before using the dashboard."
                : "Dashboard mutations are disabled. Set REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS=1 and REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING=1 for local beta provisioning."}
            {mutationStatus.reason === "signed_out" ? (
              <>
                {" "}
                <a
                  className="text-cyan-100 underline decoration-cyan-300/50 underline-offset-4"
                  href="/api/auth/signin"
                >
                  Sign in
                </a>
              </>
            ) : null}
          </p>
        </div>
      </Card>
    );
  }

  return null;
}

function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function dashboardNoticeText(notice: string, repository: string): string {
  switch (notice) {
    case "sync_requested":
      return "Repository sync was queued. Run the worker or wait for the worker to process the outbox.";
    case "sync_already_requested":
      return "Repository sync was already queued for this installation recently.";
    case "setup_pr_ready":
      return repository
        ? `Setup PR is ready for ${repository}.`
        : "Setup PR is ready.";
    case "workflow_already_current":
      return repository
        ? `ReviewRouter workflow is already current for ${repository}.`
        : "ReviewRouter workflow is already current.";
    case "review_config_saved":
      return "Review configuration was saved. Future action runs can fetch it through OIDC.";
    case "repository_review_config_saved":
      return repository
        ? `Repository review configuration was saved for ${repository}.`
        : "Repository review configuration was saved.";
    case "repository_review_config_cleared":
      return repository
        ? `${repository} now inherits the workspace review configuration.`
        : "Repository override was cleared.";
    case "outbox_retry_queued":
      return "Failed background event was queued for retry. Run the worker or wait for it to process.";
    case "outbox_retry_not_found":
      return "Failed background event was not found for this workspace.";
    case "outbox_retry_not_dead_letter":
      return "Background event is no longer in dead-letter state and was not manually retried.";
    default:
      return "Dashboard action completed.";
  }
}

function workflowSetupAlreadyCurrent(status: string | undefined): boolean {
  return [
    "healthy",
    "provider_needs_setup",
    "provider_unhealthy",
    "provider_report_stale",
  ].includes(status ?? "");
}

function dashboardErrorText(error: string): string {
  switch (error) {
    case "dashboard_mutations_disabled":
      return "Dashboard mutations are disabled on this environment.";
    case "dashboard_auth_misconfigured":
      return "GitHub OAuth is not configured. Set AUTH_SECRET, GITHUB_APP_CLIENT_ID, and GITHUB_APP_CLIENT_SECRET.";
    case "dashboard_mutation_requires_sign_in":
      return "Sign in with GitHub before changing repository setup.";
    case "workspace_mutation_forbidden":
      return "Your GitHub user is not an owner/admin for this workspace.";
    case "operation_already_running":
      return "Another setup or sync operation is already running. Try again shortly.";
    case "rate_limited":
      return "Too many dashboard requests for this resource. Wait a bit before retrying.";
    case "invalid_form":
      return "The submitted form is invalid. Refresh the dashboard and try again.";
    case "server_misconfigured":
      return "Server setup is incomplete. Check GitHub App credentials and the public ReviewRouter API URL.";
    case "repository_not_selected":
      return "This repository is no longer selected for the GitHub App installation.";
    case "repository_archived":
      return "Archived repositories cannot be provisioned.";
    case "installation_not_active":
      return "The GitHub App installation is not active.";
    case "entitlement_denied":
      return "This workspace plan does not allow that action. Check the plan status or feature flags.";
    case "workflow_provisioning_disabled":
      return "Workflow provisioning is disabled. Set REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING=1 in a trusted local or beta environment.";
    default:
      return "GitHub operation failed. Check audit events or server logs for the safe error code.";
  }
}
