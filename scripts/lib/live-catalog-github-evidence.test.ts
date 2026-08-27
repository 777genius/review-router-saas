import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import canonicalArtifact from "../../packages/features/release-rollout/src/domain/activation-catalog-policy-artifact.generated.js";
import {
  boundedGithubJson,
  boundedGithubRequest,
  gitBlobSha,
} from "./github-actions-trusted-evidence.mjs";
import {
  assertFreshProtectedMain,
  buildLiveCatalogSourceClosure,
  collectLiveCatalogClaim,
} from "./live-catalog-github-evidence.mjs";
import {
  canonicalJson,
  LIVE_CATALOG_CONTRACT_PATH,
  LIVE_CATALOG_PROJECTION_PATH,
  LIVE_CATALOG_SOURCE_WORKFLOW,
  sha256Hex,
} from "./live-catalog-attestation-domain.mjs";

const commit = "a".repeat(40);
const treeSha = "b".repeat(40);
const prefix = "/repos/owner/repo";
const projection = Buffer.from(
  `export const fencedLiveV70V73CatalogDigestSql = \`SELECT 'ok'\`;\n` +
    `export const liveV70V73CatalogDigestSha256 = "sha256:${"1".repeat(64)}";\n`,
);
const candidate = Buffer.from(
  JSON.stringify({
    kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
    version: 1,
    policies: canonicalArtifact.policies,
  }),
);
const capture = Buffer.from(
  canonicalJson({
    kind: "reviewrouter-live-catalog-successful-capture-evidence",
    version: 1,
    observedCatalogDigest: `sha256:${"1".repeat(64)}`,
    projection: {
      path: LIVE_CATALOG_PROJECTION_PATH,
      export: "fencedLiveV70V73CatalogDigestSql",
      sqlSha256: sha256Hex(Buffer.from("SELECT 'ok'")),
    },
    inputs: ["a", "b"].map((suffix, index) => ({
      disposableDatabaseIdentity: `rr-disposable-1001-1-${suffix}`,
      candidateName: `activation-catalog-policy-candidate-${index + 1}.json`,
      candidateSize: candidate.length,
      candidateSha256: sha256Hex(candidate),
      receiptCatalogDigest: `sha256:${"1".repeat(64)}`,
    })),
  }),
);

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Record<string, Buffer>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(value), 14);
    local.writeUInt32LE(value.length, 18);
    local.writeUInt32LE(value.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, value);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(value), 16);
    central.writeUInt32LE(value.length, 20);
    central.writeUInt32LE(value.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0x80000000, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + value.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function sourceFiles() {
  const empty = Buffer.from("export {};\n");
  return new Map<string, Buffer>([
    [LIVE_CATALOG_SOURCE_WORKFLOW, readFileSync(LIVE_CATALOG_SOURCE_WORKFLOW)],
    ["package.json", Buffer.from('{"name":"review-router"}\n')],
    ["pnpm-lock.yaml", Buffer.from("lockfileVersion: '9.0'\n")],
    ["pnpm-workspace.yaml", Buffer.from("packages: []\n")],
    ["scripts/install-private-dependencies.mjs", empty],
    ["scripts/run-with-env.mjs", empty],
    ["scripts/rehearse-private-pg17-rollout.mjs", empty],
    ["scripts/package-live-catalog-capture-evidence.mjs", empty],
    ["scripts/capture-private-pg17-activation-catalog-policy.mjs", empty],
    ["scripts/run-codex-rotating-release-migration.mjs", empty],
    ["scripts/run-codex-rotating-role-bootstrap.mjs", empty],
    ["scripts/run-private-pg17-copy-bootstrap.ts", empty],
    ["scripts/activate-private-pg17-generation.mjs", empty],
    ["scripts/install-release-authority-db.mjs", empty],
    [LIVE_CATALOG_CONTRACT_PATH, readFileSync(LIVE_CATALOG_CONTRACT_PATH)],
    [LIVE_CATALOG_PROJECTION_PATH, projection],
    ["packages/platform/db/prisma.config.ts", empty],
    [
      "packages/platform/db/prisma/schema.prisma",
      Buffer.from("generator client {}\n"),
    ],
    [
      "packages/platform/db/prisma/migrations/000001_init/migration.sql",
      Buffer.from("SELECT 1;\n"),
    ],
    [
      "packages/platform/release-authority-db/legacy-catalog/000001_release_authority/migration.sql",
      Buffer.from("SELECT 2;\n"),
    ],
    [
      "packages/platform/release-authority-db/legacy-catalog/000002_external_effect_protocol/migration.sql",
      Buffer.from("SELECT 3;\n"),
    ],
    ["docs/unrelated.txt", Buffer.from("unrelated\n")],
  ]);
}

function fixture(mutate?: (value: any) => void) {
  const archive = zip({
    "activation-catalog-policy-candidate-1.json": candidate,
    "activation-catalog-policy-candidate-2.json": candidate,
    "live-catalog-successful-capture-evidence.json": capture,
  });
  const sources = sourceFiles();
  const value: any = {
    repository: { id: 17, full_name: "Owner/Repo", default_branch: "main" },
    main: { name: "main", protected: true, commit: { sha: commit } },
    run: {
      id: 1001,
      run_attempt: 1,
      event: "workflow_dispatch",
      path: LIVE_CATALOG_SOURCE_WORKFLOW,
      head_branch: "main",
      head_sha: commit,
      status: "completed",
      conclusion: "success",
      repository: { id: 17, full_name: "Owner/Repo" },
      head_repository: { id: 17, full_name: "Owner/Repo" },
    },
    jobs: {
      total_count: 1,
      jobs: [
        {
          id: 203,
          run_id: 1001,
          run_attempt: 1,
          head_sha: commit,
          head_branch: "main",
          name: "Capture live catalog producer",
          status: "completed",
          conclusion: "success",
          labels: ["ubuntu-24.04"],
          runner_group_id: 0,
          runner_group_name: "GitHub Actions",
          runner_name: "GitHub Actions 3",
        },
      ],
    },
    artifact: {
      id: 301,
      name: `activation-catalog-policy-${commit}-1`,
      workflow_run: {
        id: 1001,
        repository_id: 17,
        head_repository_id: 17,
        head_branch: "main",
        head_sha: commit,
      },
      expired: false,
      digest: `sha256:${sha256Hex(archive)}`,
    },
    commit: { sha: commit, tree: { sha: treeSha } },
    tree: {
      sha: treeSha,
      truncated: false,
      tree: [...sources].map(([path, bytes]) => ({
        path,
        type: "blob",
        sha: gitBlobSha(bytes),
        size: bytes.length,
      })),
    },
    archive,
    sources,
  };
  mutate?.(value);
  const bodies = new Map<string, unknown>([
    [prefix, value.repository],
    [`${prefix}/branches/main`, value.main],
    [`${prefix}/actions/runs/1001`, value.run],
    [`${prefix}/actions/runs/1001/jobs?filter=latest&per_page=100`, value.jobs],
    [`${prefix}/actions/artifacts/301`, value.artifact],
    [`${prefix}/git/commits/${commit}`, value.commit],
    [`${prefix}/git/trees/${treeSha}?recursive=1`, value.tree],
  ]);
  for (const [path, bytes] of value.sources)
    bodies.set(`${prefix}/contents/${path}?ref=${commit}`, {
      type: "file",
      path,
      encoding: "base64",
      content: bytes.toString("base64"),
      size: bytes.length,
      sha: gitBlobSha(bytes),
    });
  return async (url: string) => {
    const path = new URL(url).pathname + new URL(url).search;
    const body =
      path === `${prefix}/actions/artifacts/301/zip`
        ? value.archive
        : Buffer.from(JSON.stringify(bodies.get(path)));
    return new Response(body, {
      status:
        path === `${prefix}/actions/artifacts/301/zip` || bodies.has(path)
          ? 200
          : 404,
      headers: { "content-length": String(body.length) },
    });
  };
}

const configuration = {
  repository: "owner/repo",
  token: "token",
  runId: 1001,
  artifactId: 301,
  producerJobId: 203,
  attestorCommit: commit,
  attestorRunId: 401,
  attestorRunAttempt: 1,
  attestorRef: "refs/heads/main",
  attestorRunner: "ubuntu-24.04",
  attestorEnvironment: "production-release",
};

function producerVerifier(input: any) {
  return {
    certificate: {
      repository: "owner/repo",
      signerWorkflow: "owner/repo/.github/workflows/capture-live-catalog.yml",
      signerDigest: commit,
      sourceRef: "refs/heads/main",
      sourceDigest: commit,
      runnerEnvironment: "github-hosted",
      runInvocationURI:
        "https://github.com/owner/repo/actions/runs/1001/attempts/1",
    },
    subject: {
      name: input.subjectName,
      digest: `sha256:${sha256Hex(input.subjectBytes)}`,
    },
    bundleBytes: Buffer.from('{"bundle":true}\n'),
  };
}

describe("authenticated producer evidence", () => {
  it("requires exact current main, one producer, producer attestation, and independent closure", async () => {
    const verifier = vi.fn(producerVerifier);
    const result = await collectLiveCatalogClaim(
      configuration,
      fixture() as any,
      verifier,
    );
    expect(result.claim.source.commit).toBe(commit);
    expect(result.claim.source.commit).toBe(result.claim.attestor.commit);
    expect(
      result.claim.sourceClosure.entries.some((entry: any) =>
        entry.path.endsWith("migration.sql"),
      ),
    ).toBe(true);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(result.claim.artifact.restDigest).toBe(
      result.claim.producerAttestation.subject.digest,
    );
  });

  it("binds dynamic execution inputs but excludes unrelated workspace bytes", async () => {
    const getClosure = async (mutate?: (value: any) => void) => {
      const fetchImpl = fixture(mutate) as any;
      return buildLiveCatalogSourceClosure({
        fetchImpl,
        prefix,
        token: "token",
        commit,
        treeSha,
      });
    };
    const baseline = await getClosure();
    const digest = (files: any[]) =>
      files.map(({ path, sha256 }) => `${path}:${sha256}`).join("\n");
    for (const relevant of [
      "scripts/run-with-env.mjs",
      "packages/platform/db/prisma.config.ts",
      "packages/platform/release-authority-db/legacy-catalog/000001_release_authority/migration.sql",
      "packages/platform/release-authority-db/legacy-catalog/000002_external_effect_protocol/migration.sql",
    ]) {
      const changed = await getClosure((value) => {
        const bytes = Buffer.concat([
          value.sources.get(relevant),
          Buffer.from("x"),
        ]);
        value.sources.set(relevant, bytes);
        const entry = value.tree.tree.find(
          (item: any) => item.path === relevant,
        );
        entry.sha = gitBlobSha(bytes);
        entry.size = bytes.length;
      });
      expect(digest(changed)).not.toBe(digest(baseline));
    }
    const unrelated = await getClosure((value) => {
      const path = "docs/unrelated.txt";
      const bytes = Buffer.from("changed unrelated\n");
      value.sources.set(path, bytes);
      const entry = value.tree.tree.find((item: any) => item.path === path);
      entry.sha = gitBlobSha(bytes);
      entry.size = bytes.length;
    });
    expect(digest(unrelated)).toBe(digest(baseline));
  });

  it.each([
    [
      "malicious ancestor A then B",
      (value: any) => (value.run.head_sha = "c".repeat(40)),
    ],
    [
      "sibling job",
      (value: any) => {
        value.jobs.jobs.push({ ...value.jobs.jobs[0], id: 204 });
        value.jobs.total_count = 2;
      },
    ],
    ["attempt two", (value: any) => (value.run.run_attempt = 2)],
    [
      "self hosted",
      (value: any) => (value.jobs.jobs[0].runner_group_name = "Default"),
    ],
    [
      "REST digest divergence",
      (value: any) => (value.artifact.digest = `sha256:${"e".repeat(64)}`),
    ],
    [
      "workflow overwrite",
      (value: any) => {
        const source = value.sources
          .get(LIVE_CATALOG_SOURCE_WORKFLOW)
          .toString()
          .replace("overwrite: false", "overwrite: true");
        value.sources.set(LIVE_CATALOG_SOURCE_WORKFLOW, Buffer.from(source));
        const entry = value.tree.tree.find(
          (item: any) => item.path === LIVE_CATALOG_SOURCE_WORKFLOW,
        );
        entry.sha = gitBlobSha(Buffer.from(source));
        entry.size = Buffer.byteLength(source);
      },
    ],
    [
      "unresolved local import",
      (value: any) => {
        const source = Buffer.from("import './missing.mjs';\n");
        value.sources.set("scripts/rehearse-private-pg17-rollout.mjs", source);
        const entry = value.tree.tree.find(
          (item: any) =>
            item.path === "scripts/rehearse-private-pg17-rollout.mjs",
        );
        entry.sha = gitBlobSha(source);
        entry.size = source.length;
      },
    ],
  ])("rejects %s", async (_name, mutate) => {
    await expect(
      collectLiveCatalogClaim(
        configuration,
        fixture(mutate) as any,
        producerVerifier,
      ),
    ).rejects.toThrow(/live_catalog_/u);
  });

  it("fails the immediate pre-sign freshness recheck after main advances", async () => {
    await expect(
      assertFreshProtectedMain(
        { repository: "owner/repo", token: "token", expectedCommit: commit },
        fixture((value) => (value.main.commit.sha = "c".repeat(40))) as any,
      ),
    ).rejects.toThrow("live_catalog_attestor_not_fresh_protected_main");
  });

  it("fails closed when producer certificate verification fails before parsing", async () => {
    await expect(
      collectLiveCatalogClaim(configuration, fixture() as any, () => {
        throw new Error("live_catalog_gh_attestation_invalid");
      }),
    ).rejects.toThrow("live_catalog_gh_attestation_invalid");
  });
});

describe("bounded GitHub transport adversarial contract", () => {
  it("streams bounded JSON and rejects JSON redirects", async () => {
    const ok = vi.fn(
      async () =>
        new Response('{"ok":true}', {
          headers: { "content-length": "11" },
        }),
    );
    await expect(
      boundedGithubJson("/repos/owner/repo", "token", ok as any),
    ).resolves.toEqual({ ok: true });
    expect(ok.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
    await expect(
      boundedGithubJson(
        "/repos/owner/repo",
        "token",
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://api.github.com/other" },
          }),
      ),
    ).rejects.toThrow("live_catalog_github_redirect_invalid");
  });

  it("strips authorization on the allowlisted cross-origin storage redirect", async () => {
    const seen: Array<{ url: string; authorization?: string }> = [];
    const fetchImpl = async (url: string, init: any) => {
      seen.push({ url, authorization: init.headers.Authorization });
      if (url.startsWith("https://api.github.com/"))
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://objects.githubusercontent.com/evidence",
          },
        });
      return new Response("archive", {
        headers: { "content-length": "7" },
      });
    };
    await expect(
      boundedGithubRequest(
        {
          path: "/download",
          token: "secret",
          kind: "download",
          maximumBytes: 16,
        },
        fetchImpl,
      ),
    ).resolves.toEqual(Buffer.from("archive"));
    expect(seen).toEqual([
      {
        url: "https://api.github.com/download",
        authorization: "Bearer secret",
      },
      {
        url: "https://objects.githubusercontent.com/evidence",
        authorization: undefined,
      },
    ]);
  });

  it.each([
    ["HTTP", "http://objects.githubusercontent.com/evidence"],
    ["lookalike", "https://objects.githubusercontent.com.evil.test/evidence"],
    ["arbitrary", "https://example.com/evidence"],
  ])("rejects %s redirects", async (_name, location) => {
    await expect(
      boundedGithubRequest(
        {
          path: "/download",
          token: "token",
          kind: "download",
          maximumBytes: 16,
        },
        async () => new Response(null, { status: 302, headers: { location } }),
      ),
    ).rejects.toThrow(/live_catalog_github_/u);
  });

  it.each([
    [
      "oversized declared",
      new Response("x", { headers: { "content-length": "17" } }),
    ],
    ["oversized streamed", new Response("0123456789abcdefg")],
    [
      "truncated",
      new Response("short", { headers: { "content-length": "9" } }),
    ],
  ])("rejects %s bodies", async (_name, response) => {
    await expect(
      boundedGithubRequest(
        {
          path: "/download",
          token: "token",
          kind: "download",
          maximumBytes: 16,
        },
        async () => response,
      ),
    ).rejects.toThrow(/live_catalog_github_/u);
  });

  it("aborts once at timeout without retrying", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init: any) =>
        await new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    await expect(
      boundedGithubRequest(
        {
          path: "/download",
          token: "token",
          kind: "download",
          maximumBytes: 16,
          timeoutMs: 5,
        },
        fetchImpl as any,
      ),
    ).rejects.toThrow("live_catalog_github_transport_timeout");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
