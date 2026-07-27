import { beforeEach, describe, expect, it, vi } from "vitest";
import { OctokitGitHubAppCommentTokenIssuer } from "./octokit-github-app-comment-token-issuer.js";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
}));

vi.mock("@octokit/app", () => ({
  App: vi.fn().mockImplementation(function App() {
    return {
      octokit: {
        auth: mocks.auth,
      },
    };
  }),
}));

describe("OctokitGitHubAppCommentTokenIssuer", () => {
  beforeEach(() => {
    mocks.auth.mockReset();
  });

  it("issues repository-scoped runtime tokens with read access for private PR diffs", async () => {
    mocks.auth.mockResolvedValueOnce({
      token: "ghs_reviewrouter_app_token",
      expiresAt: "2026-05-03T13:00:00.000Z",
      permissions: {
        contents: "read",
        pull_requests: "write",
        issues: "write",
        statuses: "write",
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

    expect(mocks.auth).toHaveBeenCalledWith({
      type: "installation",
      installationId: 129500385,
      repositoryIds: [123456],
      permissions: {
        contents: "read",
        pull_requests: "write",
        issues: "write",
        statuses: "write",
      },
    });
    expect(result.permissions).toEqual({
      contents: "read",
      pullRequests: "write",
      issues: "write",
      statuses: "write",
    });
  });

  it("rejects tokens that do not include private PR diff read access", async () => {
    mocks.auth.mockResolvedValueOnce({
      token: "ghs_reviewrouter_app_token",
      expiresAt: "2026-05-03T13:00:00.000Z",
      permissions: {
        pull_requests: "write",
        issues: "write",
        statuses: "write",
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

  it("rejects non-numeric GitHub repository ids before token minting", async () => {
    const issuer = new OctokitGitHubAppCommentTokenIssuer({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      issuer.issueCommentToken({
        githubInstallationId: "129500385",
        githubRepositoryId: "R_kgDOExample",
        repositoryFullName: "777genius/example",
      }),
    ).rejects.toThrow("comment_token_repository_id_invalid");
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});
