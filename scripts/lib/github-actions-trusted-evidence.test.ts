import { createHash } from "node:crypto";
import {
  assertTrustedGitHubEvidence,
  fetchTrustedGitHubEvidence,
  gitBlobSha,
} from "./github-actions-trusted-evidence.mjs";
import { describe, expect, it, vi } from "vitest";
import { claimTrustedMigrationEvidence } from "../deploy-render-hosted-beta.mjs";

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

function fixture() {
  const sourceBytes = Buffer.from("name: trusted\n");
  const expected = {
    token: "token-never-logged",
    repository: "777genius/review-router",
    repositoryId: "17",
    workflowPath: ".github/workflows/codex-rotating-release-migration.yml",
    workflowSha: gitBlobSha(sourceBytes),
    workflowRef: "a".repeat(40),
    runId: "101",
    runAttempt: "1",
    jobId: "202",
    jobName: "trusted-release-migration",
    artifactId: "303",
    artifactName: "reviewrouter-trusted-rollout-101-1",
    headSha: "a".repeat(40),
    rolloutId: "rollout-unique-1",
  };
  const evidence = {
    version: 4,
    rolloutId: expected.rolloutId,
    execution: {
      repositoryId: "17",
      repositoryFullName: "777genius/review-router",
      workflowPath: expected.workflowPath,
      workflowSha: expected.workflowSha,
      workflowRef: expected.workflowRef,
      runId: "101",
      runAttempt: 1,
      jobId: "202",
      jobName: expected.jobName,
      artifactName: expected.artifactName,
      headSha: expected.headSha,
    },
    release: {
      commit: expected.headSha,
      imageDigest: `sha256:${"b".repeat(64)}`,
    },
  };
  const archive = zip({
    "reviewrouter-trusted-rollout-evidence.json": Buffer.from(
      JSON.stringify(evidence),
    ),
  });
  const bodies: Record<string, unknown> = {
    repository: { id: 17, full_name: expected.repository },
    run: {
      id: 101,
      repository: { id: 17 },
      head_repository: { id: 17 },
      path: expected.workflowPath,
      head_sha: expected.headSha,
      run_attempt: 1,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
    },
    jobs: {
      total_count: 1,
      jobs: [
        {
          id: 202,
          run_id: 101,
          run_attempt: 1,
          name: expected.jobName,
          head_sha: expected.headSha,
          status: "completed",
          conclusion: "success",
        },
      ],
    },
    artifact: {
      id: 303,
      name: expected.artifactName,
      workflow_run: { id: 101 },
      expired: false,
      digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
      created_at: "2026-08-11T00:00:00.000Z",
    },
    source: {
      path: expected.workflowPath,
      sha: expected.workflowSha,
      type: "file",
    },
  };
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("/zip"))
      return {
        ok: true,
        status: 200,
        url: "https://artifact.actions.githubusercontent.com/archive.zip",
        arrayBuffer: async () => archive,
      };
    const key = url.includes("/jobs?")
      ? "jobs"
      : url.includes("/artifacts/")
        ? "artifact"
        : url.includes("/contents/")
          ? "source"
          : url.includes("/actions/runs/")
            ? "run"
            : "repository";
    return {
      ok: true,
      status: 200,
      url,
      text: async () => JSON.stringify(bodies[key]),
    };
  });
  return {
    archive,
    bodies,
    evidence,
    expected: {
      ...expected,
      now: Date.parse("2026-08-11T01:00:00.000Z"),
    },
    fetchImpl,
  };
}

describe("authenticated GitHub Actions rollout evidence", () => {
  it("accepts only the exact immutable run, job, source, and artifact digest", async () => {
    const value = fixture();
    const trusted = await fetchTrustedGitHubEvidence(
      value.expected,
      value.fetchImpl as never,
    );
    expect(assertTrustedGitHubEvidence(trusted).evidence).toEqual(
      value.evidence,
    );
    expect(value.fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("claims the authenticated artifact once without placing database secrets in argv", async () => {
    const value = fixture();
    const trusted = await fetchTrustedGitHubEvidence(
      value.expected,
      value.fetchImpl as never,
    );
    const execute = vi.fn().mockReturnValue({ status: 0, stdout: "claimed\n" });
    claimTrustedMigrationEvidence(
      "postgresql://reviewrouter_release_migration:database-secret@db.internal/review_router",
      trusted,
      execute,
    );
    expect(JSON.stringify(execute.mock.calls[0][1])).not.toContain(
      "database-secret",
    );
    expect(execute.mock.calls[0][2].input).toContain(
      "reviewrouter_bootstrap.consume_migration_evidence",
    );
    execute.mockReturnValueOnce({ status: 1, stdout: "" });
    expect(() =>
      claimTrustedMigrationEvidence(
        "postgresql://reviewrouter_release_migration:database-secret@db.internal/review_router",
        trusted,
        execute,
      ),
    ).toThrow("claim failed or was replayed");
  });

  it("rejects fabricated local JSON without an authenticated provider observation", () => {
    expect(() =>
      assertTrustedGitHubEvidence({ evidence: fixture().evidence }),
    ).toThrow("not bound to an authenticated GitHub artifact observation");
  });

  it.each([
    [
      "wrong repository",
      (f: ReturnType<typeof fixture>) => ((f.bodies.repository as any).id = 99),
      "repository identity",
    ],
    [
      "wrong workflow",
      (f: ReturnType<typeof fixture>) =>
        ((f.bodies.run as any).path = ".github/workflows/other.yml"),
      "workflow run identity",
    ],
    [
      "replayed commit",
      (f: ReturnType<typeof fixture>) =>
        ((f.bodies.run as any).head_sha = "b".repeat(40)),
      "workflow run identity",
    ],
    [
      "wrong job",
      (f: ReturnType<typeof fixture>) =>
        ((f.bodies.jobs as any).jobs[0].id = 999),
      "workflow job identity",
    ],
    [
      "wrong artifact",
      (f: ReturnType<typeof fixture>) => ((f.bodies.artifact as any).id = 999),
      "artifact identity",
    ],
    [
      "wrong workflow SHA",
      (f: ReturnType<typeof fixture>) =>
        ((f.bodies.source as any).sha = "b".repeat(40)),
      "workflow source identity",
    ],
    [
      "artifact digest mismatch",
      (f: ReturnType<typeof fixture>) =>
        ((f.bodies.artifact as any).digest = `sha256:${"f".repeat(64)}`),
      "artifact digest mismatch",
    ],
    [
      "replayed artifact",
      (f: ReturnType<typeof fixture>) =>
        ((f.bodies.artifact as any).created_at = "2026-08-01T00:00:00.000Z"),
      "stale or replayed",
    ],
  ])("fails closed for %s", async (_name, mutate, message) => {
    const value = fixture();
    mutate(value);
    await expect(
      fetchTrustedGitHubEvidence(value.expected, value.fetchImpl as never),
    ).rejects.toThrow(message);
  });
});
