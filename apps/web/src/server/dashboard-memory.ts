import {
  CryptoMemoryIdGenerator,
  PrismaMemoryItemRepository,
  PrismaMemoryPermission,
  PrismaMemorySuggestionRepository,
  PrismaMemoryTransaction,
  PrismaMemoryUsageEventRepository,
  type MemoryActor,
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
    memoryPermissions: new PrismaMemoryPermission(input.prisma, {
      localAdminGithubLogins: readCsvEnv(
        "REVIEW_ROUTER_LOCAL_ADMIN_GITHUB_LOGINS",
      ),
    }),
    memoryUsageEvents: new PrismaMemoryUsageEventRepository(input.prisma),
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
