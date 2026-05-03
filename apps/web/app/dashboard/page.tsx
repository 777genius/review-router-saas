import { Badge, Button, Card } from "@reviewrouter/ui";
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
import { safeGitHubDashboardLink } from "../../src/server/safe-dashboard-link";

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

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-10">
      <section className="space-y-3">
        <Badge tone="accent">Dashboard</Badge>
        <h1 className="text-4xl font-semibold tracking-tight text-cyan-50 md:text-6xl">
          Connected repositories
        </h1>
        <p className="max-w-3xl text-base leading-7 text-slate-300">
          Repository sync is App-driven. The dashboard reads normalized
          installation and repository metadata, not code, diffs, PR bodies, or
          commit messages.
        </p>
      </section>

      <DashboardNotice params={params} mutationStatus={mutationStatus} />

      <section className="grid gap-5">
        {workspaces.length === 0 ? (
          <Card className="space-y-3">
            <Badge tone="warning">No workspace yet</Badge>
            <p className="text-sm leading-6 text-slate-300">
              Sign in with GitHub and install the ReviewRouter App to create a
              workspace and start syncing repositories.
            </p>
            <div className="flex flex-wrap gap-3">
              {!mutationStatus.signedIn ? (
                <a
                  href="/api/auth/signin"
                  className="inline-flex h-9 items-center justify-center rounded-lg border border-cyan-300/50 bg-cyan-300 px-3 text-sm font-medium text-slate-950 shadow-[var(--rr-shadow-glow-cyan)] transition hover:bg-cyan-200"
                >
                  Sign in with GitHub
                </a>
              ) : null}
              {appInstallUrl ? (
                <a
                  href={appInstallUrl}
                  className="inline-flex h-9 items-center justify-center rounded-lg border border-cyan-200/30 bg-cyan-300/10 px-3 text-sm font-medium text-cyan-50 transition hover:bg-cyan-300/15"
                >
                  Install GitHub App
                </a>
              ) : (
                <span className="text-xs leading-5 text-slate-400">
                  Set GITHUB_APP_SLUG to show the local App install link.
                </span>
              )}
            </div>
          </Card>
        ) : (
          workspaces.map((workspace) => (
            <WorkspaceCard
              key={workspace.workspace.id}
              data={workspace}
              mutationsEnabled={mutationStatus.enabled}
            />
          ))
        )}
      </section>
    </main>
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
        organizationLogin:
          primaryInstallation?.accountType === "Organization"
            ? primaryInstallation.accountLogin
            : null,
      })
    : null;

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

      {supportDiagnostics ? (
        <div className="rounded-xl border border-magenta-300/20 bg-fuchsia-400/10 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge tone="accent">Support diagnostics</Badge>
            <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
              metadata only / no code, diffs, prompts, or secrets
            </span>
          </div>
          <div className="grid gap-3 text-sm md:grid-cols-4">
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
                    <span className="block text-cyan-100">
                      {repositoryHealth?.status ?? "unknown"}
                    </span>
                    <span className="text-xs text-slate-400">
                      {repositoryHealth?.summary ?? "No health data"}
                    </span>
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
}: {
  readonly params: Record<string, string | string[] | undefined>;
  readonly mutationStatus: Awaited<
    ReturnType<typeof getDashboardMutationStatus>
  >;
}): React.ReactElement | null {
  const notice = readParam(params.notice);
  const error = readParam(params.error);
  if (notice) {
    const pullRequestUrl = safeGitHubDashboardLink(readParam(params.pr));
    return (
      <Card className="border-lime-300/25 bg-lime-300/10">
        <Badge tone="success">Done</Badge>
        <p className="mt-3 text-sm leading-6 text-lime-50">
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
      </Card>
    );
  }
  if (error) {
    return (
      <Card className="border-red-300/25 bg-red-300/10">
        <Badge tone="danger">Action failed</Badge>
        <p className="mt-3 text-sm leading-6 text-red-50">
          {dashboardErrorText(error)}
        </p>
      </Card>
    );
  }
  if (!mutationStatus.enabled) {
    return (
      <Card className="border-amber-300/25 bg-amber-300/10">
        <Badge tone="warning">Read-only dashboard</Badge>
        <p className="mt-3 text-sm leading-6 text-amber-50">
          {mutationStatus.reason === "signed_out"
            ? "Sign in with GitHub to request repository syncs or setup PRs."
            : mutationStatus.reason === "auth_misconfigured"
              ? "GitHub OAuth is not configured. Set AUTH_SECRET, GITHUB_APP_CLIENT_ID, and GITHUB_APP_CLIENT_SECRET before using the dashboard."
              : "Dashboard mutations are disabled. Set REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS=1 for local beta provisioning."}
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
    default:
      return "GitHub operation failed. Check audit events or server logs for the safe error code.";
  }
}
