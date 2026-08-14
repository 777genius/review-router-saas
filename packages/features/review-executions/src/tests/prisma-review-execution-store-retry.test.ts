import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ReviewObservationAttachmentStatus } from "../application/ports/review-execution-ports";
import { PrismaReviewExecutionStore } from "../infrastructure/prisma/prisma-review-execution-store";

describe("Prisma review execution attachment retries", () => {
  it("retries serialization conflicts before returning the attachment result", async () => {
    const prisma = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce(serializationConflict())
        .mockRejectedValueOnce(serializationConflict())
        .mockResolvedValueOnce({
          status: ReviewObservationAttachmentStatus.Attached,
        }),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);

    await expect(store.attachObservation({} as never)).resolves.toEqual({
      status: ReviewObservationAttachmentStatus.Attached,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it("does not misreport an exhausted serialization conflict as a domain conflict", async () => {
    const conflict = serializationConflict();
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(conflict),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);

    await expect(store.attachObservation({} as never)).rejects.toBe(conflict);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });
});

function serializationConflict() {
  return new Prisma.PrismaClientKnownRequestError("serialization conflict", {
    code: "P2034",
    clientVersion: "test",
  });
}
