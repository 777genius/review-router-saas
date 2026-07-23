import type { CreateReviewCompletionProcessInput } from "../../domain/review-completion-process";
import type {
  ReviewCompletionProcessCreateResult,
  ReviewCompletionProcessRepositoryPort,
} from "../ports/review-completion-process-ports";

export class WakeReviewCompletionProcess {
  constructor(
    private readonly processes: ReviewCompletionProcessRepositoryPort,
  ) {}

  execute(
    input: CreateReviewCompletionProcessInput,
  ): Promise<ReviewCompletionProcessCreateResult> {
    return this.processes.createOrWake(input);
  }
}
