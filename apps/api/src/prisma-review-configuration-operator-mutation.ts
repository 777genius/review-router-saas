import type { PrismaClient } from "@prisma/client";
import { PrismaAuditLogRepository } from "@reviewrouter/features-audit-log";
import {
  isPrismaReviewConfigurationSerializationConflict,
  isPrismaReviewConfigurationWriteConflict,
  isReviewConfigurationWriteConflictError,
  PrismaReviewConfigurationTransactionRepository,
  resolveReviewConfiguration,
  ReviewConfigurationWriteConflictError,
  type ReviewConfigurationOperatorMutationPort,
} from "@reviewrouter/features-review-config";
import { ReviewConfigurationOperatorAudit } from "./review-configuration-operator-audit.js";

export class PrismaReviewConfigurationOperatorMutation implements ReviewConfigurationOperatorMutationPort {
  constructor(private readonly prisma: PrismaClient) {}

  async commit(
    input: Parameters<ReviewConfigurationOperatorMutationPort["commit"]>[0],
  ) {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const configurations =
              new PrismaReviewConfigurationTransactionRepository(transaction);
            const current = await resolveReviewConfiguration(input.target, {
              configurations,
            });
            if (current.revisionToken !== input.expectedRevisionToken) {
              throw new ReviewConfigurationWriteConflictError();
            }

            const saved = await configurations.saveNextVersion({
              target: input.target,
              config: input.config,
              expectedVersion:
                current.source === "repository" ? current.version : null,
            });
            await new ReviewConfigurationOperatorAudit(
              new PrismaAuditLogRepository(transaction),
            ).record({
              ...input.auditEvent,
              metadata: {
                ...input.auditEvent.metadata,
                version: saved.version,
              },
            });
            return saved;
          },
          { isolationLevel: "Serializable" },
        );
      } catch (error) {
        if (
          isReviewConfigurationWriteConflictError(error) ||
          isPrismaReviewConfigurationWriteConflict(error)
        ) {
          throw new ReviewConfigurationWriteConflictError();
        }
        if (
          !isPrismaReviewConfigurationSerializationConflict(error) ||
          attempt === MAX_TRANSACTION_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
    throw new Error(
      "review_configuration_operator_transaction_retry_exhausted",
    );
  }
}

const MAX_TRANSACTION_ATTEMPTS = 3;
