import {
  assertEpochMilliseconds,
  assertPositiveInteger,
} from "../../domain/review-evidence-primitives";
import type { ClockPort } from "../ports/clock-port";
import type { ReviewEvidencePrunerPort } from "../ports/review-observation-ports";

export const reviewEvidenceMaxPruneLimit = 10_000;

export class PruneReviewEvidence {
  constructor(
    private readonly dependencies: Readonly<{
      pruner: ReviewEvidencePrunerPort;
      clock: ClockPort;
    }>,
  ) {}

  async execute(input: { readonly limit: number }): Promise<number> {
    assertPositiveInteger(input.limit, "prune_limit");
    if (input.limit > reviewEvidenceMaxPruneLimit) {
      throw new Error("review_evidence_prune_limit_exceeded");
    }
    const nowMs = this.dependencies.clock.nowMs();
    assertEpochMilliseconds(nowMs, "now_ms");
    return this.dependencies.pruner.pruneRetainedObservations({
      retainUntilOrBeforeMs: nowMs,
      limit: input.limit,
    });
  }
}
