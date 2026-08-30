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
    ["base private", { basePrivate: true }],
    ["source private", { sourcePrivate: true }],
    ["base internal", { baseVisibility: "internal" }],
    ["source internal", { sourceVisibility: "internal" }],
    ["base id", { baseId: 98 }],
    ["source id", { sourceId: 100 }],
    ["base name", { baseName: "owner/renamed" }],
    ["source name", { sourceName: "contributor/renamed" }],
    ["PR number", { pullRequestNumber: 43 }],
    ["closed", { state: "closed" }],
    ["draft", { draft: true }],
    ["merged", { merged: true }],
    ["bot", { authorType: "Bot" }],
    ["PR base id", { prBaseId: 98 }],
    ["PR source id", { prSourceId: 100 }],
    ["PR base name", { prBaseName: "owner/renamed" }],
    ["PR source name", { prSourceName: "contributor/renamed" }],
    ["base SHA", { baseSha: "c".repeat(40) }],
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

  it("creates a separate App comment when only an attacker owns the marker", async () => {
    const writes: string[] = [];
    const marker = `<!-- reviewrouter:certified-fork:${headSha} -->`;
    const gateway = fixture(async (route, parameters) => {
      if (route.includes("/comments") && route.startsWith("GET"))
        return {
          data: [{ id: 1, body: marker, user: { login: "attacker" } }],
        };
      if (route.startsWith("POST")) {
        writes.push(route);
        return {
          data: { id: 3, body: marker, user: { login: "reviewrouter[bot]" } },
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
    ).resolves.toMatchObject({ status: "created", commentId: "3" });
    expect(writes).toEqual([
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    ]);
  });

  it("fails closed when the PR head moves immediately before a write", async () => {
    let pullReads = 0;
    let writes = 0;
    const gateway = fixture(async (route, parameters) => {
      if (route.endsWith("/pulls/{pull_number}")) {
        pullReads += 1;
        return response(route, parameters, {
          headSha: pullReads >= 2 ? "d".repeat(40) : headSha,
        });
      }
      if (route.startsWith("POST") || route.startsWith("PATCH")) writes += 1;
      if (route.includes("/comments") && route.startsWith("GET"))
        return { data: [] };
      return response(route, parameters);
    });
    await expect(
      gateway.upsertOwnedComment({
        githubInstallationId: "7",
        binding,
        marker: `<!-- reviewrouter:certified-fork:${headSha} -->`,
        body: "safe",
      }),
    ).rejects.toThrow("certified_fork_tuple_mismatch");
    expect(writes).toBe(0);
  });

  it.each([
    ["byte", { patch: "x".repeat(240_001), additions: 1, deletions: 0 }],
    ["line", { patch: "@@", additions: 20_001, deletions: 0 }],
  ])("enforces the %s budget", async (_name, fileMutation) => {
    const gateway = fixture(async (route, parameters) =>
      response(route, parameters, {}, fileMutation),
    );
    await expect(
      gateway.prepareContext({ githubInstallationId: "7", binding }),
    ).rejects.toThrow("certified_fork_diff_budget_exceeded");
  });

  it("enforces the paginated file-count budget", async () => {
    const gateway = fixture(async (route, parameters) => {
      if (route.endsWith("/pulls/{pull_number}/files")) {
        const page = Number(parameters?.page);
        return {
          data: Array.from({ length: page <= 3 ? 100 : 1 }, (_, index) => ({
            filename: `src/${page}-${index}.ts`,
            status: "modified",
            additions: 1,
            deletions: 0,
            patch: "@@",
          })),
        };
      }
      return response(route, parameters);
    });
    await expect(
      gateway.prepareContext({ githubInstallationId: "7", binding }),
    ).rejects.toThrow("certified_fork_diff_budget_exceeded");
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
        id: source ? (mutation.sourceId ?? 101) : (mutation.baseId ?? 99),
        full_name: source
          ? (mutation.sourceName ?? "contributor/example")
          : (mutation.baseName ?? "owner/example"),
        private: source
          ? (mutation.sourcePrivate ?? false)
          : (mutation.basePrivate ?? false),
        visibility: source
          ? (mutation.sourceVisibility ?? "public")
          : (mutation.baseVisibility ?? "public"),
      },
    };
  }
  if (route.endsWith("/pulls/{pull_number}/files"))
    return {
      data: [
        {
          filename: fileMutation.path ?? "src/a.ts",
          status: "modified",
          additions: fileMutation.additions ?? 1,
          deletions: fileMutation.deletions ?? 1,
          patch: Object.hasOwn(fileMutation, "patch")
            ? fileMutation.patch
            : "@@ -1 +1 @@",
        },
      ],
    };
  if (route.endsWith("/pulls/{pull_number}"))
    return {
      data: {
        number: mutation.pullRequestNumber ?? 42,
        state: mutation.state ?? "open",
        draft: mutation.draft ?? false,
        merged: mutation.merged ?? false,
        user: { type: mutation.authorType ?? "User" },
        base: {
          sha: mutation.baseSha ?? baseSha,
          repo: {
            id: mutation.prBaseId ?? 99,
            full_name: mutation.prBaseName ?? "owner/example",
          },
        },
        head: {
          sha: mutation.headSha ?? headSha,
          repo: {
            id: mutation.prSourceId ?? 101,
            full_name: mutation.prSourceName ?? "contributor/example",
          },
        },
      },
    };
  throw new Error(`unexpected:${route}`);
}
