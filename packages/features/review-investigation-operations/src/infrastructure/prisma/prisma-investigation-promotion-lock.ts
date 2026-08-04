import { Prisma, type PrismaClient } from "@prisma/client";

const maximumTransactionAttempts = 3;
const promotionReleaseLockNamespace = "review-investigation-promotion";

export async function withInvestigationPromotionReleaseLock<Result>(
  prisma: PrismaClient,
  producerReleaseId: string,
  work: (transaction: Prisma.TransactionClient) => Promise<Result>,
): Promise<Result> {
  for (let attempt = 0; attempt < maximumTransactionAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (transaction) => {
          const lockKey = `${promotionReleaseLockNamespace}:${producerReleaseId}`;
          await transaction.$queryRaw`
            SELECT 1::integer AS acquired
            FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
          `;
          return work(transaction);
        },
        {
          // A read after a waited lock must snapshot after the lock holder commits.
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        attempt < maximumTransactionAttempts - 1
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("promotion_transaction_retry_exhausted");
}
