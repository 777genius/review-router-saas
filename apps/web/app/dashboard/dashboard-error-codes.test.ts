import { describe, expect, it } from "vitest";
import { safeDashboardErrorCode } from "./dashboard-error-codes";

describe("safeDashboardErrorCode", () => {
  it.each([
    ["github_api_error:403", "github_operation_forbidden"],
    ["github_api_error:404", "github_operation_not_found"],
    ["github_api_error:409", "github_operation_conflict"],
    ["github_api_error:422", "github_validation_failed"],
    ["github_api_error:503", "github_service_unavailable"],
    ["github_api_error:418", "github_operation_failed"],
  ])("maps stored GitHub API summary %s to %s", (message, expectedCode) => {
    expect(safeDashboardErrorCode(new Error(message))).toBe(expectedCode);
  });

  it.each([
    [403, "github_operation_forbidden"],
    [404, "github_operation_not_found"],
    [409, "github_operation_conflict"],
    [422, "github_validation_failed"],
    [502, "github_service_unavailable"],
  ])("maps live GitHub HTTP status %s to %s", (status, expectedCode) => {
    const error = Object.assign(new Error("GitHub request failed"), { status });

    expect(safeDashboardErrorCode(error)).toBe(expectedCode);
  });

  it("keeps existing safe dashboard codes unchanged", () => {
    expect(safeDashboardErrorCode(new Error("setup_pr_branch_deleted"))).toBe(
      "setup_pr_branch_deleted",
    );
    expect(
      safeDashboardErrorCode(new Error("codex_rotating_not_enabled")),
    ).toBe("codex_rotating_not_enabled");
    expect(
      safeDashboardErrorCode(
        new Error("codex_rotating_repository_scope_required"),
      ),
    ).toBe("codex_rotating_repository_scope_required");
    expect(
      safeDashboardErrorCode(
        new Error("codex_rotating_single_provider_required"),
      ),
    ).toBe("codex_rotating_single_provider_required");
    expect(
      safeDashboardErrorCode(
        new Error("codex_rotating_provider_instance_required"),
      ),
    ).toBe("codex_rotating_provider_instance_required");
    expect(
      safeDashboardErrorCode(new Error("codex_legacy_auth_requires_reconnect")),
    ).toBe("codex_legacy_auth_requires_reconnect");
    expect(safeDashboardErrorCode(new Error("rate_limit_exceeded:setup"))).toBe(
      "rate_limited",
    );
  });

  it.each([
    "codex_rotating_action_ref_invalid",
    "codex_rotating_action_ref_must_be_full_sha",
    "codex_rotating_conflict_review_unsupported",
  ])(
    "maps Codex deployment setup error %s to server_misconfigured",
    (message) => {
      expect(safeDashboardErrorCode(new Error(message))).toBe(
        "server_misconfigured",
      );
    },
  );
});
