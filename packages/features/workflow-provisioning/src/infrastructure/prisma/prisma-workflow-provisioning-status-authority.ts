import { Prisma, type PrismaClient } from "@prisma/client";

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
    return this.prisma.$transaction(async (tx) => {
      const candidate = await findLatestProvisioningCandidate(tx, input);
      if (!candidate || !matchesPullRequestIdentity(candidate, input)) {
        return false;
      }
      if (candidate.status === "configured") return true;
      if (
        candidate.status !== "setup_pr_open" &&
        candidate.status !== "failed"
      ) {
        return false;
      }

      const updated = await tx.workflowProvisioning.updateMany({
        where: {
          id: candidate.id,
          status: { in: ["setup_pr_open", "failed"] },
          ...candidateIdentityWhere(candidate),
        },
        data: { status: "configured", errorMessage: null },
      });
      if (updated.count === 1) return true;

      const raced = await tx.workflowProvisioning.findUnique({
        where: { id: candidate.id },
        select: { status: true },
      });
      if (raced?.status === "configured") return true;
      throw new Error("workflow_provisioning_concurrent_transition");
    }, serializableTransactionOptions);
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
    return this.prisma.$transaction(async (tx) => {
      const candidate = await findLatestProvisioningCandidate(tx, input);
      if (!candidate || !matchesPullRequestIdentity(candidate, input)) {
        return false;
      }
      if (candidate.status === "configured") {
        throw new Error("workflow_provisioning_already_configured");
      }
      if (
        candidate.status !== "setup_pr_open" &&
        candidate.status !== "failed"
      ) {
        return false;
      }
      if (
        candidate.status === "failed" &&
        candidate.errorMessage === input.reason
      ) {
        return true;
      }

      const updated = await tx.workflowProvisioning.updateMany({
        where: {
          id: candidate.id,
          status: { in: ["setup_pr_open", "failed"] },
          ...candidateIdentityWhere(candidate),
        },
        data: { status: "failed", errorMessage: input.reason },
      });
      if (updated.count === 1) return true;

      const raced = await tx.workflowProvisioning.findUnique({
        where: { id: candidate.id },
        select: { status: true },
      });
      if (raced?.status === "configured") {
        throw new Error("workflow_provisioning_already_configured");
      }
      throw new Error("workflow_provisioning_concurrent_transition");
    }, serializableTransactionOptions);
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
}

type ProvisioningCandidate = {
  readonly id: string;
  readonly status: "not_started" | "setup_pr_open" | "configured" | "failed";
  readonly branch: string;
  readonly pullRequestUrl: string | null;
  readonly errorMessage: string | null;
};

async function findLatestProvisioningCandidate(
  tx: Prisma.TransactionClient,
  input: WorkflowProvisioningPullRequestIdentity,
): Promise<ProvisioningCandidate | null> {
  if (!input.setupBranch && !input.pullRequestNumber) {
    throw new Error("workflow_provisioning_identity_required");
  }

  return tx.workflowProvisioning.findFirst({
    where: { repositoryId: input.repositoryId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      status: true,
      branch: true,
      pullRequestUrl: true,
      errorMessage: true,
    },
  });
}

function matchesPullRequestIdentity(
  candidate: ProvisioningCandidate,
  input: WorkflowProvisioningPullRequestIdentity,
): boolean {
  if (candidate.pullRequestUrl) {
    const recordedPullRequestNumber = pullRequestNumberFromUrl(
      candidate.pullRequestUrl,
    );
    return (
      recordedPullRequestNumber !== null &&
      recordedPullRequestNumber === input.pullRequestNumber
    );
  }
  return input.setupBranch !== null && candidate.branch === input.setupBranch;
}

function candidateIdentityWhere(
  candidate: ProvisioningCandidate,
): Prisma.WorkflowProvisioningWhereInput {
  return candidate.pullRequestUrl
    ? { pullRequestUrl: candidate.pullRequestUrl }
    : { branch: candidate.branch, pullRequestUrl: null };
}

function pullRequestNumberFromUrl(url: string): number | null {
  const match = /\/pull\/(\d+)(?:$|[?#])/.exec(url);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

const serializableTransactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} as const;
