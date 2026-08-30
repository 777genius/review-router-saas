import { describe, expect, it, vi } from "vitest";
import { allocateVersionedProviderSecretNamespace } from "@reviewrouter/features-codex-oauth-rotating";
import { renderCanonicalCodexRotatingT0WorkflowV5 } from "@reviewrouter/features-codex-oauth-rotating";
import { CodexZeroLoginRolloverSetupPullRequestPublisher } from "./codex-zero-login-rollover-setup-pr-publisher.js";
import type { WorkflowSetupGatewayInput } from "@reviewrouter/features-workflow-provisioning";

const namespace = allocateVersionedProviderSecretNamespace({
  scope: { repositoryId: "123456", providerInstanceId: "codex-rotating:123456" },
  epoch: 4n,
  randomBytes: () => Buffer.alloc(16, 8),
});
const repository = {
  workspaceId: "workspace-1",
  repositoryId: "repository-1",
  githubRepositoryId: "123456",
  githubInstallationId: "789",
  fullName: "owner/repo",
  owner: "owner",
  selected: true,
  installationStatus: "active",
};
const activeNamespace = allocateVersionedProviderSecretNamespace({
  scope: { repositoryId: "123456", providerInstanceId: "codex-rotating:123456" },
  epoch: 3n,
  randomBytes: () => Buffer.alloc(16, 7),
});
const sourceActionRef = `777genius/review-router@${"a".repeat(40)}`;
const workflowSource = renderCanonicalCodexRotatingT0WorkflowV5({
  actionRef: sourceActionRef,
  apiUrl: "https://api.reviewrouter.site",
  providerInstanceId: "codex-rotating:123456",
  activeSecretNamespace: activeNamespace,
  refreshScheduleCron: "17 3 * * 2",
});

describe("zero-login rollover setup PR publisher", () => {
  it("renders exact B/schema5 with the candidate but does not write the default branch", async () => {
    const createOrUpdateSetupPullRequest = vi.fn(async (_input: WorkflowSetupGatewayInput) => ({
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      branch: "reviewrouter/zero-login-rollover-4",
      baseBranch: "main",
      headSha: "e".repeat(40),
    }));
    const publisher = new CodexZeroLoginRolloverSetupPullRequestPublisher(
      async () => ({ createOrUpdateSetupPullRequest }),
      {
        readDefaultBranch: vi.fn(async () => ({ name: "main", headSha: "c".repeat(40), workflowSource })),
        verifySetupPullRequest: vi.fn(async () => ({ headSha: "e".repeat(40) })),
      },
      "https://api.reviewrouter.site",
    );
    await publisher.createOrUpdateExactSetupPullRequest({
      repository,
      providerInstanceId: "codex-rotating:123456",
      candidate: namespace,
      targetActionRef: `777genius/review-router@${"d".repeat(40)}`,
      targetWorkflowSchemaVersion: 5,
      sourceActionRef,
      expectedBaseSha: "c".repeat(40),
      sourceActiveNamespaceId: activeNamespace.namespaceId,
    });
    const request = createOrUpdateSetupPullRequest.mock.calls[0]![0];
    const workflowFile = request.workflowFiles[0];
    expect(workflowFile?.operation).not.toBe("delete");
    if (!workflowFile || workflowFile.operation === "delete") {
      throw new Error("expected workflow upsert");
    }
    expect(request.baseBranch).toBe("main");
    expect(request.expectedBaseSha).toBe("c".repeat(40));
    expect(request.resetSetupBranch).toBe(true);
    expect(request.setupBranch).not.toBe("main");
    expect(workflowFile.content).toContain("workflow_schema_version: 5");
    expect(workflowFile.content).toContain(namespace.name);
    expect(workflowFile.content).toContain("d".repeat(40));
    expect(workflowFile.content).toContain("17 3 * * 2");
  });

  it("fails closed if the default head moved after prepare", async () => {
    const setupGateway = { createOrUpdateSetupPullRequest: vi.fn() };
    const publisher = new CodexZeroLoginRolloverSetupPullRequestPublisher(
      async () => setupGateway,
      {
        readDefaultBranch: vi.fn(async () => ({ name: "main", headSha: "e".repeat(40), workflowSource })),
        verifySetupPullRequest: vi.fn(),
      },
      "https://api.reviewrouter.site",
    );
    await expect(
      publisher.createOrUpdateExactSetupPullRequest({
        repository,
        providerInstanceId: "codex-rotating:123456",
        candidate: namespace,
        targetActionRef: `777genius/review-router@${"d".repeat(40)}`,
        targetWorkflowSchemaVersion: 5,
        sourceActionRef,
        expectedBaseSha: "c".repeat(40),
        sourceActiveNamespaceId: activeNamespace.namespaceId,
      }),
    ).rejects.toThrow("zero_login_rollover_prepared_base_moved");
    expect(setupGateway.createOrUpdateSetupPullRequest).not.toHaveBeenCalled();
  });
});
