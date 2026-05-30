import { describe, expect, it, vi } from "vitest";
import { stringifyReviewFindingsArtifact } from "../../domain/review-findings-artifact";
import { runReviewPublisherCli } from "./reviewrouter-publish-review";

describe("reviewrouter-publish-review CLI", () => {
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
