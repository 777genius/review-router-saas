import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
}));

vi.mock("./prisma", () => ({
  getPrisma: () => ({
    gitLabInstallation: {
      findFirst: mocks.findFirst,
    },
  }),
}));

import { buildGitLabCodexSeedCommand } from "./gitlab-codex-seed-command";

describe("buildGitLabCodexSeedCommand", () => {
  beforeEach(() => {
    vi.stubEnv("REVIEW_ROUTER_WEB_URL", "https://app.reviewrouter.dev");
    vi.stubEnv("GITLAB_OAUTH_BASE_URL", "https://gitlab.com");
    mocks.findFirst.mockResolvedValue({
      id: "gitlab_install_1",
      namespacePath: "acme/platform",
      sourceKind: "project",
      repositories: [
        { externalRepositoryId: "101", fullName: "acme/platform/api" },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("builds project-scoped seed commands without sending auth JSON to ReviewRouter", async () => {
    await expect(
      buildGitLabCodexSeedCommand({ workspaceId: "workspace_1" }),
    ).resolves.toMatchObject({
      secretName: "CODEX_AUTH_JSON",
      sendsSecretToReviewRouter: false,
      targetLabel: "1 GitLab project",
      command: expect.stringContaining("--scope project --project-ids 101"),
    });
  });

  it("rejects malformed GitLab project ids before joining shell args", async () => {
    mocks.findFirst.mockResolvedValueOnce({
      id: "gitlab_install_1",
      namespacePath: "acme/platform",
      sourceKind: "project",
      repositories: [
        { externalRepositoryId: "101,102", fullName: "acme/platform/api" },
      ],
    });

    await expect(
      buildGitLabCodexSeedCommand({ workspaceId: "workspace_1" }),
    ).rejects.toThrow("invalid_gitlab_project_ids");
  });
});
