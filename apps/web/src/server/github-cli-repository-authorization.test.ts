import { describe, expect, it, vi } from "vitest";
import { authorizeGitHubCliRepository } from "./github-cli-repository-authorization";

describe("authorizeGitHubCliRepository", () => {
  it("accepts a write-capable repository visible to the supplied token", async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer github-token-value",
      });
      return Response.json({
        id: 123,
        full_name: "Padelapp-Club/monorepository",
        permissions: { push: true, pull: true },
      });
    });

    await expect(
      authorizeGitHubCliRepository({
        accessToken: "github-token-value",
        repositoryFullName: "Padelapp-Club/monorepository",
        fetch: fetchMock as typeof fetch,
      }),
    ).resolves.toEqual({
      githubRepositoryId: "123",
      fullName: "Padelapp-Club/monorepository",
    });
  });

  it("rejects read-only repository access", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: 123,
        full_name: "Padelapp-Club/monorepository",
        permissions: { pull: true },
      }),
    );

    await expect(
      authorizeGitHubCliRepository({
        accessToken: "github-token-value",
        repositoryFullName: "Padelapp-Club/monorepository",
        fetch: fetchMock as typeof fetch,
      }),
    ).rejects.toThrow("github_cli_repository_forbidden");
  });

  it("maps invalid GitHub credentials without exposing the token", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));

    await expect(
      authorizeGitHubCliRepository({
        accessToken: "github-token-value",
        repositoryFullName: "Padelapp-Club/monorepository",
        fetch: fetchMock as typeof fetch,
      }),
    ).rejects.toThrow("github_cli_token_invalid");
  });
});
