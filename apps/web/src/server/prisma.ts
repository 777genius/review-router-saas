import {
  createPrismaClient,
  resolveCodexOAuthDatabaseEffectAuthorityUrl,
  type PrismaClient,
} from "@reviewrouter/platform-db";

type PrismaGlobal = typeof globalThis & {
  reviewRouterPrisma?: PrismaClient;
  reviewRouterCodexEffectAuthorityPrisma?: PrismaClient;
};

const prismaGlobal = globalThis as PrismaGlobal;

export function getPrisma(): PrismaClient {
  const prisma = prismaGlobal.reviewRouterPrisma ?? createPrismaClient();

  if (process.env.NODE_ENV !== "production") {
    prismaGlobal.reviewRouterPrisma = prisma;
  }

  return prisma;
}

export function getCodexEffectAuthorityPrisma(): PrismaClient {
  const databaseUrl = resolveCodexOAuthDatabaseEffectAuthorityUrl({
    env: process.env,
    runtimeDatabaseUrl: process.env.DATABASE_URL,
  });
  if (!databaseUrl) return getPrisma();
  const prisma =
    prismaGlobal.reviewRouterCodexEffectAuthorityPrisma ??
    createPrismaClient({ databaseUrl, poolMax: 2 });
  if (process.env.NODE_ENV !== "production") {
    prismaGlobal.reviewRouterCodexEffectAuthorityPrisma = prisma;
  }
  return prisma;
}
