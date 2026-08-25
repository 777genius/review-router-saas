import { z } from "zod";
import type { InvocationGrantExpiryPort } from "../ports/invocation-grant-expiry-port";

export const invocationGrantExpiryBatchSize = 250;
export const invocationGrantExpiryMaxBatches = 1_000;

export async function reconcileExpiredInvocationGrants(
  input: Readonly<{
    now: Date;
    batchSize?: number;
    maxBatches?: number;
  }>,
  expiry: InvocationGrantExpiryPort,
): Promise<Readonly<{ expiredCount: number; batches: number }>> {
  const now = z.date().parse(input.now);
  const batchSize = z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .parse(input.batchSize ?? invocationGrantExpiryBatchSize);
  const maxBatches = z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .parse(input.maxBatches ?? invocationGrantExpiryMaxBatches);

  let expiredCount = 0;
  for (let batches = 1; batches <= maxBatches; batches += 1) {
    const expired = await expiry.expireIssuedBatch({ now, limit: batchSize });
    if (!Number.isInteger(expired) || expired < 0 || expired > batchSize) {
      throw new Error("invocation_grant_expiry_batch_result_invalid");
    }
    expiredCount += expired;
    if (expired < batchSize) return { expiredCount, batches };
  }
  throw new Error("invocation_grant_expiry_reconciliation_limit_exceeded");
}
