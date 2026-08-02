import { describe, expect, it } from "vitest";
import {
  areWorkflowDocumentsSemanticallyEqual,
  CodexRotatingReviewActionV2Mode,
  CodexRotatingT0WorkflowSchemaVersion,
  workflowDocumentSemanticSha256,
} from "@reviewrouter/features-codex-oauth-rotating";
import {
  analyzeConflictReviewWorkflowCapability,
  analyzeWorkflowProviderCompatibility,
  defaultCodexRotatingWorkflowPath,
  defaultInteractionWorkflowPath,
  defaultRequiredWorkflowPath,
  defaultWorkflowPath,
  getCodexRotatingWorkflowSetupContentMarkerGroups,
  getWorkflowProviderContentMarkerGroups,
  getWorkflowSetupContentMarkerGroups,
  renderReviewRouterInteractionWorkflow,
  renderReviewRouterReusableInteractionWorkflow,
  renderReviewRouterReusableWorkflow,
  renderReviewRouterRequiredWorkflow,
  renderReviewRouterWorkflow,
  renderReviewRouterWorkflowFiles,
  renderCodexRotatingAdvisoryWorkflow,
  renderCanonicalCodexRotatingInteractionWorkflowV1,
  renderCodexRotatingInteractionWorkflow,
  scanCodexRotatingAdvisoryWorkflow,
} from "../domain/workflow-template";
import {
  renderCodexRotatingAdvisoryWorkflow as renderExportedCodexRotatingAdvisoryWorkflow,
  scanCodexRotatingAdvisoryWorkflow as scanExportedCodexRotatingAdvisoryWorkflow,
} from "../index";

const workflowOptions = {
  actionRef: "777genius/review-router@v1",
  apiUrl: "https://app.reviewrouter.dev",
  runtimeConfigMode: "oidc" as const,
  conflictReviewFallbackEnabled: true,
  staticRuntimeEnv: {
    REVIEW_AUTH_MODE: "codex-oauth",
    CODEX_MODEL: "gpt-5.5",
  },
};

function getWorkflowJobSection(workflow: string, jobId: string): string {
  const startMatch = new RegExp(`^ {2}${jobId}:\\s*$`, "m").exec(workflow);
  if (!startMatch) {
    throw new Error(`missing job ${jobId}`);
  }
  const start = startMatch.index;
  const afterStart = start + startMatch[0].length;
  const remainder = workflow.slice(afterStart);
  const nextJobMatch = /^ {2}[A-Za-z0-9_-]+:\s*$/m.exec(remainder);
  const end = nextJobMatch ? afterStart + nextJobMatch.index : workflow.length;
  return workflow.slice(start, end);
}

describe("renderReviewRouterWorkflow", () => {
  it("exports a dedicated advisory-only rotating Codex OAuth workflow", () => {
    const workflow = renderExportedCodexRotatingAdvisoryWorkflow({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://reviewrouter.site",
      providerInstanceId: "codex-rotating:777genius/agent-teams-ai",
    });

    expect(workflow).toContain("name: ReviewRouter Codex OAuth");
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("permissions: {}\n\njobs:");
    expect(workflow).toContain("    permissions:\n      id-token: write");
    expect(workflow).toContain("mode: codex-oauth-rotating");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("codex-refresh:");
    expect(workflow).toContain("mode: codex-oauth-refresh");
    expect(workflow).toContain(
      "group: reviewrouter-codex-oauth-${{ github.repository_id }}-codex-rotating-777genius-agent-teams-ai",
    );
    expect(workflow).not.toMatch(/^\s+queue:/m);
    expect(workflow).toContain(
      "auth-json: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
    );
    expect(workflow).not.toContain("merge_group:");
    expect(workflow).not.toContain("actions/checkout");
    expect(scanExportedCodexRotatingAdvisoryWorkflow(workflow)).toEqual({
      valid: true,
      errors: [],
    });
    expect(renderCodexRotatingAdvisoryWorkflow).toBe(
      renderExportedCodexRotatingAdvisoryWorkflow,
    );
    expect(scanCodexRotatingAdvisoryWorkflow).toBe(
      scanExportedCodexRotatingAdvisoryWorkflow,
    );
  });

  it("renders the dedicated rotating Codex workflow and trusted legacy cleanup operations when rotating provider setup is requested", () => {
    const files = renderReviewRouterWorkflowFiles({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://reviewrouter.site",
      runtimeConfigMode: "oidc",
      workflowStyle: "reusable",
      staticRuntimeEnv: {
        REVIEW_AUTH_MODE: "codex-oauth-rotating",
      },
      codexRotatingProviderInstanceId: "codex-rotating:123456",
    });

    expect(files).toHaveLength(3);
    const codexWorkflow = files[0];
    const interactionWorkflow = files[2];
    expect(codexWorkflow?.path).toBe(defaultCodexRotatingWorkflowPath);
    expect(codexWorkflow?.operation).not.toBe("delete");
    expect(files[1]).toMatchObject({
      path: ".github/workflows/reviewrouter.yml",
      operation: "delete",
    });
    expect(interactionWorkflow?.path).toBe(defaultInteractionWorkflowPath);
    expect(interactionWorkflow?.operation).not.toBe("delete");
    const codexWorkflowContent =
      codexWorkflow && codexWorkflow.operation !== "delete"
        ? codexWorkflow.content
        : "";
    const interactionWorkflowContent =
      interactionWorkflow && interactionWorkflow.operation !== "delete"
        ? interactionWorkflow.content
        : "";
    expect(codexWorkflowContent).toContain("name: ReviewRouter Codex OAuth");
    expect(codexWorkflowContent).toContain(
      'provider-instance-id: "codex-rotating:123456"',
    );
    expect(codexWorkflowContent).not.toContain("reviewrouter-interaction.yml");
    expect(codexWorkflowContent).toContain("workflow_dispatch:");
    expect(codexWorkflowContent).toContain("schedule:");
    expect(codexWorkflowContent).toContain("codex-refresh:");
    expect(codexWorkflowContent).toContain("mode: codex-oauth-refresh");
    expect(scanCodexRotatingAdvisoryWorkflow(codexWorkflowContent)).toEqual({
      valid: true,
      errors: [],
    });
    expect(interactionWorkflowContent).toContain(
      "name: ReviewRouter Interaction",
    );
    expect(interactionWorkflowContent).toContain(
      "pull_request_review_comment:",
    );
    expect(interactionWorkflowContent).toContain("issue_comment:");
    expect(interactionWorkflowContent).toContain("runs-on: ubuntu-24.04");
    expect(interactionWorkflowContent).toContain(
      "repository: 777genius/review-router",
    );
    expect(interactionWorkflowContent).toContain(
      "run: node .reviewrouter-runtime/dist/index.js",
    );
    expect(interactionWorkflowContent).toContain(
      "CODEX_AUTH_JSON_PRESENT: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON != '' && '1' || '0' }}",
    );
    expect(interactionWorkflowContent).toContain(
      'REVIEW_ROUTER_REVIEW_WORKFLOW_FILE: "reviewrouter-codex.yml"',
    );
    expect(interactionWorkflowContent).toContain(
      'REVIEW_ROUTER_MODE: "interaction-preflight"',
    );
    expect(interactionWorkflowContent).toContain(
      'REVIEW_ROUTER_MODE: "interaction"',
    );
    expect(interactionWorkflowContent).not.toContain(
      "uses: 777genius/review-router@",
    );
    expect(interactionWorkflowContent).not.toContain("provider-instance-id:");
    expect(interactionWorkflowContent).not.toContain("auth-json:");
    expect(interactionWorkflowContent).not.toContain("secrets.CODEX_AUTH_JSON");
    expect(interactionWorkflowContent).not.toContain("OPENAI_API_KEY");
  });

  it("keeps the managed interaction workflow installed in T0 mode", () => {
    const files = renderReviewRouterWorkflowFiles({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://api.reviewrouter.site",
      runtimeConfigMode: "oidc",
      codexRotatingProviderInstanceId: "codex-rotating:123456",
      codexRotatingReviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });

    const interactionWorkflow = files.find(
      (file) => file.path === defaultInteractionWorkflowPath,
    );
    expect(interactionWorkflow).toMatchObject({
      path: defaultInteractionWorkflowPath,
    });
    expect(interactionWorkflow?.operation).not.toBe("delete");
  });

  it("provisions the client-triggered T0 schema when explicitly selected", () => {
    const files = renderReviewRouterWorkflowFiles({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://api.reviewrouter.site",
      runtimeConfigMode: "oidc",
      codexRotatingProviderInstanceId: "codex-rotating:123456",
      codexRotatingReviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
      codexRotatingWorkflowSchemaVersion:
        CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredV2,
    });

    const codexWorkflow = files.find(
      (file) => file.path === defaultCodexRotatingWorkflowPath,
    );
    const content =
      codexWorkflow && codexWorkflow.operation !== "delete"
        ? codexWorkflow.content
        : "";
    expect(content).toContain("  pull_request:");
    expect(content).toContain("workflow_schema_version: 2");
    expect(scanCodexRotatingAdvisoryWorkflow(content)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("renders optional hybrid provider secret inputs only when configured for rotating Codex workflow", () => {
    const files = renderReviewRouterWorkflowFiles({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://reviewrouter.site",
      runtimeConfigMode: "oidc",
      staticRuntimeEnv: {
        REVIEW_AUTH_MODE: "codex-oauth-rotating",
        REVIEW_PROVIDERS:
          "codex/gpt-5.5,claude/sonnet,openrouter/openai/gpt-5.3-codex",
      },
      codexRotatingProviderInstanceId: "codex-rotating:123456",
    });

    const codexWorkflow = files[0];
    const content =
      codexWorkflow && codexWorkflow.operation !== "delete"
        ? codexWorkflow.content
        : "";
    expect(content).toContain(
      "auth-json: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
    );
    expect(content).toContain(
      "claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    );
    expect(content).toContain(
      "openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}",
    );
    expect(scanCodexRotatingAdvisoryWorkflow(content)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("adds fork agentic sandbox as an opt-in job inside the rotating Codex workflow", () => {
    const files = renderReviewRouterWorkflowFiles({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://reviewrouter.site",
      runtimeConfigMode: "oidc",
      staticRuntimeEnv: {
        REVIEW_AUTH_MODE: "codex-oauth-rotating",
        REVIEW_PROVIDERS:
          "codex/gpt-5.5,claude/sonnet,openrouter/openai/gpt-5.3-codex",
      },
      codexRotatingProviderInstanceId: "codex-rotating:123456",
      forkAgenticSandboxEnabled: true,
    });

    expect(files.map((file) => file.path)).toEqual([
      defaultCodexRotatingWorkflowPath,
      defaultWorkflowPath,
      defaultInteractionWorkflowPath,
    ]);
    const codexWorkflow = workflowFileContent(files[0]);
    expect(codexWorkflow).toContain("pull_request_target:");
    expect(codexWorkflow).toContain("fork-sandbox-review:");
    expect(codexWorkflow).toContain(
      "vars.REVIEW_ROUTER_FORK_AGENTIC_SANDBOX == 'certified'",
    );
    expect(codexWorkflow).toContain(
      "repository: ${{ github.event.pull_request.head.repo.full_name }}",
    );
    expect(codexWorkflow).toContain("path: safe-workspace");
    expect(codexWorkflow).toContain("persist-credentials: false");
    expect(codexWorkflow).toContain("fetch-depth: 0");
    expect(codexWorkflow).toContain(
      "git -C safe-workspace config --local --get-regexp",
    );
    expect(codexWorkflow).toContain("find safe-workspace -type l -print -quit");
    expect(codexWorkflow).toContain("mode: fork-agentic-sandbox");
    expect(codexWorkflow).toContain(
      "REVIEW_ROUTER_PR_WORKSPACE: ${{ github.workspace }}/safe-workspace",
    );
    expect(codexWorkflow).toContain(
      "auth-json: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
    );
    expect(codexWorkflow).toContain(
      "claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    );
    expect(codexWorkflow).toContain(
      "openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}",
    );
    expect(scanCodexRotatingAdvisoryWorkflow(codexWorkflow)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("renders the dedicated rotating Codex interaction workflow", () => {
    const workflow = renderCodexRotatingInteractionWorkflow({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://reviewrouter.site",
      runtimeConfigMode: "oidc",
    });

    expect(workflow).toContain("name: ReviewRouter Interaction");
    expect(workflow).toContain("pull_request_review_comment:");
    expect(workflow).toContain("issue_comment:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("repository: 777genius/review-router");
    expect(workflow).toContain("run: node .reviewrouter-runtime/dist/index.js");
    expect(workflow).toContain(
      "CODEX_AUTH_JSON_PRESENT: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON != '' && '1' || '0' }}",
    );
    expect(workflow).toContain(
      "CODEX_AUTH_JSON: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
    );
    expect(workflow).toContain(
      'REVIEW_ROUTER_REVIEW_WORKFLOW_FILE: "reviewrouter-codex.yml"',
    );
    expect(workflow).toContain('REVIEW_ROUTER_MODE: "interaction-preflight"');
    expect(workflow).toContain('REVIEW_ROUTER_MODE: "interaction"');
    expect(workflow).not.toContain("uses: 777genius/review-router@");
    expect(workflow).not.toContain("provider-instance-id:");
    expect(workflow).not.toContain("auth-json:");
    expect(workflow).not.toContain("secrets.CODEX_AUTH_JSON");
    expect(workflow).not.toContain("OPENAI_API_KEY");
    expect(
      workflowDocumentSemanticSha256(
        renderCanonicalCodexRotatingInteractionWorkflowV1({
          actionRef:
            "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
          apiUrl: "https://reviewrouter.site",
          runtimeConfigMode: "oidc",
        }),
      ),
    ).toBe("d8fd345029d506b221cabfbe6e53da429f40f9a1876388cb8c52c026112250ee");
    expect(
      areWorkflowDocumentsSemanticallyEqual(
        workflow,
        workflow.replace("  workflow_dispatch:", "  workflow_dispatch: .nan"),
      ),
    ).toBe(false);
  });

  it("exports readiness markers for the dedicated rotating Codex workflow", () => {
    expect(
      getCodexRotatingWorkflowSetupContentMarkerGroups({
        providerInstanceId: "codex-rotating:123456",
        claudeCodeOAuthTokenSecret: true,
        openRouterApiKeySecret: true,
      }),
    ).toEqual([
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
    ]);
  });

  it("exports distinct readiness markers for client-triggered T0 schema v2", () => {
    const markers = getCodexRotatingWorkflowSetupContentMarkerGroups({
      providerInstanceId: "codex-rotating:123456",
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
      workflowSchemaVersion:
        CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredV2,
    });

    expect(markers).toEqual([
      expect.arrayContaining([
        "pull_request:",
        ".github/workflows/reviewrouter-t0-reusable.yml@",
        'provider_instance_id: "codex-rotating:123456"',
        "workflow_schema_version: 2",
        "CODEX_AUTH_JSON: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
      ]),
    ]);
    expect(markers[0]).not.toContain("pull_request_target:");
    expect(markers[0]).not.toContain("mode: codex-oauth-rotating");
  });

  it("renders a review-only pull request workflow", () => {
    const workflow = renderReviewRouterWorkflow({
      ...workflowOptions,
      conflictReviewFallbackEnabled: false,
    });

    expect(workflow).toContain("name: ReviewRouter");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request_review_comment:");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).not.toContain("name: interaction");
    expect(workflow).not.toContain("actions: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain(
      "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository",
    );
    expect(workflow).toContain(
      "github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false",
    );
    expect(workflow).toContain("uses: 777genius/review-router@v1");
    expect(workflow).toContain("uses: actions/setup-node@v6");
    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain("npm install -g @openai/codex@0.141.0");
    expect(workflow).toContain("env.OPENROUTER_API_KEY_PRESENT == '1'");
    expect(workflow).toContain("github.event.pull_request.user.type != 'Bot'");
    expect(workflow).toContain(
      "CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
    );
    expect(workflow).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
    expect(workflow).toContain(
      "OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}",
    );
    expect(workflow).toContain(
      "CLAUDE_CODE_OAUTH_TOKEN_PRESENT: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN != '' && '1' || '0' }}",
    );
    expect(workflow).toContain("Install Claude Code CLI");
    expect(workflow).toContain("bash -s stable");
    expect(workflow).toContain(
      "CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    );
    expect(workflow).toContain(
      "CODEX_AUTH_JSON secret is missing. reseed auth.json",
    );
    expect(workflow).toContain(
      'REVIEWROUTER_API_URL: "https://app.reviewrouter.dev"',
    );
    expect(workflow).toContain('REVIEWROUTER_ACTION_VERSION: "v1"');
    expect(workflow).toContain("GITHUB_TOKEN: ${{ github.token }}");
    expect(workflow).toContain(
      "PR_NUMBER: ${{ github.event.pull_request.number }}",
    );
    expect(workflow).toContain('REVIEWROUTER_OIDC_AUDIENCE: "reviewrouter"');
    expect(workflow).toContain('REVIEWROUTER_RUNTIME_CONFIG_MODE: "oidc"');
    expect(workflow).toContain('REVIEWROUTER_COMMENT_TOKEN_MODE: "app-oidc"');
    expect(workflow).toContain('REVIEW_ROUTER_MEMORY_ENABLED: "true"');
    expect(workflow).toContain(
      'REVIEW_ROUTER_MEMORY_BUNDLE_ENDPOINT: "/api/action/v1/memory"',
    );
    expect(workflow).not.toContain("REVIEW_ROUTER_MEMORY_COMMAND_ENDPOINT");
    expect(workflow).toContain('REVIEW_AUTH_MODE: "codex-oauth"');
    expect(workflow).toContain('CODEX_MODEL: "gpt-5.5"');
  });

  it("requires rotating Codex setup before fork agentic sandbox can be provisioned", () => {
    expect(() =>
      renderReviewRouterWorkflowFiles({
        ...workflowOptions,
        forkAgenticSandboxEnabled: true,
      }),
    ).toThrow("fork_agentic_sandbox_requires_codex_rotating");
  });

  it("renders a separate interaction workflow for /rr commands", () => {
    const workflow = renderReviewRouterInteractionWorkflow(workflowOptions);

    expect(workflow).toContain("name: ReviewRouter Interaction");
    expect(workflow).toContain("pull_request_review_comment:");
    expect(workflow).toContain("issue_comment:");
    expect(workflow).toContain("types: [created, edited]");
    expect(workflow).toContain(
      "github.event_name == 'workflow_dispatch' || ((github.event_name != 'issue_comment' || github.event.issue.pull_request) && github.event.comment.user.type != 'Bot')",
    );
    expect(workflow).not.toContain("pull_request:\n");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).toContain("actions: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("github.event.comment.user.type != 'Bot'");
    expect(workflow).not.toContain(
      "startsWith(github.event.comment.body, '/rr ')",
    );
    expect(workflow).toContain("Preflight ReviewRouter interaction");
    expect(workflow).toContain("mode: interaction-preflight");
    expect(workflow).toContain('api-url: "https://app.reviewrouter.dev"');
    expect(workflow).toContain('REVIEW_ROUTER_MODE: "interaction-preflight"');
    expect(workflow).toContain(
      "REVIEW_ROUTER_DISCUSSION_MODE: ${{ vars.REVIEW_ROUTER_DISCUSSION_MODE || 'off' }}",
    );
    expect(workflow).toContain(
      "steps.preflight.outputs.needs_discussion == 'true'",
    );
    expect(workflow).toContain("Install Codex CLI for discussion replies");
    expect(workflow).toContain(
      "Restore Codex subscription auth for discussion replies",
    );
    expect(workflow).toContain("CODEX_AUTH_JSON_PRESENT");
    expect(workflow).toContain("OPENAI_API_KEY_PRESENT");
    expect(workflow).toContain("steps.preflight.outputs.should_run == 'true'");
    expect(workflow).toContain("mode: interaction");
    expect(workflow).toContain('REVIEW_ROUTER_MODE: "interaction"');
    expect(workflow).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
    expect(workflow).toContain(
      "CODEX_MODEL: ${{ vars.REVIEW_CODEX_MODEL || 'gpt-5.5' }}",
    );
    expect(workflow).toContain(
      "CODEX_REASONING_EFFORT: ${{ vars.REVIEW_CODEX_EFFORT || 'xhigh' }}",
    );
    expect(workflow).not.toContain("REVIEW_ROUTER_THREAD_RESOLVE_TOKEN");
    expect(workflow).toContain(
      'REVIEW_ROUTER_REVIEW_WORKFLOW_FILE: "reviewrouter.yml"',
    );
    expect(workflow).toContain('REVIEWROUTER_COMMENT_TOKEN_MODE: "app-oidc"');
    expect(workflow).toContain('REVIEW_ROUTER_MEMORY_ENABLED: "true"');
    expect(workflow).toContain(
      'REVIEW_ROUTER_MEMORY_CANDIDATE_ENDPOINT: "/api/action/v1/memory-candidates"',
    );
    expect(workflow).toContain(
      'REVIEW_ROUTER_MEMORY_COMMAND_ENDPOINT: "/api/action/v1/memory-commands"',
    );
  });

  it("returns both workflow files for setup PR provisioning", () => {
    const files = renderReviewRouterWorkflowFiles(workflowOptions);

    expect(files.map((file) => file.path)).toEqual([
      defaultWorkflowPath,
      defaultInteractionWorkflowPath,
    ]);
    const [reviewWorkflow, interactionWorkflow] = files;
    const reviewWorkflowContent = workflowFileContent(reviewWorkflow);
    const interactionWorkflowContent = workflowFileContent(interactionWorkflow);
    expect(reviewWorkflowContent).toContain("name: ReviewRouter");
    expect(reviewWorkflowContent).toContain(
      "uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1",
    );
    expect(reviewWorkflowContent).not.toContain("pull_request_review_comment:");
    expect(interactionWorkflowContent).toContain(
      "name: ReviewRouter Interaction",
    );
    expect(interactionWorkflowContent).toContain(
      "uses: 777genius/review-router/.github/workflows/reviewrouter-interaction-reusable.yml@v1",
    );
    expect(interactionWorkflowContent).toContain(
      "review_workflow_file: reviewrouter.yml",
    );
    expect(interactionWorkflowContent).toContain(
      "discussion_mode: ${{ vars.REVIEW_ROUTER_DISCUSSION_MODE || 'off' }}",
    );
    expect(interactionWorkflowContent).toContain(
      "discussion_model: ${{ vars.REVIEW_CODEX_MODEL || 'gpt-5.5' }}",
    );
    expect(interactionWorkflowContent).toContain(
      "discussion_reasoning_effort: ${{ vars.REVIEW_CODEX_EFFORT || 'xhigh' }}",
    );
    expect(interactionWorkflowContent).toContain(
      "discussion_max_per_pr: ${{ vars.REVIEW_ROUTER_DISCUSSION_MAX_PER_PR || '20' }}",
    );
    expect(interactionWorkflowContent).toContain(
      "pull_request_review_comment:",
    );
    expect(interactionWorkflowContent).toContain("issue_comment:");
    expect(interactionWorkflowContent).toContain(
      "github.event_name == 'workflow_dispatch' || ((github.event_name != 'issue_comment' || github.event.issue.pull_request) && github.event.comment.user.type != 'Bot')",
    );
  });

  it("can opt setup PR interaction workflows into suggest-only discussion replies", () => {
    const files = renderReviewRouterWorkflowFiles({
      ...workflowOptions,
      discussionMode: "suggest",
    });
    const interactionWorkflowContent = workflowFileContent(
      files.find((file) => file.path === defaultInteractionWorkflowPath),
    );

    expect(interactionWorkflowContent).toContain(
      "discussion_mode: ${{ vars.REVIEW_ROUTER_DISCUSSION_MODE || 'suggest' }}",
    );
  });

  it("does not render conflict fallback trigger or inputs unless enabled", () => {
    const workflow = renderReviewRouterReusableWorkflow({
      ...workflowOptions,
      conflictReviewFallbackEnabled: false,
    });

    expect(workflow).not.toContain("repository_dispatch:");
    expect(workflow).not.toContain("github.event.client_payload");
    expect(workflow).not.toContain("review_kind:");
    expect(workflow).not.toContain("conflict_dispatch_id:");
  });

  it("rejects mutable reusable workflow refs when conflict fallback is enabled", () => {
    expect(() =>
      renderReviewRouterReusableWorkflow({
        ...workflowOptions,
        actionRef: "777genius/review-router@main",
      }),
    ).toThrow("invalid_conflict_review_reusable_workflow_runtime_ref");

    expect(() =>
      renderReviewRouterReusableWorkflow({
        ...workflowOptions,
        actionRef: "777genius/review-router@main",
        conflictReviewFallbackEnabled: false,
      }),
    ).not.toThrow();
  });

  it("renders compact reusable caller workflows with conflict fallback enabled", () => {
    const reviewWorkflow = renderReviewRouterReusableWorkflow(workflowOptions);
    const interactionWorkflow =
      renderReviewRouterReusableInteractionWorkflow(workflowOptions);
    const reviewJob = getWorkflowJobSection(reviewWorkflow, "review");
    const conflictReviewJob = getWorkflowJobSection(
      reviewWorkflow,
      "conflict-review",
    );

    expect(reviewWorkflow).toContain("pull_request:");
    expect(reviewWorkflow).toContain("merge_group:");
    expect(reviewWorkflow).toContain("repository_dispatch:");
    expect(reviewWorkflow).toContain("types: [reviewrouter_conflict_review]");
    expect(reviewWorkflow).toContain("workflow_dispatch:");
    expect(reviewWorkflow).toContain("permissions: {}\n\nconcurrency:");
    expect(reviewWorkflow).toContain("concurrency:");
    expect(reviewWorkflow).toContain(
      "group: reviewrouter-conflict-${{ github.repository }}-${{ github.workflow }}-${{ github.run_id }}",
    );
    expect(reviewWorkflow).toContain("cancel-in-progress: false");
    expect(reviewJob).toContain(
      "if: ${{ github.event_name != 'repository_dispatch' }}",
    );
    expect(reviewJob).toContain("pull-requests: write");
    expect(reviewJob).toContain("issues: write");
    expect(reviewJob).not.toContain("github.event.client_payload");
    expect(reviewJob).not.toContain("review_kind:");
    expect(conflictReviewJob).toContain("name: conflict review");
    expect(conflictReviewJob).toContain(
      "github.event_name == 'repository_dispatch' && github.event.action == 'reviewrouter_conflict_review'",
    );
    expect(conflictReviewJob).toContain("contents: read");
    expect(conflictReviewJob).toContain("id-token: write");
    expect(conflictReviewJob).not.toContain("pull-requests: write");
    expect(conflictReviewJob).not.toContain("issues: write");
    expect(conflictReviewJob).not.toContain("write-all");
    expect(conflictReviewJob).not.toContain("read-all");
    expect(reviewJob).toContain(
      "uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1",
    );
    expect(conflictReviewJob).toContain(
      "uses: 777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@v1",
    );
    expect(reviewWorkflow).toContain("runtime_ref: v1");
    expect(reviewWorkflow).toContain('api_url: "https://app.reviewrouter.dev"');
    expect(reviewWorkflow).toContain("runtime_config_mode: oidc");
    expect(reviewJob).toContain(
      "pr_number: ${{ github.event.pull_request.number || inputs.pr_number }}",
    );
    expect(conflictReviewJob).toContain(
      "pr_number: ${{ github.event.client_payload.pr_number }}",
    );
    expect(conflictReviewJob).toContain("review_kind: conflict-head");
    expect(conflictReviewJob).toContain("conflict_repository_id:");
    expect(conflictReviewJob).toContain("conflict_dispatch_event_type:");
    expect(conflictReviewJob).toContain("conflict_dispatch_id:");
    expect(conflictReviewJob).toContain("conflict_dispatch_nonce:");
    expect(conflictReviewJob).toContain("conflict_head_sha:");
    expect(conflictReviewJob).toContain("conflict_base_ref:");
    expect(conflictReviewJob).toContain("conflict_base_sha:");
    const staticRuntimeEnvJsonBlock = [
      "static_runtime_env_json: |-",
      "        {",
      '          "REVIEW_AUTH_MODE": "codex-oauth",',
      '          "CODEX_MODEL": "gpt-5.5"',
      "        }",
    ].join("\n");
    expect(reviewJob).toContain(staticRuntimeEnvJsonBlock);
    expect(conflictReviewJob).not.toContain("static_runtime_env_json:");
    expect(conflictReviewJob).not.toContain('"REVIEW_AUTH_MODE"');
    expect(conflictReviewJob).not.toContain('"CODEX_MODEL"');
    expect(reviewWorkflow).toContain(
      "CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
    );
    expect(reviewWorkflow).toContain(
      "CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    );
    expect(reviewWorkflow).toContain(
      "REVIEW_ROUTER_LEDGER_KEY: ${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}",
    );
    expect(conflictReviewJob).toContain(
      "CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
    );
    expect(conflictReviewJob).toContain(
      "OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}",
    );
    expect(conflictReviewJob).not.toContain("REVIEW_ROUTER_LEDGER_KEY");
    expect(conflictReviewJob).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(conflictReviewJob).not.toContain("OPENROUTER_API_KEY");
    expect(reviewWorkflow).not.toContain("pull_request_target");
    expect(reviewWorkflow).not.toContain("actions/setup-node@v6");

    expect(interactionWorkflow).toContain("pull_request_review_comment:");
    expect(interactionWorkflow).toContain("issue_comment:");
    expect(interactionWorkflow).toContain("types: [created, edited]");
    expect(interactionWorkflow).toContain(
      "github.event_name == 'workflow_dispatch' || ((github.event_name != 'issue_comment' || github.event.issue.pull_request) && github.event.comment.user.type != 'Bot')",
    );
    expect(interactionWorkflow).toContain("actions: write");
    expect(interactionWorkflow).toContain(
      "uses: 777genius/review-router/.github/workflows/reviewrouter-interaction-reusable.yml@v1",
    );
    expect(interactionWorkflow).toContain(
      "REVIEW_ROUTER_LEDGER_KEY: ${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}",
    );
    expect(interactionWorkflow).toContain(
      "CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
    );
    expect(interactionWorkflow).toContain(
      "CODEX_CONFIG_TOML: ${{ secrets.CODEX_CONFIG_TOML }}",
    );
    expect(interactionWorkflow).toContain(
      "OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}",
    );
    expect(interactionWorkflow).not.toContain("pull_request_target");
  });

  it("keeps explicit workflow rendering available for debug fallback", () => {
    const files = renderReviewRouterWorkflowFiles({
      ...workflowOptions,
      workflowStyle: "explicit",
      conflictReviewFallbackEnabled: false,
    });

    const workflow = files[0];
    const workflowContent =
      workflow && workflow.operation !== "delete" ? workflow.content : "";
    expect(workflowContent).toContain("uses: 777genius/review-router@v1");
    expect(workflowContent).toContain("actions/setup-node@v6");
    expect(workflowContent).not.toContain(
      ".github/workflows/reviewrouter-reusable.yml",
    );
  });

  it("rejects conflict fallback on explicit workflows", () => {
    expect(() =>
      renderReviewRouterWorkflowFiles({
        ...workflowOptions,
        workflowStyle: "explicit",
      }),
    ).toThrow("conflict_review_explicit_workflow_unsupported");
    expect(() => renderReviewRouterWorkflow(workflowOptions)).toThrow(
      "conflict_review_explicit_workflow_unsupported",
    );
  });

  it("renders a required ruleset workflow without pull_request_target", () => {
    const workflow = renderReviewRouterRequiredWorkflow(workflowOptions);

    expect(defaultRequiredWorkflowPath).toBe(
      ".github/workflows/reviewrouter-required.yml",
    );
    expect(workflow).toContain("name: ReviewRouter Required");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("merge_group:");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("repository_dispatch:");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("ReviewRouter merge queue check passed");
    expect(workflow).toContain("uses: 777genius/review-router@v1");
    expect(workflow).toContain("github.event_name != 'merge_group'");
    expect(workflow).toContain(
      "github.event_name != 'merge_group' && (github.event_name != 'pull_request'",
    );
    expect(workflow).toContain('REVIEWROUTER_COMMENT_TOKEN_MODE: "app-oidc"');
    expect(workflow).toContain(
      'REVIEW_ROUTER_MEMORY_BUNDLE_ENDPOINT: "/api/action/v1/memory"',
    );
    expect(workflow).toContain(
      "CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
    );
    expect(workflow).toContain(
      "CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    );
    expect(workflow).toContain("Install Claude Code CLI");
    expect(workflow).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
  });

  it("detects Claude workflow compatibility for generated and old workflows", () => {
    const reusableWorkflow =
      renderReviewRouterReusableWorkflow(workflowOptions);
    const explicitWorkflow = renderReviewRouterWorkflow({
      ...workflowOptions,
      workflowStyle: "explicit",
      conflictReviewFallbackEnabled: false,
    });

    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: reusableWorkflow,
        providerKind: "claude",
        workflowStyle: "reusable",
      }),
    ).toEqual({
      providerKind: "claude",
      supported: true,
      missingRequirements: [],
    });
    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: explicitWorkflow,
        providerKind: "claude",
        workflowStyle: "explicit",
      }),
    ).toEqual({
      providerKind: "claude",
      supported: true,
      missingRequirements: [],
    });
    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: reusableWorkflow.replaceAll(
          "CLAUDE_CODE_OAUTH_TOKEN",
          "OLD_SECRET",
        ),
        providerKind: "claude",
        workflowStyle: "reusable",
      }),
    ).toMatchObject({
      supported: false,
      missingRequirements: ["secret_pass_through"],
    });
    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: explicitWorkflow.replace("Install Claude Code CLI", ""),
        providerKind: "claude",
        workflowStyle: "explicit",
      }),
    ).toMatchObject({
      supported: false,
      missingRequirements: ["cli_install_step"],
    });
  });

  it("detects OpenRouter workflow compatibility for generated and old workflows", () => {
    const reusableWorkflow =
      renderReviewRouterReusableWorkflow(workflowOptions);
    const explicitWorkflow = renderReviewRouterWorkflow({
      ...workflowOptions,
      workflowStyle: "explicit",
      conflictReviewFallbackEnabled: false,
    });

    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: reusableWorkflow,
        providerKind: "openrouter",
        workflowStyle: "reusable",
      }),
    ).toEqual({
      providerKind: "openrouter",
      supported: true,
      missingRequirements: [],
    });
    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: explicitWorkflow,
        providerKind: "openrouter",
        workflowStyle: "explicit",
      }),
    ).toEqual({
      providerKind: "openrouter",
      supported: true,
      missingRequirements: [],
    });
    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: explicitWorkflow.replace("Install Codex CLI", ""),
        providerKind: "openrouter",
        workflowStyle: "explicit",
      }),
    ).toMatchObject({
      supported: false,
      missingRequirements: ["cli_install_step"],
    });
  });

  it("exports provider workflow marker groups for readiness probes", () => {
    expect(
      getWorkflowProviderContentMarkerGroups({ providerKind: "claude" }),
    ).toEqual([
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
    expect(
      getWorkflowProviderContentMarkerGroups({ providerKind: "openrouter" }),
    ).toEqual([
      [".github/workflows/reviewrouter-reusable.yml", "OPENROUTER_API_KEY"],
      ["Install Codex CLI", "OPENROUTER_API_KEY", "Skip fork pull requests"],
    ]);
    expect(
      getWorkflowProviderContentMarkerGroups({ providerKind: "codex" }),
    ).toEqual([]);
  });

  it("exports combined conflict fallback marker groups for setup readiness probes", () => {
    expect(
      getWorkflowSetupContentMarkerGroups({
        conflictReviewFallbackEnabled: true,
      }),
    ).toEqual([
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

    expect(
      getWorkflowSetupContentMarkerGroups({
        providerKind: "claude",
        conflictReviewFallbackEnabled: true,
      }),
    ).toEqual([
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

  it("detects conflict review capability only on the reusable review workflow", () => {
    const reviewWorkflow = renderReviewRouterReusableWorkflow(workflowOptions);
    const explicitWorkflow = renderReviewRouterWorkflow({
      ...workflowOptions,
      workflowStyle: "explicit",
      conflictReviewFallbackEnabled: false,
    });
    const requiredWorkflow =
      renderReviewRouterRequiredWorkflow(workflowOptions);

    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: reviewWorkflow,
      }),
    ).toEqual({ supported: true });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: explicitWorkflow,
      }),
    ).toEqual({
      supported: false,
      reason: "repository_dispatch_missing",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: requiredWorkflow,
      }),
    ).toEqual({
      supported: false,
      reason: "repository_dispatch_missing",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: reviewWorkflow
          .replace("  repository_dispatch:", "  # repository_dispatch:")
          .replace(
            "    types: [reviewrouter_conflict_review]",
            "    # types: [reviewrouter_conflict_review]",
          ),
      }),
    ).toEqual({
      supported: false,
      reason: "repository_dispatch_missing",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: reviewWorkflow.replace("conflict_dispatch_id:", ""),
      }),
    ).toEqual({
      supported: false,
      reason: "conflict_dispatch_inputs_missing",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: [
          reviewWorkflow,
          "  unsafe:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo unsafe",
        ].join("\n"),
      }),
    ).toEqual({
      supported: false,
      reason: "conflict_fallback_workflow_shape_untrusted",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: [
          reviewWorkflow,
          "  unsafe:",
          "    uses: attacker/workflows/.github/workflows/review.yml@main",
        ].join("\n"),
      }),
    ).toEqual({
      supported: false,
      reason: "conflict_fallback_workflow_shape_untrusted",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: reviewWorkflow.replace(
          ".github/workflows/reviewrouter-conflict-reusable.yml@v1",
          ".github/workflows/reviewrouter-conflict-reusable.yml@main",
        ),
      }),
    ).toEqual({
      supported: false,
      reason: "conflict_reusable_workflow_ref_untrusted",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: reviewWorkflow.replace(
          "github.run_id",
          "github.event.client_payload.dispatch_id",
        ),
      }),
    ).toEqual({
      supported: false,
      reason: "conflict_concurrency_missing",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: reviewWorkflow.replace(
          [
            "    permissions:",
            "      contents: read",
            "      id-token: write",
            "    uses: 777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@v1",
          ].join("\n"),
          [
            "    permissions:",
            "      contents: read",
            "      pull-requests: write",
            "      id-token: write",
            "    uses: 777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@v1",
          ].join("\n"),
        ),
      }),
    ).toEqual({
      supported: false,
      reason: "conflict_workflow_write_permissions_forbidden",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: reviewWorkflow.replace(
          "permissions: {}\n\nconcurrency:",
          [
            "permissions:",
            "  contents: read",
            "  pull-requests: write",
            "  issues: write",
            "  id-token: write",
            "",
            "concurrency:",
          ].join("\n"),
        ),
      }),
    ).toEqual({
      supported: false,
      reason: "workflow_write_permissions_forbidden",
    });
  });

  it("uses github-actions comment identity when runtime config is static", () => {
    const reviewWorkflow = renderReviewRouterWorkflow({
      actionRef: "777genius/review-router@v1",
      apiUrl: "https://app.reviewrouter.dev",
      runtimeConfigMode: "static",
    });
    const interactionWorkflow = renderReviewRouterInteractionWorkflow({
      actionRef: "777genius/review-router@v1",
      apiUrl: "https://app.reviewrouter.dev",
      runtimeConfigMode: "static",
    });

    expect(reviewWorkflow).toContain(
      'REVIEWROUTER_COMMENT_TOKEN_MODE: "github-token"',
    );
    expect(interactionWorkflow).toContain(
      'REVIEWROUTER_COMMENT_TOKEN_MODE: "github-token"',
    );
  });

  it("allows local http for development workflow provisioning only", () => {
    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "http://localhost:4000",
        runtimeConfigMode: "oidc",
      }),
    ).not.toThrow();
    expect(() =>
      renderReviewRouterInteractionWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "http://127.0.0.1:4000",
        runtimeConfigMode: "oidc",
      }),
    ).not.toThrow();
    expect(() =>
      renderReviewRouterInteractionWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "http://[::1]:4000",
        runtimeConfigMode: "oidc",
      }),
    ).not.toThrow();
  });

  it("rejects unsafe workflow template inputs before rendering YAML", () => {
    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1\nrun: evil",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_action_ref");

    expect(() =>
      renderReviewRouterInteractionWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "javascript:alert(1)",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_api_url");

    expect(() =>
      renderReviewRouterRequiredWorkflow({
        actionRef: "777genius/review-router@v1\nrun: evil",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_action_ref");

    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "http://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_api_url");

    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "https://token@example.com",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_api_url");

    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "https://app.reviewrouter.dev?target=evil",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_api_url");

    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "https://app.reviewrouter.dev/base-path",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_api_url");

    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "static",
        staticRuntimeEnv: {
          "BAD_KEY:\n          RUN": "evil",
        },
      }),
    ).toThrow("invalid_workflow_env_key");

    expect(() =>
      renderReviewRouterReusableWorkflow({
        actionRef: "evil/review-router@v1",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_reusable_workflow_action_ref");

    expect(() =>
      renderReviewRouterReusableWorkflow({
        actionRef: "777genius/review-router@feature/evil",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_reusable_workflow_runtime_ref");
  });
});

function workflowFileContent(
  file: ReturnType<typeof renderReviewRouterWorkflowFiles>[number] | undefined,
): string {
  return file && file.operation !== "delete" ? file.content : "";
}
