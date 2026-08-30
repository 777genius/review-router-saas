import { Prisma } from "@prisma/client";

export type ReviewExecutionTransaction = Prisma.TransactionClient;

export async function databaseNow(
  transaction: ReviewExecutionTransaction,
): Promise<Date> {
  const rows = await transaction.$queryRaw<Array<{ epochMs: bigint }>>(
    Prisma.sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "epochMs"`,
  );
  const epochMs = rows[0]?.epochMs;
  const epochMsNumber = epochMs === undefined ? Number.NaN : Number(epochMs);
  if (!Number.isSafeInteger(epochMsNumber)) {
    throw new Error("review_execution_database_clock_invalid");
  }
  return new Date(epochMsNumber);
}

export async function lockScope(
  transaction: ReviewExecutionTransaction,
  scopeKey: string,
): Promise<void> {
  await transaction.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))`,
  );
}

export async function lockExecution(
  transaction: ReviewExecutionTransaction,
  executionId: string,
): Promise<void> {
  await transaction.$queryRaw(
    Prisma.sql`SELECT "executionId" FROM "ReviewExecutionV2" WHERE "executionId" = ${executionId} FOR UPDATE`,
  );
}

export async function lockLease(
  transaction: ReviewExecutionTransaction,
  leaseId: string,
): Promise<void> {
  await transaction.$queryRaw(
    Prisma.sql`SELECT "leaseId" FROM "ReviewInvocationLeaseV2" WHERE "leaseId" = ${leaseId} FOR UPDATE`,
  );
}

export function databaseRelativeDate(
  databaseTime: Date,
  requestedAt: Date,
  requestedDeadline: Date,
  field: string,
): Date {
  const duration = requestedDeadline.getTime() - requestedAt.getTime();
  if (!Number.isSafeInteger(duration) || duration < 0) {
    throw new Error(`review_execution_invalid_${field}`);
  }
  return new Date(databaseTime.getTime() + duration);
}

export function isUniqueConstraintError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

export function isTransactionConflictError(error: unknown): boolean {
  if (isDriverAdapterTransactionWriteConflict(error)) return true;
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034" || error.code === "P2028") return true;
  if (error.code !== "P2010") return false;
  const details = `${safeJson(error.meta)} ${error.message}`;
  return /(?:^|\D)(?:40001|40P01)(?:\D|$)/u.test(details);
}

function isDriverAdapterTransactionWriteConflict(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "DriverAdapterError") {
    return false;
  }
  const cause = (error as Error & { readonly cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    Object.prototype.hasOwnProperty.call(cause, "kind") &&
    (cause as { readonly kind?: unknown }).kind === "TransactionWriteConflict"
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
