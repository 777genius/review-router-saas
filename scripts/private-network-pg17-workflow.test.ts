import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  ".github/workflows/private-network-pg17-rollout.yml",
  "utf8",
);
const controller = readFileSync(
  ".github/workflows/private-pg17-runner-controller.yml",
  "utf8",
);
const dockerfile = readFileSync("deploy/private-runner/Dockerfile", "utf8");
const bootstrap = readFileSync("deploy/private-runner/bootstrap.mjs", "utf8");
const launcher = readFileSync(
  "deploy/private-runner/launch-and-cleanup.mjs",
  "utf8",
);
function jobs(source: string): string[] {
  return source
    .split(/^ {2}(?=[a-z][a-z0-9-]+:\n)/mu)
    .slice(1)
    .map((block) => `  ${block}`);
}

describe("private-network PG17 workflow security contract", () => {
  it("keeps database credentials exclusively on exact execution steps of runner-group jobs", () => {
    const databaseJobs = jobs(workflow).filter((block) =>
      block.includes("DATABASE_URL"),
    );
    expect(databaseJobs).toHaveLength(2);
    for (const block of databaseJobs) {
      expect(block).toContain(
        "group: ${{ vars.REVIEW_ROUTER_RUNNER_GROUP_NAME }}",
      );
      expect(block.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(
        block.indexOf("REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL:"),
      );
      expect(block.slice(0, block.indexOf("steps:"))).not.toContain("secrets.");
    }
    for (const block of jobs(workflow).filter((item) =>
      item.includes("runs-on: ubuntu-24.04"),
    )) {
      expect(block).not.toContain("DATABASE_URL");
      expect(block).not.toMatch(/\bpsql\b|\bpg_dump\b|\bpg_restore\b/u);
    }
  });

  it("uses a workflow_job controller so exact queued job identity exists before JIT generation", () => {
    expect(controller).toContain("workflow_job:");
    expect(controller).toContain("types: [queued, completed]");
    expect(controller).toContain(
      "REVIEW_ROUTER_TARGET_WORKFLOW_JOB_ID: ${{ github.event.workflow_job.id }}",
    );
    expect(controller).toContain("REVIEW_ROUTER_RUNNER_GROUP_ID");
    expect(controller).toContain("cleanup-runners");
    expect(workflow).not.toContain("outputs.label");
  });

  it("fails closed on control-repository, protected environment, retry, and unique rollout preconditions", () => {
    expect(workflow).toContain(
      "run-name: private-pg17:${{ inputs.rollout_id }}",
    );
    expect(workflow).toContain("production-release-preflight");
    expect(workflow).toContain("observe-private-pg17-protected-environment.ts");
    expect(workflow).toContain("REVIEW_ROUTER_RELEASE_CONTROL_REPOSITORY");
    expect(workflow).toContain("cancel-in-progress: false");
  });

  it("splits runner control, provenance read, and service suspension credentials", () => {
    expect(workflow).toContain("RENDER_RUNNER_CONTROL_API_KEY");
    expect(workflow).toContain("RENDER_PROVENANCE_READ_API_KEY");
    expect(workflow).toContain("RENDER_SERVICE_SUSPENSION_API_KEY");
    const finalize = jobs(workflow).find((block) =>
      block.startsWith("  finalize-trusted-rollout:"),
    )!;
    expect(finalize).not.toContain("RENDER_RUNNER_CONTROL_API_KEY");
    expect(finalize).not.toContain("DATABASE_URL");
  });

  it("runs cleanup before target resume/live canary/evidence and always reconciles compensation", () => {
    expect(workflow.indexOf("await-cutover-runner-cleanup:")).toBeLessThan(
      workflow.indexOf("finalize-trusted-rollout:"),
    );
    expect(workflow).toContain("finalize-private-pg17-rollout.ts");
    expect(workflow).toContain("if: ${{ always() }}");
    expect(workflow).toContain("always-reconcile-runners-and-compensation");
  });

  it("uses only SHA-pinned actions and preserves the opt-in legacy workflow contracts", () => {
    expect(`${workflow}\n${controller}`).not.toMatch(
      /uses: [^\n]+@(main|master|v\d+)/u,
    );
    for (const path of [
      ".github/workflows/codex-rotating-role-bootstrap.yml",
      ".github/workflows/codex-rotating-release-migration.yml",
      ".github/workflows/codex-rotating-rollout-evidence.yml",
    ]) {
      expect(existsSync(path)).toBe(true);
      const legacy = readFileSync(path, "utf8");
      expect(legacy).toContain("workflow_dispatch:");
      expect(legacy).toContain("runs-on: ubuntu-24.04");
      expect(legacy).not.toContain("private-network-pg17-rollout.yml");
    }
  });

  it("pins base image and runner download, and never supplies the App private key by env", () => {
    expect(dockerfile).toMatch(
      /^FROM node:24-bookworm-slim@sha256:[a-f0-9]{64}/mu,
    );
    expect(dockerfile).toContain("GITHUB_ACTIONS_RUNNER_SHA256");
    expect(dockerfile).toContain("sha256sum --check --strict");
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
    expect(dockerfile).toContain("snapshot.debian.org");
    expect(dockerfile).not.toContain("npm install --no-save");
    expect(bootstrap).toContain(
      "REVIEW_ROUTER_RUNNER_GITHUB_APP_PRIVATE_KEY_FILE",
    );
    expect(bootstrap).toContain(
      "private_runner_private_key_environment_forbidden",
    );
    expect(bootstrap).toContain("process.execve");
    expect(launcher).toContain('runnerPath: "/runner/bin/Runner.Listener"');
    expect(launcher).toContain("cleanupRunnerWorkspace");
    expect(launcher.indexOf("cleanupRunnerWorkspace")).toBeLessThan(
      launcher.indexOf("process.stdout.write"),
    );
  });

  it("mints the control-repository token with only the org runner permissions required by JIT bootstrap", () => {
    expect(bootstrap).toContain(
      'repositories: [String(context.repository).split("/")[1]]',
    );
    expect(bootstrap).toContain('organization_self_hosted_runners: "write"');
    expect(bootstrap).toContain('actions: "read"');
    expect(bootstrap).toContain('metadata: "read"');
    expect(bootstrap).not.toMatch(/\badministration\s*:/u);
  });

  it("keeps the JIT configuration out of persisted registration metadata", () => {
    expect(bootstrap).toContain("const registrationMetadata = Object.freeze({");
    expect(bootstrap).toContain("registration: registrationMetadata");
    expect(bootstrap).toContain(
      "writeFileSync(jitPath, registration.encodedJitConfig",
    );
    expect(bootstrap).not.toContain("registration: registration,");
  });
});
