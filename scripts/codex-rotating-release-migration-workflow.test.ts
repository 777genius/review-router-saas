import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  ".github/workflows/codex-rotating-release-migration.yml",
  "utf8",
);

describe("Codex rotating release migration workflow", () => {
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

  it("redeploys every runtime service and waits for live status", () => {
    expect(workflow).toContain(
      '"https://api.render.com/v1/services/$service_id/deploys"',
    );
    expect(workflow).toContain("deadline=$((SECONDS + 900))");
    expect(workflow).toContain('length == 3 and all(.status == "live")');
    expect(workflow).toContain("deployment-result.json");
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
