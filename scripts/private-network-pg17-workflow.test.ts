import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/private-network-pg17-rollout.yml";
const workflow = readFileSync(workflowPath, "utf8");
const runnerDockerfile = readFileSync(
  "deploy/private-runner/Dockerfile",
  "utf8",
);
const bootstrap = readFileSync("deploy/private-runner/bootstrap.mjs", "utf8");

function jobBlocks(source: string): string[] {
  return source
    .split(/^ {2}(?=[a-z][a-z0-9-]+:\n)/mu)
    .slice(1)
    .map((block) => `  ${block}`);
}

describe("private-network PG17 workflow contract", () => {
  it("allows GitHub-hosted jobs to perform Render control operations only", () => {
    const hosted = jobBlocks(workflow).filter((block) =>
      block.includes("runs-on: ubuntu-24.04"),
    );
    expect(hosted.length).toBeGreaterThanOrEqual(5);
    for (const block of hosted) {
      expect(block).not.toContain("DATABASE_URL");
      expect(block).not.toContain("psql");
      expect(block).not.toContain("pg_dump");
      expect(block).not.toContain("pg_restore");
    }
  });

  it("places every database URL on a unique private runner job", () => {
    const databaseJobs = jobBlocks(workflow).filter((block) =>
      block.includes("DATABASE_URL"),
    );
    expect(databaseJobs).toHaveLength(2);
    for (const block of databaseJobs) {
      expect(block).toContain("self-hosted");
      expect(block).toContain("needs.");
      expect(block).toContain("outputs.label");
      expect(block).toContain("persist-credentials: false");
    }
  });

  it("isolates role-bootstrap credential from migration and runtime", () => {
    const roleJob = jobBlocks(workflow).find((block) =>
      block.startsWith("  role-bootstrap-private:"),
    );
    const cutoverJob = jobBlocks(workflow).find((block) =>
      block.startsWith("  pg17-cutover-private:"),
    );
    expect(roleJob).toContain("environment: production-role-bootstrap");
    expect(roleJob).toContain("REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL");
    expect(cutoverJob).toContain("environment: production");
    expect(cutoverJob).not.toContain(
      "REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL",
    );
  });

  it("pins Actions and immutable runner artifact facts", () => {
    expect(workflow).not.toMatch(/uses: [^\n]+@(main|master|v\d+)/u);
    expect(workflow).toContain("REVIEW_ROUTER_RUNNER_BASE_DEPLOY_ID");
    expect(workflow).toContain("REVIEW_ROUTER_RUNNER_BASE_IMAGE_DIGEST");
    expect(workflow).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(workflow).toContain(
      'test "$GITHUB_SHA" = "$REVIEW_ROUTER_EXPECTED_SHA"',
    );
  });

  it("keeps the runner base free of database credentials", () => {
    expect(runnerDockerfile).not.toMatch(
      /DATABASE_URL|PGPASSWORD|postgresql:\/\//u,
    );
    expect(runnerDockerfile).toContain("GITHUB_ACTIONS_RUNNER_SHA256");
    expect(runnerDockerfile).toContain("sha256sum --check --strict");
  });

  it("removes bootstrap credentials before the workflow process", () => {
    const deleteOffset = bootstrap.indexOf("delete process.env[name]");
    const spawnOffset = bootstrap.indexOf("runOneJobRunner({");
    expect(deleteOffset).toBeGreaterThan(0);
    expect(spawnOffset).toBeGreaterThan(deleteOffset);
    expect(bootstrap).not.toMatch(/console\.|process\.stdout|process\.stderr/u);
  });

  it("retires all legacy GitHub-hosted DB workflow bodies", () => {
    for (const path of [
      ".github/workflows/codex-rotating-role-bootstrap.yml",
      ".github/workflows/codex-rotating-release-migration.yml",
      ".github/workflows/codex-rotating-rollout-evidence.yml",
    ]) {
      const alias = readFileSync(path, "utf8");
      expect(alias).toContain(
        "uses: ./.github/workflows/private-network-pg17-rollout.yml",
      );
      expect(alias).not.toContain("DATABASE_URL");
      expect(alias).not.toContain("runs-on: ubuntu");
    }
  });
});
