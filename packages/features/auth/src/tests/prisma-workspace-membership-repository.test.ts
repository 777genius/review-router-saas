import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AuthenticatedPrincipal } from "../domain/authenticated-principal";
import { PrismaWorkspaceMembershipRepository } from "../infrastructure/prisma/prisma-workspace-membership-repository";

function createPrismaMock() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "user_1" }]),
    workspace: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }) => ({
        id: "workspace_1",
        ...data,
      })),
      update: vi.fn(),
    },
    workspaceMember: {
      upsert: vi.fn().mockResolvedValue({ role: "owner" }),
    },
    gitHubInstallation: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return {
    ...tx,
    $transaction: async <T>(callback: (value: typeof tx) => Promise<T>) =>
      callback(tx),
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
  // RED: external-derived upsert adopts legacy scopes and gives two logins two P.
  // Real SQL serialization/uniqueness is covered in postgres-fences.ts.
  it("creates a fresh opaque stable-User workspace for either provider", async () => {
    for (const provider of ["github", "gitlab"] as const) {
      const prisma = createPrismaMock();
      const repository = new PrismaWorkspaceMembershipRepository(
        prisma as unknown as PrismaClient,
      );
      const result = await repository.ensurePersonalWorkspaceOwner(
        principal({ provider }),
      );
      expect(result).toEqual({
        workspaceId: "workspace_1",
        workspaceSlug: expect.stringMatching(/^personal-[0-9a-f-]{36}$/),
        role: "owner",
        source: "personal",
      });
      expect(prisma.workspace.create).toHaveBeenCalledWith({
        data: {
          personalOwnerUserId: "user_1",
          slug: result.workspaceSlug,
          name: "@maintainer",
        },
      });
    }
  });

  // RED: trusting an unpersisted principal creates an unowned scope.
  it("rejects a missing persisted User before workspace creation", async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([]);
    const repository = new PrismaWorkspaceMembershipRepository(
      prisma as unknown as PrismaClient,
    );
    await expect(
      repository.ensurePersonalWorkspaceOwner(principal({})),
    ).rejects.toThrow("personal_workspace_user_not_found");
    expect(prisma.workspace.create).not.toHaveBeenCalled();
    expect(prisma.workspaceMember.upsert).not.toHaveBeenCalled();
  });

  // RED: refresh forces a demoted personal membership back to owner.
  it("returns the persisted membership role on repeated provision", async () => {
    const prisma = createPrismaMock();
    prisma.workspace.findUnique.mockResolvedValue({
      id: "workspace_1",
      slug: "opaque-existing",
    });
    prisma.workspace.update.mockResolvedValue({
      id: "workspace_1",
      slug: "opaque-existing",
    });
    prisma.workspaceMember.upsert.mockResolvedValue({ role: "member" });
    const repository = new PrismaWorkspaceMembershipRepository(
      prisma as unknown as PrismaClient,
    );
    expect(
      await repository.ensurePersonalWorkspaceOwner(principal({})),
    ).toEqual({
      workspaceId: "workspace_1",
      workspaceSlug: "opaque-existing",
      role: "member",
      source: "personal",
    });
    expect(prisma.workspace.create).not.toHaveBeenCalled();
  });
});
