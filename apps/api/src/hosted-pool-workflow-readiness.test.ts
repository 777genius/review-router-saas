import { describe, expect, it, vi } from "vitest";
import { renderCanonicalHostedPoolWorkflowV2 } from "@reviewrouter/features-workflow-provisioning";
import { hasMatchingHostedPoolWorkflow } from "./hosted-pool-workflow-readiness.js";

function fixture() {
  const options = {
    actionRef: `777genius/review-router@${"a".repeat(40)}`,
    apiUrl: "https://api.example.test",
    providerInstanceId: "hosted-pool:repository:123",
    bindingId: "binding-1",
    bindingRevision: 2,
  };
  const source = renderCanonicalHostedPoolWorkflowV2(options);
  const request = vi.fn().mockResolvedValue({
    data: {
      encoding: "base64",
      content: Buffer.from(source).toString("base64"),
    },
  });
  return {
    request,
    options,
    input: {
      repository: {
        owner: "test-owner",
        name: "disposable",
        defaultBranch: "main",
        githubRepositoryId: "123",
      },
      octokit: { request },
      binding: { bindingId: "binding-1", revision: 2 },
      actionRef: options.actionRef,
      apiUrl: options.apiUrl,
    },
  };
}

describe("hosted setup readiness", () => {
  it("recognizes the actual rendered workflow for the exact pool binding", async () => {
    const { input, request } = fixture();
    await expect(hasMatchingHostedPoolWorkflow(input)).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/contents/{path}",
      expect.objectContaining({ ref: "main" }),
    );
  });
  it("allows initial setup when no workflow exists", async () => {
    const { input, request } = fixture();
    request.mockRejectedValue({ status: 404 });
    await expect(hasMatchingHostedPoolWorkflow(input)).resolves.toBe(false);
  });
  it("allows a setup PR for an older non-hosted workflow", async () => {
    const { input, request } = fixture();
    request.mockResolvedValue({
      data: {
        encoding: "base64",
        content: Buffer.from(
          "name: Previous review\non: pull_request\n",
        ).toString("base64"),
      },
    });
    await expect(hasMatchingHostedPoolWorkflow(input)).resolves.toBe(false);
  });
  it.each([401, 403, 429, 500])(
    "propagates HTTP %s instead of treating uncertain reads as absence",
    async (status) => {
      const { input, request } = fixture();
      const error = { status };
      request.mockRejectedValue(error);
      await expect(hasMatchingHostedPoolWorkflow(input)).rejects.toBe(error);
    },
  );
  it("does not classify another binding revision as ready", async () => {
    const { input } = fixture();
    await expect(
      hasMatchingHostedPoolWorkflow({
        ...input,
        binding: { ...input.binding, revision: 3 },
      }),
    ).resolves.toBe(false);
  });
  it("does not classify another repository identity as ready", async () => {
    const { input } = fixture();
    await expect(
      hasMatchingHostedPoolWorkflow({
        ...input,
        repository: { ...input.repository, githubRepositoryId: "456" },
      }),
    ).resolves.toBe(false);
  });
});
