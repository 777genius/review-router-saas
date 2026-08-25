import { describe, expect, it, vi } from "vitest";
import { reconcileExpiredInvocationGrants } from "../application/use-cases/reconcile-expired-invocation-grants";

describe("reconcileExpiredInvocationGrants", () => {
  it("drains multiple bounded batches with one stable cutoff", async () => {
    const expireIssuedBatch = vi
      .fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    const hasIssuedExpiringAtOrBefore = vi.fn();
    const now = new Date("2026-08-25T12:00:00.000Z");

    await expect(
      reconcileExpiredInvocationGrants(
        { now, batchSize: 2, maxBatches: 3 },
        { expireIssuedBatch, hasIssuedExpiringAtOrBefore },
      ),
    ).resolves.toEqual({ expiredCount: 5, batches: 3 });
    expect(expireIssuedBatch).toHaveBeenCalledTimes(3);
    expect(expireIssuedBatch).toHaveBeenCalledWith({ now, limit: 2 });
    expect(hasIssuedExpiringAtOrBefore).not.toHaveBeenCalled();
  });

  it("fails boundedly when the backlog exceeds the configured work limit", async () => {
    const expiry = {
      expireIssuedBatch: vi.fn(async ({ limit }: { limit: number }) => limit),
      hasIssuedExpiringAtOrBefore: vi.fn(async () => true),
    };
    await expect(
      reconcileExpiredInvocationGrants(
        {
          now: new Date("2026-08-25T12:00:00.000Z"),
          batchSize: 2,
          maxBatches: 2,
        },
        expiry,
      ),
    ).rejects.toThrow("invocation_grant_expiry_reconciliation_limit_exceeded");
    expect(expiry.expireIssuedBatch).toHaveBeenCalledTimes(2);
    expect(expiry.hasIssuedExpiringAtOrBefore).toHaveBeenCalledOnce();
    expect(expiry.hasIssuedExpiringAtOrBefore).toHaveBeenCalledWith({
      now: new Date("2026-08-25T12:00:00.000Z"),
    });
  });

  it("succeeds when the backlog ends exactly at the configured work limit", async () => {
    const expireIssuedBatch = vi
      .fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(2);
    const hasIssuedExpiringAtOrBefore = vi.fn(async () => false);
    const now = new Date("2026-08-25T12:00:00.000Z");

    await expect(
      reconcileExpiredInvocationGrants(
        { now, batchSize: 2, maxBatches: 2 },
        { expireIssuedBatch, hasIssuedExpiringAtOrBefore },
      ),
    ).resolves.toEqual({ expiredCount: 4, batches: 2 });
    expect(expireIssuedBatch).toHaveBeenCalledTimes(2);
    expect(hasIssuedExpiringAtOrBefore).toHaveBeenCalledOnce();
    expect(hasIssuedExpiringAtOrBefore).toHaveBeenCalledWith({ now });
  });
});
