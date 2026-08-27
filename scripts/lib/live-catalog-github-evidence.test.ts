import { describe, expect, it } from "vitest";
import { gitBlobSha } from "./github-actions-trusted-evidence.mjs";
import { collectLiveCatalogClaim } from "./live-catalog-github-evidence.mjs";
import { sha256Hex } from "./live-catalog-attestation-domain.mjs";

const sourceCommit = "a".repeat(40);
const attestorCommit = "b".repeat(40);
const tree = "c".repeat(40);
const prefix = "/repos/owner/repo";
const projection = Buffer.from(
  `export const fencedLiveV70V73CatalogDigestSql = \`SELECT 'ok'\`;\n` +
    `export const liveV70V73CatalogDigestSha256 = "sha256:${"1".repeat(64)}";\n`,
);
const workflow = Buffer.from(`jobs:
  release-authority-pg17-contract:
    env:
      REVIEW_ROUTER_PG17_ADVERSARIAL_IMAGE: postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4
  quality:
    services:
      postgres:
        image: postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4
`);
const candidate = Buffer.from(
  JSON.stringify({
    kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
    version: 1,
    policies: { preactivation: { value: 1 }, activated: { value: 1 } },
  }),
);
const log = Buffer.from(
  `Quality Gates\tStop containers\t2026-08-26T22:49:15.6169885Z  ` +
    `2026-08-26 22:49:13.883 UTC [2032] DETAIL:  expected=sha256:${"1".repeat(64)} ` +
    `observed=sha256:${"2".repeat(64)}\n`,
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
  });
  const values: Record<string, any> = {
    repository: { id: 17, full_name: "Owner/Repo" },
    main: { name: "main", protected: true, commit: { sha: attestorCommit } },
    run: {
      id: 101,
      run_attempt: 1,
      event: "workflow_dispatch",
      path: ".github/workflows/ci.yml",
      head_branch: "fix/pr227-r41-ci-remediation",
      head_sha: sourceCommit,
      status: "completed",
      conclusion: "success",
      repository: { id: 17 },
      head_repository: { id: 17 },
    },
    jobs: {
      total_count: 2,
      jobs: [
        {
          id: 201,
          run_id: 101,
          run_attempt: 1,
          name: "Quality Gates",
          status: "completed",
          conclusion: "success",
          labels: ["ubuntu-latest"],
          runner_group_name: null,
        },
        {
          id: 202,
          run_id: 101,
          run_attempt: 1,
          name: "Dedicated Release Authority PG17 contract",
          status: "completed",
          conclusion: "success",
          labels: ["ubuntu-latest"],
          runner_group_name: null,
        },
      ],
    },
    artifact: {
      id: 301,
      name: `activation-catalog-policy-${sourceCommit}-1`,
      workflow_run: { id: 101 },
      expired: false,
      digest: `sha256:${sha256Hex(archive)}`,
    },
    commit: { sha: sourceCommit, tree: { sha: tree } },
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
    [`${prefix}/actions/runs/101`, values.run],
    [`${prefix}/actions/runs/101/jobs?filter=latest&per_page=100`, values.jobs],
    [`${prefix}/actions/artifacts/301`, values.artifact],
    [`${prefix}/git/commits/${sourceCommit}`, values.commit],
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
    [`${prefix}/actions/jobs/201/logs`, log],
    [`${prefix}/actions/artifacts/301/zip`, values.archive],
  ]);
  const fetchImpl = async (url: string) => {
    const path = new URL(url).pathname + new URL(url).search;
    const download = downloads.get(path);
    const body = download ?? Buffer.from(JSON.stringify(bodies.get(path)));
    return {
      ok: download !== undefined || bodies.has(path),
      status: download !== undefined || bodies.has(path) ? 200 : 404,
      url: download
        ? "https://objects.githubusercontent.com/reviewrouter/evidence"
        : url,
      text: async () => body.toString("utf8"),
      arrayBuffer: async () => body,
    } as any;
  };
  return fetchImpl;
}

const configuration = {
  repository: "owner/repo",
  token: "token",
  runId: 101,
  artifactId: 301,
  qualityJobId: 201,
  pg17JobId: 202,
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
      branch: "fix/pr227-r41-ci-remediation",
    });
    expect(result.claim.execution.qualityJob.id).toBe("201");
    expect(result.claim.execution.pg17Job.id).toBe("202");
    expect(result.evidence.workflowSourceBytes).toEqual(workflow);
    expect(result.evidence.projectionSourceBytes).toEqual(projection);
  });

  it.each([
    ["unprotected main", (value: any) => (value.main.protected = false)],
    ["stale attestor", (value: any) => (value.main.commit.sha = sourceCommit)],
    ["source retry", (value: any) => (value.run.run_attempt = 2)],
    ["pull request source", (value: any) => (value.run.event = "pull_request")],
    [
      "failed Quality",
      (value: any) => (value.jobs.jobs[0].conclusion = "failure"),
    ],
    [
      "self-hosted PG17",
      (value: any) => value.jobs.jobs[1].labels.push("self-hosted"),
    ],
    ["artifact replay", (value: any) => (value.artifact.workflow_run.id = 999)],
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
