import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

export type DatabaseHealth = {
  readonly connected: boolean;
  readonly checkedAt: Date;
};

export function createDatabaseHealth(
  connected: boolean,
  checkedAt = new Date(),
): DatabaseHealth {
  return { connected, checkedAt };
}

export type CreatePrismaClientOptions = {
  readonly databaseUrl?: string;
};

export function createPrismaClient(
  options: CreatePrismaClientOptions = {},
): PrismaClient {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to create PrismaClient");
  }

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
}

export { PrismaClient };
