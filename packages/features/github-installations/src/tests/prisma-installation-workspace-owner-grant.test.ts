import { describe, expect, it } from "vitest";
import { PrismaInstallationWorkspaceOwnerGrant } from "../infrastructure/prisma/prisma-installation-workspace-owner-grant";

type UserRow = {
  readonly id: string;
  readonly githubUserId: bigint;
  githubLogin: string;
  avatarUrl: string | null;
};

type WorkspaceMemberRow = {
  readonly id: string;
  readonly workspaceId: string;
  userId: string | null;
  githubLogin: string | null;
  role: "owner" | "admin" | "member";
};

class FakeOwnerGrantPrisma {
  public readonly installations = new Map<string, { workspaceId: string }>();
  public readonly users = new Map<string, UserRow>();
  public readonly members = new Map<string, WorkspaceMemberRow>();
  private memberSequence = 0;

  async $transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> {
    return callback(this);
  }

  public readonly gitHubInstallation = {
    findUnique: async (input: {
      readonly where: { readonly githubInstallationId: bigint };
    }) =>
      this.installations.get(String(input.where.githubInstallationId)) ?? null,
  };

  public readonly user = {
    upsert: async (input: {
      readonly where: { readonly githubUserId: bigint };
      readonly update: {
        readonly githubLogin: string;
        readonly avatarUrl: string | null;
      };
      readonly create: {
        readonly githubUserId: bigint;
        readonly githubLogin: string;
        readonly avatarUrl: string | null;
      };
    }) => {
      const key = String(input.where.githubUserId);
      const existing = this.users.get(key);
      if (existing) {
        existing.githubLogin = input.update.githubLogin;
        existing.avatarUrl = input.update.avatarUrl;
        return existing;
      }

      const created: UserRow = {
        id: `user-${key}`,
        githubUserId: input.create.githubUserId,
        githubLogin: input.create.githubLogin,
        avatarUrl: input.create.avatarUrl,
      };
      this.users.set(key, created);
      return created;
    },
  };

  public readonly workspaceMember = {
    findUnique: async (input: {
      readonly where:
        | { readonly id: string }
        | {
            readonly workspaceId_userId: {
              readonly workspaceId: string;
              readonly userId: string;
            };
          }
        | {
            readonly workspaceId_githubLogin: {
              readonly workspaceId: string;
              readonly githubLogin: string;
            };
          };
    }) => {
      if ("id" in input.where) {
        return this.members.get(input.where.id) ?? null;
      }

      for (const member of this.members.values()) {
        if (
          "workspaceId_userId" in input.where &&
          member.workspaceId === input.where.workspaceId_userId.workspaceId &&
          member.userId === input.where.workspaceId_userId.userId
        ) {
          return { id: member.id };
        }

        if (
          "workspaceId_githubLogin" in input.where &&
          member.workspaceId ===
            input.where.workspaceId_githubLogin.workspaceId &&
          member.githubLogin === input.where.workspaceId_githubLogin.githubLogin
        ) {
          return { id: member.id };
        }
      }

      return null;
    },
    delete: async (input: { readonly where: { readonly id: string } }) => {
      this.members.delete(input.where.id);
    },
    update: async (input: {
      readonly where: { readonly id: string };
      readonly data: Partial<
        Pick<WorkspaceMemberRow, "userId" | "githubLogin" | "role">
      >;
    }) => {
      const existing = this.members.get(input.where.id);
      if (!existing) {
        throw new Error("member_not_found");
      }
      const updated = { ...existing, ...input.data };
      this.assertMemberUnique(updated);
      this.members.set(input.where.id, updated);
      return updated;
    },
    create: async (input: {
      readonly data: Pick<
        WorkspaceMemberRow,
        "workspaceId" | "userId" | "githubLogin" | "role"
      >;
    }) => {
      const created: WorkspaceMemberRow = {
        id: `member-${++this.memberSequence}`,
        ...input.data,
      };
      this.assertMemberUnique(created);
      this.members.set(created.id, created);
      return created;
    },
  };

  seedInstallation(input: {
    readonly githubInstallationId: string;
    readonly workspaceId: string;
  }): void {
    this.installations.set(input.githubInstallationId, {
      workspaceId: input.workspaceId,
    });
  }

  seedUser(input: UserRow): void {
    this.users.set(String(input.githubUserId), input);
  }

  seedMember(input: WorkspaceMemberRow): void {
    this.assertMemberUnique(input);
    this.members.set(input.id, input);
  }

  private assertMemberUnique(candidate: WorkspaceMemberRow): void {
    for (const member of this.members.values()) {
      if (
        member.id === candidate.id ||
        member.workspaceId !== candidate.workspaceId
      ) {
        continue;
      }
      if (candidate.userId && member.userId === candidate.userId) {
        throw new Error("Unique constraint failed on workspaceId_userId");
      }
      if (
        candidate.githubLogin &&
        member.githubLogin === candidate.githubLogin
      ) {
        throw new Error("Unique constraint failed on workspaceId_githubLogin");
      }
    }
  }
}

describe("PrismaInstallationWorkspaceOwnerGrant", () => {
  it("keeps repeated installation owner grants idempotent", async () => {
    const prisma = new FakeOwnerGrantPrisma();
    prisma.seedInstallation({
      githubInstallationId: "129",
      workspaceId: "workspace-1",
    });
    const grants = new PrismaInstallationWorkspaceOwnerGrant(prisma as never);

    await grants.grantInstallationActorOwner({
      githubInstallationId: "129",
      githubUserId: "777",
      githubLogin: "777genius",
      avatarUrl: "https://avatars.example/777.png",
    });
    await grants.grantInstallationActorOwner({
      githubInstallationId: "129",
      githubUserId: "777",
      githubLogin: "777genius",
      avatarUrl: "https://avatars.example/777.png",
    });

    expect([...prisma.members.values()]).toEqual([
      expect.objectContaining({
        workspaceId: "workspace-1",
        userId: "user-777",
        githubLogin: "777genius",
        role: "owner",
      }),
    ]);
  });

  it("merges stale login-only rows before updating the user-linked owner row", async () => {
    const prisma = new FakeOwnerGrantPrisma();
    prisma.seedInstallation({
      githubInstallationId: "129",
      workspaceId: "workspace-1",
    });
    prisma.seedUser({
      id: "user-777",
      githubUserId: 777n,
      githubLogin: "old-login",
      avatarUrl: null,
    });
    prisma.seedMember({
      id: "member-by-user",
      workspaceId: "workspace-1",
      userId: "user-777",
      githubLogin: "old-login",
      role: "member",
    });
    prisma.seedMember({
      id: "member-by-login",
      workspaceId: "workspace-1",
      userId: null,
      githubLogin: "777genius",
      role: "member",
    });
    const grants = new PrismaInstallationWorkspaceOwnerGrant(prisma as never);

    await grants.grantInstallationActorOwner({
      githubInstallationId: "129",
      githubUserId: "777",
      githubLogin: "777genius",
      avatarUrl: null,
    });

    expect([...prisma.members.values()]).toEqual([
      {
        id: "member-by-user",
        workspaceId: "workspace-1",
        userId: "user-777",
        githubLogin: "777genius",
        role: "owner",
      },
    ]);
  });
});
