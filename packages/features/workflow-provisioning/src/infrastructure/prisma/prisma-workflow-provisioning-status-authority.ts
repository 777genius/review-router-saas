import type { Prisma, PrismaClient } from "@prisma/client";

export type WorkflowProvisioningPullRequestIdentity = {
  readonly repositoryId: string;
  readonly setupBranch: string | null;
  readonly pullRequestNumber: number | null;
};

export class PrismaWorkflowProvisioningStatusAuthority {
  constructor(private readonly prisma: PrismaClient) {}

  async markConfigured(
    input: WorkflowProvisioningPullRequestIdentity,
  ): Promise<boolean> {
    return this.updateExpected(
      input,
      {},
      { status: "configured", errorMessage: null },
    );
  }

  async assertConfigured(
    input: WorkflowProvisioningPullRequestIdentity,
  ): Promise<void> {
    if (!(await this.markConfigured(input))) {
      throw new Error("workflow_provisioning_match_not_found");
    }
  }

  async markFailed(
    input: WorkflowProvisioningPullRequestIdentity & {
      readonly reason:
        | "setup_pr_closed"
        | "setup_pr_branch_deleted"
        | "setup_pr_wrong_base_branch";
    },
  ): Promise<boolean> {
    return this.updateExpected(
      input,
      { status: { in: ["setup_pr_open", "failed"] } },
      { status: "failed", errorMessage: input.reason },
    );
  }

  async assertFailed(
    input: WorkflowProvisioningPullRequestIdentity & {
      readonly reason:
        | "setup_pr_closed"
        | "setup_pr_branch_deleted"
        | "setup_pr_wrong_base_branch";
    },
  ): Promise<void> {
    if (!(await this.markFailed(input))) {
      throw new Error("workflow_provisioning_match_not_found");
    }
  }

  private async updateExpected(
    input: WorkflowProvisioningPullRequestIdentity,
    additionalWhere: Prisma.WorkflowProvisioningWhereInput,
    data: Prisma.WorkflowProvisioningUpdateInput,
  ): Promise<boolean> {
    const identityWhere = workflowProvisioningPullRequestWhere(input);

    return this.prisma.$transaction(async (tx) => {
      const matches = await tx.workflowProvisioning.findMany({
        where: { ...identityWhere, ...additionalWhere },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 2,
        select: { id: true },
      });
      if (matches.length === 0) return false;
      if (matches.length !== 1) {
        throw new Error("workflow_provisioning_match_ambiguous");
      }

      await tx.workflowProvisioning.update({
        where: { id: matches[0]!.id },
        data,
      });
      return true;
    });
  }
}

function workflowProvisioningPullRequestWhere(
  input: WorkflowProvisioningPullRequestIdentity,
): Prisma.WorkflowProvisioningWhereInput {
  const identities: Prisma.WorkflowProvisioningWhereInput[] = [
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
  ];
  if (identities.length === 0) {
    throw new Error("workflow_provisioning_identity_required");
  }

  return {
    repositoryId: input.repositoryId,
    OR: identities,
  };
}
