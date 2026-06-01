import { describe, expect, it, vi } from "vitest";
import {
  buildDashboardMemoryActor,
  resolveDashboardMemoryActor,
} from "./dashboard-memory";

describe("dashboard memory actor", () => {
  it("maps GitLab source identities to workspace memory actors", async () => {
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: "user_gitlab",
          githubUserId: null,
          githubLogin: null,
        }),
      },
    };

    await expect(
      resolveDashboardMemoryActor(
        {
          userId: "user_gitlab",
          sourceProvider: "gitlab",
          sourceLogin: "gitlab-maintainer",
          githubUserId: null,
          githubLogin: null,
        },
        prisma as never,
      ),
    ).resolves.toEqual({
      kind: "workspace_user",
      id: "user_gitlab",
      githubUserId: null,
      login: "gitlab-maintainer",
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user_gitlab" },
      select: { id: true, githubUserId: true, githubLogin: true },
    });
  });

  it("does not allow a GitHub memory actor without a GitHub user id", () => {
    expect(() =>
      buildDashboardMemoryActor({
        userId: "user_github",
        sourceProvider: "github",
        sourceLogin: "maintainer",
        githubUserId: null,
        githubLogin: "maintainer",
      }),
    ).toThrow("github_user_id_required");
  });
});
