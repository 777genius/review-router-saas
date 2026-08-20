import {
  reviewExecutionAbsoluteMaxAttemptBudget,
  reviewExecutionAbsoluteMaxFindingCount,
  reviewExecutionAbsoluteMaxProjectionBytes,
  reviewExecutionAbsoluteMaxWorkSlots,
} from "@reviewrouter/features-review-executions";
import type { ReviewProtocolLimits } from "@reviewrouter/features-review-run-control";

export const reviewActionV2AbsoluteProtocolMaxima: ReviewProtocolLimits =
  Object.freeze({
    maxWorkSlots: reviewExecutionAbsoluteMaxWorkSlots,
    maxAttemptsPerSlot: reviewExecutionAbsoluteMaxAttemptBudget,
    maxObservationBytes: 2 * 1024 * 1024,
    maxObservationFindings: 2_000,
    maxProjectionBytes: reviewExecutionAbsoluteMaxProjectionBytes,
    maxProjectionFindings: reviewExecutionAbsoluteMaxFindingCount,
    maxPublicationOperations: 1_000,
    maxPublicationChunks: 1_000,
    maxPublicationBodyBytes: 2 * 1024 * 1024,
    maxRequestBatchSize: 100,
    maxLeaseDurationMs: 60 * 60 * 1_000,
    maxResultReportDurationMs: 6 * 60 * 60 * 1_000,
    maxReconciliationDurationMs: 24 * 60 * 60 * 1_000,
  });
