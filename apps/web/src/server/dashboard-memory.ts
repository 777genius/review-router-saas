import {
  CryptoMemoryIdGenerator,
  PrismaMemoryItemRepository,
  PrismaMemorySuggestionRepository,
  PrismaMemoryTransaction,
  type MemoryActor,
  type MemoryPermissionDecision,
  type MemoryPermissionPort,
  type MemoryScope,
  type MemoryUseCaseDependencies,
} from "@reviewrouter/features-memory";
import type { PrismaClient } from "@reviewrouter/platform-db";

export type DashboardMemoryActorInput = {
  readonly githubUserId: string;
  readonly githubLogin: string;
};

export async function resolveDashboardMemoryActor(
  input: DashboardMemoryActorInput,
  prisma: PrismaClient,
): Promise<MemoryActor> {
  const user = await prisma.user.upsert({
    where: { githubUserId: BigInt(input.githubUserId) },
    update: { githubLogin: input.githubLogin },
    create: {
      githubUserId: BigInt(input.githubUserId),
      githubLogin: input.githubLogin,
    },
    select: { id: true, githubUserId: true, githubLogin: true },
  });

  return {
    kind: "github_user",
    id: user.id,
    githubUserId: user.githubUserId.toString(),
    login: user.githubLogin,
  };
}

export function createDashboardMemoryDependencies(input: {
  readonly prisma: PrismaClient;
  readonly actor: DashboardMemoryActorInput;
}): MemoryUseCaseDependencies {
  return {
    memoryItems: new PrismaMemoryItemRepository(input.prisma),
    memorySuggestions: new PrismaMemorySuggestionRepository(input.prisma),
    memoryPermissions: new DashboardMemoryPermission(
      input.prisma,
      input.actor,
      readCsvEnv("REVIEW_ROUTER_LOCAL_ADMIN_GITHUB_LOGINS"),
    ),
    memoryIds: new CryptoMemoryIdGenerator(),
    memoryTransaction: new PrismaMemoryTransaction(input.prisma),
    clock: { now: () => new Date() },
  };
}

class DashboardMemoryPermission implements MemoryPermissionPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly actor: DashboardMemoryActorInput,
    private readonly localAdminGithubLogins: readonly string[],
  ) {}

  async canConfirmMemory(input: {
    readonly workspaceId: string;
    readonly repositoryId: string | null;
    readonly userId: string | null;
    readonly scope: MemoryScope;
    readonly actor: MemoryActor;
  }): Promise<MemoryPermissionDecision> {
    if (input.actor.githubUserId !== this.actor.githubUserId) {
      return deny("permission_service_unavailable", false);
    }
    if (this.isLocalAdmin()) {
      return { allowed: true };
    }

    if (input.scope === "user_prefs") {
      return input.userId && input.userId === input.actor.id
        ? { allowed: true }
        : deny("not_user_owner", false);
    }

    if (input.scope === "repository") {
      const repositoryAvailable = await this.repositoryAvailable({
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId,
      });
      if (!repositoryAvailable) {
        return deny("repository_unavailable", false);
      }
    }

    const role = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: input.workspaceId,
        user: { githubUserId: BigInt(this.actor.githubUserId) },
      },
      select: { role: true },
    });
    if (role?.role === "owner" || role?.role === "admin") {
      return { allowed: true };
    }
    return deny(
      input.scope === "repository"
        ? "not_repository_maintainer"
        : "not_workspace_admin",
      false,
    );
  }

  private isLocalAdmin(): boolean {
    return this.localAdminGithubLogins.some(
      (login) => login.toLowerCase() === this.actor.githubLogin.toLowerCase(),
    );
  }

  private async repositoryAvailable(input: {
    readonly workspaceId: string;
    readonly repositoryId: string | null;
  }): Promise<boolean> {
    if (!input.repositoryId) return false;
    const repository = await this.prisma.repositoryConnection.findFirst({
      where: {
        id: input.repositoryId,
        workspaceId: input.workspaceId,
      },
      select: {
        selected: true,
        archived: true,
      },
    });
    return Boolean(repository?.selected && !repository.archived);
  }
}

function deny(
  reason: Exclude<
    MemoryPermissionDecision,
    { readonly allowed: true }
  >["reason"],
  retryable: boolean,
): MemoryPermissionDecision {
  return { allowed: false, reason, retryable };
}

function readCsvEnv(name: string): readonly string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
