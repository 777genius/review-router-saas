import { beforeEach, describe, expect, it, vi } from "vitest";
import { OctokitGitHubAppCommentTokenIssuer } from "./octokit-github-app-comment-token-issuer.js";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("@octokit/app", () => ({
  App: vi.fn().mockImplementation(function App() {
    return {
      octokit: {
        request: mocks.request,
      },
    };
  }),
}));

describe("OctokitGitHubAppCommentTokenIssuer", () => {
  beforeEach(() => {
    mocks.request.mockReset();
  });

  it("issues repository-scoped runtime tokens with read access for private PR diffs", async () => {
    mocks.request.mockResolvedValueOnce({
      data: {
        token: "ghs_reviewrouter_app_token",
        expires_at: "2026-05-03T13:00:00.000Z",
        permissions: {
          contents: "read",
          pull_requests: "write",
          issues: "write",
        },
      },
    });

    const issuer = new OctokitGitHubAppCommentTokenIssuer({
      appId: "123",
      privateKey: "private-key",
    });

    const result = await issuer.issueCommentToken({
      githubInstallationId: "129500385",
      githubRepositoryId: "123456",
      repositoryFullName: "777genius/example",
    });

    expect(mocks.request).toHaveBeenCalledWith(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: 129500385,
        repository_ids: [123456],
        permissions: {
          contents: "read",
          pull_requests: "write",
          issues: "write",
        },
      },
    );
    expect(result.permissions).toEqual({
      contents: "read",
      pullRequests: "write",
      issues: "write",
    });
  });

  it("rejects tokens that do not include private PR diff read access", async () => {
    mocks.request.mockResolvedValueOnce({
      data: {
        token: "ghs_reviewrouter_app_token",
        expires_at: "2026-05-03T13:00:00.000Z",
        permissions: {
          pull_requests: "write",
          issues: "write",
        },
      },
    });

    const issuer = new OctokitGitHubAppCommentTokenIssuer({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      issuer.issueCommentToken({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
      }),
    ).rejects.toThrow("comment_token_permissions_mismatch");
  });
});
