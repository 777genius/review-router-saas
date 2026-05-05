import type { AuditLogRepositoryPort } from "@reviewrouter/features-audit-log";
import { recordAuditEvent } from "@reviewrouter/features-audit-log";
import type { OutboxEventRepositoryPort } from "@reviewrouter/features-outbox";
import { enqueueOutboxEvent } from "@reviewrouter/features-outbox";
import { defaultRequiredWorkflowPath } from "@reviewrouter/features-workflow-provisioning";
import {
  assertOrganizationRulesetTarget,
  chooseDefaultSourceRepository,
  createOrgRulesetProvisioningRequest,
  defaultOrgRulesetSourceBranch,
  resolveOrgRulesetTargetSelection,
  type OrgRulesetEnforcement,
  type OrgRulesetScope,
} from "../../domain/org-ruleset-provisioning";
import type { OrgRulesetProvisioningRepositoryPort } from "../ports/org-ruleset-provisioning-repository-port";
import type { OrgRulesetSetupGatewayPort } from "../ports/org-ruleset-setup-gateway-port";

export type RequestOrgRulesetProvisioningInput = {
  readonly workspaceId: string;
  readonly githubInstallationId: string;
  readonly scope: OrgRulesetScope;
  readonly enforcement: OrgRulesetEnforcement;
  readonly targetRepositoryIds?: readonly string[];
  readonly actor: string;
  readonly requestedAt: Date;
};

export async function requestOrgRulesetProvisioning(
  input: RequestOrgRulesetProvisioningInput,
  dependencies: {
    readonly provisioning: OrgRulesetProvisioningRepositoryPort;
    readonly setupGateway: OrgRulesetSetupGatewayPort;
    readonly outbox: OutboxEventRepositoryPort;
    readonly auditLog?: AuditLogRepositoryPort | undefined;
  },
): Promise<{
  readonly provisioningId: string;
  readonly status: "queued";
}> {
  const target = await dependencies.provisioning.findTargetByInstallation({
    workspaceId: input.workspaceId,
    githubInstallationId: input.githubInstallationId,
  });
  if (!target) {
    throw new Error("installation_not_found");
  }
  assertOrganizationRulesetTarget(target);
  if (
    input.scope === "all_repositories" &&
    target.repositorySelection !== "all"
  ) {
    throw new Error("org_ruleset_all_repositories_requires_all_access");
  }

  const probe = await dependencies.setupGateway.probeOrganizationRulesetAccess({
    organizationLogin: target.organizationLogin,
  });
  if (!probe.ok) {
    await auditOptional(input.workspaceId, input.actor, {
      action: "org_ruleset.permission_required",
      targetId: target.installationId,
      metadata: {
        organizationLogin: target.organizationLogin,
        safeErrorCode: probe.safeErrorCode,
      },
      auditLog: dependencies.auditLog,
    });
    throw new Error(probe.safeErrorCode);
  }

  const sourceRepository = chooseDefaultSourceRepository(target);
  const targetSelection = resolveOrgRulesetTargetSelection({
    scope: input.scope,
    repositories: target.repositories,
    ...(input.targetRepositoryIds
      ? { selectedRepositoryIds: input.targetRepositoryIds }
      : {}),
  });
  const targetRepositoryIds =
    targetSelection.scope === "selected_repositories"
      ? targetSelection.repositoryIds
      : target.repositories
          .filter((repository) => repository.selected && !repository.archived)
          .map((repository) => repository.githubRepositoryId);
  const sourceWorkflowRef = `refs/heads/${sourceRepository.defaultBranch || defaultOrgRulesetSourceBranch}`;
  const request = createOrgRulesetProvisioningRequest({
    workspaceId: target.workspaceId,
    installationId: target.installationId,
    githubInstallationId: target.githubInstallationId,
    organizationLogin: target.organizationLogin,
    sourceRepositoryId: sourceRepository.id,
    sourceGithubRepositoryId: sourceRepository.githubRepositoryId,
    sourceRepositoryFullName: sourceRepository.fullName,
    sourceWorkflowPath: defaultRequiredWorkflowPath,
    sourceWorkflowRef,
    scope: input.scope,
    enforcement: input.enforcement,
    targetRepositoryIds,
    requestedBy: input.actor,
    requestedAt: input.requestedAt,
  });
  const record = await dependencies.provisioning.upsertRequested(request);

  await enqueueOutboxEvent(
    {
      type: "org_ruleset.provision_requested",
      version: 1,
      idempotencyKey: `org-ruleset:${record.id}:${record.requestedAt.toISOString()}`,
      workspaceId: record.workspaceId,
      aggregateId: `org-ruleset:${record.id}`,
      payload: { provisioningId: record.id },
      occurredAt: input.requestedAt,
      maxAttempts: 5,
    },
    { outbox: dependencies.outbox },
  );

  await auditOptional(input.workspaceId, input.actor, {
    action: "org_ruleset.provision_requested",
    targetId: record.id,
    metadata: {
      organizationLogin: record.organizationLogin,
      scope: record.scope,
      enforcement: record.enforcement,
      targetRepositoryCount: record.targetRepositoryIds.length,
      sourceRepository: record.sourceRepositoryFullName,
    },
    auditLog: dependencies.auditLog,
  });

  return { provisioningId: record.id, status: "queued" };
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
