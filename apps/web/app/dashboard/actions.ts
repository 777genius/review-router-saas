"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  recordAuditEvent,
  PrismaAuditLogRepository,
} from "@reviewrouter/features-audit-log";
import {
  assertWorkspaceFeatureEntitlement,
  PrismaEntitlementRepository,
  type EntitlementFeature,
} from "@reviewrouter/features-entitlements";
import { OutboxInstallationSyncRequester } from "@reviewrouter/features-github-installations";
import {
  PrismaOutboxEventRepository,
  retryDeadLetterOutboxEvent,
} from "@reviewrouter/features-outbox";
import {
  OctokitOrgRulesetSetupGateway,
  PrismaOrgRulesetProvisioningRepository,
  requestOrgRulesetProvisioning,
  type OrgRulesetEnforcement,
  type OrgRulesetScope,
} from "@reviewrouter/features-org-ruleset-provisioning";
import {
  clearReviewConfiguration,
  PrismaReviewConfigurationRepository,
  resolveReviewRuntimeEnv,
  type ResolvedReviewRuntimeEnv,
  saveReviewConfiguration,
  type ReviewConfiguration,
} from "@reviewrouter/features-review-config";
import {
  confirmMemorySuggestion,
  createDashboardMemorySource,
  deleteMemoryItem,
  disableMemoryItem,
  editMemoryItem,
  rejectMemorySuggestion,
  rememberMemoryDirectly,
  type MemoryMutationResult,
  type MemoryScope,
} from "@reviewrouter/features-memory";
import {
  getProviderSecretNames,
  providerAuthModeBelongsToKind,
  providerAuthModeSchema,
  providerKindForAuthMode,
  providerKindSchema,
  type ProviderAuthMode,
  type ProviderKind,
} from "@reviewrouter/features-review-providers";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  isConflictReviewFallbackAllowedForRepository,
  isWorkflowProvisioningEnabled,
  resolveReviewRouterActionRef,
} from "@reviewrouter/platform-config";
import { OctokitRepositoryWorkflowProbe } from "@reviewrouter/features-repo-health";
import {
  defaultWorkflowPath,
  OctokitWorkflowSetupGateway,
  PrismaWorkflowProvisioningRepository,
  PrismaWorkflowProvisioningTarget,
  provisionRepositoryReviewRouterWorkflow,
} from "@reviewrouter/features-workflow-provisioning";
import type { ProviderSecretScope } from "@reviewrouter/features-provider-setup";
import { PostgresLeaseLock } from "@reviewrouter/platform-locks";
import {
  assertDashboardMutationAllowed,
  assertDashboardRepositoryConfigMutationAllowed,
  assertDashboardRepositoryMutationAllowed,
  createGitHubAppInstallationOctokit,
  createGitHubUserOctokit,
  dashboardMutationAccessAuditMetadata,
  getDashboardSignedInActor,
  getDashboardWorkspaceScope,
} from "../../src/server/dashboard-mutations";
import {
  createDashboardMemoryDependencies,
  resolveDashboardMemoryActor,
} from "../../src/server/dashboard-memory";
import { createDashboardRateLimitPolicy } from "../../src/server/dashboard-rate-limits";
import { refreshGitHubUserRepositoryAccess } from "../../src/server/github-user-repository-access";
import { getPrisma } from "../../src/server/prisma";
import { inspectSetupPullRequestStatus } from "../../src/server/setup-pull-request-status";
import { resolveWorkflowPublicApiUrl } from "../../src/server/workflow-public-api-url";
import { isWorkflowSetupAlreadyCurrent } from "../../src/server/workflow-setup-readiness";

export async function requestInstallationSyncAction(
  formData: FormData,
): Promise<never> {
  const params = await requestInstallationSyncMutation(formData);

  revalidatePath("/dashboard");
  revalidatePath("/setup");
  redirectAfterMutation(formData, params);
}

export async function requestInstallationSyncClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await requestInstallationSyncMutation(formData);

  return { params };
}

async function requestInstallationSyncMutation(
  formData: FormData,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  const githubInstallationId = readFormString(formData, "githubInstallationId");
  const workspaceId = readFormString(formData, "workspaceId");
  let params: Record<string, string>;

  try {
    const installation = await prisma.gitHubInstallation.findUnique({
      where: { githubInstallationId: BigInt(githubInstallationId) },
      select: { workspaceId: true, accountLogin: true },
    });
    if (!installation || installation.workspaceId !== workspaceId) {
      throw new Error("installation_not_found");
    }

    const actor = await assertDashboardMutationAllowed(workspaceId);
    await assertDashboardEntitlement({
      prisma,
      workspaceId,
      actor: actor.actor,
      feature: "repository_dashboard",
    });
    await createDashboardRateLimitPolicy(prisma).assertInstallationSyncAllowed({
      workspaceId,
      githubInstallationId,
    });
    const clockNow = new Date();
    const deliveryBucket = Math.floor(clockNow.getTime() / 60_000);

    const result = await new PostgresLeaseLock(prisma).withLock(
      `installation:${githubInstallationId}:sync-request`,
      30_000,
      async () => {
        const syncRequester = new OutboxInstallationSyncRequester(
          new PrismaOutboxEventRepository(prisma),
        );
        return syncRequester.requestInstallationSync({
          githubInstallationId,
          deliveryId: `dashboard-${githubInstallationId}-${deliveryBucket}`,
          reason: "manual_dashboard_sync",
          occurredAt: clockNow,
        });
      },
    );

    await recordAuditEvent(
      {
        workspaceId,
        actor: actor.actor,
        action: "installation.sync_requested",
        targetType: "github_installation",
        targetId: githubInstallationId,
        metadata: {
          source: "dashboard",
          created: result.created,
          accountLogin: installation.accountLogin,
        },
      },
      { auditLog: new PrismaAuditLogRepository(prisma) },
    );

    params = {
      notice: result.created ? "sync_requested" : "sync_already_requested",
      workspace: workspaceId,
      section: "repositories",
    };
  } catch (error) {
    params = {
      error: safeDashboardErrorCode(error),
      workspace: workspaceId,
      section: "repositories",
    };
  }

  return params;
}

export async function refreshRepositoryAccessAction(
  formData: FormData,
): Promise<never> {
  const params = await refreshRepositoryAccessMutation(formData);

  revalidatePath("/dashboard");
  redirectWithParams(params);
}

export async function refreshRepositoryAccessClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await refreshRepositoryAccessMutation(formData);

  return { params };
}

async function refreshRepositoryAccessMutation(
  formData: FormData,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  let params: Record<string, string>;

  try {
    const actor = await getDashboardSignedInActor();
    if (!actor) {
      throw new Error("dashboard_mutation_requires_sign_in");
    }
    await createDashboardRateLimitPolicy(
      prisma,
    ).assertRepositoryAccessRefreshAllowed({ userId: actor.userId });
    const workspaceScope = await getDashboardWorkspaceScope();
    const result = await refreshGitHubUserRepositoryAccess({
      prisma,
      actor,
      excludedWorkspaceIds:
        workspaceScope.kind === "workspace_ids"
          ? workspaceScope.workspaceIds
          : [],
    });
    if (result.status !== "ready") {
      throw new Error(`repository_access_${result.status}`);
    }

    params = { notice: "repository_access_refreshed" };
  } catch (error) {
    params = { error: safeDashboardErrorCode(error) };
  }

  const workspace = readOptionalFormString(formData, "workspace");
  const section = readOptionalFormString(formData, "section");
  if (workspace) params.workspace = workspace;
  if (section) params.section = section;

  return params;
}

export async function createSetupPullRequestAction(
  formData: FormData,
): Promise<never> {
  const params = await createSetupPullRequestMutation(formData);

  revalidatePath("/dashboard");
  revalidatePath("/setup");
  redirectAfterMutation(formData, params);
}

export async function createSetupPullRequestClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await createSetupPullRequestMutation(formData);

  return { params };
}

export async function confirmSetupPullRequestMergedClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await confirmSetupPullRequestMergedMutation(formData);

  return { params };
}

export async function confirmProviderSecretSetupClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await confirmProviderSecretSetupMutation(formData);

  return { params };
}

export async function createMemoryItemAction(
  formData: FormData,
): Promise<never> {
  const params = await createMemoryItemMutation(formData);

  revalidatePath("/dashboard");
  redirectAfterMutation(formData, params);
}

export async function createMemoryItemClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await createMemoryItemMutation(formData);

  return { params };
}

export async function confirmMemorySuggestionAction(
  formData: FormData,
): Promise<never> {
  const params = await confirmMemorySuggestionMutation(formData);

  revalidatePath("/dashboard");
  redirectAfterMutation(formData, params);
}

export async function confirmMemorySuggestionClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await confirmMemorySuggestionMutation(formData);

  return { params };
}

export async function rejectMemorySuggestionAction(
  formData: FormData,
): Promise<never> {
  const params = await rejectMemorySuggestionMutation(formData);

  revalidatePath("/dashboard");
  redirectAfterMutation(formData, params);
}

export async function rejectMemorySuggestionClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await rejectMemorySuggestionMutation(formData);

  return { params };
}

export async function editMemoryItemAction(formData: FormData): Promise<never> {
  const params = await editMemoryItemMutation(formData);

  revalidatePath("/dashboard");
  redirectAfterMutation(formData, params);
}

export async function editMemoryItemClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await editMemoryItemMutation(formData);

  return { params };
}

export async function disableMemoryItemAction(
  formData: FormData,
): Promise<never> {
  const params = await disableMemoryItemMutation(formData);

  revalidatePath("/dashboard");
  redirectAfterMutation(formData, params);
}

export async function disableMemoryItemClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await disableMemoryItemMutation(formData);

  return { params };
}

export async function deleteMemoryItemAction(
  formData: FormData,
): Promise<never> {
  const params = await deleteMemoryItemMutation(formData);

  revalidatePath("/dashboard");
  redirectAfterMutation(formData, params);
}

export async function deleteMemoryItemClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await deleteMemoryItemMutation(formData);

  return { params };
}

export async function checkProviderRepositorySecretClientAction(
  formData: FormData,
): Promise<{
  readonly status:
    | "available_repository"
    | "available_organization"
    | "not_available_to_repository"
    | "missing"
    | "permission_required"
    | "unknown";
}> {
  const prisma = getPrisma();
  const workspaceId = readFormString(formData, "workspaceId");
  const repositoryId = readFormString(formData, "repositoryId");
  const providerSetup = readProviderSetupSelection(formData);
  const secretNames = providerSecretNamesForAuthMode(providerSetup.authMode);

  try {
    const repository = await loadRepositoryForWorkspace({
      prisma,
      workspaceId,
      repositoryId,
    });
    const actor = await assertDashboardRepositoryMutationAllowed(
      workspaceId,
      repository,
    );
    await assertDashboardEntitlement({
      prisma,
      workspaceId,
      actor: actor.actor,
      feature: "action_control_plane",
    });

    const octokit = await createGitHubAppInstallationOctokit(
      repository.installation.githubInstallationId.toString(),
    );
    await assertRepositoryVisibleToGitHubApp({ octokit, repository });

    return await checkProviderSecretAvailability({
      octokit,
      repository,
      secretNames,
      allowOrganizationSecrets: actor.accessSource?.source !== "repo_manager",
    });
  } catch (error) {
    const status = providerSecretAvailabilityStatusForError(error);
    if (status) return { status };

    return { status: "unknown" };
  }
}

async function createSetupPullRequestMutation(
  formData: FormData,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  const repositoryId = readFormString(formData, "repositoryId");
  const workspaceId = readFormString(formData, "workspaceId");
  const workflowStyle = readWorkflowStyle(formData);
  let params: Record<string, string>;

  try {
    const repository = await prisma.repositoryConnection.findUnique({
      where: { id: repositoryId },
      select: {
        workspaceId: true,
        githubRepositoryId: true,
        owner: true,
        name: true,
        fullName: true,
        defaultBranch: true,
        installation: {
          select: { githubInstallationId: true },
        },
      },
    });
    if (!repository || repository.workspaceId !== workspaceId) {
      throw new Error("repository_not_found");
    }

    const actor = await assertDashboardRepositoryMutationAllowed(
      workspaceId,
      repository,
    );
    await assertDashboardEntitlement({
      prisma,
      workspaceId,
      actor: actor.actor,
      feature: "workflow_provisioning",
    });
    await createDashboardRateLimitPolicy(prisma).assertWorkflowSetupPrAllowed({
      workspaceId,
      repositoryId,
    });
    const octokit = await createGitHubAppInstallationOctokit(
      repository.installation.githubInstallationId.toString(),
    );
    const actionRef = resolveReviewRouterActionRef();
    const resolvedRuntime = await loadResolvedReviewRuntime({
      prisma,
      workspaceId,
      repositoryId,
    });
    const workflowProviderKind = workflowReadinessProviderKind(
      resolvedRuntime.config,
    );
    const conflictReviewFallbackAllowed =
      isConflictReviewFallbackAllowedForRepository(repository.fullName);
    const workflowReady = await isWorkflowSetupAlreadyCurrent(
      {
        githubInstallationId:
          repository.installation.githubInstallationId.toString(),
        owner: repository.owner,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        actionRef,
        conflictReviewFallbackEnabled: conflictReviewFallbackAllowed,
        ...(workflowProviderKind ? { providerKind: workflowProviderKind } : {}),
      },
      {
        workflowProbe: new OctokitRepositoryWorkflowProbe({
          createRequester: async () => octokit,
        }),
      },
    );

    if (workflowReady) {
      await recordAuditEvent(
        {
          workspaceId,
          actor: actor.actor,
          action: "workflow.setup_pr_skipped",
          targetType: "repository",
          targetId: repositoryId,
          metadata: {
            reason: "workflow_already_current",
            actionVersion: actionRef,
            workflowPath: defaultWorkflowPath,
            ...dashboardMutationAccessAuditMetadata(actor),
          },
        },
        { auditLog: new PrismaAuditLogRepository(prisma) },
      );
      params = {
        notice: "workflow_already_current",
        repository: repository.fullName,
        workspace: workspaceId,
        section: "repositories",
      };
    } else {
      const setupOctokit =
        actor.accessSource?.source === "repo_manager"
          ? await createGitHubUserOctokit(actor)
          : octokit;
      const pullRequest = await new PostgresLeaseLock(prisma).withLock(
        `repo:${repositoryId}:workflow-provision`,
        5 * 60_000,
        async () =>
          provisionRepositoryReviewRouterWorkflow(
            {
              repositoryId,
              actionRef,
              apiUrl: resolveWorkflowPublicApiUrl(),
              runtimeConfigMode: "oidc",
              staticRuntimeEnv: resolvedRuntime.runtimeEnv,
              workflowStyle,
              conflictReviewFallbackEnabled: conflictReviewFallbackAllowed,
              actor: actor.actor,
            },
            {
              targets: new PrismaWorkflowProvisioningTarget(prisma),
              setupGateway: new OctokitWorkflowSetupGateway(setupOctokit),
              provisioning: new PrismaWorkflowProvisioningRepository(prisma),
              auditLog: new PrismaAuditLogRepository(prisma),
              enabled: isWorkflowProvisioningEnabled(),
              auditMetadata: dashboardMutationAccessAuditMetadata(actor),
            },
          ),
      );

      params = {
        notice: "setup_pr_ready",
        repository: repository.fullName,
        pr: pullRequest.url,
        workspace: workspaceId,
        section: "repositories",
      };
    }
  } catch (error) {
    params = {
      error: safeDashboardErrorCode(error),
      workspace: workspaceId,
      section: "repositories",
    };
  }

  return params;
}

async function confirmSetupPullRequestMergedMutation(
  formData: FormData,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  const repositoryId = readFormString(formData, "repositoryId");
  const workspaceId = readFormString(formData, "workspaceId");
  let params: Record<string, string>;

  try {
    const repository = await prisma.repositoryConnection.findUnique({
      where: { id: repositoryId },
      select: {
        id: true,
        workspaceId: true,
        githubRepositoryId: true,
        owner: true,
        name: true,
        fullName: true,
        defaultBranch: true,
        selected: true,
        archived: true,
        installation: {
          select: { status: true, githubInstallationId: true },
        },
        provisioning: {
          where: { status: "setup_pr_open" },
          orderBy: { updatedAt: "desc" },
          take: 1,
          select: {
            branch: true,
            pullRequestUrl: true,
          },
        },
      },
    });
    if (!repository || repository.workspaceId !== workspaceId) {
      throw new Error("repository_not_found");
    }
    assertRepositoryConfigMutable(repository);

    const actor = await assertDashboardRepositoryMutationAllowed(
      workspaceId,
      repository,
    );
    await assertDashboardEntitlement({
      prisma,
      workspaceId,
      actor: actor.actor,
      feature: "workflow_provisioning",
    });

    const octokit = await createGitHubAppInstallationOctokit(
      repository.installation.githubInstallationId.toString(),
    );
    const setupProvisioning = repository.provisioning[0] ?? null;
    const pullRequestNumber = pullRequestNumberFromUrl(
      setupProvisioning?.pullRequestUrl ?? "",
    );
    const setupPullRequestStatus = pullRequestNumber
      ? await inspectSetupPullRequestStatus(
          {
            owner: repository.owner,
            name: repository.name,
            pullRequestNumber,
            setupBranch: setupProvisioning?.branch ?? null,
          },
          octokit,
        )
      : null;
    const setupPullRequestMerged = setupPullRequestStatus === "merged";
    const workflowProviderKind = setupPullRequestMerged
      ? undefined
      : workflowReadinessProviderKind(
          (
            await loadResolvedReviewRuntime({
              prisma,
              workspaceId,
              repositoryId,
            })
          ).config,
        );
    const workflowReady = setupPullRequestMerged
      ? true
      : await isWorkflowSetupAlreadyCurrent(
          {
            githubInstallationId:
              repository.installation.githubInstallationId.toString(),
            owner: repository.owner,
            name: repository.name,
            defaultBranch: repository.defaultBranch,
            actionRef: resolveReviewRouterActionRef(),
            ...(workflowProviderKind
              ? { providerKind: workflowProviderKind }
              : {}),
          },
          {
            workflowProbe: new OctokitRepositoryWorkflowProbe({
              createRequester: async () => octokit,
            }),
          },
        );

    if (!setupPullRequestMerged && !workflowReady) {
      if (
        setupPullRequestStatus === "closed" ||
        setupPullRequestStatus === "branch_deleted"
      ) {
        const reason =
          setupPullRequestStatus === "closed"
            ? "setup_pr_closed"
            : "setup_pr_branch_deleted";
        await markRepositoryWorkflowSetupNeedsAttention({
          prisma,
          repositoryId,
          setupBranch: setupProvisioning?.branch ?? null,
          pullRequestNumber,
          reason,
        });
        throw new Error(reason);
      }

      throw new Error("setup_pr_not_merged");
    }

    await markRepositoryWorkflowConfigured({
      prisma,
      repositoryId,
      setupBranch: setupProvisioning?.branch ?? null,
      pullRequestNumber,
    });
    await recordAuditEvent(
      {
        workspaceId,
        actor: actor.actor,
        action: "workflow.setup_pr_merged_confirmed",
        targetType: "repository",
        targetId: repositoryId,
        metadata: {
          repository: repository.fullName,
          source: setupPullRequestMerged ? "github_pull_request" : "workflow",
          pullRequestNumber,
          ...dashboardMutationAccessAuditMetadata(actor),
        },
      },
      { auditLog: new PrismaAuditLogRepository(prisma) },
    );

    params = {
      notice: "setup_pr_merged",
      repository: repository.fullName,
      workspace: workspaceId,
      section: "repositories",
    };
  } catch (error) {
    params = {
      error: safeDashboardErrorCode(error),
      workspace: workspaceId,
      section: "repositories",
    };
  }

  return params;
}

async function confirmProviderSecretSetupMutation(
  formData: FormData,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  const workspaceId = readFormString(formData, "workspaceId");
  const repositoryId = readFormString(formData, "repositoryId");
  const providerSetup = readProviderSetupSelection(formData);
  const secretScope = readProviderSecretScope(formData);
  const confirmationMode = readProviderSetupConfirmationMode(formData);
  const secretNames = providerSecretNamesForAuthMode(providerSetup.authMode);
  let params: Record<string, string>;

  try {
    const repository = await loadRepositoryForWorkspace({
      prisma,
      workspaceId,
      repositoryId,
    });
    assertRepositoryConfigMutable(repository);

    const actor = await assertDashboardRepositoryMutationAllowed(
      workspaceId,
      repository,
    );
    await assertDashboardEntitlement({
      prisma,
      workspaceId,
      actor: actor.actor,
      feature: "action_control_plane",
    });
    await createDashboardRateLimitPolicy(prisma).assertReviewConfigSaveAllowed({
      workspaceId,
      resourceId: repositoryId,
    });
    if (
      actor.accessSource?.source === "repo_manager" &&
      secretScope !== "repository"
    ) {
      throw new Error("organization_secret_scope_forbidden");
    }
    if (confirmationMode === "verified") {
      const octokit = await createGitHubAppInstallationOctokit(
        repository.installation.githubInstallationId.toString(),
      );
      await assertRepositoryVisibleToGitHubApp({ octokit, repository });
      await verifyProviderSecrets({
        octokit,
        repository,
        secretNames,
        secretScope,
      });
    }

    await prisma.providerSetupState.upsert({
      where: {
        workspaceId_targetKey_providerKind_authMode: {
          workspaceId,
          targetKey: `repo:${repositoryId}`,
          providerKind: providerSetup.providerKind,
          authMode: providerSetup.authMode,
        },
      },
      update: {
        repositoryId,
        state: "configured",
      },
      create: {
        workspaceId,
        repositoryId,
        targetKey: `repo:${repositoryId}`,
        providerKind: providerSetup.providerKind,
        authMode: providerSetup.authMode,
        state: "configured",
      },
    });
    await recordAuditEvent(
      {
        workspaceId,
        actor: actor.actor,
        action: "provider_secret_setup.confirmed",
        targetType: "repository",
        targetId: repositoryId,
        metadata: {
          repository: repository.fullName,
          providerKind: providerSetup.providerKind,
          authMode: providerSetup.authMode,
          confirmationMode,
          credentialScope: secretScope,
          requiredCredentialCount: secretNames.length,
          ...dashboardMutationAccessAuditMetadata(actor),
        },
      },
      { auditLog: new PrismaAuditLogRepository(prisma) },
    );

    params = {
      notice: "provider_setup_confirmed",
      repository: repository.fullName,
      workspace: workspaceId,
      section: "repositories",
    };
  } catch (error) {
    const failedState = providerSetupStateForSecretCheckError(error);
    if (failedState) {
      await prisma.providerSetupState.updateMany({
        where: {
          workspaceId,
          targetKey: `repo:${repositoryId}`,
          providerKind: providerSetup.providerKind,
          authMode: providerSetup.authMode,
        },
        data: {
          repositoryId,
          state: failedState,
        },
      });
    }
    params = {
      error: safeDashboardErrorCode(error),
      workspace: workspaceId,
      section: "repositories",
    };
  }

  return params;
}

async function createMemoryItemMutation(
  formData: FormData,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  const workspaceId = readFormString(formData, "workspaceId");
  let params: Record<string, string>;

  try {
    const scope = readMemoryScope(formData);
    const context = await createMemoryActionContext({
      prisma,
      workspaceId,
      rateLimitResourceId: `memory:${scope}`,
    });
    const result = await rememberMemoryDirectly(
      {
        workspaceId,
        repositoryId:
          scope === "repository"
            ? readFormString(formData, "repositoryId")
            : null,
        userId: scope === "user_prefs" ? context.memoryActor.id : null,
        scope,
        body: readFormString(formData, "body"),
        source: createDashboardMemorySource({
          actorLogin: context.dashboardActor.githubLogin,
        }),
        actor: context.memoryActor,
      },
      context.dependencies,
    );
    params = memoryMutationParams({
      workspaceId,
      successNotice: "memory_saved",
      result,
    });
  } catch (error) {
    params = {
      error: safeDashboardErrorCode(error),
      workspace: workspaceId,
      section: "memory",
    };
  }

  return params;
}

async function confirmMemorySuggestionMutation(
  formData: FormData,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  const workspaceId = readFormString(formData, "workspaceId");
  const suggestionId = readFormString(formData, "suggestionId");
  let params: Record<string, string>;

  try {
    const context = await createMemoryActionContext({
      prisma,
      workspaceId,
      rateLimitResourceId: `memory-suggestion:${suggestionId}`,
    });
    const result = await confirmMemorySuggestion(
      {
        workspaceId,
        suggestionId,
        actor: context.memoryActor,
        ...readOptionalEditedMemory(formData),
      },
      context.dependencies,
    );
    params = memoryMutationParams({
      workspaceId,
      successNotice: "memory_suggestion_confirmed",
      result,
    });
  } catch (error) {
    params = {
      error: safeDashboardErrorCode(error),
      workspace: workspaceId,
      section: "memory",
    };
  }

  return params;
}

async function rejectMemorySuggestionMutation(
  formData: FormData,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  const workspaceId = readFormString(formData, "workspaceId");
  const suggestionId = readFormString(formData, "suggestionId");
  let params: Record<string, string>;

  try {
    const context = await createMemoryActionContext({
      prisma,
      workspaceId,
      rateLimitResourceId: `memory-suggestion:${suggestionId}`,
    });
    const result = await rejectMemorySuggestion(
      {
        workspaceId,
        suggestionId,
        actor: context.memoryActor,
        reason: readOptionalFormString(formData, "reason") ?? "rejected",
      },
      context.dependencies,
    );
    params = memoryMutationParams({
      workspaceId,
      successNotice: "memory_suggestion_rejected",
      result,
    });
  } catch (error) {
    params = {
      error: safeDashboardErrorCode(error),
      workspace: workspaceId,
      section: "memory",
    };
  }

  return params;
}

async function editMemoryItemMutation(
  formData: FormData,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  const workspaceId = readFormString(formData, "workspaceId");
  const itemId = readFormString(formData, "memoryItemId");
  const expectedVersion = readOptionalPositiveInteger(
    formData,
    "expectedVersion",
  );
  let params: Record<string, string>;

  try {
    const context = await createMemoryActionContext({
      prisma,
      workspaceId,
      rateLimitResourceId: `memory-item:${itemId}:edit`,
    });
    const result = await editMemoryItem(
      {
        workspaceId,
        itemId,
        body: readFormString(formData, "body"),
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        actor: context.memoryActor,
      },
      context.dependencies,
    );
    params = memoryMutationParams({
      workspaceId,
      successNotice: "memory_edited",
      result,
    });
  } catch (error) {
    params = {
      error: safeDashboardErrorCode(error),
      workspace: workspaceId,
      section: "memory",
    };
  }

  return params;
}

async function disableMemoryItemMutation(
  formData: FormData,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  const workspaceId = readFormString(formData, "workspaceId");
  const itemId = readFormString(formData, "memoryItemId");
  const expectedVersion = readOptionalPositiveInteger(
    formData,
    "expectedVersion",
  );
  let params: Record<string, string>;

  try {
    const context = await createMemoryActionContext({
      prisma,
      workspaceId,
      rateLimitResourceId: `memory-item:${itemId}`,
    });
    const result = await disableMemoryItem(
      {
        workspaceId,
        itemId,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        actor: context.memoryActor,
      },
      context.dependencies,
    );
    params = memoryMutationParams({
      workspaceId,
      successNotice: "memory_disabled",
      result,
    });
  } catch (error) {
    params = {
      error: safeDashboardErrorCode(error),
      workspace: workspaceId,
      section: "memory",
    };
  }

  return params;
}

async function deleteMemoryItemMutation(
  formData: FormData,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  const workspaceId = readFormString(formData, "workspaceId");
  const itemId = readFormString(formData, "memoryItemId");
  const expectedVersion = readOptionalPositiveInteger(
    formData,
    "expectedVersion",
  );
  let params: Record<string, string>;

  try {
    const context = await createMemoryActionContext({
      prisma,
      workspaceId,
      rateLimitResourceId: `memory-item:${itemId}`,
    });
    const result = await deleteMemoryItem(
      {
        workspaceId,
        itemId,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        actor: context.memoryActor,
      },
      context.dependencies,
    );
    params = memoryMutationParams({
      workspaceId,
      successNotice: "memory_deleted",
      result,
    });
  } catch (error) {
    params = {
      error: safeDashboardErrorCode(error),
      workspace: workspaceId,
      section: "memory",
    };
  }

  return params;
}

export async function enableOrgRulesetWorkflowAction(
  formData: FormData,
): Promise<never> {
  const params = await enableOrgRulesetWorkflowMutation(formData);

  revalidatePath("/dashboard");
  redirectWithParams(params);
}

export async function enableOrgRulesetWorkflowClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await enableOrgRulesetWorkflowMutation(formData);

  return { params };
}

async function enableOrgRulesetWorkflowMutation(
  formData: FormData,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  const workspaceId = readFormString(formData, "workspaceId");
  const githubInstallationId = readFormString(formData, "githubInstallationId");
  let params: Record<string, string>;

  try {
    const installation = await prisma.gitHubInstallation.findUnique({
      where: { githubInstallationId: BigInt(githubInstallationId) },
      select: {
        id: true,
        workspaceId: true,
        accountLogin: true,
        accountType: true,
        status: true,
      },
    });
    if (!installation || installation.workspaceId !== workspaceId) {
      throw new Error("installation_not_found");
    }
    if (installation.accountType !== "Organization") {
      throw new Error("org_ruleset_requires_organization_installation");
    }

    const actor = await assertDashboardMutationAllowed(workspaceId);
    await assertDashboardEntitlement({
      prisma,
      workspaceId,
      actor: actor.actor,
      feature: "workflow_provisioning",
    });
    await createDashboardRateLimitPolicy(
      prisma,
    ).assertOrgRulesetProvisioningAllowed({
      workspaceId,
      githubInstallationId,
    });

    const octokit =
      await createGitHubAppInstallationOctokit(githubInstallationId);
    await assertOrgRulesetOrganizationPlanAllowed({
      octokit,
      organizationLogin: installation.accountLogin,
    });
    const scope = readFormString(formData, "scope") as OrgRulesetScope;
    const enforcement = readFormString(
      formData,
      "enforcement",
    ) as OrgRulesetEnforcement;
    const result = await new PostgresLeaseLock(prisma).withLock(
      `org-ruleset:${workspaceId}:provision`,
      5 * 60_000,
      async () =>
        requestOrgRulesetProvisioning(
          {
            workspaceId,
            githubInstallationId,
            scope,
            enforcement,
            actor: actor.actor,
            requestedAt: new Date(),
          },
          {
            provisioning: new PrismaOrgRulesetProvisioningRepository(prisma),
            setupGateway: new OctokitOrgRulesetSetupGateway(octokit),
            outbox: new PrismaOutboxEventRepository(prisma),
            auditLog: new PrismaAuditLogRepository(prisma),
          },
        ),
    );

    params = {
      notice: "org_ruleset_queued",
      workspace: workspaceId,
      section: "setup",
      provisioning: result.provisioningId,
    };
  } catch (error) {
    params = {
      error: safeDashboardErrorCode(error),
      workspace: workspaceId,
      section: "setup",
    };
  }

  return params;
}

export async function saveWorkspaceReviewConfigAction(
  formData: FormData,
): Promise<never> {
  const params = await saveWorkspaceReviewConfigMutation(formData);

  revalidatePath("/dashboard");
  redirectWithParams(params);
}

export async function saveWorkspaceReviewConfigClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await saveWorkspaceReviewConfigMutation(formData);

  return { params };
}

async function saveWorkspaceReviewConfigMutation(
  formData: FormData,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  const workspaceId = readFormString(formData, "workspaceId");
  let params: Record<string, string>;

  try {
    const actor = await assertDashboardMutationAllowed(workspaceId);
    await assertDashboardEntitlement({
      prisma,
      workspaceId,
      actor: actor.actor,
      feature: "action_control_plane",
    });
    await createDashboardRateLimitPolicy(prisma).assertReviewConfigSaveAllowed({
      workspaceId,
    });
    const config = readReviewConfigurationForm(formData);

    const saved = await saveReviewConfiguration(
      {
        target: { scope: "workspace", workspaceId },
        config,
      },
      {
        configurations: new PrismaReviewConfigurationRepository(prisma),
      },
    );

    await recordAuditEvent(
      {
        workspaceId,
        actor: actor.actor,
        action: "review_config.saved",
        targetType: "workspace",
        targetId: workspaceId,
        metadata: {
          version: saved.version,
          providerKind: saved.config.provider.kind,
          authMode: saved.config.provider.authMode,
          model: saved.config.provider.model,
          failOnSeverity: saved.config.blockingPolicy.failOnSeverity,
          ...dashboardMutationAccessAuditMetadata(actor),
        },
      },
      { auditLog: new PrismaAuditLogRepository(prisma) },
    );

    params = {
      notice: "review_config_saved",
      version: String(saved.version),
      workspace: workspaceId,
      section: "policy",
    };
  } catch (error) {
    params = {
      error: safeDashboardErrorCode(error),
      workspace: workspaceId,
      section: "policy",
    };
  }

  return params;
}

export async function saveRepositoryReviewConfigAction(
  formData: FormData,
): Promise<never> {
  const params = await saveRepositoryReviewConfigMutation(formData);

  revalidatePath("/dashboard");
  redirectWithParams(params);
}

export async function saveRepositoryReviewConfigClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await saveRepositoryReviewConfigMutation(formData);

  return { params };
}

async function saveRepositoryReviewConfigMutation(
  formData: FormData,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  const workspaceId = readFormString(formData, "workspaceId");
  const repositoryId = readFormString(formData, "repositoryId");
  let params: Record<string, string>;

  try {
    const repository = await loadRepositoryForWorkspace({
      prisma,
      workspaceId,
      repositoryId,
    });
    assertRepositoryConfigMutable(repository);

    const actor = await assertDashboardRepositoryConfigMutationAllowed(
      workspaceId,
      repository,
    );
    await assertDashboardEntitlement({
      prisma,
      workspaceId,
      actor: actor.actor,
      feature: "action_control_plane",
    });
    await createDashboardRateLimitPolicy(prisma).assertReviewConfigSaveAllowed({
      workspaceId,
      resourceId: repositoryId,
    });
    const config = readReviewConfigurationForm(formData);

    const saved = await saveReviewConfiguration(
      {
        target: { scope: "repository", workspaceId, repositoryId },
        config,
      },
      {
        configurations: new PrismaReviewConfigurationRepository(prisma),
      },
    );

    await recordAuditEvent(
      {
        workspaceId,
        actor: actor.actor,
        action: "review_config.saved",
        targetType: "repository",
        targetId: repositoryId,
        metadata: {
          repository: repository.fullName,
          version: saved.version,
          providerKind: saved.config.provider.kind,
          authMode: saved.config.provider.authMode,
          model: saved.config.provider.model,
          failOnSeverity: saved.config.blockingPolicy.failOnSeverity,
          ...dashboardMutationAccessAuditMetadata(actor),
        },
      },
      { auditLog: new PrismaAuditLogRepository(prisma) },
    );

    params = {
      notice: "repository_review_config_saved",
      repository: repository.fullName,
      version: String(saved.version),
    };
  } catch (error) {
    params = { error: safeDashboardErrorCode(error) };
  }

  return params;
}

export async function clearRepositoryReviewConfigAction(
  formData: FormData,
): Promise<never> {
  const params = await clearRepositoryReviewConfigMutation(formData);

  revalidatePath("/dashboard");
  redirectWithParams(params);
}

export async function clearRepositoryReviewConfigClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await clearRepositoryReviewConfigMutation(formData);

  return { params };
}

async function clearRepositoryReviewConfigMutation(
  formData: FormData,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  const workspaceId = readFormString(formData, "workspaceId");
  const repositoryId = readFormString(formData, "repositoryId");
  let params: Record<string, string>;

  try {
    const repository = await loadRepositoryForWorkspace({
      prisma,
      workspaceId,
      repositoryId,
    });
    assertRepositoryConfigMutable(repository);

    const actor = await assertDashboardRepositoryConfigMutationAllowed(
      workspaceId,
      repository,
    );
    await assertDashboardEntitlement({
      prisma,
      workspaceId,
      actor: actor.actor,
      feature: "action_control_plane",
    });
    await createDashboardRateLimitPolicy(prisma).assertReviewConfigSaveAllowed({
      workspaceId,
      resourceId: repositoryId,
    });

    const cleared = await clearReviewConfiguration(
      { scope: "repository", workspaceId, repositoryId },
      {
        configurations: new PrismaReviewConfigurationRepository(prisma),
      },
    );

    await recordAuditEvent(
      {
        workspaceId,
        actor: actor.actor,
        action: "review_config.cleared",
        targetType: "repository",
        targetId: repositoryId,
        metadata: {
          repository: repository.fullName,
          cleared,
          ...dashboardMutationAccessAuditMetadata(actor),
        },
      },
      { auditLog: new PrismaAuditLogRepository(prisma) },
    );

    params = {
      notice: "repository_review_config_cleared",
      repository: repository.fullName,
    };
  } catch (error) {
    params = { error: safeDashboardErrorCode(error) };
  }

  return params;
}

export async function retryOutboxEventAction(
  formData: FormData,
): Promise<never> {
  const params = await retryOutboxEventMutation(formData);

  revalidatePath("/dashboard");
  redirectWithParams(params);
}

export async function retryOutboxEventClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await retryOutboxEventMutation(formData);

  return { params };
}

async function retryOutboxEventMutation(
  formData: FormData,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  const workspaceId = readFormString(formData, "workspaceId");
  const eventId = readFormString(formData, "eventId");
  let params: Record<string, string>;

  try {
    const actor = await assertDashboardMutationAllowed(workspaceId);
    await assertDashboardEntitlement({
      prisma,
      workspaceId,
      actor: actor.actor,
      feature: "repository_dashboard",
    });
    await createDashboardRateLimitPolicy(prisma).assertOutboxRetryAllowed({
      workspaceId,
      eventId,
    });
    const outbox = new PrismaOutboxEventRepository(prisma);
    const result = await new PostgresLeaseLock(prisma).withLock(
      `outbox:${eventId}:retry`,
      30_000,
      async () =>
        retryDeadLetterOutboxEvent(
          { workspaceId, eventId },
          { outbox, clock: { now: () => new Date() } },
        ),
    );

    await recordAuditEvent(
      {
        workspaceId,
        actor: actor.actor,
        action: "outbox.retry_requested",
        targetType: "outbox_event",
        targetId: eventId,
        metadata: { result },
      },
      { auditLog: new PrismaAuditLogRepository(prisma) },
    );

    params = {
      notice:
        result.status === "queued"
          ? "outbox_retry_queued"
          : `outbox_retry_${result.status}`,
    };
  } catch (error) {
    params = { error: safeDashboardErrorCode(error) };
  }

  return params;
}

async function assertDashboardEntitlement(input: {
  readonly prisma: PrismaClient;
  readonly workspaceId: string;
  readonly actor: string;
  readonly feature: EntitlementFeature;
}): Promise<void> {
  await assertWorkspaceFeatureEntitlement(
    {
      workspaceId: input.workspaceId,
      actor: input.actor,
      feature: input.feature,
    },
    {
      entitlements: new PrismaEntitlementRepository(input.prisma),
      auditLog: new PrismaAuditLogRepository(input.prisma),
    },
  );
}

async function createMemoryActionContext(input: {
  readonly prisma: PrismaClient;
  readonly workspaceId: string;
  readonly rateLimitResourceId: string;
}) {
  const dashboardActor = await assertDashboardMutationAllowed(
    input.workspaceId,
  );
  await assertDashboardEntitlement({
    prisma: input.prisma,
    workspaceId: input.workspaceId,
    actor: dashboardActor.actor,
    feature: "repository_dashboard",
  });
  await createDashboardRateLimitPolicy(
    input.prisma,
  ).assertReviewConfigSaveAllowed({
    workspaceId: input.workspaceId,
    resourceId: input.rateLimitResourceId,
  });

  const memoryActor = await resolveDashboardMemoryActor(
    {
      githubUserId: dashboardActor.githubUserId,
      githubLogin: dashboardActor.githubLogin,
    },
    input.prisma,
  );

  return {
    dashboardActor,
    memoryActor,
    dependencies: createDashboardMemoryDependencies({
      prisma: input.prisma,
      actor: {
        githubUserId: dashboardActor.githubUserId,
        githubLogin: dashboardActor.githubLogin,
      },
    }),
  };
}

function memoryMutationParams(input: {
  readonly workspaceId: string;
  readonly successNotice: string;
  readonly result: MemoryMutationResult;
}): Record<string, string> {
  const base = { workspace: input.workspaceId, section: "memory" };
  if (input.result.status === "created" || input.result.status === "updated") {
    return { ...base, notice: input.successNotice, memory: input.result.id };
  }
  if (input.result.status === "rejected") {
    return { ...base, error: input.result.reason };
  }
  switch (input.result.reason) {
    case "memory_duplicate":
      return { ...base, notice: "memory_duplicate" };
    case "memory_not_found":
      return { ...base, error: "memory_not_found" };
    case "confirmed":
    case "rejected":
    case "disabled":
    case "deleted":
      return { ...base, notice: `memory_already_${input.result.reason}` };
    default:
      return { ...base, notice: "memory_noop" };
  }
}

async function loadRepositoryForWorkspace(input: {
  readonly prisma: PrismaClient;
  readonly workspaceId: string;
  readonly repositoryId: string;
}): Promise<{
  readonly id: string;
  readonly workspaceId: string;
  readonly githubRepositoryId: bigint;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly visibility: string;
  readonly selected: boolean;
  readonly archived: boolean;
  readonly installation: {
    readonly status: string;
    readonly githubInstallationId: bigint;
  };
}> {
  const repository = await input.prisma.repositoryConnection.findUnique({
    where: { id: input.repositoryId },
    select: {
      id: true,
      workspaceId: true,
      githubRepositoryId: true,
      owner: true,
      name: true,
      fullName: true,
      visibility: true,
      selected: true,
      archived: true,
      installation: { select: { status: true, githubInstallationId: true } },
    },
  });
  if (!repository || repository.workspaceId !== input.workspaceId) {
    throw new Error("repository_not_found");
  }

  return repository;
}

async function verifyProviderSecrets(input: {
  readonly octokit: Awaited<
    ReturnType<typeof createGitHubAppInstallationOctokit>
  >;
  readonly repository: Awaited<ReturnType<typeof loadRepositoryForWorkspace>>;
  readonly secretNames: readonly string[];
  readonly secretScope: ProviderSecretScope;
}): Promise<void> {
  for (const secretName of input.secretNames) {
    if (input.secretScope === "repository") {
      await verifyRepositorySecret({
        octokit: input.octokit,
        repository: input.repository,
        secretName,
      });
    } else {
      await verifyOrganizationSecret({
        octokit: input.octokit,
        repository: input.repository,
        secretName,
      });
    }
  }
}

async function checkProviderSecretAvailability(input: {
  readonly octokit: Awaited<
    ReturnType<typeof createGitHubAppInstallationOctokit>
  >;
  readonly repository: Awaited<ReturnType<typeof loadRepositoryForWorkspace>>;
  readonly secretNames: readonly string[];
  readonly allowOrganizationSecrets?: boolean;
}): Promise<{
  readonly status:
    | "available_repository"
    | "available_organization"
    | "not_available_to_repository"
    | "missing"
    | "permission_required"
    | "unknown";
}> {
  for (const secretName of input.secretNames) {
    try {
      await verifyRepositorySecret({
        octokit: input.octokit,
        repository: input.repository,
        secretName,
      });
      continue;
    } catch (error) {
      const status = providerSecretAvailabilityStatusForError(error);
      if (status === "permission_required") return { status };
      if (status !== "missing") return { status: "unknown" };
    }

    if (input.allowOrganizationSecrets === false) {
      return { status: "missing" };
    }

    return await checkOrganizationProviderSecretAvailability({
      ...input,
      secretName,
    });
  }

  return { status: "available_repository" };
}

async function checkOrganizationProviderSecretAvailability(input: {
  readonly octokit: Awaited<
    ReturnType<typeof createGitHubAppInstallationOctokit>
  >;
  readonly repository: Awaited<ReturnType<typeof loadRepositoryForWorkspace>>;
  readonly secretName: string;
}): Promise<{
  readonly status:
    | "available_organization"
    | "not_available_to_repository"
    | "missing"
    | "permission_required"
    | "unknown";
}> {
  try {
    await verifyOrganizationSecret({
      octokit: input.octokit,
      repository: input.repository,
      secretName: input.secretName,
    });
    return { status: "available_organization" };
  } catch (error) {
    const status = providerSecretAvailabilityStatusForError(error);
    if (status) return { status };

    return { status: "unknown" };
  }
}

async function assertRepositoryVisibleToGitHubApp(input: {
  readonly octokit: Awaited<
    ReturnType<typeof createGitHubAppInstallationOctokit>
  >;
  readonly repository: Awaited<ReturnType<typeof loadRepositoryForWorkspace>>;
}): Promise<void> {
  try {
    await input.octokit.request("GET /repos/{owner}/{repo}", {
      owner: input.repository.owner,
      repo: input.repository.name,
    });
  } catch (error) {
    const status = githubApiStatus(error);
    if (status === 401 || status === 403 || status === 404) {
      throw new Error("repository_not_visible_to_github_app", {
        cause: error,
      });
    }

    throw error;
  }
}

async function assertOrgRulesetOrganizationPlanAllowed(input: {
  readonly octokit: Awaited<
    ReturnType<typeof createGitHubAppInstallationOctokit>
  >;
  readonly organizationLogin: string;
}): Promise<void> {
  try {
    const response = await input.octokit.request("GET /orgs/{org}", {
      org: input.organizationLogin,
    });
    const planName = readGitHubOrganizationPlanName(
      (response.data as { readonly plan?: unknown }).plan,
    );
    if (planName === "free") {
      throw new Error("org_rulesets_not_supported");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "org_rulesets_not_supported"
    ) {
      throw error;
    }
    const status = githubApiStatus(error);
    if (status === 401 || status === 403) return;
    throw error;
  }
}

async function verifyRepositorySecret(input: {
  readonly octokit: Awaited<
    ReturnType<typeof createGitHubAppInstallationOctokit>
  >;
  readonly repository: Awaited<ReturnType<typeof loadRepositoryForWorkspace>>;
  readonly secretName: string;
}): Promise<void> {
  await requestProviderSecretMetadata(async () => {
    await input.octokit.request(
      "GET /repos/{owner}/{repo}/actions/secrets/{secret_name}",
      {
        owner: input.repository.owner,
        repo: input.repository.name,
        secret_name: input.secretName,
      },
    );
  });
}

async function verifyOrganizationSecret(input: {
  readonly octokit: Awaited<
    ReturnType<typeof createGitHubAppInstallationOctokit>
  >;
  readonly repository: Awaited<ReturnType<typeof loadRepositoryForWorkspace>>;
  readonly secretName: string;
}): Promise<void> {
  const secret = await requestProviderSecretMetadata(async () => {
    const response = await input.octokit.request(
      "GET /orgs/{org}/actions/secrets/{secret_name}",
      {
        org: input.repository.owner,
        secret_name: input.secretName,
      },
    );
    return response.data as { readonly visibility?: string };
  });
  const visibility = secret.visibility;

  if (visibility === "all") return;
  if (visibility === "private" && input.repository.visibility === "private") {
    return;
  }
  if (visibility !== "selected") {
    throw new Error("provider_secret_not_available_to_repository");
  }

  const selected = await organizationSecretIncludesRepository({
    octokit: input.octokit,
    org: input.repository.owner,
    secretName: input.secretName,
    githubRepositoryId: input.repository.githubRepositoryId,
  });
  if (!selected) {
    throw new Error("provider_secret_not_available_to_repository");
  }
}

async function organizationSecretIncludesRepository(input: {
  readonly octokit: Awaited<
    ReturnType<typeof createGitHubAppInstallationOctokit>
  >;
  readonly org: string;
  readonly secretName: string;
  readonly githubRepositoryId: bigint;
}): Promise<boolean> {
  const expectedId = input.githubRepositoryId.toString();

  for (let page = 1; page <= 100; page += 1) {
    const response = await requestProviderSecretMetadata(async () => {
      return input.octokit.request(
        "GET /orgs/{org}/actions/secrets/{secret_name}/repositories",
        {
          org: input.org,
          secret_name: input.secretName,
          per_page: 100,
          page,
        },
      );
    });
    const repositories = toRepositoryIdRecords(response.data);

    if (repositories.some((repository) => repository.id === expectedId)) {
      return true;
    }
    if (repositories.length < 100) return false;
  }

  return false;
}

async function requestProviderSecretMetadata<T>(
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const status = githubApiStatus(error);
    if (status === 401 || status === 403) {
      throw new Error("provider_secret_check_permission_required", {
        cause: error,
      });
    }
    if (status === 404) {
      throw new Error("provider_secret_not_found", { cause: error });
    }

    throw error;
  }
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

function toRepositoryIdRecords(
  value: unknown,
): readonly { readonly id: string }[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("repositories" in value) ||
    !Array.isArray(value.repositories)
  ) {
    return [];
  }

  return value.repositories
    .map((repository) => {
      if (
        typeof repository === "object" &&
        repository !== null &&
        "id" in repository
      ) {
        return { id: String(repository.id) };
      }

      return null;
    })
    .filter((repository): repository is { readonly id: string } =>
      Boolean(repository),
    );
}

function assertRepositoryConfigMutable(input: {
  readonly selected: boolean;
  readonly archived: boolean;
  readonly installation: { readonly status: string };
}): void {
  if (!input.selected) {
    throw new Error("repository_not_selected");
  }
  if (input.archived) {
    throw new Error("repository_archived");
  }
  if (input.installation.status !== "active") {
    throw new Error("installation_not_active");
  }
}

async function loadResolvedReviewRuntime(input: {
  readonly prisma: PrismaClient;
  readonly workspaceId: string;
  readonly repositoryId: string;
}): Promise<ResolvedReviewRuntimeEnv> {
  const configurations = new PrismaReviewConfigurationRepository(input.prisma);
  return resolveReviewRuntimeEnv(
    {
      scope: "repository",
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
    },
    { configurations },
  );
}

function workflowReadinessProviderKind(
  config: ReviewConfiguration,
): ProviderKind | undefined {
  return config.providers.some((provider) => provider.kind === "claude")
    ? "claude"
    : undefined;
}

async function markRepositoryWorkflowConfigured(input: {
  readonly prisma: PrismaClient;
  readonly repositoryId: string;
  readonly setupBranch: string | null;
  readonly pullRequestNumber: number | null;
}): Promise<void> {
  const provisioningWhere =
    input.setupBranch || input.pullRequestNumber
      ? {
          repositoryId: input.repositoryId,
          status: "setup_pr_open" as const,
          OR: [
            ...(input.setupBranch ? [{ branch: input.setupBranch }] : []),
            ...(input.pullRequestNumber
              ? [
                  {
                    pullRequestUrl: {
                      endsWith: `/pull/${input.pullRequestNumber}`,
                    },
                  },
                ]
              : []),
          ],
        }
      : {
          repositoryId: input.repositoryId,
          status: "setup_pr_open" as const,
        };

  await input.prisma.$transaction([
    input.prisma.workflowProvisioning.updateMany({
      where: provisioningWhere,
      data: {
        status: "configured",
        errorMessage: null,
      },
    }),
    input.prisma.repositoryConnection.update({
      where: { id: input.repositoryId },
      data: { setupStatus: "configured" },
    }),
  ]);
}

async function markRepositoryWorkflowSetupNeedsAttention(input: {
  readonly prisma: PrismaClient;
  readonly repositoryId: string;
  readonly setupBranch: string | null;
  readonly pullRequestNumber: number | null;
  readonly reason: "setup_pr_closed" | "setup_pr_branch_deleted";
}): Promise<void> {
  const provisioningWhere =
    input.setupBranch || input.pullRequestNumber
      ? {
          repositoryId: input.repositoryId,
          status: "setup_pr_open" as const,
          OR: [
            ...(input.setupBranch ? [{ branch: input.setupBranch }] : []),
            ...(input.pullRequestNumber
              ? [
                  {
                    pullRequestUrl: {
                      endsWith: `/pull/${input.pullRequestNumber}`,
                    },
                  },
                ]
              : []),
          ],
        }
      : {
          repositoryId: input.repositoryId,
          status: "setup_pr_open" as const,
        };

  await input.prisma.$transaction([
    input.prisma.workflowProvisioning.updateMany({
      where: provisioningWhere,
      data: {
        status: "failed",
        errorMessage: input.reason,
      },
    }),
    input.prisma.repositoryConnection.update({
      where: { id: input.repositoryId },
      data: { setupStatus: "needs_attention" },
    }),
  ]);
}

function pullRequestNumberFromUrl(url: string): number | null {
  const match = /\/pull\/(\d+)(?:$|[?#])/.exec(url);
  if (!match) return null;

  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function readReviewConfigurationForm(formData: FormData): ReviewConfiguration {
  const providerCount = readFormNumber(formData, "providerCount");
  if (!Number.isInteger(providerCount) || providerCount < 1) {
    throw new Error("invalid_form_value:providerCount");
  }
  const providers = Array.from({ length: providerCount }, (_, index) => {
    const authMode = readProviderAuthMode(
      formData,
      `providerAuthMode.${index}`,
    );

    return {
      kind: providerKindForAuthMode(authMode),
      authMode,
      model: readFormString(formData, `providerModel.${index}`),
      reasoningEffort: readFormString(
        formData,
        `providerReasoningEffort.${index}`,
      ) as ReviewConfiguration["provider"]["reasoningEffort"],
      agenticContext: readFormBoolean(
        formData,
        `providerAgenticContext.${index}`,
      ),
      fastMode: readFormBoolean(formData, `providerFastMode.${index}`),
      requiredHealthy:
        readOptionalFormBoolean(formData, `providerRequiredHealthy.${index}`) ??
        index === 0,
    } satisfies ReviewConfiguration["provider"];
  });

  return {
    schemaVersion: 2,
    providers,
    provider: providers[0]!,
    execution: {
      providerLimit: providers.length,
      providerMaxParallel: readFormNumber(formData, "providerMaxParallel"),
      inlineMinAgreement: readFormNumber(formData, "inlineMinAgreement"),
    },
    blockingPolicy: {
      failOnSeverity: readFormString(
        formData,
        "failOnSeverity",
      ) as ReviewConfiguration["blockingPolicy"]["failOnSeverity"],
    },
    limits: {
      inlineMaxComments: readFormNumber(formData, "inlineMaxComments"),
      targetTokensPerBatch: readFormNumber(formData, "targetTokensPerBatch"),
    },
  };
}

function readFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing_form_value:${key}`);
  }
  return value;
}

function readOptionalFormString(
  formData: FormData,
  key: string,
): string | null {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readOptionalPositiveInteger(
  formData: FormData,
  key: string,
): number | undefined {
  const value = readOptionalFormString(formData, key);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid_form_value:${key}`);
  }
  return parsed;
}

function readMemoryScope(formData: FormData): MemoryScope {
  const value = readFormString(formData, "scope");
  if (
    value === "repository" ||
    value === "workspace" ||
    value === "user_prefs"
  ) {
    return value;
  }
  throw new Error("invalid_form_value:memoryScope");
}

function readOptionalEditedMemory(formData: FormData): {
  readonly optionalEditedBody?: string;
  readonly optionalScope?: MemoryScope;
} {
  const body = readOptionalFormString(formData, "body");
  const rawScope = readOptionalFormString(formData, "scope");
  const optionalScope =
    rawScope === null ? undefined : readMemoryScopeValue(rawScope);
  return {
    ...(body === null ? {} : { optionalEditedBody: body }),
    ...(optionalScope === undefined ? {} : { optionalScope }),
  };
}

function readMemoryScopeValue(value: string): MemoryScope {
  if (
    value === "repository" ||
    value === "workspace" ||
    value === "user_prefs"
  ) {
    return value;
  }
  throw new Error("invalid_form_value:memoryScope");
}

function readProviderAuthMode(
  formData: FormData,
  key: string,
): ProviderAuthMode {
  const authMode = providerAuthModeSchema.safeParse(
    readFormString(formData, key),
  );
  if (!authMode.success) {
    throw new Error(`invalid_form_value:${key}`);
  }
  return authMode.data;
}

function readWorkflowStyle(formData: FormData): "reusable" | "explicit" {
  const value = formData.get("workflowStyle");
  return value === "explicit" ? "explicit" : "reusable";
}

function readProviderSetupSelection(formData: FormData): {
  readonly providerKind: ProviderKind;
  readonly authMode: ProviderAuthMode;
} {
  const providerKind = providerKindSchema.safeParse(
    readFormString(formData, "providerKind"),
  );
  const authMode = providerAuthModeSchema.safeParse(
    readFormString(formData, "authMode"),
  );

  if (
    providerKind.success &&
    authMode.success &&
    providerAuthModeBelongsToKind(authMode.data, providerKind.data)
  ) {
    return { providerKind: providerKind.data, authMode: authMode.data };
  }

  throw new Error("invalid_form_value:providerSetup");
}

function readProviderSecretScope(formData: FormData): ProviderSecretScope {
  const value = readFormString(formData, "secretScope");
  if (
    value === "repository" ||
    value === "organization_selected_repositories" ||
    value === "organization_private_repositories" ||
    value === "organization_all_repositories"
  ) {
    return value;
  }

  throw new Error("invalid_form_value:secretScope");
}

function readProviderSetupConfirmationMode(
  formData: FormData,
): "verified" | "manual" {
  const value = formData.get("confirmationMode");
  if (value === null) return "verified";
  if (value === "verified" || value === "manual") return value;

  throw new Error("invalid_form_value:confirmationMode");
}

function providerSecretNamesForAuthMode(
  authMode: ProviderAuthMode,
): readonly string[] {
  return getProviderSecretNames(authMode);
}

function providerSetupStateForSecretCheckError(
  error: unknown,
): "missing" | "stale_or_invalid" | "unknown" | null {
  if (!(error instanceof Error)) return null;

  switch (error.message) {
    case "provider_secret_not_found":
      return "missing";
    case "provider_secret_not_available_to_repository":
      return "stale_or_invalid";
    case "provider_secret_check_permission_required":
      return "unknown";
    case "repository_not_visible_to_github_app":
      return "unknown";
    default:
      return null;
  }
}

function providerSecretAvailabilityStatusForError(
  error: unknown,
): "not_available_to_repository" | "missing" | "permission_required" | null {
  if (!(error instanceof Error)) return null;

  switch (error.message) {
    case "provider_secret_not_found":
      return "missing";
    case "provider_secret_not_available_to_repository":
      return "not_available_to_repository";
    case "provider_secret_check_permission_required":
    case "repository_not_visible_to_github_app":
      return "permission_required";
    default:
      return null;
  }
}

function readFormNumber(formData: FormData, key: string): number {
  const value = Number(readFormString(formData, key));
  if (!Number.isFinite(value)) {
    throw new Error(`invalid_form_number:${key}`);
  }
  return value;
}

function readFormBoolean(formData: FormData, key: string): boolean {
  const value = readFormString(formData, key);
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`invalid_form_boolean:${key}`);
}

function readOptionalFormBoolean(
  formData: FormData,
  key: string,
): boolean | undefined {
  const value = readOptionalFormString(formData, key);
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`invalid_form_boolean:${key}`);
}

function redirectWithParams(params: Record<string, string>): never {
  redirect(`/dashboard?${new URLSearchParams(params).toString()}`);
}

function redirectAfterMutation(
  _formData: FormData,
  params: Record<string, string>,
): never {
  redirectWithParams(params);
}

function safeDashboardErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  if (message.startsWith("workspace_mutation_forbidden:")) {
    return "workspace_mutation_forbidden";
  }
  if (message.startsWith("entitlement_denied:")) {
    return "entitlement_denied";
  }
  if (message.startsWith("rate_limit_exceeded:")) {
    return "rate_limited";
  }
  if (message.startsWith("github_user_token_request_failed:401")) {
    return "repository_access_token_revoked";
  }
  if (
    message.startsWith("github_user_token_request_failed:403") ||
    message.startsWith("github_user_token_request_failed:404")
  ) {
    return "repository_mutation_forbidden";
  }
  if (
    message.startsWith("missing_form_value:") ||
    message.startsWith("invalid_form_number:") ||
    message.startsWith("invalid_form_boolean:") ||
    message.startsWith("invalid_form_value:")
  ) {
    return "invalid_form";
  }
  if (
    [
      "repository_access_token_missing",
      "repository_access_token_revoked",
      "repository_access_token_expired",
      "repository_access_token_refresh_failed",
      "repository_access_token_decryption_failed",
      "repository_access_token_encryption_misconfigured",
      "repository_access_github_error",
      "dashboard_mutations_disabled",
      "dashboard_auth_misconfigured",
      "dashboard_mutation_requires_sign_in",
      "installation_not_found",
      "repository_not_found",
      "repository_mutation_forbidden",
      "repository_config_mutation_forbidden",
      "repository_not_selected",
      "repository_archived",
      "installation_not_active",
      "setup_pr_not_merged",
      "setup_pr_closed",
      "setup_pr_branch_deleted",
      "repository_not_visible_to_github_app",
      "provider_secret_not_found",
      "provider_secret_not_available_to_repository",
      "provider_secret_check_permission_required",
      "organization_secret_scope_forbidden",
      "workflow_provisioning_disabled",
      "org_ruleset_requires_organization_installation",
      "org_ruleset_no_selected_repositories",
      "org_ruleset_all_repositories_requires_all_access",
      "org_ruleset_source_repository_invalid",
      "org_ruleset_source_repository_wrong_owner",
      "org_ruleset_source_repository_not_installed",
      "org_ruleset_source_repository_archived",
      "org_ruleset_source_repository_not_writable",
      "org_ruleset_source_repository_branch_blocked",
      "org_ruleset_source_repository_actions_access_required",
      "org_admin_permission_required",
      "org_rulesets_not_supported",
      "org_ruleset_permission_update_pending",
      "github_org_ruleset_validation_failed",
      "contains_code_block",
      "contains_diff_hunk",
      "contains_large_stacktrace",
      "contains_prompt_injection",
      "contains_secret_like_text",
      "memory_active_item_quota_exceeded",
      "memory_not_found",
      "memory_pending_suggestion_quota_exceeded",
      "memory_safety_blocked",
      "memory_version_conflict",
      "not_repository_maintainer",
      "not_user_owner",
      "not_workspace_admin",
      "permission_service_unavailable",
      "repository_unavailable",
      "too_long",
      "unsafe_for_user_prefs",
    ].includes(message)
  ) {
    return message;
  }
  if (
    message.startsWith("missing_env:") ||
    [
      "invalid_workflow_api_url",
      "invalid_workflow_action_ref",
      "invalid_reusable_workflow_action_ref",
      "invalid_reusable_workflow_runtime_ref",
      "invalid_workflow_env_key",
    ].includes(message)
  ) {
    return "server_misconfigured";
  }
  if (message.startsWith("distributed_lock_not_acquired:")) {
    return "operation_already_running";
  }
  return "github_operation_failed";
}
