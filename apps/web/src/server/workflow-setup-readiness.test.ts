import { describe, expect, it } from "vitest";
import type {
  RepositoryWorkflowCheck,
  RepositoryWorkflowProbeInput,
  RepositoryWorkflowProbePort,
} from "@reviewrouter/features-repo-health";
import {
  defaultCodexRotatingWorkflowPath,
  defaultWorkflowPath,
} from "@reviewrouter/features-workflow-provisioning";
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

  it("requires conflict fallback markers before skipping setup when fallback rollout is enabled", async () => {
    const probe = new CapturingWorkflowProbe({
      status: "present",
      expectedActionRefFound: true,
      expectedContentMarkersFound: true,
    });

    await expect(
      isWorkflowSetupAlreadyCurrent(
        { ...readinessInput, conflictReviewFallbackEnabled: true },
        { workflowProbe: probe },
      ),
    ).resolves.toBe(true);

    expect(probe.input?.expectedContentMarkerGroups).toEqual([
      [
        ".github/workflows/reviewrouter-reusable.yml",
        ".github/workflows/reviewrouter-conflict-reusable.yml",
        "repository_dispatch:",
        "types: [reviewrouter_conflict_review]",
        "conflict-review:",
        "github.event_name == 'repository_dispatch'",
        "github.event.action == 'reviewrouter_conflict_review'",
        "review_kind: conflict-head",
        "conflict_repository_id:",
        "conflict_dispatch_event_type:",
        "conflict_dispatch_id:",
      ],
    ]);
  });

  it("requires both Claude and conflict markers when both capabilities are needed", async () => {
    const probe = new CapturingWorkflowProbe({
      status: "present",
      expectedActionRefFound: true,
      expectedContentMarkersFound: false,
    });

    await expect(
      isWorkflowSetupAlreadyCurrent(
        {
          ...readinessInput,
          providerKind: "claude",
          conflictReviewFallbackEnabled: true,
        },
        { workflowProbe: probe },
      ),
    ).resolves.toBe(false);

    expect(probe.input?.expectedContentMarkerGroups).toEqual([
      [
        ".github/workflows/reviewrouter-reusable.yml",
        "CLAUDE_CODE_OAUTH_TOKEN",
        ".github/workflows/reviewrouter-conflict-reusable.yml",
        "repository_dispatch:",
        "types: [reviewrouter_conflict_review]",
        "conflict-review:",
        "github.event_name == 'repository_dispatch'",
        "github.event.action == 'reviewrouter_conflict_review'",
        "review_kind: conflict-head",
        "conflict_repository_id:",
        "conflict_dispatch_event_type:",
        "conflict_dispatch_id:",
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

  it("checks the dedicated rotating Codex workflow path and markers", async () => {
    const probe = new CapturingWorkflowProbe({
      status: "present",
      expectedActionRefFound: true,
      expectedContentMarkersFound: true,
    });

    await expect(
      isWorkflowSetupAlreadyCurrent(
        {
          ...readinessInput,
          actionRef:
            "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
          codexRotatingProviderInstanceId: "codex-rotating:123456",
          codexRotatingClaudeCodeOAuthTokenSecret: true,
          codexRotatingOpenRouterApiKeySecret: true,
          conflictReviewFallbackEnabled: true,
        },
        { workflowProbe: probe },
      ),
    ).resolves.toBe(true);

    expect(probe.input).toMatchObject({
      workflowPath: defaultCodexRotatingWorkflowPath,
      expectedActionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      expectedContentMarkerGroups: [
        [
          "name: ReviewRouter Codex OAuth",
          "permissions: {}\n\njobs:",
          "    permissions:\n      id-token: write",
          "mode: codex-oauth-rotating",
          'provider-instance-id: "codex-rotating:123456"',
          "auth-json: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
          "claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
          "openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}",
        ],
      ],
    });
  });
});
