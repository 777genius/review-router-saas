import { describe, expect, it, vi } from "vitest";
import { createReviewPublicationPlan } from "../../domain/review-publication";
import { GitLabReviewPublisher } from "./gitlab-review-publisher";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const startSha = "c".repeat(40);

function createPlan() {
  return createReviewPublicationPlan({
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
      {
        fingerprint: "added-line",
        severity: "major",
        title: "Added line finding",
        body: "Added body",
        location: { filePath: "src/app.ts", newLine: 3 },
      },
      {
        fingerprint: "removed-line",
        severity: "critical",
        title: "Removed line finding",
        body: "Removed body",
        location: { filePath: "src/app.ts", oldLine: 2 },
      },
      {
        fingerprint: "context-line",
        severity: "minor",
        title: "Context line finding",
        body: "Context body",
        location: { filePath: "src/app.ts", oldLine: 3, newLine: 4 },
      },
    ],
  });
}

describe("GitLabReviewPublisher", () => {
  it("posts summary and inline discussions for added, removed, and context lines", async () => {
    const postedBodies: URLSearchParams[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/projects/123/merge_requests/7")) {
        return jsonResponse({
          iid: 7,
          project_id: 123,
          source_project_id: 123,
          target_project_id: 123,
          state: "opened",
          sha: headSha,
        });
      }
      if (href.endsWith("/projects/123/merge_requests/7/versions")) {
        return jsonResponse([
          {
            head_commit_sha: headSha,
            base_commit_sha: baseSha,
            start_commit_sha: startSha,
            state: "collected",
          },
        ]);
      }
      if (href.endsWith("/projects/123/merge_requests/7/diffs?per_page=100")) {
        return jsonResponse([
          {
            old_path: "src/app.ts",
            new_path: "src/app.ts",
            diff: [
              "@@ -1,4 +1,5 @@",
              " line1",
              "-line2",
              "+line2 changed",
              "+line3 added",
              " line4",
              " line5",
            ].join("\n"),
          },
        ]);
      }
      if (
        href.endsWith(
          "/projects/123/merge_requests/7/discussions?per_page=100&page=1",
        )
      ) {
        return jsonResponse([]);
      }
      if (href.endsWith("/projects/123/merge_requests/7/discussions")) {
        postedBodies.push(init?.body as URLSearchParams);
        return jsonResponse({
          id: `discussion-${postedBodies.length}`,
          notes: [{ id: postedBodies.length }],
        });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    const publisher = new GitLabReviewPublisher({
      token: "glpat-token",
      apiBaseUrl: "https://gitlab.test/api/v4",
      fetchImpl,
    });

    const result = await publisher.publishReview(createPlan());

    expect(result.inlineCommentCount).toBe(3);
    expect(result.summaryCommentCount).toBe(1);
    expect(result.skippedInlineFindings).toEqual([]);
    expect(postedBodies).toHaveLength(4);
    expect(postedBodies[1]?.get("position[new_line]")).toBe("3");
    expect(postedBodies[1]?.get("position[old_line]")).toBeNull();
    expect(postedBodies[2]?.get("position[old_line]")).toBe("2");
    expect(postedBodies[2]?.get("position[new_line]")).toBeNull();
    expect(postedBodies[3]?.get("position[old_line]")).toBe("3");
    expect(postedBodies[3]?.get("position[new_line]")).toBe("4");
    expect(postedBodies[1]?.get("body")).toContain("finding=added-line");
  });

  it("maps new-line-only findings on unchanged context lines to GitLab context positions", async () => {
    const postedBodies: URLSearchParams[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/projects/123/merge_requests/7")) {
        return jsonResponse({
          iid: 7,
          project_id: 123,
          source_project_id: 123,
          target_project_id: 123,
          state: "opened",
          sha: headSha,
        });
      }
      if (href.endsWith("/projects/123/merge_requests/7/versions")) {
        return jsonResponse([
          {
            head_commit_sha: headSha,
            base_commit_sha: baseSha,
            start_commit_sha: startSha,
            state: "collected",
          },
        ]);
      }
      if (href.endsWith("/projects/123/merge_requests/7/diffs?per_page=100")) {
        return jsonResponse([
          {
            old_path: "src/discount.ts",
            new_path: "src/discount.ts",
            diff: [
              "@@ -2,5 +2,6 @@ export function applyDiscount(total: number, percent: number): number {",
              "   if (percent < 0 || percent > 100) {",
              '     throw new Error("invalid_percent");',
              "   }",
              "-  return total - (total * percent) / 100;",
              "+  // Intentional smoke bug: discount increases the total.",
              "+  return total + (total * percent) / 100;",
              " }",
            ].join("\n"),
          },
        ]);
      }
      if (
        href.endsWith(
          "/projects/123/merge_requests/7/discussions?per_page=100&page=1",
        )
      ) {
        return jsonResponse([]);
      }
      if (href.endsWith("/projects/123/merge_requests/7/discussions")) {
        postedBodies.push(init?.body as URLSearchParams);
        return jsonResponse({
          id: `discussion-${postedBodies.length}`,
          notes: [{ id: postedBodies.length }],
        });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    const publisher = new GitLabReviewPublisher({
      token: "glpat-token",
      apiBaseUrl: "https://gitlab.test/api/v4",
      fetchImpl,
    });

    const result = await publisher.publishReview(
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
          {
            fingerprint: "context-new-line-only",
            severity: "major",
            title: "Context line finding",
            body: "Context body",
            location: { filePath: "src/discount.ts", newLine: 7 },
          },
        ],
      }),
    );

    expect(result.inlineCommentCount).toBe(1);
    expect(result.skippedInlineFindings).toEqual([]);
    expect(postedBodies).toHaveLength(2);
    expect(postedBodies[1]?.get("position[old_line]")).toBe("6");
    expect(postedBodies[1]?.get("position[new_line]")).toBe("7");
  });

  it("updates existing ReviewRouter notes instead of duplicating them", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      methods.push(`${init?.method ?? "GET"} ${href}`);
      if (href.endsWith("/projects/123/merge_requests/7")) {
        return jsonResponse({
          iid: 7,
          project_id: 123,
          source_project_id: 123,
          target_project_id: 123,
          state: "opened",
          sha: headSha,
        });
      }
      if (href.endsWith("/projects/123/merge_requests/7/versions")) {
        return jsonResponse([
          {
            head_commit_sha: headSha,
            base_commit_sha: baseSha,
            start_commit_sha: startSha,
          },
        ]);
      }
      if (href.endsWith("/projects/123/merge_requests/7/diffs?per_page=100")) {
        return jsonResponse([]);
      }
      if (
        href.endsWith(
          "/projects/123/merge_requests/7/discussions?per_page=100&page=1",
        )
      ) {
        return jsonResponse([
          {
            id: "summary-discussion",
            notes: [
              {
                id: 11,
                body: "<!-- reviewrouter:review:v1 summary -->\nOld",
              },
            ],
          },
        ]);
      }
      if (href.includes("/discussions/summary-discussion/notes/11")) {
        return jsonResponse({ id: 11 });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    const publisher = new GitLabReviewPublisher({
      token: "glpat-token",
      apiBaseUrl: "https://gitlab.test/api/v4",
      fetchImpl,
    });
    const result = await publisher.publishReview(
      createReviewPublicationPlan({
        ...createPlan(),
        mode: "summary-only",
      }),
    );

    expect(result.inlineCommentCount).toBe(0);
    expect(result.skippedInlineFindings).toHaveLength(3);
    expect(methods).toContain(
      "PUT https://gitlab.test/api/v4/projects/123/merge_requests/7/discussions/summary-discussion/notes/11",
    );
    expect(
      methods.some(
        (method) =>
          method ===
          "POST https://gitlab.test/api/v4/projects/123/merge_requests/7/discussions",
      ),
    ).toBe(false);
  });

  it("does not reuse inline notes from a stale MR head", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      methods.push(`${init?.method ?? "GET"} ${href}`);
      if (href.endsWith("/projects/123/merge_requests/7")) {
        return jsonResponse({
          iid: 7,
          project_id: 123,
          source_project_id: 123,
          target_project_id: 123,
          state: "opened",
          sha: headSha,
        });
      }
      if (href.endsWith("/projects/123/merge_requests/7/versions")) {
        return jsonResponse([
          {
            head_commit_sha: headSha,
            base_commit_sha: baseSha,
            start_commit_sha: startSha,
          },
        ]);
      }
      if (href.endsWith("/projects/123/merge_requests/7/diffs?per_page=100")) {
        return jsonResponse([
          {
            old_path: "src/new.ts",
            new_path: "src/new.ts",
            diff: ["@@ -0,0 +1,2 @@", "+first", "+second"].join("\n"),
          },
        ]);
      }
      if (
        href.endsWith(
          "/projects/123/merge_requests/7/discussions?per_page=100&page=1",
        )
      ) {
        return jsonResponse([
          {
            id: "old-inline",
            notes: [
              {
                id: 44,
                body: "<!-- reviewrouter:review:v1 finding=new-file -->\nOld",
                position: { head_sha: "d".repeat(40) },
              },
            ],
          },
        ]);
      }
      if (href.endsWith("/projects/123/merge_requests/7/discussions")) {
        return jsonResponse({
          id: "new-inline",
          notes: [{ id: 45 }],
        });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    const publisher = new GitLabReviewPublisher({
      token: "glpat-token",
      apiBaseUrl: "https://gitlab.test/api/v4",
      fetchImpl,
    });
    const result = await publisher.publishReview(
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
          {
            fingerprint: "new-file",
            severity: "major",
            title: "New file finding",
            body: "New file body",
            location: { filePath: "src/new.ts", newLine: 2 },
          },
        ],
      }),
    );

    expect(result.inlineCommentCount).toBe(1);
    expect(methods).toContain(
      "POST https://gitlab.test/api/v4/projects/123/merge_requests/7/discussions",
    );
    expect(
      methods.some((method) =>
        method.includes("/discussions/old-inline/notes/44"),
      ),
    ).toBe(false);
  });

  it("reuses same-position inline notes when model wording changes the fingerprint", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      methods.push(`${init?.method ?? "GET"} ${href}`);
      if (href.endsWith("/projects/123/merge_requests/7")) {
        return jsonResponse({
          iid: 7,
          project_id: 123,
          source_project_id: 123,
          target_project_id: 123,
          state: "opened",
          sha: headSha,
        });
      }
      if (href.endsWith("/projects/123/merge_requests/7/versions")) {
        return jsonResponse([
          {
            head_commit_sha: headSha,
            base_commit_sha: baseSha,
            start_commit_sha: startSha,
          },
        ]);
      }
      if (href.endsWith("/projects/123/merge_requests/7/diffs?per_page=100")) {
        return jsonResponse([
          {
            old_path: "src/new.ts",
            new_path: "src/new.ts",
            diff: ["@@ -0,0 +1,2 @@", "+first", "+second"].join("\n"),
          },
        ]);
      }
      if (
        href.endsWith(
          "/projects/123/merge_requests/7/discussions?per_page=100&page=1",
        )
      ) {
        return jsonResponse([
          {
            id: "summary-discussion",
            notes: [
              {
                id: 11,
                body: "<!-- reviewrouter:review:v1 summary -->\nOld",
              },
            ],
          },
          {
            id: "old-inline",
            notes: [
              {
                id: 44,
                body: "<!-- reviewrouter:review:v1 finding=old-fingerprint -->\nOld",
                position: {
                  head_sha: headSha,
                  old_path: "src/new.ts",
                  new_path: "src/new.ts",
                  new_line: 2,
                },
              },
            ],
          },
        ]);
      }
      if (href.includes("/discussions/summary-discussion/notes/11")) {
        return jsonResponse({ id: 11 });
      }
      if (href.includes("/discussions/old-inline/notes/44")) {
        return jsonResponse({ id: 44 });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    const publisher = new GitLabReviewPublisher({
      token: "glpat-token",
      apiBaseUrl: "https://gitlab.test/api/v4",
      fetchImpl,
    });
    const result = await publisher.publishReview(
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
          {
            fingerprint: "new-fingerprint",
            severity: "major",
            title: "New wording for the same line",
            body: "New body",
            location: { filePath: "src/new.ts", newLine: 2 },
          },
        ],
      }),
    );

    expect(result.inlineCommentCount).toBe(1);
    expect(methods).toContain(
      "PUT https://gitlab.test/api/v4/projects/123/merge_requests/7/discussions/old-inline/notes/44",
    );
    expect(
      methods.some(
        (method) =>
          method ===
          "POST https://gitlab.test/api/v4/projects/123/merge_requests/7/discussions",
      ),
    ).toBe(false);
  });

  it("reuses nearby same-title inline notes when model line numbers drift on retry", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      methods.push(`${init?.method ?? "GET"} ${href}`);
      if (href.endsWith("/projects/123/merge_requests/7")) {
        return jsonResponse({
          iid: 7,
          project_id: 123,
          source_project_id: 123,
          target_project_id: 123,
          state: "opened",
          sha: headSha,
        });
      }
      if (href.endsWith("/projects/123/merge_requests/7/versions")) {
        return jsonResponse([
          {
            head_commit_sha: headSha,
            base_commit_sha: baseSha,
            start_commit_sha: startSha,
          },
        ]);
      }
      if (href.endsWith("/projects/123/merge_requests/7/diffs?per_page=100")) {
        return jsonResponse([
          {
            old_path: "src/discount.ts",
            new_path: "src/discount.ts",
            diff: [
              "@@ -2,5 +2,6 @@ export function applyDiscount(total: number, percent: number): number {",
              "   if (percent < 0 || percent > 100) {",
              '     throw new Error("invalid_percent");',
              "   }",
              "-  return total - (total * percent) / 100;",
              "+  // Intentional smoke bug: discount increases the total.",
              "+  return total + (total * percent) / 100;",
              " }",
            ].join("\n"),
          },
        ]);
      }
      if (
        href.endsWith(
          "/projects/123/merge_requests/7/discussions?per_page=100&page=1",
        )
      ) {
        return jsonResponse([
          {
            id: "summary-discussion",
            notes: [
              {
                id: 11,
                body: "<!-- reviewrouter:review:v1 summary -->\nOld",
              },
            ],
          },
          {
            id: "old-inline",
            notes: [
              {
                id: 44,
                body: "<!-- reviewrouter:review:v1 finding=old-line-fingerprint -->\n**[major] Discount application increases the order total**\n\nOld body",
                position: {
                  head_sha: headSha,
                  old_path: "src/discount.ts",
                  new_path: "src/discount.ts",
                  old_line: 6,
                  new_line: 7,
                },
              },
            ],
          },
        ]);
      }
      if (href.includes("/discussions/summary-discussion/notes/11")) {
        return jsonResponse({ id: 11 });
      }
      if (href.includes("/discussions/old-inline/notes/44")) {
        return jsonResponse({ id: 44 });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    const publisher = new GitLabReviewPublisher({
      token: "glpat-token",
      apiBaseUrl: "https://gitlab.test/api/v4",
      fetchImpl,
    });
    const result = await publisher.publishReview(
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
          {
            fingerprint: "new-line-fingerprint",
            severity: "major",
            title: "Discount application increases the order total",
            body: "New body",
            location: { filePath: "src/discount.ts", newLine: 6 },
          },
        ],
      }),
    );

    expect(result.inlineCommentCount).toBe(1);
    expect(methods).toContain(
      "PUT https://gitlab.test/api/v4/projects/123/merge_requests/7/discussions/old-inline/notes/44",
    );
    expect(
      methods.some(
        (method) =>
          method ===
          "POST https://gitlab.test/api/v4/projects/123/merge_requests/7/discussions",
      ),
    ).toBe(false);
  });

  it("rejects fork merge requests before posting comments", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith("/projects/123/merge_requests/7")) {
        return jsonResponse({
          iid: 7,
          project_id: 123,
          source_project_id: 456,
          target_project_id: 123,
          state: "opened",
          sha: headSha,
        });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    const publisher = new GitLabReviewPublisher({
      token: "glpat-token",
      apiBaseUrl: "https://gitlab.test/api/v4",
      fetchImpl,
    });

    await expect(publisher.publishReview(createPlan())).rejects.toThrow(
      "gitlab_merge_request_fork_unsupported",
    );
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
