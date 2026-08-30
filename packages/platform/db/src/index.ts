import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

export { resolveCodexOAuthDatabaseEffectAuthorityUrl } from "./codex-oauth-database-effect-authority.js";
export { resolveCommentTokenCustodyDatabaseAuthorityUrl } from "./comment-token-custody-database-authority.js";
export {
  PostgresTransactionClock,
  type PostgresTransactionClockClient,
  type TransactionClock,
} from "./postgres-transaction-clock.js";

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
  readonly poolMax?: number;
  /** Retire authenticated backends even while periodically active. */
  readonly poolMaxLifetimeSeconds?: number;
  readonly transactionMaxWaitMs?: number;
  readonly transactionTimeoutMs?: number;
};

export function createPrismaClient(
  options: CreatePrismaClientOptions = {},
): PrismaClient {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to create PrismaClient");
  }
  const poolMax =
    options.poolMax ??
    parseOptionalPositiveInteger("REVIEW_ROUTER_DB_POOL_MAX");
  const adapterConfig = {
    connectionString: databaseUrl,
    ...(typeof poolMax === "number" ? { max: poolMax } : {}),
    ...(typeof options.poolMaxLifetimeSeconds === "number"
      ? { maxLifetimeSeconds: options.poolMaxLifetimeSeconds }
      : {}),
  };

  return new PrismaClient({
    adapter: new PrismaPg(adapterConfig),
    transactionOptions: {
      ...(typeof options.transactionMaxWaitMs === "number"
        ? { maxWait: options.transactionMaxWaitMs }
        : {}),
      ...(typeof options.transactionTimeoutMs === "number"
        ? { timeout: options.transactionTimeoutMs }
        : {}),
    },
  });
}

function parseOptionalPositiveInteger(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export { PrismaClient };
