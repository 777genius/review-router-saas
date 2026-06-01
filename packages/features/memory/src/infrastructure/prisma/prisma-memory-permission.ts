import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  MemoryPermissionDecision,
  MemoryPermissionPort,
} from "../../application/ports/memory-permission-port";
import type { MemoryActor } from "../../domain/memory-actor";
import type { MemoryScope } from "../../domain/memory-scope-policy";

export class PrismaMemoryPermission implements MemoryPermissionPort {
  constructor(
    private readonly prisma: PrismaClient | Prisma.TransactionClient,
    private readonly options: {
      readonly localAdminGithubLogins?: readonly string[];
    } = {},
  ) {}

  async canConfirmMemory(input: {
    readonly workspaceId: string;
    readonly repositoryId: string | null;
    readonly userId: string | null;
    readonly scope: MemoryScope;
    readonly actor: MemoryActor;
  }): Promise<MemoryPermissionDecision> {
    if (this.isLocalAdmin(input.actor)) {
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

    const role = await this.findWorkspaceRole({
      workspaceId: input.workspaceId,
      actor: input.actor,
    });
    if (role === "owner" || role === "admin") {
      return { allowed: true };
    }

    return deny(
      input.scope === "repository"
        ? "not_repository_maintainer"
        : "not_workspace_admin",
      false,
    );
  }

  private isLocalAdmin(actor: MemoryActor): boolean {
    if (actor.kind !== "github_user") return false;
    if (!actor.login) return false;
    return (
      this.options.localAdminGithubLogins?.some(
        (login) => login.toLowerCase() === actor.login?.toLowerCase(),
      ) === true
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

  private async findWorkspaceRole(input: {
    readonly workspaceId: string;
    readonly actor: MemoryActor;
  }): Promise<"owner" | "admin" | "member" | null> {
    const actorFilter = workspaceMemberActorFilter(input.actor);
    if (!actorFilter) return null;

    const member = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: input.workspaceId,
        OR: actorFilter,
      },
      select: { role: true },
    });

    return member?.role ?? null;
  }
}

function workspaceMemberActorFilter(
  actor: MemoryActor,
): Prisma.WorkspaceMemberWhereInput[] | null {
  if (actor.kind === "workspace_user") {
    return [{ userId: actor.id }];
  }
  const filters: Prisma.WorkspaceMemberWhereInput[] = [];
  if (actor.githubUserId && /^\d+$/.test(actor.githubUserId)) {
    filters.push({ user: { githubUserId: BigInt(actor.githubUserId) } });
  }
  if (actor.login) {
    filters.push({
      githubLogin: { equals: actor.login, mode: "insensitive" },
    });
    filters.push({
      user: { githubLogin: { equals: actor.login, mode: "insensitive" } },
    });
  }
  return filters.length > 0 ? filters : null;
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
