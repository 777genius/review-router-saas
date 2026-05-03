import { describe, expect, it } from "vitest";
import { evaluateRepositoryHealth } from "../domain/repository-health";

describe("repository health", () => {
  it("detects setup and workflow version states", () => {
    expect(
      evaluateRepositoryHealth({
        repositoryId: "repo_1",
        fullName: "777genius/example",
        setupStatus: "not_configured",
        expectedActionRef: "777genius/review-router@v1",
      }),
    ).toMatchObject({ status: "missing_workflow" });

    expect(
      evaluateRepositoryHealth({
        repositoryId: "repo_1",
        fullName: "777genius/example",
        setupStatus: "configured",
        expectedActionRef: "777genius/review-router@v1",
        workflowYaml: "uses: 777genius/review-router@v0",
      }),
    ).toMatchObject({ status: "version_mismatch" });
  });

  it("surfaces provider setup and runtime health", () => {
    expect(
      evaluateRepositoryHealth({
        repositoryId: "repo_1",
        fullName: "777genius/example",
        setupStatus: "configured",
        expectedActionRef: "777genius/review-router@v1",
        latestProviderSetupState: "missing",
      }),
    ).toMatchObject({ status: "provider_needs_setup" });

    expect(
      evaluateRepositoryHealth({
        repositoryId: "repo_1",
        fullName: "777genius/example",
        setupStatus: "configured",
        expectedActionRef: "777genius/review-router@v1",
        latestProviderSetupState: "configured",
        latestProviderHealth: "failed",
      }),
    ).toMatchObject({ status: "provider_unhealthy" });
  });
});
