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
import { PrismaOrgRulesetProvisioningRepository } from "@reviewrouter/features-org-ruleset-provisioning";
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
  enableOrgRulesetWorkflowAction,
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
  GitHubSignOutButton,
} from "../github-sign-in-button";
import { LogoMark } from "../logo-mark";
import { ActionToast } from "../action-toast";
import { RepositoryVisibilityBadge } from "../repository-visibility-badge";
import { DashboardSectionTabs } from "./dashboard-section-tabs";
import { DashboardWorkspaceTabs } from "./dashboard-workspace-tabs";

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
  const orgRulesetStore = new PrismaOrgRulesetProvisioningRepository(prisma);

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
        orgRuleset: Awaited<
          ReturnType<typeof orgRulesetStore.findByWorkspaceId>
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
        const orgRuleset = await orgRulesetStore.findByWorkspaceId(
          workspace.id,
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
          orgRuleset,
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

const dashboardSectionMeta: Record<
  DashboardSection,
  {
    readonly eyebrow: string;
    readonly title: string;
    readonly description: string;
    readonly navDescription: string;
  }
> = {
  repositories: {
    eyebrow: "Repository setup",
    title: "Repositories",
    description:
      "Create setup PRs, confirm runtime health, and see what needs attention before reviews run.",
    navDescription: "Setup PRs and health",
  },
  setup: {
    eyebrow: "Connection",
    title: "Setup",
    description:
      "Sync GitHub App repositories and seed provider credentials directly into GitHub Actions secrets.",
    navDescription: "App sync and secrets",
  },
  policy: {
    eyebrow: "Review behavior",
    title: "Policy",
    description:
      "Choose provider auth, model, reasoning effort, context mode, and blocking severity.",
    navDescription: "Provider, model, gates",
  },
  diagnostics: {
    eyebrow: "Operations",
    title: "Diagnostics",
    description:
      "Inspect metadata-only health, queue failures, audit events, and support diagnostics.",
    navDescription: "Queue, audit, support",
  },
};

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
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 md:py-10">
      <DashboardActionToast params={params} />
      <section className="relative overflow-hidden rounded-[2rem] border border-cyan-300/[0.12] bg-[#0a0a0f]/80 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.42),0_0_90px_-54px_rgba(0,240,255,0.9)] backdrop-blur-2xl sm:p-6">
        <div className="absolute right-[-8rem] top-[-8rem] h-64 w-64 rounded-full bg-cyan-300/10 blur-3xl" />
        <div className="relative grid gap-5 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <LogoMark size="sm" />
              <Badge tone="accent">Dashboard</Badge>
              <span className="font-mono text-xs uppercase tracking-[0.16em] text-slate-500">
                Reviews run in customer CI
              </span>
              {mutationStatus.signedIn ? (
                <>
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 font-mono text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-300">
                    Signed in
                    {mutationStatus.githubLogin
                      ? ` as ${mutationStatus.githubLogin}`
                      : ""}
                  </span>
                  <GitHubSignOutButton
                    variant="ghost"
                    size="sm"
                    className="rounded-xl"
                  />
                </>
              ) : null}
            </div>
            <h1 className="mt-5 max-w-3xl break-words text-3xl font-extrabold leading-[1.08] tracking-[-0.035em] text-cyan-50 sm:text-4xl md:text-5xl">
              Manage repository review rollout.
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[#a0a8c0] sm:text-base sm:leading-7">
              Start from repositories. Setup, policy, and diagnostics are
              separated into focused sections so the primary action stays clear.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-3 xl:min-w-[31rem]">
            <LinkButton
              href={dashboardSectionHref("repositories", selectedWorkspaceKey)}
              size="lg"
              className="w-full"
            >
              {dashboardSummary.needsSetup > 0
                ? "Set up repo"
                : "Review repositories"}
            </LinkButton>
            {appInstallUrl ? (
              <LinkButton
                href={appInstallUrl}
                variant="outline"
                size="md"
                className="w-full"
              >
                Add repos
              </LinkButton>
            ) : null}
            <LinkButton
              href="/setup"
              variant="ghost"
              size="md"
              className="w-full"
            >
              Guided setup
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
          appInstallUrl={appInstallUrl}
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
            "Refresh repository list",
            "Use only if GitHub webhook metadata has not appeared yet.",
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
            "Refresh repository list",
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

  const items = workspaces.map((workspace) => {
    const workspaceKey = dashboardWorkspaceUrlKey(
      workspace.workspace,
      workspaces,
    );
    return {
      id: workspace.workspace.id,
      label: workspace.workspace.name,
      repositoryCount: workspace.repositoryCount,
      href: dashboardSectionHref(selectedSection, workspaceKey),
    };
  });

  return (
    <section className="py-3">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] xl:items-center">
        <div className="min-w-0 px-1">
          <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-cyan-100">
            Workspace
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Personal accounts and organizations stay isolated.
          </p>
        </div>
        <DashboardWorkspaceTabs
          items={items}
          selectedWorkspaceId={selectedWorkspaceId}
        />
      </div>
    </section>
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
    readonly href: string;
  }[] = (["repositories", "setup", "policy", "diagnostics"] as const).map(
    (section) => ({
      section,
      label: dashboardSectionMeta[section].title,
      description: dashboardSectionMeta[section].navDescription,
      href: dashboardSectionHref(section, workspaceKey),
    }),
  );

  return (
    <aside className="p-4 lg:p-5">
      <div className="grid gap-4 lg:sticky lg:top-24">
        <div className="px-1 py-1">
          <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Current account
          </p>
          <p className="mt-2 truncate text-xl font-semibold text-cyan-50">
            {workspace.name}
          </p>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            {workspaceInstallSummary(workspace)}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Badge tone="neutral">{repositoryCount} repos</Badge>
            <Badge tone={workspaceHealth.tone}>{workspaceHealth.label}</Badge>
            <Badge tone="accent" className="max-w-full break-words">
              {entitlement.plan.replace("_", " ")} / {entitlement.status}
            </Badge>
          </div>
        </div>
        <DashboardSectionTabs items={items} selectedSection={selectedSection} />
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
  appInstallUrl,
}: {
  readonly data: DashboardWorkspaceData;
  readonly mutationsEnabled: boolean;
  readonly selectedSection: DashboardSection;
  readonly params: Record<string, string | string[] | undefined>;
  readonly workspaceKey: string;
  readonly appInstallUrl: string | null;
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
    orgRuleset,
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
    <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <DashboardSectionNav
        workspace={workspace}
        repositoryCount={repositoryCount}
        entitlement={entitlement}
        workspaceHealth={workspaceHealth}
        selectedSection={selectedSection}
        workspaceKey={workspaceKey}
      />
      <div id="dashboard-section-content" className="space-y-5 scroll-mt-28">
        <DashboardSectionHeader
          selectedSection={selectedSection}
          repositoryCount={repositoryCount}
          workspaceHealth={workspaceHealth}
          primaryRepositoryFullName={primaryRepository?.fullName ?? null}
          activeConfig={activeConfig}
        />
        <WorkspaceActionNotice params={params} orgRuleset={orgRuleset} />

        {selectedSection === "repositories" ? (
          <>
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
              className="rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/60 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]"
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
              <div className="mt-5 rounded-2xl border border-cyan-200/10 bg-cyan-300/[0.04] p-4 text-sm leading-6 text-slate-300">
                <p className="font-semibold text-cyan-50">
                  Personal account vs organization
                </p>
                <p className="mt-1">
                  To connect a personal repository, install the GitHub App on
                  your username in GitHub. To connect organization repositories,
                  install it on the organization. Each install appears as a
                  separate workspace in the left switcher.
                </p>
              </div>
              <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {workspace.installations.map((installation) => {
                  const selectedRepositories = repositories
                    .filter(
                      (repository) =>
                        repository.selected &&
                        repository.fullName.startsWith(
                          `${installation.accountLogin}/`,
                        ),
                    )
                    .map((repository) => repository.fullName);
                  const visibleSelectedRepositories =
                    selectedRepositories.slice(0, 6);
                  const hiddenSelectedRepositoryCount =
                    selectedRepositories.length -
                    visibleSelectedRepositories.length;

                  return (
                    <div
                      key={`${workspace.id}-${installation.githubInstallationId}`}
                      className="grid gap-4 rounded-2xl border border-cyan-200/10 bg-cyan-300/[0.04] p-4"
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
                      {installation.accountType === "Organization" ? (
                        <div className="rounded-xl border border-cyan-200/10 bg-slate-950/55 p-3">
                          <p className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-cyan-100/70">
                            Selected repositories
                          </p>
                          {installation.repositorySelection === "all" ? (
                            <p className="mt-2 text-xs leading-5 text-slate-300">
                              All organization repositories are available. Setup
                              and secrets still apply only to the repository you
                              choose.
                            </p>
                          ) : visibleSelectedRepositories.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {visibleSelectedRepositories.map(
                                (repositoryFullName) => (
                                  <span
                                    key={repositoryFullName}
                                    className="rounded-full border border-cyan-300/15 bg-cyan-300/[0.08] px-2.5 py-1 text-[0.7rem] font-semibold text-cyan-50"
                                  >
                                    {repositoryFullName}
                                  </span>
                                ),
                              )}
                              {hiddenSelectedRepositoryCount > 0 ? (
                                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[0.7rem] font-semibold text-slate-300">
                                  +{hiddenSelectedRepositoryCount} more
                                </span>
                              ) : null}
                            </div>
                          ) : (
                            <p className="mt-2 text-xs leading-5 text-slate-300">
                              Refresh repositories to show the exact selected
                              repository list if the GitHub webhook has not
                              synced it yet.
                            </p>
                          )}
                        </div>
                      ) : (
                        <div className="rounded-xl border border-cyan-200/10 bg-slate-950/55 p-3">
                          <p className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-cyan-100/70">
                            Personal repositories
                          </p>
                          <p className="mt-2 text-xs leading-5 text-slate-300">
                            This install belongs to your personal GitHub
                            account. Use repository Actions secrets for provider
                            credentials.
                          </p>
                        </div>
                      )}
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
                          className="w-full sm:w-auto"
                          disabled={
                            !mutationsEnabled ||
                            installation.status !== "active"
                          }
                        >
                          Refresh repos
                        </Button>
                      </form>
                    </div>
                  );
                })}
              </div>
            </details>

            <OrgRulesetAdvancedCard
              workspace={workspace}
              orgRuleset={orgRuleset}
              mutationsEnabled={mutationsEnabled}
              appInstallUrl={appInstallUrl}
              permissionUpgradeNeeded={
                readParam(params.error) === "org_admin_permission_required" ||
                readParam(params.error) ===
                  "org_ruleset_permission_update_pending"
              }
            />

            {providerGuidance ? (
              <ProviderSecretGuidancePanel
                guidance={providerGuidance}
                repositoryFullName={primaryRepository?.fullName ?? null}
              />
            ) : null}
          </>
        ) : null}

        {selectedSection === "policy" ? (
          <details
            open
            className="rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/60 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]"
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
            <div className="mt-5 rounded-2xl border border-cyan-200/10 bg-cyan-300/[0.04] p-4">
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
              <div className="mt-4 rounded-2xl border border-cyan-200/10 bg-slate-950/65 p-4">
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
                        className="rounded-2xl border border-cyan-200/10 bg-cyan-300/[0.04] p-4"
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
            Public repository warning: fork pull requests are skipped by default
            for secret-backed providers. Maintainers can add a trusted rerun
            flow later, but v1 keeps provider secrets out of untrusted fork code
            paths.
          </div>
        ) : null}

        {selectedSection === "diagnostics" ? (
          <>
            <div className="rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/60 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
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
              <div className="rounded-[1.5rem] border border-magenta-300/20 bg-fuchsia-400/10 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Badge tone="accent">Support diagnostics</Badge>
                  <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
                    metadata only / no code, diffs, prompts, or secrets
                  </span>
                </div>
                <div className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-5">
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

            <div className="rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/60 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
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

            <div className="rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/60 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
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
  );
}

function DashboardSectionHeader({
  selectedSection,
  repositoryCount,
  workspaceHealth,
  primaryRepositoryFullName,
  activeConfig,
}: {
  readonly selectedSection: DashboardSection;
  readonly repositoryCount: number;
  readonly workspaceHealth: ReturnType<typeof summarizeWorkspaceHealth>;
  readonly primaryRepositoryFullName: string | null;
  readonly activeConfig: ReviewConfiguration;
}): React.ReactElement {
  const meta = dashboardSectionMeta[selectedSection];
  const status =
    selectedSection === "repositories"
      ? `${repositoryCount} synced repositories`
      : selectedSection === "policy"
        ? `${activeConfig.provider.model} / ${activeConfig.provider.reasoningEffort}`
        : selectedSection === "setup"
          ? primaryRepositoryFullName
            ? `Selected repo: ${primaryRepositoryFullName}`
            : "Select a repository first"
          : "Metadata only";

  return (
    <section className="rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/62 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-start">
        <div className="min-w-0">
          <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-cyan-100">
            {meta.eyebrow}
          </p>
          <h2 className="mt-2 text-2xl font-bold tracking-[-0.025em] text-cyan-50 sm:text-3xl">
            {meta.title}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
            {meta.description}
          </p>
          {selectedSection === "repositories" ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <ReadinessInlineStat
                label="Ready"
                value={workspaceHealth.ready}
                tone="success"
              />
              <ReadinessInlineStat
                label="Need setup"
                value={workspaceHealth.needsSetup}
                tone="warning"
              />
              <ReadinessInlineStat
                label="Need attention"
                value={workspaceHealth.needsAttention}
                tone="danger"
              />
            </div>
          ) : null}
          {selectedSection === "repositories" ? (
            <p className="mt-3 text-sm leading-6 text-slate-400">
              Next: create or update the setup PR, merge it, then seed provider
              secrets from Setup.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2 xl:justify-end">
          <Badge tone={workspaceHealth.tone}>{workspaceHealth.label}</Badge>
          <Badge tone="neutral" className="max-w-full break-words">
            {status}
          </Badge>
        </div>
      </div>
    </section>
  );
}

function ReadinessInlineStat({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: "success" | "warning" | "danger";
}): React.ReactElement {
  const toneClass =
    tone === "success"
      ? "border-lime-300/25 text-lime-100"
      : tone === "warning"
        ? "border-amber-300/25 text-amber-100"
        : "border-red-300/25 text-red-100";

  return (
    <span
      className={[
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold",
        toneClass,
      ].join(" ")}
    >
      <span className="font-mono text-[0.68rem] uppercase tracking-[0.14em]">
        {label}
      </span>
      <span className="text-sm text-cyan-50">{value}</span>
    </span>
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
    const setupView = describeRepositorySetup(
      repository.setupStatus,
      repositoryHealth?.status,
    );

    return {
      repository,
      repositoryHealth,
      repositoryProvisioning,
      healthView,
      setupView,
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
    <div className="overflow-hidden rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/62 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
      <div className="grid gap-3 border-b border-cyan-200/10 bg-white/[0.025] p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <Badge tone="accent">Repositories</Badge>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Showing {repositories.length} of {repositoryCount} synced
            repositories. Create or update setup PRs here; use setup search if
            the repo is not visible.{" "}
            {hiddenRepositoryCount > 0
              ? `${hiddenRepositoryCount} more are available in the setup search.`
              : "Only selected App repositories are shown."}
          </p>
        </div>
        <LinkButton href={setupSearchHref} variant="outline" size="sm">
          Find repository
        </LinkButton>
      </div>
      <div className="grid gap-3 p-3 lg:hidden">
        {rows.map(
          ({
            repository,
            repositoryHealth,
            repositoryProvisioning,
            healthView,
            setupView,
            setupPullRequestUrl,
            workflowCurrent,
          }) => (
            <div
              key={repository.id}
              className={[
                "grid gap-4 border-t border-cyan-200/10 px-1 py-5 first:border-t-0",
                repository.selected ? "" : "opacity-50",
              ].join(" ")}
            >
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                <p className="break-words font-medium text-cyan-50">
                  {repository.fullName}
                </p>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
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

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">
                    Setup PR
                  </p>
                  <div className="mt-2">
                    <Badge tone={setupView.tone}>{setupView.label}</Badge>
                  </div>
                  {setupView.hint ? (
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      {setupView.hint}
                    </p>
                  ) : null}
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
                    Runtime health
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
          <thead className="bg-cyan-300/[0.08] text-xs uppercase tracking-[0.16em] text-cyan-100">
            <tr>
              <th className="px-4 py-3">Repository</th>
              <th className="px-4 py-3">Setup PR</th>
              <th className="px-4 py-3">Runtime health</th>
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
                setupView,
                setupPullRequestUrl,
                workflowCurrent,
              }) => {
                return (
                  <tr
                    key={repository.id}
                    className={[
                      "transition hover:bg-cyan-300/[0.035]",
                      repository.selected ? "" : "opacity-50",
                    ].join(" ")}
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
                      <Badge tone={setupView.tone}>{setupView.label}</Badge>
                      {setupView.hint ? (
                        <span className="mt-1 block text-xs leading-5 text-slate-500">
                          {setupView.hint}
                        </span>
                      ) : null}
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

function OrgRulesetAdvancedCard({
  workspace,
  orgRuleset,
  mutationsEnabled,
  appInstallUrl,
  permissionUpgradeNeeded,
}: {
  readonly workspace: DashboardWorkspace;
  readonly orgRuleset: DashboardWorkspaceData["orgRuleset"];
  readonly mutationsEnabled: boolean;
  readonly appInstallUrl: string | null;
  readonly permissionUpgradeNeeded: boolean;
}): React.ReactElement | null {
  const organizationInstallation = workspace.installations.find(
    (installation) => installation.accountType === "Organization",
  );
  if (!organizationInstallation) {
    return null;
  }

  const rulesetsUnsupported =
    orgRuleset?.safeErrorCode === "org_rulesets_not_supported";
  const permissionMissing =
    permissionUpgradeNeeded ||
    orgRuleset?.safeErrorCode === "org_admin_permission_required" ||
    orgRuleset?.safeErrorCode === "org_ruleset_permission_update_pending";
  const rulesetUrl = safeGitHubDashboardLink(orgRuleset?.rulesetUrl ?? "");
  const permissionApprovalUrl =
    buildInstallationSettingsUrl(organizationInstallation) ?? appInstallUrl;

  return (
    <details className="rounded-[1.5rem] border border-amber-300/20 bg-amber-300/[0.08] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
      <summary className="cursor-pointer list-none">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <div>
            <Badge tone="warning">Advanced org-wide mode</Badge>
            <p className="mt-2 text-sm leading-6 text-amber-50">
              Enable a GitHub Organization Ruleset required workflow for many
              repositories without opening setup PRs in every repo. Default
              onboarding stays per-repository setup PR.
            </p>
          </div>
          <Badge tone={orgRulesetStatusTone(orgRuleset?.status)}>
            {orgRuleset?.status
              ? orgRuleset.status.replaceAll("_", " ")
              : "not enabled"}
          </Badge>
        </div>
      </summary>

      <div className="mt-5 grid gap-4">
        <div className="rounded-2xl border border-amber-200/15 bg-slate-950/70 p-4 text-sm leading-6 text-slate-300">
          <p>
            This advanced mode requires GitHub App{" "}
            <strong className="text-amber-100">
              Organization Administration: write
            </strong>{" "}
            only to create/update the ReviewRouter ruleset and its central
            workflow. Provider secrets still stay in GitHub Actions, not in
            ReviewRouter SaaS.
          </p>
          {rulesetsUnsupported ? (
            <p className="mt-3 text-amber-100">
              GitHub accepted the App permissions, but this organization plan
              does not expose Organization Rulesets through the API. Use the
              per-repository setup PR fallback unless the organization is
              upgraded to a plan that supports rulesets.
            </p>
          ) : permissionMissing ? (
            <p className="mt-3 text-amber-100">
              GitHub did not allow ruleset access. Usually this means the
              optional Organization Administration permission still needs
              approval; if it is already approved, the organization plan may not
              support rulesets. Use the setup PR fallback when rulesets are not
              available.
            </p>
          ) : null}
          {orgRuleset?.safeErrorCode ? (
            <p className="mt-3 text-amber-100">
              Last status: {orgRulesetErrorText(orgRuleset.safeErrorCode)}
            </p>
          ) : null}
          {rulesetUrl ? (
            <a
              href={rulesetUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex text-cyan-100 underline decoration-cyan-300/50 underline-offset-4"
            >
              Open GitHub ruleset
            </a>
          ) : null}
        </div>

        <div className="rounded-2xl border border-amber-200/10 bg-slate-950/55 p-4">
          <form
            action={enableOrgRulesetWorkflowAction}
            className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-[minmax(0,18rem)_minmax(0,18rem)_auto] 2xl:items-end"
          >
            <input type="hidden" name="workspaceId" value={workspace.id} />
            <input
              type="hidden"
              name="githubInstallationId"
              value={organizationInstallation.githubInstallationId}
            />
            <SelectField
              name="scope"
              label="Repository scope"
              defaultValue={orgRuleset?.scope ?? "selected_repositories"}
              disabled={!mutationsEnabled}
              options={[
                {
                  value: "selected_repositories",
                  label: "Selected App repos",
                  description: "Safer default, matches App repository access.",
                },
                {
                  value: "all_repositories",
                  label: "All organization repos",
                  description:
                    "Advanced, ruleset applies broadly where GitHub allows it.",
                },
              ]}
            />
            <SelectField
              name="enforcement"
              label="Ruleset enforcement"
              defaultValue={orgRuleset?.enforcement ?? "evaluate"}
              disabled={!mutationsEnabled}
              options={[
                {
                  value: "evaluate",
                  label: "Evaluate first",
                  description:
                    "Non-blocking smoke mode. GitHub Enterprise only.",
                },
                {
                  value: "active",
                  label: "Active",
                  description: "Blocks according to GitHub required workflow.",
                },
              ]}
            />
            <div className="flex items-end">
              <FormSubmitButton
                variant="soft"
                tone="warning"
                className="w-full whitespace-nowrap"
                disabled={
                  !mutationsEnabled ||
                  organizationInstallation.status !== "active" ||
                  orgRuleset?.status === "processing" ||
                  rulesetsUnsupported
                }
                idleLabel={orgRuleset ? "Update org-wide" : "Enable org-wide"}
                pendingLabel="Checking permission..."
              />
            </div>
          </form>

          <div className="mt-4 flex flex-wrap gap-2 border-t border-amber-200/10 pt-4">
            {permissionMissing && permissionApprovalUrl ? (
              <LinkButton
                href={permissionApprovalUrl}
                variant="outline"
                size="sm"
              >
                Review App permissions
              </LinkButton>
            ) : null}
            <LinkButton
              href={dashboardSectionHref(
                "repositories",
                dashboardWorkspaceUrlKey(workspace),
              )}
              variant="ghost"
              size="sm"
            >
              Use setup PR fallback
            </LinkButton>
          </div>
        </div>
      </div>
    </details>
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
    <form action={createSetupPullRequestAction} className="grid gap-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="repositoryId" value={repositoryId} />
      <input type="hidden" name="workflowStyle" value="reusable" />
      <FormSubmitButton
        variant="solid"
        size="sm"
        className="w-full"
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
  orgRuleset,
}: {
  readonly params: Record<string, string | string[] | undefined>;
  readonly orgRuleset: DashboardWorkspaceData["orgRuleset"];
}): React.ReactElement | null {
  const notice = readParam(params.notice);
  const rawError = readParam(params.error);
  const error =
    rawError === "org_admin_permission_required" &&
    orgRuleset?.safeErrorCode === "org_rulesets_not_supported"
      ? "org_rulesets_not_supported"
      : rawError;
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
    <form action={action} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
      <DashboardTextField
        name="model"
        label="Model"
        defaultValue={config.provider.model}
        disabled={!mutationsEnabled}
      />
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
      <DashboardTextField
        name="inlineMaxComments"
        label="Inline max comments"
        type="number"
        min={0}
        max={50}
        defaultValue={config.limits.inlineMaxComments}
        disabled={!mutationsEnabled}
      />
      <DashboardTextField
        name="targetTokensPerBatch"
        label="Target tokens per batch"
        type="number"
        min={4000}
        max={200000}
        step={1000}
        defaultValue={config.limits.targetTokensPerBatch}
        disabled={!mutationsEnabled}
      />
      <SelectField
        name="agenticContext"
        label="Agentic context"
        defaultValue={String(config.provider.agenticContext)}
        disabled={!mutationsEnabled}
        options={agenticContextOptions}
      />
      <div className="flex items-end md:col-span-2 xl:col-span-1">
        <Button
          type="submit"
          variant="solid"
          className="w-full"
          disabled={!mutationsEnabled}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function DashboardTextField({
  name,
  label,
  defaultValue,
  disabled,
  type = "text",
  min,
  max,
  step,
}: {
  readonly name: string;
  readonly label: string;
  readonly defaultValue: string | number;
  readonly disabled: boolean;
  readonly type?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}): React.ReactElement {
  return (
    <label className="grid min-w-0 gap-2 text-sm text-slate-300">
      <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
        {label}
      </span>
      <input
        name={name}
        type={type}
        min={min}
        max={max}
        step={step}
        defaultValue={defaultValue}
        disabled={disabled}
        className="min-h-11 w-full rounded-xl border border-cyan-200/15 bg-slate-950/80 px-3 py-2 text-cyan-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] outline-none transition placeholder:text-slate-500 hover:border-cyan-200/30 focus:border-cyan-300/55 focus:ring-2 focus:ring-cyan-300/20 disabled:cursor-not-allowed disabled:opacity-50"
      />
    </label>
  );
}

function ProviderSecretGuidancePanel({
  guidance,
  repositoryFullName,
}: {
  readonly guidance: ReturnType<typeof buildProviderSecretSetupGuidance>;
  readonly repositoryFullName: string | null;
}): React.ReactElement {
  const recommendedCommand = guidance.commands[0];

  return (
    <details
      open
      className="rounded-[1.5rem] border border-emerald-300/20 bg-emerald-300/[0.08] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]"
    >
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Badge tone="success">
              {providerSetupTitle(guidance.provider)}
            </Badge>
            <p className="mt-2 text-sm leading-6 text-emerald-50">
              Ready command for{" "}
              <span className="font-semibold">
                {repositoryFullName ?? "the selected repository"}
              </span>
              . Credentials stay in GitHub Actions secrets.
            </p>
          </div>
          <span className="max-w-full break-words font-mono text-xs uppercase tracking-[0.16em] text-emerald-100">
            {guidance.recommendedScope.replaceAll("_", " ")}
          </span>
        </div>
      </summary>

      <div className="mt-5">
        <p className="mb-3 rounded-2xl border border-emerald-200/10 bg-slate-950/60 p-3 text-xs leading-5 text-emerald-100/90">
          {guidance.recommendedScope === "repository"
            ? "Personal account flow: this command writes a repository secret for the selected repo."
            : "Organization flow: the recommended command writes one organization secret scoped only to the selected repository."}
        </p>
        <p className="text-sm leading-6 text-emerald-50">
          {providerSetupIntro(guidance.provider)}
        </p>

        {recommendedCommand ? (
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <ProviderSetupFact
              label="Writes secret to"
              value={recommendedCommand.targetLabel}
            />
            <ProviderSetupFact
              label="Selected repositories"
              value={recommendedCommand.selectedRepositories.join(", ")}
            />
            <ProviderSetupFact
              label="Before write"
              value={
                recommendedCommand.validatesBeforeWrite
                  ? "Validates auth.json locally"
                  : "GitHub validates the secret input"
              }
            />
          </div>
        ) : null}

        {guidance.warnings.length > 0 ? (
          <ul className="mt-4 list-disc space-y-1 pl-5 text-xs leading-5 text-emerald-100/90">
            {guidance.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}

        <div className="mt-4 grid gap-3">
          {guidance.commands.map((command, index) => (
            <div
              key={command.title}
              className="rounded-2xl border border-emerald-200/10 bg-slate-950/80 p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={index === 0 ? "success" : "neutral"}>
                  {index === 0 ? "Recommended" : "Alternative"}
                </Badge>
                <p className="text-sm font-semibold text-emerald-50">
                  {command.title}
                </p>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-400">
                {command.description}
              </p>
              <div className="mt-3 grid gap-2 text-xs leading-5 text-slate-300 md:grid-cols-2">
                <span>
                  <strong className="text-emerald-100">Secrets:</strong>{" "}
                  {command.secretNames.join(", ")}
                </span>
                <span>
                  <strong className="text-emerald-100">Recovery:</strong>{" "}
                  {command.failureRecovery}
                </span>
              </div>
              <CodeBlock
                code={command.command}
                className="mt-3 rounded-md p-3 text-xs leading-5"
              />
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function ProviderSetupFact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.ReactElement {
  return (
    <div className="min-w-0 rounded-2xl border border-emerald-200/10 bg-slate-950/70 p-4">
      <p className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-emerald-100/70">
        {label}
      </p>
      <p className="mt-2 break-words text-sm font-semibold leading-6 text-emerald-50">
        {value}
      </p>
    </div>
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

function DashboardActionToast({
  params,
}: {
  readonly params: Record<string, string | string[] | undefined>;
}): React.ReactElement | null {
  const notice = readParam(params.notice);
  const error = readParam(params.error);
  const repository = readParam(params.repository);
  const prUrl = safeGitHubDashboardLink(readParam(params.pr)) ?? undefined;

  if (error) {
    return (
      <ActionToast
        tone="danger"
        title="Action needs attention"
        body={dashboardErrorText(error)}
      />
    );
  }

  if (!notice) return null;

  const autoOpenSetupPr = notice === "setup_pr_ready" ? prUrl : undefined;
  return (
    <ActionToast
      tone={dashboardNoticeTone(notice)}
      title={dashboardNoticeTitle(notice)}
      body={dashboardNoticeText(notice, repository)}
      actionUrl={prUrl}
      actionLabel={prUrl ? "Open setup PR" : undefined}
      autoOpenUrl={autoOpenSetupPr}
      storageKey={
        autoOpenSetupPr
          ? `reviewrouter:dashboard-setup-pr:${autoOpenSetupPr}`
          : undefined
      }
    />
  );
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
      "org_ruleset_queued",
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
    "section",
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
      return "Repository metadata refresh was queued. Reload in a few seconds if the repository list does not update immediately.";
    case "sync_already_requested":
      return "Repository metadata refresh was already queued for this installation recently.";
    case "setup_pr_ready":
      return repository
        ? `Setup PR is ready for ${repository}.`
        : "Setup PR is ready.";
    case "workflow_already_current":
      return repository
        ? `ReviewRouter workflow is already current for ${repository}.`
        : "ReviewRouter workflow is already current.";
    case "org_ruleset_queued":
      return "Organization-wide required workflow setup was queued. The worker will create or update the central workflow and GitHub ruleset after the permission probe passes.";
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
      return "Refresh queued";
    case "setup_pr_ready":
      return "Setup PR ready";
    case "workflow_already_current":
      return "Workflow installed";
    case "org_ruleset_queued":
      return "Org-wide setup queued";
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

function dashboardNoticeTone(
  notice: string,
): "success" | "warning" | "danger" | "accent" {
  switch (notice) {
    case "setup_pr_ready":
    case "workflow_already_current":
    case "review_config_saved":
    case "repository_review_config_saved":
    case "repository_review_config_cleared":
      return "success";
    case "sync_already_requested":
      return "accent";
    case "outbox_retry_not_found":
    case "outbox_retry_not_dead_letter":
      return "warning";
    default:
      return "accent";
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

function describeRepositorySetup(
  setupStatus: string,
  healthStatus: string | undefined,
): {
  readonly label: string;
  readonly tone: "success" | "warning" | "danger" | "neutral";
  readonly hint: string | null;
} {
  if (healthStatus === "missing_workflow") {
    return {
      label: "Setup PR needed",
      tone: "warning",
      hint: "Workflow is not on the default branch yet.",
    };
  }

  switch (setupStatus) {
    case "not_configured":
      return {
        label: "No setup PR",
        tone: "neutral",
        hint: "Create and merge the setup PR first.",
      };
    case "setup_pr_open":
      return {
        label: "Setup PR open",
        tone: "warning",
        hint: "Merge it to install the workflow.",
      };
    case "configured":
      return {
        label: "Setup recorded",
        tone: "success",
        hint: null,
      };
    case "needs_attention":
      return {
        label: "Needs attention",
        tone: "danger",
        hint: "Fix the setup error, then retry.",
      };
    default:
      return {
        label: setupStatus.replaceAll("_", " "),
        tone: "neutral",
        hint: null,
      };
  }
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

function orgRulesetStatusTone(
  status: string | undefined,
): "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "configured":
      return "success";
    case "requested":
    case "processing":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

function orgRulesetErrorText(error: string): string {
  switch (error) {
    case "org_admin_permission_required":
      return "Organization Administration: write is required for org-wide rulesets.";
    case "org_rulesets_not_supported":
      return "GitHub organization rulesets are unavailable on this organization plan. Use per-repository setup PR fallback, or upgrade the organization plan before retrying org-wide mode.";
    case "org_ruleset_permission_update_pending":
      return "GitHub rejected the ruleset probe. The App permission update may still need approval.";
    case "org_ruleset_all_repositories_requires_all_access":
      return "All-repositories ruleset requires the GitHub App installation to be configured for all repositories.";
    case "github_org_ruleset_validation_failed":
      return "GitHub rejected the ruleset payload. If you chose Evaluate, switch to Active unless the organization is on GitHub Enterprise.";
    default:
      return error.replaceAll("_", " ");
  }
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
    case "org_ruleset_requires_organization_installation":
      return "Organization-wide required workflow is available only for GitHub organization installations. Use per-repository setup PR for personal repositories.";
    case "org_ruleset_no_selected_repositories":
      return "This organization installation has no selected, active repositories to target.";
    case "org_ruleset_all_repositories_requires_all_access":
      return "All-repositories org ruleset requires installing the GitHub App for all repositories first. Use selected repositories or per-repository setup PR fallback.";
    case "org_admin_permission_required":
      return "GitHub did not allow organization ruleset access. Approve the optional Organization Administration: write permission if it is still pending; if it is already approved, the organization plan may not support rulesets. Use per-repository setup PR fallback.";
    case "org_rulesets_not_supported":
      return "GitHub accepted the App permissions, but organization rulesets are unavailable on this organization plan. Use per-repository setup PR fallback, or upgrade the organization plan before retrying org-wide mode.";
    case "org_ruleset_permission_update_pending":
      return "GitHub rejected the ruleset permission probe. An organization owner may still need to approve the App permission update.";
    case "github_org_ruleset_validation_failed":
      return "GitHub rejected the ruleset payload. Evaluate mode requires GitHub Enterprise; switch to Active or use per-repository setup PR fallback.";
    default:
      return "GitHub operation failed. Check audit events or server logs for the safe error code.";
  }
}

function buildInstallationSettingsUrl(
  installation: DashboardWorkspace["installations"][number],
): string | null {
  if (!/^\d+$/.test(installation.githubInstallationId)) return null;
  if (installation.accountType === "Organization") {
    if (!/^[A-Za-z0-9-]+$/.test(installation.accountLogin)) return null;
    return `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.githubInstallationId}`;
  }
  return `https://github.com/settings/installations/${installation.githubInstallationId}`;
}
