import type { Prisma } from "@prisma/client";

export type PostgresTransactionClockClient = Pick<
  Prisma.TransactionClient,
  "$queryRaw"
>;

export interface TransactionClock {
  now(transaction: PostgresTransactionClockClient): Promise<Date>;
}

/**
 * Reads PostgreSQL wall time rather than the transaction-start timestamp.
 * Durable authorization adapters call this only after acquiring their lock so
 * lock wait time cannot silently extend an authority deadline.
 */
export class PostgresTransactionClock implements TransactionClock {
  async now(transaction: PostgresTransactionClockClient): Promise<Date> {
    const rows = await transaction.$queryRaw<readonly { epochMs: bigint }[]>`
      SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "epochMs"
    `;
    const epochMs = rows[0]?.epochMs;
    if (epochMs === undefined) {
      throw new Error("postgres_transaction_clock_missing_row");
    }
    const numericEpochMs = Number(epochMs);
    if (!Number.isSafeInteger(numericEpochMs)) {
      throw new Error("postgres_transaction_clock_unsafe_epoch");
    }
    return new Date(numericEpochMs);
  }
}
