import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discoverGitLabSourceProjects: vi.fn(),
  provisionGitLabReviewRouterProjects: vi.fn(),
  getPrisma: vi.fn(),
  gatewayOptions: [] as unknown[],
}));

vi.mock("@reviewrouter/features-gitlab-integration", () => ({
  GitLabInstallationGateway: class GitLabInstallationGateway {
    constructor(options: unknown) {
      mocks.gatewayOptions.push(options);
    }
  },
  discoverGitLabSourceProjects: mocks.discoverGitLabSourceProjects,
  provisionGitLabReviewRouterProjects:
    mocks.provisionGitLabReviewRouterProjects,
}));

vi.mock("./prisma", () => ({
  getPrisma: mocks.getPrisma,
}));

vi.mock("./workflow-public-api-url", () => ({
  resolveWorkflowPublicApiUrl: () => "https://api.reviewrouter.test",
}));

import { installGitLabConnectProjects } from "./gitlab-connect";

describe("installGitLabConnectProjects", () => {
  beforeEach(() => {
    vi.stubEnv("REVIEW_ROUTER_GITLAB_API_TOKEN", "server-review-token");
    vi.stubEnv("REVIEW_ROUTER_GITLAB_OIDC_AUDIENCE", "reviewrouter-test");
    mocks.gatewayOptions.length = 0;
    mocks.discoverGitLabSourceProjects.mockResolvedValue({
      source: {
        inputPath: "acme/platform",
        resolvedKind: "group",
        baseUrl: "https://gitlab.com",
      },
      parentGroupPath: "acme",
      projects: [
        {
          projectId: "101",
          fullName: "acme/platform/api",
          name: "api",
          defaultBranch: "main",
          webUrl: "https://gitlab.com/acme/platform/api",
          visibility: "private",
          archived: false,
        },
        {
          projectId: "102",
          fullName: "acme/platform/web",
          name: "web",
          defaultBranch: "main",
          webUrl: "https://gitlab.com/acme/platform/web",
          visibility: "private",
          archived: false,
        },
      ],
    });
    mocks.provisionGitLabReviewRouterProjects.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("uses the server review token, records project fallback installs, and deselects removed repositories", async () => {
    const gitLabInstallationUpsert = vi.fn().mockResolvedValue({
      id: "gitlab_install_1",
    });
    const repositoryUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const repositoryUpsert = vi.fn().mockResolvedValue({});
    mocks.getPrisma.mockReturnValue({
      gitLabInstallation: { upsert: gitLabInstallationUpsert },
      repositoryConnection: {
        updateMany: repositoryUpdateMany,
        upsert: repositoryUpsert,
      },
    });
    mocks.provisionGitLabReviewRouterProjects
      .mockRejectedValueOnce(new Error("gitlab_api_error_403"))
      .mockResolvedValueOnce({
        protocolVersion: 1,
        requested: 1,
        succeeded: 1,
        failed: 0,
        sharedVariablesConfigured: 0,
        results: [
          {
            projectId: "101",
            status: "fulfilled",
            result: {
              mode: "ci_config_path",
              ciConfigPath: ".gitlab/reviewrouter.yml",
              variablesConfigured: 3,
            },
          },
        ],
      });

    await expect(
      installGitLabConnectProjects({
        sourceUrl: "https://gitlab.com/acme/platform",
        token: "user-pat-should-not-be-seeded",
        workspaceId: "workspace_1",
        selectedProjectIds: ["101"],
        installedByUserId: "user_1",
      }),
    ).resolves.toMatchObject({
      installationId: "gitlab_install_1",
      namespacePath: "acme/platform",
      succeeded: 1,
    });

    expect(mocks.gatewayOptions).toHaveLength(2);
    expect(mocks.gatewayOptions).toEqual([
      expect.objectContaining({ token: "user-pat-should-not-be-seeded" }),
      expect.objectContaining({ token: "user-pat-should-not-be-seeded" }),
    ]);
    expect(mocks.provisionGitLabReviewRouterProjects).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        variableTarget: { kind: "group", id: "acme/platform" },
        reviewToken: "server-review-token",
      }),
      expect.any(Object),
    );
    expect(mocks.provisionGitLabReviewRouterProjects).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        variableTarget: { kind: "project", id: "0" },
        reviewToken: "server-review-token",
      }),
      expect.any(Object),
    );
    expect(
      JSON.stringify(mocks.provisionGitLabReviewRouterProjects.mock.calls),
    ).not.toContain("user-pat-should-not-be-seeded");
    expect(gitLabInstallationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_sourceBaseUrl_namespacePath: {
            workspaceId: "workspace_1",
            sourceBaseUrl: "https://gitlab.com",
            namespacePath: "acme/platform",
          },
        },
        update: expect.objectContaining({
          sourceBaseUrl: "https://gitlab.com",
          sourceKind: "project",
        }),
        create: expect.objectContaining({
          sourceBaseUrl: "https://gitlab.com",
          sourceKind: "project",
        }),
      }),
    );
    expect(repositoryUpdateMany).toHaveBeenCalledWith({
      where: {
        provider: "gitlab",
        gitlabInstallationId: "gitlab_install_1",
        externalRepositoryId: { notIn: ["101"] },
      },
      data: expect.objectContaining({ selected: false }),
    });
    expect(repositoryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider_externalRepositoryId_sourceBaseUrl: {
            provider: "gitlab",
            externalRepositoryId: "101",
            sourceBaseUrl: "https://gitlab.com",
          },
        },
        update: expect.objectContaining({
          sourceBaseUrl: "https://gitlab.com",
        }),
        create: expect.objectContaining({
          sourceBaseUrl: "https://gitlab.com",
        }),
      }),
    );
  });

  it("fails closed when the server GitLab review token is missing", async () => {
    vi.stubEnv("REVIEW_ROUTER_GITLAB_API_TOKEN", "");

    await expect(
      installGitLabConnectProjects({
        sourceUrl: "https://gitlab.com/acme/platform",
        token: "user-pat",
        workspaceId: "workspace_1",
        selectedProjectIds: ["101"],
        installedByUserId: "user_1",
      }),
    ).rejects.toThrow("gitlab_review_token_missing");
    expect(mocks.provisionGitLabReviewRouterProjects).not.toHaveBeenCalled();
  });
});
