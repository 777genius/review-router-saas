import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCompensationSourceWriterServiceIds } from "./reconcile-private-pg17-compensation-config";
import { parseFreezeSourceWriterServiceIds } from "./release-rollout-render-control-config";

const workflow = readFileSync(
  ".github/workflows/private-network-pg17-rollout.yml",
  "utf8",
);
const controller = readFileSync(
  ".github/workflows/private-pg17-runner-controller.yml",
  "utf8",
);
const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
const releaseImageVerifier = readFileSync(
  "scripts/verify-private-pg17-release-image-provenance.ts",
  "utf8",
);
const rolloutRunbook = readFileSync(
  "docs/operations/private-pg17-release-rollout.md",
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

type StepConclusion = "success" | "failure";

function namedSteps(job: string): readonly Readonly<{
  name: string;
  condition: "always" | "success";
}>[] {
  return job
    .split(/^ {6}- /mu)
    .slice(1)
    .map((block) => {
      const name =
        /^(?:name: ([^\n]+)|uses: ([^@\n]+)|run: ([^\n]+)|id: ([^\n]+))/u.exec(
          block,
        );
      if (!name) throw new Error("workflow_test_step_name_missing");
      const condition = /^\s*if:\s*(.+)$/mu.exec(block)?.[1]?.trim();
      if (
        condition &&
        !/^(?:\$\{\{\s*)?always\(\)(?:\s*&&[\s\S]+)?\s*(?:\}\})?$/u.test(
          condition,
        )
      )
        throw new Error(
          `workflow_test_step_condition_unsupported:${condition}`,
        );
      return {
        name: name[1] ?? name[2] ?? name[3] ?? name[4]!,
        condition: condition ? ("always" as const) : ("success" as const),
      };
    });
}

function executeStepComposition(
  steps: ReturnType<typeof namedSteps>,
  conclusions: Readonly<Record<string, StepConclusion>>,
) {
  let jobFailed = false;
  const executed: string[] = [];
  for (const step of steps) {
    if (step.condition === "success" && jobFailed) continue;
    executed.push(step.name);
    if (conclusions[step.name] === "failure") jobFailed = true;
  }
  return {
    conclusion: jobFailed ? ("failure" as const) : ("success" as const),
    executed,
  };
}

describe("private-network PG17 workflow security contract", () => {
  it("documents a valid exact release run and artifact dispatch", () => {
    expect(rolloutRunbook).toContain('-f release_run_id="$RELEASE_RUN_ID"');
    expect(rolloutRunbook).toContain(
      '-f release_artifact_id="$RELEASE_ARTIFACT_ID"',
    );
    expect(rolloutRunbook).toContain("actions/runs/$RELEASE_RUN_ID/attempts/1");
    expect(rolloutRunbook).toContain("actions/artifacts/$RELEASE_ARTIFACT_ID");
    expect(rolloutRunbook).toContain(
      ".github/workflows/release.yml\tworkflow_dispatch\t1\t$EXPECTED_SHA\tsuccess",
    );
    expect(rolloutRunbook).toContain("$RELEASE_RUN_ID\t$EXPECTED_SHA\tfalse");
  });

  it("scheduled and manual recovery redrive exact authority-backed compensation after cleanup", () => {
    const recovery = jobs(controller).find((job) =>
      job.startsWith("  recover:"),
    )!;
    expect(controller).toContain("github.event_name == 'schedule'");
    expect(controller).toContain("github.event_name == 'workflow_dispatch'");
    expect(recovery).toContain("ref: ${{ matrix.target.head_sha }}");
    expect(recovery).toContain("run-id: ${{ matrix.target.run_id }}");
    expect(recovery).toContain(
      "protected-preflight-${{ steps.context.outputs.rollout_id }}-${{ matrix.target.run_id }}-1",
    );
    expect(recovery.indexOf("cleanup-runners")).toBeLessThan(
      recovery.indexOf("reconcile-private-pg17-compensation.ts"),
    );
    expect(recovery).toContain("REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN:");
    expect(recovery).toContain("REVIEW_ROUTER_RUNNER_LEDGER_URL:");
    expect(recovery).toContain(
      "REVIEW_ROUTER_INITIAL_ROLLOUT_FILE: artifacts/preflight/initial-rollout.json",
    );
    expect(workflow).toMatch(
      /name: protected-preflight-\$\{\{ inputs\.rollout_id \}\}-\$\{\{ github\.run_id \}\}-1[\s\S]*?retention-days: 90/u,
    );
    expect(recovery).not.toContain("initialize-private-pg17-rollout.ts");
    expect(recovery).not.toContain("workflow_dispatches");
  });

  it("does not redrive compensation when safe runner cleanup is incomplete", () => {
    const recovery = jobs(controller).find((job) =>
      job.startsWith("  recover:"),
    )!;
    const result = executeStepComposition(namedSteps(recovery), {
      "Reconcile every known or late provider runner with bounded backoff":
        "failure",
    });

    expect(result.executed).not.toContain(
      "Redrive exact durable rollout compensation through authority",
    );
    expect(result.executed).toContain("actions/upload-artifact");
    expect(result.conclusion).toBe("failure");
  });

  it("cryptographically binds the deployed image to the exact release commit before mutation", () => {
    const preflight = jobs(workflow).find((job) =>
      job.startsWith("  protected-preflight:"),
    )!;
    expect(workflow).toContain("release_run_id:");
    expect(workflow).toContain("release_artifact_id:");
    expect(preflight).toContain(
      "artifact-ids: ${{ inputs.release_artifact_id }}",
    );
    expect(preflight).toContain("run-id: ${{ inputs.release_run_id }}");
    expect(preflight).toContain(
      "verify-private-pg17-release-image-provenance.ts",
    );
    expect(preflight.indexOf("Verify release image identity")).toBeLessThan(
      preflight.indexOf("Durably claim rollout"),
    );
    expect(workflow.indexOf("protected-preflight:")).toBeLessThan(
      workflow.indexOf("freeze-source-writers:"),
    );
    expect(workflow).not.toContain("vars.REVIEW_ROUTER_RELEASE_IMAGE_DIGEST");
    expect(workflow).toContain("attestations: read");
    expect(releaseWorkflow).toContain("attestations: write");
    expect(releaseWorkflow).toContain("id-token: write");
    expect(releaseWorkflow).toContain("actions/attest-build-provenance@");
    expect(releaseWorkflow).toContain(
      "subject-path: hosted-runtime-image.json",
    );
    expect(releaseImageVerifier).toContain('"--source-digest"');
    expect(releaseImageVerifier).toContain('"--source-ref"');
    expect(releaseImageVerifier).toContain('"--signer-workflow"');
    expect(releaseImageVerifier).toContain(
      "identity.commit !== expectedCommit",
    );
    expect(releaseImageVerifier).toContain(
      "artifact.workflow_run.head_sha !== expectedCommit",
    );
    expect(releaseImageVerifier).toContain("run.head_sha !== expectedCommit");
    expect(releaseImageVerifier).toContain("AbortSignal.timeout(30_000)");
    expect(releaseImageVerifier).toContain("timeout: 120_000");
    const rolloutScript = readFileSync(
      "scripts/run-private-pg17-rollout.ts",
      "utf8",
    );
    expect(rolloutScript).toContain(
      "canonical.activateTarget(\n        canonicalReleaseEnvironment,",
    );
    const cutover = jobs(workflow).find((job) =>
      job.startsWith("  pg17-cutover-private:"),
    )!;
    const finalize = jobs(workflow).find((job) =>
      job.startsWith("  finalize-trusted-rollout:"),
    )!;
    for (const job of [cutover, finalize]) {
      expect(job).toContain("verified-release-image-provenance.json");
      expect(job).toContain("REVIEW_ROUTER_RELEASE_IMAGE_PROVENANCE_FILE:");
    }
  });
  it("uses one canonical source-writer value through freeze and compensation", () => {
    const workflowValue = '["srv-api123","srv-worker456"]';
    const workflowEnvironment = {
      REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS: workflowValue,
    };

    expect(
      parseFreezeSourceWriterServiceIds(
        workflowEnvironment.REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS,
      ),
    ).toEqual(["srv-api123", "srv-worker456"]);
    expect(
      parseCompensationSourceWriterServiceIds(
        workflowEnvironment.REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS,
      ),
    ).toEqual(["srv-api123", "srv-worker456"]);
    expect(
      workflow.match(
        /REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS: \$\{\{ vars\.REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS \}\}/gu,
      ),
    ).toHaveLength(4);
  });
  it("binds freeze mutations to the durably claimed rollout", () => {
    const freeze = jobs(workflow).find((job) =>
      job.startsWith("  freeze-source-writers:"),
    );
    expect(freeze).toBeDefined();
    expect(freeze).toContain("actions/download-artifact@");
    expect(freeze).toContain(
      "REVIEW_ROUTER_INITIAL_ROLLOUT_FILE: preflight/initial-rollout.json",
    );
    expect(freeze).toContain(
      "REVIEW_ROUTER_RUNNER_LEDGER_TOKEN: ${{ secrets.REVIEW_ROUTER_RELEASE_CONTROL_TOKEN }}",
    );
  });
  it("keeps database credentials exclusively on exact execution steps of runner-group jobs", () => {
    const databaseJobs = jobs(workflow).filter((block) =>
      block.includes("DATABASE_URL"),
    );
    expect(databaseJobs).toHaveLength(3);
    for (const block of databaseJobs.filter(
      (block) => !block.startsWith("  always-reconcile:"),
    )) {
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
      if (block.startsWith("  always-reconcile:")) {
        expect(
          block.match(/REVIEW_ROUTER_SOURCE_DATABASE_URL:/gu),
        ).toHaveLength(1);
        expect(block).not.toContain("REVIEW_ROUTER_TARGET_DATABASE_URLS_JSON:");
      } else expect(block).not.toContain("DATABASE_URL");
      expect(block).not.toMatch(/\bpsql\b|\bpg_dump\b|\bpg_restore\b/u);
    }
  });

  it("uses workflow_run and bounded exact-job polling before JIT generation", () => {
    expect(controller).toContain("workflow_run:");
    expect(controller).toContain(
      "workflows: [Private-network PostgreSQL 17 release rollout]",
    );
    expect(controller).toContain("types: [requested, completed]");
    expect(controller).not.toContain("workflow_job:");
    expect(controller).not.toContain("github.event.workflow_job");
    expect(controller).toContain(
      "REVIEW_ROUTER_TARGET_RUN_ID: ${{ github.event.workflow_run.id }}",
    );
    expect(controller).toContain("REVIEW_ROUTER_TARGET_JOB_POLL_ATTEMPTS: 600");
    expect(controller).toContain("job_name: copy-and-role-bootstrap-private");
    expect(controller).toContain("job_name: pg17-cutover-private");
    expect(
      readFileSync("scripts/resolve-private-pg17-run-context.ts", "utf8"),
    ).toContain('repositoryIdentity.default_branch !== "main"');
    expect(controller).toContain("REVIEW_ROUTER_RUNNER_GROUP_ID");
    expect(controller).toContain("cleanup-runners");
    expect(controller).toContain("REVIEW_ROUTER_RECONCILIATION_ATTEMPTS: 8");
    expect(controller).toContain(
      "REVIEW_ROUTER_RECONCILIATION_MAXIMUM_DELAY_MS: 30000",
    );
    expect(controller).toContain("runner-cleanup-reconciliation.json");
    expect(workflow).not.toContain("outputs.label");
    expect(controller).toContain(
      "REVIEW_ROUTER_RUNNER_WITNESS_URL: ${{ vars.REVIEW_ROUTER_RELEASE_WITNESS_URL }}",
    );
    expect(controller).not.toContain("vars.REVIEW_ROUTER_RUNNER_WITNESS_URL");
  });

  it("provides durable scheduled and exact manual late-job recovery", () => {
    expect(controller).toContain('cron: "17,47 * * * *"');
    expect(controller).toContain("target_run_id:");
    expect(controller).toContain("recovery-context:");
    expect(controller).toContain("discover-private-pg17-recovery-runs.ts");
    expect(controller).toContain("sweep_checkpoint:");
    expect(controller).toContain("continue-recovery-sweep:");
    expect(controller).toContain(
      "dispatch-private-pg17-recovery-continuation.ts",
    );
    expect(controller).toContain(
      "needs.recovery-context.outputs.complete == 'false'",
    );
    expect(controller).not.toContain(
      "needs.recover.result == 'success' || needs.recover.result == 'skipped'",
    );
    expect(controller).toContain(
      "REVIEW_ROUTER_RECOVERY_WINDOW_RESULT: ${{ needs.recover.result }}",
    );
    expect(controller).toContain("actions: write");
    expect(controller).toContain("REVIEW_ROUTER_RECOVERY_MAXIMUM_PAGES: 2");
    expect(controller).toContain("max-parallel: 2");
    expect(controller).toContain(
      "Reconcile every known or late provider runner with bounded backoff",
    );
    expect(controller).toContain("REVIEW_ROUTER_RECONCILIATION_ATTEMPTS: 8");
    expect(controller).toContain("scheduled-reconciliation.json");
  });

  it("is dispatch-only because runtime identity requires workflow_dispatch", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("workflow_call:");
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
    const reconcile = jobs(workflow).find((block) =>
      block.startsWith("  always-reconcile:"),
    )!;
    expect(reconcile).toContain("REVIEW_ROUTER_RUNNER_WITNESS_TOKEN:");
    expect(reconcile).toContain("REVIEW_ROUTER_RUNNER_WITNESS_URL:");
    expect(reconcile).toContain("reconcile-private-pg17-compensation.ts");
    expect(reconcile).toContain("REVIEW_ROUTER_SOURCE_DATABASE_URL:");
    expect(reconcile).toContain("REVIEW_ROUTER_SOURCE_RECONNECT_URLS_JSON:");
    expect(reconcile).toContain("REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN:");
    expect(reconcile).toContain("RENDER_SERVICE_SUSPENSION_API_KEY:");
    expect(reconcile).toContain("RENDER_TARGET_SWITCH_API_KEY:");
    expect(reconcile).toContain("REVIEW_ROUTER_SOURCE_RECOVERY_WITNESS:");
    expect(reconcile).toContain(
      "REVIEW_ROUTER_SOURCE_RECOVERY_WITNESS_SHA256:",
    );
    const cutover = jobs(workflow).find((block) =>
      block.startsWith("  pg17-cutover-private:"),
    )!;
    expect(cutover).toContain("REVIEW_ROUTER_SOURCE_RECOVERY_WITNESS_SHA256:");
    expect(cutover).toContain("REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256:");
    expect(reconcile).not.toContain(
      "REVIEW_ROUTER_SOURCE_RECOVERY_MANIFEST_JSON:",
    );
    expect(workflow).not.toContain("REVIEW_ROUTER_PROTECTED_SOURCE_ENV_JSON:");
    expect(workflow).not.toContain(
      "REVIEW_ROUTER_TARGET_SERVICE_CONTRACTS_JSON:",
    );
    expect(reconcile).toContain("timeout-minutes: 30");
    expect(reconcile).toContain("REVIEW_ROUTER_RECONCILIATION_ATTEMPTS: 8");
    expect(reconcile.indexOf("cleanup-runners")).toBeLessThan(
      reconcile.indexOf("reconcile-private-pg17-compensation.ts"),
    );
    expect(reconcile).toContain("compensation-gate-");
  });

  it("evaluates durable compensation after runner cleanup fails without erasing the failure", () => {
    const reconcile = jobs(workflow).find((block) =>
      block.startsWith("  always-reconcile:"),
    )!;
    const result = executeStepComposition(namedSteps(reconcile), {
      "Idempotently reconcile persisted jobs and rollout boundary": "failure",
    });

    expect(result.executed).toContain("actions/upload-artifact");
    expect(result.executed).toContain("actions/download-artifact");
    expect(result.executed).toContain(
      "Complete safe pre-activation compensation, then reconcile",
    );
    expect(result.conclusion).toBe("failure");
  });

  it("propagates compensation failure after successful runner cleanup", () => {
    const reconcile = jobs(workflow).find((block) =>
      block.startsWith("  always-reconcile:"),
    )!;
    const result = executeStepComposition(namedSteps(reconcile), {
      "Idempotently reconcile persisted jobs and rollout boundary": "success",
      "Complete safe pre-activation compensation, then reconcile": "failure",
    });

    expect(result.executed).toContain(
      "Complete safe pre-activation compensation, then reconcile",
    );
    expect(result.conclusion).toBe("failure");
  });

  it("keeps installer and external authority credentials out of every workflow job", () => {
    const cutover = jobs(workflow).find((block) =>
      block.startsWith("  pg17-cutover-private:"),
    )!;
    expect(workflow).not.toContain("EXTERNAL_ACTIVATION_AUTHORITY");
    expect(workflow).not.toContain("ACTIVATION_PERMIT_INSTALLER");
    expect(workflow).not.toContain("ACTIVATION_RECEIPT_GUARD");
    expect(cutover).toContain(
      "REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN: ${{ secrets.REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN }}",
    );
    expect(cutover).not.toContain(
      "REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN: ${{ secrets.REVIEW_ROUTER_RELEASE_CONTROL_TOKEN }}",
    );
  });

  it("uses dedicated release-control and compensation credentials", () => {
    expect(workflow).toContain("secrets.REVIEW_ROUTER_RELEASE_CONTROL_TOKEN");
    expect(workflow).toContain(
      "secrets.REVIEW_ROUTER_COMPENSATION_SOURCE_DATABASE_URL",
    );
    expect(workflow).not.toContain("secrets.REVIEW_ROUTER_RUNNER_LEDGER_TOKEN");
    expect(`${workflow}\n${controller}`).not.toContain(
      "secrets.REVIEW_ROUTER_RUNNER_WITNESS_TOKEN",
    );
    expect(workflow).not.toContain("secrets.REVIEW_ROUTER_SOURCE_DATABASE_URL");
    for (const jobName of ["role-bootstrap-private", "pg17-cutover-private"]) {
      const job = jobs(workflow).find((block) =>
        block.startsWith(`  ${jobName}:`),
      )!;
      expect(job).toContain("REVIEW_ROUTER_SOURCE_DATABASE_URL:");
      expect(job).toContain("REVIEW_ROUTER_SOURCE_RECONNECT_URLS_JSON:");
      expect(job).toContain("RENDER_SERVICE_SUSPENSION_API_KEY:");
      expect(job).toContain("REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS:");
    }
  });

  it("uses one canonical three-credential release service contract", () => {
    const combined = `${workflow}\n${controller}`;
    const credentials = new Set(
      [
        ...combined.matchAll(
          /secrets\.(REVIEW_ROUTER_(?:RELEASE_CONTROL|PROVIDER_AUTHORITY|RELEASE_WITNESS)_TOKEN)\b/gu,
        ),
      ].map((match) => match[1]),
    );
    expect([...credentials].sort()).toEqual([
      "REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN",
      "REVIEW_ROUTER_RELEASE_CONTROL_TOKEN",
      "REVIEW_ROUTER_RELEASE_WITNESS_TOKEN",
    ]);
    expect(combined).not.toMatch(
      /(?:vars|secrets)\.REVIEW_ROUTER_RUNNER_(?:LEDGER|WITNESS)_(?:URL|TOKEN)/u,
    );
    expect(combined).toContain(
      "REVIEW_ROUTER_RUNNER_LEDGER_URL: ${{ vars.REVIEW_ROUTER_RELEASE_CONTROL_URL }}",
    );
    expect(combined).toContain(
      "REVIEW_ROUTER_RUNNER_WITNESS_URL: ${{ vars.REVIEW_ROUTER_RELEASE_WITNESS_URL }}",
    );

    const blueprint = readFileSync("render.yaml", "utf8");
    for (const hash of [
      "REVIEW_ROUTER_RELEASE_CONTROL_TOKEN_SHA256",
      "REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN_SHA256",
      "REVIEW_ROUTER_RELEASE_WITNESS_TOKEN_SHA256",
    ])
      expect(blueprint.match(new RegExp(`key: ${hash}`, "gu"))).toHaveLength(1);
    expect(blueprint).not.toContain(
      "REVIEW_ROUTER_RELEASE_WITNESS_TRIGGER_TOKEN_SHA256",
    );
    const witnessServer = readFileSync(
      "apps/api/src/release-witness-server.ts",
      "utf8",
    );
    expect(witnessServer).toContain(
      'required("REVIEW_ROUTER_RELEASE_WITNESS_TOKEN_SHA256")',
    );
    expect(witnessServer).not.toContain("WITNESS_TRIGGER_TOKEN_SHA256");

    const architecture = readFileSync(
      "docs/adr/ADR-private-pg17-release-authority.md",
      "utf8",
    );
    const runbook = readFileSync(
      "docs/operations/private-pg17-release-rollout.md",
      "utf8",
    );
    for (const document of [architecture, runbook]) {
      expect(document).toContain("REVIEW_ROUTER_RELEASE_CONTROL_TOKEN_SHA256");
      expect(document).toContain(
        "REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN_SHA256",
      );
      expect(document).toContain("REVIEW_ROUTER_RELEASE_WITNESS_TOKEN_SHA256");
      expect(document).not.toContain("WITNESS_TRIGGER_TOKEN_SHA256");
    }
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
