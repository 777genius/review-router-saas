import type { PrismaClient } from "@prisma/client";
import type {
  WorkflowProvisioningAttempt,
  WorkflowProvisioningRecord,
  WorkflowProvisioningScope,
} from "../../application/ports/workflow-provisioning-repository-port";
import { preferredSetupBaseBranches } from "../../domain/workflow-provisioning";
import { workflowProvisioningTransaction } from "./workflow-provisioning-transaction";
import {
  findProvisioningRepository,
  provisioningScopeWhere,
} from "./workflow-provisioning-scope";

export type WorkflowProvisioningPullRequestIdentity =
  WorkflowProvisioningScope & {
    readonly setupBranch: string | null;
    readonly pullRequestNumber: number | null;
    readonly expectedAttempt?: Pick<
      WorkflowProvisioningAttempt,
      "attemptId" | "revision"
    >;
  };

type Failure =
  | "setup_pr_closed"
  | "setup_pr_branch_deleted"
  | "setup_pr_wrong_base_branch";

export class PrismaWorkflowProvisioningStatusAuthority {
  constructor(private readonly prisma: PrismaClient) {}

  async markConfigured(
    input: WorkflowProvisioningPullRequestIdentity & {
      readonly baseBranch: string;
    },
  ): Promise<boolean> {
    return this.transition(input, {
      status: "configured",
      baseBranch: input.baseBranch,
    });
  }

  async assertConfigured(
    input: WorkflowProvisioningPullRequestIdentity & {
      readonly baseBranch: string;
    },
  ): Promise<void> {
    if (!(await this.markConfigured(input)))
      throw new Error("workflow_provisioning_match_not_found");
  }

  async markFailed(
    input: WorkflowProvisioningPullRequestIdentity & {
      readonly reason: Failure;
    },
  ): Promise<boolean> {
    return this.transition(input, { status: "failed", reason: input.reason });
  }

  async assertFailed(
    input: WorkflowProvisioningPullRequestIdentity & {
      readonly reason: Failure;
    },
  ): Promise<void> {
    if (!(await this.markFailed(input)))
      throw new Error("workflow_provisioning_match_not_found");
  }

  /** Called only after the current installed workflow and provider activation
   * have been verified. The pre-verification snapshot fences asynchronous probes. */
  async confirmInstalledWorkflow(
    input: WorkflowProvisioningRecord & {
      readonly baseBranch: string;
      readonly expectedAttempt: Pick<
        WorkflowProvisioningAttempt,
        "attemptId" | "revision"
      > | null;
    },
  ): Promise<void> {
    await workflowProvisioningTransaction(this.prisma, async (tx) => {
      const repository = await findProvisioningRepository(tx, input);
      if (
        !repository ||
        !preferredSetupBaseBranches(repository.defaultBranch).includes(
          input.baseBranch,
        )
      )
        throw new Error("workflow_provisioning_match_not_found");
      const current = await tx.workflowProvisioning.findUnique({
        where: { repositoryId: input.repositoryId },
      });
      if (!current) {
        if (input.expectedAttempt)
          throw new Error("workflow_provisioning_match_not_found");
        await tx.workflowProvisioning.create({
          data: {
            workspaceId: input.workspaceId,
            repositoryId: input.repositoryId,
            installationId: input.installationId,
            status: "configured",
            branch: input.branch,
            workflowPath: input.workflowPath,
            workflowStyle: input.workflowStyle,
            actionVersion: input.actionVersion,
          },
        });
        return;
      }
      if (
        input.expectedAttempt === null &&
        current.workspaceId === input.workspaceId &&
        current.installationId === input.installationId &&
        current.status === "configured" &&
        current.pullRequestUrl === null &&
        current.branch === input.branch &&
        current.workflowPath === input.workflowPath &&
        current.workflowStyle === input.workflowStyle &&
        current.actionVersion === input.actionVersion
      )
        return;
      if (
        current.workspaceId !== input.workspaceId ||
        current.installationId !== input.installationId ||
        current.attemptId !== input.expectedAttempt?.attemptId
      )
        throw new Error("workflow_provisioning_match_not_found");
      if (current.status === "configured") return;
      if (current.revision !== input.expectedAttempt.revision)
        throw new Error("workflow_provisioning_match_not_found");
      const updated = await tx.workflowProvisioning.updateMany({
        where: {
          ...provisioningScopeWhere(input),
          attemptId: current.attemptId,
          revision: current.revision,
          status: current.status,
        },
        data: {
          status: "configured",
          errorMessage: null,
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1)
        throw new Error("workflow_provisioning_concurrent_transition");
    });
  }

  private async transition(
    input: WorkflowProvisioningPullRequestIdentity,
    next:
      | { status: "configured"; baseBranch: string }
      | { status: "failed"; reason: Failure },
  ): Promise<boolean> {
    return workflowProvisioningTransaction(this.prisma, async (tx) => {
      const repository = await findProvisioningRepository(tx, input);
      if (
        !repository ||
        (next.status === "configured" &&
          !preferredSetupBaseBranches(repository.defaultBranch).includes(
            next.baseBranch,
          ))
      )
        return false;
      const current = await tx.workflowProvisioning.findFirst({
        where: provisioningScopeWhere(input),
      });
      // A reused branch alone never establishes which attempt created a PR.
      if (
        !current ||
        !current.pullRequestUrl ||
        current.branch !== input.setupBranch ||
        pullRequestNumberFromUrl(current.pullRequestUrl) !==
          input.pullRequestNumber ||
        (input.expectedAttempt &&
          current.attemptId !== input.expectedAttempt.attemptId)
      )
        return false;
      if (current.status === "configured") {
        if (next.status === "failed")
          throw new Error("workflow_provisioning_already_configured");
        return true;
      }
      if (current.status !== "setup_pr_open" && current.status !== "failed")
        return false;
      if (
        input.expectedAttempt &&
        current.revision !== input.expectedAttempt.revision
      )
        return false;
      if (
        next.status === "failed" &&
        current.status === "failed" &&
        current.errorMessage === next.reason
      )
        return true;
      const updated = await tx.workflowProvisioning.updateMany({
        where: {
          ...provisioningScopeWhere(input),
          id: current.id,
          attemptId: current.attemptId,
          revision: current.revision,
          status: current.status,
          branch: current.branch,
          pullRequestUrl: current.pullRequestUrl,
        },
        data: {
          status: next.status,
          errorMessage: next.status === "failed" ? next.reason : null,
          revision: { increment: 1 },
        },
      });
      return updated.count === 1;
    });
  }
}

function pullRequestNumberFromUrl(url: string): number | null {
  const match = /\/pull\/(\d+)(?:$|[?#])/.exec(url);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
