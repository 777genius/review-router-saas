import {
  CryptoMemoryIdGenerator,
  EntitlementMemoryPolicyConfig,
  EntitlementMemoryQuotaPolicy,
  PrismaMemoryItemRepository,
  PrismaMemoryPermission,
  PrismaMemorySuggestionRepository,
  PrismaMemoryTransaction,
  PrismaMemoryUsageEventRepository,
  readMemoryServiceEnabled,
  type MemoryActor,
  type MemoryUseCaseDependencies,
} from "@reviewrouter/features-memory";
import { PrismaEntitlementRepository } from "@reviewrouter/features-entitlements";
import type { PrismaClient } from "@reviewrouter/platform-db";

export type DashboardMemoryActorInput = {
  readonly userId: string;
  readonly sourceProvider: "github" | "gitlab";
  readonly sourceLogin: string;
  readonly githubUserId: string | null;
  readonly githubLogin: string | null;
};

export async function resolveDashboardMemoryActor(
  input: DashboardMemoryActorInput,
  prisma: PrismaClient,
): Promise<MemoryActor> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, githubUserId: true, githubLogin: true },
  });
  if (!user) {
    throw new Error("memory_actor_not_found");
  }

  return buildDashboardMemoryActor({
    ...input,
    githubUserId: input.githubUserId ?? user.githubUserId?.toString() ?? null,
    githubLogin: input.githubLogin ?? user.githubLogin,
  });
}

export function buildDashboardMemoryActor(
  input: DashboardMemoryActorInput,
): MemoryActor {
  if (input.sourceProvider === "gitlab") {
    return {
      kind: "workspace_user",
      id: input.userId,
      githubUserId: null,
      login: input.sourceLogin,
    };
  }

  if (!input.githubUserId) {
    throw new Error("github_user_id_required");
  }

  return {
    kind: "github_user",
    id: input.userId,
    githubUserId: input.githubUserId,
    login: input.githubLogin ?? input.sourceLogin,
  };
}

export function createDashboardMemoryDependencies(input: {
  readonly prisma: PrismaClient;
  readonly actor: DashboardMemoryActorInput;
}): MemoryUseCaseDependencies {
  return {
    memoryItems: new PrismaMemoryItemRepository(input.prisma),
    memorySuggestions: new PrismaMemorySuggestionRepository(input.prisma),
    memoryPermissions: new PrismaMemoryPermission(input.prisma, {
      localAdminGithubLogins: readCsvEnv(
        "REVIEW_ROUTER_LOCAL_ADMIN_GITHUB_LOGINS",
      ),
    }),
    memoryPolicyConfig: new EntitlementMemoryPolicyConfig(
      new PrismaEntitlementRepository(input.prisma),
      { serviceEnabled: readMemoryServiceEnabled(process.env) },
    ),
    memoryUsageEvents: new PrismaMemoryUsageEventRepository(input.prisma),
    memoryQuotaPolicy: new EntitlementMemoryQuotaPolicy(
      new PrismaEntitlementRepository(input.prisma),
    ),
    memoryIds: new CryptoMemoryIdGenerator(),
    memoryTransaction: new PrismaMemoryTransaction(input.prisma),
    clock: { now: () => new Date() },
  };
}

function readCsvEnv(name: string): readonly string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
