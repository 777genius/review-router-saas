import { describe, expect, it } from "vitest";
import { createReviewFindingsArtifactFromModelOutput } from "./review-model-output-artifact";

describe("review model output artifact", () => {
  it("converts bounded model JSON into a CI-local findings artifact", () => {
    const artifact = createReviewFindingsArtifactFromModelOutput({
      generatedAt: new Date("2026-05-30T12:00:00.000Z"),
      modelOutput: {
        protocolVersion: 1,
        summaryMarkdown: " Review completed. ",
        findings: [
          {
            severity: "major",
            title: "Bug title",
            body: "Bug body",
            path: "src/app.ts",
            startLine: 12,
            endLine: 12,
          },
        ],
      },
    });

    expect(artifact).toMatchObject({
      protocolVersion: 1,
      generatedAt: "2026-05-30T12:00:00.000Z",
      summaryMarkdown: "Review completed.",
      findings: [
        {
          severity: "major",
          title: "Bug title",
          body: "Bug body",
          location: { filePath: "src/app.ts", newLine: 12 },
        },
      ],
    });
    expect(artifact.findings[0]?.fingerprint).toMatch(/^rr-[a-f0-9]{40}$/);
  });

  it("rejects malformed or oversized model output before artifact writing", () => {
    expect(() =>
      createReviewFindingsArtifactFromModelOutput({
        generatedAt: new Date("2026-05-30T12:00:00.000Z"),
        modelOutput: {
          protocolVersion: 1,
          summaryMarkdown: "ok",
          findings: [{ severity: "major", title: "Missing body" }],
        },
      }),
    ).toThrow("review_model_output_body_invalid");

    expect(() =>
      createReviewFindingsArtifactFromModelOutput({
        generatedAt: new Date("2026-05-30T12:00:00.000Z"),
        modelOutput: {
          protocolVersion: 1,
          summaryMarkdown: "ok",
          findings: [
            {
              severity: "major",
              title: "Bad line",
              body: "body",
              path: "src/app.ts",
              startLine: 0,
            },
          ],
        },
      }),
    ).toThrow("review_model_output_startLine_invalid");
  });
});
