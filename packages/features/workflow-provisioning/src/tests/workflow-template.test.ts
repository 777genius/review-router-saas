import { describe, expect, it } from "vitest";
import { renderReviewRouterWorkflow } from "../domain/workflow-template";

describe("renderReviewRouterWorkflow", () => {
  it("renders secure pull_request workflow defaults", () => {
    const workflow = renderReviewRouterWorkflow({
      actionRef: "777genius/review-router@v1",
      apiUrl: "https://app.reviewrouter.dev",
      runtimeConfigMode: "oidc",
      staticRuntimeEnv: {
        REVIEW_AUTH_MODE: "codex-oauth",
        CODEX_MODEL: "gpt-5.5",
      },
    });

    expect(workflow).toContain("pull_request:");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain(
      "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository",
    );
    expect(workflow).toContain(
      "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(workflow).toContain(
      "github.event_name != 'pull_request' || github.event.pull_request.draft == false",
    );
    expect(workflow).toContain("uses: 777genius/review-router@v1");
    expect(workflow).toContain(
      'REVIEWROUTER_API_URL: "https://app.reviewrouter.dev"',
    );
    expect(workflow).toContain('REVIEWROUTER_OIDC_AUDIENCE: "reviewrouter"');
    expect(workflow).toContain('REVIEWROUTER_RUNTIME_CONFIG_MODE: "oidc"');
    expect(workflow).toContain('REVIEW_AUTH_MODE: "codex-oauth"');
    expect(workflow).toContain('CODEX_MODEL: "gpt-5.5"');
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
      renderReviewRouterWorkflow({
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
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "javascript:alert(1)",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_api_url");

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
  });
});
