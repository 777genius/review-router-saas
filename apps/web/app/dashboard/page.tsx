import type { Metadata } from "next";
import { Badge, LinkButton, SelectField } from "@reviewrouter/ui";
import {
  isCodexRotatingOAuthAllowedForRepository,
  isClaudeCodeProviderEnabled,
  resolveReviewRouterActionRef,
} from "@reviewrouter/platform-config";
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
import {
  defaultOrgRulesetSourceRepositoryName,
  PrismaOrgRulesetProvisioningRepository,
} from "@reviewrouter/features-org-ruleset-provisioning";
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
  EntitlementMemoryPolicyConfig,
  EntitlementMemoryQuotaPolicy,
  PrismaMemoryPermission,
  PrismaMemoryItemRepository,
  PrismaMemorySuggestionRepository,
  readMemoryServiceEnabled,
  simulateMemoryPolicyDecision,
  type MemoryActor,
  type MemoryDashboardItemDto,
  type MemoryDashboardSuggestionDto,
  type MemoryPolicySimulationDecision,
} from "@reviewrouter/features-memory";
import {
  getWorkspaceSupportDiagnostics,
  PrismaSupportDiagnosticsRepository,
} from "@reviewrouter/features-support-diagnostics";
import {
  canDashboardActorConfigureRepository,
  canDashboardActorMutateRepository,
  createGitHubAppInstallationOctokit,
  getDashboardMutationStatus,
  getDashboardSignedInActor,
  getDashboardWorkspaceScope,
  type DashboardMutationActor,
} from "../../src/server/dashboard-mutations";
import {
  listGitHubUserRepositoryAccess,
  type GitHubUserRepositoryAccessStatus,
} from "../../src/server/github-user-repository-access";
import { getPrisma } from "../../src/server/prisma";
import {
  refreshRepositoryAccessClientAction,
  requestInstallationSyncClientAction,
  retryOutboxEventClientAction,
  enableOrgRulesetWorkflowClientAction,
} from "./actions";
import { getGitHubAppInstallUrl } from "../../src/server/github-app-install-url";
import {
  buildPendingOrganizationInstallRequest,
  type PendingOrganizationInstallRequest,
} from "../../src/server/dashboard-app-install-request";
import { safeGitHubDashboardLink } from "../../src/server/safe-dashboard-link";
import type { WorkspaceHealthSummary } from "../../src/server/repository-health-view";
import {
  buildRepositorySearchText,
  repositoryMatchesSearchFilter,
  repositorySearchReadiness,
  repositorySetupProgressStep,
  tokenizeRepositorySearch,
  workflowSetupAlreadyCurrent,
} from "../../src/server/repository-search";
import {
  getReviewModelOptions,
  type ReviewModelOption,
} from "../../src/server/openrouter-model-catalog";
import { FormSubmitButton } from "../form-submit-button";
import { GitHubAppInstallPermissionDialog } from "../github-app-install-permission-dialog";
import { GitHubAccountAvatar } from "../github-account-avatar";
import { GitHubSignInButton } from "../github-sign-in-button";
import { ActionToast } from "../action-toast";
import { RepositoryVisibilityBadge } from "../repository-visibility-badge";
import { DashboardInstallRequestToast } from "./dashboard-install-request-toast";
import { DashboardSectionTabs } from "./dashboard-section-tabs";
import { DashboardWorkspaceTabs } from "./dashboard-workspace-tabs";
import { ProviderSecretSetupDialog } from "./provider-secret-setup-dialog";
import {
  RepositoryLiveSearch,
  type RepositorySearchFilter,
  type RepositorySearchIndexItem,
} from "./repository-live-search";
import {
  RepositorySetupDisclosureToggle,
  RepositorySetupReadyGate,
  RepositorySetupRowDisclosureController,
} from "./repository-setup-optimistic-status";
import { RepositorySetupProgressPanel as RepositorySetupProgressPanelClient } from "./repository-setup-progress-panel";
import {
  RepositoryPolicyEditor,
  RepositoryPolicyOverrideDetails,
  WorkspaceReviewConfigForm,
} from "./repository-policy-editor";
import { RepositorySetupStatusRefresher } from "./repository-setup-status-refresher";
import {
  MemoryManagementPanel,
  type MemoryManagementMode,
  type MemoryManagementModeLinks,
} from "./memory-management-panel";
import { DashboardCollapsibleShell } from "./dashboard-collapsible-shell";
import { DashboardActionForm } from "./dashboard-action-form";
import {
  buildInstallationSettingsUrl,
  dashboardErrorText,
  dashboardNoticeText,
  dashboardNoticeTitle,
  dashboardNoticeTone,
  formatAccountTypeLabel,
  isMemoryError,
  isProviderSecretCheckError,
  isSetupRecoveryIssue,
  orgRulesetErrorText,
  orgRulesetStatusTone,
  readCsvEnv,
  workspaceInstallSummary,
} from "./dashboard-copy";
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
    readonly organizationSecretPolicy: DashboardOrganizationSecretPolicy | null;
  }[];
  readonly auditEvents: readonly {
    readonly action: string;
    readonly actor: string;
    readonly targetType: string;
    readonly createdAt: Date;
  }[];
};

type DashboardOrganizationSecretPolicy = {
  readonly planName: string | null;
  readonly privateRepositoriesAvailable: boolean | null;
  readonly status: "available" | "permission_required" | "unknown";
};

async function loadDashboardData(
  scope: Awaited<ReturnType<typeof getDashboardWorkspaceScope>>,
  repositoryAccess: DashboardRepositoryAccessScope,
  supportAudit?: {
    readonly actor: string;
    readonly reason: "local_admin_override" | "workspace_admin";
  },
  currentActor?: {
    readonly githubUserId: string;
    readonly githubLogin: string;
  } | null,
) {
  if (scope.kind === "none" && repositoryAccess.workspaceIds.length === 0) {
    return [];
  }
  if (
    scope.kind === "workspace_ids" &&
    scope.workspaceIds.length === 0 &&
    repositoryAccess.workspaceIds.length === 0
  ) {
    return [];
  }

  const prisma = getPrisma();
  const workspaceIds = mergeWorkspaceIds(
    scope.kind === "workspace_ids" ? scope.workspaceIds : [],
    repositoryAccess.workspaceIds,
  );
  const workspaceWhere =
    scope.kind === "all" ? undefined : { id: { in: workspaceIds } };
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
  const memoryPermission = new PrismaMemoryPermission(prisma, {
    localAdminGithubLogins: readCsvEnv(
      "REVIEW_ROUTER_LOCAL_ADMIN_GITHUB_LOGINS",
    ),
  });
  const memoryQuotaPolicy = new EntitlementMemoryQuotaPolicy(entitlementStore);
  const memoryPolicyConfig = new EntitlementMemoryPolicyConfig(
    entitlementStore,
    { serviceEnabled: readMemoryServiceEnabled(process.env) },
  );

  const dashboardData = await Promise.all(
    workspaces.map(
      async (
        workspace,
      ): Promise<{
        hasWorkspaceWideAccess: boolean;
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
        > | null;
        orgRuleset: Awaited<
          ReturnType<typeof orgRulesetStore.findByWorkspaceId>
        > | null;
        memoryItems: readonly MemoryDashboardItemDto[];
        memorySuggestions: readonly MemoryDashboardSuggestionDto[];
        memoryWritesEnabled: boolean;
        memoryPolicySimulation:
          | readonly MemoryPolicySimulationDecision[]
          | null;
      }> => {
        const repositories = await repositoryStore.listWorkspaceRepositories(
          workspace.id,
        );
        const hasWorkspaceWideAccess =
          scope.kind === "all" ||
          (scope.kind === "workspace_ids" &&
            scope.workspaceIds.includes(workspace.id));
        const visibleRepositories = hasWorkspaceWideAccess
          ? repositories
          : repositories.filter((repository) =>
              repositoryAccess.repositoryIds.has(repository.id),
            );
        const visibleRepositoryIds = new Set(
          visibleRepositories.map((repository) => repository.id),
        );
        const entitlement =
          (await entitlementStore.findWorkspaceEntitlement(workspace.id)) ??
          freeBetaEntitlement(workspace.id);
        const health = (
          await listWorkspaceRepositoryHealth(
            {
              workspaceId: workspace.id,
              expectedActionRef: resolveReviewRouterActionRef(),
              workflowProbeMaxRepositories: 0,
            },
            { repositories: healthStore },
          )
        ).filter((item) => visibleRepositoryIds.has(item.repositoryId));
        const reviewConfig = await findReviewConfiguration(
          { scope: "workspace", workspaceId: workspace.id },
          { configurations: reviewConfigStore },
        );
        const repositoryConfigs = await Promise.all(
          visibleRepositories.map(async (repository) => ({
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
        const outboxFailures = hasWorkspaceWideAccess
          ? await listWorkspaceOutboxFailures(
              { workspaceId: workspace.id, limit: 5 },
              { outbox: outboxStore },
            )
          : [];
        const provisioning = await listRepositoryWorkflowProvisioning(
          {
            workspaceId: workspace.id,
            repositoryIds: visibleRepositories.map(
              (repository) => repository.id,
            ),
          },
          { provisioning: new PrismaWorkflowProvisioningQuery(prisma) },
        );
        const providerSetup = await prisma.providerSetupState.findMany({
          where: {
            workspaceId: workspace.id,
            repositoryId: {
              in: visibleRepositories.map((repository) => repository.id),
            },
          },
          select: {
            repositoryId: true,
            state: true,
            updatedAt: true,
          },
        });
        const supportDiagnostics = hasWorkspaceWideAccess
          ? await getWorkspaceSupportDiagnostics(
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
            )
          : null;
        const orgRuleset = hasWorkspaceWideAccess
          ? await orgRulesetStore.findByWorkspaceId(workspace.id)
          : null;
        const visibleRepositoryOwners = new Set(
          visibleRepositories.map((repository) =>
            repository.owner.toLowerCase(),
          ),
        );
        const visibleInstallations = hasWorkspaceWideAccess
          ? workspace.installations
          : workspace.installations.filter((installation) =>
              visibleRepositoryOwners.has(
                installation.accountLogin.toLowerCase(),
              ),
            );
        const dashboardInstallations = await Promise.all(
          visibleInstallations.map(async (installation) => ({
            ...installation,
            githubInstallationId: installation.githubInstallationId.toString(),
            organizationSecretPolicy: hasWorkspaceWideAccess
              ? await loadOrganizationSecretPolicy(installation)
              : null,
          })),
        );
        const [memoryItems, memorySuggestions, memoryPolicy] =
          await Promise.all([
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
            memoryPolicyConfig.getPolicy({ workspaceId: workspace.id }),
          ]);
        const memoryPolicySimulation = await buildMemoryPolicySimulation({
          workspaceId: workspace.id,
          repositories,
          actor: currentActor ?? null,
          memoryPolicyConfig,
          memoryPermission,
          memoryItemStore,
          memorySuggestionStore,
          memoryQuotaPolicy,
        });

        return {
          hasWorkspaceWideAccess,
          workspace: {
            id: workspace.id,
            name: workspace.name,
            slug: workspace.slug,
            installations: dashboardInstallations,
            auditEvents: hasWorkspaceWideAccess ? workspace.auditEvents : [],
          },
          repositoryCount: hasWorkspaceWideAccess
            ? repositories.length
            : visibleRepositories.length,
          repositories: visibleRepositories,
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
          memoryWritesEnabled: memoryPolicy.memoryEnabled,
          memoryPolicySimulation,
        };
      },
    ),
  );

  return dashboardData.sort(compareDashboardWorkspaces);
}

async function buildMemoryPolicySimulation(input: {
  readonly workspaceId: string;
  readonly repositories: readonly {
    readonly id: string;
    readonly selected: boolean;
    readonly archived: boolean;
  }[];
  readonly actor: {
    readonly githubUserId: string;
    readonly githubLogin: string;
  } | null;
  readonly memoryPolicyConfig: EntitlementMemoryPolicyConfig;
  readonly memoryPermission: PrismaMemoryPermission;
  readonly memoryItemStore: PrismaMemoryItemRepository;
  readonly memorySuggestionStore: PrismaMemorySuggestionRepository;
  readonly memoryQuotaPolicy: EntitlementMemoryQuotaPolicy;
}): Promise<readonly MemoryPolicySimulationDecision[] | null> {
  if (!input.actor) return null;

  const actor: MemoryActor = {
    kind: "github_user",
    id: `github:${input.actor.githubUserId}`,
    githubUserId: input.actor.githubUserId,
    login: input.actor.githubLogin,
  };
  const adminDecision = await input.memoryPermission.canConfirmMemory({
    workspaceId: input.workspaceId,
    repositoryId: null,
    userId: null,
    scope: "workspace",
    actor,
  });
  if (!adminDecision.allowed) return null;

  const repository =
    input.repositories.find(
      (candidate) => candidate.selected && !candidate.archived,
    ) ??
    input.repositories.find((candidate) => !candidate.archived) ??
    null;
  const now = new Date();
  const dependencies = {
    memoryPolicyConfig: input.memoryPolicyConfig,
    memoryPermissions: input.memoryPermission,
    memoryItems: input.memoryItemStore,
    memorySuggestions: input.memorySuggestionStore,
    memoryQuotaPolicy: input.memoryQuotaPolicy,
  };

  return Promise.all([
    simulateMemoryPolicyDecision(
      {
        workspaceId: input.workspaceId,
        repositoryId: null,
        userId: null,
        scope: "workspace",
        actor,
        action: "direct_save",
        safetyFixture: "safe_project_rule",
        now,
      },
      dependencies,
    ),
    simulateMemoryPolicyDecision(
      {
        workspaceId: input.workspaceId,
        repositoryId: repository?.id ?? null,
        userId: null,
        scope: "repository",
        actor,
        action: "direct_save",
        safetyFixture: "safe_project_rule",
        now,
      },
      dependencies,
    ),
    simulateMemoryPolicyDecision(
      {
        workspaceId: input.workspaceId,
        repositoryId: repository?.id ?? null,
        userId: null,
        scope: "repository",
        actor,
        action: "propose_suggestion",
        safetyFixture: "prompt_injection",
        now,
      },
      dependencies,
    ),
    simulateMemoryPolicyDecision(
      {
        workspaceId: input.workspaceId,
        repositoryId: null,
        userId: actor.id,
        scope: "user_prefs",
        actor,
        action: "direct_save",
        safetyFixture: "safe_user_preference",
        now,
      },
      dependencies,
    ),
  ]);
}

async function loadOrganizationSecretPolicy(input: {
  readonly accountLogin: string;
  readonly accountType: string;
  readonly githubInstallationId: bigint;
}): Promise<DashboardOrganizationSecretPolicy | null> {
  if (input.accountType !== "Organization") {
    return null;
  }

  try {
    const octokit = await createGitHubAppInstallationOctokit(
      input.githubInstallationId.toString(),
    );
    const response = await octokit.request("GET /orgs/{org}", {
      org: input.accountLogin,
    });
    const plan = (response.data as { readonly plan?: unknown }).plan;
    const planName = readGitHubOrganizationPlanName(plan);

    return {
      planName,
      privateRepositoriesAvailable: planName ? planName !== "free" : null,
      status: planName ? "available" : "unknown",
    };
  } catch (error) {
    const status = githubApiStatus(error);
    return {
      planName: null,
      privateRepositoriesAvailable: null,
      status:
        status === 401 || status === 403 ? "permission_required" : "unknown",
    };
  }
}

function readGitHubOrganizationPlanName(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    value.name.trim().length > 0
  ) {
    return value.name.trim().toLowerCase();
  }

  return null;
}

function githubApiStatus(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }

  return null;
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

type DashboardRepositoryAccessScope = {
  readonly status: GitHubUserRepositoryAccessStatus;
  readonly workspaceIds: readonly string[];
  readonly repositoryIds: ReadonlySet<string>;
  readonly directConfigRepositoryIds: ReadonlySet<string>;
  readonly checkedAt: Date | null;
  readonly errorCode?: string;
};

async function listDashboardRepositoryAccess(input: {
  readonly actor: DashboardMutationActor | null;
  readonly workspaceScope: Awaited<
    ReturnType<typeof getDashboardWorkspaceScope>
  >;
  readonly requestedRepositoryFullName: string;
}): Promise<DashboardRepositoryAccessScope> {
  const actor = input.actor;
  if (!actor || input.workspaceScope.kind === "all") {
    return emptyDashboardRepositoryAccess();
  }

  const fullAccessWorkspaceIds =
    input.workspaceScope.kind === "workspace_ids"
      ? input.workspaceScope.workspaceIds
      : [];
  const prisma = getPrisma();
  const discovered = await listGitHubUserRepositoryAccess({
    prisma,
    actor,
    excludedWorkspaceIds: fullAccessWorkspaceIds,
  });
  const requestedRepositoryFullName = normalizeRequestedRepositoryFullName(
    input.requestedRepositoryFullName,
  );
  if (discovered.status !== "ready" || !requestedRepositoryFullName) {
    return discovered;
  }

  const candidateWhere = {
    selected: true,
    archived: false,
    installation: { status: "active" },
    ...(fullAccessWorkspaceIds.length > 0
      ? { workspaceId: { notIn: [...fullAccessWorkspaceIds] } }
      : {}),
  } as const;
  const requestedCandidates = requestedRepositoryFullName
    ? await prisma.repositoryConnection.findMany({
        where: {
          ...candidateWhere,
          fullName: requestedRepositoryFullName,
        },
        select: {
          id: true,
          workspaceId: true,
          githubRepositoryId: true,
          owner: true,
          name: true,
          installation: { select: { githubInstallationId: true } },
        },
      })
    : [];
  const candidates = dedupeRepositoryAccessCandidates(requestedCandidates);
  const allowed = await Promise.all(
    candidates.map(async (repository) => {
      const allowed = await canDashboardActorMutateRepository({
        actor,
        repository,
      });
      const canConfigure = allowed
        ? await canDashboardActorConfigureRepository({
            actor,
            repository,
          })
        : false;

      return { repository, allowed, canConfigure };
    }),
  );
  const repositoryIds = new Set<string>(
    discovered.status === "ready" ? [...discovered.repositoryIds] : [],
  );
  const directConfigRepositoryIds = new Set<string>(
    discovered.status === "ready"
      ? [...discovered.directConfigRepositoryIds]
      : [],
  );
  const workspaceIds = new Set<string>(
    discovered.status === "ready" ? discovered.workspaceIds : [],
  );

  for (const item of allowed) {
    if (!item.allowed) continue;
    repositoryIds.add(item.repository.id);
    workspaceIds.add(item.repository.workspaceId);
    if (item.canConfigure) {
      directConfigRepositoryIds.add(item.repository.id);
    }
  }

  return {
    status: discovered.status,
    workspaceIds: [...workspaceIds],
    repositoryIds,
    directConfigRepositoryIds,
    checkedAt: discovered.checkedAt,
    ...(discovered.errorCode ? { errorCode: discovered.errorCode } : {}),
  };
}

function dedupeRepositoryAccessCandidates<T extends { readonly id: string }>(
  repositories: readonly T[],
): T[] {
  return [
    ...new Map(
      repositories.map((repository) => [repository.id, repository]),
    ).values(),
  ];
}

function emptyDashboardRepositoryAccess(
  status: GitHubUserRepositoryAccessStatus = "ready",
): DashboardRepositoryAccessScope {
  return {
    status,
    workspaceIds: [],
    repositoryIds: new Set<string>(),
    directConfigRepositoryIds: new Set<string>(),
    checkedAt: null,
  };
}

function mergeWorkspaceIds(
  left: readonly string[],
  right: readonly string[],
): string[] {
  return [...new Set([...left, ...right])];
}

function normalizeRequestedRepositoryFullName(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return null;
  }

  return trimmed;
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
  const requestedRepositoryFullName = readParam(params.repository);

  const [mutationStatus, workspaceScope] = await Promise.all([
    getDashboardMutationStatus(),
    getDashboardWorkspaceScope(),
  ]);
  const signedInActor = await getDashboardSignedInActor();
  const repositoryAccess = await listDashboardRepositoryAccess({
    actor: signedInActor,
    workspaceScope,
    requestedRepositoryFullName,
  });

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
    loadDashboardData(
      workspaceScope,
      repositoryAccess,
      supportAudit,
      mutationStatus.githubUserId && mutationStatus.githubLogin
        ? {
            githubUserId: mutationStatus.githubUserId,
            githubLogin: mutationStatus.githubLogin,
          }
        : null,
    ),
    getReviewModelOptions(),
  ]);
  const workspaces = filterVisibleDashboardWorkspaces(dashboardData);
  const appInstallUrl = getGitHubAppInstallUrl();
  const selectedSection = resolveDashboardSection(params);
  const pendingOrganizationInstallRequest =
    buildPendingOrganizationInstallRequest(params);

  if (workspaces.length === 0) {
    if (mutationStatus.signedIn) {
      return (
        <>
          <DashboardInstallRequestToast
            request={pendingOrganizationInstallRequest}
          />
          <DashboardActionToast params={params} />
          <DashboardEmptyAccessState
            repositoryAccess={repositoryAccess}
            githubLogin={mutationStatus.githubLogin}
            githubAvatarUrl={mutationStatus.githubAvatarUrl}
            appInstallUrl={appInstallUrl}
          />
        </>
      );
    }

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
  const claudeCodeProviderEnabled = isClaudeCodeProviderEnabled();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 md:py-10">
      <WorkspaceSwitcher
        workspaces={workspaces}
        selectedWorkspaceId={selectedWorkspace.workspace.id}
        selectedSection={selectedSection}
        appInstallUrl={appInstallUrl}
        pendingOrganizationInstallRequest={pendingOrganizationInstallRequest}
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
          repositoryAccess={repositoryAccess}
          workspaceKey={selectedWorkspaceKey}
          appInstallUrl={appInstallUrl}
          modelOptions={modelOptions}
          claudeCodeProviderEnabled={claudeCodeProviderEnabled}
          fallbackUser={{
            githubLogin: mutationStatus.githubLogin,
            githubAvatarUrl: mutationStatus.githubAvatarUrl,
          }}
        />
      </section>
    </main>
  );
}

function DashboardEmptyAccessState({
  repositoryAccess,
  githubLogin,
  githubAvatarUrl,
  appInstallUrl,
}: {
  readonly repositoryAccess: DashboardRepositoryAccessScope;
  readonly githubLogin: string | null;
  readonly githubAvatarUrl: string | null;
  readonly appInstallUrl: string | null;
}): React.ReactElement {
  const copy = dashboardRepositoryAccessEmptyCopy(repositoryAccess.status);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 md:py-10">
      <section className="rounded-[2rem] border border-cyan-300/[0.12] bg-[var(--rr-surface-card-strong)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.42),0_0_90px_-54px_rgba(0,240,255,0.9)] backdrop-blur-2xl sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={copy.tone}>{copy.badge}</Badge>
          {githubLogin ? (
            <GitHubAccountAvatar
              login={githubLogin}
              avatarUrl={githubAvatarUrl}
              size="sm"
            />
          ) : null}
        </div>
        <div className="mt-6 max-w-3xl space-y-3">
          <h1 className="text-3xl font-extrabold leading-tight text-cyan-50 sm:text-5xl">
            {copy.title}
          </h1>
          <p className="text-sm leading-6 text-slate-300 sm:text-base">
            {copy.body}
          </p>
          {repositoryAccess.errorCode ? (
            <p className="text-xs leading-5 text-slate-500">
              Status: <code>{repositoryAccess.errorCode}</code>
            </p>
          ) : null}
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          {copy.reconnect ? (
            <GitHubSignInButton
              callbackUrl="/dashboard"
              variant="solid"
              size="lg"
              className="rounded-2xl"
            >
              Reconnect GitHub
            </GitHubSignInButton>
          ) : null}
          {appInstallUrl ? (
            <LinkButton
              href={appInstallUrl}
              variant={copy.reconnect ? "outline" : "solid"}
              size="lg"
              className="rounded-2xl"
            >
              Install GitHub App
            </LinkButton>
          ) : null}
          <RepositoryAccessRefreshForm
            triggerLabel="Refresh GitHub access"
            size="lg"
            className="rounded-2xl"
          />
        </div>
      </section>
    </main>
  );
}

function RepositoryAccessRefreshForm({
  workspaceKey,
  section,
  triggerLabel = "Refresh access",
  size = "sm",
  className = "",
}: {
  readonly workspaceKey?: string;
  readonly section?: DashboardSection;
  readonly triggerLabel?: string;
  readonly size?: "sm" | "md" | "lg";
  readonly className?: string;
}): React.ReactElement {
  return (
    <DashboardActionForm
      action={refreshRepositoryAccessClientAction}
      fallbackParams={{
        error: "dashboard_action_failed",
        ...(workspaceKey ? { workspace: workspaceKey } : {}),
        ...(section ? { section } : {}),
      }}
    >
      {workspaceKey ? (
        <input type="hidden" name="workspace" value={workspaceKey} />
      ) : null}
      {section ? <input type="hidden" name="section" value={section} /> : null}
      <FormSubmitButton
        variant="outline"
        size={size}
        className={className}
        idleLabel={triggerLabel}
        pendingLabel="Refreshing..."
      />
    </DashboardActionForm>
  );
}

function RepositoryAccessRefreshNotice({
  repositoryAccess,
  workspaceKey,
  selectedSection,
}: {
  readonly repositoryAccess: DashboardRepositoryAccessScope;
  readonly workspaceKey: string;
  readonly selectedSection: DashboardSection;
}): React.ReactElement {
  const copy = repositoryAccessNoticeCopy(repositoryAccess.status);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-cyan-200/10 bg-slate-950/60 p-4">
      <div className="min-w-0">
        <Badge tone={copy.tone}>{copy.badge}</Badge>
        <p className="mt-2 text-sm font-semibold leading-6 text-cyan-50">
          {copy.title}
        </p>
        <p className="mt-2 text-sm leading-6 text-slate-300">{copy.body}</p>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          {repositoryAccess.checkedAt
            ? `Last checked ${repositoryAccess.checkedAt.toISOString()}`
            : "Access has not been cached yet."}
        </p>
      </div>
      <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:justify-end">
        {copy.reconnect ? (
          <GitHubSignInButton
            callbackUrl={dashboardSectionHref(selectedSection, workspaceKey)}
            variant="solid"
            size="sm"
            className="w-full rounded-xl sm:w-auto"
          >
            Reconnect GitHub
          </GitHubSignInButton>
        ) : null}
        <RepositoryAccessRefreshForm
          workspaceKey={workspaceKey}
          section={selectedSection}
          triggerLabel="Refresh GitHub access"
          className="w-full sm:w-auto"
        />
      </div>
    </div>
  );
}

function repositoryAccessNoticeCopy(status: GitHubUserRepositoryAccessStatus): {
  readonly badge: string;
  readonly title: string;
  readonly body: string;
  readonly reconnect: boolean;
  readonly tone: "accent" | "warning";
} {
  if (status === "token_missing") {
    return {
      badge: "GitHub reconnect required",
      title: "Signed in, but repository discovery is not connected yet.",
      body: "Reconnect GitHub once so ReviewRouter can discover installed organization repositories where your GitHub role has write, maintain, or admin access.",
      reconnect: true,
      tone: "warning",
    };
  }
  if (
    status === "token_revoked" ||
    status === "token_expired" ||
    status === "token_refresh_failed" ||
    status === "token_decryption_failed"
  ) {
    return {
      badge: "GitHub authorization expired",
      title: "Reconnect GitHub to refresh repository access.",
      body: "Your GitHub authorization is no longer usable for repository discovery. Reconnecting updates the token without asking for provider secrets.",
      reconnect: true,
      tone: "warning",
    };
  }
  if (status === "token_encryption_misconfigured") {
    return {
      badge: "Configuration required",
      title: "Repository discovery is not enabled yet.",
      body: "Server token encryption is not configured, so repo-scoped discovery cannot store GitHub user tokens safely.",
      reconnect: false,
      tone: "warning",
    };
  }
  if (status === "github_error") {
    return {
      badge: "GitHub access",
      title: "GitHub repository access could not be refreshed.",
      body: "Try refreshing access again shortly. Existing workspace access still works, but repo-scoped organizations may be missing until GitHub discovery succeeds.",
      reconnect: false,
      tone: "warning",
    };
  }

  return {
    badge: "GitHub access",
    title: "Repository access is scoped by GitHub permissions.",
    body: "Repository visibility comes from your GitHub App authorization and is limited to repos where your GitHub role has write, maintain, or admin access.",
    reconnect: false,
    tone: "accent",
  };
}

function dashboardRepositoryAccessEmptyCopy(
  status: GitHubUserRepositoryAccessStatus,
): {
  readonly badge: string;
  readonly title: string;
  readonly body: string;
  readonly reconnect: boolean;
  readonly tone: "accent" | "warning" | "success";
} {
  if (status === "token_missing") {
    return {
      badge: "GitHub reconnect required",
      title: "Reconnect GitHub to show repositories you can manage.",
      body: "ReviewRouter needs the GitHub App user authorization from your sign-in to discover installed repositories where you have write, maintain, or admin access.",
      reconnect: true,
      tone: "warning",
    };
  }
  if (
    status === "token_revoked" ||
    status === "token_expired" ||
    status === "token_refresh_failed" ||
    status === "token_decryption_failed"
  ) {
    return {
      badge: "GitHub authorization expired",
      title: "Reconnect GitHub to refresh repository access.",
      body: "Your GitHub authorization is no longer usable for repository discovery. Reconnecting updates the token without asking for provider secrets.",
      reconnect: true,
      tone: "warning",
    };
  }
  if (status === "token_encryption_misconfigured") {
    return {
      badge: "Configuration required",
      title: "Repository discovery is not enabled yet.",
      body: "Set REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY so ReviewRouter can store GitHub user tokens encrypted at rest. Until then, workspace admins can still use the dashboard, but maintainer repository discovery is disabled.",
      reconnect: false,
      tone: "warning",
    };
  }
  if (status === "github_error") {
    return {
      badge: "GitHub API unavailable",
      title: "Repository access could not be refreshed.",
      body: "GitHub did not return the installation repository list. Retry in a moment; ReviewRouter will not expand access while the check is unavailable.",
      reconnect: false,
      tone: "warning",
    };
  }

  return {
    badge: "No repositories found",
    title: "No installed repositories with write access found.",
    body: "Install the GitHub App on a repository where your GitHub account has write, maintain, or admin access, then return to the dashboard.",
    reconnect: false,
    tone: "accent",
  };
}

function WorkspaceSwitcher({
  workspaces,
  selectedWorkspaceId,
  selectedSection,
  appInstallUrl,
  pendingOrganizationInstallRequest,
  fallbackUser,
}: {
  readonly workspaces: readonly DashboardWorkspaceData[];
  readonly selectedWorkspaceId: string;
  readonly selectedSection: DashboardSection;
  readonly appInstallUrl: string | null;
  readonly pendingOrganizationInstallRequest: PendingOrganizationInstallRequest | null;
  readonly fallbackUser: {
    readonly githubLogin: string | null;
    readonly githubAvatarUrl: string | null;
  };
}): React.ReactElement | null {
  if (
    workspaces.length < 2 &&
    !appInstallUrl &&
    !pendingOrganizationInstallRequest
  ) {
    return null;
  }

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
      ...(workspace.hasWorkspaceWideAccess
        ? {}
        : { statusLabel: "Repo access" }),
      href: dashboardSectionHref(selectedSection, workspaceKey),
    };
  });
  const pendingTab = pendingOrganizationInstallRequest
    ? {
        id: pendingOrganizationInstallRequest.id,
        label: pendingOrganizationInstallRequest.accountLogin,
        href: dashboardSectionHref(selectedSection),
        statusLabel: "Request pending",
      }
    : null;

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
        {items.length > 1 || pendingTab ? (
          <DashboardWorkspaceTabs
            items={items}
            selectedWorkspaceId={selectedWorkspaceId}
            pendingInstallRequest={pendingTab}
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
  readonly workspaceHealth: WorkspaceHealthSummary;
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
  repositoryAccess,
  workspaceKey,
  appInstallUrl,
  modelOptions,
  claudeCodeProviderEnabled,
  fallbackUser,
}: {
  readonly data: DashboardWorkspaceData;
  readonly mutationsEnabled: boolean;
  readonly selectedSection: DashboardSection;
  readonly params: Record<string, string | string[] | undefined>;
  readonly repositoryAccess: DashboardRepositoryAccessScope;
  readonly workspaceKey: string;
  readonly appInstallUrl: string | null;
  readonly modelOptions: readonly ReviewModelOption[];
  readonly claudeCodeProviderEnabled: boolean;
  readonly fallbackUser: {
    readonly githubLogin: string | null;
    readonly githubAvatarUrl: string | null;
  };
}): React.ReactElement {
  const {
    hasWorkspaceWideAccess,
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
    memoryWritesEnabled,
    memoryPolicySimulation,
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
          allowOrganizationSecrets: hasWorkspaceWideAccess,
        })
      : null;
  const workspaceHealth = summarizeWorkspaceSetupReadiness({
    repositories,
    health,
    providerSetup,
    providerSecretCheckFailedRepositoryFullName,
  });
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
        repositoryVisibility={selectedRepository.visibility}
        installation={selectedInstallation}
        guidanceSet={providerGuidanceSet}
        allowOrganizationSecrets={hasWorkspaceWideAccess}
        claudeCodeProviderEnabled={claudeCodeProviderEnabled}
        triggerLabel="Enable review"
        triggerVariant="solid"
        triggerSize="sm"
        triggerClassName="rounded-xl"
      />
    ) : null;

  return (
    <DashboardCollapsibleShell
      defaultCollapsed={selectedSection === "memory"}
      nav={
        <DashboardSectionNav
          workspace={workspace}
          repositoryCount={repositoryCount}
          workspaceHealth={workspaceHealth}
          selectedSection={selectedSection}
          workspaceKey={workspaceKey}
          fallbackUser={fallbackUser}
        />
      }
    >
      <div
        id="dashboard-section-content"
        className="min-w-0 space-y-5 scroll-mt-28"
      >
        <DashboardInstallRequestToast
          request={buildPendingOrganizationInstallRequest(params)}
        />
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
        {!hasWorkspaceWideAccess || repositoryAccess.status !== "ready" ? (
          <RepositoryAccessRefreshNotice
            repositoryAccess={repositoryAccess}
            workspaceKey={workspaceKey}
            selectedSection={selectedSection}
          />
        ) : null}
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
              claudeCodeProviderEnabled={claudeCodeProviderEnabled}
              mutationsEnabled={mutationsEnabled}
              workspaceKey={workspaceKey}
              searchQuery={repositorySearchQuery}
              searchFilter={repositorySearchFilter}
              selectedRepositoryFullName={selectedRepository?.fullName ?? null}
              providerSecretCheckFailedRepositoryFullName={
                providerSecretCheckFailedRepositoryFullName || null
              }
              directConfigRepositoryIds={
                hasWorkspaceWideAccess
                  ? null
                  : repositoryAccess.directConfigRepositoryIds
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
            memoryWritesEnabled={memoryWritesEnabled}
            policySimulation={memoryPolicySimulation}
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
                      {hasWorkspaceWideAccess ? (
                        <DashboardActionForm
                          action={requestInstallationSyncClientAction}
                          fallbackParams={{
                            error: "dashboard_action_failed",
                            workspace: workspace.id,
                            section: "repositories",
                          }}
                          refresh={false}
                        >
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
                        </DashboardActionForm>
                      ) : (
                        <p className="rounded-xl border border-cyan-200/10 bg-slate-950/55 p-3 text-xs leading-5 text-slate-400">
                          You can manage repositories where your GitHub role has
                          write, maintain, or admin access. Workspace sync and
                          organization-wide controls are available to workspace
                          owners and admins.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </details>

            {hasWorkspaceWideAccess ? (
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
            ) : null}
          </>
        ) : null}

        {selectedSection === "policy" ? (
          <section className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Badge tone="accent">Review model</Badge>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
                  {hasWorkspaceWideAccess
                    ? "Workspace defaults apply to every repository unless a repository override is saved."
                    : "Direct provider, model, reasoning, and gate edits require maintain or admin access on that repository."}
                </p>
              </div>
              <span className="font-mono text-xs uppercase tracking-[0.16em] text-slate-400">
                {hasWorkspaceWideAccess
                  ? "Workspace default"
                  : "Repository access"}
              </span>
            </div>

            {hasWorkspaceWideAccess ? (
              <div className="rounded-2xl border border-cyan-200/10 bg-cyan-300/[0.04] p-4">
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <Badge tone="accent">Workspace default</Badge>
                </div>
                <WorkspaceReviewConfigForm
                  workspaceId={workspace.id}
                  config={activeConfig}
                  modelOptions={modelOptions}
                  claudeCodeProviderEnabled={claudeCodeProviderEnabled}
                  mutationsEnabled={mutationsEnabled}
                />
              </div>
            ) : null}

            {repositories.length > 0 ? (
              <details
                className="group mt-4 rounded-2xl border border-cyan-200/10 bg-slate-950/65 p-4"
                open={!hasWorkspaceWideAccess || undefined}
              >
                <summary className="cursor-pointer list-none rounded-xl outline-none transition focus-visible:ring-2 focus-visible:ring-cyan-300/40">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="accent">
                        {hasWorkspaceWideAccess
                          ? "Repository overrides"
                          : "Repository settings"}
                      </Badge>
                      <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
                        optional per-repository provider/model/effort
                      </span>
                    </div>
                    <span className="inline-flex items-center gap-2 rounded-full border border-cyan-200/30 bg-cyan-300/[0.08] px-3 py-2 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-cyan-100 transition group-hover:border-cyan-200/50 group-hover:bg-cyan-300/[0.12]">
                      {hasWorkspaceWideAccess ? (
                        <>
                          <span className="group-open:hidden">
                            Open overrides
                          </span>
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
                        </>
                      ) : (
                        "Repository access"
                      )}
                    </span>
                  </div>
                  <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-400">
                    {hasWorkspaceWideAccess
                      ? "Most repositories should inherit the workspace default. Open this only when one repository needs a different provider, model, effort, or gate."
                      : "Changes here affect only the repository you edit. They do not change workspace defaults or other repositories."}
                  </p>
                  <p className="mt-2 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-cyan-200/80 group-open:hidden">
                    Click to expand repository-specific settings
                  </p>
                </summary>
                <div className="mt-4 grid gap-3">
                  {repositories.map((repository) => {
                    const repositoryConfig =
                      repositoryConfigs.find(
                        (item) => item.repositoryId === repository.id,
                      )?.config ?? null;
                    const effectiveConfig =
                      repositoryConfig?.config ?? activeConfig;
                    const configVersion =
                      repositoryConfig?.version ?? activeConfigVersion;
                    const canEditRepositorySettings =
                      hasWorkspaceWideAccess ||
                      repositoryAccess.directConfigRepositoryIds.has(
                        repository.id,
                      );

                    return (
                      <RepositoryPolicyOverrideDetails
                        key={`${repository.id}-review-config`}
                        workspaceId={workspace.id}
                        repository={repository}
                        repositoryConfig={repositoryConfig}
                        effectiveConfig={effectiveConfig}
                        configVersion={configVersion}
                        modelOptions={modelOptions}
                        codexRotatingOAuthEnabled={isCodexRotatingOAuthEnabledForRepository(
                          repository,
                        )}
                        claudeCodeProviderEnabled={claudeCodeProviderEnabled}
                        mutationsEnabled={
                          mutationsEnabled && canEditRepositorySettings
                        }
                        editDisabledReason={
                          canEditRepositorySettings
                            ? undefined
                            : "Maintain or admin access is required to change repo settings directly."
                        }
                      />
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
          <div className="rounded-xl border border-cyan-200/10 bg-slate-950/50 p-4 text-sm leading-6 text-slate-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge tone="neutral">Public repo default</Badge>
              <span className="font-mono text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Fork PR protection
              </span>
            </div>
            <p>
              Fork pull request reviews are skipped by default when a
              secret-backed provider is used. This keeps provider secrets out of
              untrusted fork code paths; maintainers can add a trusted rerun
              flow later.
            </p>
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
                <div className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-6">
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
                  <SupportMetric
                    label="Memory"
                    value={`${supportDiagnostics.memoryCounts.items.active}/${supportDiagnostics.memoryCounts.items.total} active`}
                    hint={`${supportDiagnostics.memoryCounts.suggestions.pending} pending / ${supportDiagnostics.memoryCounts.index.pending} indexing`}
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

            {hasWorkspaceWideAccess ? (
              <>
                <div className="rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/60 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
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
                          <DashboardActionForm
                            action={retryOutboxEventClientAction}
                            fallbackParams={{
                              error: "dashboard_action_failed",
                              workspace: workspace.id,
                              section: "diagnostics",
                            }}
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
                            <FormSubmitButton
                              variant="outline"
                              size="sm"
                              disabled={
                                !mutationsEnabled ||
                                event.status !== "dead_letter"
                              }
                              idleLabel="Retry"
                              pendingLabel="Retrying..."
                            />
                          </DashboardActionForm>
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
                    <p className="text-sm text-slate-400">
                      No audit events yet.
                    </p>
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
          </>
        ) : null}
      </div>
    </DashboardCollapsibleShell>
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
  readonly workspaceHealth: WorkspaceHealthSummary;
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

function summarizeWorkspaceSetupReadiness({
  repositories,
  health,
  providerSetup,
  providerSecretCheckFailedRepositoryFullName,
}: {
  readonly repositories: DashboardWorkspaceData["repositories"];
  readonly health: DashboardWorkspaceData["health"];
  readonly providerSetup: DashboardWorkspaceData["providerSetup"];
  readonly providerSecretCheckFailedRepositoryFullName: string | null;
}): WorkspaceHealthSummary {
  const repositoryHealthById = new Map(
    health.map((item) => [item.repositoryId, item] as const),
  );
  const configuredProviderSetupByRepositoryId =
    buildConfiguredProviderSetupByRepositoryId(providerSetup);
  const counts = repositories.reduce(
    (accumulator, repository) => {
      const repositoryHealth = repositoryHealthById.get(repository.id);
      const workflowCurrent = workflowSetupAlreadyCurrent(
        repositoryHealth?.status,
      );
      const setupProgressStep = repositorySetupProgressStep({
        setupStatus: repository.setupStatus,
        healthStatus: repositoryHealth?.status,
        workflowCurrent,
        providerSetupConfirmed: isRepositoryProviderSetupConfirmed({
          repository,
          repositoryHealth,
          configuredProviderSetupByRepositoryId,
          providerSecretCheckFailedRepositoryFullName,
        }),
      });
      const readiness = repositorySearchReadiness({
        setupProgressStep,
        healthStatus: repositoryHealth?.status,
      });

      if (readiness === "ready") accumulator.ready += 1;
      else if (readiness === "needs_attention") accumulator.needsAttention += 1;
      else accumulator.needsSetup += 1;
      return accumulator;
    },
    { ready: 0, needsSetup: 0, needsAttention: 0, unknown: 0 },
  );

  if (repositories.length === 0) {
    return {
      ...counts,
      label: "No repositories synced",
      tone: "neutral",
    };
  }
  if (counts.needsAttention > 0) {
    return {
      ...counts,
      label: `${counts.needsAttention} need attention`,
      tone: "danger",
    };
  }
  if (counts.needsSetup > 0) {
    return {
      ...counts,
      label: `${counts.needsSetup} need setup`,
      tone: "warning",
    };
  }
  return {
    ...counts,
    label: "All synced repos ready",
    tone: "success",
  };
}

function buildConfiguredProviderSetupByRepositoryId(
  providerSetup: DashboardWorkspaceData["providerSetup"],
): ReadonlyMap<string, { readonly updatedAt: Date }> {
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

  return configuredProviderSetupByRepositoryId;
}

function isRepositoryProviderSetupConfirmed({
  repository,
  repositoryHealth,
  configuredProviderSetupByRepositoryId,
  providerSecretCheckFailedRepositoryFullName,
}: {
  readonly repository: DashboardWorkspaceData["repositories"][number];
  readonly repositoryHealth:
    | DashboardWorkspaceData["health"][number]
    | undefined;
  readonly configuredProviderSetupByRepositoryId: ReadonlyMap<
    string,
    { readonly updatedAt: Date }
  >;
  readonly providerSecretCheckFailedRepositoryFullName: string | null;
}): boolean {
  const providerSetupConfirmedAt = configuredProviderSetupByRepositoryId.get(
    repository.id,
  )?.updatedAt;
  const providerSecretCheckFailed =
    repository.fullName === providerSecretCheckFailedRepositoryFullName;

  return (
    !providerSecretCheckFailed &&
    providerSetupConfirmedAt !== undefined &&
    (!repositoryHealth?.latestActionHealthReceivedAt ||
      providerSetupConfirmedAt >= repositoryHealth.latestActionHealthReceivedAt)
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
  claudeCodeProviderEnabled,
  mutationsEnabled,
  workspaceKey,
  searchQuery,
  searchFilter,
  selectedRepositoryFullName,
  providerSecretCheckFailedRepositoryFullName,
  directConfigRepositoryIds,
}: {
  readonly workspace: DashboardWorkspace;
  readonly repositories: DashboardWorkspaceData["repositories"];
  readonly health: DashboardWorkspaceData["health"];
  readonly provisioning: DashboardWorkspaceData["provisioning"];
  readonly providerSetup: DashboardWorkspaceData["providerSetup"];
  readonly repositoryConfigs: DashboardWorkspaceData["repositoryConfigs"];
  readonly activeConfig: ReviewConfiguration;
  readonly modelOptions: readonly ReviewModelOption[];
  readonly claudeCodeProviderEnabled: boolean;
  readonly mutationsEnabled: boolean;
  readonly workspaceKey: string;
  readonly searchQuery: string;
  readonly searchFilter: RepositorySearchFilter;
  readonly selectedRepositoryFullName: string | null;
  readonly providerSecretCheckFailedRepositoryFullName: string | null;
  readonly directConfigRepositoryIds: ReadonlySet<string> | null;
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
  const configuredProviderSetupByRepositoryId =
    buildConfiguredProviderSetupByRepositoryId(providerSetup);

  const rows = repositories.map((repository) => {
    const repositoryHealth = repositoryHealthById.get(repository.id);
    const repositoryProvisioning = repositoryProvisioningById.get(
      repository.id,
    );
    const setupPullRequestUrl = safeGitHubDashboardLink(
      repositoryProvisioning?.pullRequestUrl ?? "",
    );
    const setupIssue = repositoryProvisioning?.errorMessage ?? null;
    const workflowCurrent = workflowSetupAlreadyCurrent(
      repositoryHealth?.status,
    );
    const setupProgressStep = repositorySetupProgressStep({
      setupStatus: repository.setupStatus,
      healthStatus: repositoryHealth?.status,
      workflowCurrent,
      setupNeedsAttention: isSetupRecoveryIssue(setupIssue),
      providerSetupConfirmed: isRepositoryProviderSetupConfirmed({
        repository,
        repositoryHealth,
        configuredProviderSetupByRepositoryId,
        providerSecretCheckFailedRepositoryFullName,
      }),
    });
    const readiness = repositorySearchReadiness({
      setupProgressStep,
      healthStatus: repositoryHealth?.status,
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
      setupIssue,
      workflowCurrent,
      setupProgressStep,
      readiness,
      searchableText,
    };
  });

  const searchIndex = rows.map(
    (row): RepositorySearchIndexItem => ({
      id: row.repository.id,
      searchText: row.searchableText,
      visibility: row.repository.visibility,
      readiness: row.readiness,
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
        role="status"
        aria-live="polite"
        aria-label="Loading updated repository results"
        className="border-t border-cyan-200/10 bg-cyan-300/[0.025] px-3 py-5 text-slate-200 lg:px-6 lg:py-6"
      >
        <div className="grid gap-4">
          <p className="inline-flex w-fit items-center gap-2 rounded-full border border-cyan-300/25 bg-cyan-300/[0.075] px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-cyan-100 shadow-[0_0_38px_-30px_rgba(103,232,249,0.95)]">
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent"
            />
            Loading updated results
          </p>
          <div aria-hidden="true" className="grid gap-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div
                key={index}
                className="grid gap-3 border-t border-cyan-200/10 py-5 first:border-t-0 first:pt-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="h-8 w-80 max-w-full animate-pulse rounded-full bg-cyan-100/12" />
                  <span className="h-8 w-16 animate-pulse rounded-full bg-slate-700/45" />
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <span className="h-8 w-28 animate-pulse rounded-full bg-slate-700/45" />
                  <span className="h-8 w-20 animate-pulse rounded-full bg-slate-800/55" />
                  <span className="h-9 w-40 animate-pulse rounded-xl bg-slate-800/55" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div data-repository-results className="grid text-slate-200">
        <RepositorySetupRowDisclosureController />
        {displayRows.map(
          (
            {
              repository,
              setupPullRequestUrl,
              setupIssue,
              workflowCurrent,
              setupProgressStep,
            },
            rowIndex,
          ) => {
            const repositoryConfig =
              repositoryConfigById.get(repository.id) ?? null;
            const effectiveConfig = repositoryConfig?.config ?? activeConfig;
            const canEditRepositorySettings =
              directConfigRepositoryIds === null ||
              directConfigRepositoryIds.has(repository.id);
            const repositoryUrl = githubRepositoryUrl(repository.fullName);
            const setupDisclosureId = `repo-setup-${repository.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
            const isSelectedRepository =
              repository.fullName === selectedRepositoryFullName;
            const rowStripeClass = (() => {
              if (isSelectedRepository) {
                return setupProgressStep === 4
                  ? "bg-emerald-400/[0.075]"
                  : "bg-cyan-300/[0.045]";
              }
              if (setupProgressStep === 4) {
                return rowIndex % 2 === 0
                  ? "bg-emerald-400/[0.04] hover:bg-emerald-400/[0.07]"
                  : "bg-emerald-300/[0.07] hover:bg-emerald-300/[0.095]";
              }
              return rowIndex % 2 === 0
                ? "bg-slate-950/[0.2] hover:bg-cyan-300/[0.035]"
                : "bg-cyan-300/[0.035] hover:bg-cyan-300/[0.06]";
            })();

            return (
              <div
                key={repository.id}
                data-repository-row-id={repository.id}
                data-repository-setup-row
                data-disclosure-id={setupDisclosureId}
                hidden={!initiallyVisibleRepositoryIds.has(repository.id)}
                className={[
                  "grid cursor-pointer gap-4 border-t border-cyan-200/10 px-4 py-5 transition-colors first:border-t-0 lg:px-6 lg:py-6",
                  rowStripeClass,
                ].join(" ")}
              >
                <input
                  id={setupDisclosureId}
                  type="checkbox"
                  defaultChecked={isSelectedRepository}
                  className="repository-setup-disclosure peer sr-only"
                />
                {repository.setupStatus === "setup_pr_open" ? (
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
                    {repository.archived ? (
                      <Badge tone="warning">Archived</Badge>
                    ) : null}
                    <RepositorySetupDisclosureToggle
                      repositoryId={repository.id}
                      disclosureId={setupDisclosureId}
                      currentStep={setupProgressStep}
                    />
                  </div>
                </div>

                <div
                  className="hidden peer-checked:block"
                  data-repository-setup-panel
                >
                  <div className="rounded-2xl border border-cyan-200/10 bg-slate-950/45 px-4 pb-1 pt-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] sm:px-5">
                    <RepositorySetupProgressPanel
                      workspace={workspace}
                      repository={repository}
                      setupPullRequestUrl={setupPullRequestUrl}
                      setupIssue={setupIssue}
                      workflowCurrent={workflowCurrent}
                      mutationsEnabled={mutationsEnabled}
                      claudeCodeProviderEnabled={claudeCodeProviderEnabled}
                      allowOrganizationSecrets={
                        directConfigRepositoryIds === null
                      }
                      currentStep={setupProgressStep}
                    />
                  </div>
                </div>
                <RepositorySetupReadyGate
                  repositoryId={repository.id}
                  currentStep={setupProgressStep}
                >
                  <RepositoryPolicyEditor
                    workspaceId={workspace.id}
                    repository={repository}
                    repositoryConfig={repositoryConfig}
                    effectiveConfig={effectiveConfig}
                    modelOptions={modelOptions}
                    codexRotatingOAuthEnabled={isCodexRotatingOAuthEnabledForRepository(
                      repository,
                    )}
                    claudeCodeProviderEnabled={claudeCodeProviderEnabled}
                    mutationsEnabled={
                      mutationsEnabled && canEditRepositorySettings
                    }
                    editDisabledReason={
                      canEditRepositorySettings
                        ? undefined
                        : "Maintain or admin access is required to change repo settings directly."
                    }
                  />
                </RepositorySetupReadyGate>
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
      className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs font-semibold leading-none text-amber-100/90"
      title={`${safeCount} GitHub stars`}
      aria-label={`${safeCount} GitHub stars`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5 shrink-0 translate-y-px fill-amber-300 text-amber-300"
      >
        <path d="M8 1.6 9.9 5.5l4.3.6-3.1 3 0.7 4.3L8 11.4l-3.8 2 0.7-4.3-3.1-3 4.3-.6L8 1.6Z" />
      </svg>
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

function RepositorySetupProgressPanel({
  workspace,
  repository,
  setupPullRequestUrl,
  setupIssue,
  workflowCurrent,
  mutationsEnabled,
  claudeCodeProviderEnabled,
  allowOrganizationSecrets,
  currentStep,
}: {
  readonly workspace: DashboardWorkspace;
  readonly repository: DashboardWorkspaceData["repositories"][number];
  readonly setupPullRequestUrl: string | null;
  readonly setupIssue: string | null;
  readonly workflowCurrent: boolean;
  readonly mutationsEnabled: boolean;
  readonly claudeCodeProviderEnabled: boolean;
  readonly allowOrganizationSecrets: boolean;
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
      claudeCodeProviderEnabled={claudeCodeProviderEnabled}
      allowOrganizationSecrets={allowOrganizationSecrets}
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
      initialSetupIssue={setupIssue}
      workflowCurrent={workflowCurrent}
      mutationsEnabled={mutationsEnabled}
      initialStep={currentStep}
      enableReviewAction={canManage ? enableReviewAction : null}
    />
  );
}

type DashboardInstallation = DashboardWorkspace["installations"][number];

type ProviderSecretGuidanceSet = {
  readonly codexOAuthRotating: ReturnType<
    typeof buildProviderSecretSetupGuidance
  >;
  readonly codexOAuth: ReturnType<typeof buildProviderSecretSetupGuidance>;
  readonly codexApiKey: ReturnType<typeof buildProviderSecretSetupGuidance>;
  readonly claudeCodeOAuth: ReturnType<typeof buildProviderSecretSetupGuidance>;
  readonly openRouterApiKey: ReturnType<
    typeof buildProviderSecretSetupGuidance
  >;
};

function RepositoryProviderSecretsAction({
  workspace,
  repository,
  setupStatus,
  disabled,
  claudeCodeProviderEnabled,
  allowOrganizationSecrets,
  triggerVariant,
  triggerClassName,
}: {
  readonly workspace: DashboardWorkspace;
  readonly repository: DashboardWorkspaceData["repositories"][number];
  readonly setupStatus: string;
  readonly disabled: boolean;
  readonly claudeCodeProviderEnabled: boolean;
  readonly allowOrganizationSecrets: boolean;
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
      repositoryVisibility={repository.visibility}
      installation={installation}
      guidanceSet={buildProviderSecretGuidanceSet({
        repositoryFullName: repository.fullName,
        installation,
        allowOrganizationSecrets,
      })}
      allowOrganizationSecrets={allowOrganizationSecrets}
      claudeCodeProviderEnabled={claudeCodeProviderEnabled}
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
  repositoryVisibility,
  installation,
  guidanceSet,
  allowOrganizationSecrets,
  claudeCodeProviderEnabled,
  triggerLabel,
  triggerVariant = "outline",
  triggerSize = "sm",
  triggerClassName,
  disabled = false,
}: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly repositoryVisibility: string;
  readonly installation: DashboardInstallation;
  readonly guidanceSet: ProviderSecretGuidanceSet;
  readonly allowOrganizationSecrets: boolean;
  readonly claudeCodeProviderEnabled: boolean;
  readonly triggerLabel: string;
  readonly triggerVariant?: "solid" | "soft" | "outline" | "ghost";
  readonly triggerSize?: "sm" | "md" | "lg";
  readonly triggerClassName?: string;
  readonly disabled?: boolean;
}): React.ReactElement {
  const organizationLogin =
    allowOrganizationSecrets && installation.accountType === "Organization"
      ? installation.accountLogin
      : null;
  const organizationSecretPolicy = allowOrganizationSecrets
    ? installation.organizationSecretPolicy
    : null;
  const codexRotatingOAuthEnabled = isCodexRotatingOAuthEnabledForRepository({
    fullName: repositoryFullName,
    visibility: repositoryVisibility,
  });
  const effectiveGuidanceSet = codexRotatingOAuthEnabled
    ? guidanceSet
    : {
        ...guidanceSet,
        codexOAuthRotating: {
          ...guidanceSet.codexOAuthRotating,
          commands: [],
          warnings: [
            "Rotating Codex OAuth is not enabled for this ReviewRouter deployment.",
          ],
        },
      };

  return (
    <ProviderSecretSetupDialog
      workspaceId={workspaceId}
      repositoryId={repositoryId}
      repositoryFullName={repositoryFullName}
      repositoryVisibility={repositoryVisibility}
      organizationLogin={organizationLogin}
      organizationSecretPolicy={organizationSecretPolicy}
      guidanceSet={effectiveGuidanceSet}
      codexRotatingOAuthEnabled={codexRotatingOAuthEnabled}
      claudeCodeProviderEnabled={claudeCodeProviderEnabled}
      triggerLabel={triggerLabel}
      triggerVariant={triggerVariant}
      triggerSize={triggerSize}
      triggerClassName={triggerClassName}
      disabled={disabled}
    />
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

function isCodexRotatingOAuthEnabledForRepository(repository: {
  readonly fullName: string;
  readonly visibility: string;
}): boolean {
  return isCodexRotatingOAuthAllowedForRepository(repository.fullName);
}

function buildProviderSecretGuidanceSet({
  repositoryFullName,
  installation,
  allowOrganizationSecrets,
}: {
  readonly repositoryFullName: string;
  readonly installation: DashboardInstallation;
  readonly allowOrganizationSecrets: boolean;
}): ProviderSecretGuidanceSet {
  const organizationLogin =
    allowOrganizationSecrets && installation.accountType === "Organization"
      ? installation.accountLogin
      : null;

  return {
    codexOAuthRotating:
      buildCodexRotatingPlaceholderGuidance(repositoryFullName),
    codexOAuth: buildDisabledLegacyCodexGuidance("codex_oauth"),
    codexApiKey: buildDisabledLegacyCodexGuidance("openai_api_key"),
    claudeCodeOAuth: buildProviderSecretSetupGuidance({
      provider: "claude_code_oauth",
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

function buildDisabledLegacyCodexGuidance(
  provider: "codex_oauth" | "openai_api_key",
): ReturnType<typeof buildProviderSecretSetupGuidance> {
  return {
    provider,
    recommendedScope: "repository",
    commands: [],
    warnings: [
      "Legacy Codex setup is disabled. Reconnect Codex from the ReviewRouter dashboard to use rotating OAuth.",
    ],
  };
}

function buildCodexRotatingPlaceholderGuidance(
  repositoryFullName: string,
): ProviderSecretGuidanceSet["codexOAuthRotating"] {
  return {
    provider: "codex_oauth_rotating",
    recommendedScope: "repository",
    commands: [],
    warnings: [
      `Rotating Codex OAuth setup for ${repositoryFullName} is minted on demand with a short-lived nonce.`,
    ],
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
  const organizationPlanName =
    organizationInstallation.organizationSecretPolicy?.planName ?? null;
  const rulesetsUnavailableByPlan = organizationPlanName === "free";
  const permissionMissing =
    permissionUpgradeNeeded ||
    orgRuleset?.safeErrorCode === "org_admin_permission_required" ||
    orgRuleset?.safeErrorCode === "org_ruleset_permission_update_pending";
  const rulesetUrl = safeGitHubDashboardLink(orgRuleset?.rulesetUrl ?? "");
  const permissionApprovalUrl =
    buildInstallationSettingsUrl(organizationInstallation) ?? appInstallUrl;
  const sourceRepositoryFullName = `${organizationInstallation.accountLogin}/${defaultOrgRulesetSourceRepositoryName}`;

  return (
    <details className="rounded-[1.5rem] border border-amber-300/20 bg-amber-300/[0.08] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
      <summary className="cursor-pointer list-none">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <div>
            <Badge tone={rulesetsUnavailableByPlan ? "neutral" : "warning"}>
              {rulesetsUnavailableByPlan
                ? "Plan upgrade required"
                : "Advanced org-wide mode"}
            </Badge>
            <p className="mt-2 text-sm leading-6 text-amber-50">
              Enable a GitHub Organization Ruleset required workflow for many
              repositories without opening setup PRs in every repo. Default
              onboarding stays per-repository setup PR.
            </p>
          </div>
          <Badge
            tone={
              rulesetsUnavailableByPlan
                ? "neutral"
                : orgRulesetStatusTone(orgRuleset?.status)
            }
          >
            {rulesetsUnavailableByPlan
              ? "unavailable"
              : orgRuleset?.status
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
          {rulesetsUnavailableByPlan ? (
            <div className="mt-4 rounded-xl border border-cyan-200/15 bg-cyan-300/[0.06] p-4 text-cyan-50">
              <p className="font-semibold">
                Organization-wide required workflows are not available on the
                current GitHub Free plan.
              </p>
              <p className="mt-2 text-slate-300">
                GitHub requires a paid organization plan, Team or Enterprise, to
                use organization rulesets for private repositories. Until this
                organization is upgraded, use per-repository setup PRs from the
                repositories list. After the upgrade, create{" "}
                <strong className="text-cyan-100">
                  {sourceRepositoryFullName}
                </strong>{" "}
                and enable org-wide mode here.
              </p>
              <LinkButton
                href={dashboardSectionHref(
                  "repositories",
                  dashboardWorkspaceUrlKey(workspace),
                )}
                variant="outline"
                size="sm"
                className="mt-3"
              >
                Open repositories
              </LinkButton>
            </div>
          ) : (
            <div className="mt-3 text-slate-300">
              <p>Manual source setup before enabling org-wide mode:</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                <li>
                  Create the private source repository{" "}
                  <strong className="text-amber-100">
                    {sourceRepositoryFullName}
                  </strong>
                  .
                </li>
                <li>
                  In that repository, open Settings - Actions - General - Access
                  and choose Accessible from repositories in{" "}
                  <strong className="text-amber-100">
                    {organizationInstallation.accountLogin}
                  </strong>{" "}
                  organization.
                </li>
                <li>
                  Make sure the ReviewRouter GitHub App installation includes
                  that source repository.
                </li>
              </ol>
            </div>
          )}
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

        {rulesetsUnavailableByPlan ? null : (
          <div className="rounded-2xl border border-amber-200/10 bg-slate-950/55 p-4">
            <DashboardActionForm
              action={enableOrgRulesetWorkflowClientAction}
              fallbackParams={{
                error: "dashboard_action_failed",
                workspace: workspace.id,
                section: "setup",
              }}
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
                    description:
                      "Safer default, matches App repository access.",
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
                    description:
                      "Blocks according to GitHub required workflow.",
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
            </DashboardActionForm>

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
        )}
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
  const rawError = readParam(params.error);
  const error =
    rawError === "org_admin_permission_required" &&
    orgRuleset?.safeErrorCode === "org_rulesets_not_supported"
      ? "org_rulesets_not_supported"
      : rawError;
  if (!error) return null;

  const pullRequestUrl = safeGitHubDashboardLink(readParam(params.pr));

  return (
    <div
      className={[
        "rounded-2xl border p-4 text-sm leading-6",
        "border-red-300/25 bg-red-300/10 text-red-50",
      ].join(" ")}
    >
      <div className="grid gap-3 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center">
        <Badge tone="danger">Action failed</Badge>
        <p>{dashboardErrorText(error)}</p>
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
  if (setup === "attention") return "needs_attention";
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

const dashboardNoticeToastSearchParams = [
  "notice",
  "version",
  "pr",
  "error",
] as const;
const dashboardErrorToastSearchParams = [
  "error",
  "notice",
  "version",
  "pr",
] as const;

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
  const selectedSection = resolveDashboardSection(params);

  if (error) {
    return (
      <ActionToast
        tone="danger"
        title="Action needs attention"
        body={dashboardErrorText(error)}
        clearUrlSearchParams={dashboardErrorToastSearchParams}
        setUrlSearchParams={{ section: selectedSection }}
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
      clearUrlSearchParams={dashboardNoticeToastSearchParams}
      setUrlSearchParams={{ section: selectedSection }}
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
      "repository_access_refreshed",
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
