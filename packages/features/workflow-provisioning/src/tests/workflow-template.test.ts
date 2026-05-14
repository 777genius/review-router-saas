import { describe, expect, it } from "vitest";
import {
  analyzeConflictReviewWorkflowCapability,
  analyzeWorkflowProviderCompatibility,
  defaultInteractionWorkflowPath,
  defaultRequiredWorkflowPath,
  defaultWorkflowPath,
  getWorkflowProviderContentMarkerGroups,
  getWorkflowSetupContentMarkerGroups,
  renderReviewRouterInteractionWorkflow,
  renderReviewRouterReusableInteractionWorkflow,
  renderReviewRouterReusableWorkflow,
  renderReviewRouterRequiredWorkflow,
  renderReviewRouterWorkflow,
  renderReviewRouterWorkflowFiles,
} from "../domain/workflow-template";

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
    expect(workflow).toContain("npm install -g @openai/codex@0.125.0");
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
    expect(workflow).toContain('REVIEW_AUTH_MODE: "codex-oauth"');
    expect(workflow).toContain('CODEX_MODEL: "gpt-5.5"');
  });

  it("renders a separate interaction workflow for /rr commands", () => {
    const workflow = renderReviewRouterInteractionWorkflow(workflowOptions);

    expect(workflow).toContain("name: ReviewRouter Interaction");
    expect(workflow).toContain("pull_request_review_comment:");
    expect(workflow).toContain("issue_comment:");
    expect(workflow).toContain("types: [created, edited]");
    expect(workflow).toContain(
      "github.event_name != 'issue_comment' || github.event.issue.pull_request",
    );
    expect(workflow).not.toContain("pull_request:\n");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).toContain("actions: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).not.toContain("github.event.comment.user.type != 'Bot'");
    expect(workflow).not.toContain(
      "startsWith(github.event.comment.body, '/rr ')",
    );
    expect(workflow).toContain("Preflight ReviewRouter interaction");
    expect(workflow).toContain('REVIEW_ROUTER_MODE: "interaction-preflight"');
    expect(workflow).toContain("steps.preflight.outputs.should_run == 'true'");
    expect(workflow).toContain('REVIEW_ROUTER_MODE: "interaction"');
    expect(workflow).not.toContain("REVIEW_ROUTER_THREAD_RESOLVE_TOKEN");
    expect(workflow).toContain(
      'REVIEW_ROUTER_REVIEW_WORKFLOW_FILE: "reviewrouter.yml"',
    );
    expect(workflow).toContain('REVIEWROUTER_COMMENT_TOKEN_MODE: "app-oidc"');
  });

  it("returns both workflow files for setup PR provisioning", () => {
    const files = renderReviewRouterWorkflowFiles(workflowOptions);

    expect(files.map((file) => file.path)).toEqual([
      defaultWorkflowPath,
      defaultInteractionWorkflowPath,
    ]);
    const [reviewWorkflow, interactionWorkflow] = files;
    expect(reviewWorkflow?.content).toContain("name: ReviewRouter");
    expect(reviewWorkflow?.content).toContain(
      "uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1",
    );
    expect(reviewWorkflow?.content).not.toContain(
      "pull_request_review_comment:",
    );
    expect(interactionWorkflow?.content).toContain(
      "name: ReviewRouter Interaction",
    );
    expect(interactionWorkflow?.content).toContain(
      "uses: 777genius/review-router/.github/workflows/reviewrouter-interaction-reusable.yml@v1",
    );
    expect(interactionWorkflow?.content).toContain(
      "review_workflow_file: reviewrouter.yml",
    );
    expect(interactionWorkflow?.content).toContain(
      "pull_request_review_comment:",
    );
    expect(interactionWorkflow?.content).toContain("issue_comment:");
    expect(interactionWorkflow?.content).toContain(
      "github.event_name != 'issue_comment' || github.event.issue.pull_request",
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
      "uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1",
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
    expect(conflictReviewJob).toContain("conflict_dispatch_id:");
    expect(conflictReviewJob).toContain("conflict_dispatch_nonce:");
    expect(conflictReviewJob).toContain("conflict_head_sha:");
    expect(conflictReviewJob).toContain("conflict_base_ref:");
    expect(conflictReviewJob).toContain("conflict_base_sha:");
    expect(reviewWorkflow).toContain(
      [
        "static_runtime_env_json: |-",
        "        {",
        '          "REVIEW_AUTH_MODE": "codex-oauth",',
        '          "CODEX_MODEL": "gpt-5.5"',
        "        }",
      ].join("\n"),
    );
    expect(reviewWorkflow).toContain(
      "CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
    );
    expect(reviewWorkflow).toContain(
      "CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    );
    expect(reviewWorkflow).toContain(
      "REVIEW_ROUTER_LEDGER_KEY: ${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}",
    );
    expect(reviewWorkflow).not.toContain("pull_request_target");
    expect(reviewWorkflow).not.toContain("actions/setup-node@v6");

    expect(interactionWorkflow).toContain("pull_request_review_comment:");
    expect(interactionWorkflow).toContain("issue_comment:");
    expect(interactionWorkflow).toContain("types: [created, edited]");
    expect(interactionWorkflow).toContain(
      "github.event_name != 'issue_comment' || github.event.issue.pull_request",
    );
    expect(interactionWorkflow).toContain("actions: write");
    expect(interactionWorkflow).toContain(
      "uses: 777genius/review-router/.github/workflows/reviewrouter-interaction-reusable.yml@v1",
    );
    expect(interactionWorkflow).toContain(
      "REVIEW_ROUTER_LEDGER_KEY: ${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}",
    );
    expect(interactionWorkflow).not.toContain("pull_request_target");
  });

  it("keeps explicit workflow rendering available for debug fallback", () => {
    const files = renderReviewRouterWorkflowFiles({
      ...workflowOptions,
      workflowStyle: "explicit",
      conflictReviewFallbackEnabled: false,
    });

    expect(files[0]?.content).toContain("uses: 777genius/review-router@v1");
    expect(files[0]?.content).toContain("actions/setup-node@v6");
    expect(files[0]?.content).not.toContain(
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

  it("exports Claude workflow marker groups for readiness probes", () => {
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
        "repository_dispatch:",
        "types: [reviewrouter_conflict_review]",
        "conflict-review:",
        "github.event_name == 'repository_dispatch'",
        "github.event.action == 'reviewrouter_conflict_review'",
        "review_kind: conflict-head",
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
        "repository_dispatch:",
        "types: [reviewrouter_conflict_review]",
        "conflict-review:",
        "github.event_name == 'repository_dispatch'",
        "github.event.action == 'reviewrouter_conflict_review'",
        "review_kind: conflict-head",
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
          ".github/workflows/reviewrouter-reusable.yml@v1",
          ".github/workflows/reviewrouter-reusable.yml@main",
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
            "    uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1",
          ].join("\n"),
          [
            "    permissions:",
            "      contents: read",
            "      pull-requests: write",
            "      id-token: write",
            "    uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1",
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
