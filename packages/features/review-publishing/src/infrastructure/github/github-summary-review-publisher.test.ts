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

  it("refreshes the GitHub token once after an auth failure and retries the request", async () => {
    const authorizations: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      authorizations.push(readAuthorization(init));
      if (href.endsWith("/repos/owner/repo/issues/7/comments?per_page=100")) {
        return authorizations.length === 1
          ? jsonResponse({ message: "Bad credentials" }, 401)
          : jsonResponse([]);
      }
      if (href.endsWith("/repos/owner/repo/issues/7/comments")) {
        return jsonResponse({ id: 1001 });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;
    const refreshToken = vi.fn(async () => "ghs-refreshed-token");

    const publisher = new GitHubSummaryReviewPublisher({
      token: "ghs-expired-token",
      tokenRefresh: { refreshToken },
      apiBaseUrl: "https://github.test",
      fetchImpl,
    });

    await publisher.publishReview(createPlan());

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(authorizations).toEqual([
      "Bearer ghs-expired-token",
      "Bearer ghs-refreshed-token",
      "Bearer ghs-refreshed-token",
    ]);
  });

  it("does not refresh the GitHub token for permission errors", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "Resource not accessible by integration" }, 403),
    ) as unknown as typeof fetch;
    const refreshToken = vi.fn(async () => "ghs-refreshed-token");

    const publisher = new GitHubSummaryReviewPublisher({
      token: "ghs-token",
      tokenRefresh: { refreshToken },
      apiBaseUrl: "https://github.test",
      fetchImpl,
    });

    await expect(publisher.publishReview(createPlan())).rejects.toThrow(
      "github_review_comment_lookup_failed:403",
    );
    expect(refreshToken).not.toHaveBeenCalled();
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function readAuthorization(init: RequestInit | undefined): string {
  const headers = init?.headers;
  if (!headers) return "";
  if (headers instanceof Headers) {
    return headers.get("authorization") ?? "";
  }
  if (Array.isArray(headers)) {
    return (
      headers.find(([key]) => key.toLowerCase() === "authorization")?.[1] ?? ""
    );
  }
  const record = headers as Record<string, string | undefined>;
  return String(record.authorization ?? record.Authorization ?? "");
}
