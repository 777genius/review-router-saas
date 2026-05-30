import { describe, expect, it, vi } from "vitest";
import {
  createReviewPublicationPlan,
  type ReviewPublicationPlan,
} from "../../domain/review-publication";
import { ProviderReviewPublisher } from "./publish-review";

const headSha = "a".repeat(40);

describe("ProviderReviewPublisher", () => {
  it("selects the publisher by SCM provider at the composition seam", async () => {
    const githubPublisher = { publishReview: vi.fn() };
    const gitlabPublisher = {
      publishReview: vi.fn(async (plan: ReviewPublicationPlan) => ({
        target: plan.target,
        inlineCommentCount: 0,
        summaryCommentCount: 1,
        skippedInlineFindings: [],
        externalIds: ["gitlab:summary:1"],
      })),
    };
    const publisher = new ProviderReviewPublisher(
      new Map([
        ["github", githubPublisher],
        ["gitlab", gitlabPublisher],
      ]),
    );
    const plan = createReviewPublicationPlan({
      target: {
        provider: "gitlab",
        repositoryExternalId: "123",
        repositoryFullName: "group/project",
        changeRequestExternalId: "7",
        headSha,
      },
      marker: "reviewrouter:review:v1",
      mode: "summary-only",
      findings: [],
    });

    await expect(publisher.publishReview(plan)).resolves.toMatchObject({
      externalIds: ["gitlab:summary:1"],
    });
    expect(gitlabPublisher.publishReview).toHaveBeenCalledWith(plan);
    expect(githubPublisher.publishReview).not.toHaveBeenCalled();
  });
});
