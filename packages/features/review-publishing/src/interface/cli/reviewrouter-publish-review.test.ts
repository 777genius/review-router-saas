import { describe, expect, it, vi } from "vitest";
import { stringifyReviewFindingsArtifact } from "../../domain/review-findings-artifact";
import { runReviewPublisherCli } from "./reviewrouter-publish-review";

describe("reviewrouter-publish-review CLI", () => {
  it("refreshes the GitHub comment token once when publishing gets a 401", async () => {
    const authorizations: string[] = [];
    const refreshBodies: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === "https://api.reviewrouter.test/comment-token") {
        if (init?.body) refreshBodies.push(String(init.body));
        return jsonResponse({ token: "ghs-refreshed-token" });
      }
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
    let output = "";

    await runReviewPublisherCli({
      argv: ["--provider", "github"],
      env: {
        GITHUB_TOKEN: "ghs-expired-token",
        REVIEWROUTER_GITHUB_API_BASE_URL: "https://github.test",
        REVIEWROUTER_COMMENT_TOKEN_REFRESH_URL:
          "https://api.reviewrouter.test/comment-token",
        REVIEWROUTER_COMMENT_TOKEN_LEASE_ID: "lease_1",
        REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID:
          "codex-rotating:123456",
        REVIEWROUTER_REPOSITORY_EXTERNAL_ID: "123",
        REVIEWROUTER_REPOSITORY_FULL_NAME: "owner/repo",
        REVIEWROUTER_CHANGE_REQUEST_EXTERNAL_ID: "7",
        REVIEWROUTER_HEAD_SHA: "a".repeat(40),
      },
      fetchImpl,
      readFileImpl: async () =>
        stringifyReviewFindingsArtifact({
          protocolVersion: 1,
          generatedAt: "2026-05-30T12:00:00.000Z",
          findings: [],
        }),
      stdout: { write: (chunk) => (output += chunk) },
    });

    const result = JSON.parse(output) as {
      readonly summaryCommentCount: number;
      readonly externalIds: readonly string[];
    };
    expect(result.summaryCommentCount).toBe(1);
    expect(result.externalIds).toEqual(["github:summary:1001"]);
    expect(authorizations).toEqual([
      "Bearer ghs-expired-token",
      "Bearer ghs-refreshed-token",
      "Bearer ghs-refreshed-token",
    ]);
    expect(refreshBodies.map((body) => JSON.parse(body))).toEqual([
      {
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        authCleared: true,
      },
    ]);
  });

  it("bounds GitHub comment token refresh latency", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === "https://api.reviewrouter.test/comment-token") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }
      if (href.endsWith("/repos/owner/repo/issues/7/comments?per_page=100")) {
        return Promise.resolve(
          jsonResponse({ message: "Bad credentials" }, 401),
        );
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;
    let output = "";

    try {
      const publish = runReviewPublisherCli({
        argv: ["--provider", "github"],
        env: {
          GITHUB_TOKEN: "ghs-expired-token",
          REVIEWROUTER_GITHUB_API_BASE_URL: "https://github.test",
          REVIEWROUTER_COMMENT_TOKEN_REFRESH_URL:
            "https://api.reviewrouter.test/comment-token",
          REVIEWROUTER_COMMENT_TOKEN_LEASE_ID: "lease_1",
          REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID:
            "codex-rotating:123456",
          REVIEWROUTER_REPOSITORY_EXTERNAL_ID: "123",
          REVIEWROUTER_REPOSITORY_FULL_NAME: "owner/repo",
          REVIEWROUTER_CHANGE_REQUEST_EXTERNAL_ID: "7",
          REVIEWROUTER_HEAD_SHA: "a".repeat(40),
        },
        fetchImpl,
        readFileImpl: async () =>
          stringifyReviewFindingsArtifact({
            protocolVersion: 1,
            generatedAt: "2026-05-30T12:00:00.000Z",
            findings: [],
          }),
        stdout: { write: (chunk) => (output += chunk) },
      });

      const rejection = expect(publish).rejects.toThrow(
        "github_comment_token_refresh_timeout",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
      expect(output).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes a GitLab findings artifact and emits safe metadata only", async () => {
    const calls: { readonly method: string; readonly url: string }[] = [];
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      calls.push({ method: init?.method ?? "GET", url: href });
      if (init?.body) {
        bodies.push(String(init.body));
      }
      if (href.endsWith("/projects/123/merge_requests/5")) {
        return jsonResponse({
          iid: 5,
          project_id: 123,
          source_project_id: 123,
          target_project_id: 123,
          state: "opened",
          sha: "a".repeat(40),
        });
      }
      if (href.endsWith("/projects/123/merge_requests/5/versions")) {
        return jsonResponse([
          {
            head_commit_sha: "a".repeat(40),
            base_commit_sha: "b".repeat(40),
            start_commit_sha: "c".repeat(40),
          },
        ]);
      }
      if (
        href.endsWith(
          "/projects/123/merge_requests/5/discussions?per_page=100&page=1",
        )
      ) {
        return jsonResponse([]);
      }
      if (href.endsWith("/projects/123/merge_requests/5/diffs?per_page=100")) {
        return jsonResponse([
          {
            old_path: "src/app.ts",
            new_path: "src/app.ts",
            diff: "@@ -1,1 +1,2 @@\n const old = true;\n+const added = true;\n",
          },
        ]);
      }
      if (
        href.endsWith("/projects/123/merge_requests/5/discussions") &&
        init?.method === "POST"
      ) {
        return jsonResponse({
          id: `discussion-${bodies.length}`,
          notes: [{ id: bodies.length }],
        });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;
    let output = "";

    await runReviewPublisherCli({
      argv: ["--provider", "gitlab", "--max-inline-comments", "5"],
      env: {
        REVIEWROUTER_GITLAB_TOKEN: "glpat-test",
        CI_PROJECT_ID: "123",
        CI_PROJECT_PATH: "group/project",
        CI_MERGE_REQUEST_IID: "5",
        CI_COMMIT_SHA: "a".repeat(40),
      },
      fetchImpl,
      readFileImpl: async () =>
        stringifyReviewFindingsArtifact({
          protocolVersion: 1,
          generatedAt: "2026-05-30T12:00:00.000Z",
          findings: [
            {
              fingerprint: "fingerprint",
              severity: "major",
              title: "Risky branch",
              body: "Use an explicit guard before this branch.",
              location: { filePath: "src/app.ts", newLine: 2 },
            },
          ],
        }),
      stdout: { write: (chunk) => (output += chunk) },
    });

    const result = JSON.parse(output) as {
      readonly inlineCommentCount: number;
      readonly summaryCommentCount: number;
      readonly externalIds: readonly string[];
    };
    expect(result.inlineCommentCount).toBe(1);
    expect(result.summaryCommentCount).toBe(1);
    expect(result.externalIds).toHaveLength(2);
    expect(output).not.toContain("Use an explicit guard");
    expect(calls.map((call) => `${call.method} ${call.url}`)).toContain(
      "POST https://gitlab.com/api/v4/projects/123/merge_requests/5/discussions",
    );
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
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
