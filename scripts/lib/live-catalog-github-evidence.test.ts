import { describe, expect, it, vi } from "vitest";
import {
  boundedGithubJson,
  boundedGithubRequest,
  gitBlobSha,
} from "./github-actions-trusted-evidence.mjs";
import { collectLiveCatalogClaim } from "./live-catalog-github-evidence.mjs";
import { sha256Hex } from "./live-catalog-attestation-domain.mjs";
import {
  testCandidate as candidate,
  testCaptureEvidence as captureEvidence,
  testProjectionSource as projection,
  testWorkflowSource as workflow,
} from "./live-catalog-attestation-test-fixtures.mjs";

const sourceCommit = "a".repeat(40);
const attestorCommit = "b".repeat(40);
const tree = "c".repeat(40);
const prefix = "/repos/owner/repo";

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

function fixture(mutate?: (values: Record<string, any>) => void) {
  const archive = zip({
    "activation-catalog-policy-candidate-1.json": candidate,
    "activation-catalog-policy-candidate-2.json": candidate,
    "live-catalog-successful-capture-evidence.json": captureEvidence,
  });
  const values: Record<string, any> = {
    repository: { id: 17, full_name: "Owner/Repo", default_branch: "main" },
    main: { name: "main", protected: true, commit: { sha: attestorCommit } },
    run: {
      id: 1001,
      run_attempt: 1,
      event: "workflow_dispatch",
      path: ".github/workflows/ci.yml",
      head_branch: "main",
      head_sha: sourceCommit,
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
          head_sha: sourceCommit,
          head_branch: "main",
          name: "Full private PG16 to PG17 rehearsal",
          status: "completed",
          conclusion: "success",
          labels: ["ubuntu-24.04"],
          runner_group_id: 0,
          runner_group_name: "GitHub Actions",
          runner_name: "GitHub Actions 1003",
        },
      ],
    },
    artifact: {
      id: 301,
      name: `activation-catalog-policy-${sourceCommit}-1`,
      workflow_run: {
        id: 1001,
        repository_id: 17,
        head_repository_id: 17,
        head_branch: "main",
        head_sha: sourceCommit,
      },
      expired: false,
      digest: `sha256:${sha256Hex(archive)}`,
    },
    commit: { sha: sourceCommit, tree: { sha: tree } },
    ancestry: {
      status: "ahead",
      base_commit: { sha: sourceCommit },
      merge_base_commit: { sha: sourceCommit },
    },
    archive,
  };
  mutate?.(values);
  const source = (path: string, bytes: Buffer) => ({
    type: "file",
    path,
    encoding: "base64",
    content: bytes.toString("base64"),
    size: bytes.length,
    sha: gitBlobSha(bytes),
  });
  const bodies = new Map<string, unknown>([
    [prefix, values.repository],
    [`${prefix}/branches/main`, values.main],
    [`${prefix}/actions/runs/1001`, values.run],
    [
      `${prefix}/actions/runs/1001/jobs?filter=latest&per_page=100`,
      values.jobs,
    ],
    [`${prefix}/actions/artifacts/301`, values.artifact],
    [`${prefix}/git/commits/${sourceCommit}`, values.commit],
    [`${prefix}/compare/${sourceCommit}...${attestorCommit}`, values.ancestry],
    [
      `${prefix}/contents/.github/workflows/ci.yml?ref=${sourceCommit}`,
      source(".github/workflows/ci.yml", workflow),
    ],
    [
      `${prefix}/contents/packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs?ref=${sourceCommit}`,
      source(
        "packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs",
        projection,
      ),
    ],
  ]);
  const downloads = new Map<string, Buffer>([
    [`${prefix}/actions/artifacts/301/zip`, values.archive],
  ]);
  const fetchImpl = async (url: string) => {
    const path = new URL(url).pathname + new URL(url).search;
    const download = downloads.get(path);
    const body = download ?? Buffer.from(JSON.stringify(bodies.get(path)));
    return new Response(body, {
      status: download !== undefined || bodies.has(path) ? 200 : 404,
      headers: { "content-length": String(body.length) },
    });
  };
  return fetchImpl;
}

const configuration = {
  repository: "owner/repo",
  token: "token",
  runId: 1001,
  artifactId: 301,
  producerJobId: 203,
  attestorCommit,
  attestorRunId: 401,
  attestorRunAttempt: 1,
  attestorRef: "refs/heads/main",
  attestorRunner: "ubuntu-24.04",
  attestorEnvironment: "production-release",
};

describe("live catalog authenticated GitHub adapter", () => {
  it("assembles only from protected-main API/source bytes and exact GitHub tuples", async () => {
    const result = await collectLiveCatalogClaim(
      configuration,
      fixture() as any,
    );
    expect(result.claim.repository).toEqual({ id: "17", name: "owner/repo" });
    expect(result.claim.source).toEqual({
      commit: sourceCommit,
      tree,
      ref: sourceCommit,
      branch: "main",
    });
    expect(result.claim.execution.producerJob.id).toBe("203");
    expect(result.evidence.workflowSourceBytes).toEqual(workflow);
    expect(result.evidence.projectionSourceBytes).toEqual(projection);
  });

  it.each([
    [
      "repository rename",
      (value: any) => (value.repository.full_name = "Owner/Other"),
    ],
    ["repository ID", (value: any) => (value.repository.id = 18)],
    [
      "default branch",
      (value: any) => (value.repository.default_branch = "develop"),
    ],
    ["unprotected main", (value: any) => (value.main.protected = false)],
    ["stale attestor", (value: any) => (value.main.commit.sha = sourceCommit)],
    ["non-main source", (value: any) => (value.run.head_branch = "pull/227")],
    [
      "source repository fork",
      (value: any) => (value.run.head_repository.id = 18),
    ],
    [
      "source workflow",
      (value: any) => (value.run.path = ".github/workflows/other.yml"),
    ],
    ["source retry", (value: any) => (value.run.run_attempt = 2)],
    ["run repository ID", (value: any) => (value.run.repository.id = 18)],
    [
      "run repository name",
      (value: any) => (value.run.repository.full_name = "Owner/Other"),
    ],
    [
      "head repository name",
      (value: any) => (value.run.head_repository.full_name = "Owner/Other"),
    ],
    ["pull request source", (value: any) => (value.run.event = "pull_request")],
    ["source tree", (value: any) => (value.commit.tree.sha = "invalid")],
    ["commit identity", (value: any) => (value.commit.sha = attestorCommit)],
    ["source ancestry", (value: any) => (value.ancestry.status = "diverged")],
    [
      "ancestry base",
      (value: any) => (value.ancestry.base_commit.sha = attestorCommit),
    ],
    [
      "ancestry merge base",
      (value: any) => (value.ancestry.merge_base_commit.sha = attestorCommit),
    ],
    [
      "failed producer",
      (value: any) => (value.jobs.jobs[0].conclusion = "failure"),
    ],
    [
      "wrong producer name",
      (value: any) => (value.jobs.jobs[0].name = "Quality Gates"),
    ],
    [
      "self-hosted producer",
      (value: any) => value.jobs.jobs[0].labels.push("self-hosted"),
    ],
    ["producer status", (value: any) => (value.jobs.jobs[0].status = "queued")],
    ["producer ID", (value: any) => (value.jobs.jobs[0].id = 999)],
    ["job inventory", (value: any) => (value.jobs.total_count = 2)],
    ["producer run", (value: any) => (value.jobs.jobs[0].run_id = 999)],
    ["producer attempt", (value: any) => (value.jobs.jobs[0].run_attempt = 2)],
    [
      "producer branch",
      (value: any) => (value.jobs.jobs[0].head_branch = "other"),
    ],
    [
      "runner group name",
      (value: any) => (value.jobs.jobs[0].runner_group_name = "Other"),
    ],
    [
      "custom runner group",
      (value: any) => (value.jobs.jobs[0].runner_group_id = 7),
    ],
    [
      "runner name spoof",
      (value: any) => (value.jobs.jobs[0].runner_name = "ubuntu-latest"),
    ],
    [
      "job source mismatch",
      (value: any) => (value.jobs.jobs[0].head_sha = attestorCommit),
    ],
    ["artifact replay", (value: any) => (value.artifact.workflow_run.id = 999)],
    [
      "artifact repository",
      (value: any) => (value.artifact.workflow_run.repository_id = 999),
    ],
    [
      "artifact head repository",
      (value: any) => (value.artifact.workflow_run.head_repository_id = 999),
    ],
    [
      "artifact branch",
      (value: any) => (value.artifact.workflow_run.head_branch = "other"),
    ],
    [
      "artifact commit",
      (value: any) => (value.artifact.workflow_run.head_sha = attestorCommit),
    ],
    ["expired artifact", (value: any) => (value.artifact.expired = true)],
    ["artifact ID", (value: any) => (value.artifact.id = 999)],
    [
      "artifact digest",
      (value: any) => (value.artifact.digest = `sha256:${"f".repeat(64)}`),
    ],
    ["source run status", (value: any) => (value.run.status = "queued")],
    [
      "source run conclusion",
      (value: any) => (value.run.conclusion = "failure"),
    ],
    ["source run ID", (value: any) => (value.run.id = 999)],
    [
      "artifact name",
      (value: any) => (value.artifact.name = "candidate-decoy"),
    ],
    [
      "archive substitution",
      (value: any) => (value.archive = Buffer.from("bad")),
    ],
  ])("rejects %s", async (_name, mutate) => {
    await expect(
      collectLiveCatalogClaim(configuration, fixture(mutate) as any),
    ).rejects.toThrow(/live_catalog_/u);
  });
});

describe("shared bounded GitHub transport", () => {
  it("streams bounded API JSON and rejects JSON redirects", async () => {
    const ok = vi.fn(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
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

  it("allows explicit storage redirects and strips cross-origin authorization", async () => {
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

  it("rejects redirect loops at the finite boundary", async () => {
    await expect(
      boundedGithubRequest(
        {
          path: "/download",
          token: "token",
          kind: "download",
          maximumBytes: 16,
          maximumRedirects: 1,
        },
        async () =>
          new Response(null, {
            status: 302,
            headers: {
              location: "https://objects.githubusercontent.com/loop",
            },
          }),
      ),
    ).rejects.toThrow("live_catalog_github_redirect_invalid");
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

  it("aborts once at timeout without retries", async () => {
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
