import { describe, expect, it, vi } from "vitest";
import { stringifyReviewFindingsArtifact } from "../../domain/review-findings-artifact";
import { publishReviewFindingsArtifact } from "./publish-review-findings-artifact";

describe("publishReviewFindingsArtifact", () => {
  it("parses the CI-local artifact and publishes through the provider port", async () => {
    const publisher = {
      publishReview: vi.fn(async () => ({
        target: {
          provider: "gitlab" as const,
          repositoryExternalId: "123",
          repositoryFullName: "group/project",
          changeRequestExternalId: "5",
          headSha: "a".repeat(40),
        },
        inlineCommentCount: 1,
        summaryCommentCount: 1,
        skippedInlineFindings: [],
        externalIds: ["gitlab:inline:fingerprint:discussion:1"],
      })),
    };

    const result = await publishReviewFindingsArtifact(
      {
        artifactJson: stringifyReviewFindingsArtifact({
          protocolVersion: 1,
          generatedAt: "2026-05-30T12:00:00.000Z",
          findings: [
            {
              fingerprint: "fingerprint",
              severity: "major",
              title: "Risky branch",
              body: "Use an explicit guard before this branch.",
              location: { filePath: "src/app.ts", newLine: 12 },
            },
          ],
        }),
        target: {
          provider: "gitlab",
          repositoryExternalId: "123",
          repositoryFullName: "group/project",
          changeRequestExternalId: "5",
          headSha: "a".repeat(40),
        },
        marker: "reviewrouter:test",
        maxInlineComments: 3,
      },
      { publisher },
    );

    expect(result.inlineCommentCount).toBe(1);
    expect(publisher.publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        marker: "reviewrouter:test",
        maxInlineComments: 3,
        findings: [
          expect.objectContaining({
            fingerprint: "fingerprint",
            title: "Risky branch",
          }),
        ],
      }),
    );
  });
});
