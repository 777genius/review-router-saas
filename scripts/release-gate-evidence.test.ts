import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  findAndVerifyReleaseGate,
  releaseGateContract,
  verifyReleaseGateRun,
} from "./release-gate-evidence.mjs";

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(name: string, value: Buffer) {
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(value), 14);
  local.writeUInt32LE(value.length, 18);
  local.writeUInt32LE(value.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(value), 16);
  central.writeUInt32LE(value.length, 20);
  central.writeUInt32LE(value.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + value.length, 16);
  return Buffer.concat([local, nameBytes, value, central, nameBytes, end]);
}

function fixture() {
  const commit = "a".repeat(40);
  const repository = "777genius/review-router-saas";
  const runId = 101;
  const runAttempt = 2;
  const archives = new Map<number, Buffer>();
  const jobs = releaseGateContract.jobs.map((contract, index) => ({
    id: 201 + index,
    run_id: runId,
    run_attempt: runAttempt,
    name: contract.jobName,
    head_sha: commit,
    status: "completed",
    conclusion: "success",
  }));
  const artifacts = releaseGateContract.jobs.map((contract, index) => {
    const artifactId = 301 + index;
    const artifactName = `${contract.artifactPrefix}${commit}`;
    const manifest = {
      schemaVersion: releaseGateContract.schemaVersion,
      gate: contract.gate,
      repository,
      commit,
      runId: String(runId),
      runAttempt,
      jobName: contract.jobName,
      artifactName,
    };
    const archive = zip(
      "release-gate-evidence.json",
      Buffer.from(JSON.stringify(manifest)),
    );
    archives.set(artifactId, archive);
    return {
      id: artifactId,
      name: artifactName,
      workflow_run: { id: runId, head_sha: commit },
      expired: false,
      digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    };
  });
  const bodies = {
    repository: { id: 17, full_name: repository },
    run: {
      id: runId,
      repository: { id: 17 },
      head_repository: { id: 17 },
      path: releaseGateContract.workflowPath,
      head_branch: "main",
      head_sha: commit,
      run_attempt: runAttempt,
      event: "push",
      status: "completed",
      conclusion: "success",
    },
    jobs: { total_count: jobs.length, jobs },
    artifacts: { total_count: artifacts.length, artifacts },
    inventory: {
      total_count: 1,
      workflow_runs: [
        {
          id: runId,
          head_branch: "main",
          head_sha: commit,
          status: "completed",
          conclusion: "success",
        },
      ],
    },
  };
  const fetchImpl = vi.fn(async (url: string) => {
    const artifactId = /\/actions\/artifacts\/(\d+)\/zip$/u.exec(url)?.[1];
    if (artifactId) {
      const archive = archives.get(Number(artifactId))!;
      return {
        ok: true,
        status: 200,
        url: `https://release-assets.githubusercontent.com/${artifactId}.zip`,
        arrayBuffer: async () => archive,
      };
    }
    const body = url.includes("/workflows/ci.yml/runs?")
      ? bodies.inventory
      : url.includes("/jobs?")
        ? bodies.jobs
        : url.includes("/artifacts?")
          ? bodies.artifacts
          : url.includes("/actions/runs/")
            ? bodies.run
            : bodies.repository;
    return {
      ok: true,
      status: 200,
      url,
      text: async () => JSON.stringify(body),
    };
  });
  return {
    artifacts,
    bodies,
    configuration: { repository, token: "token", commit, runId },
    fetchImpl,
  };
}

describe("production release-gate evidence", () => {
  it("discovers and accepts a complete successful run for the exact release SHA", async () => {
    const value = fixture();
    await expect(
      findAndVerifyReleaseGate(
        {
          repository: value.configuration.repository,
          token: value.configuration.token,
          commit: value.configuration.commit,
        },
        value.fetchImpl as never,
      ),
    ).resolves.toMatchObject({
      commit: value.configuration.commit,
      runId: String(value.configuration.runId),
    });
  });

  it("accepts successful exact-SHA jobs and immutable artifacts from one exact run", async () => {
    const value = fixture();
    await expect(
      verifyReleaseGateRun(value.configuration, value.fetchImpl as never),
    ).resolves.toMatchObject({
      commit: value.configuration.commit,
      runId: String(value.configuration.runId),
      receipts: [{ artifactId: "301" }, { artifactId: "302" }],
    });
  });

  it("rejects a CI run whose mandatory job was skipped", async () => {
    const value = fixture();
    value.bodies.jobs.jobs[0]!.conclusion = "skipped";
    await expect(
      verifyReleaseGateRun(value.configuration, value.fetchImpl as never),
    ).rejects.toThrow("exact job did not succeed");
  });

  it("rejects stale-SHA evidence", async () => {
    const value = fixture();
    value.bodies.run.head_sha = "b".repeat(40);
    await expect(
      verifyReleaseGateRun(value.configuration, value.fetchImpl as never),
    ).rejects.toThrow("workflow run identity or result mismatch");
  });

  it("rejects an artifact attached to the wrong workflow run", async () => {
    const value = fixture();
    value.artifacts[0]!.workflow_run.id = 999;
    await expect(
      verifyReleaseGateRun(value.configuration, value.fetchImpl as never),
    ).rejects.toThrow("artifact identity is invalid");
  });

  it("rejects a failed mandatory job even when the overall run claims success", async () => {
    const value = fixture();
    value.bodies.jobs.jobs[1]!.conclusion = "failure";
    await expect(
      verifyReleaseGateRun(value.configuration, value.fetchImpl as never),
    ).rejects.toThrow("exact job did not succeed");
  });

  it("rejects a missing exact artifact", async () => {
    const value = fixture();
    value.bodies.artifacts.artifacts.pop();
    value.bodies.artifacts.total_count -= 1;
    await expect(
      verifyReleaseGateRun(value.configuration, value.fetchImpl as never),
    ).rejects.toThrow("exact artifact is missing");
  });

  it("rejects missing exact-SHA release evidence", async () => {
    const value = fixture();
    value.bodies.inventory.workflow_runs = [];
    value.bodies.inventory.total_count = 0;
    await expect(
      findAndVerifyReleaseGate(
        {
          repository: value.configuration.repository,
          token: value.configuration.token,
          commit: value.configuration.commit,
        },
        value.fetchImpl as never,
      ),
    ).rejects.toThrow("has no successful CI run");
  });
});

describe("release workflow contract", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const gitlabImage = readFileSync(
    ".github/workflows/gitlab-runtime-image.yml",
    "utf8",
  );
  const release = readFileSync(".github/workflows/release.yml", "utf8");

  it("runs expensive PostgreSQL gates once on trusted main pushes and skips fork PRs", () => {
    expect(
      ci.match(
        /if: \$\{\{ github\.event_name == 'push' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.[^)]+\) \}\}/gu,
      ),
    ).toHaveLength(2);
    expect(ci).toContain(
      "node scripts/release-gate-evidence.mjs write release-authority-pg17-contract",
    );
    expect(ci).toContain(
      "node scripts/release-gate-evidence.mjs write private-pg16-to-pg17-rehearsal",
    );
    for (const jobId of [
      "release-authority-pg17-contract",
      "private-pg16-to-pg17-rehearsal",
    ]) {
      const start = ci.indexOf(`  ${jobId}:`);
      const end = ci.indexOf("\n  ", start + 3);
      const job = ci.slice(start, end);
      expect(job).not.toMatch(
        /uses: actions\/(?:checkout|setup-node|upload-artifact)@v\d/gu,
      );
    }
  });

  it("verifies exact evidence before any production image can be published", () => {
    const gate = release.indexOf(
      "node scripts/release-gate-evidence.mjs verify",
    );
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(
      release.indexOf("Build and publish immutable hosted runtime image"),
    );
    expect(release).not.toContain("gh run list");

    const gitlabGate = gitlabImage.indexOf(
      "node scripts/release-gate-evidence.mjs verify",
    );
    expect(gitlabGate).toBeGreaterThan(0);
    expect(gitlabGate).toBeLessThan(gitlabImage.indexOf("Build and push"));
    expect(gitlabImage).toContain("actions: read");
    expect(gitlabImage).not.toMatch(/uses: [^@\n]+@v\d/gu);
  });
});
