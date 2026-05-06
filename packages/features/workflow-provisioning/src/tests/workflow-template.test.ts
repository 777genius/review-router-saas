import { describe, expect, it } from "vitest";
import {
  defaultInteractionWorkflowPath,
  defaultRequiredWorkflowPath,
  defaultWorkflowPath,
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
  staticRuntimeEnv: {
    REVIEW_AUTH_MODE: "codex-oauth",
    CODEX_MODEL: "gpt-5.5",
  },
};

describe("renderReviewRouterWorkflow", () => {
  it("renders a review-only pull request workflow", () => {
    const workflow = renderReviewRouterWorkflow(workflowOptions);

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
  });

  it("renders compact reusable caller workflows by default", () => {
    const reviewWorkflow = renderReviewRouterReusableWorkflow(workflowOptions);
    const interactionWorkflow =
      renderReviewRouterReusableInteractionWorkflow(workflowOptions);

    expect(reviewWorkflow).toContain("pull_request:");
    expect(reviewWorkflow).toContain("workflow_dispatch:");
    expect(reviewWorkflow).toContain("id-token: write");
    expect(reviewWorkflow).toContain(
      "uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1",
    );
    expect(reviewWorkflow).toContain("runtime_ref: v1");
    expect(reviewWorkflow).toContain('api_url: "https://app.reviewrouter.dev"');
    expect(reviewWorkflow).toContain("runtime_config_mode: oidc");
    expect(reviewWorkflow).toContain(
      'static_runtime_env_json: >-\n        {"REVIEW_AUTH_MODE":"codex-oauth","CODEX_MODEL":"gpt-5.5"}',
    );
    expect(reviewWorkflow).toContain(
      "CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
    );
    expect(reviewWorkflow).toContain(
      "REVIEW_ROUTER_LEDGER_KEY: ${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}",
    );
    expect(reviewWorkflow).not.toContain("pull_request_target");
    expect(reviewWorkflow).not.toContain("actions/setup-node@v6");

    expect(interactionWorkflow).toContain("pull_request_review_comment:");
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
    });

    expect(files[0]?.content).toContain("uses: 777genius/review-router@v1");
    expect(files[0]?.content).toContain("actions/setup-node@v6");
    expect(files[0]?.content).not.toContain(
      ".github/workflows/reviewrouter-reusable.yml",
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
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("uses: 777genius/review-router@v1");
    expect(workflow).toContain("github.event_name != 'merge_group'");
    expect(workflow).toContain('REVIEWROUTER_COMMENT_TOKEN_MODE: "app-oidc"');
    expect(workflow).toContain(
      "CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
    );
    expect(workflow).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
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
