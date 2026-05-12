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
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
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
import { PostgresLeaseLock } from "@reviewrouter/platform-locks";
import {
  assertDashboardMutationAllowed,
  createGitHubAppInstallationOctokit,
} from "../../src/server/dashboard-mutations";
import {
  createDashboardMemoryDependencies,
  resolveDashboardMemoryActor,
} from "../../src/server/dashboard-memory";
import { createDashboardRateLimitPolicy } from "../../src/server/dashboard-rate-limits";
import { getPrisma } from "../../src/server/prisma";
import { resolveWorkflowPublicApiUrl } from "../../src/server/workflow-public-api-url";
import { isWorkflowSetupAlreadyCurrent } from "../../src/server/workflow-setup-readiness";

export async function requestInstallationSyncAction(
  formData: FormData,
): Promise<never> {
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

  revalidatePath("/dashboard");
  revalidatePath("/setup");
  redirectAfterMutation(formData, params);
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

  revalidatePath("/dashboard");
  revalidatePath("/setup");
  return { params };
}

export async function confirmSetupPullRequestMergedClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await confirmSetupPullRequestMergedMutation(formData);

  revalidatePath("/dashboard");
  revalidatePath("/setup");
  return { params };
}

export async function confirmProviderSecretSetupClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const params = await confirmProviderSecretSetupMutation(formData);

  revalidatePath("/dashboard");
  return { params };
}

export async function createMemoryItemAction(
  formData: FormData,
): Promise<never> {
  const params = await createMemoryItemMutation(formData);

  revalidatePath("/dashboard");
  redirectAfterMutation(formData, params);
}

export async function confirmMemorySuggestionAction(
  formData: FormData,
): Promise<never> {
  const params = await confirmMemorySuggestionMutation(formData);

  revalidatePath("/dashboard");
  redirectAfterMutation(formData, params);
}

export async function rejectMemorySuggestionAction(
  formData: FormData,
): Promise<never> {
  const params = await rejectMemorySuggestionMutation(formData);

  revalidatePath("/dashboard");
  redirectAfterMutation(formData, params);
}

export async function editMemoryItemAction(
  formData: FormData,
): Promise<never> {
  const params = await editMemoryItemMutation(formData);

  revalidatePath("/dashboard");
  redirectAfterMutation(formData, params);
}

export async function disableMemoryItemAction(
  formData: FormData,
): Promise<never> {
  const params = await disableMemoryItemMutation(formData);

  revalidatePath("/dashboard");
  redirectAfterMutation(formData, params);
}

export async function deleteMemoryItemAction(
  formData: FormData,
): Promise<never> {
  const params = await deleteMemoryItemMutation(formData);

  revalidatePath("/dashboard");
  redirectAfterMutation(formData, params);
}

export async function checkOpenRouterRepositorySecretClientAction(
  formData: FormData,
): Promise<{
  readonly status:
    | "available_repository"
    | "available_organization"
    | "missing"
    | "permission_required"
    | "unknown";
}> {
  const prisma = getPrisma();
  const workspaceId = readFormString(formData, "workspaceId");
  const repositoryId = readFormString(formData, "repositoryId");

  try {
    const repository = await loadRepositoryForWorkspace({
      prisma,
      workspaceId,
      repositoryId,
    });
    const actor = await assertDashboardMutationAllowed(workspaceId);
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

    return await checkOpenRouterSecretAvailability({
      octokit,
      repository,
    });
  } catch (error) {
    const failedState = providerSetupStateForSecretCheckError(error);
    if (failedState === "missing" || failedState === "stale_or_invalid") {
      return { status: "missing" };
    }
    if (failedState === "unknown") {
      return { status: "permission_required" };
    }

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

    const actor = await assertDashboardMutationAllowed(workspaceId);
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
    const workflowReady = await isWorkflowSetupAlreadyCurrent(
      {
        githubInstallationId:
          repository.installation.githubInstallationId.toString(),
        owner: repository.owner,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        actionRef,
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
      const staticRuntimeEnv = await loadStaticRuntimeEnv({
        prisma,
        workspaceId,
        repositoryId,
      });

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
              staticRuntimeEnv,
              workflowStyle,
              actor: actor.actor,
            },
            {
              targets: new PrismaWorkflowProvisioningTarget(prisma),
              setupGateway: new OctokitWorkflowSetupGateway(octokit),
              provisioning: new PrismaWorkflowProvisioningRepository(prisma),
              auditLog: new PrismaAuditLogRepository(prisma),
              enabled: isWorkflowProvisioningEnabled(),
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

    const actor = await assertDashboardMutationAllowed(workspaceId);
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
    const setupPullRequestMerged = pullRequestNumber
      ? await checkSetupPullRequestMerged(
          {
            owner: repository.owner,
            name: repository.name,
            pullRequestNumber,
            setupBranch: setupProvisioning?.branch ?? null,
          },
          octokit,
        )
      : false;
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
          },
          {
            workflowProbe: new OctokitRepositoryWorkflowProbe({
              createRequester: async () => octokit,
            }),
          },
        );

    if (!setupPullRequestMerged && !workflowReady) {
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

    const actor = await assertDashboardMutationAllowed(workspaceId);
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

  revalidatePath("/dashboard");
  redirectWithParams(params);
}

export async function saveWorkspaceReviewConfigAction(
  formData: FormData,
): Promise<never> {
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
        },
      },
      { auditLog: new PrismaAuditLogRepository(prisma) },
    );

    params = { notice: "review_config_saved", version: String(saved.version) };
  } catch (error) {
    params = { error: safeDashboardErrorCode(error) };
  }

  revalidatePath("/dashboard");
  redirectWithParams(params);
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

  revalidatePath("/dashboard");
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

    const actor = await assertDashboardMutationAllowed(workspaceId);
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

  revalidatePath("/dashboard");
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

    const actor = await assertDashboardMutationAllowed(workspaceId);
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

  revalidatePath("/dashboard");
  redirectWithParams(params);
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
  readonly secretScope: "repository" | "organization_selected_repositories";
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

async function checkOpenRouterSecretAvailability(input: {
  readonly octokit: Awaited<
    ReturnType<typeof createGitHubAppInstallationOctokit>
  >;
  readonly repository: Awaited<ReturnType<typeof loadRepositoryForWorkspace>>;
}): Promise<{
  readonly status:
    | "available_repository"
    | "available_organization"
    | "missing"
    | "permission_required"
    | "unknown";
}> {
  try {
    await verifyRepositorySecret({
      octokit: input.octokit,
      repository: input.repository,
      secretName: "OPENROUTER_API_KEY",
    });
    return { status: "available_repository" };
  } catch (error) {
    const state = providerSetupStateForSecretCheckError(error);
    if (state === "unknown") return { status: "permission_required" };
    if (state !== "missing") return { status: "unknown" };
  }

  try {
    await verifyOrganizationSecret({
      octokit: input.octokit,
      repository: input.repository,
      secretName: "OPENROUTER_API_KEY",
    });
    return { status: "available_organization" };
  } catch (error) {
    const state = providerSetupStateForSecretCheckError(error);
    if (state === "unknown") return { status: "permission_required" };
    if (state === "missing" || state === "stale_or_invalid") {
      return { status: "missing" };
    }

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

async function loadStaticRuntimeEnv(input: {
  readonly prisma: PrismaClient;
  readonly workspaceId: string;
  readonly repositoryId: string;
}): Promise<Record<string, string>> {
  const configurations = new PrismaReviewConfigurationRepository(input.prisma);
  const resolved = await resolveReviewRuntimeEnv(
    {
      scope: "repository",
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
    },
    { configurations },
  );
  return resolved.runtimeEnv;
}

async function checkSetupPullRequestMerged(
  input: {
    readonly owner: string;
    readonly name: string;
    readonly pullRequestNumber: number;
    readonly setupBranch: string | null;
  },
  octokit: Awaited<ReturnType<typeof createGitHubAppInstallationOctokit>>,
): Promise<boolean> {
  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: input.owner,
        repo: input.name,
        pull_number: input.pullRequestNumber,
      },
    );
    const pullRequest = response.data as {
      readonly merged?: unknown;
      readonly head?: { readonly ref?: unknown };
    };

    if (input.setupBranch && pullRequest.head?.ref !== input.setupBranch) {
      return false;
    }

    return pullRequest.merged === true;
  } catch {
    return false;
  }
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

function pullRequestNumberFromUrl(url: string): number | null {
  const match = /\/pull\/(\d+)(?:$|[?#])/.exec(url);
  if (!match) return null;

  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function readReviewConfigurationForm(formData: FormData): ReviewConfiguration {
  const providerCount = readFormNumber(formData, "providerCount");
  const providers = Array.from({ length: providerCount }, (_, index) => {
    const authMode = readFormString(
      formData,
      `providerAuthMode.${index}`,
    ) as ReviewConfiguration["provider"]["authMode"];

    return {
      kind: authMode === "openrouter_api_key" ? "openrouter" : "codex",
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

function readWorkflowStyle(formData: FormData): "reusable" | "explicit" {
  const value = formData.get("workflowStyle");
  return value === "explicit" ? "explicit" : "reusable";
}

function readProviderSetupSelection(formData: FormData): {
  readonly providerKind: "codex" | "openrouter";
  readonly authMode:
    | "codex_subscription_oauth"
    | "codex_openai_api_key"
    | "openrouter_api_key";
} {
  const providerKind = readFormString(formData, "providerKind");
  const authMode = readFormString(formData, "authMode");

  if (
    providerKind === "codex" &&
    (authMode === "codex_subscription_oauth" ||
      authMode === "codex_openai_api_key")
  ) {
    return { providerKind, authMode };
  }
  if (providerKind === "openrouter" && authMode === "openrouter_api_key") {
    return { providerKind, authMode };
  }

  throw new Error("invalid_form_value:providerSetup");
}

function readProviderSecretScope(
  formData: FormData,
): "repository" | "organization_selected_repositories" {
  const value = readFormString(formData, "secretScope");
  if (
    value === "repository" ||
    value === "organization_selected_repositories"
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
  authMode:
    | "codex_subscription_oauth"
    | "codex_openai_api_key"
    | "openrouter_api_key",
): readonly string[] {
  switch (authMode) {
    case "codex_subscription_oauth":
      return ["CODEX_AUTH_JSON"];
    case "codex_openai_api_key":
      return ["OPENAI_API_KEY"];
    case "openrouter_api_key":
      return ["OPENROUTER_API_KEY"];
  }
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
      "dashboard_mutations_disabled",
      "dashboard_auth_misconfigured",
      "dashboard_mutation_requires_sign_in",
      "installation_not_found",
      "repository_not_found",
      "repository_not_selected",
      "repository_archived",
      "installation_not_active",
      "setup_pr_not_merged",
      "repository_not_visible_to_github_app",
      "provider_secret_not_found",
      "provider_secret_not_available_to_repository",
      "provider_secret_check_permission_required",
      "workflow_provisioning_disabled",
      "org_ruleset_requires_organization_installation",
      "org_ruleset_no_selected_repositories",
      "org_ruleset_all_repositories_requires_all_access",
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
