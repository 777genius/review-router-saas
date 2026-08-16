import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderCanonicalHostedPoolWorkflowV5 } from "@reviewrouter/features-workflow-provisioning";

const mocks = vi.hoisted(() => ({
  switchConfiguration: vi.fn(async () => true),
}));

vi.mock("@reviewrouter/platform-config", () => ({
  resolveReviewRouterCodexRotatingTrustedActionRefs: () => [
    `777genius/review-router@${"a".repeat(40)}`,
  ],
}));
vi.mock("./prisma-hosted-pool-mutations", () => ({
  switchRepositoryConfigurationAuthMode: mocks.switchConfiguration,
}));

import { activateConfirmedHostedPoolBindingAfterWorkflowMerge } from "./hosted-pool-workflow-activation";

const commitSha = "b".repeat(40);
const binding = {
  id: "binding-1",
  workspaceId: "workspace-1",
  repositoryConnectionId: "repo-1",
  status: "pending_activation",
  revision: 3n,
  stateVersion: 7n,
  tombstonedAt: null,
};
const workflow = renderCanonicalHostedPoolWorkflowV5({
  actionRef: `777genius/review-router@${"a".repeat(40)}`,
  apiUrl: "https://api.reviewrouter.test",
  providerInstanceId: "hosted-pool:repository:1228051727",
  bindingId: binding.id,
  bindingRevision: 3,
});

describe("activateConfirmedHostedPoolBindingAfterWorkflowMerge", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists exact default-branch evidence and preserves binding revision", async () => {
    const fixture = createFixture();
    await expect(
      activateConfirmedHostedPoolBindingAfterWorkflowMerge(fixture.input),
    ).resolves.toMatchObject({
      status: "activated",
      bindingId: binding.id,
      bindingRevision: 3,
      workflowSourceCommitSha: commitSha,
    });
    expect(fixture.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revision: 3n,
          stateVersion: 7n,
          status: "pending_activation",
        }),
        data: expect.objectContaining({
          status: "active",
          stateVersion: { increment: 1 },
          attestedBindingRevision: 3n,
          workflowSourceCommitSha: commitSha,
        }),
      }),
    );
    expect(fixture.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ revision: expect.anything() }),
      }),
    );
    expect(mocks.switchConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        authMode: "codex_subscription_oauth_hosted_pool",
      }),
    );
  });

  it("fails closed if default-branch head moves during verification", async () => {
    const fixture = createFixture("c".repeat(40));
    await expect(
      activateConfirmedHostedPoolBindingAfterWorkflowMerge(fixture.input),
    ).rejects.toThrow("hosted_workflow_default_head_changed");
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it("rejects workflow authority for a different binding revision", async () => {
    const fixture = createFixture(
      commitSha,
      workflow.replace(
        "session_binding_version: 3",
        "session_binding_version: 4",
      ),
    );
    await expect(
      activateConfirmedHostedPoolBindingAfterWorkflowMerge(fixture.input),
    ).rejects.toThrow("hosted_workflow_authority_mismatch");
    expect(fixture.transaction).not.toHaveBeenCalled();
  });
});

function createFixture(finalHead = commitSha, source = workflow) {
  const blobSha = gitBlobSha(source);
  const updateMany =
    vi.fn<(input: unknown) => Promise<{ readonly count: number }>>();
  updateMany.mockResolvedValue({ count: 1 });
  const transaction = vi.fn(
    async (callback: (transaction: unknown) => unknown) =>
      callback({ hostedCodexRepositoryBinding: { updateMany } }),
  );
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      data: {
        id: 1228051727,
        full_name: "777genius/example",
        default_branch: "main",
      },
    })
    .mockResolvedValueOnce({ data: { object: { sha: commitSha } } })
    .mockResolvedValueOnce({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(source).toString("base64"),
        sha: blobSha,
      },
    })
    .mockResolvedValueOnce({ data: { object: { sha: finalHead } } });
  return {
    updateMany,
    transaction,
    input: {
      prisma: {
        hostedCodexRepositoryBinding: {
          findFirst: vi.fn(async () => binding),
        },
        $transaction: transaction,
      } as never,
      octokit: { request },
      workspaceId: "workspace-1",
      repositoryId: "repo-1",
      githubRepositoryId: "1228051727",
      owner: "777genius",
      name: "example",
      defaultBranch: "main",
      expectedRepositoryFullName: "777genius/example",
      expectedApiUrl: "https://api.reviewrouter.test",
      now: new Date("2026-08-15T12:00:00.000Z"),
    },
  };
}

function gitBlobSha(source: string): string {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(source)}\0`)
    .update(source)
    .digest("hex");
}
