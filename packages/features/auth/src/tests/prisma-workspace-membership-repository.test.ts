import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AuthenticatedPrincipal } from "../domain/authenticated-principal";
import { PrismaWorkspaceMembershipRepository } from "../infrastructure/prisma/prisma-workspace-membership-repository";

function createPrismaMock() {
  return {
    workspace: {
      upsert: vi.fn().mockResolvedValue({
        id: "workspace_1",
        slug: "workspace-slug",
      }),
    },
    workspaceMember: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
}

function principal(
  overrides: Partial<AuthenticatedPrincipal>,
): AuthenticatedPrincipal {
  return {
    provider: "github",
    userId: "user_1",
    externalUserId: "123",
    login: "maintainer",
    githubUserId: "123",
    githubLogin: "maintainer",
    primaryEmail: null,
    avatarUrl: null,
    ...overrides,
  };
}

describe("PrismaWorkspaceMembershipRepository", () => {
  it("preserves the legacy GitHub personal workspace slug", async () => {
    const prisma = createPrismaMock();
    const repository = new PrismaWorkspaceMembershipRepository(
      prisma as unknown as PrismaClient,
    );

    await repository.ensurePersonalWorkspaceOwner(principal({}));

    expect(prisma.workspace.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: "gh-user-123" },
        create: expect.objectContaining({ slug: "gh-user-123" }),
      }),
    );
  });

  it("uses provider-prefixed personal workspace slugs for GitLab identities", async () => {
    const prisma = createPrismaMock();
    const repository = new PrismaWorkspaceMembershipRepository(
      prisma as unknown as PrismaClient,
    );

    await repository.ensurePersonalWorkspaceOwner(
      principal({
        provider: "gitlab",
        externalUserId: "456",
        login: "gitlab-maintainer",
        githubUserId: null,
        githubLogin: null,
      }),
    );

    expect(prisma.workspace.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: "gitlab-user-456" },
        create: expect.objectContaining({ slug: "gitlab-user-456" }),
      }),
    );
  });
});
