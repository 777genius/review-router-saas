import type { Metadata } from "next";
import {
  Badge,
  Button,
  DialogBackdrop,
  DialogClose,
  DialogDescription,
  DialogPopup,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
  LinkButton,
  SelectField,
} from "@reviewrouter/ui";
import { resolveReviewRouterActionRef } from "@reviewrouter/platform-config";
import { PrismaRepositoryConnectionRepository } from "@reviewrouter/features-repositories";
import {
  listWorkspaceRepositoryHealth,
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
import { redirect } from "next/navigation";
import {
  findReviewConfiguration,
  PrismaReviewConfigurationRepository,
  safeDefaultReviewConfiguration,
  type ReviewConfiguration,
} from "@reviewrouter/features-review-config";
import {
  listMemoryItemsForDashboard,
  listMemorySuggestionsForDashboard,
  PrismaMemoryItemRepository,
  PrismaMemorySuggestionRepository,
  type MemoryDashboardItemDto,
  type MemoryDashboardSuggestionDto,
} from "@reviewrouter/features-memory";
import {
  getWorkspaceSupportDiagnostics,
  PrismaSupportDiagnosticsRepository,
} from "@reviewrouter/features-support-diagnostics";
import {
  getDashboardMutationStatus,
  getDashboardWorkspaceScope,
} from "../../src/server/dashboard-mutations";
import { getPrisma } from "../../src/server/prisma";
import {
  clearRepositoryReviewConfigAction,
  requestInstallationSyncAction,
  retryOutboxEventAction,
  enableOrgRulesetWorkflowAction,
  saveRepositoryReviewConfigAction,
  saveWorkspaceReviewConfigAction,
} from "./actions";
import { getGitHubAppInstallUrl } from "../../src/server/github-app-install-url";
import { safeGitHubDashboardLink } from "../../src/server/safe-dashboard-link";
import { summarizeWorkspaceHealth } from "../../src/server/repository-health-view";
import {
  buildRepositorySearchText,
  repositoryMatchesSearchFilter,
  repositorySetupProgressStep,
  tokenizeRepositorySearch,
  workflowSetupAlreadyCurrent,
} from "../../src/server/repository-search";
import { resolveCodexSeedScriptUrl } from "../../src/server/codex-seed-script-url";
import {
  getReviewModelOptions,
  type ReviewModelOption,
} from "../../src/server/openrouter-model-catalog";
import { FormSubmitButton } from "../form-submit-button";
import { GitHubAppInstallPermissionDialog } from "../github-app-install-permission-dialog";
import { GitHubAccountAvatar } from "../github-account-avatar";
import { ActionToast } from "../action-toast";
import { RepositoryVisibilityBadge } from "../repository-visibility-badge";
import { DashboardSectionTabs } from "./dashboard-section-tabs";
import { DashboardWorkspaceTabs } from "./dashboard-workspace-tabs";
import { ProviderSecretSetupChooser } from "./provider-secret-setup-chooser";
import {
  RepositoryLiveSearch,
  type RepositorySearchFilter,
  type RepositorySearchIndexItem,
} from "./repository-live-search";
import { RepositorySetupProgressPanel as RepositorySetupProgressPanelClient } from "./repository-setup-progress-panel";
import {
  RepositoryPolicyEditor,
  ReviewConfigForm,
} from "./repository-policy-editor";
import { RepositorySetupStatusRefresher } from "./repository-setup-status-refresher";
import {
  MemoryManagementPanel,
  type MemoryManagementMode,
  type MemoryManagementModeLinks,
} from "./memory-management-panel";
import { createNoIndexPageMetadata } from "../seo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = createNoIndexPageMetadata({
  title: "Dashboard",
  description:
    "Private ReviewRouter dashboard for repository setup, review policy, health, and audit metadata.",
});

type DashboardWorkspace = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly installations: readonly {
    readonly accountLogin: string;
    readonly accountType: string;
    readonly accountAvatarUrl: string | null;
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
          accountAvatarUrl: true,
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
  const entitlementStore = new PrismaEntitlementRepository(prisma);
  const reviewConfigStore = new PrismaReviewConfigurationRepository(prisma);
  const outboxStore = new PrismaOutboxEventRepository(prisma);
  const diagnosticsStore = new PrismaSupportDiagnosticsRepository(prisma);
  const orgRulesetStore = new PrismaOrgRulesetProvisioningRepository(prisma);
  const memoryItemStore = new PrismaMemoryItemRepository(prisma);
  const memorySuggestionStore = new PrismaMemorySuggestionRepository(prisma);

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
        providerSetup: readonly {
          readonly repositoryId: string | null;
          readonly state: string;
          readonly updatedAt: Date;
        }[];
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
        memoryItems: readonly MemoryDashboardItemDto[];
        memorySuggestions: readonly MemoryDashboardSuggestionDto[];
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
            workflowProbeMaxRepositories: 0,
          },
          { repositories: healthStore },
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
        const providerSetup = await prisma.providerSetupState.findMany({
          where: {
            workspaceId: workspace.id,
            repositoryId: {
              in: repositories.map((repository) => repository.id),
            },
          },
          select: {
            repositoryId: true,
            state: true,
            updatedAt: true,
          },
        });
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
        const [memoryItems, memorySuggestions] = await Promise.all([
          listMemoryItemsForDashboard(
            { workspaceId: workspace.id, limit: 25 },
            { memoryItems: memoryItemStore },
          ),
          listMemorySuggestionsForDashboard(
            { workspaceId: workspace.id, limit: 25 },
            {
              memorySuggestions: memorySuggestionStore,
              clock: { now: () => new Date() },
            },
          ),
        ]);

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
          repositories,
          provisioning,
          providerSetup,
          entitlement,
          health,
          reviewConfig,
          repositoryConfigs,
          outboxFailures,
          supportDiagnostics,
          orgRuleset,
          memoryItems: memoryItems.items,
          memorySuggestions: memorySuggestions.suggestions,
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

type DashboardWorkspaceData = Awaited<
  ReturnType<typeof loadDashboardData>
>[number];

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
  installationIdParam = "",
): DashboardWorkspaceData {
  if (!workspaceParam && installationIdParam) {
    const byInstallation = workspaces.find((workspace) =>
      workspace.workspace.installations.some(
        (installation) =>
          installation.githubInstallationId === installationIdParam,
      ),
    );
    if (byInstallation) return byInstallation;
  }

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

function workspaceAvatarUrl(
  workspace: DashboardWorkspace,
  fallbackUser?: {
    readonly githubLogin: string | null;
    readonly githubAvatarUrl: string | null;
  },
): string | null {
  const installationAvatar =
    workspace.installations.find(
      (installation) => installation.status === "active",
    )?.accountAvatarUrl ??
    workspace.installations[0]?.accountAvatarUrl ??
    null;
  if (installationAvatar) return installationAvatar;

  const personalInstallation = workspace.installations.find(
    (installation) =>
      installation.accountType === "User" &&
      installation.accountLogin === fallbackUser?.githubLogin,
  );
  if (personalInstallation && fallbackUser?.githubAvatarUrl) {
    return fallbackUser.githubAvatarUrl;
  }

  return githubAvatarUrlForLogin(
    workspace.installations[0]?.accountLogin ?? workspace.name,
  );
}

function githubAvatarUrlForLogin(
  login: string | null | undefined,
): string | null {
  if (!login || !/^[A-Za-z0-9-]+$/.test(login)) {
    return null;
  }

  return `https://github.com/${login}.png?size=64`;
}

function normalizeWorkspaceKey(value: string): string {
  return value.trim().toLowerCase();
}

type DashboardPageProps = {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
};

type DashboardSection =
  | "repositories"
  | "memory"
  | "setup"
  | "policy"
  | "diagnostics";

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
  memory: {
    eyebrow: "Memory management",
    title: "Memory",
    description:
      "Confirm suggested memories, manage approved knowledge, and keep runtime context scoped to this workspace.",
    navDescription: "Suggestions and knowledge",
  },
  setup: {
    eyebrow: "Connection",
    title: "Setup",
    description:
      "Refresh GitHub App repository metadata and manage installation access. Provider commands appear after choosing a repository.",
    navDescription: "App sync and access",
  },
  policy: {
    eyebrow: "Review behavior",
    title: "Model",
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

const MAX_RENDERED_REPOSITORY_ROWS = 24;

export default async function DashboardPage({
  searchParams,
}: DashboardPageProps): Promise<React.ReactElement> {
  const params = searchParams ? await searchParams : {};
  const appInstallCallbackRedirect =
    buildDashboardAppInstallCallbackRedirect(params);
  if (appInstallCallbackRedirect) {
    redirect(appInstallCallbackRedirect);
  }

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
  const [dashboardData, modelOptions] = await Promise.all([
    loadDashboardData(workspaceScope, supportAudit),
    getReviewModelOptions(),
  ]);
  const workspaces = filterVisibleDashboardWorkspaces(dashboardData);
  const appInstallUrl = getGitHubAppInstallUrl();
  const selectedSection = resolveDashboardSection(params);

  if (workspaces.length === 0) {
    redirect("/");
  }

  const selectedWorkspace = selectDashboardWorkspace(
    workspaces,
    readParam(params.workspace),
    readParam(params.installation_id),
  );
  const selectedWorkspaceKey = dashboardWorkspaceUrlKey(
    selectedWorkspace.workspace,
    workspaces,
  );

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 md:py-10">
      <WorkspaceSwitcher
        workspaces={workspaces}
        selectedWorkspaceId={selectedWorkspace.workspace.id}
        selectedSection={selectedSection}
        appInstallUrl={appInstallUrl}
        fallbackUser={{
          githubLogin: mutationStatus.githubLogin,
          githubAvatarUrl: mutationStatus.githubAvatarUrl,
        }}
      />

      <section id="dashboard-workspace" className="grid gap-5 scroll-mt-28">
        <WorkspaceCard
          data={selectedWorkspace}
          mutationsEnabled={mutationStatus.enabled}
          selectedSection={selectedSection}
          params={params}
          workspaceKey={selectedWorkspaceKey}
          appInstallUrl={appInstallUrl}
          modelOptions={modelOptions}
          fallbackUser={{
            githubLogin: mutationStatus.githubLogin,
            githubAvatarUrl: mutationStatus.githubAvatarUrl,
          }}
        />
      </section>
    </main>
  );
}

function WorkspaceSwitcher({
  workspaces,
  selectedWorkspaceId,
  selectedSection,
  appInstallUrl,
  fallbackUser,
}: {
  readonly workspaces: readonly DashboardWorkspaceData[];
  readonly selectedWorkspaceId: string;
  readonly selectedSection: DashboardSection;
  readonly appInstallUrl: string | null;
  readonly fallbackUser: {
    readonly githubLogin: string | null;
    readonly githubAvatarUrl: string | null;
  };
}): React.ReactElement | null {
  if (workspaces.length < 2 && !appInstallUrl) return null;

  const items = workspaces.map((workspace) => {
    const workspaceKey = dashboardWorkspaceUrlKey(
      workspace.workspace,
      workspaces,
    );
    return {
      id: workspace.workspace.id,
      label: workspace.workspace.name,
      avatarUrl: workspaceAvatarUrl(workspace.workspace, fallbackUser),
      repositoryCount: workspace.repositoryCount,
      href: dashboardSectionHref(selectedSection, workspaceKey),
    };
  });

  return (
    <section className="py-3">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3 px-1">
          <div className="min-w-0">
            <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-cyan-100">
              Workspace
            </p>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Personal accounts and organizations stay isolated.
            </p>
          </div>
          {appInstallUrl ? (
            <GitHubAppInstallPermissionDialog
              href={appInstallUrl}
              variant="outline"
              size="sm"
              className="inline-flex w-auto items-center gap-2 px-3"
            >
              <span
                aria-hidden="true"
                className="relative h-4 w-4 rounded-full border border-cyan-100/35 text-cyan-100"
              >
                <span className="absolute left-1/2 top-1/2 h-0.5 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current" />
                <span className="absolute left-1/2 top-1/2 h-2 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current" />
              </span>
              Add repos
            </GitHubAppInstallPermissionDialog>
          ) : null}
        </div>
        {workspaces.length > 1 ? (
          <DashboardWorkspaceTabs
            items={items}
            selectedWorkspaceId={selectedWorkspaceId}
          />
        ) : null}
      </div>
    </section>
  );
}

function DashboardSectionNav({
  workspace,
  repositoryCount,
  workspaceHealth,
  selectedSection,
  workspaceKey,
  fallbackUser,
}: {
  readonly workspace: DashboardWorkspace;
  readonly repositoryCount: number;
  readonly workspaceHealth: ReturnType<typeof summarizeWorkspaceHealth>;
  readonly selectedSection: DashboardSection;
  readonly workspaceKey: string;
  readonly fallbackUser: {
    readonly githubLogin: string | null;
    readonly githubAvatarUrl: string | null;
  };
}): React.ReactElement {
  const avatarUrl = workspaceAvatarUrl(workspace, fallbackUser);
  const items: readonly {
    readonly section: DashboardSection;
    readonly label: string;
    readonly description: string;
    readonly href: string;
  }[] = (
    ["repositories", "memory", "setup", "policy", "diagnostics"] as const
  ).map((section) => ({
    section,
    label: dashboardSectionMeta[section].title,
    description: dashboardSectionMeta[section].navDescription,
    href: dashboardSectionHref(section, workspaceKey),
  }));

  return (
    <aside className="p-4 lg:p-5">
      <div className="grid gap-4 lg:sticky lg:top-24">
        <div className="px-1 py-1">
          <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Current account
          </p>
          <div className="mt-2 flex min-w-0 items-center gap-3">
            <GitHubAccountAvatar
              avatarUrl={avatarUrl}
              login={workspace.name}
              size="md"
            />
            <p className="truncate text-xl font-semibold text-cyan-50">
              {workspace.name}
            </p>
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            {workspaceInstallSummary(workspace)}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Badge tone="neutral">{repositoryCount} repos</Badge>
            <Badge tone={workspaceHealth.tone}>{workspaceHealth.label}</Badge>
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
  modelOptions,
  fallbackUser,
}: {
  readonly data: DashboardWorkspaceData;
  readonly mutationsEnabled: boolean;
  readonly selectedSection: DashboardSection;
  readonly params: Record<string, string | string[] | undefined>;
  readonly workspaceKey: string;
  readonly appInstallUrl: string | null;
  readonly modelOptions: readonly ReviewModelOption[];
  readonly fallbackUser: {
    readonly githubLogin: string | null;
    readonly githubAvatarUrl: string | null;
  };
}): React.ReactElement {
  const {
    workspace,
    repositoryCount,
    repositories,
    health,
    provisioning,
    providerSetup,
    repositoryConfigs,
    outboxFailures,
    supportDiagnostics,
    orgRuleset,
    memoryItems,
    memorySuggestions,
  } = data;
  const activeConfig =
    data.reviewConfig?.config ?? safeDefaultReviewConfiguration;
  const activeConfigVersion = data.reviewConfig?.version ?? 1;
  const requestedRepositoryFullName = readParam(params.repository);
  const providerSecretCheckFailedRepositoryFullName =
    isProviderSecretCheckError(readParam(params.error))
      ? requestedRepositoryFullName
      : null;
  const repositorySearchQuery = readParam(params.q);
  const repositorySearchFilter = readRepositorySearchFilter(params);
  const selectedMemoryMode = resolveMemoryManagementMode(params);
  const requestedRepository = requestedRepositoryFullName
    ? repositories.find(
        (repository) => repository.fullName === requestedRepositoryFullName,
      )
    : undefined;
  const selectedRepository = requestedRepository ?? null;
  const selectedInstallation = selectedRepository
    ? findInstallationForRepository(workspace, selectedRepository.fullName)
    : null;
  const providerGuidanceSet =
    selectedRepository && selectedInstallation
      ? buildProviderSecretGuidanceSet({
          repositoryFullName: selectedRepository.fullName,
          installation: selectedInstallation,
        })
      : null;
  const workspaceHealth = summarizeWorkspaceHealth(
    repositories.map(
      (repository) =>
        health.find((item) => item.repositoryId === repository.id)?.status,
    ),
  );
  const activeInstallations = workspace.installations.filter(
    (installation) => installation.status === "active",
  );
  const setupReadyEnableReviewAction =
    readParam(params.notice) === "setup_pr_ready" &&
    selectedRepository &&
    selectedInstallation &&
    providerGuidanceSet ? (
      <RepositoryProviderSecretsDialog
        workspaceId={workspace.id}
        repositoryId={selectedRepository.id}
        repositoryFullName={selectedRepository.fullName}
        installation={selectedInstallation}
        guidanceSet={providerGuidanceSet}
        triggerLabel="Enable review"
        triggerVariant="solid"
        triggerSize="sm"
        triggerClassName="rounded-xl"
      />
    ) : null;

  return (
    <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <DashboardSectionNav
        workspace={workspace}
        repositoryCount={repositoryCount}
        workspaceHealth={workspaceHealth}
        selectedSection={selectedSection}
        workspaceKey={workspaceKey}
        fallbackUser={fallbackUser}
      />
      <div id="dashboard-section-content" className="space-y-5 scroll-mt-28">
        <DashboardActionToast
          params={params}
          secondaryAction={setupReadyEnableReviewAction}
        />
        <DashboardSectionHeader
          selectedSection={selectedSection}
          repositoryCount={repositoryCount}
          workspaceHealth={workspaceHealth}
          activeConfig={activeConfig}
        />
        <WorkspaceActionNotice params={params} orgRuleset={orgRuleset} />

        {selectedSection === "repositories" ? (
          <>
            <RepositoryTable
              workspace={workspace}
              repositories={repositories}
              health={health}
              provisioning={provisioning}
              providerSetup={providerSetup}
              repositoryConfigs={repositoryConfigs}
              activeConfig={activeConfig}
              modelOptions={modelOptions}
              mutationsEnabled={mutationsEnabled}
              workspaceKey={workspaceKey}
              searchQuery={repositorySearchQuery}
              searchFilter={repositorySearchFilter}
              selectedRepositoryFullName={selectedRepository?.fullName ?? null}
              providerSecretCheckFailedRepositoryFullName={
                providerSecretCheckFailedRepositoryFullName || null
              }
            />
          </>
        ) : null}

        {selectedSection === "memory" ? (
          <MemoryManagementPanel
            workspace={workspace}
            repositories={repositories}
            memoryItems={memoryItems}
            memorySuggestions={memorySuggestions}
            mutationsEnabled={mutationsEnabled}
            mode={selectedMemoryMode}
            modeLinks={dashboardMemoryModeLinks(workspaceKey)}
          />
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
                    {activeInstallations.length} connected
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
                {activeInstallations.map((installation) => {
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
                      <div className="flex min-w-0 items-center gap-3">
                        <GitHubAccountAvatar
                          avatarUrl={installation.accountAvatarUrl}
                          login={installation.accountLogin}
                          size="sm"
                        />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-cyan-50">
                            {installation.accountLogin}
                          </p>
                          <p className="text-xs uppercase tracking-[0.16em] text-slate-400">
                            {formatAccountTypeLabel(installation.accountType)} /{" "}
                            {installation.status} /{" "}
                            {installation.repositorySelection}
                          </p>
                        </div>
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
                        <FormSubmitButton
                          variant="outline"
                          size="sm"
                          className="w-full sm:w-auto"
                          disabled={
                            !mutationsEnabled ||
                            installation.status !== "active"
                          }
                          idleLabel="Refresh repos"
                          pendingLabel="Refreshing..."
                        />
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
          </>
        ) : null}

        {selectedSection === "policy" ? (
          <section className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Badge tone="accent">Review model</Badge>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
                  Workspace defaults apply to every repository unless a
                  repository override is saved.
                </p>
              </div>
              <span className="font-mono text-xs uppercase tracking-[0.16em] text-slate-400">
                Workspace default
              </span>
            </div>

            <div className="rounded-2xl border border-cyan-200/10 bg-cyan-300/[0.04] p-4">
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <Badge tone="accent">Workspace default</Badge>
              </div>
              <ReviewConfigForm
                action={saveWorkspaceReviewConfigAction}
                config={activeConfig}
                modelOptions={modelOptions}
                hiddenFields={[{ name: "workspaceId", value: workspace.id }]}
                mutationsEnabled={mutationsEnabled}
                submitLabel="Save workspace default"
              />
            </div>

            {repositories.length > 0 ? (
              <details className="group mt-4 rounded-2xl border border-cyan-200/10 bg-slate-950/65 p-4">
                <summary className="cursor-pointer list-none rounded-xl outline-none transition focus-visible:ring-2 focus-visible:ring-cyan-300/40">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="accent">Repository overrides</Badge>
                      <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
                        optional per-repository provider/model/effort
                      </span>
                    </div>
                    <span className="inline-flex items-center gap-2 rounded-full border border-cyan-200/30 bg-cyan-300/[0.08] px-3 py-2 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-cyan-100 transition group-hover:border-cyan-200/50 group-hover:bg-cyan-300/[0.12]">
                      <span className="group-open:hidden">Open overrides</span>
                      <span className="hidden group-open:inline">
                        Hide overrides
                      </span>
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 16 16"
                        className="h-3.5 w-3.5 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
                        fill="none"
                      >
                        <path
                          d="M4 6l4 4 4-4"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1.8"
                        />
                      </svg>
                    </span>
                  </div>
                  <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-400">
                    Most repositories should inherit the workspace default. Open
                    this only when one repository needs a different provider,
                    model, effort, or gate.
                  </p>
                  <p className="mt-2 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-cyan-200/80 group-open:hidden">
                    Click to expand repository-specific settings
                  </p>
                </summary>
                <div className="mt-4 grid gap-3">
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
                            modelOptions={modelOptions}
                            hiddenFields={[
                              { name: "workspaceId", value: workspace.id },
                              { name: "repositoryId", value: repository.id },
                            ]}
                            mutationsEnabled={
                              mutationsEnabled &&
                              repository.selected &&
                              !repository.archived
                            }
                            repositoryFullName={repository.fullName}
                            repositorySecretCheckTarget={{
                              workspaceId: workspace.id,
                              repositoryId: repository.id,
                            }}
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
                              <FormSubmitButton
                                variant="outline"
                                size="sm"
                                disabled={
                                  !mutationsEnabled ||
                                  !repository.selected ||
                                  repository.archived
                                }
                                idleLabel="Inherit workspace default"
                                pendingLabel="Saving..."
                              />
                            </form>
                          ) : null}
                        </div>
                      </details>
                    );
                  })}
                </div>
              </details>
            ) : null}
          </section>
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
                        <FormSubmitButton
                          variant="outline"
                          size="sm"
                          disabled={
                            !mutationsEnabled || event.status !== "dead_letter"
                          }
                          idleLabel="Retry"
                          pendingLabel="Retrying..."
                        />
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
  activeConfig,
}: {
  readonly selectedSection: DashboardSection;
  readonly repositoryCount: number;
  readonly workspaceHealth: ReturnType<typeof summarizeWorkspaceHealth>;
  readonly activeConfig: ReviewConfiguration;
}): React.ReactElement {
  const meta = dashboardSectionMeta[selectedSection];
  const status =
    selectedSection === "repositories"
      ? `${repositoryCount} synced repositories`
      : selectedSection === "policy"
        ? `${activeConfig.provider.model} / ${activeConfig.provider.reasoningEffort}`
        : selectedSection === "memory"
          ? "Confirm before use"
          : selectedSection === "setup"
            ? "App connection"
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
              {workspaceHealth.needsAttention > 0 ? (
                <ReadinessInlineStat
                  label="Need attention"
                  value={workspaceHealth.needsAttention}
                  tone="danger"
                />
              ) : null}
            </div>
          ) : null}
        </div>
        {selectedSection === "repositories" ? null : (
          <div className="flex flex-wrap gap-2 xl:justify-end">
            <Badge tone={workspaceHealth.tone}>{workspaceHealth.label}</Badge>
            <Badge tone="neutral" className="max-w-full break-words">
              {status}
            </Badge>
          </div>
        )}
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
  repositories,
  health,
  provisioning,
  providerSetup,
  repositoryConfigs,
  activeConfig,
  modelOptions,
  mutationsEnabled,
  workspaceKey,
  searchQuery,
  searchFilter,
  selectedRepositoryFullName,
  providerSecretCheckFailedRepositoryFullName,
}: {
  readonly workspace: DashboardWorkspace;
  readonly repositories: DashboardWorkspaceData["repositories"];
  readonly health: DashboardWorkspaceData["health"];
  readonly provisioning: DashboardWorkspaceData["provisioning"];
  readonly providerSetup: DashboardWorkspaceData["providerSetup"];
  readonly repositoryConfigs: DashboardWorkspaceData["repositoryConfigs"];
  readonly activeConfig: ReviewConfiguration;
  readonly modelOptions: readonly ReviewModelOption[];
  readonly mutationsEnabled: boolean;
  readonly workspaceKey: string;
  readonly searchQuery: string;
  readonly searchFilter: RepositorySearchFilter;
  readonly selectedRepositoryFullName: string | null;
  readonly providerSecretCheckFailedRepositoryFullName: string | null;
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

  const repositoryConfigById = new Map(
    repositoryConfigs.map((item) => [item.repositoryId, item.config] as const),
  );
  const repositoryHealthById = new Map(
    health.map((item) => [item.repositoryId, item] as const),
  );
  const repositoryProvisioningById = new Map(
    provisioning.map((item) => [item.repositoryId, item] as const),
  );
  const configuredProviderSetupByRepositoryId = new Map<
    string,
    { readonly updatedAt: Date }
  >();
  for (const item of providerSetup) {
    if (!item.repositoryId || item.state !== "configured") continue;

    const existing = configuredProviderSetupByRepositoryId.get(
      item.repositoryId,
    );
    if (!existing || existing.updatedAt < item.updatedAt) {
      configuredProviderSetupByRepositoryId.set(item.repositoryId, {
        updatedAt: item.updatedAt,
      });
    }
  }

  const rows = repositories.map((repository) => {
    const repositoryHealth = repositoryHealthById.get(repository.id);
    const repositoryProvisioning = repositoryProvisioningById.get(
      repository.id,
    );
    const setupPullRequestUrl = safeGitHubDashboardLink(
      repositoryProvisioning?.pullRequestUrl ?? "",
    );
    const workflowCurrent = workflowSetupAlreadyCurrent(
      repositoryHealth?.status,
    );
    const providerSetupConfirmedAt = configuredProviderSetupByRepositoryId.get(
      repository.id,
    )?.updatedAt;
    const providerSecretCheckFailed =
      repository.fullName === providerSecretCheckFailedRepositoryFullName;
    const providerSetupConfirmed =
      !providerSecretCheckFailed &&
      providerSetupConfirmedAt !== undefined &&
      (!repositoryHealth?.latestActionHealthReceivedAt ||
        providerSetupConfirmedAt >=
          repositoryHealth.latestActionHealthReceivedAt);
    const setupProgressStep = repositorySetupProgressStep({
      setupStatus: repository.setupStatus,
      healthStatus: repositoryHealth?.status,
      workflowCurrent,
      providerSetupConfirmed,
    });
    const searchableText = buildRepositorySearchText({
      fullName: repository.fullName,
      owner: repository.owner,
      name: repository.name,
      defaultBranch: repository.defaultBranch,
      visibility: repository.visibility,
      stargazersCount: repository.stargazersCount,
      archived: repository.archived,
      selected: repository.selected,
      setupStatus: repository.setupStatus,
      healthStatus: repositoryHealth?.status,
      healthSummary: repositoryHealth?.summary,
    });

    return {
      repository,
      repositoryHealth,
      setupPullRequestUrl,
      workflowCurrent,
      setupProgressStep,
      searchableText,
    };
  });

  const searchIndex = rows.map(
    (row): RepositorySearchIndexItem => ({
      id: row.repository.id,
      searchText: row.searchableText,
      visibility: row.repository.visibility,
      needsSetup: row.setupProgressStep < 4,
    }),
  );
  const initialSearchTokens = tokenizeRepositorySearch(searchQuery);
  const matchingRows =
    initialSearchTokens.length === 0 && searchFilter === "all"
      ? rows
      : rows.filter(
          (row) =>
            repositoryMatchesSearchFilter(row, searchFilter) &&
            initialSearchTokens.every((token) =>
              row.searchableText.includes(token),
            ),
        );
  const selectedRow = selectedRepositoryFullName
    ? (rows.find(
        (row) => row.repository.fullName === selectedRepositoryFullName,
      ) ?? null)
    : null;
  const cappedRows = matchingRows.slice(0, MAX_RENDERED_REPOSITORY_ROWS);
  const selectedRowMatches = Boolean(
    selectedRow &&
    matchingRows.some((row) => row.repository.id === selectedRow.repository.id),
  );
  const displayRows =
    selectedRow &&
    selectedRowMatches &&
    !cappedRows.some((row) => row.repository.id === selectedRow.repository.id)
      ? [selectedRow, ...cappedRows.slice(0, MAX_RENDERED_REPOSITORY_ROWS - 1)]
      : cappedRows;
  const initiallyVisibleRepositoryIds = new Set(
    displayRows.map((row) => row.repository.id),
  );
  return (
    <div
      data-repository-table
      className="rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/62 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]"
    >
      <div className="border-b border-cyan-200/10 bg-transparent p-0">
        <RepositoryLiveSearch
          workspaceKey={workspaceKey}
          selectedRepositoryFullName={selectedRepositoryFullName}
          initialQuery={searchQuery}
          initialFilter={searchFilter}
          searchIndex={searchIndex}
          totalRepositoryCount={rows.length}
          renderedRepositoryCount={displayRows.length}
          rowLimit={MAX_RENDERED_REPOSITORY_ROWS}
        />
      </div>

      <div
        data-repository-search-loader
        hidden
        className="border-t border-cyan-200/10 px-3 py-5 text-slate-200 lg:px-6 lg:py-6"
      >
        <div className="grid gap-4">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100">
            Searching repositories
          </p>
          {Array.from({ length: 4 }, (_, index) => (
            <div
              key={index}
              className="grid gap-3 border-t border-cyan-200/10 py-5 first:border-t-0 first:pt-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="h-8 w-80 max-w-full animate-pulse rounded-full bg-slate-700/45" />
                <span className="h-8 w-16 animate-pulse rounded-full bg-slate-800/55" />
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <span className="h-8 w-28 animate-pulse rounded-full bg-slate-800/55" />
                <span className="h-8 w-20 animate-pulse rounded-full bg-slate-800/55" />
                <span className="h-9 w-40 animate-pulse rounded-xl bg-slate-800/55" />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div
        data-repository-results
        className="grid gap-3 p-3 text-slate-200 lg:gap-0 lg:p-0"
      >
        {displayRows.map(
          ({
            repository,
            setupPullRequestUrl,
            workflowCurrent,
            setupProgressStep,
          }) => {
            const repositoryConfig =
              repositoryConfigById.get(repository.id) ?? null;
            const effectiveConfig = repositoryConfig?.config ?? activeConfig;
            const repositoryUrl = githubRepositoryUrl(repository.fullName);
            const setupDisclosureId = `repo-setup-${repository.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

            return (
              <div
                key={repository.id}
                data-repository-row-id={repository.id}
                hidden={!initiallyVisibleRepositoryIds.has(repository.id)}
                className={[
                  "grid gap-4 border-t border-cyan-200/10 px-1 py-5 transition first:border-t-0 lg:px-6 lg:py-6",
                  setupProgressStep === 4
                    ? "bg-emerald-400/[0.045] hover:bg-emerald-400/[0.07]"
                    : "hover:bg-cyan-300/[0.035]",
                  repository.fullName === selectedRepositoryFullName
                    ? setupProgressStep === 4
                      ? "rounded-2xl bg-emerald-400/[0.075] px-3 lg:rounded-none"
                      : "rounded-2xl bg-cyan-300/[0.045] px-3 lg:rounded-none"
                    : "",
                ].join(" ")}
              >
                <input
                  id={setupDisclosureId}
                  type="checkbox"
                  defaultChecked={
                    repository.fullName === selectedRepositoryFullName
                  }
                  className="repository-setup-disclosure peer sr-only"
                />
                {setupProgressStep < 3 ? (
                  <RepositorySetupStatusRefresher
                    enabled
                    workspaceId={workspace.id}
                    repositoryId={repository.id}
                    disclosureId={setupDisclosureId}
                  />
                ) : null}
                <div className="repository-setup-row-header grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <RepositoryNameLink
                      fullName={repository.fullName}
                      repositoryUrl={repositoryUrl}
                      className="min-w-0 break-words text-xl font-semibold leading-tight text-cyan-50 sm:text-2xl xl:text-[1.65rem]"
                    />
                    <RepositoryStarsBadge
                      stargazersCount={repository.stargazersCount}
                    />
                  </div>
                  <div className="repository-setup-toggle-row flex flex-wrap items-center gap-2 peer-focus-visible:[&_.setup-toggle]:outline peer-focus-visible:[&_.setup-toggle]:outline-2 peer-focus-visible:[&_.setup-toggle]:outline-offset-2 peer-focus-visible:[&_.setup-toggle]:outline-cyan-200 sm:justify-end">
                    <RepositoryVisibilityBadge
                      visibility={repository.visibility}
                    />
                    <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 font-mono text-xs text-slate-300">
                      {repository.defaultBranch}
                    </span>
                    {repository.archived ? (
                      <Badge tone="warning">Archived</Badge>
                    ) : null}
                    <RepositorySetupDisclosureToggle
                      disclosureId={setupDisclosureId}
                      currentStep={setupProgressStep}
                    />
                  </div>
                </div>

                <div className="hidden peer-checked:block">
                  <div className="rounded-2xl border border-cyan-200/10 bg-slate-950/45 px-4 pb-1 pt-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] sm:px-5">
                    <RepositorySetupProgressPanel
                      workspace={workspace}
                      repository={repository}
                      setupPullRequestUrl={setupPullRequestUrl}
                      workflowCurrent={workflowCurrent}
                      mutationsEnabled={mutationsEnabled}
                      currentStep={setupProgressStep}
                    />
                  </div>
                </div>
                {setupProgressStep === 4 ? (
                  <RepositoryPolicyEditor
                    workspaceId={workspace.id}
                    repository={repository}
                    repositoryConfig={repositoryConfig}
                    effectiveConfig={effectiveConfig}
                    modelOptions={modelOptions}
                    mutationsEnabled={mutationsEnabled}
                  />
                ) : null}
              </div>
            );
          },
        )}
      </div>
    </div>
  );
}

function githubRepositoryUrl(fullName: string): string | null {
  const parts = fullName.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;

  return safeGitHubDashboardLink(
    `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  );
}

function RepositoryNameLink({
  fullName,
  repositoryUrl,
  className,
}: {
  readonly fullName: string;
  readonly repositoryUrl: string | null;
  readonly className: string;
}): React.ReactElement {
  const displayName = repositoryDisplayName(fullName);
  const classes = [
    className,
    repositoryUrl
      ? "transition hover:text-cyan-100 hover:underline hover:decoration-cyan-300/50 hover:underline-offset-4"
      : "",
  ].join(" ");

  if (!repositoryUrl) {
    return (
      <p className={classes} title={fullName}>
        {displayName}
      </p>
    );
  }

  return (
    <a
      href={repositoryUrl}
      target="_blank"
      rel="noreferrer"
      className={classes}
      title={fullName}
      aria-label={fullName}
    >
      {displayName}
    </a>
  );
}

function repositoryDisplayName(fullName: string): string {
  const [, repo] = fullName.split("/");
  return repo || fullName;
}

function RepositoryStarsBadge({
  stargazersCount,
}: {
  readonly stargazersCount: number;
}): React.ReactElement {
  const safeCount = Math.max(0, stargazersCount);

  return (
    <span
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-amber-200/20 bg-amber-200/[0.055] px-2.5 font-mono text-xs font-semibold leading-none text-amber-100/90"
      title={`${safeCount} GitHub stars`}
      aria-label={`${safeCount} GitHub stars`}
    >
      <span
        aria-hidden="true"
        className="grid h-4 w-4 place-items-center rounded-full bg-amber-100/10 text-[0.82rem] leading-none"
      >
        ★
      </span>
      <span className="leading-none">{formatRepositoryStars(safeCount)}</span>
    </span>
  );
}

function formatRepositoryStars(count: number): string {
  if (count < 1000) return String(count);

  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(count);
}

function RepositorySetupDisclosureToggle({
  disclosureId,
  currentStep,
}: {
  readonly disclosureId: string;
  readonly currentStep: 1 | 2 | 3 | 4;
}): React.ReactElement {
  const isComplete = currentStep === 4;
  return (
    <label
      htmlFor={disclosureId}
      title={repositorySetupProgressSummary(currentStep)}
      className={[
        "setup-toggle inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 font-mono text-xs font-semibold uppercase tracking-[0.12em] transition duration-200 ease-out hover:saturate-125",
        isComplete
          ? "border-emerald-300/40 bg-emerald-400/[0.09] text-emerald-100 hover:border-emerald-300/60 hover:bg-emerald-400/[0.14]"
          : "border-cyan-300/25 bg-cyan-300/[0.035] text-cyan-100 hover:border-cyan-300/50 hover:bg-cyan-300/[0.075]",
      ].join(" ")}
    >
      <span>Setup</span>
      <span
        className={[
          "text-[0.65rem] tracking-normal",
          isComplete ? "text-emerald-200/80" : "text-slate-400",
        ].join(" ")}
      >
        {currentStep}/4
      </span>
      {isComplete ? <SetupCompleteCheckIcon /> : <SetupDisclosureChevron />}
    </label>
  );
}

function RepositorySetupProgressPanel({
  workspace,
  repository,
  setupPullRequestUrl,
  workflowCurrent,
  mutationsEnabled,
  currentStep,
}: {
  readonly workspace: DashboardWorkspace;
  readonly repository: DashboardWorkspaceData["repositories"][number];
  readonly setupPullRequestUrl: string | null;
  readonly workflowCurrent: boolean;
  readonly mutationsEnabled: boolean;
  readonly currentStep: 1 | 2 | 3 | 4;
}): React.ReactElement {
  const canManage =
    mutationsEnabled && repository.selected && !repository.archived;
  const installation = findInstallationForRepository(
    workspace,
    repository.fullName,
  );
  const enableReviewAction = installation ? (
    <RepositoryProviderSecretsAction
      workspace={workspace}
      repository={repository}
      setupStatus={repository.setupStatus}
      disabled={!canManage}
      triggerVariant="outline"
      triggerClassName="min-h-11 w-full min-w-0 rounded-lg px-3 sm:w-auto sm:min-w-[9.5rem] sm:px-5"
    />
  ) : null;

  return (
    <RepositorySetupProgressPanelClient
      workspaceId={workspace.id}
      repositoryId={repository.id}
      repositoryFullName={repository.fullName}
      selected={repository.selected}
      archived={repository.archived}
      initialSetupStatus={repository.setupStatus}
      initialSetupPullRequestUrl={setupPullRequestUrl}
      workflowCurrent={workflowCurrent}
      mutationsEnabled={mutationsEnabled}
      initialStep={currentStep}
      enableReviewAction={canManage ? enableReviewAction : null}
    />
  );
}

function SetupDisclosureChevron(): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="setup-chevron h-3.5 w-3.5 shrink-0 text-cyan-100 transition-transform duration-200 ease-out motion-reduce:transition-none"
      fill="none"
    >
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SetupCompleteCheckIcon(): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0 text-emerald-200"
      fill="none"
    >
      <path
        d="M3.5 8.5l3 3 6-6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function repositorySetupProgressSummary(step: 1 | 2 | 3 | 4): string {
  switch (step) {
    case 1:
      return "1 of 4 - setup PR needed";
    case 2:
      return "2 of 4 - merge setup PR";
    case 3:
      return "3 of 4 - enable review";
    case 4:
      return "4 of 4 - complete";
  }
}

type DashboardInstallation = DashboardWorkspace["installations"][number];

type ProviderSecretGuidanceSet = {
  readonly codexOAuth: ReturnType<typeof buildProviderSecretSetupGuidance>;
  readonly codexApiKey: ReturnType<typeof buildProviderSecretSetupGuidance>;
  readonly openRouterApiKey: ReturnType<
    typeof buildProviderSecretSetupGuidance
  >;
};

function RepositoryProviderSecretsAction({
  workspace,
  repository,
  setupStatus,
  disabled,
  triggerVariant,
  triggerClassName,
}: {
  readonly workspace: DashboardWorkspace;
  readonly repository: DashboardWorkspaceData["repositories"][number];
  readonly setupStatus: string;
  readonly disabled: boolean;
  readonly triggerVariant?: "solid" | "soft" | "outline" | "ghost";
  readonly triggerClassName?: string;
}): React.ReactElement | null {
  const installation = findInstallationForRepository(
    workspace,
    repository.fullName,
  );
  if (!installation) {
    return null;
  }

  return (
    <RepositoryProviderSecretsDialog
      workspaceId={workspace.id}
      repositoryId={repository.id}
      repositoryFullName={repository.fullName}
      installation={installation}
      guidanceSet={buildProviderSecretGuidanceSet({
        repositoryFullName: repository.fullName,
        installation,
      })}
      disabled={disabled}
      triggerLabel="Enable review"
      triggerVariant={
        triggerVariant ??
        (setupStatus === "setup_pr_open" ? "solid" : "outline")
      }
      triggerSize="sm"
      triggerClassName={
        triggerClassName ??
        "w-full min-w-0 px-3 sm:w-auto sm:min-w-[9rem] sm:px-5"
      }
    />
  );
}

function RepositoryProviderSecretsDialog({
  workspaceId,
  repositoryId,
  repositoryFullName,
  installation,
  guidanceSet,
  triggerLabel,
  triggerVariant = "outline",
  triggerSize = "sm",
  triggerClassName,
  disabled = false,
}: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly installation: DashboardInstallation;
  readonly guidanceSet: ProviderSecretGuidanceSet;
  readonly triggerLabel: string;
  readonly triggerVariant?: "solid" | "soft" | "outline" | "ghost";
  readonly triggerSize?: "sm" | "md" | "lg";
  readonly triggerClassName?: string;
  readonly disabled?: boolean;
}): React.ReactElement {
  const organizationLogin =
    installation.accountType === "Organization"
      ? installation.accountLogin
      : null;

  return (
    <DialogRoot>
      <DialogTrigger
        render={
          <Button
            variant={triggerVariant}
            size={triggerSize}
            className={triggerClassName}
            disabled={disabled}
          />
        }
      >
        {triggerLabel}
      </DialogTrigger>
      <DialogPortal>
        <DialogBackdrop className="z-50" />
        <DialogPopup className="z-[60] max-h-[86vh] w-[min(96vw,58rem)] overflow-y-auto border-emerald-300/20 bg-[#061015] p-0 shadow-[0_30px_120px_rgba(0,0,0,0.62),0_0_90px_-48px_rgba(190,255,61,0.7)]">
          <DialogClose
            render={
              <button
                type="button"
                className="absolute right-4 top-4 z-10 inline-grid h-10 w-10 place-items-center rounded-full border border-cyan-200/15 bg-slate-950/75 text-cyan-100 shadow-[0_12px_40px_-30px_rgba(0,240,255,0.95)] transition hover:-translate-y-0.5 hover:border-cyan-200/35 hover:bg-cyan-300/[0.08] hover:text-cyan-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200 active:translate-y-0"
              />
            }
            aria-label="Close provider secrets dialog"
          >
            <span className="sr-only">Close</span>
            <span aria-hidden="true" className="relative h-4 w-4">
              <span className="absolute left-1/2 top-1/2 h-0.5 w-4 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-full bg-current" />
              <span className="absolute left-1/2 top-1/2 h-0.5 w-4 -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded-full bg-current" />
            </span>
          </DialogClose>
          <div className="border-b border-emerald-300/15 p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4 pr-12">
              <div className="min-w-0">
                <Badge tone="success">Provider secrets</Badge>
                <DialogTitle className="mt-3 text-xl font-semibold text-emerald-50">
                  Connect model credentials for {repositoryFullName}
                </DialogTitle>
                <DialogDescription className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
                  Merge the setup PR first, then run one command from your own
                  computer. The command connects your AI provider to{" "}
                  {repositoryFullName}; secrets are written directly to GitHub
                  Actions, while ReviewRouter SaaS stores only metadata and
                  model settings. Run it in a terminal from the{" "}
                  {repositoryFullName} repository directory.
                </DialogDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={organizationLogin ? "accent" : "neutral"}>
                  {organizationLogin
                    ? `${organizationLogin} selected repo secret`
                    : "repository secret"}
                </Badge>
              </div>
            </div>
          </div>
          <div className="p-5 sm:p-6">
            <ProviderSecretSetupChooser
              workspaceId={workspaceId}
              repositoryId={repositoryId}
              repositoryFullName={repositoryFullName}
              organizationLogin={organizationLogin}
              codexOAuthGuidance={guidanceSet.codexOAuth}
              codexApiKeyGuidance={guidanceSet.codexApiKey}
              openRouterApiKeyGuidance={guidanceSet.openRouterApiKey}
            />
          </div>
        </DialogPopup>
      </DialogPortal>
    </DialogRoot>
  );
}

function findInstallationForRepository(
  workspace: DashboardWorkspace,
  repositoryFullName: string,
): DashboardInstallation | undefined {
  const owner = repositoryFullName.split("/")[0]?.toLowerCase();
  return (
    workspace.installations.find(
      (installation) => installation.accountLogin.toLowerCase() === owner,
    ) ?? workspace.installations[0]
  );
}

function buildProviderSecretGuidanceSet({
  repositoryFullName,
  installation,
}: {
  readonly repositoryFullName: string;
  readonly installation: DashboardInstallation;
}): ProviderSecretGuidanceSet {
  const organizationLogin =
    installation.accountType === "Organization"
      ? installation.accountLogin
      : null;

  return {
    codexOAuth: buildProviderSecretSetupGuidance({
      provider: "codex_oauth",
      repoFullName: repositoryFullName,
      seedScriptUrl: resolveCodexSeedScriptUrl(),
      organizationLogin,
    }),
    codexApiKey: buildProviderSecretSetupGuidance({
      provider: "openai_api_key",
      repoFullName: repositoryFullName,
      organizationLogin,
    }),
    openRouterApiKey: buildProviderSecretSetupGuidance({
      provider: "openrouter_api_key",
      repoFullName: repositoryFullName,
      organizationLogin,
    }),
  };
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
              <GitHubAppInstallPermissionDialog
                href={permissionApprovalUrl}
                variant="outline"
                size="sm"
                continueLabel="Continue to GitHub permissions"
              >
                Review App permissions
              </GitHubAppInstallPermissionDialog>
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
  if (
    !error &&
    [
      "setup_pr_ready",
      "setup_pr_merged",
      "provider_setup_confirmed",
      "review_config_saved",
      "repository_review_config_saved",
      "repository_review_config_cleared",
    ].includes(notice)
  ) {
    return null;
  }

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

function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function readRepositorySearchFilter(
  params: Record<string, string | string[] | undefined>,
): RepositorySearchFilter {
  const setup = readParam(params.setup);
  if (setup === "needed") return "needs_setup";
  if (setup === "ready") return "ready";

  const visibility = readParam(params.visibility);
  if (visibility === "private" || visibility === "public") {
    return visibility;
  }

  return "all";
}

function buildDashboardAppInstallCallbackRedirect(
  params: Record<string, string | string[] | undefined>,
): string | null {
  const installationId = readParam(params.installation_id).trim();
  if (!installationId || !/^\d+$/.test(installationId)) return null;

  const workspace = readParam(params.workspace).trim();
  if (workspace) {
    const query = new URLSearchParams();
    copyQueryParam(query, "workspace", workspace);
    copyQueryParam(query, "section", readParam(params.section).trim());
    copyQueryParam(query, "notice", readParam(params.notice).trim());
    copyQueryParam(query, "repository", readParam(params.repository).trim());
    copyQueryParam(query, "error", readParam(params.error).trim());

    const cleanQuery = query.toString();
    return cleanQuery ? `/dashboard?${cleanQuery}` : "/dashboard";
  }

  const setupAction = readParam(params.setup_action).trim();
  if (setupAction && setupAction !== "install" && setupAction !== "update") {
    return null;
  }

  const query = new URLSearchParams({ installation_id: installationId });
  if (setupAction) query.set("setup_action", setupAction);

  return `/setup?${query.toString()}`;
}

function copyQueryParam(
  query: URLSearchParams,
  key: string,
  value: string,
): void {
  if (value) query.set(key, value);
}

function DashboardActionToast({
  params,
  secondaryAction,
}: {
  readonly params: Record<string, string | string[] | undefined>;
  readonly secondaryAction?: React.ReactNode;
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
      secondaryAction={secondaryAction}
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
      "app_installed",
      "setup_pr_ready",
      "setup_pr_merged",
      "provider_setup_confirmed",
      "workflow_already_current",
      "sync_requested",
      "sync_already_requested",
    ].includes(notice)
  ) {
    return "repositories";
  }
  if (notice === "org_ruleset_queued") {
    return "setup";
  }
  if (
    [
      "memory_saved",
      "memory_suggestion_confirmed",
      "memory_suggestion_rejected",
      "memory_disabled",
      "memory_deleted",
      "memory_duplicate",
      "memory_already_confirmed",
      "memory_already_rejected",
      "memory_already_disabled",
      "memory_already_deleted",
      "memory_noop",
    ].includes(notice)
  ) {
    return "memory";
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
  if (isMemoryError(readParam(params.error))) return "memory";
  if (readParam(params.error)) return "setup";
  return "repositories";
}

function isDashboardSection(value: string): value is DashboardSection {
  return ["repositories", "memory", "setup", "policy", "diagnostics"].includes(
    value,
  );
}

function dashboardSectionHref(
  section: DashboardSection,
  workspaceKey?: string,
): string {
  const query = new URLSearchParams({ section });
  if (workspaceKey) query.set("workspace", workspaceKey);
  return `/dashboard?${query.toString()}#dashboard-section-content`;
}

function resolveMemoryManagementMode(
  params: Record<string, string | string[] | undefined>,
): MemoryManagementMode {
  const explicit = readParam(params.memory_mode);
  if (
    explicit === "knowledge" ||
    explicit === "suggestions" ||
    explicit === "table"
  ) {
    return explicit;
  }
  if (readParam(params.status) === "pending") return "suggestions";
  return "knowledge";
}

function dashboardMemoryModeLinks(
  workspaceKey?: string,
): MemoryManagementModeLinks {
  return {
    knowledge: dashboardMemoryModeHref("knowledge", workspaceKey),
    suggestions: dashboardMemoryModeHref("suggestions", workspaceKey),
    table: dashboardMemoryModeHref("table", workspaceKey),
  };
}

function dashboardMemoryModeHref(
  mode: MemoryManagementMode,
  workspaceKey?: string,
): string {
  const query = new URLSearchParams({
    section: "memory",
    memory_mode: mode,
  });
  if (workspaceKey) query.set("workspace", workspaceKey);
  return `/dashboard?${query.toString()}#dashboard-section-content`;
}

function dashboardNoticeText(notice: string, repository: string): string {
  switch (notice) {
    case "app_installed":
      return "GitHub App is connected. Search for one repository, create the setup PR, then seed provider credentials from this dashboard.";
    case "sync_requested":
      return "Repository metadata refresh was queued. Reload in a few seconds if the repository list does not update immediately.";
    case "sync_already_requested":
      return "Repository metadata refresh was already queued for this installation recently.";
    case "setup_pr_ready":
      return repository
        ? `Setup PR is ready for ${repository}.`
        : "Setup PR is ready.";
    case "setup_pr_merged":
      return repository
        ? `Setup PR merge was confirmed for ${repository}.`
        : "Setup PR merge was confirmed.";
    case "provider_setup_confirmed":
      return repository
        ? `Provider setup was marked complete for ${repository}.`
        : "Provider setup was marked complete.";
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
    case "memory_saved":
      return "Memory was saved after policy and safety checks.";
    case "memory_suggestion_confirmed":
      return "Suggested memory was confirmed and queued for retrieval indexing.";
    case "memory_suggestion_rejected":
      return "Suggested memory was rejected and will not be used in runtime context.";
    case "memory_disabled":
      return "Memory was disabled and queued for removal from retrieval.";
    case "memory_deleted":
      return "Memory was deleted and queued for removal from retrieval.";
    case "memory_duplicate":
      return "A matching active memory already exists, so nothing was changed.";
    case "memory_already_confirmed":
    case "memory_already_rejected":
    case "memory_already_disabled":
    case "memory_already_deleted":
      return "Memory state was already up to date.";
    case "memory_noop":
      return "No memory change was needed.";
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
    case "app_installed":
      return "GitHub App installed";
    case "sync_requested":
    case "sync_already_requested":
      return "Refresh queued";
    case "setup_pr_ready":
      return "Setup PR ready";
    case "setup_pr_merged":
      return "Setup PR merged";
    case "provider_setup_confirmed":
      return "Provider setup confirmed";
    case "workflow_already_current":
      return "Workflow installed";
    case "org_ruleset_queued":
      return "Org-wide setup queued";
    case "review_config_saved":
    case "repository_review_config_saved":
    case "repository_review_config_cleared":
      return "Model settings saved";
    case "memory_saved":
      return "Memory saved";
    case "memory_suggestion_confirmed":
      return "Suggestion approved";
    case "memory_suggestion_rejected":
      return "Suggestion rejected";
    case "memory_disabled":
      return "Memory disabled";
    case "memory_deleted":
      return "Memory deleted";
    case "memory_duplicate":
      return "Duplicate skipped";
    case "memory_already_confirmed":
    case "memory_already_rejected":
    case "memory_already_disabled":
    case "memory_already_deleted":
    case "memory_noop":
      return "Memory unchanged";
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
    case "setup_pr_merged":
    case "provider_setup_confirmed":
    case "app_installed":
    case "workflow_already_current":
    case "review_config_saved":
    case "repository_review_config_saved":
    case "repository_review_config_cleared":
    case "memory_saved":
    case "memory_suggestion_confirmed":
    case "memory_suggestion_rejected":
    case "memory_disabled":
    case "memory_deleted":
      return "success";
    case "sync_already_requested":
    case "memory_duplicate":
    case "memory_already_confirmed":
    case "memory_already_rejected":
    case "memory_already_disabled":
    case "memory_already_deleted":
    case "memory_noop":
      return "accent";
    case "outbox_retry_not_found":
    case "outbox_retry_not_dead_letter":
      return "warning";
    default:
      return "accent";
  }
}

function isProviderSecretCheckError(error: string): boolean {
  return (
    error === "repository_not_visible_to_github_app" ||
    error === "provider_secret_not_found" ||
    error === "provider_secret_not_available_to_repository" ||
    error === "provider_secret_check_permission_required"
  );
}

function isMemoryError(error: string): boolean {
  return [
    "contains_code_block",
    "contains_diff_hunk",
    "contains_large_stacktrace",
    "contains_prompt_injection",
    "contains_secret_like_text",
    "memory_not_found",
    "memory_safety_blocked",
    "not_repository_maintainer",
    "not_user_owner",
    "not_workspace_admin",
    "permission_service_unavailable",
    "repository_unavailable",
    "too_long",
    "unsafe_for_user_prefs",
  ].includes(error);
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
    case "dashboard_action_failed":
      return "The dashboard could not complete this action. Refresh and try again.";
    case "server_misconfigured":
      return "Server setup is incomplete. Check GitHub App credentials and the public ReviewRouter API URL.";
    case "repository_not_selected":
      return "This repository is no longer selected for the GitHub App installation.";
    case "repository_archived":
      return "Archived repositories cannot be provisioned.";
    case "installation_not_active":
      return "The GitHub App installation is not active.";
    case "setup_pr_not_merged":
      return "GitHub does not show the workflow on the default branch yet. If you just merged the setup PR, wait a few seconds; the dashboard will advance automatically when GitHub metadata catches up.";
    case "repository_not_visible_to_github_app":
      return "The GitHub App installation cannot read this repository. Update App repository access or sync repositories, then try again.";
    case "provider_secret_not_found":
      return "GitHub does not show the required Actions secret yet. Run the command, then try again.";
    case "provider_secret_not_available_to_repository":
      return "The organization Actions secret exists, but it is not available to this repository. Add this repository to the selected-repository secret access, then try again.";
    case "provider_secret_check_permission_required":
      return "ReviewRouter needs GitHub App Secrets: read for repository secrets, or Organization secrets: read for organization secrets, to verify Actions secret metadata. Approve the App permission update, then try again.";
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
    case "not_repository_maintainer":
      return "Only repository maintainers or workspace admins can confirm repository memory.";
    case "not_workspace_admin":
      return "Only workspace admins can change workspace memory.";
    case "not_user_owner":
      return "User preference memory can only be changed by that user.";
    case "repository_unavailable":
      return "This repository is not available for memory changes. It may be archived, unselected, or outside the workspace.";
    case "memory_not_found":
      return "Memory was not found in this workspace.";
    case "contains_secret_like_text":
      return "Memory was blocked because it looks like it contains a secret.";
    case "contains_code_block":
    case "contains_diff_hunk":
      return "Memory was blocked because code or diffs must not be stored.";
    case "contains_large_stacktrace":
      return "Memory was blocked because stack traces must not be stored as memory.";
    case "contains_prompt_injection":
      return "Memory was blocked because it looks like prompt-injection text.";
    case "too_long":
      return "Memory is too long. Save a short distilled preference or rule instead.";
    case "unsafe_for_user_prefs":
      return "User preference memory can only store safe response preferences, not repository-specific facts.";
    case "permission_service_unavailable":
    case "memory_safety_blocked":
      return "Memory policy blocked this change. Refresh and try again with a safer distilled memory.";
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
