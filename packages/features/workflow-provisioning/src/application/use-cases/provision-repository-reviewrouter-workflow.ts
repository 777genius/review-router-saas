import type { AuditLogRepositoryPort } from "@reviewrouter/features-audit-log";
import type {
  ReviewRouterDiscussionMode,
  ReviewRouterWorkflowStyle,
} from "../../domain/workflow-template";
import {
  CodexRotatingT0WorkflowSchemaVersion,
  CodexRotatingReviewActionV2Mode,
  type CodexRotatingT0WorkflowSchemaVersion as CodexRotatingWorkflowSchemaVersion,
  type VersionedProviderSecretNamespace,
} from "@reviewrouter/features-codex-oauth-rotating";
import { provisionReviewRouterWorkflow } from "./provision-reviewrouter-workflow";
import type { WorkflowProvisioningRepositoryPort } from "../ports/workflow-provisioning-repository-port";
import type { WorkflowSetupGatewayPort } from "../ports/workflow-setup-gateway-port";
import type { WorkflowProvisioningTargetPort } from "../ports/workflow-provisioning-target-port";

export type ProvisionRepositoryReviewRouterWorkflowInput = {
  readonly workspaceId: string;
  readonly installationId: string;
  readonly repositoryId: string;
  readonly actionRef: string;
  readonly apiUrl: string;
  readonly runtimeConfigMode: "oidc" | "static";
  readonly staticRuntimeEnv?: Readonly<Record<string, string>>;
  readonly workflowStyle?: ReviewRouterWorkflowStyle;
  readonly discussionMode?: ReviewRouterDiscussionMode;
  readonly conflictReviewFallbackEnabled?: boolean;
  readonly forkAgenticSandboxEnabled?: boolean;
  readonly codexRotatingProviderInstanceId?: string;
  readonly codexRotatingWorkflowSecretNamespace?: VersionedProviderSecretNamespace;
  readonly codexRotatingReviewActionV2Mode?: CodexRotatingReviewActionV2Mode;
  readonly codexRotatingWorkflowSchemaVersion?: CodexRotatingWorkflowSchemaVersion;
  readonly actor?: string;
};

export async function provisionRepositoryReviewRouterWorkflow(
  input: ProvisionRepositoryReviewRouterWorkflowInput,
  dependencies: {
    readonly targets: WorkflowProvisioningTargetPort;
    readonly setupGateway: WorkflowSetupGatewayPort;
    readonly provisioning: WorkflowProvisioningRepositoryPort;
    readonly auditLog?: AuditLogRepositoryPort;
    readonly enabled?: boolean;
    readonly auditMetadata?: Readonly<Record<string, unknown>>;
  },
) {
  const target =
    await dependencies.targets.findWorkflowProvisioningTarget(input);

  if (
    !target ||
    target.workspaceId !== input.workspaceId ||
    target.installationId !== input.installationId ||
    target.repositoryId !== input.repositoryId
  ) {
    throw new Error("repository_not_found");
  }
  if (!target.selected) {
    throw new Error("repository_not_selected");
  }
  if (target.archived) {
    throw new Error("repository_archived");
  }
  if (target.installationStatus !== "active") {
    throw new Error("installation_not_active");
  }
  if (
    input.codexRotatingProviderInstanceId &&
    (!input.codexRotatingWorkflowSecretNamespace ||
      input.codexRotatingWorkflowSecretNamespace.scope.providerInstanceId !==
        input.codexRotatingProviderInstanceId)
  ) {
    throw new Error("codex_rotating_active_secret_namespace_required");
  }

  return provisionReviewRouterWorkflow(
    {
      workspaceId: input.workspaceId,
      installationId: input.installationId,
      repositoryId: input.repositoryId,
      owner: target.owner,
      name: target.name,
      defaultBranch: target.defaultBranch,
      actionRef: input.actionRef,
      apiUrl: input.apiUrl,
      runtimeConfigMode: input.runtimeConfigMode,
      ...(input.workflowStyle ? { workflowStyle: input.workflowStyle } : {}),
      ...(input.discussionMode ? { discussionMode: input.discussionMode } : {}),
      ...(input.conflictReviewFallbackEnabled === undefined
        ? {}
        : {
            conflictReviewFallbackEnabled: input.conflictReviewFallbackEnabled,
          }),
      ...(input.forkAgenticSandboxEnabled === undefined
        ? {}
        : {
            forkAgenticSandboxEnabled: input.forkAgenticSandboxEnabled,
          }),
      ...(input.codexRotatingProviderInstanceId
        ? {
            codexRotatingProviderInstanceId:
              input.codexRotatingProviderInstanceId,
            codexRotatingWorkflowSecretNamespace:
              input.codexRotatingWorkflowSecretNamespace!,
          }
        : {}),
      ...(input.codexRotatingProviderInstanceId
        ? {
            codexRotatingReviewActionV2Mode:
              input.codexRotatingReviewActionV2Mode ??
              CodexRotatingReviewActionV2Mode.T0,
          }
        : input.codexRotatingReviewActionV2Mode
          ? {
              codexRotatingReviewActionV2Mode:
                input.codexRotatingReviewActionV2Mode,
            }
          : {}),
      ...(input.codexRotatingProviderInstanceId
        ? {
            codexRotatingWorkflowSchemaVersion:
              input.codexRotatingWorkflowSchemaVersion ??
              CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
          }
        : input.codexRotatingWorkflowSchemaVersion !== undefined
          ? {
              codexRotatingWorkflowSchemaVersion:
                input.codexRotatingWorkflowSchemaVersion,
            }
          : {}),
      ...(input.staticRuntimeEnv
        ? { staticRuntimeEnv: input.staticRuntimeEnv }
        : {}),
    },
    {
      setupGateway: dependencies.setupGateway,
      provisioning: dependencies.provisioning,
      ...(dependencies.auditLog ? { auditLog: dependencies.auditLog } : {}),
      ...(dependencies.enabled === undefined
        ? {}
        : { enabled: dependencies.enabled }),
      ...(input.actor ? { actor: input.actor } : {}),
      ...(dependencies.auditMetadata
        ? { auditMetadata: dependencies.auditMetadata }
        : {}),
    },
  );
}
