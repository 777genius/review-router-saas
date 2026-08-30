import { describe, expect, it } from "vitest";
import { OctokitCertifiedForkReviewGateway } from "./octokit-certified-fork-review-gateway.js";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const binding = {
  baseRepository: "owner/example",
  baseRepositoryId: "99",
  sourceRepository: "contributor/example",
  sourceRepositoryId: "101",
  pullRequestNumber: 42,
  baseSha,
  reviewHeadSha: headSha,
  trustDomain: "fork" as const,
};

describe("OctokitCertifiedForkReviewGateway", () => {
  it("builds a bounded canonical context and rechecks the tuple", async () => {
    const calls: string[] = [];
    const gateway = fixture(async (route, parameters) => {
      calls.push(route);
      return response(route, parameters);
    });
    const result = await gateway.prepareContext({
      githubInstallationId: "7",
      binding,
    });
    expect(result.contextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.promptPacket.files).toEqual([
      expect.objectContaining({ path: "src/a.ts", patch: "@@ -1 +1 @@" }),
    ]);
    expect(
      calls.filter((route) => route.endsWith("/pulls/{pull_number}")),
    ).toHaveLength(3);
  });
  it.each([
    ["private", { sourcePrivate: true }],
    ["draft", { draft: true }],
    ["bot", { authorType: "Bot" }],
    ["head", { headSha: "d".repeat(40) }],
  ])("rejects %s tuple mutation", async (_name, mutation) => {
    const gateway = fixture(async (route, parameters) =>
      response(route, parameters, mutation),
    );
    await expect(
      gateway.prepareContext({ githubInstallationId: "7", binding }),
    ).rejects.toThrow("certified_fork_tuple_mismatch");
  });
  it.each([
    ["binary", { patch: "Binary files differ" }],
    ["truncated", { patch: undefined }],
    ["unsafe path", { path: "../secret" }],
  ])("rejects %s files", async (_name, fileMutation) => {
    const gateway = fixture(async (route, parameters) =>
      response(route, parameters, {}, fileMutation),
    );
    await expect(
      gateway.prepareContext({ githubInstallationId: "7", binding }),
    ).rejects.toThrow("certified_fork_file_unsupported");
  });
  it("ignores attacker-owned markers and updates only the App bot comment", async () => {
    const writes: string[] = [];
    const marker = `<!-- reviewrouter:certified-fork:${headSha} -->`;
    const gateway = fixture(async (route, parameters) => {
      if (route.includes("/comments") && route.startsWith("GET"))
        return {
          data: [
            { id: 1, body: marker, user: { login: "attacker" } },
            { id: 2, body: marker, user: { login: "reviewrouter[bot]" } },
          ],
        };
      if (route.startsWith("PATCH")) {
        writes.push(route);
        return {
          data: { id: 2, body: marker, user: { login: "reviewrouter[bot]" } },
        };
      }
      return response(route, parameters);
    });
    await expect(
      gateway.upsertOwnedComment({
        githubInstallationId: "7",
        binding,
        marker,
        body: `${marker}\nsafe`,
      }),
    ).resolves.toMatchObject({ status: "updated", commentId: "2" });
    expect(writes).toEqual([
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
    ]);
  });

  it("fails closed when the head moves between file pages", async () => {
    let pullReads = 0;
    const gateway = fixture(async (route, parameters) => {
      if (route.endsWith("/pulls/{pull_number}")) {
        pullReads += 1;
        return response(route, parameters, {
          headSha: pullReads >= 3 ? "d".repeat(40) : headSha,
        });
      }
      if (route.endsWith("/pulls/{pull_number}/files")) {
        const page = Number(parameters?.page);
        return {
          data:
            page === 1
              ? Array.from({ length: 100 }, (_, index) => ({
                  filename: `src/${index}.ts`,
                  status: "modified",
                  additions: 1,
                  deletions: 0,
                  patch: "@@",
                }))
              : [
                  {
                    filename: "src/last.ts",
                    status: "modified",
                    additions: 1,
                    deletions: 0,
                    patch: "@@",
                  },
                ],
        };
      }
      return response(route, parameters);
    });
    await expect(
      gateway.prepareContext({ githubInstallationId: "7", binding }),
    ).rejects.toThrow("certified_fork_tuple_mismatch");
  });
});

function fixture(
  request: (
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<{ data: unknown }> | { data: unknown },
) {
  return new OctokitCertifiedForkReviewGateway({
    botLogin: "reviewrouter[bot]",
    app: {
      getInstallationOctokit: async () => ({
        request: async (route, parameters) => request(route, parameters),
      }),
    },
  });
}
function response(
  route: string,
  parameters?: Record<string, unknown>,
  mutation: Record<string, unknown> = {},
  fileMutation: Record<string, unknown> = {},
) {
  if (route === "GET /repos/{owner}/{repo}") {
    const source = parameters?.owner === "contributor";
    return {
      data: {
        id: source ? 101 : 99,
        full_name: source ? "contributor/example" : "owner/example",
        private: source ? (mutation.sourcePrivate ?? false) : false,
      },
    };
  }
  if (route.endsWith("/pulls/{pull_number}/files"))
    return {
      data: [
        {
          filename: fileMutation.path ?? "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: Object.hasOwn(fileMutation, "patch")
            ? fileMutation.patch
            : "@@ -1 +1 @@",
        },
      ],
    };
  if (route.endsWith("/pulls/{pull_number}"))
    return {
      data: {
        state: "open",
        draft: mutation.draft ?? false,
        merged: false,
        user: { type: mutation.authorType ?? "User" },
        base: { sha: baseSha, repo: { id: 99, full_name: "owner/example" } },
        head: {
          sha: mutation.headSha ?? headSha,
          repo: { id: 101, full_name: "contributor/example" },
        },
      },
    };
  throw new Error(`unexpected:${route}`);
}
