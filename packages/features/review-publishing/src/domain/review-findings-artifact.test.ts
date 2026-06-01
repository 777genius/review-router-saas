import { describe, expect, it } from "vitest";
import {
  createReviewFindingsArtifact,
  createReviewPublicationPlanFromArtifact,
  parseReviewFindingsArtifactJson,
  stringifyReviewFindingsArtifact,
} from "./review-findings-artifact";

const headSha = "a".repeat(40);

describe("review findings artifact", () => {
  it("round-trips the CI-local findings artifact into a publication plan", () => {
    const artifact = createReviewFindingsArtifact({
      generatedAt: new Date("2026-05-30T12:00:00.000Z"),
      summaryMarkdown: "Review summary",
      findings: [
        {
          fingerprint: "finding-1",
          severity: "major",
          title: "Finding title",
          body: "Finding body",
          location: { filePath: "src/app.ts", newLine: 10 },
        },
      ],
    });

    const parsed = parseReviewFindingsArtifactJson(
      stringifyReviewFindingsArtifact(artifact),
    );
    const plan = createReviewPublicationPlanFromArtifact({
      artifact: parsed,
      marker: "reviewrouter:review:v1",
      target: {
        provider: "github",
        repositoryExternalId: "123",
        repositoryFullName: "owner/repo",
        changeRequestExternalId: "7",
        headSha,
      },
    });

    expect(parsed).toEqual(artifact);
    expect(plan.findings).toHaveLength(1);
    expect(plan.findings[0]?.fingerprint).toBe("finding-1");
  });

  it("rejects malformed artifacts before publisher adapters run", () => {
    expect(() =>
      parseReviewFindingsArtifactJson(
        JSON.stringify({
          protocolVersion: 2,
          generatedAt: "2026-05-30T12:00:00.000Z",
          findings: [],
        }),
      ),
    ).toThrow("review_findings_artifact_protocol_version_invalid");

    expect(() =>
      parseReviewFindingsArtifactJson(
        JSON.stringify({
          protocolVersion: 1,
          generatedAt: "2026-05-30T12:00:00.000Z",
          findings: [{ severity: "major" }],
        }),
      ),
    ).toThrow("review_findings_artifact_fingerprint_invalid");
  });
});
