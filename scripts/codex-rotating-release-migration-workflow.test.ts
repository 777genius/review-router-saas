import { readFileSync } from "node:fs";
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
const registerRelease = workflow.slice(
  workflow.indexOf("\n  register-release:"),
);

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
    const suspensionBarrier = workflow.indexOf(
      'all(.suspended == "suspended")',
    );
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
    expect(workflow).toContain('persist_recovery_phase "ready_to_resume"');
    expect(workflow).toContain("recovery-resume-state.json");
  });

  it("converges live and partially suspended service sets before mutation", () => {
    expect(workflow).toContain('if [[ "$state" != "suspended" ]]');
    expect(workflow).toContain(
      '"https://api.render.com/v1/services/$service_id/suspend"',
    );
    expect(workflow).toContain("suspension_deadline=$((SECONDS + 600))");
  });

  it("records observed revisions and image digests before resuming", () => {
    const revisionProof = workflow.indexOf(
      "service-revision-observations.json",
    );
    const resume = workflow.indexOf(
      '"https://api.render.com/v1/services/$service_id/resume"',
    );
    expect(revisionProof).toBeGreaterThan(-1);
    expect(resume).toBeGreaterThan(revisionProof);
    expect(workflow).toContain("observedCommitSha");
    expect(workflow).toContain("observedImageDigest");
    expect(workflow).toContain('all(.observedStatus == "live")');
    expect(workflow).toContain("all(.observedCommitSha == $releaseCommitSha)");
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

  it("provisions custody through migration 000086 without exposing credentials", () => {
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
      appliedMigrationCount: 89,
      latestMigration: "000086_comment_token_custody_r18_remediation",
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
