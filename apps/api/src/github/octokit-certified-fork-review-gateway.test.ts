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
      expect.objectContaining({
        path: "src/a.ts",
        patch: "@@ -1 +1 @@\n-old\n+new",
      }),
    ]);
    expect(
      calls.filter((route) => route.endsWith("/pulls/{pull_number}")),
    ).toHaveLength(2);
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
    [
      "patchless rename",
      { status: "renamed", patch: undefined, additions: 0, deletions: 0 },
    ],
    [
      "empty rename",
      { status: "renamed", patch: "", additions: 0, deletions: 0 },
    ],
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
    [
      "line",
      {
        patch: "@@ -0,0 +1,20001 @@\n" + "+x\n".repeat(20_001),
        additions: 20_001,
        deletions: 0,
      },
    ],
  ])("enforces the %s budget", async (_name, fileMutation) => {
    const gateway = fixture(async (route, parameters) =>
      response(route, parameters, {}, fileMutation),
    );
    await expect(
      gateway.prepareContext({ githubInstallationId: "7", binding }),
    ).rejects.toThrow("certified_fork_diff_budget_exceeded");
  });

  it.each([
    ["ASCII", sizedPatch(certifiedForkReviewMaxFilePatchBytes, "x")],
    ["multibyte", sizedPatch(certifiedForkReviewMaxFilePatchBytes, "é")],
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
    const patch = sizedPatch(certifiedForkReviewMaxFilePatchBytes, "é") + "é";
    const gateway = fixture(async (route, parameters) =>
      response(route, parameters, {}, { patch, additions: 1, deletions: 0 }),
    );
    await expect(
      gateway.prepareContext({ githubInstallationId: "7", binding }),
    ).rejects.toThrow("certified_fork_diff_budget_exceeded");
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
        fork: source,
        ...(source ? { parent: { id: 99 }, source: { id: 99 } } : {}),
        visibility: source
          ? (mutation.sourceVisibility ?? "public")
          : (mutation.baseVisibility ?? "public"),
      },
    };
  }
  if (route === compareRoute)
    return {
      data: {
        base_commit: { sha: baseSha },
        files: [
          {
            filename: fileMutation.path ?? "src/a.ts",
            status: fileMutation.status ?? "modified",
            additions: fileMutation.additions ?? 1,
            deletions: fileMutation.deletions ?? 1,
            patch: Object.hasOwn(fileMutation, "patch")
              ? fileMutation.patch
              : "@@ -1 +1 @@\n-old\n+new",
          },
        ],
      },
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

const compareRoute = "GET /repos/{owner}/{repo}/compare/{basehead}";
const input = { githubInstallationId: "7", binding };
function sizedPatch(bytes: number, unit = "x") {
  const header = "@@ -0,0 +1 @@\n+";
  const remaining = bytes - Buffer.byteLength(header);
  return (
    header +
    unit.repeat(Math.floor(remaining / Buffer.byteLength(unit))) +
    "x".repeat(remaining % Buffer.byteLength(unit))
  );
}
function file(patch = "@@ -1 +1 @@\n-old\n+new", additions = 1, deletions = 1) {
  return {
    filename: "src/a.ts",
    status: "modified",
    patch,
    additions,
    deletions,
  };
}
function withFiles(files: unknown, changedFiles = 1) {
  return fixture(async (route, parameters) =>
    route === compareRoute
      ? { data: { base_commit: { sha: baseSha }, files } }
      : response(route, parameters, { changedFiles }),
  );
}

describe("immutable compare certification", () => {
  it("binds ABA provenance to immutable lowercase SHAs with one page and a timeout", async () => {
    const calls: string[] = [];
    const gateway = fixture(async (route, parameters) => {
      calls.push(route);
      expect(parameters?.request).toEqual({ timeout: 15000 });
      if (route.endsWith("/files"))
        return { data: [file("@@ -1 +1 @@\n-old\n+C")] };
      if (route === compareRoute)
        expect(parameters).toEqual({
          owner: "owner",
          repo: "example",
          basehead: `${baseSha}...${headSha}`,
          page: 1,
          per_page: 1,
          request: { timeout: 15000 },
        });
      return response(route, parameters);
    });
    expect(
      (await gateway.prepareContext(input)).promptPacket.files[0]?.patch,
    ).toBe(file().patch);
    expect(calls.filter((route) => route === compareRoute)).toHaveLength(1);
    expect(calls.some((route) => route.endsWith("/files"))).toBe(false);
  });
  it("accepts diverged three-dot semantics", async () => {
    const gateway = fixture(async (route, parameters) =>
      route === compareRoute
        ? {
            data: {
              base_commit: { sha: baseSha },
              merge_base_commit: { sha: "c".repeat(40) },
              status: "diverged",
              files: [file()],
            },
          }
        : response(route, parameters),
    );
    await expect(gateway.prepareContext(input)).resolves.toHaveProperty(
      "contextHash",
    );
  });
  it("rejects the wrong compare base", async () => {
    const gateway = fixture(async (route, parameters) =>
      route === compareRoute
        ? { data: { base_commit: { sha: headSha }, files: [file()] } }
        : response(route, parameters),
    );
    await expect(gateway.prepareContext(input)).rejects.toThrow(
      "certified_fork_tuple_mismatch",
    );
  });
  it.each([301, 500, 501])(
    "gates %s declared files before compare",
    async (count) => {
      let compares = 0;
      const gateway = fixture(async (route, parameters) => {
        if (route === compareRoute) compares++;
        return response(route, parameters, { changedFiles: count });
      });
      await expect(gateway.prepareContext(input)).rejects.toThrow(
        count > 500
          ? "certified_fork_diff_budget_exceeded"
          : "certified_fork_diff_api_limit_exceeded",
      );
      expect(compares).toBe(0);
    },
  );
  it("accepts 300 complete files", async () => {
    const files = Array.from({ length: 300 }, (_, index) => ({
      ...file(),
      filename: `src/${index}.ts`,
    }));
    expect(
      (await withFiles(files, 300).prepareContext(input)).promptPacket.files,
    ).toHaveLength(300);
  });
  it.each([0, 2])("rejects %s files against a declared one", async (count) => {
    await expect(
      withFiles(Array.from({ length: count }, () => file())).prepareContext(
        input,
      ),
    ).rejects.toThrow("certified_fork_files_incomplete");
  });
  it.each([
    { changedFiles: 2 },
    { headSha: "c".repeat(40) },
    { baseSha: "d".repeat(40) },
  ])("rejects final tuple mutation %j", async (mutation) => {
    let compared = false;
    const gateway = fixture(async (route, parameters) => {
      const result = response(route, parameters, compared ? mutation : {});
      if (route === compareRoute) compared = true;
      return result;
    });
    await expect(gateway.prepareContext(input)).rejects.toThrow(
      "certified_fork_tuple_mismatch",
    );
  });
  it.each(["baseSha", "reviewHeadSha"])(
    "rejects noncanonical binding %s",
    async (key) => {
      await expect(
        withFiles([file()]).prepareContext({
          ...input,
          binding: { ...binding, [key]: "A".repeat(40) },
        }),
      ).rejects.toThrow("certified_fork_tuple_mismatch");
    },
  );
  it("rejects stale binding and context entrypoints", async () => {
    const gateway = fixture(async (route, parameters) =>
      response(route, parameters, { headSha: "c".repeat(40) }),
    );
    await expect(gateway.assertBindingCurrent(input)).rejects.toThrow(
      "certified_fork_tuple_mismatch",
    );
    await expect(
      gateway.assertContextCurrent({
        ...input,
        expectedContextHash: "a".repeat(64),
      }),
    ).rejects.toThrow("certified_fork_tuple_mismatch");
    await expect(
      gateway.assertContextCurrent({ ...input, expectedContextHash: "bad" }),
    ).rejects.toThrow("certified_fork_context_mismatch");
  });
  it.each([240000, 240001])(
    "preserves aggregate bytes at %s",
    async (bytes) => {
      const files = Array.from({ length: 4 }, (_, index) => ({
        ...file(sizedPatch(60000 + (index === 0 ? bytes - 240000 : 0)), 1, 0),
        filename: `src/${index}.ts`,
      }));
      const result = withFiles(files, 4).prepareContext(input);
      if (bytes === 240000)
        await expect(result).resolves.toHaveProperty("contextHash");
      else
        await expect(result).rejects.toThrow(
          "certified_fork_diff_budget_exceeded",
        );
    },
  );
});

describe("current fork network", () => {
  const root = { fork: false };
  const fork = (parent = 99, source = 99) => ({
    fork: true,
    parent: { id: parent },
    source: { id: source },
  });
  function network(
    base: object,
    head: object,
    finalBase = base,
    finalHead = head,
  ) {
    let compared = false;
    return fixture(async (route, parameters) => {
      const result = response(route, parameters);
      if (route === "GET /repos/{owner}/{repo}")
        return {
          data: {
            ...result.data,
            ...(parameters?.owner === "owner"
              ? compared
                ? finalBase
                : base
              : compared
                ? finalHead
                : head),
          },
        };
      if (route === compareRoute) compared = true;
      return result;
    });
  }
  it.each([
    [root, fork()],
    [root, fork(88)],
    [fork(77, 77), fork(88, 77)],
  ])(
    "accepts direct, transitive and sibling networks %j %j",
    async (base, head) => {
      await expect(
        network(base, head).prepareContext(input),
      ).resolves.toHaveProperty("contextHash");
      await expect(
        network(base, head).assertBindingCurrent(input),
      ).resolves.toBeUndefined();
    },
  );
  it.each([
    [fork(101, 101), root],
    [root, { fork: true, parent: undefined, source: undefined }],
    [root, fork(99, 88)],
    [root, fork(101)],
    [root, fork(99, 101)],
    [root, { fork: true, parent: { id: 0 }, source: { id: 99 } }],
    [root, { fork: true, parent: { id: 99 }, source: { id: "bad" } }],
    [root, { fork: undefined }],
    [fork(99, 77), fork(88, 77)],
    [fork(77, 99), fork()],
    [
      root,
      { fork: true, parent: { id: 9007199254740992 }, source: { id: 99 } },
    ],
  ])("rejects invalid network %j %j", async (base, head) => {
    await expect(network(base, head).prepareContext(input)).rejects.toThrow(
      /certified_fork_/,
    );
    await expect(
      network(base, head).assertBindingCurrent(input),
    ).rejects.toThrow(/certified_fork_/);
  });
  it.each([
    [root, fork(), root, fork(88)],
    [fork(77, 77), fork(88, 77), fork(66, 66), fork(88, 66)],
    [root, fork(), fork(77, 77), fork(88, 77)],
    [root, fork(), root, root],
  ])(
    "rejects changed relationship across compare %j",
    async (base, head, finalBase, finalHead) => {
      await expect(
        network(base, head, finalBase, finalHead).prepareContext(input),
      ).rejects.toThrow("certified_fork_tuple_mismatch");
      await expect(
        network(base, head, finalBase, finalHead).assertContextCurrent({
          ...input,
          expectedContextHash: "a".repeat(64),
        }),
      ).rejects.toThrow("certified_fork_tuple_mismatch");
    },
  );
});

describe("unified hunk completeness", () => {
  it.each([
    ["@@ -1 +1 @@\n-old\n+new", 1, 1],
    ["@@ -1,2 +1,2 @@ section\r\n same\r\n-old\r\n+new\r\n", 1, 1],
    ["@@ -0,0 +1 @@\n+new", 1, 0],
    ["@@ -1 +0,0 @@\n-old", 0, 1],
    ["@@ -1 +1 @@\n-old\n+new\n@@ -5 +5 @@ label\n-x\n+y\n", 2, 2],
    [
      "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\r\n",
      1,
      1,
    ],
    ["@@ -1 +1,2 @@\n GIT binary patch\n+GIT binary patch", 1, 0],
    [
      "@@ -1 +1,2 @@\n \\ No newline at end of file\n+Binary files differ",
      1,
      0,
    ],
  ] as const)(
    "accepts complete patch %s",
    async (patch, additions, deletions) => {
      expect(
        (
          await withFiles([file(patch, additions, deletions)]).prepareContext(
            input,
          )
        ).promptPacket.files[0]?.patch,
      ).toBe(patch);
    },
  );
  it.each([
    ["@@ -0,0 +1 @@\n+x", 2, 0],
    ["@@ -1 +1 @@\n-old", 0, 1],
    ["@@ -1 +1 @@\n-old\n+new\nmalformed", 1, 1],
    ["@@ -1,2 +1,2 @@\n-old\n+new\n@@ -5 +5 @@\n-x\n+y", 2, 2],
    ["@@ -9007199254740992 +1 @@\n-x\n+y", 1, 1],
    ["@@ -1,9007199254740992 +1 @@\n-x\n+y", 1, 1],
    ["@@ -9007199254740991,1 +1 @@\n-x\n+y", 1, 1],
    ["@@ -0 +1 @@\n-x\n+y", 1, 1],
    ["@@ -1e2 +1 @@\n-x\n+y", 1, 1],
    ["@@ --1 +1 @@\n-x\n+y", 1, 1],
    ["@@ -1 +1 @@\n-x\n+y\n+late", 2, 1],
    ["@@ -1 +1 @@\n+x\n+y", 2, 0],
    ["\\ No newline at end of file\n@@ -1 +1 @@\n-x\n+y", 1, 1],
    ["@@ -1 +1 @@\n\\ No newline at end of file\n-x\n+y", 1, 1],
    [
      "@@ -1 +1 @@\n-x\n+y\n\\ No newline at end of file\n\\ No newline at end of file",
      1,
      1,
    ],
    ["GIT binary patch", 0, 0],
    ["@@", 0, 0],
    ["@@ -1 +1 @@\n-x\n+y", 1, 2],
  ] as const)(
    "rejects incomplete patch %s",
    async (patch, additions, deletions) => {
      await expect(
        withFiles([file(patch, additions, deletions)]).prepareContext(input),
      ).rejects.toThrow("certified_fork_file_unsupported");
    },
  );
});

describe("callback-free response intake", () => {
  it.each(["repository", "PR", "compare"])(
    "rejects %s envelope getters and proxies without callbacks",
    async (kind) => {
      for (const proxy of [false, true]) {
        let callbacks = 0;
        const gateway = fixture(async (route, parameters) => {
          const targeted =
            kind === "repository"
              ? route === "GET /repos/{owner}/{repo}"
              : kind === "PR"
                ? route.endsWith("/pulls/{pull_number}")
                : route === compareRoute;
          if (!targeted) return response(route, parameters);
          const envelope = Object.defineProperty({}, "data", {
            enumerable: true,
            get() {
              callbacks++;
              return {};
            },
          }) as { data: unknown };
          return proxy
            ? new Proxy(envelope, {
                get(target, key) {
                  if (key === "then") return undefined;
                  callbacks++;
                  return Reflect.get(target, key);
                },
                getPrototypeOf() {
                  callbacks++;
                  return Object.prototype;
                },
                ownKeys() {
                  callbacks++;
                  return ["data"];
                },
                getOwnPropertyDescriptor() {
                  callbacks++;
                  return undefined;
                },
              })
            : envelope;
        });
        await expect(gateway.prepareContext(input)).rejects.toThrow(
          "certified_fork_response_accessor",
        );
        expect(callbacks).toBe(0);
      }
    },
  );
  it.each([
    "files getter",
    "proxy",
    "index getter",
    "iterator",
    "iterator getter",
    "sparse",
    "prototype",
    "extra key",
    "symbol",
    "nonenumerable index",
    "non-array",
    "oversized",
  ])("rejects %s without callbacks", async (kind) => {
    let callbacks = 0;
    let files: unknown = [file()];
    if (kind === "proxy")
      files = new Proxy([file()], {
        get() {
          callbacks++;
          return undefined;
        },
        getPrototypeOf() {
          callbacks++;
          return Array.prototype;
        },
        ownKeys() {
          callbacks++;
          return [];
        },
        getOwnPropertyDescriptor() {
          callbacks++;
          return undefined;
        },
      });
    if (kind === "index getter")
      Object.defineProperty(files, "0", {
        enumerable: true,
        get() {
          callbacks++;
          return file();
        },
      });
    if (kind === "iterator")
      Object.defineProperty(files, Symbol.iterator, {
        value() {
          callbacks++;
          return [file()][Symbol.iterator]();
        },
      });
    if (kind === "iterator getter")
      Object.defineProperty(files, Symbol.iterator, {
        get() {
          callbacks++;
          return Array.prototype[Symbol.iterator];
        },
      });
    if (kind === "sparse") files = new Array(1);
    if (kind === "prototype")
      Object.setPrototypeOf(
        files,
        new Proxy(
          {},
          {
            get() {
              callbacks++;
              return undefined;
            },
          },
        ),
      );
    if (kind === "extra key")
      Object.defineProperty(files, "extra", { value: 1 });
    if (kind === "symbol")
      Object.defineProperty(files, Symbol("extra"), { value: 1 });
    if (kind === "nonenumerable index")
      Object.defineProperty(files, "0", { enumerable: false });
    if (kind === "non-array") files = { 0: file(), length: 1 };
    if (kind === "oversized") files = Array.from({ length: 301 }, () => file());
    const gateway = fixture(async (route, parameters) => {
      if (route !== compareRoute) return response(route, parameters);
      const data = { base_commit: { sha: baseSha }, files };
      if (kind === "files getter")
        Object.defineProperty(data, "files", {
          enumerable: true,
          get() {
            callbacks++;
            return [file()];
          },
        });
      return { data };
    });
    await expect(gateway.prepareContext(input)).rejects.toThrow(
      kind === "files getter"
        ? "certified_fork_response_accessor"
        : "certified_fork_files_invalid",
    );
    expect(callbacks).toBe(0);
  });
  it("rejects file field getters and proxies without callbacks", async () => {
    let callbacks = 0;
    const accessor = Object.defineProperty(file(), "patch", {
      enumerable: true,
      get() {
        callbacks++;
        return file().patch;
      },
    });
    const proxy = new Proxy(file(), {
      getPrototypeOf() {
        callbacks++;
        return Object.prototype;
      },
      get() {
        callbacks++;
        return undefined;
      },
    });
    await expect(withFiles([accessor]).prepareContext(input)).rejects.toThrow(
      "certified_fork_response_accessor",
    );
    await expect(withFiles([proxy]).prepareContext(input)).rejects.toThrow(
      "certified_fork_file_unsupported",
    );
    expect(callbacks).toBe(0);
  });
});

describe("preserved packet and line budgets", () => {
  it.each([300000, 300001])(
    "enforces serialized packet bytes at %s",
    async (bytes) => {
      const files = [0, 1].map((index) => ({
        ...file(sizedPatch(100000), 1, 0),
        filename: `src/${index}.ts`,
      }));
      const prepared = await withFiles(files, 2).prepareContext(input);
      const extra =
        bytes - Buffer.byteLength(JSON.stringify(prepared.promptPacket));
      expect(extra).toBeGreaterThan(0);
      expect(extra).toBeLessThan(99980);
      files[0]!.patch = files[0]!.patch.replace(
        "x".repeat(extra),
        '"'.repeat(extra),
      );
      const result = withFiles(files, 2).prepareContext(input);
      if (bytes === 300000) {
        const packet = (await result).promptPacket;
        expect(Buffer.byteLength(JSON.stringify(packet))).toBe(bytes);
      } else
        await expect(result).rejects.toThrow(
          "certified_fork_review_packet_too_large",
        );
    },
  );
  it("accepts exactly 20000 changed lines", async () => {
    await expect(
      withFiles([
        file("@@ -0,0 +1,20000 @@\n" + "+x\n".repeat(20000), 20000, 0),
      ]).prepareContext(input),
    ).resolves.toHaveProperty("contextHash");
  });
  it("rejects an unsupported status with a complete hunk", async () => {
    await expect(
      withFiles([{ ...file(), status: "copied" }]).prepareContext(input),
    ).rejects.toThrow("certified_fork_file_unsupported");
  });
  it("rejects omitted patches even with zero changes", async () => {
    await expect(
      withFiles([
        {
          filename: "src/a.ts",
          status: "modified",
          additions: 0,
          deletions: 0,
        },
      ]).prepareContext(input),
    ).rejects.toThrow("certified_fork_response_accessor");
  });
});
