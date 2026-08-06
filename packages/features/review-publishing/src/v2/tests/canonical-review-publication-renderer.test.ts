import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CanonicalReviewPublicationRenderPolicyVersion,
  ReviewPublicationLifecycleSemantic,
  ReviewPublicationProjectionCoverage,
  ReviewPublicationSummarySemantic,
  currentReviewProjectionPolicyVersion,
  hiddenMarkerReviewProjectionPolicyVersion,
  legacyPartialReviewPublicationSummary,
  partialReviewPublicationSummary,
  resolveReviewPublicationRenderPolicyVersion,
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

  it("preserves v4 partial canonical bytes after introducing v5", () => {
    const rendered = renderCanonicalReviewPublication(
      {
        coverage: ReviewPublicationProjectionCoverage.Partial,
        renderPolicyVersion: resolveReviewPublicationRenderPolicyVersion(
          hiddenMarkerReviewProjectionPolicyVersion,
        ),
        targetCommitId: "a".repeat(40),
        source: source(),
      },
      primitives,
    );

    expect(rendered.summary.body).toBe(
      `${partialReviewPublicationSummary}\n\n<!-- summary -->`,
    );
  });

  it("preserves preliminary findings in the current partial summary", () => {
    const rendered = renderCanonicalReviewPublication(
      {
        coverage: ReviewPublicationProjectionCoverage.Partial,
        renderPolicyVersion: resolveReviewPublicationRenderPolicyVersion(
          currentReviewProjectionPolicyVersion,
        ),
        targetCommitId: "a".repeat(40),
        source: source({
          summaryBody:
            "Review complete\n\n## Review incomplete - 99 preliminary findings preserved ⚠️\n\nAll-clear. No issues found.\n\n- P1: authorization is inverted",
          occurrenceCounts: {
            new: 1,
            reconfirmed: 1,
            changed: 1,
            carried_unverified: 2,
            resolved: 3,
            uncertain: 4,
            suppressed_by_human: 5,
          },
        }),
      },
      primitives,
    );

    expect(rendered.summary.body).toContain(
      "## Review incomplete - 3 preliminary findings preserved ⚠️",
    );
    expect(rendered.summary.body).toContain("### Preliminary findings");
    expect(rendered.summary.body).toContain("- P1: authorization is inverted");
    expect(rendered.summary.body).toContain("not an all-clear");
    expect(rendered.summary.body).not.toContain("All-clear.");
    expect(rendered.summary.body).not.toMatch(/^Review complete/im);
    expect(rendered.summary.body).not.toMatch(/^##\s+Review complete/im);
    expect(
      rendered.summary.body.match(/^## Review incomplete\b/gm),
    ).toHaveLength(1);
    expect(rendered.summary.body).not.toContain("99 preliminary");
    expect(rendered).toMatchObject({
      managedCheck: null,
      inlineReviews: [],
      lifecycle: [],
    });
  });

  it("states when partial coverage preserved no findings", () => {
    const rendered = renderCanonicalReviewPublication(
      {
        coverage: ReviewPublicationProjectionCoverage.Partial,
        renderPolicyVersion: resolveReviewPublicationRenderPolicyVersion(
          currentReviewProjectionPolicyVersion,
        ),
        targetCommitId: "a".repeat(40),
        source: source({
          summaryBody:
            "### Coverage not completed\n\n- dependency context unavailable",
          occurrenceCounts: {
            new: 0,
            reconfirmed: 0,
            changed: 0,
            carried_unverified: 2,
            resolved: 1,
            uncertain: 1,
            suppressed_by_human: 0,
          },
        }),
      },
      primitives,
    );

    expect(rendered.summary.body).toContain(
      "## Review incomplete - 0 preliminary findings preserved ⚠️",
    );
    expect(rendered.summary.body).toContain(
      "No preliminary findings were preserved.",
    );
    expect(rendered.summary.body).not.toContain("### Preliminary findings");
    expect(rendered.summary.body).toContain("### Partial review details");
    expect(rendered.summary.body).toContain("dependency context unavailable");
  });

  it("rejects partial finding totals that exceed safe integer precision", () => {
    expect(() =>
      renderCanonicalReviewPublication(
        {
          coverage: ReviewPublicationProjectionCoverage.Partial,
          renderPolicyVersion: resolveReviewPublicationRenderPolicyVersion(
            currentReviewProjectionPolicyVersion,
          ),
          targetCommitId: "a".repeat(40),
          source: source({
            occurrenceCounts: {
              new: Number.MAX_SAFE_INTEGER,
              reconfirmed: 1,
              changed: 0,
              carried_unverified: 0,
              resolved: 0,
              uncertain: 0,
              suppressed_by_human: 0,
            },
          }),
        },
        primitives,
      ),
    ).toThrow("publication_occurrence_counts_invalid");
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

  it("hides raw ReviewRouter markers in current GitHub-visible bodies", () => {
    const rendered = renderCanonicalReviewPublication(
      {
        coverage: ReviewPublicationProjectionCoverage.Completed,
        renderPolicyVersion: resolveReviewPublicationRenderPolicyVersion(
          currentReviewProjectionPolicyVersion,
        ),
        targetCommitId: "a".repeat(40),
        source: source({
          summaryMarker: "reviewrouter:summary:v2:abc123",
          checkMarker: "reviewrouter:check:v2:abc123",
          inlineMarker: "reviewrouter:inline:v2:abc123",
          findingMarker: "reviewrouter:finding:v2:abc123",
        }),
      },
      primitives,
    );

    expect(rendered.summary.body).toBe(
      "One finding\n\n<!-- reviewrouter:summary:v2:abc123 -->",
    );
    expect(rendered.managedCheck?.summary).toBe(
      "One finding\n\n<!-- reviewrouter:check:v2:abc123 -->",
    );
    expect(rendered.inlineReviews[0]?.create.reviewBody).toBe(
      "<!-- reviewrouter:inline:v2:abc123 -->",
    );
    expect(rendered.inlineReviews[0]?.submit.reviewBody).toBe(
      "<!-- reviewrouter:inline:v2:abc123:submitted -->",
    );
    expect(rendered.inlineReviews[0]?.create.comments[0]?.body).toBe(
      "Finding\n\n<!-- reviewrouter:finding:v2:abc123 -->",
    );
  });

  it("normalizes pre-existing raw markers in current GitHub-visible bodies", () => {
    const rawSource = source({
      summaryMarker: "reviewrouter:summary:v2:abc123",
      checkMarker: "reviewrouter:check:v2:abc123",
      inlineMarker: "reviewrouter:inline:v2:abc123",
      findingMarker: "reviewrouter:finding:v2:abc123",
    });
    const rendered = renderCanonicalReviewPublication(
      {
        coverage: ReviewPublicationProjectionCoverage.Completed,
        renderPolicyVersion: resolveReviewPublicationRenderPolicyVersion(
          currentReviewProjectionPolicyVersion,
        ),
        targetCommitId: "a".repeat(40),
        source: {
          ...rawSource,
          summary: {
            ...rawSource.summary,
            body: "One finding\n\nreviewrouter:summary:v2:abc123",
          },
          check: {
            ...rawSource.check,
            summary: "One finding\n\nreviewrouter:check:v2:abc123",
          },
          inlineReviewChunks: [
            {
              ...rawSource.inlineReviewChunks[0]!,
              comments: [
                {
                  ...rawSource.inlineReviewChunks[0]!.comments[0]!,
                  body: "Finding\n\nreviewrouter:finding:v2:abc123",
                },
              ],
            },
          ],
        },
      },
      primitives,
    );

    expect(rendered.summary.body).toBe(
      "One finding\n\n<!-- reviewrouter:summary:v2:abc123 -->",
    );
    expect(rendered.managedCheck?.summary).toBe(
      "One finding\n\n<!-- reviewrouter:check:v2:abc123 -->",
    );
    expect(rendered.inlineReviews[0]?.create.comments[0]?.body).toBe(
      "Finding\n\n<!-- reviewrouter:finding:v2:abc123 -->",
    );
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

function source(
  overrides: {
    readonly summaryMarker?: string;
    readonly checkMarker?: string;
    readonly inlineMarker?: string;
    readonly findingMarker?: string;
    readonly summaryBody?: string;
    readonly occurrenceCounts?: ReviewPublicationRenderingSource["summary"]["occurrenceCounts"];
  } = {},
): ReviewPublicationRenderingSource {
  return {
    summary: {
      marker: overrides.summaryMarker ?? "<!-- summary -->",
      body: overrides.summaryBody ?? "One finding",
      allClear: false,
      occurrenceCounts: overrides.occurrenceCounts ?? {
        new: 1,
        reconfirmed: 0,
        changed: 0,
        carried_unverified: 0,
        resolved: 0,
        uncertain: 0,
        suppressed_by_human: 0,
      },
    },
    check: {
      marker: overrides.checkMarker ?? "<!-- check -->",
      name: "ReviewRouter",
      title: "Review complete",
      summary: "One finding",
      conclusion: "failure",
    },
    inlineReviewChunks: [
      {
        chunkIndex: 0,
        marker: overrides.inlineMarker ?? "<!-- inline -->",
        comments: [
          {
            marker: overrides.findingMarker ?? "<!-- finding -->",
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
