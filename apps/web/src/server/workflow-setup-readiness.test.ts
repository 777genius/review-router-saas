import { describe, expect, it } from "vitest";
import type {
  RepositoryWorkflowCheck,
  RepositoryWorkflowProbeInput,
  RepositoryWorkflowProbePort,
} from "@reviewrouter/features-repo-health";
import { defaultWorkflowPath } from "@reviewrouter/features-workflow-provisioning";
import { isWorkflowSetupAlreadyCurrent } from "./workflow-setup-readiness";

class CapturingWorkflowProbe implements RepositoryWorkflowProbePort {
  public input: RepositoryWorkflowProbeInput | null = null;

  constructor(private readonly check: RepositoryWorkflowCheck) {}

  async probeWorkflow(
    input: RepositoryWorkflowProbeInput,
  ): Promise<RepositoryWorkflowCheck> {
    this.input = input;
    return this.check;
  }
}

const readinessInput = {
  githubInstallationId: "123",
  owner: "777genius",
  name: "example",
  defaultBranch: "main",
  actionRef: "777genius/review-router@main",
};

describe("workflow setup readiness", () => {
  it("treats the workflow as current only when the expected action ref is present", async () => {
    const probe = new CapturingWorkflowProbe({
      status: "present",
      expectedActionRefFound: true,
    });

    await expect(
      isWorkflowSetupAlreadyCurrent(readinessInput, { workflowProbe: probe }),
    ).resolves.toBe(true);

    expect(probe.input).toMatchObject({
      githubInstallationId: readinessInput.githubInstallationId,
      owner: readinessInput.owner,
      name: readinessInput.name,
      defaultBranch: readinessInput.defaultBranch,
      workflowPath: defaultWorkflowPath,
      expectedActionRef: readinessInput.actionRef,
    });
  });

  it("does not block setup when the workflow is missing or outdated", async () => {
    await expect(
      isWorkflowSetupAlreadyCurrent(readinessInput, {
        workflowProbe: new CapturingWorkflowProbe({ status: "missing" }),
      }),
    ).resolves.toBe(false);
    await expect(
      isWorkflowSetupAlreadyCurrent(readinessInput, {
        workflowProbe: new CapturingWorkflowProbe({
          status: "present",
          expectedActionRefFound: false,
        }),
      }),
    ).resolves.toBe(false);
  });

  it("requires Claude workflow capability markers when checking Claude readiness", async () => {
    const probe = new CapturingWorkflowProbe({
      status: "present",
      expectedActionRefFound: true,
      expectedContentMarkersFound: true,
    });

    await expect(
      isWorkflowSetupAlreadyCurrent(
        { ...readinessInput, providerKind: "claude" },
        { workflowProbe: probe },
      ),
    ).resolves.toBe(true);

    expect(probe.input?.expectedContentMarkerGroups).toEqual([
      [
        ".github/workflows/reviewrouter-reusable.yml",
        "CLAUDE_CODE_OAUTH_TOKEN",
      ],
      [
        "Install Claude Code CLI",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "Skip fork pull requests",
      ],
    ]);
  });

  it("requires a workflow update when a current action ref lacks Claude markers", async () => {
    await expect(
      isWorkflowSetupAlreadyCurrent(
        { ...readinessInput, providerKind: "claude" },
        {
          workflowProbe: new CapturingWorkflowProbe({
            status: "present",
            expectedActionRefFound: true,
            expectedContentMarkersFound: false,
          }),
        },
      ),
    ).resolves.toBe(false);
  });
});
