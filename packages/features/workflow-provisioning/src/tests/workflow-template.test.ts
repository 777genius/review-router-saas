import { describe, expect, it } from "vitest";
import { renderReviewRouterWorkflow } from "../domain/workflow-template";

describe("renderReviewRouterWorkflow", () => {
  it("renders secure pull_request workflow defaults", () => {
    const workflow = renderReviewRouterWorkflow({
      actionRef: "777genius/review-router@v1",
      apiUrl: "https://app.reviewrouter.dev",
      runtimeConfigMode: "oidc",
    });

    expect(workflow).toContain("pull_request:");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain(
      "github.event.pull_request.head.repo.full_name != github.repository",
    );
    expect(workflow).toContain("uses: 777genius/review-router@v1");
  });
});
