import { InMemoryReviewRunControlStore } from "../infrastructure/memory/in-memory-review-run-control-store";
import { reviewRunControlRepositoryContract } from "./support/review-run-control-repository-contract";

reviewRunControlRepositoryContract("memory", "memory-run-control", async () => {
  const store = new InMemoryReviewRunControlStore();
  return {
    releases: store,
    identities: store,
    authorities: store,
    safety: store,
    authorizations: store,
    async prepareRepository() {},
    async readRepositoryBinding() {
      return undefined;
    },
  };
});
