import { InMemoryReviewCompletionProcessRepository } from "../infrastructure/memory/in-memory-review-completion-process-repository";
import { reviewCompletionProcessRepositoryContract } from "./support/review-completion-process-repository-contract";

reviewCompletionProcessRepositoryContract("in-memory", () => ({
  repository: new InMemoryReviewCompletionProcessRepository(),
  prepare: async () => undefined,
  preparePublicationAttempt: async () => undefined,
}));
