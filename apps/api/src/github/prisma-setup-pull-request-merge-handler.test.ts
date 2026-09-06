import { describe, expect, it, vi } from "vitest";
import { PrismaSetupPullRequestMergeHandler } from "./prisma-setup-pull-request-merge-handler";
import {
  createProvisioningPrisma,
  initialCandidate,
} from "../../../../packages/features/workflow-provisioning/src/tests/provisioning-prisma-fixture";

const envelope = {
  deliveryId: "delivery_1",
  eventName: "pull_request",
  payload: {
    action: "closed",
    installation: { id: 123 },
    repository: { id: 456, name: "widget", full_name: "acme/widget" },
    pull_request: {
      number: 7,
      html_url: "https://github.com/acme/widget/pull/7",
      state: "closed",
      merged: true,
      draft: false,
      base: { ref: "main" },
      head: {
        ref: "reviewrouter/setup",
        sha: initialCandidate.pullRequestHeadSha ?? undefined,
      },
    },
  },
} as const;
function fixture(candidate: typeof initialCandidate | null = initialCandidate) {
  const state = createProvisioningPrisma(candidate);
  const prisma = {
    ...state.prisma,
    repositoryConnection: {
      findFirst: vi.fn(async () => ({
        id: initialCandidate.repositoryId,
        workspaceId: initialCandidate.workspaceId,
        installationId: initialCandidate.installationId,
        fullName: "acme/widget",
      })),
    },
  };
  return {
    ...state,
    handler: new PrismaSetupPullRequestMergeHandler(prisma as never),
    repositoryFind: prisma.repositoryConnection.findFirst,
  };
}

describe("setup PR merge webhook", () => {
  it("recovers a failed PR and accepts duplicate delivery idempotently", async () => {
    const f = fixture({ ...initialCandidate, status: "failed" });
    for (let i = 0; i < 2; i++)
      expect(
        await f.handler.handleGitHubPullRequestWebhook(envelope),
      ).toMatchObject({ processed: true, status: "configured" });
    expect(f.workflowProvisioning.updateMany).toHaveBeenCalledTimes(1);
    expect(f.repositoryFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          githubRepositoryId: 456n,
          installation: { githubInstallationId: 123n },
        },
      }),
    );
  });
  it("ignores an older merged PR when a new failed attempt lacks PR identity", async () => {
    const f = fixture({
      ...initialCandidate,
      status: "failed",
      attemptId: "new",
      pullRequestUrl: null,
    });
    expect(
      await f.handler.handleGitHubPullRequestWebhook(envelope),
    ).toMatchObject({ processed: false });
    expect(f.current()?.status).toBe("failed");
  });
  it("does not create authority from an unrelated PR", async () => {
    const f = fixture(null);
    expect(
      await f.handler.handleGitHubPullRequestWebhook(envelope),
    ).toMatchObject({ processed: false });
    expect(f.workflowProvisioning.create).not.toHaveBeenCalled();
  });
  it.each([undefined, "c".repeat(40)])(
    "rejects a missing or changed PR head: %s",
    async (sha) => {
      const f = fixture();
      expect(
        await f.handler.handleGitHubPullRequestWebhook({
          ...envelope,
          payload: {
            ...envelope.payload,
            pull_request: {
              ...envelope.payload.pull_request,
              head: { ref: "reviewrouter/setup", ...(sha ? { sha } : {}) },
            },
          },
        }),
      ).toMatchObject({ processed: false });
      expect(f.workflowProvisioning.updateMany).not.toHaveBeenCalled();
    },
  );
  it("rejects a wrong-base merge and accepts a PR retargeted to the allowed branch", async () => {
    const f = fixture({
      ...initialCandidate,
      status: "failed",
      errorMessage: "setup_pr_wrong_base_branch",
    });
    const wrongBase = {
      ...envelope,
      payload: {
        ...envelope.payload,
        pull_request: {
          ...envelope.payload.pull_request,
          base: { ref: "develop" },
        },
      },
    };
    expect(
      await f.handler.handleGitHubPullRequestWebhook(wrongBase),
    ).toMatchObject({ processed: false });
    expect(f.current()?.status).toBe("failed");
    expect(
      await f.handler.handleGitHubPullRequestWebhook(envelope),
    ).toMatchObject({ processed: true });
  });
  it("revalidates the installation when transfer races delivery", async () => {
    const f = fixture();
    f.transfer();
    expect(
      await f.handler.handleGitHubPullRequestWebhook(envelope),
    ).toMatchObject({ processed: false });
  });
});
