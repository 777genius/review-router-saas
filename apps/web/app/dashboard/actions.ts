"use server";

import { createHash } from "node:crypto";
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
} from "@reviewrouter/features-memory";
import type { ProviderKind } from "@reviewrouter/features-review-providers";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  isCodexRotatingOAuthAllowedForRepository,
  isCodexRotatingOAuthAllowedForWorkspaceDefault,
  isConflictReviewFallbackAllowedForRepository,
  isWorkflowProvisioningEnabled,
  isHostedCodexPoolEnabled,
  requireReviewRouterDatabaseRecoveryWitness,
  resolveHostedPoolActionRelease,
  resolveReviewRouterActionRef,
  resolveReviewRouterCodexRotatingActionRef,
  resolveReviewRouterCodexRotatingTrustedActionRefs,
} from "@reviewrouter/platform-config";
import { OctokitRepositoryWorkflowProbe } from "@reviewrouter/features-repo-health";
import {
  CodexRotatingReviewActionV2Mode,
  defaultCodexRotatingWorkflowPath,
  defaultWorkflowPath,
  OctokitWorkflowSetupGateway,
  preferredSetupBaseBranches,
  PrismaWorkflowProvisioningRepository,
  PrismaWorkflowProvisioningStatusAuthority,
  PrismaWorkflowProvisioningTarget,
  provisionRepositoryReviewRouterWorkflow,
  provisionHostedPoolRepositoryWorkflow,
  canonicalHostedPoolProviderInstanceId,
  assertActiveVersionedSecretWorkflowAttestation,
  assertTrustedCanonicalVersionedWorkflow,
  createVersionedSecretWorkflowSourceAttestation,
  isVersionedSecretNamespaceCodexWorkflowSchemaVersion,
  readCanonicalCodexRotatingT0WorkflowSourceMetadata,
  workflowDocumentSemanticSha256,
  WorkflowSourceTrust,
} from "@reviewrouter/features-workflow-provisioning";
import {
  confirmCodexRotatingSetupReadiness,
  inspectCodexRotatingWorkflowNamespace,
  inspectCodexRotatingSetupReadiness,
  type CodexRotatingWorkflowNamespaceInspection,
  type ProviderSecretScope,
} from "@reviewrouter/features-provider-setup";
import { PostgresLeaseLock } from "@reviewrouter/platform-locks";
import {
  asDashboardGitHubActor,
  assertDashboardMutationAllowed,
  assertDashboardRepositoryConfigMutationAllowed,
  assertDashboardRepositoryMutationAllowed,
  createGitHubAppInstallationOctokit,
  createGitHubUserOctokit,
  dashboardMutationAccessAuditMetadata,
  getDashboardSignedInActor,
  getDashboardWorkspaceScope,
  type DashboardMutationActor,
} from "../../src/server/dashboard-mutations";
import {
  createDashboardMemoryDependencies,
  resolveDashboardMemoryActor,
} from "../../src/server/dashboard-memory";
import { createDashboardRateLimitPolicy } from "../../src/server/dashboard-rate-limits";
import { refreshGitHubUserRepositoryAccess } from "../../src/server/github-user-repository-access";
import { getPrisma } from "../../src/server/prisma";
import { inspectSetupPullRequest } from "../../src/server/setup-pull-request-status";
import {
  AppFirstWorkflowSetupGateway,
  safeWorkflowSetupFallbackReason,
} from "../../src/server/workflow-setup-gateway-fallback";
import { resolveWorkflowPublicApiUrl } from "../../src/server/workflow-public-api-url";
import { isWorkflowSetupAlreadyCurrent } from "../../src/server/workflow-setup-readiness";
import { activateConfirmedCodexNamespaceAfterWorkflowMerge } from "../../src/server/codex-rotating-workflow-activation";
import { activateConfirmedHostedPoolBindingAfterWorkflowMerge } from "../../src/server/hosted-pool-workflow-activation";
import { PrismaCodexRotatingSetupReadiness } from "../../src/server/prisma-codex-rotating-setup-readiness";
import { PrismaCodexRotatingWorkflowNamespace } from "../../src/server/prisma-codex-rotating-workflow-namespace";
import type {
  CodexRotatingVersionedWriterSchemaVersion,
  CodexRotatingWriterSchemaPolicy,
} from "../../src/server/codex-rotating-writer-schema-policy";
import { createCodexRotatingWriterSchemaPolicy } from "../../src/server/codex-rotating-writer-schema-policy-env";
import {
  providerSecretAvailabilityStatusForError,
  providerSecretNamesForAuthMode,
  providerSetupStateForSecretCheckError,
  readFormString,
  readMemoryScope,
  readOptionalEditedMemory,
  readOptionalFormString,
  readOptionalPositiveInteger,
  readProviderSecretScope,
  readProviderSetupConfirmationMode,
  readProviderSetupSelection,
  readReviewConfigurationForm,
  readReviewDiscussionMode,
  readWorkflowStyle,
} from "./dashboard-action-form-readers";
import { safeDashboardErrorCode } from "./dashboard-error-codes";
import {
  changeHostedPoolAccountState,
  changeHostedRepositorySessionSource,
  importHostedPoolAccount,
  type HostedPoolDashboardMutationDependencies,
  type HostedSessionSource,
} from "../../src/server/hosted-pool-dashboard";
import { createPrismaHostedPoolDashboardMutationPort } from "../../src/server/prisma-hosted-pool-mutations";

export async function requestInstallationSyncAction(
  formData: FormData,
): Promise<never> {
  const params = await requestInstallationSyncMutation(formData);

  revalidatePath("/dashboard");
  revalidatePath("/setup");
  redirectAfterMutation(formData, params);
}

export async function importHostedPoolAccountClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const workspaceId = readFormString(formData, "workspaceId");
  const file = formData.get("authJson");
  let authJson = new Uint8Array();
  try {
    await importHostedPoolAccount(
      {
        workspaceId,
        label: readFormString(formData, "label"),
        priority: readNonNegativeInteger(formData, "priority"),
        authJson: async () => {
          if (!(file instanceof File))
            throw new Error("hosted_account_auth_file_invalid");
          authJson = new Uint8Array(await file.arrayBuffer());
          return authJson;
        },
      },
      createHostedPoolDashboardMutationDependencies(),
    );
    revalidatePath("/dashboard");
    return {
      params: {
        notice: "hosted_pool_account_added",
        workspace: workspaceId,
        section: "setup",
      },
    };
  } catch (error) {
    return {
      params: {
        error: safeDashboardErrorCode(error),
        workspace: workspaceId,
        section: "setup",
      },
    };
  } finally {
    authJson.fill(0);
  }
}

export async function setHostedPoolAccountStateClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const workspaceId = readFormString(formData, "workspaceId");
  try {
    const state = readFormString(formData, "state");
    if (state !== "healthy" && state !== "paused")
      throw new Error("hosted_account_state_invalid");
    await changeHostedPoolAccountState(
      {
        workspaceId,
        accountId: readFormString(formData, "accountId"),
        state,
        expectedVersion: readNonNegativeInteger(formData, "expectedVersion"),
      },
      createHostedPoolDashboardMutationDependencies(),
    );
    revalidatePath("/dashboard");
    return {
      params: {
        notice: "hosted_pool_account_updated",
        workspace: workspaceId,
        section: "setup",
      },
    };
  } catch (error) {
    return {
      params: {
        error: safeDashboardErrorCode(error),
        workspace: workspaceId,
        section: "setup",
      },
    };
  }
}

export async function setHostedRepositorySessionSourceClientAction(
  formData: FormData,
): Promise<{ readonly params: Record<string, string> }> {
  const workspaceId = readFormString(formData, "workspaceId");
  try {
    const source = readFormString(formData, "source") as HostedSessionSource;
    if (source !== "repository_secret" && source !== "hosted_workspace_pool")
      throw new Error("hosted_session_source_invalid");
    const repositoryId = readFormString(formData, "repositoryId");
    const expectedVersion = readNonNegativeInteger(formData, "expectedVersion");
    const result =
      source === "repository_secret"
        ? {
            activation: "pending" as const,
            setupPullRequest: await provisionPendingRepositoryOwnedWorkflow({
              workspaceId,
              repositoryId,
              expectedBindingRevision: expectedVersion,
            }),
          }
        : await changeHostedRepositorySessionSource(
            {
              workspaceId,
              repositoryId,
              source,
              expectedVersion,
            },
            createHostedPoolDashboardMutationDependencies(),
          );
    const setupPullRequest =
      "setupPullRequest" in result
        ? result.setupPullRequest
        : result.activation === "pending" &&
            result.bindingId &&
            result.bindingRevision
          ? await provisionPendingHostedPoolWorkflow({
              workspaceId,
              repositoryId,
              bindingId: result.bindingId,
              bindingRevision: result.bindingRevision,
            })
          : null;
    revalidatePath("/dashboard");
    return {
      params: {
        notice:
          result.activation === "pending"
            ? "hosted_pool_activation_pending"
            : "hosted_pool_source_updated",
        workspace: workspaceId,
        section: "repositories",
        ...(setupPullRequest ? { pr: setupPullRequest.url } : {}),
      },
    };
  } catch (error) {
    return {
      params: {
        error: safeDashboardErrorCode(error),
        workspace: workspaceId,
        section: "repositories",
      },
    };
  }
}

async function provisionPendingHostedPoolWorkflow(input: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
}) {
  const prisma = getPrisma();
  const repository = await prisma.repositoryConnection.findUnique({
    where: { id: input.repositoryId },
    select: {
      id: true,
      workspaceId: true,
      provider: true,
      githubRepositoryId: true,
      owner: true,
      name: true,
      fullName: true,
      visibility: true,
      defaultBranch: true,
      selected: true,
      archived: true,
      installation: {
        select: { status: true, githubInstallationId: true },
      },
    },
  });
  if (
    !repository ||
    repository.workspaceId !== input.workspaceId ||
    repository.provider !== "github" ||
    !repository.githubRepositoryId ||
    !repository.installation
  ) {
    throw new Error("repository_not_found");
  }
  const githubRepository = {
    ...repository,
    githubRepositoryId: repository.githubRepositoryId,
    installation: repository.installation,
  };
  const actor = await assertDashboardRepositoryMutationAllowed(
    input.workspaceId,
    githubRepository,
  );
  const octokit = await createGitHubAppInstallationOctokit(
    repository.installation.githubInstallationId.toString(),
  );
  await assertRepositoryVisibleToGitHubApp({
    octokit,
    repository: githubRepository,
  });
  const setupGateway = new AppFirstWorkflowSetupGateway({
    primary: new OctokitWorkflowSetupGateway(octokit),
    ...(actor.accessSource?.source === "repo_manager"
      ? {
          fallback: async () =>
            new OctokitWorkflowSetupGateway(
              await createGitHubUserOctokit(actor),
            ),
        }
      : {}),
  });
  return new PostgresLeaseLock(prisma).withLock(
    `repo:${input.repositoryId}:workflow-provision`,
    5 * 60_000,
    async () =>
      provisionHostedPoolRepositoryWorkflow(
        {
          repositoryId: input.repositoryId,
          actionRef: resolveHostedPoolActionRelease().actionRef,
          apiUrl: resolveWorkflowPublicApiUrl(),
          providerInstanceId: canonicalHostedPoolProviderInstanceId(
            githubRepository.githubRepositoryId.toString(),
          ),
          bindingId: input.bindingId,
          bindingRevision: input.bindingRevision,
          actor: actor.actor,
        },
        {
          targets: new PrismaWorkflowProvisioningTarget(prisma),
          setupGateway,
          provisioning: new PrismaWorkflowProvisioningRepository(prisma),
          auditLog: new PrismaAuditLogRepository(prisma),
          enabled: isWorkflowProvisioningEnabled(),
          auditMetadata: dashboardMutationAccessAuditMetadata(actor),
        },
      ),
  );
}

async function provisionPendingRepositoryOwnedWorkflow(input: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly expectedBindingRevision: number;
}) {
  if (!isHostedCodexPoolEnabled())
    throw new Error("hosted_pool_feature_disabled");
  if (input.expectedBindingRevision < 1)
    throw new Error("hosted_pool_binding_revision_conflict");
  const prisma = getPrisma();
  const [repository, binding] = await Promise.all([
    prisma.repositoryConnection.findUnique({
      where: { id: input.repositoryId },
      select: {
        id: true,
        workspaceId: true,
        provider: true,
        githubRepositoryId: true,
        owner: true,
        name: true,
        fullName: true,
        visibility: true,
        defaultBranch: true,
        selected: true,
        archived: true,
        installation: {
          select: { status: true, githubInstallationId: true },
        },
      },
    }),
    prisma.hostedCodexRepositoryBinding.findFirst({
      where: {
        repositoryConnectionId: input.repositoryId,
        workspaceId: input.workspaceId,
        status: "active",
        revision: BigInt(input.expectedBindingRevision),
        tombstonedAt: null,
      },
      select: { id: true },
    }),
  ]);
  if (
    !repository ||
    !binding ||
    repository.workspaceId !== input.workspaceId ||
    repository.provider !== "github" ||
    !repository.githubRepositoryId ||
    !repository.installation
  ) {
    throw new Error("hosted_pool_binding_revision_conflict");
  }
  const githubRepository = {
    ...repository,
    githubRepositoryId: repository.githubRepositoryId,
    installation: repository.installation,
  };
  assertRepositoryConfigMutable(githubRepository);
  const actor = await assertDashboardRepositoryMutationAllowed(
    input.workspaceId,
    githubRepository,
  );
  await assertDashboardEntitlement({
    prisma,
    workspaceId: input.workspaceId,
    actor: actor.actor,
    feature: "workflow_provisioning",
  });
  await assertDashboardEntitlement({
    prisma,
    workspaceId: input.workspaceId,
    actor: actor.actor,
    feature: "hosted_codex_pool",
  });
  const providerInstanceId = `codex-rotating:${repository.githubRepositoryId.toString()}`;
  await inspectCodexRotatingSetupReadiness(
    {
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      githubRepositoryId: repository.githubRepositoryId.toString(),
      providerInstanceId,
    },
    {
      readiness: new PrismaCodexRotatingSetupReadiness(
        prisma,
        requireReviewRouterDatabaseRecoveryWitness(),
      ),
    },
  );
  const namespaceInspection = await resolveCodexWorkflowSecretNamespace({
    prisma,
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    githubRepositoryId: repository.githubRepositoryId.toString(),
    providerInstanceId,
  });
  const writerSchemaVersion = await selectCodexRotatingWriterSchemaVersion({
    prisma,
    inspection: namespaceInspection,
    policy: createCodexRotatingWriterSchemaPolicy(),
  });
  const resolvedRuntime = await loadResolvedReviewRuntime({
    prisma,
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
  });
  const octokit = await createGitHubAppInstallationOctokit(
    repository.installation.githubInstallationId.toString(),
  );
  await assertRepositoryVisibleToGitHubApp({
    octokit,
    repository: githubRepository,
  });
  const actionRef = await resolveCodexRotatingProvisioningActionRef({
    prisma,
    inspection: namespaceInspection,
    octokit,
    owner: repository.owner,
    name: repository.name,
    defaultBranch: repository.defaultBranch,
    expectedRepositoryId: repository.githubRepositoryId.toString(),
    expectedRepositoryFullName: repository.fullName,
    expectedProviderInstanceId: providerInstanceId,
  });
  const setupGateway = new AppFirstWorkflowSetupGateway({
    primary: new OctokitWorkflowSetupGateway(octokit),
    ...(actor.accessSource?.source === "repo_manager"
      ? {
          fallback: async () =>
            new OctokitWorkflowSetupGateway(
              await createGitHubUserOctokit(actor),
            ),
        }
      : {}),
  });
  return new PostgresLeaseLock(prisma).withLock(
    `repo:${input.repositoryId}:workflow-provision`,
    5 * 60_000,
    async () =>
      provisionRepositoryReviewRouterWorkflow(
        {
          repositoryId: input.repositoryId,
          actionRef,
          apiUrl: resolveWorkflowPublicApiUrl(),
          runtimeConfigMode: "oidc",
          staticRuntimeEnv: resolvedRuntime.runtimeEnv,
          codexRotatingProviderInstanceId: providerInstanceId,
          codexRotatingWorkflowSecretNamespace: namespaceInspection.namespace,
          codexRotatingReviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
          forkAgenticSandboxEnabled: false,
          codexRotatingWorkflowSchemaVersion: writerSchemaVersion,
          actor: actor.actor,
        },
        {
          targets: new PrismaWorkflowProvisioningTarget(prisma),
          setupGateway,
          provisioning: new PrismaWorkflowProvisioningRepository(prisma),
          auditLog: new PrismaAuditLogRepository(prisma),
          enabled: isWorkflowProvisioningEnabled(),
          auditMetadata: {
            intent: "switch_to_repository_owned_rotating",
            expectedBindingRevision: input.expectedBindingRevision,
            ...dashboardMutationAccessAuditMetadata(actor),
          },
        },
      ),
  );
}

function createHostedPoolDashboardMutationDependencies(): HostedPoolDashboardMutationDependencies {
  const prisma = getPrisma();
  return {
    featureEnabled: isHostedCodexPoolEnabled(),
    authorizeWorkspaceAdmin: async (workspaceId) => {
      const actor = await assertDashboardMutationAllowed(workspaceId);
      return { actor: actor.actor };
    },
    assertEntitled: async (workspaceId, actor) =>
      assertDashboardEntitlement({
        prisma,
        workspaceId,
        actor,
        feature: "hosted_codex_pool",
      }),
    getRepository: async (repositoryId) =>
      prisma.repositoryConnection.findUnique({
        where: { id: repositoryId },
        select: {
          id: true,
          workspaceId: true,
          fullName: true,
          visibility: true,
        },
      }),
    mutations: createPrismaHostedPoolDashboardMutationPort({
      prisma,
      env: process.env,
    }),
    now: () => new Date(),
  };
}

function readNonNegativeInteger(formData: FormData, name: string): number {
  const value = Number(readFormString(formData, name));
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name}_invalid`);
  return value;
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
    const githubActor = asDashboardGitHubActor(actor);
    if (!githubActor) {
      throw new Error("github_user_identity_required");
    }
    await createDashboardRateLimitPolicy(
      prisma,
    ).assertRepositoryAccessRefreshAllowed({ userId: githubActor.userId });
    const workspaceScope = await getDashboardWorkspaceScope();
    const result = await refreshGitHubUserRepositoryAccess({
      prisma,
      actor: githubActor,
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
  const rotatingCodex =
    providerSetup.authMode === "codex_subscription_oauth_rotating";
  const secretNames = rotatingCodex
    ? []
    : providerSecretNamesForAuthMode(providerSetup.authMode);

  try {
    const repository = await loadRepositoryForWorkspace({
      prisma,
      workspaceId,
      repositoryId,
    });
    assertCodexRotatingProviderSetupAllowed({
      providerSetup,
      repositoryFullName: repository.fullName,
      repositoryVisibility: repository.visibility,
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

    if (rotatingCodex) {
      try {
        await inspectCodexRotatingSetupReadiness(
          {
            workspaceId,
            repositoryId,
            githubRepositoryId: repository.githubRepositoryId.toString(),
            providerInstanceId: `codex-rotating:${repository.githubRepositoryId.toString()}`,
          },
          {
            readiness: new PrismaCodexRotatingSetupReadiness(
              prisma,
              requireReviewRouterDatabaseRecoveryWitness(),
            ),
          },
        );
        return { status: "available_repository" };
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "codex_rotating_setup_not_ready"
        ) {
          return { status: "missing" };
        }
        throw error;
      }
    }

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
  const discussionMode = readReviewDiscussionMode(formData);
  let params: Record<string, string>;

  try {
    const repository = await prisma.repositoryConnection.findUnique({
      where: { id: repositoryId },
      select: {
        workspaceId: true,
        provider: true,
        githubRepositoryId: true,
        owner: true,
        name: true,
        fullName: true,
        visibility: true,
        defaultBranch: true,
        installation: {
          select: { githubInstallationId: true },
        },
      },
    });
    if (!repository || repository.workspaceId !== workspaceId) {
      throw new Error("repository_not_found");
    }
    if (
      repository.provider !== "github" ||
      !repository.githubRepositoryId ||
      !repository.installation
    ) {
      throw new Error("repository_not_found");
    }
    const githubRepository = {
      ...repository,
      githubRepositoryId: repository.githubRepositoryId,
      installation: repository.installation,
    };

    const actor = await assertDashboardRepositoryMutationAllowed(
      workspaceId,
      githubRepository,
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
    const resolvedRuntime = await loadResolvedReviewRuntime({
      prisma,
      workspaceId,
      repositoryId,
    });
    assertCodexProductionReviewConfigAllowed(resolvedRuntime.config);
    assertCodexRotatingReviewConfigAllowed({
      config: resolvedRuntime.config,
      repository: githubRepository,
    });
    const workflowProviderKind = workflowReadinessProviderKind(
      resolvedRuntime.config,
    );
    const codexRotatingProviderInstanceId =
      resolveCodexRotatingProviderInstanceId({
        config: resolvedRuntime.config,
        githubRepositoryId: githubRepository.githubRepositoryId.toString(),
        repositoryFullName: repository.fullName,
        repositoryVisibility: repository.visibility,
      });
    const codexRotatingSecretInputs = codexRotatingProviderInstanceId
      ? codexRotatingWorkflowSecretInputs(resolvedRuntime.config)
      : null;
    const codexRotatingWorkflowNamespaceInspection =
      codexRotatingProviderInstanceId
        ? await resolveCodexWorkflowSecretNamespace({
            prisma,
            workspaceId,
            repositoryId,
            githubRepositoryId: githubRepository.githubRepositoryId.toString(),
            providerInstanceId: codexRotatingProviderInstanceId,
          })
        : undefined;
    const codexRotatingWorkflowSecretNamespace =
      codexRotatingWorkflowNamespaceInspection?.namespace;
    const codexRotatingV2Provisioning = codexRotatingProviderInstanceId
      ? {
          codexRotatingReviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
          codexRotatingWorkflowSchemaVersion:
            await selectCodexRotatingWriterSchemaVersion({
              prisma,
              inspection: codexRotatingWorkflowNamespaceInspection!,
              policy: createCodexRotatingWriterSchemaPolicy(),
            }),
        }
      : null;
    const forkAgenticSandboxEnabled = false;
    const octokit = await createGitHubAppInstallationOctokit(
      githubRepository.installation.githubInstallationId.toString(),
    );
    const setupBaseBranch = await resolveDashboardSetupBaseBranch({
      octokit,
      owner: repository.owner,
      name: repository.name,
      defaultBranch: repository.defaultBranch,
    });
    const actionRef = codexRotatingProviderInstanceId
      ? await resolveCodexRotatingProvisioningActionRef({
          prisma,
          inspection: codexRotatingWorkflowNamespaceInspection!,
          octokit,
          owner: repository.owner,
          name: repository.name,
          defaultBranch: repository.defaultBranch,
          expectedRepositoryId: githubRepository.githubRepositoryId.toString(),
          expectedRepositoryFullName: repository.fullName,
          expectedProviderInstanceId: codexRotatingProviderInstanceId,
        })
      : resolveReviewRouterActionRef();
    const conflictReviewFallbackAllowed = codexRotatingProviderInstanceId
      ? false
      : isConflictReviewFallbackAllowedForRepository(repository.fullName);
    const workflowReady = await isWorkflowSetupAlreadyCurrent(
      {
        githubInstallationId:
          githubRepository.installation.githubInstallationId.toString(),
        owner: repository.owner,
        name: repository.name,
        defaultBranch: setupBaseBranch,
        actionRef,
        discussionMode,
        conflictReviewFallbackEnabled: conflictReviewFallbackAllowed,
        ...(codexRotatingProviderInstanceId
          ? {
              codexRotatingProviderInstanceId,
              codexRotatingWorkflowSecretNamespace:
                codexRotatingWorkflowSecretNamespace!,
              forkAgenticSandboxEnabled,
              ...(codexRotatingSecretInputs ?? {}),
              ...(codexRotatingV2Provisioning ?? {}),
            }
          : {}),
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
            baseBranch: setupBaseBranch,
            workflowPath: codexRotatingProviderInstanceId
              ? defaultCodexRotatingWorkflowPath
              : defaultWorkflowPath,
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
      const setupGateway = new AppFirstWorkflowSetupGateway({
        primary: new OctokitWorkflowSetupGateway(octokit),
        ...(actor.accessSource?.source === "repo_manager"
          ? {
              fallback: async () =>
                new OctokitWorkflowSetupGateway(
                  await createGitHubUserOctokit(actor),
                ),
              onFallback: async ({ error }) => {
                await recordAuditEvent(
                  {
                    workspaceId,
                    actor: actor.actor,
                    action: "workflow.setup_pr_app_fallback",
                    targetType: "repository",
                    targetId: repositoryId,
                    metadata: {
                      reason: safeWorkflowSetupFallbackReason(error),
                      ...dashboardMutationAccessAuditMetadata(actor),
                    },
                  },
                  { auditLog: new PrismaAuditLogRepository(prisma) },
                );
              },
            }
          : {}),
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
              staticRuntimeEnv: resolvedRuntime.runtimeEnv,
              workflowStyle,
              discussionMode,
              conflictReviewFallbackEnabled: conflictReviewFallbackAllowed,
              ...(codexRotatingProviderInstanceId
                ? {
                    codexRotatingProviderInstanceId,
                    codexRotatingWorkflowSecretNamespace:
                      codexRotatingWorkflowSecretNamespace!,
                    forkAgenticSandboxEnabled,
                    ...(codexRotatingV2Provisioning ?? {}),
                  }
                : {}),
              actor: actor.actor,
            },
            {
              targets: new PrismaWorkflowProvisioningTarget(prisma),
              setupGateway,
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
        branch: pullRequest.baseBranch ?? setupBaseBranch,
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
    const writerSchemaPolicy = createCodexRotatingWriterSchemaPolicy();
    const repository = await prisma.repositoryConnection.findUnique({
      where: { id: repositoryId },
      select: {
        id: true,
        workspaceId: true,
        installationId: true,
        provider: true,
        githubRepositoryId: true,
        owner: true,
        name: true,
        fullName: true,
        visibility: true,
        defaultBranch: true,
        selected: true,
        archived: true,
        installation: {
          select: { status: true, githubInstallationId: true },
        },
        provisioning: {
          where: {
            workspaceId,
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            attemptId: true,
            revision: true,
            branch: true,
            pullRequestUrl: true,
          },
        },
      },
    });
    if (!repository || repository.workspaceId !== workspaceId) {
      throw new Error("repository_not_found");
    }
    if (
      repository.provider !== "github" ||
      !repository.githubRepositoryId ||
      !repository.installation ||
      !repository.installationId
    ) {
      throw new Error("repository_not_found");
    }
    const githubRepository = {
      ...repository,
      githubRepositoryId: repository.githubRepositoryId,
      installation: repository.installation,
    };
    assertRepositoryConfigMutable(githubRepository);

    const actor = await assertDashboardRepositoryMutationAllowed(
      workspaceId,
      githubRepository,
    );
    await assertDashboardEntitlement({
      prisma,
      workspaceId,
      actor: actor.actor,
      feature: "workflow_provisioning",
    });

    const octokit = await createGitHubAppInstallationOctokit(
      githubRepository.installation.githubInstallationId.toString(),
    );
    const setupProvisioning = repository.provisioning[0] ?? null;
    const pullRequestNumber = pullRequestNumberFromUrl(
      setupProvisioning?.pullRequestUrl ?? "",
    );
    const setupPullRequestInspection = pullRequestNumber
      ? await inspectSetupPullRequest(
          {
            owner: repository.owner,
            name: repository.name,
            pullRequestNumber,
            setupBranch: setupProvisioning?.branch ?? null,
            allowedBaseBranches: preferredSetupBaseBranches(
              repository.defaultBranch,
            ),
          },
          octokit,
        )
      : null;
    const setupPullRequestStatus = setupPullRequestInspection?.status ?? null;
    const setupPullRequestMerged = setupPullRequestStatus === "merged";
    const setupBaseBranch =
      setupPullRequestInspection?.baseBranch ??
      (await resolveDashboardSetupBaseBranch({
        octokit,
        owner: repository.owner,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
      }));
    if (setupPullRequestStatus === "wrong_base_branch") {
      await markRepositoryWorkflowSetupNeedsAttention({
        prisma,
        repositoryId,
        workspaceId,
        installationId: repository.installationId,
        expectedAttempt: setupProvisioning!,
        setupBranch: setupProvisioning?.branch ?? null,
        pullRequestNumber,
        reason: "setup_pr_wrong_base_branch",
      });
      throw new Error("setup_pr_wrong_base_branch");
    }
    const resolvedRuntime = setupPullRequestMerged
      ? null
      : await loadResolvedReviewRuntime({
          prisma,
          workspaceId,
          repositoryId,
        });
    const workflowProviderKind =
      resolvedRuntime === null
        ? undefined
        : workflowReadinessProviderKind(resolvedRuntime.config);
    if (resolvedRuntime !== null) {
      assertCodexProductionReviewConfigAllowed(resolvedRuntime.config);
      assertCodexRotatingReviewConfigAllowed({
        config: resolvedRuntime.config,
        repository: githubRepository,
      });
    }
    const codexRotatingProviderInstanceId =
      resolvedRuntime === null
        ? undefined
        : resolveCodexRotatingProviderInstanceId({
            config: resolvedRuntime.config,
            githubRepositoryId: githubRepository.githubRepositoryId.toString(),
            repositoryFullName: repository.fullName,
            repositoryVisibility: repository.visibility,
          });
    const codexRotatingSecretInputs =
      resolvedRuntime !== null && codexRotatingProviderInstanceId
        ? codexRotatingWorkflowSecretInputs(resolvedRuntime.config)
        : null;
    const codexRotatingWorkflowNamespaceInspection =
      codexRotatingProviderInstanceId
        ? await resolveCodexWorkflowSecretNamespace({
            prisma,
            workspaceId,
            repositoryId,
            githubRepositoryId: githubRepository.githubRepositoryId.toString(),
            providerInstanceId: codexRotatingProviderInstanceId,
          })
        : undefined;
    const codexRotatingWorkflowSecretNamespace =
      codexRotatingWorkflowNamespaceInspection?.namespace;
    const codexRotatingV2Provisioning = codexRotatingProviderInstanceId
      ? {
          codexRotatingReviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
          codexRotatingWorkflowSchemaVersion:
            await selectCodexRotatingWriterSchemaVersion({
              prisma,
              inspection: codexRotatingWorkflowNamespaceInspection!,
              policy: writerSchemaPolicy,
            }),
        }
      : null;
    const forkAgenticSandboxEnabled = false;
    const conflictReviewFallbackAllowed = codexRotatingProviderInstanceId
      ? false
      : isConflictReviewFallbackAllowedForRepository(repository.fullName);
    const verifiedWorkflowActionRef = setupPullRequestMerged
      ? null
      : codexRotatingProviderInstanceId
        ? await resolveCodexRotatingProvisioningActionRef({
            prisma,
            inspection: codexRotatingWorkflowNamespaceInspection!,
            octokit,
            owner: repository.owner,
            name: repository.name,
            defaultBranch: repository.defaultBranch,
            expectedRepositoryId:
              githubRepository.githubRepositoryId.toString(),
            expectedRepositoryFullName: repository.fullName,
            expectedProviderInstanceId: codexRotatingProviderInstanceId,
          })
        : resolveReviewRouterActionRef();
    const workflowReady = setupPullRequestMerged
      ? true
      : await isWorkflowSetupAlreadyCurrent(
          {
            githubInstallationId:
              githubRepository.installation.githubInstallationId.toString(),
            owner: repository.owner,
            name: repository.name,
            defaultBranch: setupBaseBranch,
            actionRef: verifiedWorkflowActionRef!,
            conflictReviewFallbackEnabled: conflictReviewFallbackAllowed,
            ...(codexRotatingProviderInstanceId
              ? {
                  codexRotatingProviderInstanceId,
                  codexRotatingWorkflowSecretNamespace:
                    codexRotatingWorkflowSecretNamespace!,
                  forkAgenticSandboxEnabled,
                  ...(codexRotatingSecretInputs ?? {}),
                  ...(codexRotatingV2Provisioning ?? {}),
                }
              : {}),
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
          workspaceId,
          installationId: repository.installationId,
          expectedAttempt: setupProvisioning!,
          setupBranch: setupProvisioning?.branch ?? null,
          pullRequestNumber,
          reason,
        });
        throw new Error(reason);
      }

      throw new Error("setup_pr_not_merged");
    }

    const hostedBinding = await prisma.hostedCodexRepositoryBinding.findFirst({
      where: {
        repositoryConnectionId: repositoryId,
        workspaceId,
        status: { in: ["pending_activation", "active"] },
        tombstonedAt: null,
      },
      select: { id: true, status: true, revision: true },
    });
    if (hostedBinding?.status === "pending_activation") {
      await activateConfirmedHostedPoolBindingAfterWorkflowMerge({
        prisma,
        octokit,
        workspaceId,
        repositoryId,
        githubRepositoryId: githubRepository.githubRepositoryId.toString(),
        owner: repository.owner,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        expectedRepositoryFullName: repository.fullName,
        expectedApiUrl: resolveWorkflowPublicApiUrl(),
        now: new Date(),
      });
    } else {
      await activateConfirmedCodexNamespaceAfterWorkflowMerge({
        prisma,
        octokit,
        workspaceId,
        repositoryId,
        githubRepositoryId: githubRepository.githubRepositoryId.toString(),
        owner: repository.owner,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        expectedRepositoryFullName: repository.fullName,
        expectedApiUrl: resolveWorkflowPublicApiUrl(),
        writerSchemaPolicy,
      });
      if (hostedBinding?.status === "active") {
        await createPrismaHostedPoolDashboardMutationPort({
          prisma,
          env: process.env,
        }).setRepositorySource({
          workspaceId,
          repositoryId,
          source: "repository_secret",
          expectedVersion: Number(hostedBinding.revision),
          requestedAt: new Date(),
        });
      }
    }

    const setupAuthority = new PrismaWorkflowProvisioningStatusAuthority(
      prisma,
    );
    const setupScope = {
      repositoryId,
      workspaceId,
      installationId: repository.installationId,
    };
    if (setupPullRequestMerged) {
      await setupAuthority.assertConfigured({
        ...setupScope,
        expectedAttempt: setupProvisioning!,
        setupBranch: setupProvisioning?.branch ?? null,
        pullRequestNumber,
        baseBranch: setupBaseBranch,
      });
    } else {
      await setupAuthority.confirmInstalledWorkflow({
        ...setupScope,
        expectedAttempt: setupProvisioning,
        baseBranch: setupBaseBranch,
        branch: setupProvisioning?.branch ?? "reviewrouter/setup",
        status: "configured",
        workflowPath: codexRotatingProviderInstanceId
          ? ".github/workflows/reviewrouter-codex.yml"
          : ".github/workflows/reviewrouter.yml",
        workflowStyle: "reusable",
        actionVersion: verifiedWorkflowActionRef!,
      });
    }
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
  const rotatingCodex =
    providerSetup.authMode === "codex_subscription_oauth_rotating";
  const secretNames = rotatingCodex
    ? []
    : providerSecretNamesForAuthMode(providerSetup.authMode);
  let params: Record<string, string>;

  try {
    const writerSchemaPolicy = createCodexRotatingWriterSchemaPolicy();
    const repository = await loadRepositoryForWorkspace({
      prisma,
      workspaceId,
      repositoryId,
    });
    assertCodexRotatingProviderSetupAllowed({
      providerSetup,
      repositoryFullName: repository.fullName,
      repositoryVisibility: repository.visibility,
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
    let rotatingReadiness:
      | Awaited<ReturnType<typeof confirmCodexRotatingSetupReadiness>>
      | undefined;
    if (rotatingCodex) {
      if (secretScope !== "repository" || confirmationMode !== "verified") {
        throw new Error("codex_rotating_setup_not_ready");
      }
      const octokit = await createGitHubAppInstallationOctokit(
        repository.installation.githubInstallationId.toString(),
      );
      await assertRepositoryVisibleToGitHubApp({ octokit, repository });
      await activateConfirmedCodexNamespaceAfterWorkflowMerge({
        prisma,
        octokit,
        workspaceId,
        repositoryId,
        githubRepositoryId: repository.githubRepositoryId.toString(),
        owner: repository.owner,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        expectedRepositoryFullName: repository.fullName,
        expectedApiUrl: resolveWorkflowPublicApiUrl(),
        writerSchemaPolicy,
      });
      rotatingReadiness = await confirmCodexRotatingSetupReadiness(
        {
          workspaceId,
          repositoryId,
          githubRepositoryId: repository.githubRepositoryId.toString(),
          providerInstanceId: `codex-rotating:${repository.githubRepositoryId.toString()}`,
        },
        {
          readiness: new PrismaCodexRotatingSetupReadiness(
            prisma,
            requireReviewRouterDatabaseRecoveryWitness(),
          ),
        },
      );
    } else {
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
    }
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
          requiredCredentialCount: rotatingCodex ? 1 : secretNames.length,
          ...(rotatingReadiness
            ? {
                readinessSource: "versioned_namespace_activation",
                namespaceEpoch: rotatingReadiness.namespaceEpoch.toString(10),
              }
            : {}),
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
    const failedState =
      rotatingCodex &&
      error instanceof Error &&
      error.message === "codex_rotating_setup_not_ready"
        ? "stale_or_invalid"
        : providerSetupStateForSecretCheckError(error);
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
    assertCodexProductionReviewConfigAllowed(config);
    assertCodexRotatingReviewConfigAllowed({
      config,
      repository: null,
    });

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
    assertCodexProductionReviewConfigAllowed(config);
    assertCodexRotatingReviewConfigAllowed({
      config,
      repository,
    });

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
    dashboardMemoryActorInput(dashboardActor),
    input.prisma,
  );

  return {
    dashboardActor,
    memoryActor,
    dependencies: createDashboardMemoryDependencies({
      prisma: input.prisma,
      actor: dashboardMemoryActorInput(dashboardActor),
    }),
  };
}

function dashboardMemoryActorInput(
  actor: DashboardMutationActor,
): Parameters<typeof resolveDashboardMemoryActor>[0] {
  return {
    userId: actor.userId,
    sourceProvider: actor.sourceProvider,
    sourceLogin: actor.sourceLogin,
    githubUserId: actor.githubUserId,
    githubLogin: actor.githubLogin,
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
  readonly defaultBranch: string;
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
      provider: true,
      githubRepositoryId: true,
      owner: true,
      name: true,
      fullName: true,
      defaultBranch: true,
      visibility: true,
      selected: true,
      archived: true,
      installation: { select: { status: true, githubInstallationId: true } },
    },
  });
  if (!repository || repository.workspaceId !== input.workspaceId) {
    throw new Error("repository_not_found");
  }
  if (
    repository.provider !== "github" ||
    !repository.githubRepositoryId ||
    !repository.installation
  ) {
    throw new Error("repository_not_found");
  }

  return {
    ...repository,
    githubRepositoryId: repository.githubRepositoryId,
    installation: repository.installation,
  };
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

type GitHubBranchRequester = {
  request: (
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<{ readonly data: unknown }>;
};

async function resolveDashboardSetupBaseBranch(input: {
  readonly octokit: GitHubBranchRequester;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
}): Promise<string> {
  for (const branch of preferredSetupBaseBranches(input.defaultBranch)) {
    if (await dashboardBranchExists(input, branch)) {
      return branch;
    }
  }
  return input.defaultBranch;
}

async function dashboardBranchExists(
  input: {
    readonly octokit: GitHubBranchRequester;
    readonly owner: string;
    readonly name: string;
  },
  branch: string,
): Promise<boolean> {
  try {
    await input.octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner: input.owner,
      repo: input.name,
      ref: `heads/${branch}`,
    });
    return true;
  } catch (error) {
    if (githubApiStatus(error) === 404) {
      return false;
    }
    throw error;
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

async function resolveCodexWorkflowSecretNamespace(input: {
  readonly prisma: PrismaClient;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly githubRepositoryId: string;
  readonly providerInstanceId: string;
}): Promise<CodexRotatingWorkflowNamespaceInspection> {
  const inspection = await inspectCodexRotatingWorkflowNamespace(
    {
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      githubRepositoryId: input.githubRepositoryId,
      providerInstanceId: input.providerInstanceId,
    },
    {
      workflowNamespace: new PrismaCodexRotatingWorkflowNamespace(
        input.prisma,
        requireReviewRouterDatabaseRecoveryWitness(),
      ),
    },
  );
  return inspection;
}

async function selectCodexRotatingWriterSchemaVersion(input: {
  readonly prisma: PrismaClient;
  readonly inspection: CodexRotatingWorkflowNamespaceInspection;
  readonly policy: CodexRotatingWriterSchemaPolicy;
}): Promise<CodexRotatingVersionedWriterSchemaVersion> {
  const activeNamespace =
    input.inspection.source === "active"
      ? await input.prisma.codexOAuthSecretNamespace.findUnique({
          where: {
            id: input.inspection.namespace.namespaceId,
          },
          select: { workflowSchemaVersion: true },
        })
      : null;
  return input.policy.selectWriterSchemaVersion({
    existingNamespace: input.inspection.source === "active",
    existingWorkflowSchemaVersion:
      activeNamespace?.workflowSchemaVersion ?? null,
  });
}

async function resolveCodexRotatingProvisioningActionRef(input: {
  readonly prisma: PrismaClient;
  readonly inspection: CodexRotatingWorkflowNamespaceInspection;
  readonly octokit: {
    request(
      route: string,
      parameters?: Record<string, unknown>,
    ): Promise<{ data: unknown }>;
  };
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly expectedRepositoryId: string;
  readonly expectedRepositoryFullName: string;
  readonly expectedProviderInstanceId: string;
}): Promise<string> {
  if (input.inspection.source === "confirmed_setup_candidate") {
    return resolveReviewRouterCodexRotatingActionRef();
  }

  // An active namespace is durably attested to the workflow already on the
  // default branch. Keep that exact Action SHA during an A -> B trust overlap;
  // changing it in place would strand queued A runs because a namespace has a
  // single active workflow-source attestation.
  const repositoryResponse = await input.octokit.request(
    "GET /repos/{owner}/{repo}",
    { owner: input.owner, repo: input.name },
  );
  const observedRepository = readGitHubRepositoryIdentity(
    repositoryResponse.data,
  );
  if (observedRepository.defaultBranch !== input.defaultBranch) {
    throw new Error("codex_rotating_workflow_default_branch_mismatch");
  }
  const expectedSource =
    await input.prisma.codexOAuthSecretNamespace.findUnique({
      where: { id: input.inspection.namespace.namespaceId },
      select: {
        workflowPath: true,
        workflowSourceCommitSha: true,
        workflowSourceBlobSha: true,
        workflowSourceSha256: true,
        workflowSemanticSha256: true,
        workflowSourceTrust: true,
        workflowSchemaVersion: true,
        attestedRepositoryId: true,
      },
    });
  if (
    expectedSource?.workflowPath !== defaultCodexRotatingWorkflowPath ||
    !expectedSource.workflowSourceCommitSha ||
    !expectedSource.workflowSourceBlobSha ||
    !expectedSource.workflowSourceSha256 ||
    !expectedSource.workflowSemanticSha256 ||
    expectedSource.workflowSchemaVersion === null ||
    expectedSource.workflowSourceTrust !==
      WorkflowSourceTrust.TrustedDefaultBranchRevision ||
    expectedSource.attestedRepositoryId !== input.expectedRepositoryId
  ) {
    throw new Error("codex_rotating_workflow_source_attestation_missing");
  }
  const contentResponse = await input.octokit.request(
    "GET /repos/{owner}/{repo}/contents/{path}",
    {
      owner: input.owner,
      repo: input.name,
      path: expectedSource.workflowPath,
      ref: expectedSource.workflowSourceCommitSha,
    },
  );
  const { source, blobSha } = readGitHubWorkflowBlob(contentResponse.data);
  const metadata = readCanonicalCodexRotatingT0WorkflowSourceMetadata(source);
  if (
    !isVersionedSecretNamespaceCodexWorkflowSchemaVersion(
      metadata.workflowSchemaVersion,
    )
  ) {
    throw new Error("codex_rotating_workflow_schema_version_mismatch");
  }
  assertTrustedCanonicalVersionedWorkflow({
    metadata,
    observedRepositoryId: observedRepository.id,
    observedRepositoryFullName: observedRepository.fullName,
    expectedRepositoryId: input.expectedRepositoryId,
    expectedRepositoryFullName: input.expectedRepositoryFullName,
    trustedActionRefs: resolveReviewRouterCodexRotatingTrustedActionRefs(),
    expectedApiUrl: resolveWorkflowPublicApiUrl(),
    expectedProviderInstanceId: input.expectedProviderInstanceId,
    expectedSecretNamespace: input.inspection.namespace,
    expectedWorkflowSchemaVersion: expectedSource.workflowSchemaVersion,
  });
  const observedAttestation = createVersionedSecretWorkflowSourceAttestation({
    repositoryId: input.expectedRepositoryId,
    workflowPath: expectedSource.workflowPath,
    workflowSourceCommitSha: expectedSource.workflowSourceCommitSha,
    workflowSourceBlobSha: blobSha,
    workflowSourceSha256: createHash("sha256").update(source).digest("hex"),
    workflowSemanticSha256: workflowDocumentSemanticSha256(source),
    workflowSchemaVersion: metadata.workflowSchemaVersion,
    sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
    secretNamespace: input.inspection.namespace,
  });
  assertActiveVersionedSecretWorkflowAttestation({
    attestation: observedAttestation,
    repositoryId: input.expectedRepositoryId,
    workflowPath: expectedSource.workflowPath,
    workflowSourceCommitSha: expectedSource.workflowSourceCommitSha,
    activeSecretNamespace: input.inspection.namespace,
    expectedWorkflowSource: {
      workflowPath: expectedSource.workflowPath,
      workflowSourceCommitSha: expectedSource.workflowSourceCommitSha,
      workflowSourceBlobSha: expectedSource.workflowSourceBlobSha,
      workflowSourceSha256: expectedSource.workflowSourceSha256,
      workflowSemanticSha256: expectedSource.workflowSemanticSha256,
      sourceTrust: expectedSource.workflowSourceTrust,
      repositoryId: expectedSource.attestedRepositoryId,
    },
  });
  return metadata.actionRef;
}

function readGitHubRepositoryIdentity(data: unknown): {
  readonly id: string;
  readonly fullName: string;
  readonly defaultBranch: string;
} {
  const repository = data as {
    id?: unknown;
    full_name?: unknown;
    default_branch?: unknown;
  } | null;
  if (
    typeof repository?.id !== "number" ||
    !Number.isSafeInteger(repository.id) ||
    repository.id <= 0 ||
    typeof repository.full_name !== "string" ||
    typeof repository.default_branch !== "string" ||
    repository.default_branch.length === 0
  ) {
    throw new Error("codex_rotating_workflow_repository_invalid_response");
  }
  return {
    id: String(repository.id),
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
  };
}

function readGitHubWorkflowBlob(data: unknown): {
  readonly source: string;
  readonly blobSha: string;
} {
  const blob = data as {
    type?: unknown;
    encoding?: unknown;
    content?: unknown;
    sha?: unknown;
  } | null;
  if (
    blob?.type !== "file" ||
    blob.encoding !== "base64" ||
    typeof blob.content !== "string" ||
    typeof blob.sha !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(blob.sha)
  ) {
    throw new Error("codex_rotating_workflow_content_invalid_response");
  }
  const source = Buffer.from(
    blob.content.replace(/\s+/g, ""),
    "base64",
  ).toString("utf8");
  const blobSha = blob.sha.toLowerCase();
  const computed = createHash(blobSha.length === 40 ? "sha1" : "sha256")
    .update(`blob ${Buffer.byteLength(source, "utf8")}\0`, "utf8")
    .update(source, "utf8")
    .digest("hex");
  if (computed !== blobSha) {
    throw new Error("codex_rotating_workflow_blob_sha_mismatch");
  }
  return { source, blobSha };
}

function codexRotatingWorkflowSecretInputs(config: ReviewConfiguration): {
  readonly codexRotatingClaudeCodeOAuthTokenSecret: boolean;
  readonly codexRotatingOpenRouterApiKeySecret: boolean;
} {
  return {
    codexRotatingClaudeCodeOAuthTokenSecret: config.providers.some(
      (provider) => provider.kind === "claude",
    ),
    codexRotatingOpenRouterApiKeySecret: config.providers.some(
      (provider) => provider.kind === "openrouter",
    ),
  };
}

function resolveCodexRotatingProviderInstanceId(input: {
  readonly config: ReviewConfiguration;
  readonly githubRepositoryId: string;
  readonly repositoryFullName: string;
  readonly repositoryVisibility: string;
}): string | undefined {
  const rotatingProviders = input.config.providers.filter(
    (provider) => provider.authMode === "codex_subscription_oauth_rotating",
  );
  if (rotatingProviders.length === 0) {
    return undefined;
  }
  assertCodexRotatingOAuthRepositoryAllowed({
    repositoryFullName: input.repositoryFullName,
    repositoryVisibility: input.repositoryVisibility,
  });
  if (
    rotatingProviders.length !== 1 ||
    rotatingProviders[0]?.kind !== "codex"
  ) {
    throw new Error("codex_rotating_single_provider_required");
  }
  return `codex-rotating:${input.githubRepositoryId}`;
}

function assertCodexRotatingProviderSetupAllowed(input: {
  readonly providerSetup: {
    readonly authMode: string;
  };
  readonly repositoryFullName: string;
  readonly repositoryVisibility: string;
}): void {
  if (input.providerSetup.authMode === "codex_subscription_oauth") {
    throw new Error("codex_legacy_auth_requires_reconnect");
  }
  if (input.providerSetup.authMode === "codex_openai_api_key") {
    throw new Error("codex_api_key_setup_disabled");
  }
  if (input.providerSetup.authMode !== "codex_subscription_oauth_rotating") {
    return;
  }
  assertCodexRotatingOAuthRepositoryAllowed(input);
}

function assertCodexProductionReviewConfigAllowed(
  config: ReviewConfiguration,
): void {
  const unsupportedCodex = config.providers.find(
    (provider) =>
      provider.authMode === "codex_subscription_oauth" ||
      provider.authMode === "codex_openai_api_key",
  );
  if (!unsupportedCodex) {
    return;
  }
  throw new Error(
    unsupportedCodex.authMode === "codex_subscription_oauth"
      ? "codex_legacy_auth_requires_reconnect"
      : "codex_api_key_setup_disabled",
  );
}

function assertCodexRotatingReviewConfigAllowed(input: {
  readonly config: ReviewConfiguration;
  readonly repository: {
    readonly fullName: string;
    readonly visibility: string;
  } | null;
}): void {
  const rotatingProviders = input.config.providers.filter(
    (provider) => provider.authMode === "codex_subscription_oauth_rotating",
  );
  if (rotatingProviders.length === 0) {
    return;
  }
  if (!input.repository) {
    if (!isCodexRotatingOAuthAllowedForWorkspaceDefault()) {
      throw new Error("codex_rotating_repository_scope_required");
    }
  } else {
    assertCodexRotatingOAuthRepositoryAllowed({
      repositoryFullName: input.repository.fullName,
      repositoryVisibility: input.repository.visibility,
    });
  }
  if (
    rotatingProviders.length !== 1 ||
    rotatingProviders[0]?.kind !== "codex"
  ) {
    throw new Error("codex_rotating_single_provider_required");
  }
}

function assertCodexRotatingOAuthRepositoryAllowed(input: {
  readonly repositoryFullName: string;
  readonly repositoryVisibility: string;
}): void {
  if (!isCodexRotatingOAuthAllowedForRepository(input.repositoryFullName)) {
    throw new Error("codex_rotating_not_enabled");
  }
}

async function markRepositoryWorkflowSetupNeedsAttention(input: {
  readonly workspaceId: string;
  readonly installationId: string;
  readonly expectedAttempt: {
    readonly attemptId: string;
    readonly revision: number;
  };
  readonly prisma: PrismaClient;
  readonly repositoryId: string;
  readonly setupBranch: string | null;
  readonly pullRequestNumber: number | null;
  readonly reason:
    | "setup_pr_closed"
    | "setup_pr_branch_deleted"
    | "setup_pr_wrong_base_branch";
}): Promise<void> {
  await new PrismaWorkflowProvisioningStatusAuthority(
    input.prisma,
  ).assertFailed(input);
}

function pullRequestNumberFromUrl(url: string): number | null {
  const match = /\/pull\/(\d+)(?:$|[?#])/.exec(url);
  if (!match) return null;

  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
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
