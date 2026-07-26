import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CanonicalReviewPublicationRenderPolicyVersion,
  ReviewPublicationLifecycleSemantic,
  ReviewPublicationProjectionCoverage,
  ReviewPublicationSummarySemantic,
  legacyPartialReviewPublicationSummary,
  partialReviewPublicationSummary,
  renderCanonicalReviewPublication,
  type ReviewPublicationRenderingSource,
} from "../index";

describe("canonical review publication renderer", () => {
  it("renders one conservative summary for partial coverage", () => {
    const rendered = renderCanonicalReviewPublication(
      {
        coverage: ReviewPublicationProjectionCoverage.Partial,
        renderPolicyVersion:
          CanonicalReviewPublicationRenderPolicyVersion.ClearPartialV2,
        targetCommitId: "a".repeat(40),
        source: source(),
      },
      primitives,
    );
    const expectedBody = `${partialReviewPublicationSummary}\n\n<!-- summary -->`;

    expect(rendered).toMatchObject({
      summary: {
        marker: "<!-- summary -->",
        body: expectedBody,
        markerHash: hash("<!-- summary -->"),
        bodyHash: hash(expectedBody),
        semantic: ReviewPublicationSummarySemantic.PartialCoverage,
      },
      managedCheck: null,
      inlineReviews: [],
      lifecycle: [],
    });
  });

  it("preserves legacy canonical bytes for an existing render policy", () => {
    const rendered = renderCanonicalReviewPublication(
      {
        coverage: ReviewPublicationProjectionCoverage.Partial,
        renderPolicyVersion:
          CanonicalReviewPublicationRenderPolicyVersion.LegacyV1,
        targetCommitId: "a".repeat(40),
        source: source(),
      },
      primitives,
    );

    expect(rendered.summary.body).toBe(
      `${legacyPartialReviewPublicationSummary}\n\n<!-- summary -->`,
    );
  });

  it("renders planning facts and execution payloads from the same canonical bytes", () => {
    const rendered = renderCanonicalReviewPublication(
      {
        coverage: ReviewPublicationProjectionCoverage.Completed,
        renderPolicyVersion:
          CanonicalReviewPublicationRenderPolicyVersion.ClearPartialV2,
        targetCommitId: "a".repeat(40),
        source: source(),
      },
      primitives,
    );
    const createBody =
      '{"body":"<!-- inline -->","comments":[{"body":"Finding\\n\\n<!-- finding -->","line":7,"path":"src/index.ts","startLine":null}],"commitId":"' +
      "a".repeat(40) +
      '"}';

    expect(rendered.summary.semantic).toBe(
      ReviewPublicationSummarySemantic.Findings,
    );
    expect(rendered.managedCheck?.body).toBe(
      '{"conclusion":"failure","name":"ReviewRouter","summary":"One finding\\n\\n<!-- check -->","title":"Review complete"}',
    );
    expect(rendered.inlineReviews[0]?.create).toMatchObject({
      body: createBody,
      bodyHash: hash(createBody),
      comments: [{ startLine: null }],
    });
    expect(rendered.lifecycle).toHaveLength(1);
    expect(rendered.lifecycle[0]).toMatchObject({
      chunkIndex: 0,
      semantic: ReviewPublicationLifecycleSemantic.Resolve,
      threadId: "THREAD_1",
      resolve: true,
    });
  });

  it("rejects an oversized canonical payload before planning or execution", () => {
    const oversized = source();
    expect(() =>
      renderCanonicalReviewPublication(
        {
          coverage: ReviewPublicationProjectionCoverage.Completed,
          renderPolicyVersion:
            CanonicalReviewPublicationRenderPolicyVersion.ClearPartialV2,
          targetCommitId: "a".repeat(40),
          source: {
            ...oversized,
            summary: { ...oversized.summary, marker: "x".repeat(4_097) },
          },
        },
        primitives,
      ),
    ).toThrow("publication_marker_invalid");
  });
});

function source(): ReviewPublicationRenderingSource {
  return {
    summary: {
      marker: "<!-- summary -->",
      body: "One finding",
      allClear: false,
    },
    check: {
      marker: "<!-- check -->",
      name: "ReviewRouter",
      title: "Review complete",
      summary: "One finding",
      conclusion: "failure",
    },
    inlineReviewChunks: [
      {
        chunkIndex: 0,
        marker: "<!-- inline -->",
        comments: [
          {
            marker: "<!-- finding -->",
            path: "src/index.ts",
            line: 7,
            body: "Finding",
          },
        ],
      },
    ],
    lifecycle: [
      {
        targetId: "finding-1",
        threadId: "THREAD_1",
        verdict: "resolved",
        mutationEligible: true,
      },
      {
        targetId: "finding-2",
        threadId: "THREAD_2",
        verdict: "uncertain",
        mutationEligible: true,
      },
    ],
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const primitives = {
  digestUtf8: hash,
  utf8ByteLength: (value: string) => Buffer.byteLength(value, "utf8"),
};
