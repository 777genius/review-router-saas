import type { AuditLogRepositoryPort } from "@reviewrouter/features-audit-log";
import { recordAuditEvent } from "@reviewrouter/features-audit-log";
import {
  mapConfigToRuntimeEnv,
  safeDefaultReviewConfiguration,
} from "@reviewrouter/features-review-config";
import { renderReviewRouterRequiredWorkflow } from "@reviewrouter/features-workflow-provisioning";
import {
  buildGitHubOrgRulesetPayload,
  defaultOrgRulesetName,
  safeOrgRulesetErrorCode,
  safeOrgRulesetErrorSummary,
  type OrgRulesetTargetSelection,
} from "../../domain/org-ruleset-provisioning";
import type { OrgRulesetProvisioningRepositoryPort } from "../ports/org-ruleset-provisioning-repository-port";
import type { OrgRulesetSetupGatewayPort } from "../ports/org-ruleset-setup-gateway-port";

export type ProvisionOrgRulesetRequiredWorkflowInput = {
  readonly provisioningId: string;
  readonly actionRef: string;
  readonly apiUrl: string;
  readonly runtimeConfigMode: "oidc" | "static";
  readonly staticRuntimeEnv?: Readonly<Record<string, string>>;
  readonly attemptedAt: Date;
};

export async function provisionOrgRulesetRequiredWorkflow(
  input: ProvisionOrgRulesetRequiredWorkflowInput,
  dependencies: {
    readonly provisioning: OrgRulesetProvisioningRepositoryPort;
    readonly setupGateway?: OrgRulesetSetupGatewayPort;
    readonly createSetupGateway?: (
      githubInstallationId: string,
    ) => Promise<OrgRulesetSetupGatewayPort>;
    readonly auditLog?: AuditLogRepositoryPort | undefined;
  },
): Promise<{
  readonly rulesetId: string;
  readonly rulesetUrl: string | null;
}> {
  const record = await dependencies.provisioning.findById(input.provisioningId);
  if (!record) {
    throw new Error("org_ruleset_provisioning_not_found");
  }
  if (!record.sourceRepositoryFullName || !record.sourceGithubRepositoryId) {
    throw new Error("org_ruleset_source_repository_missing");
  }
  const setupGateway =
    dependencies.setupGateway ??
    (await dependencies.createSetupGateway?.(record.githubInstallationId));
  if (!setupGateway) {
    throw new Error("org_ruleset_setup_gateway_missing");
  }

  await dependencies.provisioning.markProcessing({
    id: record.id,
    attemptedAt: input.attemptedAt,
  });

  try {
    const [sourceOwner, sourceRepo] = splitRepositoryFullName(
      record.sourceRepositoryFullName,
    );
    const branch = branchNameFromRef(record.sourceWorkflowRef);
    const workflow = renderReviewRouterRequiredWorkflow({
      actionRef: input.actionRef,
      apiUrl: input.apiUrl,
      runtimeConfigMode: input.runtimeConfigMode,
      staticRuntimeEnv:
        input.staticRuntimeEnv ??
        mapConfigToRuntimeEnv(safeDefaultReviewConfiguration),
    });
    const sourceWrite = await writeSourceWorkflowWithSafeErrors(setupGateway, {
      owner: sourceOwner,
      repo: sourceRepo,
      branch,
      path: record.sourceWorkflowPath,
      content: workflow,
      message: "chore: add ReviewRouter required workflow",
    });
    const ruleset = await setupGateway.createOrUpdateOrganizationRuleset({
      organizationLogin: record.organizationLogin,
      name: defaultOrgRulesetName,
      payload: buildGitHubOrgRulesetPayload({
        name: defaultOrgRulesetName,
        enforcement: record.enforcement,
        sourceWorkflow: {
          repositoryId: record.sourceGithubRepositoryId,
          repositoryFullName: record.sourceRepositoryFullName,
          path: record.sourceWorkflowPath,
          ref: record.sourceWorkflowRef,
          sha: null,
        },
        targetSelection: toTargetSelection(
          record.scope,
          record.targetRepositoryIds,
          [sourceRepo],
        ),
      }),
    });

    await dependencies.provisioning.markConfigured({
      id: record.id,
      sourceWorkflowSha: sourceWrite.sha,
      rulesetId: ruleset.id,
      rulesetUrl: ruleset.url,
      configuredAt: input.attemptedAt,
    });
    await auditOptional(record.workspaceId, record.requestedBy, {
      auditLog: dependencies.auditLog,
      action: "org_ruleset.provision_configured",
      targetId: record.id,
      metadata: {
        organizationLogin: record.organizationLogin,
        rulesetId: ruleset.id,
        rulesetUrl: ruleset.url,
        sourceWorkflowPath: record.sourceWorkflowPath,
        sourceRepository: record.sourceRepositoryFullName,
      },
    });

    return { rulesetId: ruleset.id, rulesetUrl: ruleset.url };
  } catch (error) {
    const safeErrorCode = safeOrgRulesetErrorCode(error);
    const safeErrorSummary = safeOrgRulesetErrorSummary(error);
    await dependencies.provisioning.markFailed({
      id: record.id,
      safeErrorCode,
      safeErrorSummary,
    });
    await auditOptional(record.workspaceId, record.requestedBy, {
      auditLog: dependencies.auditLog,
      action: "org_ruleset.provision_failed",
      targetId: record.id,
      metadata: {
        organizationLogin: record.organizationLogin,
        safeErrorCode,
      },
    });
    throw error;
  }
}

async function writeSourceWorkflowWithSafeErrors(
  setupGateway: OrgRulesetSetupGatewayPort,
  input: Parameters<OrgRulesetSetupGatewayPort["writeSourceWorkflow"]>[0],
): ReturnType<OrgRulesetSetupGatewayPort["writeSourceWorkflow"]> {
  try {
    return await setupGateway.writeSourceWorkflow(input);
  } catch (error) {
    const status = getHttpStatus(error);
    if (status === 403) {
      throw new Error("org_ruleset_source_repository_not_writable");
    }
    if (status === 404) {
      throw new Error("org_ruleset_source_repository_not_installed");
    }
    if (status === 409 || status === 422) {
      throw new Error("org_ruleset_source_repository_branch_blocked");
    }
    throw error;
  }
}

function toTargetSelection(
  scope: "selected_repositories" | "all_repositories",
  targetRepositoryIds: readonly string[],
  excludeRepositoryNames: readonly string[],
): OrgRulesetTargetSelection {
  if (scope === "all_repositories") {
    return { scope, excludeRepositoryNames };
  }
  return { scope, repositoryIds: targetRepositoryIds };
}

function splitRepositoryFullName(fullName: string): readonly [string, string] {
  const [owner, repo, extra] = fullName.split("/");
  if (!owner || !repo || extra) {
    throw new Error("org_ruleset_source_repository_invalid");
  }
  return [owner, repo];
}

function branchNameFromRef(ref: string): string {
  const prefix = "refs/heads/";
  if (!ref.startsWith(prefix) || ref.length <= prefix.length) {
    throw new Error("workflow_ref_invalid");
  }
  return ref.slice(prefix.length);
}

function getHttpStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : 0;
}

async function auditOptional(
  workspaceId: string,
  actor: string,
  input: {
    readonly action: string;
    readonly targetId: string;
    readonly metadata: Record<string, unknown>;
    readonly auditLog?: AuditLogRepositoryPort | undefined;
  },
): Promise<void> {
  if (!input.auditLog) return;
  await recordAuditEvent(
    {
      workspaceId,
      actor,
      action: input.action,
      targetType: "org_ruleset_provisioning",
      targetId: input.targetId,
      metadata: input.metadata,
    },
    { auditLog: input.auditLog },
  );
}
