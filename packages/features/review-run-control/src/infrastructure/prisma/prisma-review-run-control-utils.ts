import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";

export type ReviewRunControlTransaction = Prisma.TransactionClient;

export async function lockReviewRunControlKey(
  transaction: ReviewRunControlTransaction,
  namespace: string,
  key: string,
): Promise<void> {
  const lockIdentity = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(key)
    .digest("hex");
  await transaction.$queryRaw(
    Prisma.sql`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0))`,
  );
}

export async function lockReviewRunControlKeys(
  transaction: ReviewRunControlTransaction,
  namespace: string,
  keys: readonly string[],
): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await lockReviewRunControlKey(transaction, namespace, key);
  }
}

export async function databaseNow(
  transaction: ReviewRunControlTransaction,
): Promise<Date> {
  const rows = await transaction.$queryRaw<readonly { now: Date }[]>(
    Prisma.sql`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS "now"`,
  );
  const now = rows[0]?.now;
  if (!(now instanceof Date)) {
    throw new Error("review_run_control_database_time_unavailable");
  }
  return now;
}

export function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

export function isPrismaTransactionConflictError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  if (error.code !== "P2010") return false;
  const details = `${safeJson(error.meta)} ${error.message}`;
  return /(?:^|\D)(?:40001|40P01)(?:\D|$)/u.test(details);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
