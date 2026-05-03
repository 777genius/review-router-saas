import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";

type PrismaGlobal = typeof globalThis & {
  reviewRouterPrisma?: PrismaClient;
};

const prismaGlobal = globalThis as PrismaGlobal;

export function getPrisma(): PrismaClient {
  const prisma = prismaGlobal.reviewRouterPrisma ?? createPrismaClient();

  if (process.env.NODE_ENV !== "production") {
    prismaGlobal.reviewRouterPrisma = prisma;
  }

  return prisma;
}
