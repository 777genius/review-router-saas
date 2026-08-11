import { describe, expect, it, vi } from "vitest";
import { PostgresTransactionClock } from "./postgres-transaction-clock";

describe("PostgresTransactionClock", () => {
  it("converts an integer epoch millisecond returned by PostgreSQL", async () => {
    const query = vi.fn().mockResolvedValue([{ epochMs: 1_786_406_400_123n }]);
    const clock = new PostgresTransactionClock();

    await expect(clock.now({ $queryRaw: query } as never)).resolves.toEqual(
      new Date(1_786_406_400_123),
    );
    expect(query).toHaveBeenCalledOnce();
  });

  it("fails closed when PostgreSQL returns no row", async () => {
    const clock = new PostgresTransactionClock();
    await expect(
      clock.now({ $queryRaw: vi.fn().mockResolvedValue([]) } as never),
    ).rejects.toThrow("postgres_transaction_clock_missing_row");
  });

  it("fails closed for an epoch outside JavaScript's safe integer range", async () => {
    const clock = new PostgresTransactionClock();
    await expect(
      clock.now({
        $queryRaw: vi
          .fn()
          .mockResolvedValue([
            { epochMs: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
          ]),
      } as never),
    ).rejects.toThrow("postgres_transaction_clock_unsafe_epoch");
  });

  it("propagates query failures without a process-clock fallback", async () => {
    const clock = new PostgresTransactionClock();
    await expect(
      clock.now({
        $queryRaw: vi.fn().mockRejectedValue(new Error("database unavailable")),
      } as never),
    ).rejects.toThrow("database unavailable");
  });
});
