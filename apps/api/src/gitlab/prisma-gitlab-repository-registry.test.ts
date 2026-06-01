import { describe, expect, it, vi } from "vitest";
import { PrismaGitLabRepositoryRegistry } from "./prisma-gitlab-repository-registry";

describe("PrismaGitLabRepositoryRegistry", () => {
  it("looks up selected repositories by provider and GitLab project id", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "repo_1",
      workspaceId: "workspace_1",
      externalRepositoryId: "101",
      fullName: "acme/platform/api",
      owner: "acme/platform",
      selected: true,
      gitlabInstallation: { status: "active" },
    });
    const registry = new PrismaGitLabRepositoryRegistry({
      repositoryConnection: { findFirst },
    } as never);

    await expect(
      registry.findSelectedRepositoryByGitLabProjectId("101"),
    ).resolves.toEqual({
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
      gitlabProjectId: "101",
      fullName: "acme/platform/api",
      owner: "acme/platform",
      selected: true,
      installationStatus: "active",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider: "gitlab",
          externalRepositoryId: "101",
          selected: true,
        },
      }),
    );
  });

  it("does not use the static fallback when the database has no GitLab repository", async () => {
    const registry = new PrismaGitLabRepositoryRegistry({
      repositoryConnection: { findFirst: vi.fn().mockResolvedValue(null) },
    } as never);

    await expect(
      registry.findSelectedRepositoryByGitLabProjectId("404"),
    ).resolves.toBeNull();
  });

  it("does not return deselected GitLab repositories", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const registry = new PrismaGitLabRepositoryRegistry({
      repositoryConnection: { findFirst },
    } as never);

    await expect(
      registry.findSelectedRepositoryByGitLabProjectId("101"),
    ).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ selected: true }),
      }),
    );
  });
});
