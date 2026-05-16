import type { AuditLogRepositoryPort } from "@reviewrouter/features-audit-log";
import type { ReviewRouterWorkflowStyle } from "../../domain/workflow-template";
import { provisionReviewRouterWorkflow } from "./provision-reviewrouter-workflow";
import type { WorkflowProvisioningRepositoryPort } from "../ports/workflow-provisioning-repository-port";
import type { WorkflowSetupGatewayPort } from "../ports/workflow-setup-gateway-port";
import type { WorkflowProvisioningTargetPort } from "../ports/workflow-provisioning-target-port";

export type ProvisionRepositoryReviewRouterWorkflowInput = {
  readonly repositoryId: string;
  readonly actionRef: string;
  readonly apiUrl: string;
  readonly runtimeConfigMode: "oidc" | "static";
  readonly staticRuntimeEnv?: Readonly<Record<string, string>>;
  readonly workflowStyle?: ReviewRouterWorkflowStyle;
  readonly conflictReviewFallbackEnabled?: boolean;
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
  const target = await dependencies.targets.findWorkflowProvisioningTarget(
    input.repositoryId,
  );

  if (!target) {
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

  return provisionReviewRouterWorkflow(
    {
      workspaceId: target.workspaceId,
      repositoryId: target.repositoryId,
      owner: target.owner,
      name: target.name,
      defaultBranch: target.defaultBranch,
      actionRef: input.actionRef,
      apiUrl: input.apiUrl,
      runtimeConfigMode: input.runtimeConfigMode,
      ...(input.workflowStyle ? { workflowStyle: input.workflowStyle } : {}),
      ...(input.conflictReviewFallbackEnabled === undefined
        ? {}
        : {
            conflictReviewFallbackEnabled: input.conflictReviewFallbackEnabled,
          }),
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
