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

async function loadRepositoryForWorkspace(input: {
  readonly prisma: PrismaClient;
  readonly workspaceId: string;
  readonly repositoryId: string;
}): Promise<{
  readonly id: string;
  readonly workspaceId: string;
  readonly fullName: string;
  readonly selected: boolean;
  readonly archived: boolean;
  readonly installation: { readonly status: string };
}> {
  const repository = await input.prisma.repositoryConnection.findUnique({
    where: { id: input.repositoryId },
    select: {
      id: true,
      workspaceId: true,
      fullName: true,
      selected: true,
      archived: true,
      installation: { select: { status: true } },
    },
  });
  if (!repository || repository.workspaceId !== input.workspaceId) {
    throw new Error("repository_not_found");
  }

  return repository;
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

function readReviewConfigurationForm(formData: FormData): ReviewConfiguration {
  const authMode = readFormString(
    formData,
    "providerAuthMode",
  ) as ReviewConfiguration["provider"]["authMode"];

  return {
    schemaVersion: 1,
    provider: {
      kind: authMode === "openrouter_api_key" ? "openrouter" : "codex",
      authMode,
      model: readFormString(formData, "model"),
      reasoningEffort: readFormString(
        formData,
        "reasoningEffort",
      ) as ReviewConfiguration["provider"]["reasoningEffort"],
      agenticContext: readFormBoolean(formData, "agenticContext"),
      fastMode: readFormBoolean(formData, "fastMode"),
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

function readWorkflowStyle(formData: FormData): "reusable" | "explicit" {
  const value = formData.get("workflowStyle");
  return value === "explicit" ? "explicit" : "reusable";
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
    message.startsWith("invalid_form_boolean:")
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
      "workflow_provisioning_disabled",
      "org_ruleset_requires_organization_installation",
      "org_ruleset_no_selected_repositories",
      "org_ruleset_all_repositories_requires_all_access",
      "org_admin_permission_required",
      "org_rulesets_not_supported",
      "org_ruleset_permission_update_pending",
      "github_org_ruleset_validation_failed",
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
