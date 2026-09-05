import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type {
  WorkflowProvisioningAttempt,
  WorkflowProvisioningRecord,
  WorkflowProvisioningRepositoryPort,
} from "../../application/ports/workflow-provisioning-repository-port";
import { workflowProvisioningTransaction } from "./workflow-provisioning-transaction";
import {
  findProvisioningRepository,
  provisioningScopeWhere,
} from "./workflow-provisioning-scope";

export class PrismaWorkflowProvisioningRepository implements WorkflowProvisioningRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async beginAttempt(
    record: WorkflowProvisioningRecord,
  ): Promise<WorkflowProvisioningAttempt> {
    return workflowProvisioningTransaction(this.prisma, async (tx) => {
      if (!(await findProvisioningRepository(tx, record)))
        throw new Error("repository_not_found");
      const current = await tx.workflowProvisioning.findUnique({
        where: { repositoryId: record.repositoryId },
      });
      const attemptId = randomUUID();
      const data = {
        workspaceId: record.workspaceId,
        repositoryId: record.repositoryId,
        installationId: record.installationId,
        attemptId,
        revision: (current?.revision ?? -1) + 1,
        status: "not_started" as const,
        branch: `${record.branch}/${attemptId}`,
        workflowPath: record.workflowPath,
        workflowStyle: record.workflowStyle,
        actionVersion: record.actionVersion,
        pullRequestHeadSha: null,
        pullRequestUrl: null,
        errorMessage: null,
      };
      if (current) {
        const updated = await tx.workflowProvisioning.updateMany({
          where: {
            id: current.id,
            attemptId: current.attemptId,
            revision: current.revision,
            status: current.status,
            workspaceId: current.workspaceId,
            installationId: current.installationId,
          },
          data,
        });
        if (updated.count !== 1)
          throw new Error("workflow_provisioning_concurrent_transition");
      } else {
        await tx.workflowProvisioning.create({ data });
      }
      return {
        workspaceId: data.workspaceId,
        repositoryId: data.repositoryId,
        installationId: data.installationId,
        attemptId: data.attemptId,
        branch: data.branch,
        revision: data.revision,
      };
    });
  }

  async markSetupPullRequestOpen(
    record: WorkflowProvisioningRecord & WorkflowProvisioningAttempt,
  ): Promise<void> {
    await this.finishAttempt(record, "setup_pr_open");
  }

  async markFailed(
    record: WorkflowProvisioningRecord & WorkflowProvisioningAttempt,
  ): Promise<void> {
    await this.finishAttempt(record, "failed");
  }

  private async finishAttempt(
    record: WorkflowProvisioningRecord & WorkflowProvisioningAttempt,
    status: "setup_pr_open" | "failed",
  ): Promise<void> {
    await workflowProvisioningTransaction(this.prisma, async (tx) => {
      if (!(await findProvisioningRepository(tx, record))) return;
      const current = await tx.workflowProvisioning.findUnique({
        where: { repositoryId: record.repositoryId },
      });
      if (
        !current ||
        current.attemptId !== record.attemptId ||
        current.revision !== record.revision ||
        current.status !== "not_started" ||
        current.branch !== record.branch ||
        current.workflowPath !== record.workflowPath ||
        current.workflowStyle !== record.workflowStyle ||
        current.actionVersion !== record.actionVersion
      )
        return;
      if (
        status === "setup_pr_open" &&
        !/^[a-f0-9]{40}$/.test(record.pullRequestHeadSha ?? "")
      )
        throw new Error("workflow_provisioning_artifact_required");
      await tx.workflowProvisioning.updateMany({
        where: {
          ...provisioningScopeWhere(record),
          attemptId: record.attemptId,
          revision: record.revision,
          branch: record.branch,
          status: "not_started",
        },
        data: {
          status,
          revision: { increment: 1 },
          pullRequestHeadSha:
            status === "setup_pr_open" ? record.pullRequestHeadSha! : null,
          pullRequestUrl:
            status === "setup_pr_open" ? (record.pullRequestUrl ?? null) : null,
          errorMessage:
            status === "failed" ? (record.errorMessage ?? null) : null,
        },
      });
    });
  }
}
