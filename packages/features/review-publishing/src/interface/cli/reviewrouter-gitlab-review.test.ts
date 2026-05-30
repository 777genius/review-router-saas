import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runGitLabReviewCli } from "./reviewrouter-gitlab-review";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const startSha = "c".repeat(40);

describe("reviewrouter-gitlab-review CLI", () => {
  it("runs GitLab CI review, writes findings artifact, and publishes safe metadata", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reviewrouter-gitlab-review-"));
    const artifactPath = join(cwd, "reviewrouter-findings.json");
    const postedBodies: string[] = [];
    const runCommand = vi.fn(async (input) => {
      if (input.command === "git") {
        expect(input.args).toEqual([
          "diff",
          "--no-ext-diff",
          "--unified=80",
          baseSha,
          headSha,
          "--",
        ]);
        return {
          stdout: "@@ -1,1 +1,2 @@\n const old = true;\n+const added = true;\n",
          stderr: "",
        };
      }
      if (input.command === "codex") {
        expect(input.stdin).toContain("const added = true");
        const outputFile =
          input.args[input.args.indexOf("--output-last-message") + 1];
        if (!outputFile) {
          throw new Error("missing_output_file");
        }
        await writeFile(
          outputFile,
          JSON.stringify({
            protocolVersion: 1,
            summaryMarkdown: "Review completed.",
            findings: [
              {
                severity: "major",
                title: "Added branch needs guard",
                body: "The added branch should validate input first.",
                path: "src/app.ts",
                startLine: 2,
                endLine: 2,
              },
            ],
          }),
        );
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected_command:${input.command}`);
    });
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (
        href ===
        "https://reviewrouter.test/api/gitlab/action/v1/session/exchange"
      ) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          idToken: "gitlab-id-token",
          audience: "reviewrouter",
          mergeRequestIid: "5",
          headSha,
        });
        return jsonResponse({
          protocolVersion: 1,
          sessionToken: "gitlab-session-secret",
          expiresAt: "2026-05-30T12:15:00.000Z",
          repository: "group/project",
        });
      }
      if (href.endsWith("/projects/123/merge_requests/5")) {
        return jsonResponse({
          iid: 5,
          project_id: 123,
          source_project_id: 123,
          target_project_id: 123,
          state: "opened",
          sha: headSha,
        });
      }
      if (href.endsWith("/projects/123/merge_requests/5/versions")) {
        return jsonResponse([
          {
            head_commit_sha: headSha,
            base_commit_sha: baseSha,
            start_commit_sha: startSha,
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
        postedBodies.push(String(init.body));
        return jsonResponse({
          id: `discussion-${postedBodies.length}`,
          notes: [{ id: postedBodies.length }],
        });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;
    let output = "";

    try {
      await runGitLabReviewCli({
        argv: ["--artifact", artifactPath],
        cwd,
        env: {
          PATH: process.env.PATH,
          REVIEWROUTER_API_URL: "https://reviewrouter.test",
          REVIEWROUTER_ID_TOKEN: "gitlab-id-token",
          REVIEWROUTER_ID_TOKEN_AUDIENCE: "reviewrouter",
          REVIEWROUTER_GITLAB_TOKEN: "glpat-test",
          REVIEWROUTER_GITLAB_API_BASE_URL: "https://gitlab.test/api/v4",
          CODEX_MODEL: "gpt-5.5",
          CI_PROJECT_ID: "123",
          CI_PROJECT_PATH: "group/project",
          CI_MERGE_REQUEST_IID: "5",
          CI_COMMIT_SHA: headSha,
          CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha,
        },
        fetchImpl,
        runCommand,
        now: new Date("2026-05-30T12:00:00.000Z"),
        stdout: { write: (chunk) => (output += chunk) },
      });

      const result = JSON.parse(output) as {
        readonly status: string;
        readonly inlineCommentCount: number;
        readonly externalIds: readonly string[];
        readonly controlPlaneSession: {
          readonly exchanged: true;
          readonly repository: string;
          readonly expiresAt: string;
        };
      };
      const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
        readonly findings: readonly [{ readonly fingerprint: string }];
      };

      expect(result.status).toBe("published");
      expect(result.inlineCommentCount).toBe(1);
      expect(result.externalIds).toHaveLength(2);
      expect(result.controlPlaneSession).toEqual({
        exchanged: true,
        repository: "group/project",
        expiresAt: "2026-05-30T12:15:00.000Z",
      });
      expect(output).not.toContain("validate input first");
      expect(output).not.toContain("gitlab-id-token");
      expect(output).not.toContain("gitlab-session-secret");
      expect(artifact.findings[0].fingerprint).toMatch(/^rr-[a-f0-9]{40}$/);
      expect(postedBodies).toHaveLength(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
