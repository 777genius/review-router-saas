import { describe, expect, it, vi } from "vitest";
import { PrismaWorkflowProvisioningStatusAuthority } from "../infrastructure/prisma/prisma-workflow-provisioning-status-authority";

const identity = {
  repositoryId: "repository_1",
  setupBranch: "reviewrouter/setup",
  pullRequestNumber: 7,
} as const;

describe("PrismaWorkflowProvisioningStatusAuthority", () => {
  it("transitions the latest matching failed row to configured", async () => {
    const { authority, workflowProvisioning } = createAuthority(
      candidate({ status: "failed" }),
    );

    await expect(authority.markConfigured(identity)).resolves.toBe(true);
    expect(workflowProvisioning.findFirst).toHaveBeenCalledWith({
      where: { repositoryId: "repository_1" },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        branch: true,
        pullRequestUrl: true,
        errorMessage: true,
      },
    });
    expect(workflowProvisioning.updateMany).toHaveBeenCalledWith({
      where: {
        id: "provisioning_1",
        status: { in: ["setup_pr_open", "failed"] },
        pullRequestUrl: "https://github.com/acme/widget/pull/7",
      },
      data: { status: "configured", errorMessage: null },
    });
  });

  it("makes a repeated configured transition a true no-op", async () => {
    const { authority, workflowProvisioning } = createAuthority(
      candidate({ status: "failed" }),
    );

    await authority.markConfigured(identity);
    await authority.markConfigured(identity);

    expect(workflowProvisioning.updateMany).toHaveBeenCalledTimes(1);
  });

  it("rejects not_started as a configured transition source", async () => {
    const { authority, workflowProvisioning } = createAuthority(
      candidate({ status: "not_started" }),
    );

    await expect(authority.markConfigured(identity)).resolves.toBe(false);
    expect(workflowProvisioning.updateMany).not.toHaveBeenCalled();
  });

  it("does not fall back to a reused branch when a recorded PR number disagrees", async () => {
    const { authority, workflowProvisioning } = createAuthority(
      candidate({
        status: "failed",
        pullRequestUrl: "https://github.com/acme/widget/pull/8",
      }),
    );

    await expect(authority.markConfigured(identity)).resolves.toBe(false);
    expect(workflowProvisioning.updateMany).not.toHaveBeenCalled();
  });

  it("uses branch fallback only when the candidate has no recorded PR URL", async () => {
    const { authority } = createAuthority(
      candidate({ status: "failed", pullRequestUrl: null }),
    );

    await expect(authority.markConfigured(identity)).resolves.toBe(true);
  });

  it("rejects an older matching attempt when latest is not_started", async () => {
    const { authority, workflowProvisioning } = createAuthority(
      candidate({ status: "not_started", pullRequestUrl: null }),
    );

    await expect(authority.assertConfigured(identity)).rejects.toThrow(
      "workflow_provisioning_match_not_found",
    );
    expect(workflowProvisioning.updateMany).not.toHaveBeenCalled();
  });

  it("does not let a stale failure race overwrite configured", async () => {
    const { authority, workflowProvisioning } = createAuthority(
      candidate({ status: "setup_pr_open" }),
      { updateCount: 0, racedStatus: "configured" },
    );

    await expect(
      authority.markFailed({ ...identity, reason: "setup_pr_closed" }),
    ).rejects.toThrow("workflow_provisioning_already_configured");
    expect(workflowProvisioning.updateMany).toHaveBeenCalledWith({
      where: {
        id: "provisioning_1",
        status: { in: ["setup_pr_open", "failed"] },
        pullRequestUrl: "https://github.com/acme/widget/pull/7",
      },
      data: { status: "failed", errorMessage: "setup_pr_closed" },
    });
  });
});

type Candidate = {
  id: string;
  status: "not_started" | "setup_pr_open" | "configured" | "failed";
  branch: string;
  pullRequestUrl: string | null;
  errorMessage: string | null;
};

function candidate(input: {
  readonly status: Candidate["status"];
  readonly pullRequestUrl?: string | null;
}): Candidate {
  return {
    id: "provisioning_1",
    status: input.status,
    branch: "reviewrouter/setup",
    pullRequestUrl:
      input.pullRequestUrl === undefined
        ? "https://github.com/acme/widget/pull/7"
        : input.pullRequestUrl,
    errorMessage: input.status === "failed" ? "setup_pr_closed" : null,
  };
}

function createAuthority(
  initialCandidate: Candidate | null,
  options: {
    readonly updateCount?: number;
    readonly racedStatus?: Candidate["status"];
  } = {},
) {
  let current = initialCandidate ? { ...initialCandidate } : null;
  const workflowProvisioning = {
    findFirst: vi.fn(async () => current),
    updateMany: vi.fn(
      async (input: {
        readonly data: {
          readonly status: Candidate["status"];
          readonly errorMessage: string | null;
        };
      }) => {
        const count = options.updateCount ?? 1;
        if (count === 1 && current) current = { ...current, ...input.data };
        return { count };
      },
    ),
    findUnique: vi.fn(async () =>
      options.racedStatus ? { status: options.racedStatus } : current,
    ),
  };
  const transactionClient = { workflowProvisioning };
  const prisma = {
    $transaction: vi.fn(
      async (callback: (tx: typeof transactionClient) => unknown) =>
        callback(transactionClient),
    ),
  };

  return {
    authority: new PrismaWorkflowProvisioningStatusAuthority(prisma as never),
    workflowProvisioning,
  };
}
