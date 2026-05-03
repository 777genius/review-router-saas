"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  recordAuditEvent,
  PrismaAuditLogRepository,
} from "@reviewrouter/features-audit-log";
import { OutboxInstallationSyncRequester } from "@reviewrouter/features-github-installations";
import {
  PrismaOutboxEventRepository,
  retryDeadLetterOutboxEvent,
} from "@reviewrouter/features-outbox";
import {
  PrismaReviewConfigurationRepository,
  resolveReviewRuntimeEnv,
  saveReviewConfiguration,
  type ReviewConfiguration,
} from "@reviewrouter/features-review-config";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  OctokitWorkflowSetupGateway,
  PrismaWorkflowProvisioningRepository,
  PrismaWorkflowProvisioningTarget,
  provisionRepositoryReviewRouterWorkflow,
} from "@reviewrouter/features-workflow-provisioning";
import { PostgresAdvisoryLock } from "@reviewrouter/platform-locks";
import {
  assertDashboardMutationAllowed,
  createGitHubAppInstallationOctokit,
} from "../../src/server/dashboard-mutations";
import { getPrisma } from "../../src/server/prisma";

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
    const clockNow = new Date();
    const deliveryBucket = Math.floor(clockNow.getTime() / 60_000);

    const result = await new PostgresAdvisoryLock(prisma).withLock(
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
    };
  } catch (error) {
    params = { error: safeDashboardErrorCode(error) };
  }

  revalidatePath("/dashboard");
  redirectWithParams(params);
}

export async function createSetupPullRequestAction(
  formData: FormData,
): Promise<never> {
  const prisma = getPrisma();
  const repositoryId = readFormString(formData, "repositoryId");
  const workspaceId = readFormString(formData, "workspaceId");
  let params: Record<string, string>;

  try {
    const repository = await prisma.repositoryConnection.findUnique({
      where: { id: repositoryId },
      select: {
        workspaceId: true,
        fullName: true,
        installation: {
          select: { githubInstallationId: true },
        },
      },
    });
    if (!repository || repository.workspaceId !== workspaceId) {
      throw new Error("repository_not_found");
    }

    const actor = await assertDashboardMutationAllowed(workspaceId);
    const octokit = await createGitHubAppInstallationOctokit(
      repository.installation.githubInstallationId.toString(),
    );
    const staticRuntimeEnv = await loadStaticRuntimeEnv({
      prisma,
      workspaceId,
      repositoryId,
    });

    const pullRequest = await new PostgresAdvisoryLock(prisma).withLock(
      `repo:${repositoryId}:workflow-provision`,
      60_000,
      async () =>
        provisionRepositoryReviewRouterWorkflow(
          {
            repositoryId,
            actionRef:
              process.env.REVIEW_ROUTER_ACTION_REF ??
              "777genius/review-router@v1",
            apiUrl:
              process.env.REVIEW_ROUTER_PUBLIC_API_URL ??
              process.env.REVIEW_ROUTER_API_URL ??
              "http://localhost:4000",
            runtimeConfigMode: "oidc",
            staticRuntimeEnv,
            actor: actor.actor,
          },
          {
            targets: new PrismaWorkflowProvisioningTarget(prisma),
            setupGateway: new OctokitWorkflowSetupGateway(octokit),
            provisioning: new PrismaWorkflowProvisioningRepository(prisma),
            auditLog: new PrismaAuditLogRepository(prisma),
            enabled:
              process.env.REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING !== "0",
          },
        ),
    );

    params = {
      notice: "setup_pr_ready",
      repository: repository.fullName,
      pr: pullRequest.url,
    };
  } catch (error) {
    params = { error: safeDashboardErrorCode(error) };
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
    const authMode = readFormString(
      formData,
      "providerAuthMode",
    ) as ReviewConfiguration["provider"]["authMode"];
    const config: ReviewConfiguration = {
      schemaVersion: 1,
      provider: {
        kind: authMode === "openrouter_api_key" ? "openrouter" : "codex",
        authMode,
        model: readFormString(formData, "model"),
        reasoningEffort: readFormString(
          formData,
          "reasoningEffort",
        ) as ReviewConfiguration["provider"]["reasoningEffort"],
        agenticContext: readFormString(formData, "agenticContext") === "true",
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

export async function retryOutboxEventAction(
  formData: FormData,
): Promise<never> {
  const prisma = getPrisma();
  const workspaceId = readFormString(formData, "workspaceId");
  const eventId = readFormString(formData, "eventId");
  let params: Record<string, string>;

  try {
    const actor = await assertDashboardMutationAllowed(workspaceId);
    const outbox = new PrismaOutboxEventRepository(prisma);
    const result = await new PostgresAdvisoryLock(prisma).withLock(
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

function readFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing_form_value:${key}`);
  }
  return value;
}

function readFormNumber(formData: FormData, key: string): number {
  const value = Number(readFormString(formData, key));
  if (!Number.isFinite(value)) {
    throw new Error(`invalid_form_number:${key}`);
  }
  return value;
}

function redirectWithParams(params: Record<string, string>): never {
  redirect(`/dashboard?${new URLSearchParams(params).toString()}`);
}

function safeDashboardErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  if (message.startsWith("workspace_mutation_forbidden:")) {
    return "workspace_mutation_forbidden";
  }
  if (
    [
      "dashboard_mutations_disabled",
      "dashboard_mutation_requires_sign_in",
      "installation_not_found",
      "repository_not_found",
      "repository_not_selected",
      "repository_archived",
      "installation_not_active",
      "workflow_provisioning_disabled",
    ].includes(message)
  ) {
    return message;
  }
  if (message.startsWith("missing_env:")) {
    return "server_misconfigured";
  }
  if (message.startsWith("distributed_lock_not_acquired:")) {
    return "operation_already_running";
  }
  return "github_operation_failed";
}
