import { describe, expect, it, vi } from "vitest";
import { createReviewPublicationPlan } from "../../domain/review-publication";
import { GitHubSummaryReviewPublisher } from "./github-summary-review-publisher";

const headSha = "a".repeat(40);

function createPlan() {
  return createReviewPublicationPlan({
    target: {
      provider: "github",
      repositoryExternalId: "123",
      repositoryFullName: "owner/repo",
      changeRequestExternalId: "7",
      headSha,
    },
    marker: "reviewrouter:review:v1",
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
}

describe("GitHubSummaryReviewPublisher", () => {
  it("creates a marker-based summary comment", async () => {
    const methods: string[] = [];
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      methods.push(`${init?.method ?? "GET"} ${href}`);
      if (typeof init?.body === "string") {
        bodies.push(init.body);
      }
      if (href.endsWith("/repos/owner/repo/issues/7/comments?per_page=100")) {
        return jsonResponse([]);
      }
      if (href.endsWith("/repos/owner/repo/issues/7/comments")) {
        return jsonResponse({ id: 1001 });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    const publisher = new GitHubSummaryReviewPublisher({
      token: "ghs-token",
      apiBaseUrl: "https://github.test",
      fetchImpl,
    });

    const result = await publisher.publishReview(createPlan());

    expect(result.externalIds).toEqual(["github:summary:1001"]);
    expect(result.inlineCommentCount).toBe(0);
    expect(result.skippedInlineFindings).toEqual([
      { fingerprint: "finding-1", reason: "provider_position_unavailable" },
    ]);
    expect(methods).toContain(
      "POST https://github.test/repos/owner/repo/issues/7/comments",
    );
    expect(bodies[0]).toContain("reviewrouter:review:v1 summary");
  });

  it("updates an existing marker-based summary comment", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      methods.push(`${init?.method ?? "GET"} ${href}`);
      if (href.endsWith("/repos/owner/repo/issues/7/comments?per_page=100")) {
        return jsonResponse([
          {
            id: 1001,
            body: "<!-- reviewrouter:review:v1 summary -->\nOld",
          },
        ]);
      }
      if (href.endsWith("/repos/owner/repo/issues/comments/1001")) {
        return jsonResponse({ id: 1001 });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    const publisher = new GitHubSummaryReviewPublisher({
      token: "ghs-token",
      apiBaseUrl: "https://github.test",
      fetchImpl,
    });

    await publisher.publishReview(createPlan());

    expect(methods).toContain(
      "PATCH https://github.test/repos/owner/repo/issues/comments/1001",
    );
    expect(
      methods.some(
        (method) =>
          method ===
          "POST https://github.test/repos/owner/repo/issues/7/comments",
      ),
    ).toBe(false);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
