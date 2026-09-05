import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertRecoveryDeploymentInventory,
  advanceRecoveryPhase,
  advanceRecoveryService,
  createRecoveryJournal,
  loadRecoveryJournal,
  loadRecoveryReplicas,
  parseRecoveryJson,
  readRecoveryPhaseResponse,
  recoveryCompensationFence,
  recoveryContinuationMode,
  attachRecoveryPreparation,
  reconcileRecoveryDeploy,
  recoveryConfigFingerprint,
  recoveryJournalKey,
  recoveryRestartAction,
  recoveryRoles,
  recoveryProductionScope,
  planWorkerEffectFence,
  workerEffectFenceSql,
  workerFenceSnapshotSql,
} from "./render-recovery-journal.mjs";
import { canonicalPrismaMigrationCatalog } from "./lib/canonical-prisma-migration-catalog.mjs";

// Observer tests exercise Bash itself, without host-specific startup scripts.
const subprocessEnv = { ...process.env, BASH_ENV: "/dev/null", PS1: "" };

const workflow = readFileSync(
  ".github/workflows/codex-rotating-release-migration.yml",
  "utf8",
);
const trustBootstrap = workflow.slice(
  workflow.indexOf("\n  trust-bootstrap:"),
  workflow.indexOf("\n  release-evidence:"),
);
const recover = workflow.slice(
  workflow.indexOf("\n  recover:"),
  workflow.indexOf("\n  register-release:"),
);
const registerRelease = workflow.slice(
  workflow.indexOf("\n  register-release:"),
);

function extractRecoveryJqFilter(name: string, source = recover): string {
  const assignment = `          ${name}='`;
  const start = source.indexOf(assignment);
  if (start < 0) throw new Error(`missing recovery jq filter: ${name}`);
  const bodyStart = start + assignment.length;
  const bodyEnd = source.indexOf("\n          '", bodyStart);
  if (bodyEnd < 0) throw new Error(`unterminated recovery jq filter: ${name}`);
  return source.slice(bodyStart, bodyEnd);
}

function extractRecoveryBashFunction(name: string, source = recover): string {
  const declaration = `          ${name}() {`;
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`missing recovery bash function: ${name}`);
  const lines = source.slice(start).split("\n");
  let delimiter: string | undefined;
  let end = -1;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (delimiter !== undefined) {
      if (line.trim() === delimiter) delimiter = undefined;
      continue;
    }
    const hereDocument = line.match(/<<'([A-Z_]+)'/u);
    if (hereDocument) {
      delimiter = hereDocument[1];
      continue;
    }
    if (line === "          }") {
      end = index;
      break;
    }
  }
  if (end < 0) throw new Error(`unterminated recovery bash function: ${name}`);
  return lines
    .slice(0, end + 1)
    .join("\n")
    .replace(/^ {10}/gmu, "");
}

const recoveryDeploymentInventoryFilter = extractRecoveryJqFilter(
  "recovery_deployment_inventory_filter",
);
const recoverySuspensionSetFilter = extractRecoveryJqFilter(
  "recovery_suspension_set_filter",
);
const recoveryDeploymentSetFilter = extractRecoveryJqFilter(
  "recovery_deployment_set_filter",
);
const recoveryPredeployInventoryFilter = extractRecoveryJqFilter(
  "recovery_predeploy_inventory_filter",
);
const recoveryReconciliationFilter = extractRecoveryJqFilter(
  "recovery_reconciliation_filter",
);
const recoveryPendingDeploymentFilter = extractRecoveryJqFilter(
  "recovery_pending_deployment_filter",
);
const recoveryExactDeploymentFilter = extractRecoveryJqFilter(
  "recovery_exact_deployment_filter",
);
const recoveryBoundInventoryFilter = extractRecoveryJqFilter(
  "recovery_bound_inventory_filter",
);
const recoveryServiceObservationFilter = extractRecoveryJqFilter(
  "recovery_service_observation_filter",
);
const recoveryServiceSetFilter = extractRecoveryJqFilter(
  "recovery_service_set_filter",
);
const compensateRecoveryFleet = extractRecoveryBashFunction(
  "compensate_recovery_fleet",
);
const cleanupRecovery = extractRecoveryBashFunction("cleanup");
const terminateRecovery = extractRecoveryBashFunction("terminate_recovery");
const renderInventoryApi = extractRecoveryBashFunction("render_inventory_api");
const fetchRecoveryDeploymentInventory = extractRecoveryBashFunction(
  "fetch_recovery_deployment_inventory",
);
const releaseCommitSha = "a".repeat(40);
const releaseImageDigest = `sha256:${"b".repeat(64)}`;
const serviceId = "srv-api";
const expectedDeployId = "dep-target";

function runJq(
  filter: string,
  input: unknown,
  args: Readonly<Record<string, string>> = {},
  jsonArgs: Readonly<Record<string, unknown>> = {},
) {
  const commandArgs = ["-ce"];
  for (const [name, value] of Object.entries(args)) {
    commandArgs.push("--arg", name, value);
  }
  for (const [name, value] of Object.entries(jsonArgs)) {
    commandArgs.push("--argjson", name, JSON.stringify(value));
  }
  commandArgs.push(filter);
  const result = spawnSync("jq", commandArgs, {
    encoding: "utf8",
    input: JSON.stringify(input),
  });
  if (result.error) throw result.error;
  return result;
}

function observeInventory(expectedServiceId: string, input: unknown) {
  const fixture = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(fixture);
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      return {
        ...(typeof object.id === "string" && object.id.startsWith("dep-")
          ? { createdAt: "2026-09-05T00:00:00Z" }
          : {}),
        ...Object.fromEntries(
          Object.entries(object).map(([key, item]) => [key, fixture(item)]),
        ),
      };
    }
    return value;
  };
  const result = runJq(recoveryDeploymentInventoryFilter, fixture(input), {
    serviceId: expectedServiceId,
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as ReadonlyArray<{
    readonly createdAt: string | null;
    readonly deploymentIdentityKind: string;
    readonly deployId: string;
    readonly observedCommitSha: string | null;
    readonly observedImageDigest: string | null;
    readonly observedStatus: string;
    readonly serviceId: string;
    readonly statusClass: string;
  }>;
}

function observeDeployment(expectedServiceId: string, deploy: unknown) {
  const observations = observeInventory(expectedServiceId, [{ deploy }]);
  expect(observations).toHaveLength(1);
  return observations[0]!;
}

function recoveryDeploymentSetAccepts(observations: readonly unknown[]) {
  return (
    runJq(recoveryDeploymentSetFilter, observations, {
      releaseCommitSha,
    }).status === 0
  );
}

function exactDeploymentAccepts(
  input: unknown,
  expectedId = expectedDeployId,
): boolean {
  const observations = observeInventory(serviceId, input);
  return (
    runJq(recoveryExactDeploymentFilter, observations, {
      expectedDeployId: expectedId,
      releaseCommitSha,
      serviceId,
    }).status === 0
  );
}

function pendingDeploymentAccepts(input: unknown): boolean {
  const observations = observeInventory(serviceId, input);
  return (
    runJq(recoveryPendingDeploymentFilter, observations, {
      expectedDeployId,
      releaseCommitSha,
      serviceId,
    }).status === 0
  );
}

function boundInventoryAccepts(input: unknown): boolean {
  const observations = observeInventory(serviceId, input);
  return (
    runJq(recoveryBoundInventoryFilter, observations, {
      expectedDeployId,
      releaseCommitSha,
      serviceId,
    }).status === 0
  );
}

describe("Codex rotating release migration workflow", () => {
  it("rejects unsafe environment policies before emitting trusted output", () => {
    const program = trustBootstrap.match(
      /<<'NODE'\n([\s\S]*?)\n {10}NODE/u,
    )?.[1];
    expect(program).toBeDefined();
    const policy = {
      protection_rules: [
        {
          type: "required_reviewers",
          reviewers: [{ type: "Team", id: 1 }],
          prevent_self_review: true,
        },
      ],
      deployment_branch_policy: {
        protected_branches: true,
        custom_branch_policies: false,
      },
    };
    for (const [environment, accepted] of [
      [policy, true],
      [{ ...policy, protection_rules: [] }, false],
      [
        {
          ...policy,
          protection_rules: [
            { ...policy.protection_rules[0], prevent_self_review: false },
          ],
        },
        false,
      ],
      [
        {
          ...policy,
          deployment_branch_policy: {
            protected_branches: false,
            custom_branch_policies: true,
          },
        },
        false,
      ],
    ] as const) {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
globalThis.fetch = async (url) => ({
  ok: true,
  json: async () => String(url).endsWith("/branches/main")
    ? { protected: true, commit: { sha: process.env.GITHUB_SHA } }
    : JSON.parse(process.env.ENVIRONMENT_FIXTURE),
});
${program}
`,
        ],
        {
          encoding: "utf8",
          env: {
            ...subprocessEnv,
            GITHUB_REPOSITORY: "test/recovery",
            GITHUB_SHA: releaseCommitSha,
            GITHUB_REF: "refs/heads/main",
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_OUTPUT: "/dev/null",
            GH_TOKEN: "mock-token",
            ENVIRONMENT_FIXTURE: JSON.stringify(environment),
          },
        },
      );
      expect(result.status === 0).toBe(accepted);
      if (!accepted) expect(result.stderr).toContain("environment_unprotected");
    }
  });

  it("gates credentials on protected environment and exact release evidence", () => {
    expect(trustBootstrap).toContain("reviewers.prevent_self_review !== true");
    expect(trustBootstrap).toContain("/environments/production-release");
    expect(workflow).toContain(
      "REVIEW_ROUTER_RELEASE_GATE_SHA: ${{ inputs.release_commit_sha }}",
    );
    expect(workflow).toContain("node scripts/release-gate-evidence.mjs verify");
    for (const job of [recover, registerRelease]) {
      expect(job).toContain("needs: [trust-bootstrap, release-evidence]");
      expect(job).toContain("environment: production-release");
    }
  });

  it("binds service preflight to the owner, environment, role, and exact ID", () => {
    const filter = extractRecoveryJqFilter("service_scope_filter");
    const service = {
      id: "srv-api",
      name: "reviewrouter-api",
      repo: "https://github.com/777genius/review-router-saas",
      branch: "main",
      autoDeploy: "no",
      ownerId: "tea-owner",
      environmentId: "evm-target",
      type: "web_service",
      suspended: "not_suspended",
    };
    const args = {
      serviceId: "srv-api",
      ownerId: "tea-owner",
      environmentId: "evm-target",
      serviceType: "web_service",
      serviceName: "reviewrouter-api",
    };
    expect(runJq(filter, service, args).status).toBe(0);
    expect(runJq(filter, { service }, args).status).toBe(0);
    for (const key of Object.keys(service)) {
      expect(
        runJq(filter, { ...service, [key]: "wrong" }, args).status,
      ).not.toBe(0);
      expect(runJq(filter, { ...service, [key]: null }, args).status).not.toBe(
        0,
      );
    }
    expect(registerRelease).toContain("and .type == $serviceType");
    expect(recover.indexOf("service_scope_filter='")).toBeLessThan(
      recover.indexOf('if [[ "$state" != "suspended" ]]'),
    );
  });

  it("requires exact database firewall closure evidence", () => {
    for (const job of [recover, registerRelease]) {
      const start = job.indexOf("          close_firewall() {");
      const end = job.indexOf("\n          }", start);
      const close = job.slice(start, end + "\n          }".length);
      for (const [patchStatus, database, accepted] of [
        [0, { id: "dpg-test", ipAllowList: [] }, true],
        [28, { id: "dpg-test", ipAllowList: [] }, false],
        [0, { id: "dpg-other", ipAllowList: [] }, false],
        [0, { id: "dpg-test", ipAllowList: [{}] }, false],
        [0, { id: "dpg-test" }, false],
      ] as const) {
        const result = spawnSync(
          "bash",
          [
            "-c",
            `set -euo pipefail
firewall_open=1
TARGET_DB_ID=dpg-test
render_api() {
  if [[ "$1" == "-X" ]]; then return "$PATCH_STATUS"; fi
  printf '%s\\n' "$DATABASE_FIXTURE"
}
${close}
if close_firewall; then printf 'closed=%s' "$firewall_open"; else exit 1; fi
`,
          ],
          {
            encoding: "utf8",
            env: {
              ...subprocessEnv,
              PATCH_STATUS: String(patchStatus),
              DATABASE_FIXTURE: JSON.stringify(database),
            },
          },
        );
        expect(result.status === 0).toBe(accepted);
        if (accepted) expect(result.stdout).toBe("closed=0");
      }
    }
  });

  it("closes the firewall when its opening PATCH loses the response", () => {
    for (const job of [recover, registerRelease]) {
      const work = mkdtempSync(join(tmpdir(), "recovery-open-failure-"));
      try {
        const start = job.indexOf("          # Arm cleanup before the PATCH:");
        const end = job.indexOf("\n\n", start);
        const opening =
          job === recover
            ? `${extractRecoveryBashFunction("open_recovery_database")}\nopen_recovery_database`
            : job.slice(start, end).replace(/^ {10}/gmu, "");
        if (job === registerRelease) expect(start).toBeGreaterThan(-1);
        const result = spawnSync(
          "bash",
          [
            "-c",
            `set -euo pipefail
firewall_open=0
work="$1"
TARGET_DB_ID=dpg-test
curl() { printf 192.0.2.1; }
render_api() { return 28; }
render_inventory_api() { return 28; }
trap 'printf "cleanup_armed=%s\\n" "$firewall_open"' EXIT
${opening}
`,
            "bash",
            work,
          ],
          { encoding: "utf8", env: subprocessEnv },
        );
        expect(result.status).toBe(job === recover ? 1 : 28);
        expect(result.stdout).toBe("cleanup_armed=1\n");
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }
  });

  it("establishes current protected main before any repository checkout", () => {
    expect(trustBootstrap).toContain(
      'required("GITHUB_REF") !== "refs/heads/main"',
    );
    expect(trustBootstrap).toContain("branch.protected !== true");
    expect(trustBootstrap).toContain(
      "branch.commit?.sha?.toLowerCase() !== dispatchSha",
    );
    expect(trustBootstrap).toContain("trusted_main_sha=${dispatchSha}");
    expect(trustBootstrap).not.toContain("actions/checkout@");
    expect(registerRelease).toContain(
      "needs: [trust-bootstrap, release-evidence]",
    );
  });

  it("checks out and verifies the requested immutable migration source", () => {
    expect(workflow).toContain(
      "ref: ${{ needs.trust-bootstrap.outputs.trusted_main_sha }}",
    );
    expect(workflow).toContain('git switch --detach "$RELEASE_COMMIT_SHA"');
    expect(workflow).toContain('observed_source_sha="$(git rev-parse HEAD)"');
    expect(workflow).toContain(
      '[[ "$observed_source_sha" == "$RELEASE_COMMIT_SHA" ]]',
    );
  });

  it("fails closed until every exact runtime service is suspended", () => {
    const suspensionBarrier = workflow.indexOf("suspension_guard_armed=1");
    const credentialRotation = workflow.indexOf("create-runtime-roles.sql");
    const migration = workflow.indexOf("pnpm db:migrate:deploy");
    expect(suspensionBarrier).toBeGreaterThan(-1);
    expect(credentialRotation).toBeGreaterThan(suspensionBarrier);
    expect(migration).toBeGreaterThan(suspensionBarrier);
    expect(workflow).toContain("recovery-phase.json");
    expect(workflow).toContain('persist_recovery_phase "services_suspended"');
    expect(workflow).toContain('persist_recovery_phase "credentials_rotated"');
    expect(workflow).toContain('persist_recovery_phase "migration_complete"');
    expect(workflow).toContain(
      'persist_recovery_phase "service_credentials_staged"',
    );
    expect(workflow).toContain("advance_recovery_service deploy_intent");
    expect(workflow).toContain("recovery-resume-state.json");
  });

  it("converges live and partially suspended service sets before mutation", () => {
    expect(workflow).toContain('if [[ "$state" != "suspended" ]]');
    expect(workflow).toContain(
      '"https://api.render.com/v1/services/$service_id/suspend"',
    );
    expect(workflow).toContain("suspension_deadline=$((SECONDS + 600))");
  });

  it("binds every suspended response to the requested unique service ID", () => {
    const valid = ["api", "worker", "web"].map((role) => ({
      observedServiceId: `srv-${role}`,
      serviceId: `srv-${role}`,
      suspended: "suspended",
    }));
    const accepts = (input: unknown) =>
      runJq(recoverySuspensionSetFilter, input).status === 0;

    expect(accepts(valid)).toBe(true);
    expect(
      accepts([
        valid[0],
        { ...valid[1], observedServiceId: "srv-api" },
        valid[2],
      ]),
    ).toBe(false);
    expect(
      accepts([
        valid[0],
        { ...valid[1], suspended: "not_suspended" },
        valid[2],
      ]),
    ).toBe(false);
    expect(recover).toContain("suspension_guard_armed=1");
    expect(recover.indexOf("suspension_guard_armed=1")).toBeLessThan(
      recover.indexOf("pnpm db:migrate:deploy"),
    );
  });

  it("resumes each exact service before deployment and verifies it before advancing", () => {
    const loop = recover.indexOf("resume_result='[]'");
    const resume = recover.indexOf(
      '"https://api.render.com/v1/services/$service_id/resume"',
      loop,
    );
    const online = recover.indexOf(
      "until assert_recovery_service_online",
      resume,
    );
    const deploy = recover.indexOf("render_deploy_mutation -X POST", online);
    const verified = recover.indexOf(
      '> "$work/verified-deployment-$service_id.json"',
      deploy,
    );
    expect(loop).toBeGreaterThan(0);
    expect(resume).toBeGreaterThan(loop);
    expect(online).toBeGreaterThan(resume);
    expect(deploy).toBeGreaterThan(online);
    expect(verified).toBeGreaterThan(deploy);
    expect(recover.slice(loop, resume)).toContain(
      '"$API_SERVICE_ID" "$WORKER_SERVICE_ID" "$WEB_SERVICE_ID"',
    );
    expect(recover.slice(deploy, verified)).not.toContain(
      "assert_recovery_service_suspended",
    );
    expect(recover.slice(deploy, verified)).not.toContain(
      "assert_recovery_fleet_suspended",
    );
    expect(recoveryRoles).toEqual(["api", "worker", "web"]);
    expect(recoveryDeploymentInventoryFilter).toContain('kind: "git"');
    expect(recoveryDeploymentInventoryFilter).toContain('kind: "image"');
    expect(recoveryDeploymentInventoryFilter).toContain('kind: "missing"');
    expect(recoveryDeploymentInventoryFilter).toContain('kind: "invalid"');
    expect(recoveryDeploymentSetFilter).toContain(
      'all(.observedStatus == "live")',
    );
    expect(recoveryDeploymentSetFilter).toContain(
      ".observedCommitSha == $releaseCommitSha",
    );
    expect(recoveryDeploymentSetFilter).toContain(
      ".observedImageDigest == null",
    );
    expect(recoveryExactDeploymentFilter).toContain(
      ".[0].deployId == $expectedDeployId",
    );
  });

  it("uses one non-retried deploy POST per service and bounded reconciliation", () => {
    const deployClient = recover.slice(
      recover.indexOf("render_deploy_mutation()"),
      recover.indexOf("suspension_guard_armed=0"),
    );
    const createCalls = recover.match(/render_deploy_mutation -X POST/gu);

    expect(deployClient).not.toContain("--retry");
    expect(createCalls).toHaveLength(2); // one resume and one deploy call site
    expect(recover).toContain("before_deploy_ids=");
    expect(recover).toContain("reconciliation_deadline=$((SECONDS + 120))");
    expect(recover).toContain("stable_candidate_observations >= 2");
    expect(recover).toContain("candidate_count > 1");
    expect(recover).toContain("deployment_deadline=$((SECONDS + 900))");
    expect(recover).toContain("timeout-minutes: 70");
  });

  it("accepts the current git-backed Render shape at the exact release commit", () => {
    const observations = ["api", "worker", "web"].map((role) =>
      observeDeployment(`srv-${role}`, {
        commit: { id: releaseCommitSha },
        id: `dep-${role}`,
        image: null,
        status: "live",
      }),
    );

    expect(observations[0]).toMatchObject({
      deploymentIdentityKind: "git",
      observedCommitSha: releaseCommitSha,
      observedImageDigest: null,
    });
    expect(recoveryDeploymentSetAccepts(observations)).toBe(true);
  });

  it("classifies Render image provenance but rejects it without an expected immutable digest input", () => {
    const observations = ["api", "worker", "web"].map((role) =>
      observeDeployment(`srv-${role}`, {
        commit: null,
        id: `dep-${role}`,
        image: { sha: releaseImageDigest },
        status: "live",
      }),
    );

    expect(observations[0]).toMatchObject({
      deploymentIdentityKind: "image",
      observedCommitSha: null,
      observedImageDigest: releaseImageDigest,
    });
    expect(recoveryDeploymentSetAccepts(observations)).toBe(false);
  });

  it.each([
    ["missing", { id: "dep-api", status: "live" }, "missing"],
    [
      "ambiguous commit and image",
      {
        commit: { id: releaseCommitSha },
        id: "dep-api",
        image: { sha: releaseImageDigest },
        status: "live",
      },
      "invalid",
    ],
    [
      "conflicting commit aliases",
      {
        commit: { id: releaseCommitSha, sha: "c".repeat(40) },
        id: "dep-api",
        status: "live",
      },
      "invalid",
    ],
    [
      "wrong commit",
      { commit: { id: "d".repeat(40) }, id: "dep-api", status: "live" },
      "git",
    ],
  ])("rejects a %s deployment identity", (_name, deploy, identityKind) => {
    const observation = observeDeployment("srv-api", deploy);
    const otherObservations = ["worker", "web"].map((role) =>
      observeDeployment(`srv-${role}`, {
        commit: { id: releaseCommitSha },
        id: `dep-${role}`,
        status: "live",
      }),
    );

    expect(observation.deploymentIdentityKind).toBe(identityKind);
    expect(
      recoveryDeploymentSetAccepts([observation, ...otherObservations]),
    ).toBe(false);
  });

  it("normalizes direct, wrapped, and list Render deployment shapes", () => {
    const deploy = {
      commit: { id: releaseCommitSha },
      id: expectedDeployId,
      status: "live",
    };

    expect(observeInventory(serviceId, deploy)).toHaveLength(1);
    expect(observeInventory(serviceId, { deploy })).toHaveLength(1);
    expect(observeInventory(serviceId, [{ deploy }])).toHaveLength(1);
    expect(observeInventory(serviceId, { deploys: [{ deploy }] })).toHaveLength(
      1,
    );
  });

  it("binds an exact live response to both service ID and deploy ID", () => {
    const exact = {
      commit: { id: releaseCommitSha },
      id: expectedDeployId,
      status: "live",
    };

    expect(exactDeploymentAccepts({ deploy: exact })).toBe(true);
    expect(
      exactDeploymentAccepts({ deploy: { ...exact, id: "dep-other" } }),
    ).toBe(false);
    expect(
      exactDeploymentAccepts({
        deploy: {
          ...exact,
          commit: { id: releaseCommitSha, sha: "c".repeat(40) },
        },
      }),
    ).toBe(false);
    expect(
      exactDeploymentAccepts({
        deploy: { ...exact, commit: null, image: { sha: releaseImageDigest } },
      }),
    ).toBe(false);
    expect(
      exactDeploymentAccepts({
        deploy: { id: expectedDeployId, status: "live" },
      }),
    ).toBe(false);
  });

  it("allows missing identity only while an exact bound deployment is pending", () => {
    expect(
      pendingDeploymentAccepts({ id: expectedDeployId, status: "created" }),
    ).toBe(true);
    expect(
      pendingDeploymentAccepts({
        commit: { id: releaseCommitSha },
        id: expectedDeployId,
        status: "build_in_progress",
      }),
    ).toBe(true);
    expect(
      pendingDeploymentAccepts({ id: expectedDeployId, status: "live" }),
    ).toBe(false);
    expect(
      pendingDeploymentAccepts({
        commit: { id: "d".repeat(40) },
        id: expectedDeployId,
        status: "build_in_progress",
      }),
    ).toBe(false);
  });

  it("reconciles only a unique exact git deployment outside every pre-intent ID", () => {
    const intentEpoch = Date.parse("2026-08-30T10:00:00Z") / 1_000;
    const candidates = observeInventory(serviceId, [
      {
        commit: { id: releaseCommitSha },
        createdAt: "2026-08-30T10:00:01.123Z",
        id: expectedDeployId,
        status: "build_in_progress",
      },
      {
        commit: { id: "b".repeat(40) },
        createdAt: "2026-08-30T09:00:00Z",
        id: "dep-before",
        status: "deactivated",
      },
    ]);
    const args = {
      beforeDeployIds: ["dep-before"],
      beforeInventory: [candidates[1]],
      intentEpoch,
      intentDeadlineEpoch: intentEpoch + 120,
      observationEpoch: intentEpoch + 10,
    };
    const result = runJq(
      recoveryReconciliationFilter,
      candidates,
      { releaseCommitSha, serviceId },
      args,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({ deployId: expectedDeployId }),
    ]);
    for (const source of [recover, registerRelease]) {
      const filter = extractRecoveryJqFilter(
        "recovery_reconciliation_filter",
        source,
      );
      // A fractional observation cutoff still applies, and even a nanosecond
      // after the integer intent deadline is outside the original POST window.
      for (const [createdAt, observationEpoch, accepted] of [
        ["2026-08-30T10:00:01.100Z", intentEpoch + 1.2, true],
        ["2026-08-30T10:00:01.900Z", intentEpoch + 1.2, false],
        ["2026-08-30T10:02:00Z", intentEpoch + 600, true],
        ["2026-08-30T10:02:00.000000001Z", intentEpoch + 600, false],
      ] as const) {
        const timed = runJq(
          filter,
          [{ ...candidates[0], createdAt }, candidates[1]],
          { releaseCommitSha, serviceId },
          { ...args, observationEpoch },
        );
        expect(timed.status === 0, timed.stderr).toBe(accepted);
      }
    }
    const ambiguous = runJq(
      recoveryReconciliationFilter,
      [...candidates, { ...candidates[0], deployId: "dep-extra" }],
      { releaseCommitSha, serviceId },
      args,
    );
    expect(ambiguous.status).not.toBe(0);
  });

  it("rejects a same-commit substitution or any concurrent active deployment", () => {
    const exact = {
      commit: { id: releaseCommitSha },
      id: expectedDeployId,
      status: "live",
    };
    const historical = {
      commit: { id: "b".repeat(40) },
      id: "dep-old",
      status: "deactivated",
    };

    expect(boundInventoryAccepts([exact, historical])).toBe(true);
    expect(
      boundInventoryAccepts([
        { ...exact, id: "dep-same-commit-wrong-id" },
        { ...historical, id: expectedDeployId },
      ]),
    ).toBe(false);
    expect(
      boundInventoryAccepts([
        exact,
        historical,
        {
          commit: { id: releaseCommitSha },
          id: "dep-concurrent",
          status: "build_in_progress",
        },
      ]),
    ).toBe(false);
    expect(
      boundInventoryAccepts([
        exact,
        { ...historical, id: "dep-unknown", status: "mystery" },
      ]),
    ).toBe(false);

    const firstPageHistory = Array.from({ length: 100 }, (_, index) => ({
      commit: { id: releaseCommitSha },
      id: `dep-history-${index}`,
      status: "deactivated",
    }));
    expect(
      boundInventoryAccepts([
        exact,
        ...firstPageHistory,
        {
          commit: { id: releaseCommitSha },
          id: "dep-active-on-page-two",
          status: "update_in_progress",
        },
      ]),
    ).toBe(false);
    expect(fetchRecoveryDeploymentInventory).toContain("deploys?limit=100");
    expect(fetchRecoveryDeploymentInventory).toContain(
      "&cursor=$encoded_cursor",
    );
    expect(fetchRecoveryDeploymentInventory).toContain("all_deployments");
    expect(fetchRecoveryDeploymentInventory).toContain(
      'absolute_deadline="$2"',
    );
    expect(fetchRecoveryDeploymentInventory).toContain(
      'render_inventory_api "$absolute_deadline"',
    );
    expect(fetchRecoveryDeploymentInventory).toContain(
      'if [[ "$final_snapshot" != "$first_page_snapshot" ]]',
    );
    expect(renderInventoryApi).toContain(
      "remaining=$((absolute_deadline - SECONDS))",
    );
    expect(renderInventoryApi).toContain('--max-time "$request_timeout"');
    expect(renderInventoryApi).not.toContain("--retry");
    expect(recover).not.toContain("deploys?limit=20");

    const paginationScript = `
set -euo pipefail
recovery_deployment_inventory_filter="$RECOVERY_DEPLOYMENT_FILTER"
render_inventory_api() {
  local absolute_deadline="$1"
  local argument url=""
  shift
  (( absolute_deadline > SECONDS ))
  for argument in "$@"; do
    if [[ "$argument" == https://* ]]; then url="$argument"; fi
  done
  if [[ "$url" == *cursor=* ]]; then
    jq -nc --arg commit "$RELEASE_COMMIT_SHA" '[{
      cursor: "cursor-end",
      deploy: {
        commit: {id: $commit}, createdAt:"2026-09-05T00:00:00Z",
        id: "dep-active-on-page-two",
        status: "update_in_progress"
      }
    }]'
    return 0
  fi
  jq -nc --arg commit "$RELEASE_COMMIT_SHA" '[
    range(0; 100) as $index
    | {
        cursor: (if $index == 99 then "cursor-page-two" else "cursor-\\($index)" end),
        deploy: {
          commit: {id: $commit}, createdAt:"2026-09-05T00:00:00Z",
          id: (if $index == 0 then "dep-target" else "dep-history-\\($index)" end),
          status: (if $index == 0 then "live" else "deactivated" end)
        }
      }
  ]'
}
${fetchRecoveryDeploymentInventory}
fetch_recovery_deployment_inventory srv-api "$((SECONDS + 30))"
`;
    const pagination = spawnSync("bash", ["-c", paginationScript], {
      encoding: "utf8",
      env: {
        ...subprocessEnv,
        RECOVERY_DEPLOYMENT_FILTER: recoveryDeploymentInventoryFilter,
        RELEASE_COMMIT_SHA: releaseCommitSha,
      },
    });
    expect(pagination.stderr).toBe("");
    expect(pagination.status).toBe(0);
    const exhaustiveInventory = JSON.parse(pagination.stdout) as unknown[];
    expect(exhaustiveInventory).toHaveLength(101);
    expect(
      runJq(recoveryBoundInventoryFilter, exhaustiveInventory, {
        expectedDeployId,
        releaseCommitSha,
        serviceId,
      }).status,
    ).not.toBe(0);
  });

  it("fails closed when the deployment head changes during pagination", () => {
    const work = mkdtempSync(join(tmpdir(), "reviewrouter-pagination-test-"));
    try {
      const script = `
set -euo pipefail
request_count_file="$1/request-count"
recovery_deployment_inventory_filter="$RECOVERY_DEPLOYMENT_FILTER"
render_inventory_api() {
  local absolute_deadline="$1"
  local argument count url=""
  shift
  (( absolute_deadline > SECONDS ))
  for argument in "$@"; do
    if [[ "$argument" == https://* ]]; then url="$argument"; fi
  done
  if [[ "$url" == *cursor=* ]]; then
    jq -nc --arg commit "$RELEASE_COMMIT_SHA" '[{
      cursor: "cursor-end",
      deploy: {
        commit: {id: $commit}, createdAt:"2026-09-05T00:00:00Z",
        id: "dep-page-two",
        status: "deactivated"
      }
    }]'
    return 0
  fi
  count=0
  if [[ -f "$request_count_file" ]]; then read -r count < "$request_count_file"; fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$request_count_file"
  jq -nc --arg commit "$RELEASE_COMMIT_SHA" --argjson count "$count" '[
    range(0; 100) as $index
    | {
        cursor: (if $index == 99 then "cursor-page-two" else "cursor-\\($index)" end),
        deploy: {
          commit: {id: $commit}, createdAt:"2026-09-05T00:00:00Z",
          id: (
            if $count > 1 and $index == 0 then "dep-concurrent"
            elif $count > 1 and $index == 1 then "dep-target"
            elif $index == 0 then "dep-target"
            else "dep-history-\\($index)"
            end
          ),
          status: (if $index <= (if $count > 1 then 1 else 0 end) then "live" else "deactivated" end)
        }
      }
  ]'
}
${fetchRecoveryDeploymentInventory}
fetch_recovery_deployment_inventory srv-api "$((SECONDS + 30))"
`;
      const pagination = spawnSync("bash", ["-c", script, "bash", work], {
        encoding: "utf8",
        env: {
          ...subprocessEnv,
          RECOVERY_DEPLOYMENT_FILTER: recoveryDeploymentInventoryFilter,
          RELEASE_COMMIT_SHA: releaseCommitSha,
        },
      });
      expect(pagination.status).not.toBe(0);
      expect(pagination.stderr).toContain(
        "deployment inventory head changed during pagination",
      );
    } finally {
      rmSync(work, { force: true, recursive: true });
    }
  });

  it("rejects an expired inventory deadline before making a request", () => {
    const script = `
set -euo pipefail
RENDER_API_KEY=test
${renderInventoryApi}
set +e
render_inventory_api "$((SECONDS - 1))" https://api.render.com/v1/test
status=$?
set -e
printf '%s\n' "$status"
`;
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("124");
    expect(result.stderr).toContain("inventory deadline expired");
  });

  it("rejects a competing deploy before recovery creates its pinned target", () => {
    const baseline = observeInventory(serviceId, [
      {
        commit: { id: "c".repeat(40) },
        id: "dep-baseline",
        status: "live",
      },
      {
        commit: { id: "b".repeat(40) },
        id: "dep-old",
        status: "deactivated",
      },
    ]);
    const gate = (input: unknown) =>
      runJq(recoveryPredeployInventoryFilter, input, { serviceId }).status ===
      0;

    expect(gate(baseline)).toBe(true);
    expect(
      gate([
        ...baseline,
        {
          ...baseline[0],
          deployId: "dep-concurrent",
          observedStatus: "update_in_progress",
          statusClass: "active",
        },
      ]),
    ).toBe(false);
  });

  it("requires role-specific online service shapes before public health checks", () => {
    const services = [
      [
        "api",
        "srv-api",
        {
          id: "srv-api",
          serviceDetails: { url: "https://api.example.test" },
          suspended: "not_suspended",
          type: "web_service",
        },
      ],
      [
        "worker",
        "srv-worker",
        {
          id: "srv-worker",
          serviceDetails: {},
          suspended: "not_suspended",
          type: "background_worker",
        },
      ],
      [
        "web",
        "srv-web",
        {
          id: "srv-web",
          serviceDetails: { url: "https://web.example.test/" },
          suspended: "not_suspended",
          type: "web_service",
        },
      ],
    ].map(([role, id, service]) => {
      const result = runJq(
        recoveryServiceObservationFilter,
        { service },
        { role: String(role), serviceId: String(id) },
      );
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout) as unknown;
    });

    expect(runJq(recoveryServiceSetFilter, services).status).toBe(0);
    expect(
      runJq(recoveryServiceSetFilter, [
        services[0],
        { ...(services[1] as object), suspended: "suspended" },
        services[2],
      ]).status,
    ).not.toBe(0);
    expect(recover).toContain('"$api_origin/health"');
    expect(recover).toContain('"$web_origin/"');
    expect(recover).toContain(
      'healthSignal: "render_not_suspended_and_exact_live_deploy"',
    );
  });

  it("compensates every exact service after a partial or uncertain resume", () => {
    const work = mkdtempSync(join(tmpdir(), "reviewrouter-recovery-test-"));
    try {
      const script = `
set -euo pipefail
work="$1"
API_SERVICE_ID=srv-api
WORKER_SERVICE_ID=srv-worker
WEB_SERVICE_ID=srv-web
RECOVERY_COMPENSATION_TIMEOUT_SECONDS=5
recovery_suspension_set_filter="$RECOVERY_SUSPENSION_FILTER"
render_inventory_api() {
  local absolute_deadline="$1"
  local argument service_id url=""
  shift
  (( absolute_deadline > SECONDS ))
  for argument in "$@"; do
    if [[ "$argument" == https://* ]]; then url="$argument"; fi
  done
  service_id="\${url#*/services/}"
  service_id="\${service_id%%/*}"
  if [[ "$url" == */suspend ]]; then
    printf '%s\\n' "$service_id" >> "$work/suspend-calls"
    : > "$work/$service_id.suspended"
    return 0
  fi
  if [[ -f "$work/$service_id.suspended" ]]; then
    printf '{"id":"%s","suspended":"suspended"}\\n' "$service_id"
  else
    printf '{"id":"%s","suspended":"not_suspended"}\\n' "$service_id"
  fi
}
${compensateRecoveryFleet}
compensate_recovery_fleet
`;
      const result = spawnSync("bash", ["-c", script, "bash", work], {
        encoding: "utf8",
        env: {
          ...subprocessEnv,
          RECOVERY_SUSPENSION_FILTER: recoverySuspensionSetFilter,
        },
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(
        readFileSync(join(work, "suspend-calls"), "utf8").trim().split("\n"),
      ).toEqual(["srv-api", "srv-worker", "srv-web"]);
      expect(
        JSON.parse(
          readFileSync(
            join(work, "compensation-suspension-result.json"),
            "utf8",
          ),
        ),
      ).toEqual([
        {
          observedServiceId: "srv-api",
          serviceId: "srv-api",
          suspended: "suspended",
        },
        {
          observedServiceId: "srv-worker",
          serviceId: "srv-worker",
          suspended: "suspended",
        },
        {
          observedServiceId: "srv-web",
          serviceId: "srv-web",
          suspended: "suspended",
        },
      ]);
    } finally {
      rmSync(work, { force: true, recursive: true });
    }

    const activation = recover.indexOf("resume_result='[]'");
    const firstResume = recover.indexOf(
      '"https://api.render.com/v1/services/$service_id/resume"',
    );
    const health = recover.indexOf("health_deadline=$((SECONDS + 300))");
    const finalIdentity = recover.indexOf(
      '"$work/post-resume-deployment-result.json"',
      health,
    );
    const finalServiceState = recover.indexOf(
      "observe_recovery_services",
      finalIdentity,
    );
    const completion = recover.indexOf("recovery_complete=1");

    expect(activation).toBeLessThan(firstResume);
    expect(firstResume).toBeLessThan(health);
    expect(health).toBeLessThan(finalIdentity);
    expect(finalIdentity).toBeLessThan(finalServiceState);
    expect(finalServiceState).toBeLessThan(completion);
    expect(recover).toContain(
      'if [[ "$suspension_guard_armed" -eq 1 && "$recovery_complete" -eq 0 ]]',
    );
  });

  it("runs fail-closed compensation for HUP, INT, and TERM exits", () => {
    for (const [signal, expectedStatus] of [
      ["HUP", 129],
      ["INT", 130],
      ["TERM", 143],
    ] as const) {
      const work = mkdtempSync(join(tmpdir(), "reviewrouter-signal-test-"));
      try {
        const script = `
set -euo pipefail
work="$1"
signal="$2"
firewall_open=0
suspension_guard_armed=1
recovery_complete=0
worker_fence_restored=0
set_recovery_maintenance() { :; }
compensate_worker_effect_fence() { :; }
compensate_recovery_fleet() {
  printf '%s\n' "$signal" > "$work/compensated"
}
close_firewall() { :; }
${cleanupRecovery}
${terminateRecovery}
trap cleanup EXIT
trap 'terminate_recovery 129' HUP
trap 'terminate_recovery 130' INT
trap 'terminate_recovery 143' TERM
kill -s "$signal" "$$"
printf 'unreachable\n' > "$work/unreachable"
`;
        const result = spawnSync("bash", ["-c", script, "bash", work, signal], {
          encoding: "utf8",
        });
        expect(result.status).toBe(expectedStatus);
        expect(readFileSync(join(work, "compensated"), "utf8").trim()).toBe(
          signal,
        );
        expect(() => readFileSync(join(work, "unreachable"), "utf8")).toThrow();
      } finally {
        rmSync(work, { force: true, recursive: true });
      }
    }

    expect(cleanupRecovery).toContain("trap '' HUP INT TERM");
    expect(terminateRecovery).toContain("trap '' HUP INT TERM");
  });

  it("does not let a repeated cancellation signal interrupt compensation", () => {
    const work = mkdtempSync(join(tmpdir(), "reviewrouter-cleanup-test-"));
    try {
      const script = `
set -euo pipefail
work="$1"
firewall_open=0
suspension_guard_armed=1
recovery_complete=0
worker_fence_restored=0
set_recovery_maintenance() { :; }
compensate_worker_effect_fence() { :; }
compensate_recovery_fleet() {
  kill -TERM "$$"
  printf 'complete\n' > "$work/compensated"
}
close_firewall() { :; }
${cleanupRecovery}
${terminateRecovery}
trap cleanup EXIT
trap 'terminate_recovery 129' HUP
trap 'terminate_recovery 130' INT
trap 'terminate_recovery 143' TERM
false
`;
      const result = spawnSync("bash", ["-c", script, "bash", work], {
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(readFileSync(join(work, "compensated"), "utf8").trim()).toBe(
        "complete",
      );
    } finally {
      rmSync(work, { force: true, recursive: true });
    }
  });

  it("keeps recovery and Action release identities separate", () => {
    expect(workflow).toContain("release_commit_sha:");
    expect(workflow).toContain("action_commit_sha:");
    expect(workflow).toContain(
      "ACTION_COMMIT_SHA: ${{ inputs.action_commit_sha }}",
    );
    expect(workflow).not.toContain(
      "ACTION_COMMIT_SHA: ${{ inputs.release_commit_sha }}",
    );
  });

  it("requires and verifies the exact registration source commit", () => {
    const releaseCommitInput = workflow.slice(
      workflow.indexOf("      release_commit_sha:"),
      workflow.indexOf("      action_commit_sha:"),
    );

    expect(releaseCommitInput).toContain("required: true");
    expect(registerRelease).toContain(
      "RELEASE_COMMIT_SHA: ${{ inputs.release_commit_sha }}",
    );
    expect(registerRelease).toContain(
      "ref: ${{ needs.trust-bootstrap.outputs.trusted_main_sha }}",
    );
    expect(registerRelease).not.toContain(
      "ref: ${{ inputs.release_commit_sha }}",
    );
    expect(registerRelease).toContain("fetch-depth: 0");
    expect(registerRelease).toContain(
      '[[ "$(git cat-file -t "$RELEASE_COMMIT_SHA")" == "commit" ]]',
    );
    expect(registerRelease).toContain(
      'git merge-base --is-ancestor "$RELEASE_COMMIT_SHA" "$TRUSTED_MAIN_SHA"',
    );
    expect(registerRelease).toContain(
      'git switch --detach "$RELEASE_COMMIT_SHA"',
    );
    expect(
      registerRelease.indexOf('git switch --detach "$RELEASE_COMMIT_SHA"'),
    ).toBeLessThan(registerRelease.indexOf("corepack enable"));
    expect(registerRelease).toContain(
      '[[ "$RELEASE_COMMIT_SHA" =~ ^[a-f0-9]{40}$ ]]',
    );
    expect(registerRelease).toContain(
      'observed_source_sha="$(git rev-parse HEAD)"',
    );
    expect(registerRelease).toContain(
      '[[ "$observed_source_sha" == "$RELEASE_COMMIT_SHA" ]]',
    );
    expect(registerRelease).not.toContain("ref: ${{ github.sha }}");
  });

  it("fails closed unless all current live services run the release commit", () => {
    const preflight = registerRelease.indexOf("live_service_preflight='[]'");
    const firstRenderMutation = registerRelease.indexOf("render_api -X PUT");
    const firewallMutation = registerRelease.indexOf(
      'runner_ip="$(curl --fail',
    );

    expect(preflight).toBeGreaterThan(-1);
    expect(firstRenderMutation).toBeGreaterThan(preflight);
    expect(firewallMutation).toBeGreaterThan(preflight);
    expect(registerRelease).toContain(
      '"https://api.render.com/v1/services/$service_id/deploys?limit=1"',
    );
    expect(registerRelease).toContain('all(.observedStatus == "live")');
    expect(registerRelease).toContain(
      "all(.observedCommitSha == $releaseCommitSha)",
    );
    expect(registerRelease).toContain("live-service-preflight.json");
  });

  it("pins every redeploy and verifies its observed live commit", () => {
    expect(registerRelease).toContain(
      '"https://api.render.com/v1/services/$service_id/deploys"',
    );
    expect(registerRelease).toContain(
      "'{clearCache: \"do_not_clear\", commitId: $commitId}'",
    );
    expect(registerRelease).toContain(
      '--data-binary @"$work/deploy-request.json"',
    );
    expect(registerRelease).not.toContain(
      '--data-binary \'{"clearCache":"do_not_clear"}\'',
    );
    expect(registerRelease).toContain("deadline=$((SECONDS + 900))");
    expect(registerRelease).toContain(
      'if [[ "$observed_commit_sha" != "$RELEASE_COMMIT_SHA" ]]',
    );
    expect(registerRelease).toContain(
      "all(.observedCommitSha == $releaseCommitSha)",
    );
    expect(registerRelease).toContain("deployment-result.json");
  });

  it("reconciles an accepted deploy without blindly repeating the mutation", () => {
    const deployMutation = registerRelease.slice(
      registerRelease.indexOf("render_deploy_mutation()"),
      registerRelease.indexOf("close_firewall()"),
    );
    const createCalls = registerRelease.match(
      /render_deploy_mutation -X POST/gu,
    );

    expect(deployMutation).not.toContain("--retry");
    expect(createCalls).toHaveLength(1);
    expect(registerRelease).toContain(
      'before_deploy_id="$(\n              jq -er --arg serviceId "$service_id"',
    );
    expect(registerRelease).toContain(
      "deploy_intent_at=\"$(node -e 'process.stdout.write(new Date().toISOString())')\"",
    );
    expect(registerRelease).not.toContain("deploys?limit=20");
    expect(registerRelease.replace(/^ {10}/gmu, "")).toContain(
      fetchRecoveryDeploymentInventory,
    );
    expect(registerRelease.replace(/^ {10}/gmu, "")).toContain(
      renderInventoryApi,
    );
    expect(registerRelease).toContain(
      'fetch_registration_deployment_inventory "$service_id" "$reconciliation_deadline"',
    );
    expect(registerRelease).toContain('[[ "$deploy_id" =~ ^dep-[a-z0-9-]+$ ]]');
    expect(registerRelease).toContain(".[0].deployId == $beforeDeployId");
    expect(registerRelease).toContain(
      "($beforeDeployIds | index($id)) == null",
    );
    expect(
      extractRecoveryJqFilter(
        "recovery_reconciliation_filter",
        registerRelease,
      ),
    ).toBe(recoveryReconciliationFilter);
    expect(registerRelease).toContain(
      '--argjson intentDeadlineEpoch "$((deploy_intent_epoch + 120))"',
    );
    expect(registerRelease).toContain("candidate_count > 1");
    expect(registerRelease).toContain(
      "reconciliation_deadline=$((SECONDS + 120))",
    );
    expect(registerRelease).toContain("deploy-creation-evidence.json");
    expect(registerRelease).toContain("deploy-reconciliation-$service_id.json");
  });

  it("allows absent pending commit metadata but requires exact live metadata", () => {
    expect(registerRelease).toContain(
      '(.commit.id // .commit.sha // .commitId // "")',
    );
    expect(registerRelease).toContain(
      'if [[ -n "$observed_commit_sha" && "$observed_commit_sha" != "$RELEASE_COMMIT_SHA" ]]',
    );
    expect(registerRelease).toContain(
      'live)\n                  if [[ "$observed_commit_sha" != "$RELEASE_COMMIT_SHA" ]]',
    );
  });

  it("rejects a concurrent newer deploy after pinned deploy convergence", () => {
    const exactDeployPolling = registerRelease.indexOf('deploys/$deploy_id"');
    const completeHistoryReread = registerRelease.lastIndexOf(
      'fetch_registration_deployment_inventory "$service_id" "$((SECONDS + 120))"',
    );

    expect(completeHistoryReread).toBeGreaterThan(exactDeployPolling);
    expect(registerRelease).toContain(
      '.deployId == $expectedDeployId\n                and .status == "live"',
    );
    expect(registerRelease).toContain(
      "and .observedCommitSha == $releaseCommitSha",
    );
    expect(registerRelease).toContain("current-deployment-result.json");
  });

  it("provisions custody through migration 000089 without exposing credentials", () => {
    expect(workflow).toContain(
      'username: "reviewrouter_comment_token_custody"',
    );
    expect(workflow).toContain("RR_CUSTODY_PASSWORD");
    expect(workflow).toContain(
      '{ role: "comment-token-custody", username: "reviewrouter_comment_token_custody" }',
    );
    expect(workflow).toContain(
      "REVIEW_ROUTER_COMMENT_TOKEN_CUSTODY_DATABASE_URL",
    );
    expect(workflow).toContain(
      ".latestMigration == $canonical[0].latestMigration",
    );
    expect(workflow).toContain(
      ".appliedMigrationCount == $canonical[0].appliedMigrationCount",
    );
    expect(workflow).toContain("canonicalPrismaMigrationCatalog");
    expect(canonicalPrismaMigrationCatalog).toEqual({
      appliedMigrationCount: 92,
      latestMigration: "000089_codex_oauth_v4_v5_staged_compatibility",
    });
    expect(workflow).toContain(".runtimeRoleCount == 5");
    expect(workflow).toContain(".custodyFunction == true");
    expect(workflow).not.toMatch(/echo .*RR_CUSTODY_PASSWORD/u);
  });

  it("fences and drains custody sessions before installing the new password", () => {
    const noLogin = workflow.indexOf(
      "ALTER ROLE reviewrouter_comment_token_custody NOLOGIN;",
    );
    const commit = workflow.indexOf("COMMIT;", noLogin);
    const terminate = workflow.indexOf(
      "SELECT pg_terminate_backend(pid)",
      commit,
    );
    const proveEmpty = workflow.indexOf(
      "custody credential rotation retained an old backend",
      terminate,
    );
    const begin = workflow.indexOf("BEGIN;", proveEmpty);
    const rotate = workflow.indexOf(
      "ALTER ROLE reviewrouter_comment_token_custody LOGIN NOCREATEROLE PASSWORD",
      begin,
    );
    expect(noLogin).toBeGreaterThan(0);
    expect(commit).toBeGreaterThan(noLogin);
    expect(terminate).toBeGreaterThan(commit);
    expect(proveEmpty).toBeGreaterThan(terminate);
    expect(begin).toBeGreaterThan(proveEmpty);
    expect(rotate).toBeGreaterThan(begin);
  });

  it("leaves global, workspace and repository activation to explicit workflows", () => {
    expect(workflow).not.toContain("open_global_emergency");
    expect(workflow).not.toContain("OPEN_GLOBAL_EMERGENCY");
    expect(workflow).not.toContain('"emergency",');
    expect(workflow).not.toContain("emergency-control-result.json");
    expect(workflow).toContain("Explicit activation workflows");
    expect(workflow).toContain(
      "OPERATOR_REPOSITORY: ${{ inputs.operator_repository }}",
    );
    expect(workflow).toContain(
      "OPERATOR_WORKSPACE_ID: ${{ inputs.operator_workspace_id }}",
    );
  });

  it("proves the exact investigation rollout target before deployment", () => {
    expect(workflow).toContain('"investigation",');
    expect(workflow).toContain('"rollout-status",');
    expect(workflow).toContain('"--release",');
    expect(workflow).toContain("attestation.producerReleaseId,");
    expect(workflow).not.toContain(
      '"--release",\n                  releaseKey,',
    );
    expect(workflow).toContain('"--provider",');
    expect(workflow).toContain('rolloutProfile === "production"');
    // A closed global gate deliberately denies activation; diagnostics must
    // not force recovery to open it to stage a production profile.
    expect(workflow).not.toContain(
      "review_v2_investigation_profile_not_allowed",
    );
    expect(workflow).toContain("investigation-rollout-status-result.json");
    expect(workflow).toContain("investigation-rollout-status-diagnostic.json");
  });

  it("persists and verifies an explicit investigation rollout profile", () => {
    expect(workflow).toContain("investigation_rollout_profile:");
    expect(workflow).toContain("- preserve");
    expect(workflow).toContain("- shadow");
    expect(workflow).toContain("- production");
    expect(workflow).toContain("put_investigation_env");
    expect(workflow).toContain(
      "REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED",
    );
    expect(workflow).toContain(
      "REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED",
    );
    expect(workflow).toContain("repositoryConnectionIds");
    expect(workflow).toContain("producerReleaseIds");
    expect(workflow).toContain(
      '[[ "$INVESTIGATION_PRODUCER_RELEASE_ID" == "$attested_producer_release_id" ]]',
    );
    expect(workflow).toContain(
      "review_v2_investigation_producer_release_mismatch",
    );
    expect(workflow).toContain("investigation-env-proof.json");
  });

  it("preserves registration evidence and redacted diagnostics", () => {
    expect(workflow).toContain("registration-result.json");
    expect(workflow).toContain("database_permission_denied");
    expect(workflow).toContain("database_connection_failed");
    expect(workflow).toContain("review_safety_control_conflict");
    expect(workflow).not.toContain("emergency-error.log");
  });
});

describe("recovery complete command-substitution observers", () => {
  const roles = ["api", "worker", "web"];
  const bindings = roles.map((role) => ({
    serviceId: `srv-${role}`,
    deployId: `dep-${role}`,
  }));
  const cases = [
    "valid",
    "read-failure",
    "malformed",
    "wrong-id",
    "wrong-commit",
    "not-live",
    "inventory-failure",
    "inventory-valid-output-failure",
    "valid-output-read-failure",
    "construction-failure",
    "inventory-malformed",
    "historical-same-commit",
    "competing-active",
    "same-commit-replacement",
  ];
  for (const fleet of [false, true]) {
    for (const scenario of cases) {
      it(`${fleet ? "fleet" : "single"} rejects ${scenario} without errexit inheritance`, () => {
        const work = mkdtempSync(join(tmpdir(), "pr247-observer-"));
        try {
          const before = (role: string) => ({
            serviceId: `srv-${role}`,
            deployId: `dep-old-${role}`,
            createdAt: "1970-01-01T00:00:02Z",
            observedCommitSha: "b".repeat(40),
            observedImageDigest: null,
            deploymentIdentityKind: "git",
            observedStatus: "live",
            statusClass: "active",
          });
          const tuple = {
            operationId: "observer",
            targetDbId: "dpg-test",
            ownerId: "tea-test",
            environmentId: "evm-test",
            releaseCommitSha,
            services: Object.fromEntries(
              roles.map((role) => [
                role,
                {
                  id: `srv-${role}`,
                  name: `reviewrouter-${role}`,
                  type: role === "worker" ? "background_worker" : "web_service",
                  ownerId: "tea-test",
                  environmentId: "evm-test",
                  repo: "https://github.com/777genius/review-router-saas",
                  branch: "main",
                  autoDeploy: "no",
                  configFingerprint: "c".repeat(64),
                },
              ]),
            ),
          };
          let state = advanceRecoveryPhase(
            advanceRecoveryPhase(
              createRecoveryJournal(
                tuple,
                Object.fromEntries(roles.map((role) => [role, [before(role)]])),
              ),
              "frozen",
            ),
            "prepared",
          );
          for (const role of roles) {
            state = advanceRecoveryService(state, role, "resume_intent");
            state = advanceRecoveryService(state, role, "resumed");
            state = advanceRecoveryService(state, role, "deploy_intent", {
              inventory: [before(role)],
              intentEpoch: 1,
            });
            state = advanceRecoveryService(state, role, "deploy_bound", {
              deployId: `dep-${role}`,
            });
            state = advanceRecoveryService(state, role, "verified", {
              inventory: [
                {
                  ...before(role),
                  deployId: `dep-${role}`,
                  observedCommitSha: releaseCommitSha,
                },
                {
                  ...before(role),
                  observedStatus: "deactivated",
                  statusClass: "terminal",
                },
              ],
            });
          }
          writeFileSync(
            join(work, "recovery-journal.json"),
            JSON.stringify(state),
          );
          const script = `
set -uo pipefail
work="$WORK"
shopt -u inherit_errexit
${fetchRecoveryDeploymentInventory}
${extractRecoveryBashFunction("observe_bound_recovery_deployment")}
${extractRecoveryBashFunction("observe_bound_recovery_deployments")}
render_inventory_api() {
  local url="$2" role=api
  [[ "$url" != *srv-worker* ]] || role=worker
  [[ "$url" != *srv-web* ]] || role=web
  local id="dep-$role" commit="$RELEASE_COMMIT_SHA" status=live
  if [[ "$url" == *limit=100 ]]; then
    [[ "$SCENARIO" != inventory-failure ]] || return 22
    if [[ "$SCENARIO" == inventory-malformed ]]; then printf 'broken'; return; fi
    local extra
    extra="$(jq -nc --arg role "$role" '[{id:("dep-old-"+$role),status:"deactivated",commit:{id:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}]')"
    if [[ "$SCENARIO" == competing-active ]]; then
      extra='[{"id":"dep-competing","status":"build_in_progress","commit":{"id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}]'
    elif [[ "$SCENARIO" == historical-same-commit ]]; then
      extra="$(jq -nc --arg sha "$commit" '[{id:"dep-history", status:"deactivated", commit:{id:$sha}}]')"
    elif [[ "$SCENARIO" == same-commit-replacement ]]; then
      extra="$(jq -nc --arg id "$id" --arg sha "$commit" '[{id:$id, status:"deactivated", commit:{id:$sha}}]')"
      id=dep-replacement
    fi
    jq -nc --arg id "$id" --arg sha "$commit" --argjson extra "$extra" '([{id:$id, status:"live", commit:{id:$sha}}] + $extra) | map(.createdAt="1970-01-01T00:00:02Z")'
    [[ "$SCENARIO" != inventory-valid-output-failure ]] || return 22
  else
    [[ "$SCENARIO" != read-failure ]] || return 22
    if [[ "$SCENARIO" == malformed ]]; then printf 'broken'; return; fi
    [[ "$SCENARIO" != wrong-id ]] || id=dep-wrong
    [[ "$SCENARIO" != wrong-commit ]] || commit=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    [[ "$SCENARIO" != not-live ]] || status=build_in_progress
    jq -nc --arg id "$id" --arg sha "$commit" --arg status "$status" '{id:$id, status:$status, commit:{id:$sha},createdAt:"1970-01-01T00:00:02Z"}'
    [[ "$SCENARIO" != valid-output-read-failure ]] || return 22
  fi
}
jq() {
  if [[ "$SCENARIO" == construction-failure && "$*" == *"--argjson exact"* ]]; then return 23; fi
  command jq "$@"
}
set -e
${fleet ? 'result="$(observe_bound_recovery_deployments "$BINDINGS" "$WORK/evidence.json" 999)"' : 'result="$(observe_bound_recovery_deployment srv-api dep-api 999)"'}
${fleet ? 'cat "$WORK/evidence.json"' : `printf '%s\\n' "$result"`}
`;
          const result = spawnSync("bash", ["-c", script], {
            encoding: "utf8",
            env: {
              ...subprocessEnv,
              WORK: work,
              SCENARIO: scenario,
              BINDINGS: JSON.stringify(bindings),
              RELEASE_COMMIT_SHA: releaseCommitSha,
              recovery_deployment_inventory_filter:
                recoveryDeploymentInventoryFilter,
              recovery_exact_deployment_filter: recoveryExactDeploymentFilter,
              recovery_bound_inventory_filter: recoveryBoundInventoryFilter,
              recovery_deployment_set_filter: recoveryDeploymentSetFilter,
            },
          });
          expect(result.status === 0, result.stderr).toBe(
            ["valid"].includes(scenario),
          );
          if (!["valid"].includes(scenario)) expect(result.stdout).toBe("");
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      });
    }
  }
});

describe("canonical fleet preflight ordering", () => {
  const ids = ["srv-api", "srv-worker", "srv-web"];
  const permutations = ids.flatMap((a) =>
    ids
      .filter((b) => b !== a)
      .map((b) => [a, b, ids.find((c) => c !== a && c !== b)!]),
  );
  for (const supplied of [...permutations, [ids[0]!, ids[0]!, ids[2]!]]) {
    for (const defect of [
      "none",
      "renamed",
      "wrong-owner",
      "wrong-environment",
      "wrong-repo",
      "wrong-branch",
      "auto-deploy",
      "ambiguous",
      "read-failure",
    ]) {
      it(`checks ${supplied.join("/")} with ${defect} before mutation`, () => {
        const script = `
set -uo pipefail
assert_recovery_trusted_topology() { :; }
render_inventory_api() { shift; render_api "$@"; }
${extractRecoveryBashFunction("assert_recovery_fleet_identity")}
render_api() {
  [[ "$DEFECT" != read-failure ]] || return 22
  local id="\${1##*/}" name type=web_service owner=tea-test environment=evm-test
  case "$id" in
    srv-api) name=reviewrouter-api ;;
    srv-worker) name=reviewrouter-worker; type=background_worker ;;
    srv-web) name=reviewrouter-web ;;
  esac
  [[ "$DEFECT" != renamed ]] || name=renamed
  [[ "$DEFECT" != wrong-owner ]] || owner=tea-wrong
  [[ "$DEFECT" != wrong-environment ]] || environment=evm-wrong
  local repo=https://github.com/777genius/review-router-saas branch=main autoDeploy=no
  [[ "$DEFECT" != wrong-repo ]] || repo=https://github.com/other/repo
  [[ "$DEFECT" != wrong-branch ]] || branch=staging
  [[ "$DEFECT" != auto-deploy ]] || autoDeploy=yes
  local value
  value="$(jq -nc --arg id "$id" --arg name "$name" --arg type "$type" --arg owner "$owner" --arg environment "$environment" --arg repo "$repo" --arg branch "$branch" --arg autoDeploy "$autoDeploy" '{id:$id,name:$name,type:$type,ownerId:$owner,environmentId:$environment,suspended:"not_suspended",repo:$repo,branch:$branch,autoDeploy:$autoDeploy}')"
  if [[ "$DEFECT" == ambiguous ]]; then printf '[%s,%s]' "$value" "$value"; else printf '%s' "$value"; fi
}
set -e
result="$(assert_recovery_fleet_identity)"
printf mutation
`;
        const result = spawnSync("bash", ["-c", script], {
          encoding: "utf8",
          env: {
            ...subprocessEnv,
            API_SERVICE_ID: supplied[0],
            WORKER_SERVICE_ID: supplied[1],
            WEB_SERVICE_ID: supplied[2],
            RENDER_OWNER_ID: "tea-test",
            RENDER_ENVIRONMENT_ID: "evm-test",
            DEFECT: defect,
            service_scope_filter: extractRecoveryJqFilter(
              "service_scope_filter",
            ),
          },
        });
        const valid = supplied.join() === ids.join() && defect === "none";
        expect(result.status === 0, result.stderr).toBe(valid);
        expect(result.stdout).toBe(valid ? "mutation" : "");
      });
    }
  }
  it("uses the same complete executable preflight for release registration", () => {
    expect(
      extractRecoveryBashFunction(
        "assert_recovery_fleet_identity",
        registerRelease,
      ),
    ).toBe(extractRecoveryBashFunction("assert_recovery_fleet_identity"));
    expect(
      registerRelease.indexOf("          assert_recovery_fleet_identity\n"),
    ).toBeLessThan(registerRelease.indexOf("          firewall_open=1"));
  });
  it("runs the complete preflight before the first suspension", () => {
    expect(
      recover.indexOf("          assert_recovery_fleet_identity\n"),
    ).toBeLessThan(recover.indexOf("          # Converge both"));
    const contract = readFileSync("render.yaml", "utf8");
    for (const role of ["api", "worker", "web"])
      expect(contract).toContain(`name: reviewrouter-${role}`);
  });
});

describe("retained Render recovery journal", () => {
  const tuple = {
    operationId: "recovery-test",
    targetDbId: "dpg-target",
    ownerId: "tea-owner",
    environmentId: "evm-production",
    releaseCommitSha,
    services: Object.fromEntries(
      recoveryRoles.map((role) => [
        role,
        {
          id: `srv-${role}`,
          name: `reviewrouter-${role}`,
          type: role === "worker" ? "background_worker" : "web_service",
          ownerId: "tea-owner",
          environmentId: "evm-production",
          repo: "https://github.com/777genius/review-router-saas",
          branch: "main",
          autoDeploy: "no",
          configFingerprint: "c".repeat(64),
        },
      ]),
    ),
  };
  const inventory = (role: string, id = `dep-old-${role}`) => [
    {
      serviceId: `srv-${role}`,
      deployId: id,
      statusClass: "active",
      observedStatus: "live",
      deploymentIdentityKind: "git",
      observedCommitSha: "b".repeat(40),
      observedImageDigest: null,
      createdAt: "2026-09-05T00:00:00Z",
    },
  ];
  const inventories = Object.fromEntries(
    recoveryRoles.map((role) => [role, inventory(role)]),
  );
  const fresh = () => createRecoveryJournal(tuple, inventories);
  const prepared = () =>
    advanceRecoveryPhase(advanceRecoveryPhase(fresh(), "frozen"), "prepared");
  const epoch = Date.parse("2026-09-05T01:00:00Z") / 1000;
  const intent = () =>
    advanceRecoveryService(
      advanceRecoveryService(
        advanceRecoveryService(prepared(), "api", "resume_intent"),
        "api",
        "resumed",
      ),
      "api",
      "deploy_intent",
      { inventory: inventory("api"), intentEpoch: epoch },
    );
  const candidate = {
    ...inventory("api", "dep-target-api")[0]!,
    observedCommitSha: releaseCommitSha,
    createdAt: "2026-09-05T01:00:01Z",
  };

  it("retains every durable fleet and per-service phase across process serialization", () => {
    let state = fresh();
    const restart = () => {
      const encoded = JSON.stringify(state);
      const loaded = loadRecoveryJournal(encoded, tuple);
      expect(loaded).toEqual(state);
      expect(JSON.stringify(state)).toBe(encoded);
      return loaded;
    };
    restart();
    state = advanceRecoveryPhase(state, "frozen");
    restart();
    state = advanceRecoveryPhase(state, "prepared");
    restart();
    for (const role of recoveryRoles) {
      for (const [phase, action] of [
        ["resume_intent", "observe_resume"],
        ["resumed", "prepare_deploy_intent"],
        ["deploy_intent", "reconcile_deploy"],
        ["deploy_bound", "observe_exact_deploy"],
        ["verified", "verify_exact_deploy"],
      ]) {
        state = advanceRecoveryService(state, role, phase, {
          inventory:
            phase === "verified"
              ? [
                  {
                    ...inventory(role, `dep-target-${role}`)[0]!,
                    observedCommitSha: releaseCommitSha,
                    createdAt: "2026-09-05T01:00:01Z",
                  },
                  ...inventory(role).map((item) => ({
                    ...item,
                    observedStatus: "deactivated",
                    statusClass: "terminal",
                  })),
                ]
              : inventory(role),
          intentEpoch: epoch,
          deployId: `dep-target-${role}`,
        });
        expect(recoveryRestartAction(restart(), role)).toBe(action);
      }
    }
    state = advanceRecoveryPhase(state, "fleet_verified_closed");
    restart();
    state = advanceRecoveryPhase(state, "complete");
    restart();
    for (const role of recoveryRoles)
      expect(recoveryRestartAction(state, role)).toBe("already_complete");
  });

  for (const key of [
    "operationId",
    "targetDbId",
    "ownerId",
    "environmentId",
    "releaseCommitSha",
    "services",
  ]) {
    it(`rejects altered retained ${key} before planning an effect`, () => {
      expect(() =>
        loadRecoveryJournal(
          { ...fresh(), tuple: { ...tuple, [key]: "changed" } },
          tuple,
        ),
      ).toThrow("tuple_mismatch");
    });
  }
  for (const value of [
    undefined,
    null,
    {},
    "invalid",
    { schemaVersion: 1 },
    { ...fresh(), services: {} },
  ]) {
    it(`does not turn missing/legacy/malformed history into fresh work: ${JSON.stringify(value)}`, () => {
      expect(() => loadRecoveryJournal(value, tuple)).toThrow();
    });
  }
  it("never grants a second POST after a retained intent or ID", () => {
    const pending = intent();
    expect(recoveryRestartAction(pending, "api")).toBe("reconcile_deploy");
    expect(() =>
      advanceRecoveryService(pending, "api", "deploy_intent"),
    ).toThrow();
    const bound = reconcileRecoveryDeploy(
      pending,
      "api",
      [...inventory("api"), candidate],
      epoch + 5,
    );
    expect(recoveryRestartAction(bound, "api")).toBe("observe_exact_deploy");
    expect(() =>
      reconcileRecoveryDeploy(
        bound,
        "api",
        [...inventory("api"), candidate],
        epoch + 10,
      ),
    ).toThrow();
    expect(() =>
      advanceRecoveryService(bound, "api", "deploy_bound", {
        deployId: "dep-replacement",
      }),
    ).toThrow();
    expect(loadRecoveryJournal(JSON.stringify(bound), tuple)).toEqual(bound);
  });
  for (const scenario of [
    "no-effect",
    "missing-history",
    "multiple",
    "wrong-commit",
    "wrong-service",
    "before-window",
    "after-window",
    "unknown-status",
  ]) {
    it(`stops lost-response reconciliation on ${scenario}`, () => {
      let observed = [...inventory("api"), candidate];
      if (scenario === "no-effect") observed = inventory("api");
      if (scenario === "missing-history") observed = [candidate];
      if (scenario === "multiple")
        observed.push({ ...candidate, deployId: "dep-extra" });
      if (scenario === "wrong-commit")
        observed[1] = { ...candidate, observedCommitSha: "d".repeat(40) };
      if (scenario === "wrong-service")
        observed[1] = { ...candidate, serviceId: "srv-web" };
      if (scenario === "before-window")
        observed[1] = { ...candidate, createdAt: "2026-09-05T00:00:00Z" };
      if (scenario === "after-window")
        observed[1] = { ...candidate, createdAt: "2026-09-05T02:00:00Z" };
      if (scenario === "unknown-status")
        observed[1] = { ...candidate, statusClass: "unknown" };
      const pending = intent();
      expect(() =>
        reconcileRecoveryDeploy(pending, "api", observed, epoch + 5),
      ).toThrow();
      expect(recoveryRestartAction(pending, "api")).toBe("reconcile_deploy");
    });
  }
  it("never widens the retained POST window when a later process reconciles", () => {
    const pending = loadRecoveryJournal(JSON.stringify(intent()), tuple);
    const late = { ...candidate, createdAt: "2026-09-05T01:05:00Z" };
    expect(() =>
      reconcileRecoveryDeploy(
        pending,
        "api",
        [...inventory("api"), late],
        epoch + 600,
      ),
    ).toThrow("candidate");
    expect(() =>
      reconcileRecoveryDeploy(
        pending,
        "api",
        [...inventory("api"), candidate],
        epoch + 600,
      ),
    ).not.toThrow();
  });
  it("enforces fixed service order, migration-first and complete fleet proof", () => {
    expect(() =>
      advanceRecoveryService(fresh(), "api", "resume_intent"),
    ).toThrow();
    expect(() =>
      advanceRecoveryService(prepared(), "web", "resume_intent"),
    ).toThrow();
    expect(() =>
      advanceRecoveryPhase(prepared(), "fleet_verified_closed"),
    ).toThrow();
    expect(() => advanceRecoveryPhase(fresh(), "prepared")).toThrow();
  });
  it("permits only the retained predecessor during replacement and only target at final proof", () => {
    const bound = reconcileRecoveryDeploy(
      intent(),
      "api",
      [...inventory("api"), candidate],
      epoch + 5,
    );
    expect(() =>
      assertRecoveryDeploymentInventory(
        bound,
        "api",
        [candidate, ...inventory("api")],
        true,
      ),
    ).not.toThrow();
    expect(() =>
      assertRecoveryDeploymentInventory(bound, "api", [
        candidate,
        ...inventory("api"),
      ]),
    ).toThrow("competitor");
    expect(() =>
      assertRecoveryDeploymentInventory(bound, "api", [
        candidate,
        ...inventory("api").map((item) => ({
          ...item,
          observedStatus: "deactivated",
          statusClass: "terminal",
        })),
      ]),
    ).not.toThrow();
    expect(() =>
      assertRecoveryDeploymentInventory(
        bound,
        "api",
        [
          candidate,
          ...inventory("api"),
          { ...candidate, deployId: "dep-unexpected" },
        ],
        true,
      ),
    ).toThrow("unrelated_history");
    expect(() =>
      assertRecoveryDeploymentInventory(bound, "api", [
        { ...candidate, deployId: "dep-replacement" },
        {
          ...candidate,
          statusClass: "terminal",
          observedStatus: "deactivated",
        },
      ]),
    ).toThrow();
    expect(() =>
      assertRecoveryDeploymentInventory(
        bound,
        "api",
        [
          {
            ...candidate,
            observedStatus: "build_failed",
            statusClass: "terminal",
          },
          ...inventory("api"),
        ],
        true,
      ),
    ).toThrow("failed");
  });
  it("fingerprints every runtime value, ignores only the save-only journal and rejects duplicate keys", () => {
    const env = [
      { key: "DATABASE_URL", value: "test-only" },
      { key: "FLAG", value: "off" },
    ];
    const fingerprint = recoveryConfigFingerprint(env);
    expect(recoveryConfigFingerprint([...env].reverse())).toBe(fingerprint);
    expect(
      recoveryConfigFingerprint([
        ...env,
        { key: recoveryJournalKey, value: "new-phase" },
      ]),
    ).toBe(fingerprint);
    expect(
      recoveryConfigFingerprint([{ ...env[0]!, value: "changed" }, env[1]!]),
    ).not.toBe(fingerprint);
    expect(() => recoveryConfigFingerprint([...env, env[0]!])).toThrow(
      "duplicate",
    );
  });
  it("rejects missing, legacy and torn replicas instead of granting mutation authority", () => {
    const state = prepared();
    expect(loadRecoveryReplicas([state, state, state], tuple)).toEqual(state);
    for (const replicas of [
      [state, null, state],
      [state, { ...state, revision: state.revision + 1 }, state],
      [{ schemaVersion: 1 }, state, state],
    ]) {
      expect(() => loadRecoveryReplicas(replicas, tuple)).toThrow();
    }
  });

  it("resumes only unstarted bootstrap and rejects ambiguous credential effects", () => {
    expect(recoveryContinuationMode(fresh())).toBe("bootstrap");
    expect(() =>
      recoveryContinuationMode({ ...fresh(), workerFence: {} }),
    ).toThrow("bootstrap_retained_effects");
    expect(() => recoveryContinuationMode({ ...fresh(), revision: 1 })).toThrow(
      "bootstrap_validated_history",
    );
    const frozen = advanceRecoveryPhase(fresh(), "frozen");
    expect(
      recoveryContinuationMode({
        ...frozen,
        bootstrapPhase: "services_suspended",
      }),
    ).toBe("bootstrap");
    for (const bootstrapPhase of [
      "credential_rotation_intent",
      "credentials_rotated",
      "worker_fence_intent",
      "migration_complete",
      "service_credentials_staged",
    ]) {
      expect(() =>
        recoveryContinuationMode({ ...frozen, bootstrapPhase }),
      ).toThrow("preparation_missing");
    }
  });
  it("retains validated worker restoration evidence and effective configuration in preparation", () => {
    const fence = planWorkerEffectFence({
      owner: "schema_owner",
      role: {
        name: "reviewrouter_worker",
        superuser: false,
        createRole: false,
        bypassRls: false,
      },
      memberships: [],
      tableAcl: [
        {
          grantee: "reviewrouter_worker",
          grantor: "schema_owner",
          privilege: "UPDATE",
          grantable: false,
        },
      ],
      columnAcl: [],
      effectiveUpdate: true,
      effectiveColumnUpdate: true,
    });
    const fingerprints = Object.fromEntries(
      recoveryRoles.map((role) => [
        role,
        { serviceId: `srv-${role}`, fingerprint: "d".repeat(64) },
      ]),
    );
    const state = attachRecoveryPreparation(
      advanceRecoveryPhase(fresh(), "frozen"),
      fingerprints,
      fence,
    );
    expect(recoveryContinuationMode(state)).toBe("fleet");
    expect(state.workerFence).toEqual(fence);
    expect(state.runtimeConfigFingerprints).toEqual(fingerprints);
    expect(() =>
      recoveryContinuationMode({ ...state, workerFence: null }),
    ).toThrow();
    expect(() =>
      recoveryContinuationMode({
        ...state,
        runtimeConfigFingerprints: {
          ...fingerprints,
          worker: { serviceId: "srv-wrong", fingerprint: "d".repeat(64) },
        },
      }),
    ).toThrow();
  });

  it("retains only exact compensation evidence across torn terminal writes", () => {
    const fence = planWorkerEffectFence({
      owner: "schema_owner",
      role: {
        name: "reviewrouter_worker",
        superuser: false,
        createRole: false,
        bypassRls: false,
      },
      memberships: [],
      tableAcl: [
        {
          grantee: "reviewrouter_worker",
          grantor: "schema_owner",
          privilege: "UPDATE",
          grantable: false,
        },
      ],
      columnAcl: [],
      effectiveUpdate: true,
      effectiveColumnUpdate: true,
    });
    const state = { ...prepared(), workerFence: fence };
    const torn = [state, { ...state, revision: state.revision + 1 }, state];
    expect(recoveryCompensationFence(torn, tuple)).toEqual(fence);
    expect(() => loadRecoveryReplicas(torn, tuple)).toThrow(
      "replica_disagreement",
    );
    expect(
      recoveryCompensationFence([prepared(), prepared(), prepared()], tuple),
    ).toBeNull();
    for (const changed of [
      null,
      { ...state, workerFence: null },
      {
        ...state,
        workerFence: { ...fence, before: { ...fence.before, owner: "other" } },
      },
      { ...state, tuple: { ...tuple, targetDbId: "dpg-other" } },
    ]) {
      expect(() =>
        recoveryCompensationFence([state, changed, state], tuple),
      ).toThrow();
    }
  });

  const startupScript = (() => {
    const marker = recover.indexOf(
      '          const retained = read("recovery-resume-state.json");',
    );
    const start =
      recover.lastIndexOf("<<'NODE'\n", marker) + "<<'NODE'\n".length;
    const end = recover.indexOf("\n          NODE", marker);
    return recover.slice(start, end).replace(/^ {10}/gmu, "");
  })();
  const startupCase = (phase: string) => {
    const environment = [
      { key: "DATABASE_URL", value: "postgresql://role:fake@db/test" },
    ];
    const fingerprint = recoveryConfigFingerprint(environment);
    const scopedTuple = structuredClone(tuple);
    for (const role of recoveryRoles)
      scopedTuple.services[role]!.configFingerprint = fingerprint;
    const base = createRecoveryJournal(scopedTuple, inventories);
    let state: ReturnType<typeof createRecoveryJournal> & {
      bootstrapPhase?: string;
    } = base;
    if (phase !== "validated") state = advanceRecoveryPhase(base, "frozen");
    if (phase === "frozen") state.bootstrapPhase = "services_suspended";
    const unsafeBootstrap = [
      "credential_rotation_intent",
      "credentials_rotated",
      "worker_fence_intent",
      "migration_complete",
      "service_credentials_staged",
    ].includes(phase);
    if (unsafeBootstrap) state.bootstrapPhase = phase;
    const fence = planWorkerEffectFence({
      owner: "schema_owner",
      role: {
        name: "reviewrouter_worker",
        superuser: false,
        createRole: false,
        bypassRls: false,
      },
      memberships: [],
      tableAcl: [
        {
          grantee: "reviewrouter_worker",
          grantor: "schema_owner",
          privilege: "UPDATE",
          grantable: false,
        },
      ],
      columnAcl: [],
      effectiveUpdate: true,
      effectiveColumnUpdate: true,
    });
    if (!unsafeBootstrap && phase !== "validated" && phase !== "frozen") {
      state = attachRecoveryPreparation(
        state,
        Object.fromEntries(
          recoveryRoles.map((role) => [
            role,
            { serviceId: `srv-${role}`, fingerprint },
          ]),
        ),
        fence,
      );
      if (phase !== "prepared") {
        for (const role of recoveryRoles) {
          state = advanceRecoveryService(state, role, "resume_intent");
          state = advanceRecoveryService(state, role, "resumed");
          state = advanceRecoveryService(state, role, "deploy_intent", {
            inventory: inventories[role],
            intentEpoch: epoch,
          });
          state = advanceRecoveryService(state, role, "deploy_bound", {
            deployId: `dep-target-${role}`,
          });
          state = advanceRecoveryService(state, role, "verified", {
            inventory: [
              {
                ...inventory(role)[0],
                deployId: `dep-target-${role}`,
                observedCommitSha: releaseCommitSha,
                createdAt: "2026-09-05T01:00:01Z",
              },
              ...inventory(role).map((item) => ({
                ...item,
                observedStatus: "deactivated",
                statusClass: "terminal",
              })),
            ],
          });
        }
        state = advanceRecoveryPhase(state, "fleet_verified_closed");
        if (phase === "complete")
          state = advanceRecoveryPhase(state, "complete");
      }
    }
    return { environment, state, fence };
  };

  it.each([
    "validated",
    "frozen",
    "credential_rotation_intent",
    "credentials_rotated",
    "worker_fence_intent",
    "migration_complete",
    "service_credentials_staged",
    "prepared",
    "fleet_verified_closed",
    "complete",
    "torn_terminal",
    "observed_bootstrap_effect",
  ])("executes workflow startup from durable %s", (phase) => {
    const work = mkdtempSync(join(tmpdir(), "recovery-startup-"));
    try {
      const { environment, state, fence } = startupCase(
        phase === "torn_terminal"
          ? "fleet_verified_closed"
          : phase === "observed_bootstrap_effect"
            ? "validated"
            : phase,
      );
      const replicas =
        phase === "torn_terminal"
          ? [state, advanceRecoveryPhase(state, "complete"), state]
          : [state, state, state];
      writeFileSync(
        join(work, "recovery-resume-state.json"),
        JSON.stringify(replicas),
      );
      for (const role of recoveryRoles) {
        writeFileSync(
          join(work, `initial-srv-${role}-env.json`),
          JSON.stringify(environment),
        );
        writeFileSync(
          join(work, `initial-srv-${role}-inventory.json`),
          JSON.stringify(inventories[role]),
        );
      }
      if (phase === "observed_bootstrap_effect")
        writeFileSync(
          join(work, "initial-srv-api-inventory.json"),
          JSON.stringify([
            {
              ...inventory("api")[0],
              deployId: "dep-unexpected",
              observedCommitSha: releaseCommitSha,
            },
          ]),
        );
      const result = spawnSync(process.execPath, ["--input-type=module"], {
        input: startupScript,
        encoding: "utf8",
        env: {
          ...subprocessEnv,
          WORK: work,
          API_SERVICE_ID: "srv-api",
          WORKER_SERVICE_ID: "srv-worker",
          WEB_SERVICE_ID: "srv-web",
          TARGET_DB_ID: tuple.targetDbId,
          RENDER_OWNER_ID: tuple.ownerId,
          RENDER_ENVIRONMENT_ID: tuple.environmentId,
          RELEASE_COMMIT_SHA: releaseCommitSha,
          GITHUB_RUN_ID: "new-run",
        },
      });
      const allowed = ["validated", "frozen", "prepared"].includes(phase);
      expect(result.status === 0, result.stderr).toBe(allowed);
      if (allowed)
        expect(
          JSON.parse(readFileSync(join(work, "recovery-journal.json"), "utf8")),
        ).toEqual(state);
      else
        expect(() =>
          readFileSync(join(work, "recovery-journal.json")),
        ).toThrow();
      if (phase === "torn_terminal") {
        expect(result.stderr).toContain("replica_disagreement");
        expect(
          JSON.parse(
            readFileSync(join(work, "worker-effect-fence.json"), "utf8"),
          ),
        ).toEqual(fence);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.each(
    ["fleet_verified_closed", "complete"].flatMap((phase) =>
      ["recover", "register"].flatMap((job) =>
        [
          "none",
          "autodeploy",
          "repo",
          "branch",
          "duplicate_phase",
          "escaped_phase",
        ].map((drift) => ({
          phase,
          job,
          drift,
        })),
      ),
    ),
  )(
    "rejects $job after $phase with $drift and zero Render or DB effects",
    ({ phase, job, drift }) => {
      const root = mkdtempSync(join(tmpdir(), "recovery-complete-dispatch-"));
      const directory =
        job === "recover"
          ? "reviewrouter-pg17-recovery"
          : "reviewrouter-release-registration";
      const source = job === "recover" ? recover : registerRelease;
      const work = join(root, directory);
      mkdirSync(work);
      try {
        const { state } = startupCase(phase);
        const duplicate = ["duplicate_phase", "escaped_phase"].includes(drift);
        const phaseKey =
          drift === "escaped_phase" ? '"ph\\u0061se"' : '"phase"';
        const raw = duplicate
          ? JSON.stringify(state).replace(
              `"phase":"${phase}"`,
              `"phase":"${phase}",${phaseKey}:"prepared"`,
            )
          : JSON.stringify(state);
        writeFileSync(join(work, "fixture-state.json"), raw);
        writeFileSync(
          join(work, "trusted-topology.json"),
          JSON.stringify({
            ...recoveryProductionScope,
            sourceRunId: "123",
            artifactDigest: `sha256:${"a".repeat(64)}`,
            services: Object.fromEntries(
              recoveryRoles.map((role) => [role, { id: `srv-${role}` }]),
            ),
          }),
        );
        const start = source.indexOf(
          "          set -euo pipefail",
          source.indexOf(
            job === "recover"
              ? "- name: Provision roles"
              : "- name: Verify and register release",
          ),
        );
        const end = source.indexOf("\n      - name: Upload", start);
        const bash = source
          .slice(start, end === -1 ? undefined : end)
          .replace(/^ {10}/gmu, "");
        const result = spawnSync(
          "bash",
          [
            "-c",
            `set -euo pipefail
curl() {
  local url="" arg role
  for arg in "$@"; do [[ "$arg" != https:* ]] || url="$arg"; done
  if [[ " $* " == *" -X "* ]]; then printf render >> "$RUNNER_TEMP/effects"; return 99; fi
  if [[ "$url" == */env-vars ]]; then
    jq -nc --arg state "$(cat "$RUNNER_TEMP/${directory}/fixture-state.json")" '[{key:"REVIEW_ROUTER_PG17_RECOVERY_PHASE",value:$state}]'
  elif [[ "$url" == */postgres/* ]]; then
    jq -nc --arg owner "$RENDER_OWNER_ID" --arg environment "$RENDER_ENVIRONMENT_ID" '{id:"dpg-target",version:"17",status:"available",name:"reviewrouter-db",ownerId:$owner,environmentId:$environment}'
  else
    role="\${url##*/srv-}"
    jq -nc --arg drift "$DRIFT" --arg role "$role" --arg owner "$RENDER_OWNER_ID" --arg environment "$RENDER_ENVIRONMENT_ID" '{id:("srv-"+$role),name:("reviewrouter-"+$role),type:(if $role == "worker" then "background_worker" else "web_service" end),ownerId:$owner,environmentId:$environment,repo:"https://github.com/777genius/review-router-saas",branch:"main",autoDeploy:"no",suspended:"not_suspended"}
      | if $drift == "autodeploy" then .autoDeploy="yes" elif $drift == "repo" then .repo="https://github.com/drift/repo" elif $drift == "branch" then .branch="drift" else . end'
  fi
}
docker() { printf db >> "$RUNNER_TEMP/effects"; return 99; }
pnpm() { printf migration >> "$RUNNER_TEMP/effects"; return 99; }
${bash}`,
          ],
          {
            encoding: "utf8",
            env: {
              ...subprocessEnv,
              RUNNER_TEMP: root,
              DRIFT: drift,
              RENDER_API_KEY: "test-only",
              RENDER_OWNER_ID: recoveryProductionScope.ownerId,
              RENDER_ENVIRONMENT_ID: recoveryProductionScope.environmentId,
              API_SERVICE_ID: "srv-api",
              WORKER_SERVICE_ID: "srv-worker",
              WEB_SERVICE_ID: "srv-web",
              TARGET_DB_ID: "dpg-target",
            },
            timeout: 15000,
          },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          duplicate ? "json_duplicate_member" : "already complete",
        );
        expect(existsSync(join(root, "effects"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  const bootstrapCheckpoints = [
    "validated",
    "services_suspended",
    "credential_rotation_intent",
    "credentials_rotated",
    "admission_closed",
    "maintenance_enabled",
    "worker_fence_intent",
    "barriers_verified",
    "migration_complete",
    "service_credentials_staged",
  ];
  const serviceCheckpoints = recoveryRoles.flatMap((role) =>
    [
      "resume_intent",
      "resumed",
      "deploy_intent",
      "deploy_bound",
      "verified",
    ].map((phase) => `${role}:${phase}`),
  );

  it.each(
    [
      // Retain every drift/role pair at the final, fully open crash barrier.
      ...recoveryRoles.map((driftRole) => ({
        checkpoint: "barriers_open",
        driftRole,
      })),
      // Each earlier checkpoint covers all three mutable fields. Rotate the
      // bootstrap role, and drift the interrupted service during activation;
      // crossing every checkpoint with every unrelated role adds no boundary.
      ...[...bootstrapCheckpoints, "prepared"].map((checkpoint, index) => ({
        checkpoint,
        driftRole: recoveryRoles[index % recoveryRoles.length]!,
      })),
      ...serviceCheckpoints.map((checkpoint) => ({
        checkpoint,
        driftRole: checkpoint.split(":")[0]!,
      })),
    ].flatMap((point) =>
      ["autodeploy", "repo", "branch"].map((drift) => ({ ...point, drift })),
    ),
  )(
    "closes every crash barrier before rejecting startup $drift drift on $driftRole at $checkpoint",
    ({ checkpoint, drift, driftRole }) => {
      const root = mkdtempSync(join(tmpdir(), "recovery-startup-drift-"));
      const work = join(root, "reviewrouter-pg17-recovery");
      mkdirSync(work);
      try {
        const serviceCheckpoint = checkpoint.includes(":");
        const fixture = startupCase(
          serviceCheckpoint || checkpoint === "prepared"
            ? "prepared"
            : checkpoint === "barriers_open"
              ? "fleet_verified_closed"
              : checkpoint === "validated"
                ? "validated"
                : "frozen",
        );
        let state = loadRecoveryJournal(fixture.state, fixture.state.tuple);
        const { fence } = fixture;
        if (state.phase === "frozen") {
          state.bootstrapPhase = checkpoint;
          if (
            bootstrapCheckpoints.indexOf(checkpoint) >=
            bootstrapCheckpoints.indexOf("worker_fence_intent")
          )
            state.workerFence = fence;
        }
        if (serviceCheckpoint) {
          writeFileSync(
            join(work, "recovery-journal.json"),
            JSON.stringify(state),
          );
          const initial = runActivation(work, checkpoint);
          expect(initial.status, initial.stderr).toBe(97);
          state = JSON.parse(readFileSync(join(work, "durable.json"), "utf8"));
          expect(state.services[driftRole].phase).toBe(
            checkpoint.split(":")[1],
          );
          rmSync(join(work, "recovery-journal.json"));
        }
        if (checkpoint === "barriers_open") {
          // Crash after UPDATE restoration and maintenance removal, before the
          // terminal commit: every service is live and the firewall is open.
          state.phase = "prepared";
        } else {
          for (const role of recoveryRoles)
            if (
              checkpoint !== "validated" &&
              ["pending", "resume_intent"].includes(state.services[role].phase)
            )
              writeFileSync(join(work, `suspended-${role}`), "");
          if (
            state.phase === "prepared" ||
            bootstrapCheckpoints.indexOf(checkpoint) >=
              bootstrapCheckpoints.indexOf("maintenance_enabled")
          )
            for (const role of ["api", "web"])
              writeFileSync(join(work, `maintenance-${role}`), "");
          if (
            state.phase === "prepared" ||
            bootstrapCheckpoints.indexOf(checkpoint) >=
              bootstrapCheckpoints.indexOf("barriers_verified")
          )
            writeFileSync(join(work, "fenced"), "");
          if (["validated", "services_suspended"].includes(checkpoint))
            writeFileSync(join(work, "firewall-closed"), "");
        }
        const activationCalls = serviceCheckpoint
          ? readFileSync(join(work, "calls"), "utf8")
          : null;
        const credentialFiles = [
          "runtime-role-secrets.json",
          "runtime-role-urls.json",
          "connection-info.json",
          ...recoveryRoles.map((role) => `initial-srv-${role}-env.json`),
        ];
        for (const file of credentialFiles)
          writeFileSync(join(work, file), "test-only-retained-credential");
        state.tuple.ownerId = recoveryProductionScope.ownerId;
        state.tuple.environmentId = recoveryProductionScope.environmentId;
        for (const role of recoveryRoles) {
          state.tuple.services[role].ownerId = state.tuple.ownerId;
          state.tuple.services[role].environmentId = state.tuple.environmentId;
        }
        loadRecoveryJournal(state, state.tuple);
        writeFileSync(join(work, "fixture-state.json"), JSON.stringify(state));
        writeFileSync(join(work, "fixture-fence.json"), JSON.stringify(fence));
        writeFileSync(
          join(work, "trusted-topology.json"),
          JSON.stringify({
            ...recoveryProductionScope,
            sourceRunId: "123",
            artifactDigest: `sha256:${"a".repeat(64)}`,
            services: Object.fromEntries(
              recoveryRoles.map((role) => [role, { id: `srv-${role}` }]),
            ),
          }),
        );
        const start = recover.indexOf(
          "          set -euo pipefail",
          recover.indexOf("- name: Provision roles"),
        );
        const end = recover.indexOf("\n      - name: Upload", start);
        const bash = recover.slice(start, end).replace(/^ {10}/gmu, "");
        const result = spawnSync(
          "bash",
          [
            "-c",
            `
set -euo pipefail
curl() {
  local url="" arg method=GET body="" previous="" role
  for arg in "$@"; do
    [[ "$arg" != https:* ]] || url="$arg"
    [[ "$previous" != -X ]] || method="$arg"
    [[ "$previous" != --data-binary ]] || body="$arg"
    previous="$arg"
  done
  printf '%s %s\\n' "$method" "$url" >> "$work/requests"
  if [[ "$url" == https://api.ipify.org ]]; then printf 192.0.2.1; return 0; fi
  if [[ "$method" != GET ]]; then
    printf '%s %s\\n' "$method" "$url" >> "$work/effects"
    [[ "\${recovery_closure:-0}" == 1 ]] || { printf unexpected-forward >> "$work/effects"; return 99; }
    if [[ "$url" == */suspend && "$method" == POST ]]; then
      role="\${url%/suspend}"; role="\${role##*/srv-}"; touch "$work/suspended-$role"
    elif [[ "$url" == */postgres/dpg-target && "$method" == PATCH ]]; then
      if [[ "$body" == '{"ipAllowList":[]}' ]]; then
        touch "$work/firewall-closed"
      elif [[ "$body" == "@$work/firewall.json" ]] && jq -e '.ipAllowList == [{cidrBlock:"192.0.2.1/32",description:"temporary GitHub PG17 cutover recovery"}]' "$work/firewall.json" >/dev/null; then
        rm -f "$work/firewall-closed"
      else printf unexpected-firewall >> "$work/effects"; return 99; fi
    elif [[ "$url" == */services/srv-* && "$method" == PATCH && "$body" == *maintenanceMode*true* ]]; then
      touch "$work/maintenance-\${url##*/srv-}"
    else printf unexpected >> "$work/effects"; return 99; fi
    return 0
  fi
  if [[ "$url" == */env-vars ]]; then
    jq -nc --arg state "$(cat "$work/fixture-state.json")" '[{key:"REVIEW_ROUTER_PG17_RECOVERY_PHASE",value:$state}]'
  elif [[ "$url" == */connection-info ]]; then
    printf '{"externalConnectionString":"postgresql://fake@db.invalid/test"}'
  elif [[ "$url" == */postgres/dpg-target ]]; then
    jq -nc --arg owner "$RENDER_OWNER_ID" --arg environment "$RENDER_ENVIRONMENT_ID" --argjson closed "$(test -f "$work/firewall-closed" && printf true || printf false)" '{id:"dpg-target",version:"17",status:"available",name:"reviewrouter-db",ownerId:$owner,environmentId:$environment,ipAllowList:(if $closed then [] else [{cidrBlock:"192.0.2.1/32"}] end)}'
  elif [[ "$url" == */services/srv-api || "$url" == */services/srv-worker || "$url" == */services/srv-web ]]; then
    role="\${url##*/srv-}"
    if [[ "$role" == "$DRIFT_ROLE" && "\${recovery_closure:-0}" == 0 ]]; then
      printf 'drift-check:%s:%s\\n' "$suspension_guard_armed" "$firewall_open" >> "$work/requests"
    fi
    jq -nc --arg role "$role" --arg owner "$RENDER_OWNER_ID" --arg environment "$RENDER_ENVIRONMENT_ID" --arg drift "$DRIFT" --arg driftRole "$DRIFT_ROLE" --argjson suspended "$(test -f "$work/suspended-$role" && printf true || printf false)" --argjson maintenance "$(test -f "$work/maintenance-$role" && printf true || printf false)" '
      {id:("srv-"+$role),name:("reviewrouter-"+$role),type:(if $role == "worker" then "background_worker" else "web_service" end),ownerId:$owner,environmentId:$environment,repo:"https://github.com/777genius/review-router-saas",branch:"main",autoDeploy:"no",suspended:(if $suspended then "suspended" else "not_suspended" end),serviceDetails:{maintenanceMode:{enabled:$maintenance,uri:""}}}
      | if $role != $driftRole then . elif $drift == "autodeploy" then .autoDeploy="yes" elif $drift == "repo" then .repo="https://github.com/drift/repo" else .branch="drift" end'
  else printf unexpected-read >> "$work/effects"; return 99; fi
}
docker() {
  [[ "\${recovery_closure:-0}" == 1 ]] || { printf unexpected-db >> "$work/effects"; return 99; }
  if [[ "$*" == *worker-refence.sql* ]]; then
    printf 'refence\\n' >> "$work/effects"; touch "$work/fenced"
  elif [[ "$*" == *worker-fence-observe.sql* ]]; then
    if [[ -f "$work/fenced" ]]; then
      printf 'snapshot:fenced\\n' >> "$work/requests"; jq '.fenced' "$work/fixture-fence.json"
    else
      printf 'snapshot:before\\n' >> "$work/requests"; jq '.before' "$work/fixture-fence.json"
    fi
  else
    local sql; sql="$(cat)"
    if [[ "$sql" == *'UPDATE "ReviewSafetyEmergencyControl" SET stopped = true'* && "$sql" == *"SET status = 'closed'"* ]]; then
      printf 'admission\\n' >> "$work/effects"
    elif [[ "$sql" == SELECT* && "$sql" != *UPDATE* ]]; then
      printf '{"review":[{"policyScope":"global","stopped":true,"version":1}],"hosted":[{"id":"global","status":"closed","authzEpoch":"1","revision":"1"}]}'
    else printf unexpected-sql >> "$work/effects"; return 99; fi
  fi
}
pnpm() { printf migration >> "$work/effects"; return 99; }
sleep() { SECONDS=$((SECONDS + 1000)); }
${bash}`,
          ],
          {
            encoding: "utf8",
            timeout: 20000,
            env: {
              ...subprocessEnv,
              RUNNER_TEMP: root,
              DRIFT: drift,
              DRIFT_ROLE: driftRole,
              RENDER_API_KEY: "test-only",
              RENDER_OWNER_ID: recoveryProductionScope.ownerId,
              RENDER_ENVIRONMENT_ID: recoveryProductionScope.environmentId,
              API_SERVICE_ID: "srv-api",
              WORKER_SERVICE_ID: "srv-worker",
              WEB_SERVICE_ID: "srv-web",
              TARGET_DB_ID: "dpg-target",
              RELEASE_COMMIT_SHA: releaseCommitSha,
            },
          },
        );
        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout).toContain("converging all runtime services");
        expect(result.stdout, result.stdout + result.stderr).not.toContain(
          "::error::",
        );
        expect(result.stderr).toBe("");
        for (const role of recoveryRoles)
          expect(existsSync(join(work, `suspended-${role}`))).toBe(true);
        for (const role of ["api", "web"])
          expect(existsSync(join(work, `maintenance-${role}`))).toBe(true);
        expect(existsSync(join(work, "fenced"))).toBe(true);
        expect(existsSync(join(work, "firewall-closed"))).toBe(true);
        const sql = readFileSync(join(work, "worker-refence.sql"), "utf8");
        expect(sql).toBe(workerEffectFenceSql(fence, false));
        expect(sql).not.toContain("GRANT UPDATE");
        const effects = readFileSync(join(work, "effects"), "utf8");
        expect(effects.trim().split("\n")).toEqual([
          "PATCH https://api.render.com/v1/services/srv-api",
          "PATCH https://api.render.com/v1/services/srv-web",
          ...recoveryRoles.map(
            (role) =>
              `POST https://api.render.com/v1/services/srv-${role}/suspend`,
          ),
          "PATCH https://api.render.com/v1/postgres/dpg-target",
          "admission",
          "refence",
          "PATCH https://api.render.com/v1/postgres/dpg-target",
        ]);
        expect(effects).not.toMatch(/unexpected|migration|deploy|resume|PUT/u);
        expect(effects.indexOf("services/srv-api\n")).toBeLessThan(
          effects.indexOf("srv-api/suspend"),
        );
        expect(effects.indexOf("srv-web/suspend")).toBeLessThan(
          effects.indexOf("refence"),
        );
        expect(
          effects
            .trim()
            .endsWith("PATCH https://api.render.com/v1/postgres/dpg-target"),
        ).toBe(true);
        const requests = readFileSync(join(work, "requests"), "utf8");
        expect(requests.match(/drift-check:[^\n]+/gu)).toEqual([
          "drift-check:1:1",
        ]);
        for (const role of recoveryRoles) {
          const phaseRead = requests.indexOf(`srv-${role}/env-vars`);
          expect(phaseRead).toBeGreaterThanOrEqual(0);
          expect(phaseRead).toBeLessThan(requests.indexOf("drift-check:"));
        }
        expect(requests.indexOf("drift-check:")).toBeLessThan(
          requests.indexOf("PATCH"),
        );
        expect(requests.match(/snapshot:[^\n]+/gu)).toEqual(
          state.workerFence
            ? ["snapshot:fenced"]
            : ["snapshot:before", "snapshot:fenced"],
        );
        for (const file of credentialFiles)
          expect(existsSync(join(work, file)), file).toBe(false);
        expect(result.stdout + result.stderr).not.toContain(
          "test-only-retained-credential",
        );
        expect(
          JSON.parse(readFileSync(join(work, "fixture-state.json"), "utf8")),
        ).toEqual(state);
        if (serviceCheckpoint)
          expect(readFileSync(join(work, "calls"), "utf8")).toBe(
            activationCalls,
          );
        expect(existsSync(join(work, "recovery-journal.json"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );

  it.each([
    ["phase", '"phase":"complete"', '"phase":"complete","phase":"prepared"'],
    [
      "escaped phase",
      '"phase":"complete"',
      '"phase":"complete","ph\\u0061se":"prepared"',
    ],
    [
      "release",
      `"releaseCommitSha":"${releaseCommitSha}"`,
      `"releaseCommitSha":"${"b".repeat(40)}","releaseCommitSha":"${releaseCommitSha}"`,
    ],
    [
      "operation",
      '"operationId":"recovery-test"',
      '"operationId":"other","operationId":"recovery-test"',
    ],
    [
      "owner",
      '"ownerId":"tea-owner"',
      '"ownerId":"other","ownerId":"tea-owner"',
    ],
    [
      "environment",
      '"environmentId":"evm-production"',
      '"environmentId":"other","environmentId":"evm-production"',
    ],
    [
      "database",
      '"targetDbId":"dpg-target"',
      '"targetDbId":"other","targetDbId":"dpg-target"',
    ],
    ["service", '"id":"srv-api"', '"id":"srv-other","id":"srv-api"'],
    ["schema", '"schemaVersion":', '"schemaVersion":1,"schemaVersion":'],
    ["revision", '"revision":', '"revision":-1,"revision":'],
    ["tuple", '"tuple":', '"tuple":null,"tup\\u006ce":'],
    ["roles", '"services":', '"services":{},"servic\\u0065s":'],
    [
      "configuration",
      '"configFingerprint":',
      '"configFingerprint":null,"configFingerprint":',
    ],
    [
      "runtime fingerprints",
      '"runtimeConfigFingerprints":',
      '"runtimeConfigFingerprints":null,"runtimeConfigFingerprints":',
    ],
    ["worker fence", '"workerFence":', '"workerFence":null,"workerFence":'],
    [
      "effect phase",
      '"phase":"verified"',
      '"phase":"pending","ph\\u0061se":"verified"',
    ],
    [
      "predecessor inventory",
      '"beforeInventory":',
      '"beforeInventory":[],"beforeInventory":',
    ],
    ["intent", '"intentEpoch":', '"intentEpoch":0,"intentEpoch":'],
    [
      "deployment",
      '"deployId":"dep-target-api"',
      '"deployId":"dep-other","deployId":"dep-target-api"',
    ],
  ])(
    "rejects duplicate journal %s at every helper and workflow admission path",
    (_name, needle, replacement) => {
      const { state } = startupCase("complete");
      const raw = JSON.stringify(state).replace(needle!, replacement!);
      expect(raw).not.toBe(JSON.stringify(state));
      expect(() => loadRecoveryJournal(raw, state.tuple)).toThrow(
        "json_duplicate_member",
      );
      expect(() => loadRecoveryReplicas([raw, raw, raw], state.tuple)).toThrow(
        "json_duplicate_member",
      );
      expect(() =>
        recoveryCompensationFence([raw, raw, raw], state.tuple),
      ).toThrow("json_duplicate_member");
      const response = JSON.stringify([
        { envVar: { key: recoveryJournalKey, value: raw } },
      ]);
      expect(() => readRecoveryPhaseResponse(response)).toThrow(
        "json_duplicate_member",
      );
      for (const source of [recover, registerRelease]) {
        const result = spawnSync(
          "bash",
          [
            "-c",
            `set -euo pipefail
render_inventory_api() { printf '%s' "$RESPONSE"; }
${extractRecoveryBashFunction("read_recovery_phase", source)}
${extractRecoveryBashFunction("read_recovery_replicas", source)}
${extractRecoveryBashFunction("assert_recovery_nonterminal", source)}
replicas="$(assert_recovery_nonterminal)"
printf admitted
`,
          ],
          {
            encoding: "utf8",
            env: {
              ...subprocessEnv,
              RESPONSE: response,
              API_SERVICE_ID: "srv-api",
              WORKER_SERVICE_ID: "srv-worker",
              WEB_SERVICE_ID: "srv-web",
            },
          },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("json_duplicate_member");
        expect(result.stdout).toBe("");
      }
    },
  );

  it.each([
    "none",
    "invalid_transition",
    "write_timeout",
    "read_timeout",
    "mismatch",
  ])(
    "requires every durable barrier write/read under conditional Bash: %s",
    (defect) => {
      const work = mkdtempSync(join(tmpdir(), "recovery-phase-replicas-"));
      try {
        const { state } = startupCase(
          defect === "invalid_transition" ? "prepared" : "frozen",
        );
        writeFileSync(
          join(work, "recovery-journal.json"),
          JSON.stringify(state),
        );
        const result = spawnSync(
          "bash",
          [
            "-c",
            `set -euo pipefail
work="$1"
defect="$2"
API_SERVICE_ID=srv-api
WORKER_SERVICE_ID=srv-worker
WEB_SERVICE_ID=srv-web
recovery_phase_key=REVIEW_ROUTER_PG17_RECOVERY_PHASE
render_inventory_api() {
  printf 'write\\n' >> "$work/events"
  [[ "$defect" != write_timeout ]] || return 28
}
read_recovery_phase() {
  printf 'read\\n' >> "$work/events"
  [[ "$defect" != read_timeout ]] || return 28
  if [[ "$defect" == mismatch ]]; then printf '{}'; else cat "$work/recovery-journal.json"; fi
}
${extractRecoveryBashFunction("persist_recovery_phase")}
${extractRecoveryBashFunction("persist_recovery_journal")}
if persist_recovery_phase admission_closed; then printf authorized; else exit 1; fi
`,
            "bash",
            work,
            defect,
          ],
          { env: subprocessEnv, encoding: "utf8", timeout: 15000 },
        );
        expect(result.status === 0, result.stderr).toBe(defect === "none");
        expect(result.stdout).toBe(defect === "none" ? "authorized" : "");
        if (defect === "invalid_transition")
          expect(existsSync(join(work, "events"))).toBe(false);
        if (defect === "none")
          expect(
            readFileSync(join(work, "events"), "utf8").trim().split("\n"),
          ).toEqual(["write", "write", "write", "read", "read", "read"]);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );

  it.each([
    "none",
    "restore",
    "maintenance_off",
    "health",
    "readiness",
    "fleet_proof",
    "config",
    "admission",
    "complete_replica",
    "fleet_phase_replica",
    "firewall_close",
    "TERM_after_restore",
  ])("executes finalization and compensates %s", (failure) => {
    const work = mkdtempSync(join(tmpdir(), "recovery-finalization-"));
    try {
      const { state, fence } = startupCase("fleet_verified_closed");
      state.phase = "prepared";
      writeFileSync(join(work, "recovery-journal.json"), JSON.stringify(state));
      writeFileSync(
        join(work, "worker-effect-fence.json"),
        JSON.stringify(fence),
      );
      writeFileSync(join(work, "worker-state"), "fenced");
      writeFileSync(join(work, "maintenance-state"), "true");
      writeFileSync(join(work, "suspension-state"), "false");
      writeFileSync(join(work, "deploy-creation-evidence.json"), "[]");
      writeFileSync(join(work, "target-stats.json"), "{}");
      const start = recover.indexOf(
        '          observe_bound_recovery_deployments "$deploy_bindings" \\\n            "$work/pre-maintenance-removal-deployment-result.json"',
      );
      const end =
        recover.indexOf("          unset DATABASE_URL external_url", start) +
        "          unset DATABASE_URL external_url".length;
      expect(start).toBeGreaterThan(0);
      const finalization = recover.slice(start, end).replace(/^ {10}/gmu, "");
      const script = `set -euo pipefail
work="$1"
failure="$2"
worker_fence_restored=0
suspension_guard_armed=1
recovery_complete=0
firewall_open=1
GITHUB_RUN_ID=123
TARGET_DB_ID=dpg-target
WORKER_SERVICE_ID=srv-worker
RELEASE_COMMIT_SHA=${releaseCommitSha}
api_origin=https://api.invalid
web_origin=https://web.invalid
deploy_bindings='[]'
proof_count=0
close_count=0
fail_once() {
  if [[ "$failure" == "$1" && ! -f "$work/failure-used" ]]; then touch "$work/failure-used"; return 1; fi
}
sleep() { SECONDS=$((SECONDS + 100)); }
set_recovery_maintenance() {
  [[ "$1" != false || -f "$work/native-ready" ]] || return 92
  printf '%s' "$1" > "$work/maintenance-state"
  [[ "$1" != false ]] || fail_once maintenance_off
}
assert_recovery_maintenance() { [[ "$(cat "$work/maintenance-state")" == "$1" ]]; }
assert_recovery_admission_closed() { fail_once admission; }
assert_recovery_config_unchanged() { fail_once config; }
assert_recovery_database_gates() { :; }
assert_worker_effect_fenced() { [[ "$(cat "$work/worker-state")" == fenced ]]; }
observe_bound_recovery_deployments() {
  proof_count=$((proof_count + 1))
  if (( proof_count > 1 )); then fail_once fleet_proof || return 1; fi
  printf '{"deployments":[],"inventories":[]}' > "$2"
}
observe_recovery_services() { printf '[]' > "$1"; }
assert_recovery_fleet_readiness() {
  [[ "$(cat "$work/worker-state")" == fenced && "$(cat "$work/maintenance-state")" == true ]] || return 93
  [[ "$failure" != readiness && "$failure" != health ]] || return 1
  touch "$work/native-ready"
}
curl() {
  [[ "$(cat "$work/worker-state")" == fenced ]] || return 91
  [[ "$failure" != health ]]
}
docker() {
  if [[ "$*" == *worker-restore.sql* ]]; then
    touch "$work/ever-restored"
    printf restored > "$work/worker-state"
    [[ "$failure" != TERM_after_restore ]] || kill -TERM "$$"
    fail_once restore
  else
    printf fenced > "$work/worker-state"
  fi
}
compensate_recovery_fleet() { printf true > "$work/suspension-state"; }
open_recovery_database() { printf open > "$work/firewall-state"; firewall_open=1; }
close_firewall() { printf closed > "$work/firewall-state"; firewall_open=0; fail_once firewall_close; }
persist_recovery_journal() {
  cp "$work/recovery-journal.json" "$work/replica-one.json"
  fail_once complete_replica || return 1
  cp "$work/recovery-journal.json" "$work/replica-two.json"
  fail_once fleet_phase_replica || return 1
  cp "$work/recovery-journal.json" "$work/replica-three.json"
}
assert_recovery_target_identity() { :; }
assert_recovery_fleet_identity() { :; }
${extractRecoveryBashFunction("worker_fence_sql")}
close_recovery_admission() { :; }
${extractRecoveryBashFunction("compensate_worker_effect_fence")}
${cleanupRecovery}
${terminateRecovery}
trap cleanup EXIT
trap 'terminate_recovery 143' TERM
${finalization}
`;
      const result = spawnSync("bash", ["-c", script, "bash", work, failure], {
        encoding: "utf8",
        env: subprocessEnv,
        timeout: 15000,
      });
      expect(result.status === 0, result.stderr + result.stdout).toBe(
        failure === "none",
      );
      const committed = [
        "none",
        "complete_replica",
        "fleet_phase_replica",
      ].includes(failure);
      expect(readFileSync(join(work, "maintenance-state"), "utf8")).toBe(
        committed ? "false" : "true",
      );
      expect(readFileSync(join(work, "worker-state"), "utf8")).toBe(
        committed ? "restored" : "fenced",
      );
      expect(readFileSync(join(work, "suspension-state"), "utf8")).toBe(
        committed ? "false" : "true",
      );
      expect(readFileSync(join(work, "firewall-state"), "utf8")).toBe("closed");
      if (["health", "readiness"].includes(failure))
        expect(existsSync(join(work, "ever-restored"))).toBe(false);

      if (failure === "none")
        expect(
          JSON.parse(readFileSync(join(work, "replica-three.json"), "utf8"))
            .phase,
        ).toBe("complete");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.each(
    ["deploy_bound", "verified"].flatMap((phase) =>
      [
        null,
        "invalid",
        "2026-02-30T01:00:01Z",
        "2026-09-05T00:59:59Z",
        "2026-09-05T01:02:00.001Z",
        "2026-09-05T01:02:00.000000001Z",
        "2026-09-05T01:10:00Z",
        "2026-09-05T01:00:01Z",
      ].map((createdAt) => ({ phase, createdAt })),
    ),
  )(
    "retains the original intent window in $phase for $createdAt, including the actual workflow reader",
    ({ phase, createdAt }) => {
      const work = mkdtempSync(join(tmpdir(), "recovery-bound-time-"));
      try {
        let state = advanceRecoveryService(intent(), "api", "deploy_bound", {
          deployId: candidate.deployId,
        });
        const valid = [
          candidate,
          {
            ...inventory("api")[0],
            observedStatus: "deactivated",
            statusClass: "terminal",
          },
        ];
        if (phase === "verified")
          state = advanceRecoveryService(state, "api", "verified", {
            inventory: valid,
          });
        const observed = [{ ...candidate, createdAt }, valid[1]];
        const accepted = createdAt === candidate.createdAt;
        if (accepted)
          expect(
            assertRecoveryDeploymentInventory(state, "api", observed).createdAt,
          ).toBe(createdAt);
        else
          expect(() =>
            assertRecoveryDeploymentInventory(state, "api", observed),
          ).toThrow();
        writeFileSync(
          join(work, "recovery-journal.json"),
          JSON.stringify(state),
        );
        writeFileSync(join(work, "inventory.json"), JSON.stringify(observed));
        writeFileSync(
          join(work, "exact.json"),
          JSON.stringify({
            id: candidate.deployId,
            status: "live",
            commitId: releaseCommitSha,
            createdAt,
          }),
        );
        const result = spawnSync(
          "bash",
          [
            "-c",
            `set -euo pipefail
work="$1"
render_inventory_api() { cat "$work/exact.json"; }
fetch_recovery_deployment_inventory() { cat "$work/inventory.json"; }
${extractRecoveryBashFunction("observe_bound_recovery_deployment")}
result="$(observe_bound_recovery_deployment srv-api dep-target-api 999)"
printf '%s' "$result"
`,
            "bash",
            work,
          ],
          {
            env: {
              ...subprocessEnv,
              RELEASE_COMMIT_SHA: releaseCommitSha,
              recovery_deployment_inventory_filter:
                recoveryDeploymentInventoryFilter,
              recovery_exact_deployment_filter: recoveryExactDeploymentFilter,
              recovery_bound_inventory_filter: recoveryBoundInventoryFilter,
            },
            encoding: "utf8",
          },
        );
        expect(result.status === 0, result.stderr).toBe(accepted);
        if (!accepted) expect(result.stdout).toBe("");
        const startup = startupCase("prepared");
        Object.assign(startup.state.services, { api: state.services.api });
        writeFileSync(
          join(work, "recovery-resume-state.json"),
          JSON.stringify([startup.state, startup.state, startup.state]),
        );
        for (const role of recoveryRoles) {
          writeFileSync(
            join(work, `initial-srv-${role}-env.json`),
            JSON.stringify(startup.environment),
          );
          writeFileSync(
            join(work, `initial-srv-${role}-inventory.json`),
            JSON.stringify(role === "api" ? observed : inventories[role]),
          );
        }
        rmSync(join(work, "recovery-journal.json"));
        const restarted = spawnSync(process.execPath, ["--input-type=module"], {
          input: startupScript,
          encoding: "utf8",
          env: {
            ...subprocessEnv,
            WORK: work,
            API_SERVICE_ID: "srv-api",
            WORKER_SERVICE_ID: "srv-worker",
            WEB_SERVICE_ID: "srv-web",
            TARGET_DB_ID: tuple.targetDbId,
            RENDER_OWNER_ID: tuple.ownerId,
            RENDER_ENVIRONMENT_ID: tuple.environmentId,
            RELEASE_COMMIT_SHA: releaseCommitSha,
            GITHUB_RUN_ID: "new-run",
          },
        });
        expect(restarted.status === 0, restarted.stderr).toBe(accepted);
        expect(existsSync(join(work, "recovery-journal.json"))).toBe(accepted);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );

  it.each([null, "invalid", "2026-02-30T00:00:00Z", "2026-09-05T00:00:00Z"])(
    "validates retained historical timestamps %j when loading the journal",
    (createdAt) => {
      const state = loadRecoveryJournal(fresh(), tuple);
      state.services.api.beforeInventory[0].createdAt = createdAt;
      if (createdAt === "2026-09-05T00:00:00Z")
        expect(loadRecoveryJournal(state, tuple)).toEqual(state);
      else
        expect(() => loadRecoveryJournal(state, tuple)).toThrow(
          "deployment_created_at",
        );
    },
  );

  it.each([
    "none",
    "close_before",
    "close_lost",
    "close_read_lost",
    "close_TERM",
    "close_KILL",
    "write_before_api",
    "write_lost_api",
    "write_lost_worker",
    "write_lost_web",
    "read_lost_api",
    "read_lost_worker",
    "read_lost_web",
    "write_TERM_api",
    "write_TERM_worker",
    "write_TERM_web",
    "write_KILL_web",
  ])(
    "executes the actual final journal and firewall boundary at %s",
    (fault) => {
      const work = mkdtempSync(join(tmpdir(), "recovery-commit-boundary-"));
      try {
        const { state } = startupCase("fleet_verified_closed");
        state.phase = "prepared";
        writeFileSync(
          join(work, "recovery-journal.json"),
          JSON.stringify(state),
        );
        for (const role of recoveryRoles)
          writeFileSync(
            join(work, `replica-${role}.json`),
            JSON.stringify(state),
          );
        writeFileSync(join(work, "firewall"), "open");
        writeFileSync(join(work, "fleet"), "live");
        const end = recover.indexOf(
          "          unset DATABASE_URL external_url",
        );
        const start = recover.lastIndexOf(
          "          assert_recovery_admission_closed\n",
          end,
        );
        const tail = recover.slice(start, end).replace(/^ {10}/gmu, "");
        const result = spawnSync(
          "bash",
          [
            "-c",
            `set -euo pipefail
work="$1"
fault="$2"
firewall_open=1
suspension_guard_armed=1
recovery_complete=0
API_SERVICE_ID=srv-api
WORKER_SERVICE_ID=srv-worker
WEB_SERVICE_ID=srv-web
TARGET_DB_ID=dpg-target
recovery_phase_key=REVIEW_ROUTER_PG17_RECOVERY_PHASE
fail_once() {
  if [[ "$fault" == "$1" && ! -f "$work/failed" ]]; then touch "$work/failed"; return 1; fi
}
render_api() {
  if [[ " $* " == *" -X "* ]]; then
    fail_once close_before || return 1
    printf closed > "$work/firewall"
    [[ "$fault" != close_TERM || -f "$work/failed" ]] || { touch "$work/failed"; kill -TERM "$$"; }
    [[ "$fault" != close_KILL ]] || kill -KILL "$$"
    fail_once close_lost || return 1
  else
    fail_once close_read_lost || return 1
    printf '{"id":"dpg-target","ipAllowList":[]}'
  fi
}
render_inventory_api() {
  local arg role=api
  for arg in "$@"; do
    [[ "$arg" != *services/srv-worker/* ]] || role=worker
    [[ "$arg" != *services/srv-web/* ]] || role=web
  done
  if [[ " $* " == *" -X PUT "* ]]; then
    fail_once "write_before_$role" || return 1
    jq -r '.value' "$work/recovery-phase-env.json" > "$work/replica-$role.json"
    [[ "$fault" != "write_TERM_$role" ]] || kill -TERM "$$"
    [[ "$fault" != "write_KILL_$role" ]] || kill -KILL "$$"
    fail_once "write_lost_$role" || return 1
  else
    fail_once "read_lost_$role" || return 1
    jq -nc --arg state "$(cat "$work/replica-$role.json")" '[{key:"REVIEW_ROUTER_PG17_RECOVERY_PHASE",value:$state}]'
  fi
}
assert_recovery_admission_closed() { :; }
assert_recovery_target_identity() { :; }
assert_recovery_fleet_identity() { :; }
assert_recovery_config_unchanged() { :; }
assert_recovery_maintenance() { :; }
set_recovery_maintenance() { printf closed > "$work/fleet"; }
compensate_recovery_fleet() { printf closed > "$work/fleet"; }
compensate_worker_effect_fence() { printf closed > "$work/fleet"; }
${extractRecoveryBashFunction("read_recovery_phase")}
${extractRecoveryBashFunction("persist_recovery_journal")}
${extractRecoveryBashFunction("close_firewall")}
${cleanupRecovery}
${terminateRecovery}
trap cleanup EXIT
trap 'terminate_recovery 143' TERM
${tail}
`,
            "bash",
            work,
            fault,
          ],
          { env: subprocessEnv, encoding: "utf8", timeout: 15000 },
        );
        expect(result.status === 0, result.stderr).toBe(fault === "none");
        const closeFailure = fault.startsWith("close_");
        expect(readFileSync(join(work, "fleet"), "utf8")).toBe(
          closeFailure && fault !== "close_KILL" ? "closed" : "live",
        );
        expect(readFileSync(join(work, "firewall"), "utf8")).toBe("closed");
        const replicas = recoveryRoles.map((role) =>
          JSON.parse(readFileSync(join(work, `replica-${role}.json`), "utf8")),
        );
        if (closeFailure || fault === "write_before_api")
          expect(replicas.every((r) => r.phase === "prepared")).toBe(true);
        else expect(replicas.some((r) => r.phase === "complete")).toBe(true);
        // Terminal receipt and a compensated fleet must never coexist.
        expect(
          replicas.some((r) => r.phase === "complete") &&
            readFileSync(join(work, "fleet"), "utf8") !== "live",
        ).toBe(false);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );

  const runActivation = (work: string, crash: string, lost = false) => {
    const start = recover.lastIndexOf(
      '          if jq -e \'.phase == "fleet_verified_closed" or .phase == "complete"\'',
      recover.indexOf("          deploy_bindings='[]'"),
    );
    const end = recover.indexOf("          online_deadline=", start);
    const activation = recover.slice(start, end).replace(/^ {10}/gmu, "");
    const filterNames = [
      "recovery_deployment_inventory_filter",
      "recovery_predeploy_inventory_filter",
      "recovery_reconciliation_filter",
      "recovery_pending_deployment_filter",
      "recovery_exact_deployment_filter",
      "recovery_bound_inventory_filter",
    ];
    const filters = filterNames
      .map((name) => `${name}='${extractRecoveryJqFilter(name)}'`)
      .join("\n");
    const script = `set -euo pipefail
work="$1"
crash="$2"
lost="$3"
GITHUB_RUN_ID=123
API_SERVICE_ID=srv-api
WORKER_SERVICE_ID=srv-worker
WEB_SERVICE_ID=srv-web
RELEASE_COMMIT_SHA=${releaseCommitSha}
${filters}
sleep() { SECONDS=$((SECONDS + 10)); }
assert_recovery_service_suspended() { rm -f "$work/$1.online"; }
assert_recovery_maintenance() { :; }
assert_recovery_admission_closed() { :; }
assert_worker_effect_fenced() { :; }
assert_recovery_config_unchanged() { :; }
assert_recovery_service_online() { [[ -f "$work/$1.online" ]]; }
render_deploy_mutation() {
  local url="" arg id
  for arg in "$@"; do [[ "$arg" != https:* ]] || url="$arg"; done
  id="$(basename "$(dirname "$url")")"
  if [[ "$url" == */resume ]]; then
    printf 'resume:%s\\n' "$id" >> "$work/calls"
    touch "$work/$id.online"
    return 0
  fi
  [[ -f "$work/$id.online" ]] || return 90
  [[ ! -f "$work/$id.deployed" ]] || return 91
  printf 'deploy:%s\\n' "$id" >> "$work/calls"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$work/$id.deployed"
  [[ "$lost" != true ]] || return 28
  exact_response "$id"
}
exact_response() {
  local id="$1"
  jq -nc --arg id "dep-target-$id" --arg serviceId "$id" --arg sha "$RELEASE_COMMIT_SHA" --arg created "$(cat "$work/$id.deployed")" '{id:$id,serviceId:$serviceId,status:"live",commit:{id:$sha},createdAt:$created}'
}
render_inventory_api() {
  local url="$2" id
  id="$(basename "$(dirname "$(dirname "$url")")")"
  exact_response "$id"
}
fetch_recovery_deployment_inventory() {
  local id="$1" previous observed defect
  defect="$(cat "$work/inventory-defect" 2>/dev/null || true)"
  previous="$(jq -nc --arg id "$id" '[{serviceId:$id,deployId:("dep-old-"+($id|ltrimstr("srv-"))),statusClass:"active",observedStatus:"live",deploymentIdentityKind:"git",observedCommitSha:"${"b".repeat(40)}",observedImageDigest:null,createdAt:"2026-09-05T00:00:00Z"}]')"
  if [[ -f "$work/$id.deployed" ]]; then
    observed="$(jq -nc --arg id "$id" --arg sha "$RELEASE_COMMIT_SHA" --arg created "$(cat "$work/$id.deployed")" --argjson previous "$previous" \\
      '[{serviceId:$id,deployId:("dep-target-"+$id),statusClass:"active",observedStatus:"live",deploymentIdentityKind:"git",observedCommitSha:$sha,observedImageDigest:null,createdAt:$created}]+($previous|map(.statusClass="terminal"|.observedStatus="deactivated"))')"
    case "$defect" in
      missing_history) observed="$(jq -c '.[0:1]' <<<"$observed")" ;;
      changed_history) observed="$(jq -c '.[1].observedCommitSha="${"d".repeat(40)}"' <<<"$observed")" ;;
      extra_terminal) observed="$(jq -c '. + [.[1] | .deployId="dep-unrelated"]' <<<"$observed")" ;;
      extra_same_sha) observed="$(jq -c '. + [.[0] | .deployId="dep-unrelated" | .statusClass="terminal" | .observedStatus="deactivated"]' <<<"$observed")" ;;
      before_window|after_window)
        offset=-1
        [[ "$defect" != after_window ]] || offset=121
        created="$(jq -r --arg role "$role" --argjson offset "$offset" '.services[$role].intentEpoch + $offset | todateiso8601' "$work/recovery-journal.json")"
        observed="$(jq -c --arg created "$created" '.[0].createdAt=$created' <<<"$observed")" ;;
    esac
    printf '%s\\n' "$observed"
  else
    printf '%s\\n' "$previous"
  fi
}
persist_recovery_journal() {
  local checkpoint
  checkpoint="$(jq -r --arg role "$role" '$role+":"+.services[$role].phase' "$work/recovery-journal.json")"
  cp "$work/recovery-journal.json" "$work/durable.json"
  printf 'persist:%s\\n' "$checkpoint" >> "$work/calls"
  [[ "$checkpoint" != "$crash" ]] || exit 97
}
${extractRecoveryBashFunction("journal_service_phase")}
${extractRecoveryBashFunction("advance_recovery_service")}
${extractRecoveryBashFunction("observe_bound_recovery_deployment")}
${activation}
`;
    return spawnSync(
      "bash",
      ["-c", script, "bash", work, crash, String(lost)],
      { encoding: "utf8", env: subprocessEnv, timeout: 20000 },
    );
  };

  it.each(
    [
      "missing_history",
      "changed_history",
      "extra_terminal",
      "extra_same_sha",
      "before_window",
      "after_window",
    ].flatMap((defect) => [false, true].map((lost) => ({ defect, lost }))),
  )(
    "rejects $defect through actual activation with lost=$lost and never repeats POST",
    ({ defect, lost }) => {
      const work = mkdtempSync(join(tmpdir(), "recovery-adversarial-deploy-"));
      try {
        writeFileSync(
          join(work, "recovery-journal.json"),
          JSON.stringify(prepared()),
        );
        writeFileSync(join(work, "inventory-defect"), defect);
        const first = runActivation(work, "", lost);
        expect(first.status, first.stderr).not.toBe(0);
        const second = runActivation(work, "", lost);
        expect(second.status, second.stderr).not.toBe(0);
        const calls = readFileSync(join(work, "calls"), "utf8")
          .trim()
          .split("\n");
        expect(calls.filter((line) => line.startsWith("deploy:"))).toEqual([
          "deploy:srv-api",
        ]);
        expect(calls).not.toContain("resume:srv-worker");
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    "uses retained deadline after a later process restart; candidate outside window=%s",
    (outside) => {
      const work = mkdtempSync(join(tmpdir(), "recovery-retained-window-"));
      try {
        writeFileSync(
          join(work, "recovery-journal.json"),
          JSON.stringify(prepared()),
        );
        const initial = runActivation(work, "api:deploy_intent");
        expect(initial.status, initial.stderr).toBe(97);
        const state = JSON.parse(
          readFileSync(join(work, "recovery-journal.json"), "utf8"),
        );
        const oldEpoch = Math.floor(Date.now() / 1000) - 600;
        state.services.api.intentEpoch = oldEpoch;
        state.services.api.intentDeadlineEpoch = oldEpoch + 120;
        writeFileSync(
          join(work, "recovery-journal.json"),
          JSON.stringify(state),
        );
        writeFileSync(
          join(work, "srv-api.deployed"),
          new Date((oldEpoch + (outside ? 300 : 1)) * 1000).toISOString(),
        );
        const restarted = runActivation(work, "");
        expect(restarted.status === 0, restarted.stderr).toBe(!outside);
        const calls = readFileSync(join(work, "calls"), "utf8")
          .trim()
          .split("\n");
        expect(calls).not.toContain("deploy:srv-api");
        if (outside)
          expect(calls.filter((line) => line.startsWith("deploy:"))).toEqual(
            [],
          );
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );

  it("does not create another deployment after an unjournaled target effect is observed", () => {
    const work = mkdtempSync(join(tmpdir(), "recovery-observed-effect-"));
    try {
      writeFileSync(
        join(work, "recovery-journal.json"),
        JSON.stringify(prepared()),
      );
      writeFileSync(join(work, "srv-api.deployed"), new Date().toISOString());
      const result = runActivation(work, "");
      expect(result.status === 0).toBe(false);
      expect(result.stderr).toContain("unexpected_preintent_history");
      expect(readFileSync(join(work, "calls"), "utf8")).not.toContain(
        "deploy:srv-",
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "executes API/worker/web resume, deploy and durable exact verification; lost response=%s",
    (lost) => {
      const work = mkdtempSync(join(tmpdir(), "recovery-activation-"));
      try {
        writeFileSync(
          join(work, "recovery-journal.json"),
          JSON.stringify(prepared()),
        );
        const result = runActivation(work, "", lost);
        expect(result.status, result.stderr + result.stdout).toBe(0);
        const calls = readFileSync(join(work, "calls"), "utf8")
          .trim()
          .split("\n");
        expect(calls.filter((line) => /^(resume|deploy):/u.test(line))).toEqual(
          [
            "resume:srv-api",
            "deploy:srv-api",
            "resume:srv-worker",
            "deploy:srv-worker",
            "resume:srv-web",
            "deploy:srv-web",
          ],
        );
        for (const role of recoveryRoles) {
          expect(calls.indexOf(`persist:${role}:deploy_intent`)).toBeLessThan(
            calls.indexOf(`deploy:srv-${role}`),
          );
          expect(calls.indexOf(`persist:${role}:deploy_bound`)).toBeGreaterThan(
            calls.indexOf(`deploy:srv-${role}`),
          );
        }
        expect(calls.indexOf("persist:api:verified")).toBeLessThan(
          calls.indexOf("resume:srv-worker"),
        );
        expect(calls.indexOf("persist:worker:verified")).toBeLessThan(
          calls.indexOf("resume:srv-web"),
        );
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );

  it.each(["fleet_verified_closed", "complete"])(
    "reconciles durable terminal phase %s without another deploy",
    (phase) => {
      const work = mkdtempSync(join(tmpdir(), "recovery-terminal-"));
      try {
        writeFileSync(
          join(work, "recovery-journal.json"),
          JSON.stringify(prepared()),
        );
        const initial = runActivation(work, "");
        expect(initial.status, initial.stderr).toBe(0);
        const journal = JSON.parse(
          readFileSync(join(work, "recovery-journal.json"), "utf8"),
        );
        let closed = advanceRecoveryPhase(journal, "fleet_verified_closed");
        if (phase === "complete")
          closed = advanceRecoveryPhase(closed, "complete");
        writeFileSync(
          join(work, "recovery-journal.json"),
          JSON.stringify(closed),
        );
        const resumed = runActivation(work, "");
        expect(resumed.status === 0, resumed.stderr).toBe(false);
        const calls = readFileSync(join(work, "calls"), "utf8")
          .trim()
          .split("\n");
        expect(calls.filter((line) => line.startsWith("deploy:"))).toHaveLength(
          3,
        );
        expect(calls.filter((line) => line.startsWith("resume:"))).toHaveLength(
          3,
        );
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );

  it.each(serviceCheckpoints)(
    "restarts from durable %s without repeating a deployment POST",
    (checkpoint) => {
      const work = mkdtempSync(join(tmpdir(), "recovery-restart-"));
      try {
        writeFileSync(
          join(work, "recovery-journal.json"),
          JSON.stringify(prepared()),
        );
        const initial = runActivation(work, checkpoint);
        expect(initial.status, initial.stderr).toBe(97);
        writeFileSync(
          join(work, "recovery-journal.json"),
          readFileSync(join(work, "durable.json")),
        );
        const resumed = runActivation(work, "");
        // An intent persisted before POST is ambiguous after a process dies.
        // No observed deployment means stop, never retry the POST.
        expect(resumed.status === 0, resumed.stderr).toBe(
          !checkpoint.endsWith(":deploy_intent"),
        );
        const calls = readFileSync(join(work, "calls"), "utf8")
          .trim()
          .split("\n");
        for (const role of recoveryRoles)
          expect(
            calls.filter((line) => line === `deploy:srv-${role}`).length,
          ).toBeLessThanOrEqual(1);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    30000,
  );
});

describe("staged credential readback boundary", () => {
  // Execute the complete checked-in command, including every import. An import
  // statement is not a stable extraction boundary when dependencies change.
  const marker = recover.indexOf("# A successful PUT");
  const start = recover.indexOf(
    "          WORK=\"$work\" node --input-type=module <<'NODE'",
    marker,
  );
  const delimiter = "\n          NODE";
  const end = recover.indexOf(delimiter, start);
  if (marker < 0 || start < marker || end < start)
    throw new Error("missing staged credential readback command");
  const program = recover
    .slice(start, end + delimiter.length)
    .replace(/^ {10}/gmu, "");
  for (const defect of [
    "none",
    "api",
    "web",
    "worker",
    "effectAuthority",
    "commentTokenCustody",
    "duplicate-key",
    "unrelated-flag",
    "baseline-tamper",
    "duplicate-json-urls",
    "duplicate-json-staged",
    "duplicate-json-baseline",
    "duplicate-json-journal",
  ]) {
    it(`executes complete readback with ${defect}`, () => {
      const work = mkdtempSync(join(tmpdir(), "pr247-staged-config-"));
      try {
        const roles = Object.fromEntries(
          [
            "api",
            "web",
            "worker",
            "effectAuthority",
            "commentTokenCustody",
          ].map((role) => [role, { internal: `postgres://test-only-${role}` }]),
        );
        writeFileSync(
          join(work, "runtime-role-urls.json"),
          JSON.stringify({ roles }),
        );
        const journal = {
          tuple: {
            services: {} as Record<string, { configFingerprint: string }>,
          },
        };
        for (const role of ["api", "web", "worker"]) {
          const baseline = [
            { key: "UNRELATED_FLAG", value: "off" },
            { key: "DATABASE_URL", value: "old-test-value" },
          ];
          journal.tuple.services[role] = {
            configFingerprint: recoveryConfigFingerprint(baseline),
          };
          writeFileSync(
            join(work, `initial-srv-${role}-env.json`),
            JSON.stringify(
              defect === "baseline-tamper"
                ? [...baseline, { key: "unexpected", value: "yes" }]
                : baseline,
            ),
          );
          const entries = [
            { key: "DATABASE_URL", value: roles[role]!.internal },
          ];
          if (role !== "worker")
            entries.push({
              key: "REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL",
              value: roles.effectAuthority!.internal,
            });
          if (role === "api")
            entries.push({
              key: "REVIEW_ROUTER_COMMENT_TOKEN_CUSTODY_DATABASE_URL",
              value: roles.commentTokenCustody!.internal,
            });
          for (const entry of entries)
            if (defect !== "none" && entry.value === roles[defect]?.internal)
              entry.value = "mismatched-test-value";
          entries.push({
            key: "UNRELATED_FLAG",
            value: defect === "unrelated-flag" ? "on" : "off",
          });
          if (defect === "duplicate-key") entries.push(entries[0]!);
          writeFileSync(
            join(work, `staged-srv-${role}-env.json`),
            JSON.stringify(entries),
          );
        }
        writeFileSync(
          join(work, "recovery-journal.json"),
          JSON.stringify(journal),
        );
        const duplicateInputs: Record<string, [string, string, string]> = {
          "duplicate-json-urls": [
            "runtime-role-urls.json",
            '"roles":',
            '"roles":{},"rol\\u0065s":',
          ],
          "duplicate-json-staged": [
            "staged-srv-api-env.json",
            '"key":"DATABASE_URL"',
            '"key":"IGNORED","k\\u0065y":"DATABASE_URL"',
          ],
          "duplicate-json-baseline": [
            "initial-srv-api-env.json",
            '"key":"DATABASE_URL"',
            '"key":"IGNORED","k\\u0065y":"DATABASE_URL"',
          ],
          "duplicate-json-journal": [
            "recovery-journal.json",
            '"configFingerprint":',
            '"configFingerprint":null,"configFingerpr\\u0069nt":',
          ],
        };
        const duplicate = duplicateInputs[defect];
        if (duplicate) {
          const [file, needle, replacement] = duplicate;
          const path = join(work, file);
          const raw = readFileSync(path, "utf8");
          const ambiguous = raw.replace(needle, replacement);
          expect(ambiguous).not.toBe(raw);
          // Native parsing would silently accept the later authoritative value.
          expect(JSON.parse(ambiguous)).toEqual(JSON.parse(raw));
          writeFileSync(path, ambiguous);
        }
        const result = spawnSync(
          "bash",
          ["-c", `set -euo pipefail\nwork="$WORK"\n${program}`],
          {
            encoding: "utf8",
            env: {
              ...subprocessEnv,
              WORK: work,
              API_SERVICE_ID: "srv-api",
              WEB_SERVICE_ID: "srv-web",
              WORKER_SERVICE_ID: "srv-worker",
            },
          },
        );
        expect(result.status === 0, result.stderr).toBe(defect === "none");
        if (defect === "none") {
          const evidence = JSON.parse(
            readFileSync(
              join(work, "recovery-config-fingerprints.json"),
              "utf8",
            ),
          );
          expect(Object.keys(evidence).sort()).toEqual([
            "api",
            "web",
            "worker",
          ]);
          expect(JSON.stringify(evidence)).not.toContain("postgres");
        } else {
          const failure = duplicate
            ? "recovery_json_duplicate_member"
            : defect === "duplicate-key"
              ? "recovery_environment_duplicate"
              : defect === "unrelated-flag"
                ? "recovery_non_owned_configuration_drift"
                : defect === "baseline-tamper"
                  ? "recovery_bootstrap_baseline_mismatch"
                  : "recovery_staged_configuration_mismatch";
          expect(result.stderr).toContain(failure);
          expect(
            existsSync(join(work, "recovery-config-fingerprints.json")),
          ).toBe(false);
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  }
});

describe("closed admission query boundary", () => {
  const closed = {
    review: [
      {
        policyScope: "global",
        workspaceId: null,
        repositoryConnectionId: null,
        scmRepositoryIdentityId: null,
        stopped: true,
        version: 1,
      },
    ],
    hosted: [
      { id: "global", status: "closed", authzEpoch: "1", revision: "2" },
    ],
  };
  const scenarios = [
    "closed",
    "review-open",
    "hosted-active",
    "review-missing",
    "hosted-missing",
    "review-duplicate",
    "hosted-duplicate",
    "wrong-workspace",
    "wrong-repository",
    "wrong-scm",
    "wrong-gate",
    "bad-epoch",
    "bad-revision",
    "read-failure",
    "valid-output-failure",
    "malformed",
    "multiple-documents",
  ];
  for (const scenario of scenarios)
    for (const context of ["nested", "conditional"]) {
      it(`rejects ${scenario} through ${context} helper invocation`, () => {
        const work = mkdtempSync(join(tmpdir(), "pr247-admission-"));
        try {
          const input = JSON.parse(JSON.stringify(closed));
          if (scenario === "review-open") input.review[0].stopped = false;
          if (scenario === "hosted-active") input.hosted[0].status = "active";
          if (scenario === "review-missing") input.review = null;
          if (scenario === "hosted-missing") input.hosted = [];
          if (scenario === "review-duplicate")
            input.review.push(input.review[0]);
          if (scenario === "hosted-duplicate")
            input.hosted.push(input.hosted[0]);
          if (scenario === "wrong-workspace")
            input.review[0].workspaceId = "other";
          if (scenario === "wrong-repository")
            input.review[0].repositoryConnectionId = "other";
          if (scenario === "wrong-scm")
            input.review[0].scmRepositoryIdentityId = "other";
          if (scenario === "wrong-gate") input.hosted[0].id = "other";
          if (scenario === "bad-epoch") input.hosted[0].authzEpoch = "0";
          if (scenario === "bad-revision") input.hosted[0].revision = null;
          const script = `
set -uo pipefail
shopt -u inherit_errexit
work="$WORK"
${extractRecoveryBashFunction("assert_recovery_admission_closed")}
docker() {
  cat > "$WORK/query.sql"
  [[ "$SCENARIO" != read-failure ]] || return 22
  if [[ "$SCENARIO" == malformed ]]; then printf invalid; else printf '%s' "$INPUT"; fi
  [[ "$SCENARIO" != multiple-documents ]] || printf '%s' "$INPUT"
  [[ "$SCENARIO" != valid-output-failure ]] || return 22
}
set -e
${context === "nested" ? 'result="$(assert_recovery_admission_closed)"' : "if assert_recovery_admission_closed; then :; else exit 1; fi"}
printf mutation
`;
          const result = spawnSync("bash", ["-c", script], {
            encoding: "utf8",
            env: {
              ...subprocessEnv,
              WORK: work,
              SCENARIO: scenario,
              INPUT: JSON.stringify(input),
              DATABASE_URL: "test-only",
            },
          });
          expect(result.status === 0, result.stderr).toBe(
            scenario === "closed",
          );
          expect(result.stdout).toBe(scenario === "closed" ? "mutation" : "");
          expect(readFileSync(join(work, "query.sql"), "utf8")).toContain(
            "FROM \"HostedCodexRuntimeGate\" WHERE id = 'global'",
          );
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      });
    }
  it("uses identical full proofs in both jobs before deploy mutation boundaries", () => {
    expect(
      extractRecoveryBashFunction(
        "assert_recovery_admission_closed",
        registerRelease,
      ),
    ).toBe(extractRecoveryBashFunction("assert_recovery_admission_closed"));
    for (const job of [recover, registerRelease]) {
      const calls =
        job.match(
          /assert_recovery_admission_closed\n(?: {12}(?:assert_|\(\()[^\n]+\n)* {12}set \+e/gmu,
        ) ?? [];
      expect(calls).toHaveLength(1);
      expect(job).toContain("admission-closed-result.json");
    }
    expect(recover).toContain(
      "assert_recovery_admission_closed\n            assert_worker_effect_fenced\n            assert_recovery_config_unchanged\n            render_deploy_mutation -X POST",
    );
  });
});

describe("exact target database preflight", () => {
  const target = {
    id: "dpg-target",
    name: "reviewrouter-db",
    version: "17",
    status: "available",
    ownerId: "tea-owner",
    environmentId: "evm-production",
  };
  for (const defect of [
    "none",
    ...Object.keys(target),
    "read-failure",
    "valid-output-failure",
    "multiple-documents",
    "malformed",
  ]) {
    it(`rejects target ${defect} before the fleet mutation barrier`, () => {
      const work = mkdtempSync(join(tmpdir(), "pr247-target-"));
      try {
        const input =
          defect in target ? { ...target, [defect]: "other" } : target;
        const result = spawnSync(
          "bash",
          [
            "-c",
            `
set -uo pipefail
shopt -u inherit_errexit
work="$WORK"
assert_recovery_trusted_topology() { :; }
render_inventory_api() { shift; render_api "$@"; }
${extractRecoveryBashFunction("assert_recovery_target_identity")}
render_api() {
  [[ "$DEFECT" != read-failure ]] || return 22
  if [[ "$DEFECT" == malformed ]]; then printf invalid; else printf '%s' "$INPUT"; fi
  [[ "$DEFECT" != multiple-documents ]] || printf '%s' "$INPUT"
  [[ "$DEFECT" != valid-output-failure ]] || return 22
}
set -e
result="$(assert_recovery_target_identity)"
printf mutation
`,
          ],
          {
            encoding: "utf8",
            env: {
              ...subprocessEnv,
              WORK: work,
              INPUT: JSON.stringify(input),
              DEFECT: defect,
              TARGET_DB_ID: "dpg-target",
              RENDER_OWNER_ID: "tea-owner",
              RENDER_ENVIRONMENT_ID: "evm-production",
            },
          },
        );
        expect(result.status === 0, result.stderr).toBe(defect === "none");
        expect(result.stdout).toBe(defect === "none" ? "mutation" : "");
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  }
  it("uses the same strict target proof in both jobs before canonical fleet validation", () => {
    expect(
      extractRecoveryBashFunction(
        "assert_recovery_target_identity",
        registerRelease,
      ),
    ).toBe(extractRecoveryBashFunction("assert_recovery_target_identity"));
    for (const job of [recover, registerRelease])
      expect(job).toContain(
        "          assert_recovery_target_identity\n          assert_recovery_fleet_identity\n",
      );
  });
});

describe("Render recovery maintenance and worker effect fence", () => {
  const maintenance = extractRecoveryBashFunction(
    "assert_recovery_maintenance",
  );
  const setMaintenance = extractRecoveryBashFunction(
    "set_recovery_maintenance",
  );
  it.each([
    "valid",
    "patch_failure",
    "read_failure",
    "disabled",
    "wrong_id",
    "missing",
    "wrong_uri",
  ])(
    "requires successful maintenance mutation and exact readback: %s",
    (scenario) => {
      const script = `set -euo pipefail
API_SERVICE_ID=srv-api
WEB_SERVICE_ID=srv-web
scenario="$1"
render_inventory_api() {
  local id="srv-api"
  [[ "$*" != *srv-web* ]] || id=srv-web
  if [[ "$*" == *PATCH* ]]; then
    [[ "$*" == *'"maintenanceMode":{"enabled":true,"uri":""}'* ]] || return 90
    [[ "$scenario" != patch_failure ]] || return 22
    return 0
  fi
  [[ "$scenario" != read_failure ]] || return 28
  local enabled=true uri=""
  [[ "$scenario" != disabled ]] || enabled=false
  [[ "$scenario" != wrong_id ]] || id=srv-other
  [[ "$scenario" != wrong_uri ]] || uri=/maintenance
  if [[ "$scenario" == missing ]]; then printf '{}'; return; fi
  jq -nc --arg id "$id" --arg uri "$uri" --argjson enabled "$enabled" '{id:$id,serviceDetails:{maintenanceMode:{enabled:$enabled,uri:$uri}}}'
}
${maintenance}
${setMaintenance}
set_recovery_maintenance true
`;
      const result = spawnSync("bash", ["-c", script, "bash", scenario], {
        encoding: "utf8",
        env: subprocessEnv,
      });
      expect(result.status === 0, result.stderr).toBe(scenario === "valid");
    },
  );
  it.each(["suspended", "not_suspended", "missing", "wrong_id"])(
    "prohibits deployment unless exact service is online: %s",
    (state) => {
      const script = `set -euo pipefail
render_inventory_api() { printf '%s' '$JSON'; }
${extractRecoveryBashFunction("assert_recovery_service_online")}
assert_recovery_service_online srv-api
printf deploy_allowed
`.replace(
        "$JSON",
        JSON.stringify({
          id: state === "wrong_id" ? "srv-other" : "srv-api",
          suspended: state,
        }),
      );
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: subprocessEnv,
      });
      expect(result.stdout.includes("deploy_allowed")).toBe(
        state === "not_suspended",
      );
    },
  );
  const before = () => ({
    owner: "reviewrouter_release_schema_owner",
    role: {
      name: "reviewrouter_worker",
      superuser: false,
      createRole: false,
      bypassRls: false,
    },
    memberships: [] as string[],
    tableAcl: [
      {
        grantee: "reviewrouter_worker",
        grantor: "reviewrouter_release_schema_owner",
        privilege: "UPDATE",
        grantable: false,
      },
      {
        grantee: "reviewrouter_worker",
        grantor: "reviewrouter_release_schema_owner",
        privilege: "SELECT",
        grantable: false,
      },
    ],
    columnAcl: [] as {
      grantee: string;
      grantor: string;
      privilege: string;
      grantable: boolean;
      column: string;
    }[],
    effectiveUpdate: true,
    effectiveColumnUpdate: true,
  });
  it.each([
    "inherited",
    "PUBLIC",
    "column",
    "PUBLIC_column",
    "owner",
    "superuser",
    "grant_option",
    "grantor",
  ])("rejects ambiguous or indirect worker authority: %s", (path) => {
    const state = before();
    if (path === "inherited") state.memberships.push("parent");
    if (path === "PUBLIC")
      state.tableAcl.push({ ...state.tableAcl[0]!, grantee: "PUBLIC" });
    if (path === "column" || path === "PUBLIC_column")
      state.columnAcl.push({
        ...state.tableAcl[0]!,
        column: "payload",
        grantee: path === "column" ? "reviewrouter_worker" : "PUBLIC",
      });
    if (path === "owner") state.owner = "reviewrouter_worker";
    if (path === "superuser") state.role.superuser = true;
    if (path === "grant_option") state.tableAcl[0]!.grantable = true;
    if (path === "grantor") state.tableAcl[0]!.grantor = "other";
    expect(() => planWorkerEffectFence(state)).toThrow();
  });
  it("preserves unrelated privileges and restores only the exact prior UPDATE grant", () => {
    const state = before();
    const plan = planWorkerEffectFence(state);
    expect(plan.before).toEqual(state);
    expect(plan.fenced.tableAcl).toEqual([state.tableAcl[1]]);
    expect(plan.fenced.effectiveUpdate).toBe(false);
    expect(plan.fenced.effectiveColumnUpdate).toBe(false);
    const revoke = workerEffectFenceSql(plan);
    const restore = workerEffectFenceSql(plan, true);
    expect(revoke).toContain(
      'REVOKE UPDATE ON public."OutboxEvent" FROM reviewrouter_worker',
    );
    expect(restore).toContain(
      'GRANT UPDATE ON public."OutboxEvent" TO reviewrouter_worker',
    );
    expect(restore).toContain(
      'SET LOCAL ROLE "reviewrouter_release_schema_owner"',
    );
    expect(restore).toContain("worker fence before-state mismatch");
    expect(restore).toContain("worker fence after-state mismatch");
    expect(restore).not.toContain("GRANT SELECT");
    expect(restore).not.toContain("OWNER TO");
    const changed = structuredClone(plan);
    changed.fenced.tableAcl = [];
    expect(() => workerEffectFenceSql(changed, true)).toThrow(
      "worker_evidence_mismatch",
    );
    expect(workerFenceSnapshotSql).toContain("has_any_column_privilege");
    expect(workerFenceSnapshotSql).toContain("'MEMBER'");
  });
});

describe("worker compensation after terminal journal rejection", () => {
  it.each([
    "none",
    "maintenance",
    "suspend",
    "open",
    "sql",
    "revoke",
    "fence",
    "admission",
    "close",
  ])("executes cleanup and preserves failure on %s error", (failure) => {
    const work = mkdtempSync(join(tmpdir(), "recovery-compensation-"));
    try {
      writeFileSync(join(work, "worker-effect-fence.json"), "{}");
      const script = `set -euo pipefail
work="$1"
failure="$2"
worker_fence_restored=0
suspension_guard_armed=1
recovery_complete=0
firewall_open=0
step() { printf '%s\\n' "$1" >> "$work/events"; [[ "$1" != "$failure" ]]; }
set_recovery_maintenance() { step maintenance; }
compensate_recovery_fleet() { step suspend; }
open_recovery_database() { step open; }
worker_fence_sql() { [[ "$1" == fence ]] || return 99; step sql; }
docker() { step revoke; }
assert_worker_effect_fenced() { step fence; }
assert_recovery_admission_closed() { step admission; }
close_firewall() { step close; }
close_recovery_admission() { :; }
${extractRecoveryBashFunction("compensate_worker_effect_fence")}
${cleanupRecovery}
trap cleanup EXIT
exit 1
`;
      const result = spawnSync("bash", ["-c", script, "bash", work, failure], {
        encoding: "utf8",
        env: subprocessEnv,
      });
      expect(result.status, result.stderr).toBe(1);
      const events = readFileSync(join(work, "events"), "utf8")
        .trim()
        .split("\n");
      expect(events.slice(0, 3)).toEqual(["maintenance", "suspend", "open"]);
      expect(events.at(-1)).toBe("close");
      if (failure === "none")
        expect(events).toEqual([
          "maintenance",
          "suspend",
          "open",
          "sql",
          "revoke",
          "fence",
          "admission",
          "close",
        ]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
  it("reacquires bounded admin connectivity before re-fencing after an uncertain firewall close", () => {
    const open = extractRecoveryBashFunction("open_recovery_database");
    expect(open).toContain("deadline=$((SECONDS + 120))");
    expect(open).toContain("firewall_open=1");
    expect(open).toContain('export DATABASE_URL="$external_url"');
    const compensation = extractRecoveryBashFunction(
      "compensate_worker_effect_fence",
    );
    expect(
      compensation.indexOf("open_recovery_database || return 1"),
    ).toBeLessThan(compensation.indexOf("worker_fence_sql fence"));
    expect(compensation).not.toContain("worker_fence_sql restore");
  });
});

describe("PR247 recovery barrier regressions through extracted Bash", () => {
  const before = {
    owner: "schema_owner",
    role: {
      name: "reviewrouter_worker",
      superuser: false,
      createRole: false,
      bypassRls: false,
    },
    memberships: [],
    tableAcl: [
      {
        grantee: "reviewrouter_worker",
        grantor: "schema_owner",
        privilege: "UPDATE",
        grantable: false,
      },
    ],
    columnAcl: [],
    effectiveUpdate: true,
    effectiveColumnUpdate: true,
  };
  const closed = {
    review: [
      {
        policyScope: "global",
        workspaceId: null,
        repositoryConnectionId: null,
        scmRepositoryIdentityId: null,
        stopped: true,
        version: 1,
      },
    ],
    hosted: [
      { id: "global", status: "closed", authzEpoch: "1", revision: "1" },
    ],
  };
  it.each([
    "none",
    "close",
    "admission_read",
    "admission_closed",
    "maintenance",
    "maintenance_enabled",
    "snapshot",
    "worker_fence_intent",
    "revoke",
    "barriers_verified",
  ])(
    "persists all bootstrap barriers before credential generation; failure=%s",
    (failure) => {
      const work = mkdtempSync(join(tmpdir(), "recovery-barrier-order-"));
      try {
        writeFileSync(join(work, "snapshot.json"), JSON.stringify(before));
        writeFileSync(join(work, "closed.json"), JSON.stringify(closed));
        writeFileSync(
          join(work, "recovery-journal.json"),
          JSON.stringify({ revision: 0 }),
        );
        const marker = recover.indexOf(
          '          establish_recovery_barriers\n          persist_recovery_phase "credential_rotation_intent"',
        );
        const end =
          recover.indexOf("\n          NODE", marker) +
          "\n          NODE".length;
        expect(marker).toBeGreaterThan(0);
        const bootstrap = recover.slice(marker, end).replace(/^ {10}/gmu, "");
        const functions = [
          "close_recovery_admission",
          "assert_recovery_admission_closed",
          "capture_worker_effect_fence",
          "worker_fence_sql",
          "assert_worker_effect_fenced",
          "establish_recovery_barriers",
        ]
          .map((name) => extractRecoveryBashFunction(name))
          .join("\n");
        const script = `set -euo pipefail
work="$1"
failure="$2"
worker_fence_restored=0
assert_recovery_target_identity() { :; }
assert_recovery_fleet_identity() { :; }
step() { printf '%s\\n' "$1" >> "$work/events"; [[ "$failure" != "$1" ]]; }
set_recovery_maintenance() { step maintenance; }
assert_recovery_maintenance() { :; }
persist_recovery_phase() { step "$1"; }
docker() {
  if [[ " $* " == *" -i "* ]]; then
    sql="$(cat)"
    if [[ "$sql" == *'LOCK TABLE "ReviewSafetyEmergencyControl"'* ]]; then step close
    else step admission_read || return 28; cat "$work/closed.json"; fi
  elif [[ "$*" == *worker-fence-observe.sql* ]]; then
    step snapshot || return 28
    cat "$work/snapshot.json"
  elif [[ "$*" == *worker-fence.sql* ]]; then
    step revoke || return 28
    jq '.fenced' "$work/worker-effect-fence.json" > "$work/snapshot.json"
  else return 99; fi
}
node() {
  local program
  program="$(cat)"
  if [[ "$program" == *randomBytes* ]]; then step credential_generation; return 77; fi
  command node "$@" <<<"$program"
}
${functions}
${bootstrap}`;
        const result = spawnSync(
          "bash",
          ["-c", script, "bash", work, failure],
          { env: subprocessEnv, encoding: "utf8", timeout: 15000 },
        );
        const events = readFileSync(join(work, "events"), "utf8")
          .trim()
          .split("\n");
        if (failure === "none") {
          expect(result.status, result.stderr).toBe(77);
          expect(events).toEqual([
            "close",
            "admission_read",
            "admission_closed",
            "maintenance",
            "maintenance_enabled",
            "snapshot",
            "worker_fence_intent",
            "revoke",
            "snapshot",
            "admission_read",
            "barriers_verified",
            "credential_rotation_intent",
            "credential_generation",
          ]);
        } else {
          expect(result.status).not.toBe(0);
          expect(events).not.toContain("credential_generation");
          expect(events).not.toContain("credential_rotation_intent");
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    "reconciles missing compensation evidence when already fenced=%s",
    (alreadyFenced) => {
      const work = mkdtempSync(join(tmpdir(), "recovery-missing-fence-"));
      try {
        const plan = planWorkerEffectFence(before);
        writeFileSync(
          join(work, "snapshot.json"),
          JSON.stringify(alreadyFenced ? plan.fenced : before),
        );
        const result = spawnSync(
          "bash",
          [
            "-c",
            `set -euo pipefail
work="$1"
worker_fence_restored=0
recovery_bootstrap=1
assert_recovery_target_identity() { :; }
assert_recovery_fleet_identity() { :; }
open_recovery_database() { printf 'open\\n' >> "$work/events"; }
close_recovery_admission() { printf 'closed\\n' >> "$work/events"; }
assert_recovery_admission_closed() { printf 'closed_proof\\n' >> "$work/events"; }
docker() {
  if [[ "$*" == *worker-fence-observe.sql* ]]; then cat "$work/snapshot.json"
  else printf 'revoke\\n' >> "$work/events"; jq '.fenced' "$work/worker-effect-fence.json" > "$work/snapshot.json"; fi
}
${["capture_worker_effect_fence", "worker_fence_sql", "assert_worker_effect_fenced", "compensate_worker_effect_fence"].map((name) => extractRecoveryBashFunction(name)).join("\n")}
compensate_worker_effect_fence
`,
            "bash",
            work,
          ],
          { env: subprocessEnv, encoding: "utf8", timeout: 15000 },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(join(work, "events"), "utf8")).toBe(
          "open\nclosed\nrevoke\nclosed_proof\n",
        );
        expect(
          JSON.parse(readFileSync(join(work, "snapshot.json"), "utf8")),
        ).toEqual(plan.fenced);
        expect(existsSync(join(work, "recovery-journal.json"))).toBe(false);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );

  it.each(["none", "srv-api", "srv-worker", "srv-web"])(
    "reads all three replicas independently and propagates exact exit 28 for %s",
    (failedId) => {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
shopt -u inherit_errexit
API_SERVICE_ID=srv-api
WORKER_SERVICE_ID=srv-worker
WEB_SERVICE_ID=srv-web
recovery_phase_key=REVIEW_ROUTER_PG17_RECOVERY_PHASE
render_inventory_api() {
  if [[ "$2" == *"/${failedId}/"* ]]; then printf '[]'; return 28; fi
  printf '[]'
}
${extractRecoveryBashFunction("read_recovery_phase")}
${extractRecoveryBashFunction("read_recovery_replicas")}
replicas="$(read_recovery_replicas)"
printf '%s' "$replicas"
`,
        ],
        { env: subprocessEnv, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(failedId === "none" ? 0 : 28);
      expect(result.stdout).toBe(failedId === "none" ? "[null,null,null]" : "");
    },
  );

  it.each([
    "future_failed",
    "mixed_git_image",
    "conflicting_alias",
    "malformed_commit",
    "conflicting_image",
    "malformed_container",
    "missing_historical_identity",
  ])(
    "rejects older %s history through both actual paginated readers",
    (defect) => {
      const old: Record<string, unknown> = {
        id: "dep-old",
        createdAt: "2026-09-05T00:00:00Z",
        status: "deactivated",
        commit: { id: "b".repeat(40) },
      };
      if (defect === "future_failed") old.status = "future_failed";
      if (defect === "mixed_git_image") old.image = { sha: releaseImageDigest };
      if (defect === "conflicting_alias") old.commitId = "c".repeat(40);
      if (defect === "malformed_commit") old.commit = { id: 123 };
      if (defect === "malformed_container") old.commit = "malformed";
      if (defect === "missing_historical_identity") delete old.commit;

      if (defect === "conflicting_image") {
        delete old.commit;
        old.image = {
          sha: releaseImageDigest,
          digest: `sha256:${"c".repeat(64)}`,
        };
      }
      for (const job of [recover, registerRelease]) {
        const result = spawnSync(
          "bash",
          [
            "-c",
            `set -euo pipefail
render_inventory_api() { printf '%s' "$PAGE"; }
${extractRecoveryBashFunction("fetch_recovery_deployment_inventory", job)}
result="$(fetch_recovery_deployment_inventory srv-api 999)"
printf '%s' "$result"
`,
          ],
          {
            env: {
              ...subprocessEnv,
              recovery_deployment_inventory_filter:
                recoveryDeploymentInventoryFilter,
              PAGE: JSON.stringify([
                {
                  id: "dep-live",
                  status: "live",
                  createdAt: "2026-09-05T01:00:00Z",
                  commit: { id: releaseCommitSha },
                },
                old,
              ]),
            },
            encoding: "utf8",
          },
        );
        expect(result.status, result.stderr).not.toBe(0);
        expect(result.stdout).toBe("");
      }
    },
  );
});

describe("authenticated topology and revalidation in actual workflow Bash", () => {
  it.each(
    [
      "none",
      "caller-clones",
      "owner",
      "environment",
      "repo",
      "branch",
      "autodeploy",
      "renamed",
    ].flatMap((defect) =>
      [
        "render_api",
        "render_inventory_api",
        "render_deploy_mutation",
        "worker_fence_sql",
      ].map((boundary) => ({ defect, boundary })),
    ),
  )("rechecks $defect at $boundary after startup", ({ defect, boundary }) => {
    const work = mkdtempSync(join(tmpdir(), "recovery-topology-"));
    try {
      writeFileSync(
        join(work, "trusted-topology.json"),
        JSON.stringify({
          ...recoveryProductionScope,
          sourceRunId: "123",
          artifactDigest: `sha256:${"a".repeat(64)}`,
          services: Object.fromEntries(
            recoveryRoles.map((role) => [role, { id: `srv-${role}` }]),
          ),
        }),
      );
      const fence = planWorkerEffectFence({
        owner: "schema_owner",
        role: {
          name: "reviewrouter_worker",
          superuser: false,
          createRole: false,
          bypassRls: false,
        },
        memberships: [],
        tableAcl: [
          {
            grantee: "reviewrouter_worker",
            grantor: "schema_owner",
            privilege: "UPDATE",
            grantable: false,
          },
        ],
        columnAcl: [],
        effectiveUpdate: true,
        effectiveColumnUpdate: true,
      });
      writeFileSync(
        join(work, "worker-effect-fence.json"),
        JSON.stringify(fence),
      );
      const functions = [
        "render_api",
        "render_inventory_api",
        "render_deploy_mutation",
        "worker_fence_sql",
        "assert_recovery_trusted_topology",
        "assert_recovery_target_identity",
        "assert_recovery_fleet_identity",
      ]
        .map((name) => extractRecoveryBashFunction(name))
        .join("\n");
      const command =
        boundary === "worker_fence_sql"
          ? 'worker_fence_sql restore > "$work/restore.sql"\nprintf restore >> "$work/effects"'
          : `${boundary}${boundary === "render_inventory_api" ? " 999" : ""} -X POST "https://api.render.com/v1/services/$API_SERVICE_ID/resume"`;
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
work="$1"
DEFECT=none
curl() {
  local url="" arg role id
  for arg in "$@"; do [[ "$arg" != https:* ]] || url="$arg"; done
  if [[ " $* " == *" -X "* ]]; then printf render >> "$work/effects"; return 0; fi
  if [[ "$url" == */postgres/* ]]; then
    jq -nc --arg owner "$RENDER_OWNER_ID" --arg environment "$RENDER_ENVIRONMENT_ID" '{id:"dpg-target",version:"17",status:"available",name:"reviewrouter-db",ownerId:$owner,environmentId:$environment}'
  else
    id="\${url##*/}"
    role="\${id##*-}"
    jq -nc --arg id "$id" --arg role "$role" --arg owner "$RENDER_OWNER_ID" --arg environment "$RENDER_ENVIRONMENT_ID" --arg defect "$DEFECT" '
      {id:$id,name:("reviewrouter-"+$role),type:(if $role == "worker" then "background_worker" else "web_service" end),ownerId:$owner,environmentId:$environment,
       repo:"https://github.com/777genius/review-router-saas",branch:"main",autoDeploy:"no",suspended:"not_suspended"}
      | if $defect == "owner" then .ownerId="tea-other" elif $defect == "environment" then .environmentId="evm-other"
        elif $defect == "repo" then .repo="https://github.com/other/repo" elif $defect == "branch" then .branch="other"
        elif $defect == "autodeploy" then .autoDeploy="yes" elif $defect == "renamed" then .name="other" else . end'
  fi
}
${functions}
assert_recovery_target_identity
assert_recovery_fleet_identity
DEFECT="$2"
if [[ "$DEFECT" == caller-clones ]]; then export API_SERVICE_ID=srv-clone-api WORKER_SERVICE_ID=srv-clone-worker WEB_SERVICE_ID=srv-clone-web; fi
${command}
`,
          "bash",
          work,
          defect,
        ],
        {
          encoding: "utf8",
          env: {
            ...subprocessEnv,
            RENDER_API_KEY: "test-only",
            TARGET_DB_ID: "dpg-target",
            API_SERVICE_ID: "srv-api",
            WORKER_SERVICE_ID: "srv-worker",
            WEB_SERVICE_ID: "srv-web",
            RENDER_OWNER_ID: recoveryProductionScope.ownerId,
            RENDER_ENVIRONMENT_ID: recoveryProductionScope.environmentId,
            service_scope_filter: extractRecoveryJqFilter(
              "service_scope_filter",
            ),
          },
          timeout: 15000,
        },
      );
      expect(result.status === 0, result.stderr).toBe(defect === "none");
      expect(existsSync(join(work, "effects"))).toBe(defect === "none");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.each([
    "none",
    "wrong_health_path",
    "missing_health_path",
    "not_live",
    "config_drift",
    "admission_open",
    "fence_open",
    "expired_deadline",
    "late_readiness",
  ])(
    "proves native readiness under maintenance before finalization: %s",
    (defect) => {
      const work = mkdtempSync(join(tmpdir(), "recovery-native-readiness-"));
      try {
        const result = spawnSync(
          "bash",
          [
            "-c",
            `set -euo pipefail
work="$1"
defect="$2"
API_SERVICE_ID=srv-api
WEB_SERVICE_ID=srv-web
assert_recovery_target_identity() { :; }
assert_recovery_fleet_identity() { :; }
assert_recovery_admission_closed() { [[ "$defect" != admission_open ]]; }
assert_worker_effect_fenced() { [[ "$defect" != fence_open ]]; }
assert_recovery_config_unchanged() { [[ "$defect" != config_drift ]]; }
assert_recovery_maintenance() { [[ "$1" == true ]]; }
render_inventory_api() {
  local id="\${2##*/}" path=/health
  [[ "$id" != srv-web ]] || path=/
  [[ "$defect" != wrong_health_path ]] || path=/wrong
  [[ "$defect" != missing_health_path ]] || path=""
  jq -nc --arg id "$id" --arg path "$path" '{id:$id,suspended:"not_suspended",serviceDetails:{healthCheckPath:$path}}'
}
observe_bound_recovery_deployments() { [[ "$defect" != not_live ]]; }
observe_recovery_services() { [[ "$defect" != late_readiness ]] || SECONDS=999; }
${extractRecoveryBashFunction("assert_recovery_fleet_readiness")}
[[ "$defect" != expired_deadline ]] || SECONDS=999
assert_recovery_fleet_readiness '[]' 999
printf authorized
`,
            "bash",
            work,
            defect,
          ],
          { env: subprocessEnv, encoding: "utf8" },
        );
        expect(result.status === 0, result.stderr).toBe(defect === "none");
        expect(result.stdout).toBe(defect === "none" ? "authorized" : "");
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
});

function recoveryFixtureCrc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function recoveryFixtureZip(name: string, value: Buffer) {
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(recoveryFixtureCrc32(value), 14);
  local.writeUInt32LE(value.length, 18);
  local.writeUInt32LE(value.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(recoveryFixtureCrc32(value), 16);
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

describe("existing release topology authority", () => {
  it.each([
    "none",
    "wrong_run",
    "failed_job",
    "torn_inventory",
    "wrong_digest",
    "duplicate_artifact",
    "wrong_revision",
  ])(
    "authenticates the existing receipt through extracted workflow Bash: %s",
    (defect) => {
      const root = mkdtempSync(join(tmpdir(), "recovery-trusted-receipt-"));
      try {
        const sha = spawnSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).stdout.trim();
        const manifest = {
          recoveryRunId: "123",
          targetVersion: 17,
          releaseCommitSha: sha,
          resumedServices: recoveryRoles.map((role) => ({
            role,
            serviceId: `srv-${role}`,
            suspended: "not_suspended",
            type: role === "worker" ? "background_worker" : "web_service",
          })),
          serviceRevisions: recoveryRoles.map((role) => ({
            serviceId: `srv-${role}`,
            observedCommitSha:
              defect === "wrong_revision" ? "b".repeat(40) : sha,
            deploymentIdentityKind: "git",
            observedImageDigest: null,
            observedStatus: "live",
          })),
        };
        const archive = recoveryFixtureZip(
          "recovery-manifest.json",
          Buffer.from(JSON.stringify(manifest)),
        );
        writeFileSync(join(root, "archive.zip"), archive);
        const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
        const fixture = {
          run: {
            id: 123,
            head_sha: sha,
            head_branch: "main",
            run_attempt: 1,
            event: "workflow_dispatch",
            status: "completed",
            conclusion: "success",
            path: ".github/workflows/codex-rotating-release-migration.yml",
            repository: { id: 42 },
            head_repository: { id: defect === "wrong_run" ? 99 : 42 },
          },
          jobs: {
            total_count: defect === "torn_inventory" ? 4 : 3,
            jobs: [
              "Verify protected main dispatch",
              "Verify exact recovery release evidence",
              "Complete restored PG17 cutover",
            ].map((name) => ({
              name,
              head_sha: sha,
              run_id: 123,
              run_attempt: 1,
              status: "completed",
              conclusion: defect === "failed_job" ? "failure" : "success",
            })),
          },
          artifact: {
            id: 456,
            name: "reviewrouter-pg17-recovery-123",
            workflow_run: { id: 123 },
            expired: false,
            digest:
              defect === "wrong_digest" ? `sha256:${"0".repeat(64)}` : digest,
          },
        };
        writeFileSync(join(root, "fixture.json"), JSON.stringify(fixture));
        writeFileSync(
          join(root, "mock.mjs"),
          `
import {readFileSync} from "node:fs";
const fixture=JSON.parse(readFileSync(process.env.RUNNER_TEMP+"/fixture.json","utf8"));
globalThis.fetch=async url => {
 let body;
 if(url.endsWith("/zip")) return {ok:true,url:"https://api.github.com/test-archive",arrayBuffer:async()=>readFileSync(process.env.RUNNER_TEMP+"/archive.zip")};
 if(url.endsWith("/review-router-saas")) body={id:42,full_name:"777genius/review-router-saas"};
 else if(url.includes("/workflows/")) body={workflow_runs:[fixture.run]};
 else if(url.includes("/jobs?")) body=fixture.jobs;
 else if(url.includes("/artifacts?")) {const artifacts=${defect === "duplicate_artifact" ? "[fixture.artifact,fixture.artifact]" : "[fixture.artifact]"}; body={total_count:artifacts.length,artifacts};}
 else throw new Error("unmocked network forbidden:"+url);
 return {ok:true,json:async()=>body};
};`,
        );
        const start = recover.indexOf(
          "          set -euo pipefail",
          recover.indexOf("- name: Authenticate existing production topology"),
        );
        const end = recover.indexOf("\n      - name: Provision roles", start);
        const program = recover.slice(start, end).replace(/^ {10}/gmu, "");
        const result = spawnSync(
          "bash",
          [
            "-c",
            `node() { command node --import "$RUNNER_TEMP/mock.mjs" "$@"; }
${program}`,
          ],
          {
            encoding: "utf8",
            env: {
              ...subprocessEnv,
              RUNNER_TEMP: root,
              GH_TOKEN: "test-only",
              TRUSTED_MAIN_SHA: sha,
            },
            timeout: 15000,
          },
        );
        expect(result.status === 0, result.stderr).toBe(defect === "none");
        const path = join(
          root,
          "reviewrouter-pg17-recovery",
          "trusted-topology.json",
        );
        expect(existsSync(path)).toBe(defect === "none");
        if (defect === "none")
          expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
            ...recoveryProductionScope,
            services: {
              api: { id: "srv-api" },
              worker: { id: "srv-worker" },
              web: { id: "srv-web" },
            },
            sourceRunId: "123",
            artifactDigest: digest,
          });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("bootstrap grant refresh preserves the committed fence", () => {
  it("executes the actual grant generator and fences UPDATE inside its sole transaction", () => {
    const work = mkdtempSync(join(tmpdir(), "recovery-grant-fence-"));
    try {
      const fence = planWorkerEffectFence({
        owner: "schema_owner",
        role: {
          name: "reviewrouter_worker",
          superuser: false,
          createRole: false,
          bypassRls: false,
        },
        memberships: [],
        tableAcl: [
          {
            grantee: "reviewrouter_worker",
            grantor: "schema_owner",
            privilege: "UPDATE",
            grantable: false,
          },
        ],
        columnAcl: [],
        effectiveUpdate: true,
        effectiveColumnUpdate: true,
      });
      writeFileSync(
        join(work, "worker-effect-fence.json"),
        JSON.stringify(fence),
      );
      const start = recover.indexOf(
        '          WORK="$work" node --import tsx --input-type=module',
      );
      const end =
        recover.indexOf("\n          NODE", start) + "\n          NODE".length;
      expect(start).toBeGreaterThan(0);
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail\nwork="$1"\n${recover.slice(start, end).replace(/^ {10}/gmu, "")}`,
          "bash",
          work,
        ],
        { env: subprocessEnv, encoding: "utf8", timeout: 15000 },
      );
      expect(result.status, result.stderr).toBe(0);
      const sql = readFileSync(join(work, "runtime-grants.sql"), "utf8");
      expect(sql.match(/COMMIT;/gu)).toHaveLength(1);
      expect(
        sql.indexOf(
          "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO reviewrouter_worker;",
        ),
      ).toBeLessThan(
        sql.lastIndexOf(
          'REVOKE UPDATE ON public."OutboxEvent" FROM reviewrouter_worker;',
        ),
      );
      expect(
        sql.lastIndexOf(
          'REVOKE UPDATE ON public."OutboxEvent" FROM reviewrouter_worker;',
        ),
      ).toBeLessThan(sql.indexOf("COMMIT;"));
      expect(sql).toContain("recovery grant refresh changed worker fence");
      expect(sql).toContain(JSON.stringify(fence.fenced));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("registration finalization uses complete strict history", () => {
  it.each([
    "none",
    "mixed_identity",
    "future_failed",
    "extra_terminal",
    "missing_history",
    "late_same_sha",
  ])("executes finalization with %s older entry", (defect) => {
    const work = mkdtempSync(join(tmpdir(), "recovery-register-history-"));
    try {
      const created = new Date().toISOString();
      const epoch =
        Math.floor(Date.now() / 1000) - (defect === "late_same_sha" ? 600 : 10);
      for (const role of recoveryRoles)
        writeFileSync(
          join(work, `registration-intent-srv-${role}.json`),
          JSON.stringify({
            intentEpoch: epoch,
            intentDeadlineEpoch: epoch + 120,
            beforeInventory: [
              {
                serviceId: `srv-${role}`,
                deployId: "dep-old",
                createdAt: "2026-09-05T00:00:00Z",
                observedCommitSha: releaseCommitSha,
                observedImageDigest: null,
                deploymentIdentityKind: "git",
                observedStatus: "live",
                statusClass: "active",
              },
            ],
          }),
        );
      const start = registerRelease.indexOf(
        "          current_deployments='[]'",
      );
      const end =
        registerRelease.indexOf("          unset DATABASE_URL", start) +
        "          unset DATABASE_URL".length;
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
work="$1"
defect="$2"
RELEASE_COMMIT_SHA=${releaseCommitSha}
deploys='[{"serviceId":"srv-api","deployId":"dep-api"},{"serviceId":"srv-worker","deployId":"dep-worker"},{"serviceId":"srv-web","deployId":"dep-web"}]'
render_inventory_api() {
  local role=api
  [[ "$2" != *srv-worker* ]] || role=worker
  [[ "$2" != *srv-web* ]] || role=web
  jq -nc --arg role "$role" --arg sha "$RELEASE_COMMIT_SHA" --arg defect "$defect" --arg created "$CREATED" '
    [{id:("dep-"+$role),status:"live",commit:{id:$sha},createdAt:$created}, {id:"dep-old",status:"deactivated",commit:{id:$sha},createdAt:"2026-09-05T00:00:00Z"}]
    | if $defect == "mixed_identity" then .[1].imageDigest="${releaseImageDigest}"
      elif $defect == "future_failed" then .[1].status="future_failed"
      elif $defect == "extra_terminal" then . + [.[1] | .id="dep-extra"]
      elif $defect == "missing_history" then .[0:1] else . end'
}
assert_recovery_admission_closed() { :; }
close_firewall() { printf finalized; }
${extractRecoveryBashFunction("fetch_recovery_deployment_inventory", registerRelease)}
${extractRecoveryBashFunction("fetch_registration_deployment_inventory", registerRelease)}
${registerRelease.slice(start, end).replace(/^ {10}/gmu, "")}
`,
          "bash",
          work,
          defect,
        ],
        {
          env: {
            ...subprocessEnv,
            CREATED: created,
            recovery_reconciliation_filter: recoveryReconciliationFilter,
            recovery_deployment_inventory_filter:
              recoveryDeploymentInventoryFilter,
          },
          encoding: "utf8",
          timeout: 15000,
        },
      );
      expect(result.status === 0, result.stderr).toBe(defect === "none");
      expect(result.stdout).toBe(defect === "none" ? "finalized" : "");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("registration deployment uses the same authoritative reconciliation", () => {
  it.each(
    [
      "none",
      "missing_history",
      "extra_terminal",
      "after_window",
      "competing_active",
    ].flatMap((defect) => [false, true].map((lost) => ({ defect, lost }))),
  )(
    "executes registration creation with $defect and lost=$lost",
    ({ defect, lost }) => {
      const work = mkdtempSync(join(tmpdir(), "recovery-registration-create-"));
      try {
        writeFileSync(
          join(work, "live-service-preflight.json"),
          JSON.stringify(
            recoveryRoles.map((role) => ({
              serviceId: `srv-${role}`,
              deployId: `dep-old-${role}`,
            })),
          ),
        );
        const start = registerRelease.indexOf("          deploys='[]'");
        const end = registerRelease.indexOf(
          "          deadline=$((SECONDS + 900))",
          start,
        );
        expect(start).toBeGreaterThan(0);
        const script = `set -euo pipefail
work="$1"
defect="$2"
lost="$3"
API_SERVICE_ID=srv-api
WORKER_SERVICE_ID=srv-worker
WEB_SERVICE_ID=srv-web
RELEASE_COMMIT_SHA=${releaseCommitSha}
sleep() { SECONDS=$((SECONDS+10)); }
assert_recovery_admission_closed() { :; }
fetch_registration_deployment_inventory() {
  local id="$1" role="\${1#srv-}" created=""
  if [[ -f "$work/$id.created" ]]; then created="$(cat "$work/$id.created")"; fi
  jq -nc --arg role "$role" --arg sha "$RELEASE_COMMIT_SHA" --arg created "$created" --arg defect "$defect" '
    [{id:("dep-old-"+$role),status:"live",commitId:$sha,createdAt:"2026-09-05T00:00:00Z"}]
    | if $created == "" then (if $defect == "competing_active" then . + [.[0] | .id="dep-competing" | .status="build_in_progress"] else . end) else
      [{id:("dep-target-"+$role),status:"live",commitId:$sha,createdAt:$created}] + map(.status="deactivated")
      | if $defect == "missing_history" then .[0:1]
        elif $defect == "extra_terminal" then . + [.[1] | .id="dep-extra"] else . end
      end'
}
render_deploy_mutation() {
  local arg url="" id created
  for arg in "$@"; do [[ "$arg" != https:* ]] || url="$arg"; done
  id="$(basename "$(dirname "$url")")"
  printf '%s\\n' "$id" >> "$work/calls"
  [[ ! -f "$work/$id.created" ]] || return 99
  created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [[ "$defect" != after_window ]] || created="$(date -u -d "@$((deploy_intent_epoch+121))" +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s' "$created" > "$work/$id.created"
  [[ "$lost" != true ]] || return 28
  jq -nc --arg id "dep-target-\${id#srv-}" --arg sha "$RELEASE_COMMIT_SHA" '{id:$id,status:"live",commit:{id:$sha}}'
}
${registerRelease.slice(start, end).replace(/^ {10}/gmu, "")}
`;
        const result = spawnSync(
          "bash",
          ["-c", script, "bash", work, defect, String(lost)],
          {
            env: {
              ...subprocessEnv,
              recovery_deployment_inventory_filter:
                recoveryDeploymentInventoryFilter,
              recovery_reconciliation_filter: recoveryReconciliationFilter,
            },
            encoding: "utf8",
            timeout: 15000,
          },
        );
        expect(result.status === 0, result.stderr).toBe(defect === "none");
        if (defect === "competing_active")
          expect(existsSync(join(work, "calls"))).toBe(false);
        else
          expect(
            readFileSync(join(work, "calls"), "utf8").trim().split("\n"),
          ).toEqual(
            defect === "none"
              ? ["srv-api", "srv-worker", "srv-web"]
              : ["srv-api"],
          );
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
});

describe("r36 strict retained authority readers", () => {
  const malformed = [
    {},
    [{}],
    [null],
    [false],
    [{ envVar: null }],
    [{ key: "X" }],
    [{ value: "x" }],
    [{ key: "", value: "x" }],
    [{ key: "X", value: 1 }],
    [{ key: "X", value: null }],
    [{ key: "X", value: "x" }, { envVar: { key: "X", value: "x" } }],
    [
      { key: recoveryJournalKey, value: "{}" },
      { key: recoveryJournalKey, value: "{}" },
    ],
    [{ key: recoveryJournalKey, value: "{}" }],
    [{ key: recoveryJournalKey, value: '{"schemaVersion":1}' }],
    [{ key: recoveryJournalKey, value: "" }],
    [{ key: recoveryJournalKey, value: "null" }],
    [{ key: recoveryJournalKey, value: "[]" }],
    [{ key: recoveryJournalKey, value: "false" }],
    [{ envVar: { key: "X", value: "x" }, key: "Y", value: "y" }],
    [{ envVar: { key: "X", value: "x" }, cursor: 3 }],
    [{ key: "X", value: "x", unexpected: true }],
  ];
  it.each(
    recoveryRoles.flatMap((role) =>
      malformed.map((response, index) => ({ role, response, index })),
    ),
  )(
    "rejects malformed response $index on $role before creating replica authority",
    ({ role, response }) => {
      for (const source of [recover, registerRelease]) {
        const result = spawnSync(
          "bash",
          [
            "-c",
            `set -euo pipefail
API_SERVICE_ID=srv-api
WORKER_SERVICE_ID=srv-worker
WEB_SERVICE_ID=srv-web
render_inventory_api() {
  if [[ "$2" == */srv-${role}/env-vars ]]; then printf '%s' "$RESPONSE"; else printf '[]'; fi
}
${extractRecoveryBashFunction("read_recovery_phase", source)}
${extractRecoveryBashFunction("read_recovery_replicas", source)}
replicas="$(read_recovery_replicas)"
printf '%s' "$replicas"
`,
          ],
          {
            encoding: "utf8",
            env: { ...subprocessEnv, RESPONSE: JSON.stringify(response) },
          },
        );
        expect(result.status, result.stderr).not.toBe(0);
        expect(result.stdout).toBe("");
      }
    },
  );

  it.each(
    [
      [],
      [{ key: "X", value: "x" }],
      [{ envVar: { key: "X", value: "x" }, cursor: "cursor" }],
    ].map((response) => ({ response })),
  )("accepts actual well-formed absent journal response %j", ({ response }) => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
render_inventory_api() { printf '%s' "$RESPONSE"; }
${extractRecoveryBashFunction("read_recovery_phase")}
read_recovery_phase srv-api
`,
      ],
      {
        encoding: "utf8",
        env: { ...subprocessEnv, RESPONSE: JSON.stringify(response) },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("null");
  });

  it.each([
    null,
    "invalid",
    "2026-02-30T00:00:00Z",
    "2026-09-05",
    "2026-09-05T00:00:00+00:00",
    "2026-09-05T25:00:00Z",
    "2026-09-05T00:00:00Z",
    "2026-09-05T00:00:00.123456Z",
  ])(
    "validates every historical timestamp %j in both actual inventory readers",
    (createdAt) => {
      const accepted =
        typeof createdAt === "string" &&
        createdAt.startsWith("2026-09-05T00:00:00") &&
        createdAt.endsWith("Z");
      for (const source of [recover, registerRelease]) {
        const response = [
          {
            id: "dep-target",
            status: "live",
            commitId: releaseCommitSha,
            createdAt: "2026-09-05T01:00:01Z",
          },
          {
            id: "dep-old",
            status: "deactivated",
            commitId: "b".repeat(40),
            createdAt,
          },
        ];
        const result = spawnSync(
          "bash",
          [
            "-c",
            `set -euo pipefail
render_inventory_api() { printf '%s' "$RESPONSE"; }
${extractRecoveryBashFunction("fetch_recovery_deployment_inventory", source)}
observed="$(fetch_recovery_deployment_inventory srv-api 999)"
printf '%s' "$observed"
`,
          ],
          {
            encoding: "utf8",
            env: {
              ...subprocessEnv,
              RESPONSE: JSON.stringify(response),
              recovery_deployment_inventory_filter: extractRecoveryJqFilter(
                "recovery_deployment_inventory_filter",
                source,
              ),
            },
          },
        );
        expect(result.status === 0, result.stderr).toBe(accepted);
        if (!accepted) expect(result.stdout).toBe("");
      }
    },
  );
});

describe("r36 immutable compensation authority despite configuration drift", () => {
  it.each(
    [
      "autodeploy",
      "branch",
      "repo",
      "environment_values",
      "wrong_id",
      "owner",
      "environment",
      "wrong_type",
      "extra",
      "db_id",
      "db_owner",
    ].flatMap((defect) =>
      ["maintenance", "suspend", "refence", "firewall"].map((boundary) => ({
        defect,
        boundary,
      })),
    ),
  )(
    "executes $boundary with $defect introduced after startup",
    ({ defect, boundary }) => {
      const work = mkdtempSync(join(tmpdir(), "recovery-closure-drift-"));
      try {
        const trusted = {
          ...recoveryProductionScope,
          sourceRunId: "123",
          artifactDigest: `sha256:${"a".repeat(64)}`,
          services: Object.fromEntries(
            recoveryRoles.map((role) => [role, { id: `srv-${role}` }]),
          ),
        };
        writeFileSync(
          join(work, "trusted-topology.json"),
          JSON.stringify(trusted),
        );
        const fence = planWorkerEffectFence({
          owner: "schema_owner",
          role: {
            name: "reviewrouter_worker",
            superuser: false,
            createRole: false,
            bypassRls: false,
          },
          memberships: [],
          tableAcl: [
            {
              grantee: "reviewrouter_worker",
              grantor: "schema_owner",
              privilege: "UPDATE",
              grantable: false,
            },
          ],
          columnAcl: [],
          effectiveUpdate: true,
          effectiveColumnUpdate: true,
        });
        writeFileSync(
          join(work, "worker-effect-fence.json"),
          JSON.stringify(fence),
        );
        writeFileSync(
          join(work, "recovery-config-fingerprints.json"),
          JSON.stringify(
            Object.fromEntries(
              recoveryRoles.map((role) => [
                role,
                {
                  serviceId: `srv-${role}`,
                  fingerprint: recoveryConfigFingerprint([
                    { key: "FIXTURE", value: "initial" },
                  ]),
                },
              ]),
            ),
          ),
        );
        const names = [
          "assert_recovery_config_unchanged",
          "render_api",
          "render_inventory_api",
          "assert_recovery_trusted_topology",
          "assert_recovery_target_identity",
          "assert_recovery_fleet_identity",
          "set_recovery_maintenance",
          "assert_recovery_maintenance",
          "compensate_recovery_fleet",
          "compensate_worker_effect_fence",
          "open_recovery_database",
          "worker_fence_sql",
          "close_firewall",
        ];
        const command = {
          maintenance: "set_recovery_maintenance true",
          suspend: "compensate_recovery_fleet",
          refence: "compensate_worker_effect_fence",
          firewall: "close_firewall",
        }[boundary];
        const result = spawnSync(
          "bash",
          [
            "-c",
            `set -euo pipefail
work="$1"
DEFECT=none
firewall_open=1
RECOVERY_COMPENSATION_TIMEOUT_SECONDS=10
sleep() { SECONDS=$((SECONDS + 20)); }
curl() {
  local arg url="" id role body="" previous=""
  for arg in "$@"; do
    [[ "$arg" != https:* ]] || url="$arg"
    [[ "$previous" != --data-binary ]] || body="$arg"
    previous="$arg"
  done
  if [[ "$url" == https://api.ipify.org ]]; then printf '192.0.2.1'; return; fi
  if [[ " $* " == *" -X "* ]]; then
    printf '%s\\n' "$url" >> "$work/effects"
    if [[ "$url" == */suspend ]]; then touch "$work/\${url##*services/}" 2>/dev/null || touch "$work/suspended"; fi
    [[ "$body" != *maintenanceMode* ]] || touch "$work/maintenance"
    return 0
  fi
  if [[ "$url" == */env-vars ]]; then
    jq -nc --arg defect "$DEFECT" '[{key:"FIXTURE",value:(if $defect == "environment_values" then "drift" else "initial" end)}]'; return
  fi
  if [[ "$url" == */connection-info ]]; then printf '{"externalConnectionString":"postgresql://test@db.invalid/test"}'; return; fi
  if [[ "$url" == */postgres/* ]]; then
    jq -nc --arg owner "$RENDER_OWNER_ID" --arg environment "$RENDER_ENVIRONMENT_ID" --arg defect "$DEFECT" '{id:"dpg-target",version:"17",status:"available",name:"reviewrouter-db",ownerId:$owner,environmentId:$environment,ipAllowList:[]}
    | if $defect == "db_id" then .id="dpg-other" elif $defect == "db_owner" then .ownerId="tea-other" else . end'
    return
  fi
  id="\${url##*/}"; role="\${id#srv-}"
  jq -nc --arg id "$id" --arg role "$role" --arg owner "$RENDER_OWNER_ID" --arg environment "$RENDER_ENVIRONMENT_ID" --arg defect "$DEFECT" --argjson suspended "$(test -f "$work/suspended" && printf true || printf false)" --argjson maintenance "$(test -f "$work/maintenance" && printf true || printf false)" '
    {id:$id,name:("reviewrouter-"+$role),type:(if $role == "worker" then "background_worker" else "web_service" end),ownerId:$owner,environmentId:$environment,repo:"https://github.com/777genius/review-router-saas",branch:"main",autoDeploy:"no",suspended:(if $suspended then "suspended" else "not_suspended" end),serviceDetails:{maintenanceMode:{enabled:$maintenance,uri:""}}}
    | if $role != "worker" then .
      elif $defect == "autodeploy" then .autoDeploy="yes" elif $defect == "branch" then .branch="drift"
      elif $defect == "repo" then .repo="https://github.com/drift/repo" elif $defect == "wrong_id" then .id="srv-other"
      elif $defect == "owner" then .ownerId="tea-other" elif $defect == "environment" then .environmentId="evm-other"
      elif $defect == "wrong_type" then .type="web_service" else . end'
}
${names.map((name) => extractRecoveryBashFunction(name)).join("\n")}
close_recovery_admission() {
  assert_recovery_target_identity || return 1
  assert_recovery_fleet_identity || return 1
  printf admission >> "$work/effects"
}
assert_recovery_admission_closed() { :; }
assert_worker_effect_fenced() { :; }
docker() { printf refence >> "$work/effects"; }
assert_recovery_target_identity
assert_recovery_fleet_identity
assert_recovery_config_unchanged
DEFECT="$2"
if [[ "$DEFECT" == extra ]]; then
  jq '.services.extra={id:"srv-extra"}' "$work/trusted-topology.json" > "$work/next.json"
  mv "$work/next.json" "$work/trusted-topology.json"
fi
# This normal desired-state validation fails on mutable source drift.
if [[ "$DEFECT" == autodeploy || "$DEFECT" == branch || "$DEFECT" == repo ]]; then
  if assert_recovery_fleet_identity; then exit 93; fi
fi
if [[ "$DEFECT" == environment_values ]]; then
  if assert_recovery_config_unchanged; then exit 94; fi
fi
${command}
`,
            "bash",
            work,
            defect,
          ],
          {
            env: {
              ...subprocessEnv,
              TARGET_DB_ID: "dpg-target",
              API_SERVICE_ID: "srv-api",
              WORKER_SERVICE_ID: "srv-worker",
              WEB_SERVICE_ID: "srv-web",
              RENDER_OWNER_ID: recoveryProductionScope.ownerId,
              RENDER_ENVIRONMENT_ID: recoveryProductionScope.environmentId,
              RENDER_API_KEY: "test-only",
              service_scope_filter: extractRecoveryJqFilter(
                "service_scope_filter",
              ),
              recovery_suspension_set_filter: recoverySuspensionSetFilter,
            },
            encoding: "utf8",
            timeout: 15000,
          },
        );
        const accepted = [
          "autodeploy",
          "branch",
          "repo",
          "environment_values",
        ].includes(defect);
        expect(result.status === 0, result.stderr).toBe(accepted);
        expect(existsSync(join(work, "effects"))).toBe(accepted);
        if (accepted) {
          const events = readFileSync(join(work, "effects"), "utf8");
          if (boundary === "maintenance")
            expect(events.match(/services\/srv-(api|web)\n/gu)).toHaveLength(2);
          if (boundary === "suspend")
            for (const role of recoveryRoles)
              expect(events).toContain(`/services/srv-${role}/suspend`);
          if (boundary === "refence")
            expect(
              readFileSync(join(work, "worker-refence.sql"), "utf8"),
            ).toContain('REVOKE UPDATE ON public."OutboxEvent"');
          expect(events).not.toContain("srv-other");
          expect(events).not.toContain("srv-extra");
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
});

describe("bounded raw recovery JSON authority", () => {
  const duplicateResponses = [
    '[{"envVar":{"key":"REVIEW_ROUTER_PG17_RECOVERY_PHASE","value":"{}"},"envVar":{"key":"X","value":"x"}}]',
    '[{"envVar":{"key":"REVIEW_ROUTER_PG17_RECOVERY_PHASE","value":"{}"},"env\\u0056ar":{"key":"X","value":"x"}}]',
    '[{"key":"REVIEW_ROUTER_PG17_RECOVERY_PHASE","key":"X","value":"x"}]',
    '[{"key":"REVIEW_ROUTER_PG17_RECOVERY_PHASE","k\\u0065y":"X","value":"x"}]',
    '[{"envVar":{"key":"X","value":"first","value":"last"}}]',
    '[{"envVar":{"key":"X","value":"first","v\\u0061lue":"last"}}]',
    '[{"key":"X","value":"first","value":"last"}]',
    '[{"envVar":{"key":"X","value":"x"},"cursor":"first","cursor":"last"}]',
    '[ { "envVar" : { "key" : "X", "value" : "x", "key" : "Y" } } ]',
    '[{"envVar":{"key":"X","value":"x"}},{"key":"Y","value":"y","value":"z"}]',
  ];
  it.each(duplicateResponses.map((response, index) => ({ response, index })))(
    "rejects raw duplicate envelope/entry $index as failure, never journal absence",
    ({ response }) => {
      expect(() => readRecoveryPhaseResponse(response)).toThrow(
        "json_duplicate_member",
      );
      expect(() => readRecoveryPhaseResponse(JSON.parse(response))).toThrow(
        "json_size",
      );
      expect(() => recoveryConfigFingerprint(response)).toThrow(
        "json_duplicate_member",
      );
      for (const source of [recover, registerRelease])
        for (const role of recoveryRoles) {
          const result = spawnSync(
            "bash",
            [
              "-c",
              `set -euo pipefail
render_inventory_api() {
  if [[ "$2" == */srv-${role}/env-vars ]]; then printf '%s' "$RESPONSE"; else printf '[]'; fi
}
${extractRecoveryBashFunction("read_recovery_phase", source)}
${extractRecoveryBashFunction("read_recovery_replicas", source)}
replicas="$(read_recovery_replicas)"
printf '%s' "$replicas"
`,
            ],
            {
              encoding: "utf8",
              env: {
                ...subprocessEnv,
                RESPONSE: response,
                API_SERVICE_ID: "srv-api",
                WORKER_SERVICE_ID: "srv-worker",
                WEB_SERVICE_ID: "srv-web",
              },
            },
          );
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("json_duplicate_member");
          expect(result.stdout).toBe("");
        }
    },
  );

  it.each([
    '{"x":1,"x":2}',
    '{"x":{"y":1,"y":2}}',
    '[{"x":0},[{"z":0,"\\u007a":0}]]',
    '{"a\\\\b":0,"a\\u005cb":1}',
    '{"a\\"b":0,"a\\u0022b":1}',
    '{"😀":0,"\\ud83d\\ude00":1}',
    '{"__proto__":0,"__proto__":1}',
  ])("rejects nested and decoded-key collisions in %s", (raw) => {
    expect(() => parseRecoveryJson(raw)).toThrow("json_duplicate_member");
  });

  it.each([
    "null",
    "true",
    "false",
    "0",
    "-2.5e+3",
    ' { "a": [{"same":1}, {"same":2}], "b": "} , \\"key\\": \\u0061" } ',
    '{"__proto__":{"ok":true},"constructor":0}',
    String.raw`["\\", "\"", "\uD800", "😀"]`,
  ])("preserves valid JSON grammar and distinct scopes: %s", (raw) => {
    expect(parseRecoveryJson(raw)).toEqual(JSON.parse(raw));
  });

  it.each([
    "",
    " ",
    "{}{}",
    "[1,]",
    '{"a":1,}',
    '{"a" 1}',
    '{"a":}',
    "{a:1}",
    "undefined",
    "01",
    "NaN",
    '"\\x20"',
    '"\\uZZZZ"',
    '"unterminated',
    "[true false]",
    '{"a":1]',
    "[}",
    '"line\nbreak"',
  ])("rejects malformed JSON without exposing response bytes: %j", (raw) => {
    expect(() => parseRecoveryJson(raw)).toThrow("recovery_json_syntax");
  });

  it("bounds raw bytes, nesting depth and total values", () => {
    expect(() => parseRecoveryJson(`"${"x".repeat(1024 * 1024)}"`)).toThrow(
      "json_size",
    );
    expect(() => parseRecoveryJson(`"${"é".repeat(512 * 1024)}"`)).toThrow(
      "json_size",
    );
    expect(() =>
      parseRecoveryJson("[".repeat(66) + "0" + "]".repeat(66)),
    ).toThrow("json_complexity");
    expect(() =>
      parseRecoveryJson(`[${Array(100001).fill("0").join(",")}]`),
    ).toThrow("json_complexity");
    expect(parseRecoveryJson("[".repeat(64) + "0" + "]".repeat(64))).toEqual(
      JSON.parse("[".repeat(64) + "0" + "]".repeat(64)),
    );
  });

  it("accepts decoded ordinary env-var keys and valid journal absence through the shared raw reader", () => {
    const raw =
      '[{"env\\u0056ar":{"k\\u0065y":"X","val\\u0075e":"value"},"cursor":"next"}]';
    expect(readRecoveryPhaseResponse(raw)).toBeNull();
    expect(recoveryConfigFingerprint(raw)).toBe(
      recoveryConfigFingerprint([{ key: "X", value: "value" }]),
    );
    expect(extractRecoveryBashFunction("read_recovery_phase", recover)).toBe(
      extractRecoveryBashFunction("read_recovery_phase", registerRelease),
    );
  });
});
