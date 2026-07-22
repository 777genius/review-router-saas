import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  ReviewCompletionRecoveryCandidate,
  ReviewCompletionRecoveryCursor,
  ReviewCompletionRecoveryFeedPort,
  ReviewCompletionRecoveryPage,
} from "../../application/ports/review-completion-process-ports";

export class PrismaReviewCompletionRecoveryFeed implements ReviewCompletionRecoveryFeedPort {
  constructor(private readonly prisma: PrismaClient) {}

  async scanMissingAfter(input: {
    readonly after: ReviewCompletionRecoveryCursor | null;
    readonly limit: number;
  }): Promise<ReviewCompletionRecoveryPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new Error("review_completion_invalid_recovery_limit");
    }
    if (input.after && input.after.executionId.trim().length === 0) {
      throw new Error("review_completion_invalid_recovery_cursor");
    }

    const cursor = input.after
      ? Prisma.sql`
          AND (
            artifact."createdAt" > ${input.after.createdAt}
            OR (
              artifact."createdAt" = ${input.after.createdAt}
              AND artifact."executionId" > ${input.after.executionId}
            )
          )
        `
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<RecoveryCandidateRow[]>(Prisma.sql`
      SELECT
        artifact."executionId",
        artifact."artifactId" AS "finalizedArtifactId",
        artifact."createdAt",
        artifact."retainUntil"
      FROM "FinalizedReviewProjectionArtifactV2" artifact
      LEFT JOIN "ReviewCompletionProcess" process
        ON process."executionId" = artifact."executionId"
      WHERE process."executionId" IS NULL
      ${cursor}
      ORDER BY artifact."createdAt" ASC, artifact."executionId" ASC
      LIMIT ${input.limit}
    `);
    const candidates = rows.map(toCandidate);
    const last = candidates.at(-1);
    return {
      candidates,
      nextCursor:
        candidates.length === input.limit && last
          ? {
              createdAt: new Date(last.createdAt),
              executionId: last.executionId,
            }
          : null,
    };
  }
}

type RecoveryCandidateRow = {
  readonly executionId: string;
  readonly finalizedArtifactId: string;
  readonly createdAt: Date;
  readonly retainUntil: Date;
};

function toCandidate(
  row: RecoveryCandidateRow,
): ReviewCompletionRecoveryCandidate {
  return {
    executionId: row.executionId,
    finalizedArtifactId: row.finalizedArtifactId,
    createdAt: new Date(row.createdAt),
    retainUntil: new Date(row.retainUntil),
  };
}
