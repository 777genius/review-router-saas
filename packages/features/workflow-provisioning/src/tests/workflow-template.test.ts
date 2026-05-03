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
      "github.event.pull_request.head.repo.full_name != github.repository",
    );
    expect(workflow).toContain("uses: 777genius/review-router@v1");
    expect(workflow).toContain('REVIEW_AUTH_MODE: "codex-oauth"');
    expect(workflow).toContain('CODEX_MODEL: "gpt-5.5"');
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
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "static",
        staticRuntimeEnv: {
          "BAD_KEY:\n          RUN": "evil",
        },
      }),
    ).toThrow("invalid_workflow_env_key");
  });
});
