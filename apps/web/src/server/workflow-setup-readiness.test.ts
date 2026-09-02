import { describe, expect, it } from "vitest";
import {
  OctokitRepositoryWorkflowProbe,
  type RepositoryWorkflowCheck,
  type RepositoryWorkflowProbeInput,
  type RepositoryWorkflowProbePort,
} from "@reviewrouter/features-repo-health";
import {
  CodexRotatingReviewActionV2Mode,
  CodexRotatingT0WorkflowSchemaVersion,
  createVersionedProviderSecretNamespace,
  defaultCodexRotatingWorkflowPath,
  defaultInteractionWorkflowPath,
  defaultWorkflowPath,
  renderCanonicalCodexRotatingInteractionWorkflowV2,
  renderCodexRotatingInteractionWorkflow,
  renderCodexRotatingAdvisoryWorkflow,
} from "@reviewrouter/features-workflow-provisioning";
import { isWorkflowSetupAlreadyCurrent } from "./workflow-setup-readiness";

class CapturingWorkflowProbe implements RepositoryWorkflowProbePort {
  public input: RepositoryWorkflowProbeInput | null = null;
  public readonly inputs: RepositoryWorkflowProbeInput[] = [];

  constructor(private readonly check: RepositoryWorkflowCheck) {}

  async probeWorkflow(
    input: RepositoryWorkflowProbeInput,
  ): Promise<RepositoryWorkflowCheck> {
    this.input ??= input;
    this.inputs.push(input);
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

const v4ActionRef =
  "777genius/review-router@0123456789abcdef0123456789abcdef01234567";
const v4ProviderInstanceId = "codex-rotating:123456";
const v4SecretNamespace = createVersionedProviderSecretNamespace({
  scope: {
    repositoryId: "123456",
    providerInstanceId: v4ProviderInstanceId,
  },
  namespaceId: "sns_0123456789abcdef0123456789abcdef",
  epoch: 4,
  name: "REVIEWROUTER_CODEX_AUTH_JSON_R123456_Pb3d5f6be619a10be_E4_0123456789abcdef0123456789abcdef",
});

function canonicalV4Workflow(): string {
  return renderCodexRotatingAdvisoryWorkflow({
    actionRef: v4ActionRef,
    apiUrl: "https://api.reviewrouter.site",
    providerInstanceId: v4ProviderInstanceId,
    reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    workflowSchemaVersion:
      CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
    activeSecretNamespace: v4SecretNamespace,
  });
}

function canonicalV3InteractionWorkflow(): string {
  return renderCodexRotatingInteractionWorkflow({
    actionRef: v4ActionRef,
    apiUrl: "https://api.reviewrouter.site",
    runtimeConfigMode: "oidc",
  });
}

function checkV4WorkflowReadiness(
  workflow: string,
  interactionWorkflow = canonicalV3InteractionWorkflow(),
): Promise<boolean> {
  const probe = new OctokitRepositoryWorkflowProbe({
    createRequester: async () => ({
      request: async (_route, parameters) => ({
        data: {
          type: "file",
          encoding: "base64",
          content: Buffer.from(
            parameters?.path === defaultInteractionWorkflowPath
              ? interactionWorkflow
              : workflow,
          ).toString("base64"),
        },
      }),
    }),
  });

  return isWorkflowSetupAlreadyCurrent(
    {
      ...readinessInput,
      actionRef: v4ActionRef,
      codexRotatingProviderInstanceId: v4ProviderInstanceId,
      codexRotatingReviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
      codexRotatingWorkflowSchemaVersion:
        CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
      codexRotatingWorkflowSecretNamespace: v4SecretNamespace,
    },
    {
      workflowProbe: probe,
      resolvePublicApiUrl: () => "https://api.reviewrouter.site",
    },
  );
}

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

  it("does not skip setup when discussion replies are being enabled", async () => {
    const probe = new CapturingWorkflowProbe({
      status: "present",
      expectedActionRefFound: true,
    });

    await expect(
      isWorkflowSetupAlreadyCurrent(
        { ...readinessInput, discussionMode: "suggest" },
        { workflowProbe: probe },
      ),
    ).resolves.toBe(false);

    expect(probe.input).toBeNull();
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
          "pull_request_target:",
          "    permissions:\n      id-token: write",
          "mode: codex-oauth-rotating",
          "vars.REVIEW_ROUTER_REVIEW_DRAFTS == 'true'",
          "review-drafts: ${{ vars.REVIEW_ROUTER_REVIEW_DRAFTS == 'true' }}",
          "max-changed-lines: ${{ vars.REVIEW_ROUTER_MAX_CHANGED_LINES }}",
          "timeout-minutes: ${{ fromJSON(vars.REVIEW_ROUTER_TIMEOUT_MINUTES || '60') }}",
          "review-timeout-minutes: ${{ vars.REVIEW_ROUTER_TIMEOUT_MINUTES || '60' }}",
          'provider-instance-id: "codex-rotating:123456"',
          "auth-json: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
          "claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
          "openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}",
        ],
      ],
    });
    expect(probe.inputs[1]).toMatchObject({
      workflowPath: defaultInteractionWorkflowPath,
      expectedActionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
    });
  });

  it("requires fork sandbox markers when rotating Codex fork mode is enabled", async () => {
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
          forkAgenticSandboxEnabled: true,
        },
        { workflowProbe: probe },
      ),
    ).resolves.toBe(true);

    expect(probe.input).not.toBeNull();
    expect(probe.input!.expectedContentMarkerGroups?.[0]).toEqual(
      expect.arrayContaining([
        "pull_request_target:",
        "fork-sandbox-review:",
        "vars.REVIEW_ROUTER_FORK_AGENTIC_SANDBOX == 'certified'",
        "mode: fork-agentic-sandbox",
        "REVIEW_ROUTER_PR_WORKSPACE: ${{ github.workspace }}/safe-workspace",
      ]),
    );
  });

  it("requires client-triggered T0 schema-v2 markers before skipping migration", async () => {
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
          codexRotatingReviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
          codexRotatingWorkflowSchemaVersion:
            CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredV2,
        },
        { workflowProbe: probe },
      ),
    ).resolves.toBe(true);

    expect(probe.input?.expectedContentMarkerGroups?.[0]).toEqual(
      expect.arrayContaining([
        "pull_request:",
        ".github/workflows/reviewrouter-t0-reusable.yml@",
        'provider_instance_id: "codex-rotating:123456"',
        "workflow_schema_version: 2",
      ]),
    );
    expect(probe.input?.expectedContentMarkerGroups?.[0]).not.toContain(
      "pull_request_target:",
    );
  });

  it("requires client-triggered T0 schema-v3 lifecycle markers", async () => {
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
          codexRotatingReviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
          codexRotatingWorkflowSchemaVersion:
            CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredLifecycleV3,
        },
        { workflowProbe: probe },
      ),
    ).resolves.toBe(true);

    expect(probe.input?.expectedContentMarkerGroups?.[0]).toEqual(
      expect.arrayContaining([
        "workflow_schema_version: 3",
        "review_timeout_minutes: ${{ fromJSON(vars.REVIEW_ROUTER_TIMEOUT_MINUTES || '240') }}",
      ]),
    );
  });

  it("accepts a canonical schema-v4 workflow when setup PR metadata is missing", async () => {
    await expect(checkV4WorkflowReadiness(canonicalV4Workflow())).resolves.toBe(
      true,
    );
  });

  it("does not treat the prior V2 interaction workflow as current", async () => {
    await expect(
      checkV4WorkflowReadiness(
        canonicalV4Workflow(),
        renderCanonicalCodexRotatingInteractionWorkflowV2({
          actionRef: v4ActionRef,
          apiUrl: "https://api.reviewrouter.site",
          runtimeConfigMode: "oidc",
        }),
      ),
    ).resolves.toBe(false);
  });

  it.each([
    [
      "missing same-repository guard",
      (workflow: string) =>
        workflow.replace(
          " && github.event.pull_request.head.repo.full_name == github.repository",
          "",
        ),
    ],
    [
      "missing Bot guard",
      (workflow: string) =>
        workflow.replace(
          " && github.event.pull_request.user.type != 'Bot'",
          "",
        ),
    ],
    [
      "commented same-repository guard",
      (workflow: string) =>
        workflow
          .replace(
            " && github.event.pull_request.head.repo.full_name == github.repository",
            "",
          )
          .replace(
            "    concurrency:",
            "    # github.event.pull_request.head.repo.full_name == github.repository\n    concurrency:",
          ),
    ],
    [
      "commented Bot guard",
      (workflow: string) =>
        workflow
          .replace(" && github.event.pull_request.user.type != 'Bot'", "")
          .replace(
            "    concurrency:",
            "    # github.event.pull_request.user.type != 'Bot'\n    concurrency:",
          ),
    ],
    [
      "wrong trigger",
      (workflow: string) =>
        workflow
          .replace("  pull_request_target:", "  pull_request:")
          .replace(
            "github.event_name == 'pull_request_target'",
            "github.event_name == 'pull_request'",
          ),
    ],
    [
      "commented trigger",
      (workflow: string) =>
        workflow.replace(
          "  pull_request_target:\n    types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]",
          "  # pull_request_target:\n  #   types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]",
        ),
    ],
  ])("rejects schema v4 with %s", async (_label, mutateWorkflow) => {
    await expect(
      checkV4WorkflowReadiness(mutateWorkflow(canonicalV4Workflow())),
    ).resolves.toBe(false);
  });
});
