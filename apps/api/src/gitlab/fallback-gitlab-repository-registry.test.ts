import { describe, expect, it, vi } from "vitest";
import type {
  GitLabRepositoryContext,
  GitLabRepositoryPort,
} from "@reviewrouter/features-gitlab-integration";
import { FallbackGitLabRepositoryRegistry } from "./fallback-gitlab-repository-registry";

describe("FallbackGitLabRepositoryRegistry", () => {
  it("uses the primary registry when the repository exists there", async () => {
    const primaryRepository = createRepository("repo_db");
    const primary = createRegistry(primaryRepository);
    const fallback = createRegistry(createRepository("repo_static"));
    const registry = new FallbackGitLabRepositoryRegistry([primary, fallback]);

    await expect(
      registry.findSelectedRepositoryByGitLabProjectId("123"),
    ).resolves.toEqual(primaryRepository);
    expect(
      primary.findSelectedRepositoryByGitLabProjectId,
    ).toHaveBeenCalledWith("123");
    expect(
      fallback.findSelectedRepositoryByGitLabProjectId,
    ).not.toHaveBeenCalled();
  });

  it("falls back to the static registry when the primary registry misses", async () => {
    const fallbackRepository = createRepository("repo_static");
    const primary = createRegistry(null);
    const fallback = createRegistry(fallbackRepository);
    const registry = new FallbackGitLabRepositoryRegistry([primary, fallback]);

    await expect(
      registry.findSelectedRepositoryByGitLabProjectId("123"),
    ).resolves.toEqual(fallbackRepository);
    expect(
      primary.findSelectedRepositoryByGitLabProjectId,
    ).toHaveBeenCalledWith("123");
    expect(
      fallback.findSelectedRepositoryByGitLabProjectId,
    ).toHaveBeenCalledWith("123");
  });

  it("returns null only after every registry misses", async () => {
    const registry = new FallbackGitLabRepositoryRegistry([
      createRegistry(null),
      createRegistry(null),
    ]);

    await expect(
      registry.findSelectedRepositoryByGitLabProjectId("123"),
    ).resolves.toBeNull();
  });
});

function createRegistry(
  repository: GitLabRepositoryContext | null,
): GitLabRepositoryPort {
  return {
    findSelectedRepositoryByGitLabProjectId: vi.fn(async () => repository),
  };
}

function createRepository(repositoryId: string): GitLabRepositoryContext {
  return {
    workspaceId: "workspace_1",
    repositoryId,
    gitlabProjectId: "123",
    fullName: "group/project",
    owner: "group",
    selected: true,
    installationStatus: "active",
  };
}
