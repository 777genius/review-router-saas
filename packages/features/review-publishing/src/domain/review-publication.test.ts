import { describe, expect, it } from "vitest";
import {
  createReviewPublicationPlan,
  reviewFindingInlineSkipReason,
  shouldPublishFindingInline,
  type ReviewFinding,
} from "./review-publication";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const startSha = "c".repeat(40);

function finding(input: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    fingerprint: "fingerprint-1",
    severity: "major",
    title: "Finding title",
    body: "Finding body",
    location: { filePath: "src/app.ts", newLine: 10 },
    ...input,
  };
}

describe("review publication", () => {
  it("creates provider-neutral publication plans", () => {
    const plan = createReviewPublicationPlan({
      target: {
        provider: "gitlab",
        repositoryExternalId: " 123 ",
        repositoryFullName: "group/project",
        changeRequestExternalId: " 7 ",
        headSha: headSha.toUpperCase(),
        baseSha,
        startSha,
      },
      marker: "reviewrouter:review:v1",
      findings: [finding()],
    });

    expect(plan.target.provider).toBe("gitlab");
    expect(plan.target.repositoryExternalId).toBe("123");
    expect(plan.target.changeRequestExternalId).toBe("7");
    expect(plan.target.headSha).toBe(headSha);
    expect(plan.maxInlineComments).toBe(20);
    expect(plan.findings[0]?.title).toBe("Finding title");
  });

  it("keeps low-risk findings out of inline comments by default", () => {
    const plan = createReviewPublicationPlan({
      target: {
        provider: "github",
        repositoryExternalId: "123",
        repositoryFullName: "owner/repo",
        changeRequestExternalId: "8",
        headSha,
      },
      marker: "reviewrouter:review:v1",
      findings: [finding({ severity: "info" })],
    });

    expect(
      shouldPublishFindingInline({
        finding: plan.findings[0]!,
        plan,
        inlineIndex: 0,
      }),
    ).toBe(false);
    expect(
      reviewFindingInlineSkipReason({
        finding: plan.findings[0]!,
        plan,
        inlineIndex: 0,
      }),
    ).toBe("low_severity");
  });

  it("enforces summary-only and inline limits before provider adapters run", () => {
    const plan = createReviewPublicationPlan({
      target: {
        provider: "gitlab",
        repositoryExternalId: "123",
        repositoryFullName: "group/project",
        changeRequestExternalId: "7",
        headSha,
        baseSha,
        startSha,
      },
      marker: "reviewrouter:review:v1",
      maxInlineComments: 1,
      findings: [finding(), finding({ fingerprint: "fingerprint-2" })],
    });

    expect(
      shouldPublishFindingInline({
        finding: plan.findings[0]!,
        plan,
        inlineIndex: 0,
      }),
    ).toBe(true);
    expect(
      shouldPublishFindingInline({
        finding: plan.findings[1]!,
        plan,
        inlineIndex: 1,
      }),
    ).toBe(false);
    expect(
      reviewFindingInlineSkipReason({
        finding: plan.findings[1]!,
        plan,
        inlineIndex: 1,
      }),
    ).toBe("inline_limit_reached");
  });

  it("does not inline file-only locations", () => {
    const plan = createReviewPublicationPlan({
      target: {
        provider: "gitlab",
        repositoryExternalId: "123",
        repositoryFullName: "group/project",
        changeRequestExternalId: "7",
        headSha,
        baseSha,
        startSha,
      },
      marker: "reviewrouter:review:v1",
      findings: [finding({ location: { filePath: "src/app.ts" } })],
    });

    expect(
      shouldPublishFindingInline({
        finding: plan.findings[0]!,
        plan,
        inlineIndex: 0,
      }),
    ).toBe(false);
    expect(
      reviewFindingInlineSkipReason({
        finding: plan.findings[0]!,
        plan,
        inlineIndex: 0,
      }),
    ).toBe("missing_location");
  });

  it("caps inline comments and rejects invalid limits", () => {
    const plan = createReviewPublicationPlan({
      target: {
        provider: "gitlab",
        repositoryExternalId: "123",
        repositoryFullName: "group/project",
        changeRequestExternalId: "7",
        headSha,
        baseSha,
        startSha,
      },
      marker: "reviewrouter:review:v1",
      maxInlineComments: 500,
      findings: [finding()],
    });

    expect(plan.maxInlineComments).toBe(50);
    expect(() =>
      createReviewPublicationPlan({
        target: {
          provider: "gitlab",
          repositoryExternalId: "123",
          repositoryFullName: "group/project",
          changeRequestExternalId: "7",
          headSha,
          baseSha,
          startSha,
        },
        marker: "reviewrouter:review:v1",
        maxInlineComments: Number.NaN,
        findings: [finding()],
      }),
    ).toThrow("review_publication_max_inline_comments_invalid");
  });

  it("rejects unsafe file paths before provider adapters run", () => {
    expect(() =>
      createReviewPublicationPlan({
        target: {
          provider: "gitlab",
          repositoryExternalId: "123",
          repositoryFullName: "group/project",
          changeRequestExternalId: "7",
          headSha,
          baseSha,
          startSha,
        },
        marker: "reviewrouter:review:v1",
        findings: [
          finding({ location: { filePath: "../src/app.ts", newLine: 10 } }),
        ],
      }),
    ).toThrow("review_finding_location_file_path_required");
  });

  it("does not inline GitLab findings until complete diff refs are present", () => {
    const withoutDiffRefs = createReviewPublicationPlan({
      target: {
        provider: "gitlab",
        repositoryExternalId: "123",
        repositoryFullName: "group/project",
        changeRequestExternalId: "7",
        headSha,
      },
      marker: "reviewrouter:review:v1",
      findings: [finding()],
    });
    const withDiffRefs = createReviewPublicationPlan({
      target: {
        provider: "gitlab",
        repositoryExternalId: "123",
        repositoryFullName: "group/project",
        changeRequestExternalId: "7",
        headSha,
        baseSha,
        startSha,
      },
      marker: "reviewrouter:review:v1",
      findings: [finding()],
    });

    expect(
      shouldPublishFindingInline({
        finding: withoutDiffRefs.findings[0]!,
        plan: withoutDiffRefs,
        inlineIndex: 0,
      }),
    ).toBe(false);
    expect(
      reviewFindingInlineSkipReason({
        finding: withoutDiffRefs.findings[0]!,
        plan: withoutDiffRefs,
        inlineIndex: 0,
      }),
    ).toBe("provider_position_unavailable");
    expect(
      shouldPublishFindingInline({
        finding: withDiffRefs.findings[0]!,
        plan: withDiffRefs,
        inlineIndex: 0,
      }),
    ).toBe(true);
  });

  it("rejects invalid change request ids and oversized text fields", () => {
    expect(() =>
      createReviewPublicationPlan({
        target: {
          provider: "gitlab",
          repositoryExternalId: "123",
          repositoryFullName: "group/project",
          changeRequestExternalId: "gid://gitlab/MergeRequest/7",
          headSha,
        },
        marker: "reviewrouter:review:v1",
        findings: [finding()],
      }),
    ).toThrow("review_publication_change_request_external_id_invalid");
    expect(() =>
      createReviewPublicationPlan({
        target: {
          provider: "github",
          repositoryExternalId: "123",
          repositoryFullName: "owner/repo",
          changeRequestExternalId: "7",
          headSha,
        },
        marker: "x".repeat(201),
        findings: [finding()],
      }),
    ).toThrow("review_publication_marker_too_large");
    expect(() =>
      createReviewPublicationPlan({
        target: {
          provider: "github",
          repositoryExternalId: "123",
          repositoryFullName: "owner/repo",
          changeRequestExternalId: "7",
          headSha,
        },
        marker: "reviewrouter:review:v1",
        findings: [finding({ body: "x".repeat(8_001) })],
      }),
    ).toThrow("review_finding_body_too_large");
  });

  it("rejects marker and fingerprint values that can break comment markers", () => {
    expect(() =>
      createReviewPublicationPlan({
        target: {
          provider: "gitlab",
          repositoryExternalId: "123",
          repositoryFullName: "group/project",
          changeRequestExternalId: "7",
          headSha,
          baseSha,
          startSha,
        },
        marker: "reviewrouter:review:v1 --> injected",
        findings: [finding()],
      }),
    ).toThrow("review_publication_marker_invalid");

    expect(() =>
      createReviewPublicationPlan({
        target: {
          provider: "gitlab",
          repositoryExternalId: "123",
          repositoryFullName: "group/project",
          changeRequestExternalId: "7",
          headSha,
          baseSha,
          startSha,
        },
        marker: "reviewrouter:review:v1",
        findings: [finding({ fingerprint: "finding-1\nfinding-2" })],
      }),
    ).toThrow("review_finding_fingerprint_invalid");
  });
});
