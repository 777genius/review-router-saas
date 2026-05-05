import { redirect } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  LinkButton,
  SelectField,
} from "@reviewrouter/ui";
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
import { FormSubmitButton } from "../form-submit-button";
import {
  GitHubSignInButton,
  GitHubSignInInlineButton,
} from "../github-sign-in-button";
import { LogoMark } from "../logo-mark";
import { RepositoryVisibilityBadge } from "../repository-visibility-badge";

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

  const dashboardData = await Promise.all(
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

  return dashboardData.sort(compareDashboardWorkspaces);
}

type SortableDashboardWorkspace = {
  readonly repositoryCount: number;
  readonly workspace: {
    readonly name: string;
    readonly installations: readonly { readonly status: string }[];
  };
};

function compareDashboardWorkspaces(
  left: SortableDashboardWorkspace,
  right: SortableDashboardWorkspace,
): number {
  const leftScore = workspaceSortScore(left);
  const rightScore = workspaceSortScore(right);
  if (leftScore !== rightScore) return rightScore - leftScore;
  return left.workspace.name.localeCompare(right.workspace.name);
}

function workspaceSortScore(data: SortableDashboardWorkspace): number {
  const activeInstallations = data.workspace.installations.filter(
    (installation) => installation.status === "active",
  ).length;
  return data.repositoryCount * 100 + activeInstallations * 10;
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

function summarizeDashboardWorkspaces(
  workspaces: readonly DashboardWorkspaceData[],
): { readonly needsSetup: number } {
  return workspaces.reduce(
    (summary, workspace) => {
      const workspaceHealth = summarizeWorkspaceHealth(
        workspace.health.map((repositoryHealth) => repositoryHealth.status),
      );

      return {
        needsSetup: summary.needsSetup + workspaceHealth.needsSetup,
      };
    },
    { needsSetup: 0 },
  );
}

function filterVisibleDashboardWorkspaces(
  workspaces: readonly DashboardWorkspaceData[],
): readonly DashboardWorkspaceData[] {
  const actionableWorkspaces = workspaces.filter(
    (workspace) =>
      workspace.repositoryCount > 0 ||
      workspace.workspace.installations.length > 0,
  );

  return actionableWorkspaces.length > 0 ? actionableWorkspaces : workspaces;
}

function selectDashboardWorkspace(
  workspaces: readonly DashboardWorkspaceData[],
  workspaceParam: string,
): DashboardWorkspaceData {
  if (!workspaceParam) return workspaces[0]!;

  const normalized = normalizeWorkspaceKey(workspaceParam);
  return (
    workspaces.find((workspace) =>
      dashboardWorkspaceKeys(workspace.workspace).includes(normalized),
    ) ?? workspaces[0]!
  );
}

function dashboardWorkspaceKeys(workspace: DashboardWorkspace): string[] {
  return [
    workspace.id,
    workspace.slug,
    workspace.name,
    ...workspace.installations.map((installation) => installation.accountLogin),
  ]
    .filter(Boolean)
    .map(normalizeWorkspaceKey);
}

function dashboardWorkspaceUrlKey(
  workspace: DashboardWorkspace,
  allWorkspaces?: readonly DashboardWorkspaceData[],
): string {
  const preferredKey = dashboardWorkspacePreferredUrlKey(workspace);
  if (!allWorkspaces) return preferredKey;

  const preferredKeyCollision = allWorkspaces.some(
    (item) =>
      item.workspace.id !== workspace.id &&
      normalizeWorkspaceKey(
        dashboardWorkspacePreferredUrlKey(item.workspace),
      ) === normalizeWorkspaceKey(preferredKey),
  );
  const preferredKeyNamesWorkspace =
    normalizeWorkspaceKey(workspace.name) ===
    normalizeWorkspaceKey(preferredKey);

  if (!preferredKeyCollision || preferredKeyNamesWorkspace) {
    return preferredKey;
  }

  return workspace.slug || workspace.id;
}

function dashboardWorkspacePreferredUrlKey(
  workspace: DashboardWorkspace,
): string {
  return (
    workspace.installations[0]?.accountLogin || workspace.slug || workspace.id
  );
}

function normalizeWorkspaceKey(value: string): string {
  return value.trim().toLowerCase();
}

type DashboardPageProps = {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
};

type DashboardSection = "repositories" | "setup" | "policy" | "diagnostics";

export default async function DashboardPage({
  searchParams,
}: DashboardPageProps): Promise<React.ReactElement> {
  const params = searchParams ? await searchParams : {};
  const [mutationStatus, workspaceScope] = await Promise.all([
    getDashboardMutationStatus(),
    getDashboardWorkspaceScope(),
  ]);
  const appSetupNotice = buildGitHubAppSetupNotice({
    installationId: readParam(params.installation_id),
    setupAction: readParam(params.setup_action),
    signedIn: mutationStatus.signedIn,
  });
  if (appSetupNotice) {
    redirect(`/setup?${setupQueryString(params)}`);
  }

  const supportAudit =
    workspaceScope.kind === "all" &&
    workspaceScope.reason === "local_admin_override" &&
    mutationStatus.githubLogin
      ? {
          actor: `support:${mutationStatus.githubLogin}`,
          reason: "local_admin_override" as const,
        }
      : undefined;
  const workspaces = filterVisibleDashboardWorkspaces(
    await loadDashboardData(workspaceScope, supportAudit),
  );
  const appInstallUrl = getGitHubAppInstallUrl();
  const dashboardSignInCallbackUrl = buildDashboardSignInCallbackUrl(params);
  const selectedSection = resolveDashboardSection(params);

  if (workspaces.length === 0) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6 md:py-16">
        <DashboardNotice
          params={params}
          mutationStatus={mutationStatus}
          showReadOnlyHint={false}
          appSetupNotice={appSetupNotice}
          signInCallbackUrl={dashboardSignInCallbackUrl}
        />
        <OnboardingDashboard
          appSetupActive={Boolean(appSetupNotice)}
          appInstallUrl={appInstallUrl}
          signedIn={mutationStatus.signedIn}
          signInCallbackUrl={dashboardSignInCallbackUrl}
        />
      </main>
    );
  }

  const selectedWorkspace = selectDashboardWorkspace(
    workspaces,
    readParam(params.workspace),
  );
  const selectedWorkspaceKey = dashboardWorkspaceUrlKey(
    selectedWorkspace.workspace,
    workspaces,
  );
  const dashboardSummary = summarizeDashboardWorkspaces([selectedWorkspace]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 md:py-12">
      <section className="rounded-[2rem] border border-cyan-300/[0.12] bg-[#0a0a0f]/75 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.42),0_0_90px_-54px_rgba(0,240,255,0.9)] backdrop-blur-2xl sm:p-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="min-w-0 space-y-4">
            <div className="flex items-center gap-3">
              <LogoMark size="sm" />
              <Badge tone="accent">Dashboard</Badge>
            </div>
            <div className="space-y-3">
              <h1 className="max-w-3xl break-words text-4xl font-extrabold leading-[1.05] tracking-[-0.04em] text-cyan-50 md:text-6xl">
                Connected repositories
              </h1>
              <p className="max-w-2xl text-base leading-7 text-[#a0a8c0]">
                Pick a repository, create the setup PR, then seed provider
                secrets directly into GitHub Actions. Advanced policy and
                diagnostics stay collapsed until you need them.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3 lg:justify-end">
            <LinkButton
              href={dashboardSectionHref("repositories", selectedWorkspaceKey)}
              size="lg"
              className="min-w-44"
            >
              {dashboardSummary.needsSetup > 0
                ? "Create setup PR"
                : "Review repositories"}
            </LinkButton>
            {appInstallUrl ? (
              <LinkButton
                href={appInstallUrl}
                variant="outline"
                size="md"
                className="min-w-44"
              >
                Add repositories
              </LinkButton>
            ) : null}
            <LinkButton href="/setup" variant="ghost" size="md">
              Setup flow
            </LinkButton>
          </div>
        </div>
      </section>

      <WorkspaceSwitcher
        workspaces={workspaces}
        selectedWorkspaceId={selectedWorkspace.workspace.id}
        selectedSection={selectedSection}
      />

      <section id="dashboard-workspace" className="grid gap-5 scroll-mt-28">
        <WorkspaceCard
          data={selectedWorkspace}
          mutationsEnabled={mutationStatus.enabled}
          selectedSection={selectedSection}
          params={params}
          workspaceKey={selectedWorkspaceKey}
        />
      </section>
    </main>
  );
}

function OnboardingDashboard({
  appSetupActive,
  appInstallUrl,
  signedIn,
  signInCallbackUrl,
}: {
  readonly appSetupActive: boolean;
  readonly appInstallUrl: string | null;
  readonly signedIn: boolean;
  readonly signInCallbackUrl: string;
}): React.ReactElement {
  const primaryAction =
    appSetupActive && !signedIn
      ? { kind: "sign-in" as const, label: "Sign in to finish setup" }
      : appInstallUrl
        ? {
            kind: "link" as const,
            href: appInstallUrl,
            label: "Install GitHub App",
          }
        : { kind: "sign-in" as const, label: "Sign in with GitHub" };
  const secondaryAction =
    appSetupActive || signedIn
      ? {
          kind: "link" as const,
          href: "/getting-started",
          label: "Setup guide",
        }
      : { kind: "sign-in" as const, label: "Sign in" };
  const onboardingSteps = appSetupActive
    ? signedIn
      ? [
          [
            "1",
            "Sync repositories",
            "Import the selected repositories from the App installation.",
          ],
          [
            "2",
            "Create setup PR",
            "ReviewRouter opens a workflow PR in the selected repo.",
          ],
          [
            "3",
            "Seed provider",
            "Codex or API keys stay in GitHub Actions secrets.",
          ],
        ]
      : [
          ["1", "Sign in", "Authorize dashboard access for this GitHub user."],
          [
            "2",
            "Sync repositories",
            "ReviewRouter maps the installation to your workspace.",
          ],
          [
            "3",
            "Create setup PR",
            "Seed provider secrets directly in GitHub Actions.",
          ],
        ]
    : [
        ["1", "Install App", "Choose only the repositories to review."],
        ["2", "Create setup PR", "ReviewRouter opens a workflow PR."],
        ["3", "Seed provider", "Codex or API keys stay in GitHub."],
      ];

  return (
    <section className="grid min-h-[72vh] items-center">
      <div className="relative overflow-hidden rounded-[2.75rem]">
        <div className="absolute -inset-6 rounded-[2.5rem] bg-[radial-gradient(circle_at_20%_20%,rgba(0,240,255,0.18),transparent_34%),radial-gradient(circle_at_80%_30%,rgba(255,0,255,0.16),transparent_30%),radial-gradient(circle_at_50%_90%,rgba(57,255,20,0.08),transparent_32%)] blur-2xl" />
        <Card className="relative min-w-0 overflow-hidden rounded-[2rem] border-cyan-300/[0.16] bg-[#0a0a0f]/90 p-6 shadow-[0_30px_90px_rgba(0,0,0,0.55),0_0_80px_-40px_rgba(0,240,255,0.85)] sm:p-10">
          <div className="absolute right-0 top-0 h-56 w-56 rounded-full bg-cyan-300/10 blur-3xl" />
          <div className="relative mx-auto grid max-w-3xl justify-items-center gap-8 text-center">
            <div className="grid justify-items-center gap-4">
              <LogoMark size="lg" />
              <Badge tone="accent">
                {appSetupActive ? "Finish setup" : "GitHub setup"}
              </Badge>
            </div>

            <div className="space-y-5">
              <h1 className="max-w-full bg-[image:var(--rr-gradient-brand)] bg-clip-text text-3xl font-extrabold leading-[1.08] tracking-[-0.035em] text-transparent [overflow-wrap:anywhere] sm:text-5xl sm:tracking-[-0.045em] md:text-7xl">
                {appSetupActive
                  ? "Finish ReviewRouter setup."
                  : "Connect ReviewRouter."}
              </h1>
              <p className="mx-auto max-w-full text-base leading-7 text-[#a0a8c0] [overflow-wrap:anywhere] sm:max-w-2xl sm:text-lg sm:leading-8">
                {appSetupActive
                  ? "The GitHub App install returned successfully. Sign in to map the installation to your workspace, then create the setup PR."
                  : "Install the GitHub App on selected repositories. ReviewRouter will sync metadata, create the setup PR, and keep provider secrets inside GitHub Actions."}
              </p>
            </div>

            <div className="grid w-full max-w-xl gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
              <OnboardingActionButton
                action={primaryAction}
                callbackUrl={signInCallbackUrl}
                className="h-16 w-full rounded-2xl px-8 text-lg font-semibold"
              />
              <OnboardingActionButton
                action={secondaryAction}
                callbackUrl={signInCallbackUrl}
                variant="outline"
                className="h-16 w-full rounded-2xl px-8"
              />
            </div>

            <div className="grid w-full gap-3 text-left sm:grid-cols-3">
              {onboardingSteps.map(([step, title, body]) => (
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

type OnboardingAction =
  | {
      readonly kind: "link";
      readonly href: string;
      readonly label: string;
    }
  | {
      readonly kind: "sign-in";
      readonly label: string;
    };

function OnboardingActionButton({
  action,
  callbackUrl,
  className,
  variant,
}: {
  readonly action: OnboardingAction;
  readonly callbackUrl: string;
  readonly className: string;
  readonly variant?: "outline";
}): React.ReactElement {
  if (action.kind === "sign-in") {
    return (
      <GitHubSignInButton
        callbackUrl={callbackUrl}
        size="lg"
        variant={variant}
        className={className}
      >
        {action.label}
      </GitHubSignInButton>
    );
  }

  return (
    <LinkButton
      href={action.href}
      size="lg"
      variant={variant}
      className={className}
    >
      {action.label}
    </LinkButton>
  );
}

function WorkspaceSwitcher({
  workspaces,
  selectedWorkspaceId,
  selectedSection,
}: {
  readonly workspaces: readonly DashboardWorkspaceData[];
  readonly selectedWorkspaceId: string;
  readonly selectedSection: DashboardSection;
}): React.ReactElement | null {
  if (workspaces.length < 2) return null;

  return (
    <Card className="rounded-2xl p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
          Account
        </span>
        {workspaces.map((workspace) => {
          const workspaceKey = dashboardWorkspaceUrlKey(
            workspace.workspace,
            workspaces,
          );
          const active = workspace.workspace.id === selectedWorkspaceId;
          return (
            <a
              key={workspace.workspace.id}
              href={dashboardSectionHref(selectedSection, workspaceKey)}
              aria-current={active ? "page" : undefined}
              className={[
                "inline-flex min-h-11 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition",
                active
                  ? "border-cyan-300/45 bg-cyan-300/10 text-cyan-50"
                  : "border-cyan-200/10 bg-white/[0.03] text-slate-300 hover:border-cyan-300/25 hover:bg-cyan-300/[0.06]",
              ].join(" ")}
            >
              <span>{workspace.workspace.name}</span>
              <span className="font-mono text-xs text-slate-500">
                {workspace.repositoryCount} repos
              </span>
            </a>
          );
        })}
      </div>
    </Card>
  );
}

function DashboardSectionNav({
  workspace,
  repositoryCount,
  entitlement,
  workspaceHealth,
  selectedSection,
  workspaceKey,
}: {
  readonly workspace: DashboardWorkspace;
  readonly repositoryCount: number;
  readonly entitlement: DashboardWorkspaceData["entitlement"];
  readonly workspaceHealth: ReturnType<typeof summarizeWorkspaceHealth>;
  readonly selectedSection: DashboardSection;
  readonly workspaceKey: string;
}): React.ReactElement {
  const items: readonly {
    readonly section: DashboardSection;
    readonly label: string;
    readonly description: string;
  }[] = [
    {
      section: "repositories",
      label: "Repositories",
      description: "Setup PRs and health",
    },
    {
      section: "setup",
      label: "Setup",
      description: "App sync and secrets",
    },
    {
      section: "policy",
      label: "Policy",
      description: "Provider, model, gates",
    },
    {
      section: "diagnostics",
      label: "Diagnostics",
      description: "Queue, audit, support",
    },
  ];

  return (
    <aside className="border-b border-cyan-200/10 bg-slate-950/45 p-5 lg:border-b-0 lg:border-r lg:p-6">
      <div className="lg:sticky lg:top-24">
        <p className="truncate text-lg font-semibold text-cyan-50">
          {workspace.name}
        </p>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          {workspaceInstallSummary(workspace)}
        </p>
        <div className="mt-4 grid gap-2">
          <Badge tone="success">{repositoryCount} repos</Badge>
          <Badge tone={workspaceHealth.tone}>{workspaceHealth.label}</Badge>
          <Badge tone="accent">
            {entitlement.plan.replace("_", " ")} / {entitlement.status}
          </Badge>
        </div>
        <nav className="mt-6 grid gap-2" aria-label="Dashboard sections">
          {items.map((item) => {
            const active = selectedSection === item.section;
            return (
              <a
                key={item.section}
                href={dashboardSectionHref(item.section, workspaceKey)}
                aria-current={active ? "page" : undefined}
                className={[
                  "rounded-2xl border p-3 transition",
                  active
                    ? "border-cyan-300/35 bg-cyan-300/10 text-cyan-50 shadow-[0_0_34px_-24px_rgba(0,240,255,0.9)]"
                    : "border-cyan-200/10 bg-white/[0.03] text-slate-300 hover:border-cyan-300/25 hover:bg-cyan-300/[0.06]",
                ].join(" ")}
              >
                <span className="block font-mono text-xs font-semibold uppercase tracking-[0.16em]">
                  {item.label}
                </span>
                <span className="mt-1 block text-xs leading-5 text-slate-400">
                  {item.description}
                </span>
              </a>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}

function WorkspaceCard({
  data,
  mutationsEnabled,
  selectedSection,
  params,
  workspaceKey,
}: {
  readonly data: DashboardWorkspaceData;
  readonly mutationsEnabled: boolean;
  readonly selectedSection: DashboardSection;
  readonly params: Record<string, string | string[] | undefined>;
  readonly workspaceKey: string;
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
  const requestedRepositoryFullName = readParam(params.repository);
  const requestedRepository = requestedRepositoryFullName
    ? repositories.find(
        (repository) => repository.fullName === requestedRepositoryFullName,
      )
    : undefined;
  const primaryRepository =
    requestedRepository ??
    repositories.find((repository) => repository.selected) ??
    repositories[0];
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
    <Card className="overflow-hidden p-0">
      <div className="grid lg:grid-cols-[16rem_minmax(0,1fr)]">
        <DashboardSectionNav
          workspace={workspace}
          repositoryCount={repositoryCount}
          entitlement={entitlement}
          workspaceHealth={workspaceHealth}
          selectedSection={selectedSection}
          workspaceKey={workspaceKey}
        />
        <div
          id="dashboard-section-content"
          className="space-y-5 scroll-mt-28 p-5 sm:p-6"
        >
          <WorkspaceActionNotice params={params} />

          {selectedSection === "repositories" ? (
            <>
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <div className="rounded-2xl border border-cyan-200/10 bg-cyan-300/5 p-4">
                  <Badge tone={workspaceHealth.tone}>
                    {workspaceHealth.label}
                  </Badge>
                  <p className="mt-3 text-sm leading-6 text-slate-300">
                    {workspaceHealth.ready} ready / {workspaceHealth.needsSetup}{" "}
                    need setup / {workspaceHealth.needsAttention} need
                    attention. Start by creating a setup PR for one selected
                    repository.
                  </p>
                </div>
                {appInstallUrlForWorkspace(primaryInstallation) ? (
                  <LinkButton
                    href={appInstallUrlForWorkspace(primaryInstallation) ?? "#"}
                    variant="outline"
                    className="md:justify-self-end"
                  >
                    Manage App access
                  </LinkButton>
                ) : null}
              </div>

              <RepositoryTable
                workspace={workspace}
                repositoryCount={repositoryCount}
                repositories={repositories}
                health={health}
                provisioning={provisioning}
                mutationsEnabled={mutationsEnabled}
              />
            </>
          ) : null}

          {selectedSection === "setup" ? (
            <>
              <details
                open
                className="rounded-xl border border-cyan-200/10 bg-cyan-300/5 p-4"
              >
                <summary className="cursor-pointer list-none">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <Badge tone="accent">GitHub App connection</Badge>
                      <p className="mt-2 text-sm text-slate-400">
                        Installation sync and repository selection.
                      </p>
                    </div>
                    <span className="font-mono text-xs uppercase tracking-[0.16em] text-cyan-100">
                      {workspace.installations.length} connected
                    </span>
                  </div>
                </summary>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
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
                          {formatAccountTypeLabel(installation.accountType)} /{" "}
                          {installation.status} /{" "}
                          {installation.repositorySelection}
                        </p>
                      </div>
                      <form action={requestInstallationSyncAction}>
                        <input
                          type="hidden"
                          name="workspaceId"
                          value={workspace.id}
                        />
                        <input
                          type="hidden"
                          name="githubInstallationId"
                          value={installation.githubInstallationId}
                        />
                        <Button
                          type="submit"
                          variant="outline"
                          size="sm"
                          disabled={
                            !mutationsEnabled ||
                            installation.status !== "active"
                          }
                        >
                          Sync repos
                        </Button>
                      </form>
                    </div>
                  ))}
                </div>
              </details>

              {providerGuidance ? (
                <details
                  open
                  className="rounded-xl border border-emerald-300/20 bg-emerald-300/10 p-4"
                >
                  <summary className="cursor-pointer list-none">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <Badge tone="success">
                          {providerSetupTitle(providerGuidance.provider)}
                        </Badge>
                        <p className="mt-2 text-sm leading-6 text-emerald-50">
                          Credentials stay in GitHub Actions secrets. Open this
                          when you are ready to seed the selected provider.
                        </p>
                      </div>
                      <span className="max-w-full break-words font-mono text-xs uppercase tracking-[0.16em] text-emerald-100">
                        {providerGuidance.recommendedScope.replaceAll("_", " ")}
                      </span>
                    </div>
                  </summary>
                  <div className="mt-4">
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
                          <CodeBlock
                            code={command.command}
                            className="mt-3 rounded-md p-3 text-xs leading-5"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </details>
              ) : null}
            </>
          ) : null}

          {selectedSection === "policy" ? (
            <details
              open
              className="rounded-xl border border-cyan-200/10 bg-cyan-300/5 p-4"
            >
              <summary className="cursor-pointer list-none">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <Badge tone="accent">Review policy</Badge>
                    <p className="mt-2 text-sm text-slate-400">
                      Workspace defaults and optional per-repository overrides.
                    </p>
                  </div>
                  <span className="font-mono text-xs uppercase tracking-[0.16em] text-slate-400">
                    v{activeConfigVersion}
                  </span>
                </div>
              </summary>
              <div className="mt-4">
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <Badge tone="accent">Workspace default</Badge>
                  <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
                    v{activeConfigVersion}
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
                <div className="mt-4 rounded-xl border border-cyan-200/10 bg-slate-950/60 p-4">
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
                      const effectiveConfig =
                        repositoryConfig?.config ?? activeConfig;
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
                              <Badge
                                tone={repositoryConfig ? "warning" : "success"}
                              >
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
                                repositoryConfig
                                  ? "Update override"
                                  : "Save override"
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
            </details>
          ) : null}

          {selectedSection === "repositories" &&
          repositories.some(
            (repository) => repository.visibility === "public",
          ) ? (
            <div className="rounded-xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm leading-6 text-amber-100">
              Public repository warning: fork pull requests are skipped by
              default for secret-backed providers. Maintainers can add a trusted
              rerun flow later, but v1 keeps provider secrets out of untrusted
              fork code paths.
            </div>
          ) : null}

          {selectedSection === "diagnostics" ? (
            <>
              <div className="rounded-xl border border-cyan-200/10 bg-slate-950/60 p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Badge tone={workspaceHealth.tone}>Readiness</Badge>
                  <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
                    {workspaceHealth.ready} ready / {workspaceHealth.needsSetup}{" "}
                    setup / {workspaceHealth.needsAttention} attention /{" "}
                    {workspaceHealth.unknown} unknown
                  </span>
                </div>
                <p className="text-sm leading-6 text-slate-300">
                  This is metadata-only repository health. It does not include
                  code, diffs, prompts, or provider output.
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
                      {supportDiagnostics.recentAuditActions
                        .slice(0, 4)
                        .join(", ")}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="rounded-xl border border-cyan-200/10 bg-slate-950/60 p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Badge
                    tone={outboxFailures.length > 0 ? "warning" : "success"}
                  >
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
                            {event.lastErrorCode
                              ? ` - ${event.lastErrorCode}`
                              : ""}
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
                        <form
                          action={retryOutboxEventAction}
                          className="self-center"
                        >
                          <input
                            type="hidden"
                            name="workspaceId"
                            value={workspace.id}
                          />
                          <input
                            type="hidden"
                            name="eventId"
                            value={event.id}
                          />
                          <Button
                            type="submit"
                            variant="outline"
                            size="sm"
                            disabled={
                              !mutationsEnabled ||
                              event.status !== "dead_letter"
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
            </>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function RepositoryTable({
  workspace,
  repositoryCount,
  repositories,
  health,
  provisioning,
  mutationsEnabled,
}: {
  readonly workspace: DashboardWorkspace;
  readonly repositoryCount: number;
  readonly repositories: DashboardWorkspaceData["repositories"];
  readonly health: DashboardWorkspaceData["health"];
  readonly provisioning: DashboardWorkspaceData["provisioning"];
  readonly mutationsEnabled: boolean;
}): React.ReactElement {
  if (repositories.length === 0) {
    return (
      <div className="rounded-2xl border border-cyan-200/10 bg-slate-950/60 p-5">
        <Badge tone="warning">No repositories yet</Badge>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          GitHub has not delivered selected repositories to ReviewRouter yet.
          Use sync after the installation webhook arrives, or update App access
          if no repositories were selected.
        </p>
      </div>
    );
  }

  const rows = repositories.map((repository) => {
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

    return {
      repository,
      repositoryHealth,
      repositoryProvisioning,
      healthView,
      setupPullRequestUrl,
      workflowCurrent,
    };
  });

  const primaryInstallation = workspace.installations[0];
  const setupSearchHref = primaryInstallation
    ? `/setup?installation_id=${primaryInstallation.githubInstallationId}&setup_action=install#sync-repositories`
    : "/setup";
  const hiddenRepositoryCount = Math.max(
    repositoryCount - repositories.length,
    0,
  );

  return (
    <div className="overflow-hidden rounded-2xl border border-cyan-200/10 bg-slate-950/55">
      <div className="grid gap-3 border-b border-cyan-200/10 p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <Badge tone="accent">Repositories</Badge>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Showing {repositories.length} of {repositoryCount} synced
            repositories here for quick setup and health.{" "}
            {hiddenRepositoryCount > 0
              ? `${hiddenRepositoryCount} more are available in the setup search.`
              : "Policy and diagnostics are below."}
          </p>
        </div>
        <LinkButton href={setupSearchHref} variant="outline" size="sm">
          Search all repos
        </LinkButton>
      </div>
      <div className="grid gap-3 p-3 lg:hidden">
        {rows.map(
          ({
            repository,
            repositoryHealth,
            repositoryProvisioning,
            healthView,
            setupPullRequestUrl,
            workflowCurrent,
          }) => (
            <div
              key={repository.id}
              className={[
                "grid gap-4 rounded-2xl border border-cyan-200/10 bg-slate-950/70 p-4",
                repository.selected ? "" : "opacity-50",
              ].join(" ")}
            >
              <div className="min-w-0">
                <p className="break-words font-medium text-cyan-50">
                  {repository.fullName}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <RepositoryVisibilityBadge
                    visibility={repository.visibility}
                  />
                  <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 font-mono text-xs text-slate-300">
                    {repository.defaultBranch}
                  </span>
                  {repository.archived ? (
                    <Badge tone="warning">Archived</Badge>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-3 rounded-xl border border-cyan-200/10 bg-cyan-300/5 p-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">
                    Setup
                  </p>
                  <p className="mt-1 text-sm text-slate-200">
                    {repository.setupStatus.replaceAll("_", " ")}
                  </p>
                  {setupPullRequestUrl ? (
                    <a
                      className="mt-1 inline-flex text-xs font-semibold text-cyan-100 underline decoration-cyan-300/50 underline-offset-4"
                      href={setupPullRequestUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open setup PR
                    </a>
                  ) : null}
                  {repositoryProvisioning?.errorMessage ? (
                    <span className="mt-1 block text-xs text-red-200">
                      {repositoryProvisioning.errorMessage.slice(0, 120)}
                    </span>
                  ) : null}
                </div>

                <div>
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">
                    Health
                  </p>
                  <div className="mt-2">
                    <Badge tone={healthView.tone}>{healthView.label}</Badge>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-slate-300">
                    {healthView.summary}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    Next: {healthView.nextAction}
                  </p>
                  {repositoryHealth?.latestActionHealthTelemetry ? (
                    <p className="mt-1 text-[11px] leading-5 text-cyan-100/80">
                      Latest run:{" "}
                      {formatActionHealthTelemetry(
                        repositoryHealth.latestActionHealthTelemetry,
                      )}
                    </p>
                  ) : null}
                </div>
              </div>

              <RepositorySetupActionForm
                workspaceId={workspace.id}
                repositoryId={repository.id}
                selected={repository.selected}
                archived={repository.archived}
                setupStatus={repository.setupStatus}
                workflowCurrent={workflowCurrent}
                mutationsEnabled={mutationsEnabled}
              />
            </div>
          ),
        )}
      </div>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="bg-cyan-300/10 text-xs uppercase tracking-[0.16em] text-cyan-100">
            <tr>
              <th className="px-4 py-3">Repository</th>
              <th className="px-4 py-3">Setup</th>
              <th className="px-4 py-3">Health</th>
              <th className="px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cyan-200/10 text-slate-200">
            {rows.map(
              ({
                repository,
                repositoryHealth,
                repositoryProvisioning,
                healthView,
                setupPullRequestUrl,
                workflowCurrent,
              }) => {
                return (
                  <tr
                    key={repository.id}
                    className={repository.selected ? "" : "opacity-50"}
                  >
                    <td className="px-4 py-4 align-top">
                      <p className="font-medium text-cyan-50">
                        {repository.fullName}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <RepositoryVisibilityBadge
                          visibility={repository.visibility}
                        />
                        <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 font-mono text-xs text-slate-300">
                          {repository.defaultBranch}
                        </span>
                        {repository.archived ? (
                          <Badge tone="warning">Archived</Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-4 align-top">
                      <span className="block text-sm">
                        {repository.setupStatus.replaceAll("_", " ")}
                      </span>
                      {setupPullRequestUrl ? (
                        <a
                          className="mt-1 block text-xs text-cyan-100 underline decoration-cyan-300/50 underline-offset-4"
                          href={setupPullRequestUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open setup PR
                        </a>
                      ) : null}
                      {repositoryProvisioning?.errorMessage ? (
                        <span className="mt-1 block text-xs text-red-200">
                          {repositoryProvisioning.errorMessage.slice(0, 120)}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-4 align-top">
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
                    </td>
                    <td className="px-4 py-4 align-top">
                      <RepositorySetupActionForm
                        workspaceId={workspace.id}
                        repositoryId={repository.id}
                        selected={repository.selected}
                        archived={repository.archived}
                        setupStatus={repository.setupStatus}
                        workflowCurrent={workflowCurrent}
                        mutationsEnabled={mutationsEnabled}
                      />
                    </td>
                  </tr>
                );
              },
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RepositorySetupActionForm({
  workspaceId,
  repositoryId,
  selected,
  archived,
  setupStatus,
  workflowCurrent,
  mutationsEnabled,
}: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly selected: boolean;
  readonly archived: boolean;
  readonly setupStatus: string;
  readonly workflowCurrent: boolean;
  readonly mutationsEnabled: boolean;
}): React.ReactElement {
  return (
    <form action={createSetupPullRequestAction}>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="repositoryId" value={repositoryId} />
      <FormSubmitButton
        variant="soft"
        size="sm"
        disabled={!mutationsEnabled || !selected || archived || workflowCurrent}
        idleLabel={
          workflowCurrent ? "Installed" : setupPrButtonLabel(setupStatus)
        }
        pendingLabel={
          setupStatus === "setup_pr_open"
            ? "Updating setup PR..."
            : "Creating setup PR..."
        }
      />
    </form>
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

function WorkspaceActionNotice({
  params,
}: {
  readonly params: Record<string, string | string[] | undefined>;
}): React.ReactElement | null {
  const notice = readParam(params.notice);
  const error = readParam(params.error);
  if (!notice && !error) return null;

  const pullRequestUrl = safeGitHubDashboardLink(readParam(params.pr));
  const tone = error ? "danger" : "success";
  const title = error ? "Action failed" : dashboardNoticeTitle(notice);
  const body = error
    ? dashboardErrorText(error)
    : dashboardNoticeText(notice, readParam(params.repository));

  return (
    <div
      className={[
        "rounded-2xl border p-4 text-sm leading-6",
        error
          ? "border-red-300/25 bg-red-300/10 text-red-50"
          : "border-lime-300/25 bg-lime-300/10 text-lime-50",
      ].join(" ")}
    >
      <div className="grid gap-3 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center">
        <Badge tone={tone}>{title}</Badge>
        <p>{body}</p>
        {pullRequestUrl ? (
          <LinkButton
            href={pullRequestUrl}
            target="_blank"
            rel="noreferrer"
            size="sm"
          >
            Open pull request
          </LinkButton>
        ) : null}
      </div>
    </div>
  );
}

type DashboardFormAction = (formData: FormData) => void | Promise<void>;

const providerAuthOptions = [
  {
    value: "codex_subscription_oauth",
    label: "Codex OAuth",
    description: "Uses the user's Codex subscription in GitHub Actions.",
  },
  {
    value: "codex_openai_api_key",
    label: "Codex API key",
    description: "Uses OPENAI_API_KEY from GitHub Actions secrets.",
  },
  {
    value: "openrouter_api_key",
    label: "OpenRouter API key",
    description: "Uses OPENROUTER_API_KEY from GitHub Actions secrets.",
  },
] as const;

const reasoningEffortOptions = [
  { value: "low", label: "Low", description: "Faster and cheaper." },
  { value: "medium", label: "Medium", description: "Balanced default." },
  { value: "high", label: "High", description: "Deeper review pass." },
] as const;

const failOnSeverityOptions = [
  { value: "off", label: "Off", description: "Never fail the check." },
  {
    value: "critical",
    label: "Critical",
    description: "Block only critical findings.",
  },
  { value: "major", label: "Major", description: "Block major and critical." },
] as const;

const agenticContextOptions = [
  {
    value: "true",
    label: "Enabled",
    description: "Codex can read related files in read-only sandbox.",
  },
  {
    value: "false",
    label: "Disabled",
    description: "Use supplied diff and deterministic context only.",
  },
] as const;

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
      <SelectField
        name="providerAuthMode"
        label="Provider auth"
        defaultValue={config.provider.authMode}
        disabled={!mutationsEnabled}
        options={providerAuthOptions}
      />
      <label className="space-y-1 text-sm text-slate-300">
        <span>Model</span>
        <input
          name="model"
          defaultValue={config.provider.model}
          disabled={!mutationsEnabled}
          className="w-full rounded-lg border border-cyan-200/15 bg-slate-950 px-3 py-2 text-cyan-50"
        />
      </label>
      <SelectField
        name="reasoningEffort"
        label="Reasoning effort"
        defaultValue={config.provider.reasoningEffort}
        disabled={!mutationsEnabled}
        options={reasoningEffortOptions}
      />
      <SelectField
        name="failOnSeverity"
        label="Fail on severity"
        defaultValue={config.blockingPolicy.failOnSeverity}
        disabled={!mutationsEnabled}
        options={failOnSeverityOptions}
      />
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
      <SelectField
        name="agenticContext"
        label="Agentic context"
        defaultValue={String(config.provider.agenticContext)}
        disabled={!mutationsEnabled}
        options={agenticContextOptions}
      />
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
  appSetupNotice,
  params,
  mutationStatus,
  signInCallbackUrl,
  showReadOnlyHint = true,
}: {
  readonly appSetupNotice?: ReturnType<typeof buildGitHubAppSetupNotice>;
  readonly params: Record<string, string | string[] | undefined>;
  readonly mutationStatus: Awaited<
    ReturnType<typeof getDashboardMutationStatus>
  >;
  readonly signInCallbackUrl: string;
  readonly showReadOnlyHint?: boolean;
}): React.ReactElement | null {
  const notice = readParam(params.notice);
  const error = readParam(params.error);
  if (notice) {
    const pullRequestUrl = safeGitHubDashboardLink(readParam(params.pr));
    return (
      <Card className="rounded-[2rem] border-lime-300/25 bg-lime-300/10 p-6 shadow-[0_18px_58px_rgba(190,255,61,0.08)] sm:p-7">
        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
          <Badge tone="success">{dashboardNoticeTitle(notice)}</Badge>
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
      <Card className="rounded-[2rem] border-lime-300/25 bg-lime-300/10 p-6 shadow-[0_18px_58px_rgba(190,255,61,0.08)] sm:p-7">
        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
          <div className="flex flex-wrap gap-2">
            <Badge tone="success">{appSetupNotice.title}</Badge>
            <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-cyan-100">
              Installation #{appSetupNotice.installationId}
            </span>
          </div>
          <p className="text-sm leading-7 text-lime-50">
            {appSetupNotice.body}
            {!mutationStatus.signedIn ? (
              <>
                {" "}
                <GitHubSignInInlineButton
                  className="text-lime-100 underline decoration-lime-300/50 underline-offset-4"
                  callbackUrl={signInCallbackUrl}
                >
                  Sign in
                </GitHubSignInInlineButton>
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
                <GitHubSignInInlineButton
                  className="text-cyan-100 underline decoration-cyan-300/50 underline-offset-4"
                  callbackUrl={signInCallbackUrl}
                >
                  Sign in
                </GitHubSignInInlineButton>
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

function resolveDashboardSection(
  params: Record<string, string | string[] | undefined>,
): DashboardSection {
  const explicit = readParam(params.section);
  if (isDashboardSection(explicit)) return explicit;

  const notice = readParam(params.notice);
  if (
    [
      "setup_pr_ready",
      "workflow_already_current",
      "sync_requested",
      "sync_already_requested",
    ].includes(notice)
  ) {
    return "setup";
  }
  if (
    [
      "review_config_saved",
      "repository_review_config_saved",
      "repository_review_config_cleared",
    ].includes(notice)
  ) {
    return "policy";
  }
  if (notice.startsWith("outbox_retry_")) return "diagnostics";
  if (readParam(params.error)) return "setup";
  return "repositories";
}

function isDashboardSection(value: string): value is DashboardSection {
  return ["repositories", "setup", "policy", "diagnostics"].includes(value);
}

function dashboardSectionHref(
  section: DashboardSection,
  workspaceKey?: string,
): string {
  const query = new URLSearchParams({ section });
  if (workspaceKey) query.set("workspace", workspaceKey);
  return `/dashboard?${query.toString()}#dashboard-section-content`;
}

function buildDashboardSignInCallbackUrl(
  params: Record<string, string | string[] | undefined>,
): string {
  const callbackParams = new URLSearchParams();
  for (const key of [
    "installation_id",
    "setup_action",
    "notice",
    "error",
    "repository",
    "pr",
    "workspace",
  ]) {
    const value = readParam(params[key]);
    if (value) callbackParams.set(key, value);
  }

  const query = callbackParams.toString();
  const callbackPath = query ? `/dashboard?${query}` : "/dashboard";

  return callbackPath;
}

function setupQueryString(
  params: Record<string, string | string[] | undefined>,
): string {
  const query = new URLSearchParams();
  for (const key of ["installation_id", "setup_action"]) {
    const value = readParam(params[key]);
    if (value) query.set(key, value);
  }
  return query.toString();
}

function dashboardNoticeText(notice: string, repository: string): string {
  switch (notice) {
    case "sync_requested":
      return "Repository sync was queued. Refresh in a few seconds if the repository list does not update immediately.";
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
      return "Failed background event was queued for retry. Refresh in a few seconds after background processing catches up.";
    case "outbox_retry_not_found":
      return "Failed background event was not found for this workspace.";
    case "outbox_retry_not_dead_letter":
      return "Background event is no longer in dead-letter state and was not manually retried.";
    default:
      return "Dashboard action completed.";
  }
}

function dashboardNoticeTitle(notice: string): string {
  switch (notice) {
    case "sync_requested":
    case "sync_already_requested":
      return "Sync queued";
    case "setup_pr_ready":
      return "Setup PR ready";
    case "workflow_already_current":
      return "Workflow installed";
    case "review_config_saved":
    case "repository_review_config_saved":
    case "repository_review_config_cleared":
      return "Policy saved";
    case "outbox_retry_queued":
    case "outbox_retry_not_found":
    case "outbox_retry_not_dead_letter":
      return "Retry updated";
    default:
      return "Action complete";
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

function setupPrButtonLabel(setupStatus: string): string {
  return setupStatus === "setup_pr_open"
    ? "Update setup PR"
    : "Create setup PR";
}

function appInstallUrlForWorkspace(
  installation: DashboardWorkspace["installations"][number] | undefined,
): string | null {
  if (!installation?.githubInstallationId) return null;
  if (!/^\d+$/.test(installation.githubInstallationId)) return null;
  if (installation.accountType === "Organization") {
    return `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.githubInstallationId}`;
  }
  return `https://github.com/settings/installations/${installation.githubInstallationId}`;
}

function workspaceInstallSummary(workspace: DashboardWorkspace): string {
  const installation = workspace.installations[0];
  if (!installation) {
    return "Signed-in GitHub user workspace - install the App to connect repositories.";
  }

  const accountType = formatAccountTypeLabel(installation.accountType);
  const repositoryScope =
    installation.repositorySelection === "all"
      ? "all repositories available"
      : "selected repositories only";

  return `${accountType} GitHub App install - ${repositoryScope}`;
}

function formatAccountTypeLabel(accountType: string): string {
  return accountType === "Organization" ? "Organization" : "Personal";
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
