import type { ReviewExecutionProgressCapturePort } from "@reviewrouter/features-review-executions/composition";
import { captureReviewProgress } from "../infrastructure/prisma/prisma-review-progress-projection";

export function createPrismaReviewProgressCapture(
  options: Readonly<{ fileCoverageEnabled?: boolean }> = {},
): ReviewExecutionProgressCapturePort {
  return (transaction, execution) =>
    captureReviewProgress(transaction, execution, options);
}
