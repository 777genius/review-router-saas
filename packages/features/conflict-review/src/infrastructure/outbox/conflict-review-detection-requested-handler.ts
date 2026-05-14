import { z } from "zod";
import { safeGitHubBranchName } from "@reviewrouter/shared";
import {
  OutboxHandlerError,
  type OutboxHandler,
} from "@reviewrouter/features-outbox";
import { conflictReviewOutboxEventType } from "../../domain/conflict-review";
import {
  processConflictReviewDetection,
  type ProcessConflictReviewDetectionResult,
} from "../../application/use-cases/process-conflict-review-detection";
import type { ConflictReviewRepositoryPort } from "../../application/ports/conflict-review-repository-port";
import type { ConflictReviewGitHubGatewayPort } from "../../application/ports/conflict-review-github-gateway-port";
import type { Clock } from "@reviewrouter/shared";

const detectionPayloadSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("pull_request"),
      deliveryId: z.string().min(1),
      githubInstallationId: z.string().min(1),
      githubRepositoryId: z.string().min(1),
      repositoryFullName: z.string().min(1),
      pullRequestNumber: z.number().int().positive(),
      action: z.string().min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("base_push"),
      deliveryId: z.string().min(1),
      githubInstallationId: z.string().min(1),
      githubRepositoryId: z.string().min(1),
      repositoryFullName: z.string().min(1),
      baseRef: safeGitHubBranchName,
    })
    .strict(),
]);

export function createConflictReviewDetectionRequestedHandler(dependencies: {
  readonly repositories: ConflictReviewRepositoryPort;
  readonly github: ConflictReviewGitHubGatewayPort;
  readonly clock: Clock;
  readonly logger?: {
    info(message: string, context?: Record<string, unknown>): void;
  };
}): OutboxHandler {
  return {
    type: conflictReviewOutboxEventType,
    version: 1,
    async handle(event) {
      const parsed = detectionPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        throw new OutboxHandlerError(
          "Invalid conflict review detection event payload",
          "invalid_event_payload",
          false,
        );
      }

      const result = await processConflictReviewDetection(parsed.data, {
        repositories: dependencies.repositories,
        github: dependencies.github,
        clock: dependencies.clock,
      });
      logResult(result, dependencies.logger);
      if (
        result.status === "ignored" &&
        result.reason === "github_mergeability_unknown"
      ) {
        throw new OutboxHandlerError(
          "GitHub mergeability is not resolved yet",
          "github_mergeability_unknown",
          true,
        );
      }
    },
  };
}

function logResult(
  result: ProcessConflictReviewDetectionResult,
  logger:
    | { info(message: string, context?: Record<string, unknown>): void }
    | undefined,
): void {
  logger?.info("Processed conflict review detection", { result });
}
