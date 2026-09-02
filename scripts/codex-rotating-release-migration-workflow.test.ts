import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalPrismaMigrationCatalog } from "./lib/canonical-prisma-migration-catalog.mjs";

const workflow = readFileSync(
  ".github/workflows/codex-rotating-release-migration.yml",
  "utf8",
);
const trustBootstrap = workflow.slice(
  workflow.indexOf("\n  trust-bootstrap:"),
  workflow.indexOf("\n  recover:"),
);
const recover = workflow.slice(
  workflow.indexOf("\n  recover:"),
  workflow.indexOf("\n  register-release:"),
);
const registerRelease = workflow.slice(
  workflow.indexOf("\n  register-release:"),
);

function extractRecoveryJqFilter(name: string): string {
  const assignment = `          ${name}='`;
  const start = recover.indexOf(assignment);
  if (start < 0) throw new Error(`missing recovery jq filter: ${name}`);
  const bodyStart = start + assignment.length;
  const bodyEnd = recover.indexOf("\n          '", bodyStart);
  if (bodyEnd < 0) throw new Error(`unterminated recovery jq filter: ${name}`);
  return recover.slice(bodyStart, bodyEnd);
}

function extractRecoveryBashFunction(name: string): string {
  const declaration = `          ${name}() {`;
  const start = recover.indexOf(declaration);
  if (start < 0) throw new Error(`missing recovery bash function: ${name}`);
  const end = recover.indexOf("\n          }", start);
  if (end < 0) throw new Error(`unterminated recovery bash function: ${name}`);
  return recover
    .slice(start, end + "\n          }".length)
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
  const result = runJq(recoveryDeploymentInventoryFilter, input, {
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
    expect(registerRelease).toContain("needs: trust-bootstrap");
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
    expect(workflow).toContain('persist_recovery_phase "target_deploy_intent"');
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

  it("creates and binds the exact target deployment while the fleet remains suspended", () => {
    const migration = recover.indexOf("pnpm db:migrate:deploy");
    const lastEnvironmentMutation = recover.indexOf(
      'persist_recovery_phase "target_deploy_intent"',
    );
    const create = recover.indexOf("render_deploy_mutation -X POST");
    const exactPoll = recover.indexOf(
      '"https://api.render.com/v1/services/$service_id/deploys/$deploy_id"',
      create,
    );
    const preResumeProof = recover.indexOf(
      "pre-resume-deployment-result.json",
      exactPoll,
    );
    const resume = workflow.indexOf(
      '"https://api.render.com/v1/services/$service_id/resume"',
    );

    expect(lastEnvironmentMutation).toBeGreaterThan(migration);
    expect(create).toBeGreaterThan(lastEnvironmentMutation);
    expect(exactPoll).toBeGreaterThan(create);
    expect(preResumeProof).toBeGreaterThan(exactPoll);
    expect(resume).toBeGreaterThan(preResumeProof);
    expect(recover.slice(create)).not.toContain("/env-vars/");
    expect(recover).toMatch(
      /assert_recovery_fleet_suspended \\\n\s+"\$work\/deploy-wait-suspension-result\.json"/u,
    );
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
    expect(createCalls).toHaveLength(1);
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
        commit: { id: releaseCommitSha },
        createdAt: "2026-08-30T10:00:02Z",
        id: "dep-before",
        status: "deactivated",
      },
      {
        commit: { id: releaseCommitSha },
        createdAt: "2026-08-30T09:59:40Z",
        id: "dep-too-old",
        status: "deactivated",
      },
      {
        commit: { id: releaseCommitSha },
        createdAt: "2026-08-30T10:00:01Z",
        id: "dep-ambiguous",
        image: { sha: releaseImageDigest },
        status: "created",
      },
      {
        commit: { id: "d".repeat(40) },
        createdAt: "2026-08-30T10:00:01Z",
        id: "dep-wrong",
        status: "created",
      },
    ]);
    const result = runJq(
      recoveryReconciliationFilter,
      candidates,
      { releaseCommitSha, serviceId },
      {
        beforeDeployIds: ["dep-before"],
        intentEpoch,
        observationEpoch: intentEpoch + 10,
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({ deployId: expectedDeployId }),
    ]);

    const duplicateIntent = [
      ...candidates,
      observeDeployment(serviceId, {
        commit: { id: releaseCommitSha },
        createdAt: "2026-08-30T10:00:03Z",
        id: "dep-second-exact",
        status: "created",
      }),
    ];
    const ambiguous = runJq(
      recoveryReconciliationFilter,
      duplicateIntent,
      { releaseCommitSha, serviceId },
      {
        beforeDeployIds: ["dep-before"],
        intentEpoch,
        observationEpoch: intentEpoch + 10,
      },
    );
    expect(JSON.parse(ambiguous.stdout)).toHaveLength(2);
  });

  it("rejects a same-commit substitution or any concurrent active deployment", () => {
    const exact = {
      commit: { id: releaseCommitSha },
      id: expectedDeployId,
      status: "live",
    };
    const historical = {
      commit: { id: releaseCommitSha },
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
        commit: {id: $commit},
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
          commit: {id: $commit},
          id: (if $index == 0 then "dep-target" else "dep-history-\\($index)" end),
          status: (if $index == 0 then "live" else "deactivated" end)
        }
      }
  ]'
}
${fetchRecoveryDeploymentInventory}
fetch_recovery_deployment_inventory srv-api "$((SECONDS + 30))"
`;
    const pagination = spawnSync("bash", ["-ceu", paginationScript], {
      encoding: "utf8",
      env: {
        ...process.env,
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
        commit: {id: $commit},
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
          commit: {id: $commit},
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
      const pagination = spawnSync("bash", ["-ceu", script, "bash", work], {
        encoding: "utf8",
        env: {
          ...process.env,
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
    const result = spawnSync("bash", ["-ceu", script], {
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
      const result = spawnSync("bash", ["-ceu", script, "bash", work], {
        encoding: "utf8",
        env: {
          ...process.env,
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
        const result = spawnSync(
          "bash",
          ["-ceu", script, "bash", work, signal],
          { encoding: "utf8" },
        );
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
      const result = spawnSync("bash", ["-ceu", script, "bash", work], {
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
    expect(registerRelease).toContain("deploys?limit=20");
    expect(registerRelease).toContain('[[ "$deploy_id" =~ ^dep-[a-z0-9-]+$ ]]');
    expect(registerRelease).toContain(".[0].deployId == $beforeDeployId");
    expect(registerRelease).toContain(
      "($beforeDeployIds | index($id)) == null",
    );
    expect(registerRelease).toContain(
      "== $releaseCommitSha\n                          )",
    );
    expect(registerRelease).toContain(">= ($intentEpoch - 5)");
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
    const latestDeployReread = registerRelease.lastIndexOf('deploys?limit=1"');

    expect(latestDeployReread).toBeGreaterThan(exactDeployPolling);
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

  it("opens the global kill switch only after explicit confirmation", () => {
    expect(workflow).toContain("open_global_emergency:");
    expect(workflow).toContain("default: false");
    expect(workflow).toContain('process.env.OPEN_GLOBAL_EMERGENCY === "true"');
    expect(workflow).toContain('"emergency",');
    expect(workflow).toContain('"global",');
    expect(workflow).toContain('"open",');
    expect(workflow).toContain("emergency-control-result.json");
  });

  it("opens an explicitly confirmed repository kill switch after the global switch", () => {
    expect(workflow).toContain("operator_repository:");
    expect(workflow).toContain(
      "OPERATOR_REPOSITORY: ${{ inputs.operator_repository }}",
    );
    expect(workflow).toContain('"repository",');
    expect(workflow).toContain('"--repo",');
    expect(workflow).toContain('"--confirm",');
    expect(workflow).toContain("operatorRepository,");
    expect(workflow).toContain(
      "repositoryEmergencyResult.repository !== operatorRepository",
    );
    expect(workflow).toContain("repository-emergency-control-result.json");
    expect(workflow).toContain("repository-emergency-control-diagnostic.json");
  });

  it("opens an explicitly confirmed workspace kill switch before its repository", () => {
    expect(workflow).toContain("operator_workspace_id:");
    expect(workflow).toContain(
      "OPERATOR_WORKSPACE_ID: ${{ inputs.operator_workspace_id }}",
    );
    expect(workflow).toContain('"workspace",');
    expect(workflow).toContain('"--workspace",');
    expect(workflow).toContain(
      "workspaceEmergencyResult.workspaceId !== operatorWorkspaceId",
    );
    expect(workflow).toContain("workspace-emergency-control-result.json");
    expect(workflow).toContain("workspace-emergency-control-diagnostic.json");
    expect(workflow.indexOf("workspaceEmergencyResult")).toBeLessThan(
      workflow.indexOf("repositoryEmergencyResult"),
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
    expect(workflow).toContain(
      '["recording", "shadow", "context_critic", "production_effects"]',
    );
    expect(workflow).toContain(
      'rolloutStatusResult.decisions?.[capability] !== "allowed"',
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

  it("preserves registration evidence and emits redacted emergency diagnostics", () => {
    const registrationEvidence = workflow.indexOf("registration-result.json");
    const emergencyMutation = workflow.indexOf(
      'process.env.OPEN_GLOBAL_EMERGENCY === "true"',
    );

    expect(registrationEvidence).toBeGreaterThan(-1);
    expect(emergencyMutation).toBeGreaterThan(registrationEvidence);
    expect(workflow).toContain(
      "diagnosticCodes: diagnosticCodes(emergency.stdout, emergency.stderr)",
    );
    expect(workflow).toContain("database_permission_denied");
    expect(workflow).toContain("database_connection_failed");
    expect(workflow).toContain("review_safety_control_conflict");
    expect(workflow).not.toContain("emergency-error.log");
  });
});
