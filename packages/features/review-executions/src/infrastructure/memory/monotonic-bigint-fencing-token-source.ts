import type { ReviewExecutionFencingTokenSourcePort } from "../../application/ports/review-execution-ports";

export class MonotonicBigIntFencingTokenSource implements ReviewExecutionFencingTokenSourcePort {
  private current: bigint;

  constructor(initialValue = 0n) {
    if (initialValue < 0n) {
      throw new Error("review_execution_invalid_initial_fencing_token");
    }
    this.current = initialValue;
  }

  next(): bigint {
    this.current += 1n;
    return this.current;
  }

  peek(): bigint {
    return this.current;
  }
}
