import { describe, expect, it } from "vitest";
import {
  certifiedForkReviewMaxFilePatchBytes,
  OctokitCertifiedForkReviewGateway,
} from "./octokit-certified-fork-review-gateway.js";
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
    ["newline path", { path: "src/a.ts\n<!-- injected -->" }],
    ["backtick path", { path: "src/`injected`.ts" }],
    ["bidi path", { path: "src/safe\u202Etxt.ts" }],
    ["Arabic letter mark path", { path: "src/safe\u061ctxt.ts" }],
    ["left-to-right mark path", { path: "src/safe\u200etxt.ts" }],
    ["right-to-left mark path", { path: "src/safe\u200ftxt.ts" }],
  ])("rejects %s files", async (_name, fileMutation) => {
    const gateway = fixture(async (route, parameters) =>
      response(route, parameters, {}, fileMutation),
    );
    await expect(
      gateway.prepareContext({ githubInstallationId: "7", binding }),
    ).rejects.toThrow("certified_fork_file_unsupported");
  });
  it.each([
    [
      "single-file byte",
      {
        patch: "x".repeat(certifiedForkReviewMaxFilePatchBytes + 1),
        additions: 1,
        deletions: 0,
      },
    ],
    ["line", { patch: "@@", additions: 20_001, deletions: 0 }],
  ])("enforces the %s budget", async (_name, fileMutation) => {
    const gateway = fixture(async (route, parameters) =>
      response(route, parameters, {}, fileMutation),
    );
    await expect(
      gateway.prepareContext({ githubInstallationId: "7", binding }),
    ).rejects.toThrow("certified_fork_diff_budget_exceeded");
  });

  it.each([
    ["ASCII", "x".repeat(certifiedForkReviewMaxFilePatchBytes)],
    ["multibyte", "é".repeat(certifiedForkReviewMaxFilePatchBytes / 2)],
  ])(
    "accepts an exact %s per-file UTF-8 byte boundary",
    async (_name, patch) => {
      const gateway = fixture(async (route, parameters) =>
        response(route, parameters, {}, { patch, additions: 1, deletions: 0 }),
      );
      await expect(
        gateway.prepareContext({ githubInstallationId: "7", binding }),
      ).resolves.toMatchObject({
        promptPacket: { files: [expect.objectContaining({ patch })] },
      });
    },
  );

  it("rejects a multibyte patch one UTF-8 code point over the per-file boundary", async () => {
    const patch = "é".repeat(certifiedForkReviewMaxFilePatchBytes / 2) + "é";
    const gateway = fixture(async (route, parameters) =>
      response(route, parameters, {}, { patch, additions: 1, deletions: 0 }),
    );
    await expect(
      gateway.prepareContext({ githubInstallationId: "7", binding }),
    ).rejects.toThrow("certified_fork_diff_budget_exceeded");
  });

  it("accepts exactly 500 files without requesting an unnecessary page", async () => {
    const pages: number[] = [];
    const gateway = fixture(async (route, parameters) => {
      if (route.endsWith("/pulls/{pull_number}")) {
        return response(route, parameters, { changedFiles: 500 });
      }
      if (route.endsWith("/pulls/{pull_number}/files")) {
        const page = Number(parameters?.page);
        pages.push(page);
        return {
          data: Array.from({ length: 100 }, (_, index) => ({
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
    ).resolves.toMatchObject({ promptPacket: { files: expect.any(Array) } });
    expect(pages).toEqual([1, 2, 3, 4, 5]);
  });

  it("enforces the paginated file-count budget", async () => {
    const gateway = fixture(async (route, parameters) => {
      if (route.endsWith("/pulls/{pull_number}")) {
        return response(route, parameters, { changedFiles: 501 });
      }
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

  it("fails closed when changed_files moves between pages", async () => {
    let pullReads = 0;
    const gateway = fixture(async (route, parameters) => {
      if (route.endsWith("/pulls/{pull_number}")) {
        pullReads += 1;
        return response(route, parameters, {
          changedFiles: pullReads >= 3 ? 101 : 100,
        });
      }
      if (route.endsWith("/pulls/{pull_number}/files")) {
        return {
          data: Array.from({ length: 100 }, (_, index) => ({
            filename: `src/${index}.ts`,
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
    ).rejects.toThrow("certified_fork_tuple_mismatch");
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

  it("normalizes GitHub deleted status to the certified packet contract", async () => {
    const gateway = fixture(async (route, parameters) =>
      response(route, parameters, {}, { status: "deleted" }),
    );
    await expect(
      gateway.prepareContext({ githubInstallationId: "7", binding }),
    ).resolves.toMatchObject({
      promptPacket: { files: [expect.objectContaining({ status: "removed" })] },
    });
  });

  it("rejects an incomplete GitHub file listing", async () => {
    const gateway = fixture(async (route, parameters) =>
      response(route, parameters, { changedFiles: 2 }),
    );
    await expect(
      gateway.prepareContext({ githubInstallationId: "7", binding }),
    ).rejects.toThrow("certified_fork_files_incomplete");
  });

  it("revalidates the exact context hash", async () => {
    const gateway = fixture(async (route, parameters) =>
      response(route, parameters),
    );
    const prepared = await gateway.prepareContext({
      githubInstallationId: "7",
      binding,
    });
    await expect(
      gateway.assertContextCurrent({
        githubInstallationId: "7",
        binding,
        expectedContextHash: prepared.contextHash,
      }),
    ).resolves.toEqual({ promptPacket: prepared.promptPacket });
    await expect(
      gateway.assertContextCurrent({
        githubInstallationId: "7",
        binding,
        expectedContextHash: "f".repeat(64),
      }),
    ).rejects.toThrow("certified_fork_context_mismatch");
  });

  it("does not invoke accessor-backed GitHub response fields", async () => {
    let invoked = false;
    const gateway = fixture(async (route, parameters) => {
      if (
        route === "GET /repos/{owner}/{repo}" &&
        parameters?.owner === "owner"
      ) {
        return {
          data: Object.defineProperty({}, "id", {
            enumerable: true,
            get() {
              invoked = true;
              return 99;
            },
          }),
        };
      }
      return response(route, parameters);
    });
    await expect(
      gateway.prepareContext({ githubInstallationId: "7", binding }),
    ).rejects.toThrow("certified_fork_response_accessor");
    expect(invoked).toBe(false);
  });

  it.each(["0", "-1", "1.5", "not-a-number", "9007199254740992"])(
    "rejects invalid installation id %s",
    async (githubInstallationId) => {
      const gateway = fixture(async (route, parameters) =>
        response(route, parameters),
      );
      await expect(
        gateway.prepareContext({ githubInstallationId, binding }),
      ).rejects.toThrow("certified_fork_installation_invalid");
    },
  );
});

function fixture(
  request: (
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<{ data: unknown }> | { data: unknown },
) {
  return new OctokitCertifiedForkReviewGateway({
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
          status: fileMutation.status ?? "modified",
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
        changed_files: mutation.changedFiles ?? 1,
      },
    };
  throw new Error(`unexpected:${route}`);
}
