import type { App } from "@octokit/app";
import { describe, expect, it, vi } from "vitest";
import { OctokitHostedWorkflowSourceReader } from "./octokit-hosted-workflow-source-reader.js";

const revisionSha = "a".repeat(40);
const workflowPath = ".github/workflows/reviewrouter-hosted.yml";
const workflow = "name: exact caller\n";

describe("OctokitHostedWorkflowSourceReader", () => {
  it("fetches the caller workflow only at the exact admitted revision", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { sha: revisionSha } })
      .mockResolvedValueOnce({
        data: {
          type: "file",
          encoding: "base64",
          sha: "b".repeat(40),
          content: Buffer.from(workflow, "utf8").toString("base64"),
        },
      });
    const reader = createReader(request);

    await expect(reader.readWorkflowAtRevision(input())).resolves.toEqual({
      commitSha: revisionSha,
      blobSha: "b".repeat(40),
      contents: workflow,
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      "GET /repos/{owner}/{repo}/commits/{ref}",
      expect.objectContaining({ ref: revisionSha }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "GET /repos/{owner}/{repo}/contents/{path}",
      expect.objectContaining({ ref: revisionSha, path: workflowPath }),
    );
  });

  it.each(["main", "refs/heads/main", "A".repeat(40)])(
    "rejects a non-exact or noncanonical revision %s without fetching",
    async (revision) => {
      const request = vi.fn();
      const reader = createReader(request);

      await expect(
        reader.readWorkflowAtRevision(input(revision)),
      ).rejects.toThrow("hosted_workflow_revision_invalid");
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("fails closed when GitHub resolves the requested SHA to a different revision", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ data: { sha: "c".repeat(40) } });
    const reader = createReader(request);

    await expect(reader.readWorkflowAtRevision(input())).rejects.toThrow(
      "hosted_workflow_revision_mismatch",
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("fails closed when the exact-revision workflow is missing", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { sha: revisionSha } })
      .mockRejectedValueOnce(new Error("github_not_found"));
    const reader = createReader(request);

    await expect(reader.readWorkflowAtRevision(input())).rejects.toThrow(
      "github_not_found",
    );
  });

  it("fails closed when the exact-revision path is ambiguous", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { sha: revisionSha } })
      .mockResolvedValueOnce({ data: [] });
    const reader = createReader(request);

    await expect(reader.readWorkflowAtRevision(input())).rejects.toThrow(
      "hosted_workflow_source_invalid",
    );
  });
});

function input(revision = revisionSha) {
  return {
    githubInstallationId: "456",
    owner: "acme",
    repository: "private-repo",
    revisionSha: revision,
    workflowPath,
  };
}

function createReader(request: ReturnType<typeof vi.fn>) {
  const app = {
    getInstallationOctokit: vi.fn().mockResolvedValue({ request }),
  } as unknown as App;
  return new OctokitHostedWorkflowSourceReader(
    { appId: "123", privateKey: "test" },
    app,
  );
}

describe("server PR identity reader", () => {
  const authorityInput = {
    githubInstallationId: "456",
    owner: "owner",
    repository: "repo",
    pullRequestNumber: 42,
  };
  it("reads base/head repository IDs and exact PR revision through installation authority", async () => {
    const request = vi.fn().mockResolvedValue({
      data: {
        number: 42,
        state: "open",
        base: { repo: { id: 123 } },
        head: { repo: { id: 999 }, sha: revisionSha },
      },
    });
    await expect(
      createReader(request).readPullRequestAuthority(authorityInput),
    ).resolves.toEqual({
      number: 42,
      state: "open",
      baseRepositoryId: "123",
      headRepositoryId: "999",
      headSha: revisionSha,
    });
    expect(request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: "owner",
        repo: "repo",
        pull_number: 42,
      },
    );
  });
  it("retains a deleted head as missing authority", async () => {
    const request = vi.fn().mockResolvedValue({
      data: {
        number: 42,
        state: "open",
        base: { repo: { id: 123 } },
        head: { repo: null, sha: revisionSha },
      },
    });
    await expect(
      createReader(request).readPullRequestAuthority(authorityInput),
    ).resolves.toMatchObject({ headRepositoryId: null });
  });
  it("returns a safe fixed failure without GitHub request metadata", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new Error("fake-sensitive-installation-header"));
    await expect(
      createReader(request).readPullRequestAuthority(authorityInput),
    ).rejects.toThrow(/^hosted_pull_request_authority_unavailable$/);
  });
  it.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid PR number %s without a request",
    async (pullRequestNumber) => {
      const request = vi.fn();
      await expect(
        createReader(request).readPullRequestAuthority({
          ...authorityInput,
          pullRequestNumber,
        }),
      ).rejects.toThrow("hosted_pull_request_number_invalid");
      expect(request).not.toHaveBeenCalled();
    },
  );
});
