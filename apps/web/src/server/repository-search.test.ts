import { describe, expect, it } from "vitest";
import {
  repositoryMatchesSearchFilter,
  repositorySetupProgressStep,
  repositorySearchReadiness,
} from "./repository-search";

describe("repositorySetupProgressStep", () => {
  it("keeps setup recovery on the first step even if health is stale", () => {
    expect(
      repositorySetupProgressStep({
        setupStatus: "needs_attention",
        healthStatus: "setup_pr_open",
        workflowCurrent: false,
        providerSetupConfirmed: false,
        setupNeedsAttention: true,
      }),
    ).toBe(1);
  });

  it("does not let generic needs-attention hide an already current workflow", () => {
    expect(
      repositorySetupProgressStep({
        setupStatus: "needs_attention",
        healthStatus: "provider_needs_setup",
        workflowCurrent: true,
        providerSetupConfirmed: false,
      }),
    ).toBe(3);
  });
});

describe("repositorySearchReadiness", () => {
  it("treats completed setup without provider danger as ready", () => {
    expect(
      repositorySearchReadiness({
        setupProgressStep: 4,
        healthStatus: "provider_report_stale",
      }),
    ).toBe("ready");
  });

  it("keeps provider-danger repositories out of the ready filter", () => {
    expect(
      repositorySearchReadiness({
        setupProgressStep: 4,
        healthStatus: "provider_unhealthy",
      }),
    ).toBe("needs_attention");
  });

  it("keeps provider setup blockers out of the ready filter", () => {
    expect(
      repositorySearchReadiness({
        setupProgressStep: 4,
        healthStatus: "provider_needs_setup",
      }),
    ).toBe("needs_setup");
  });

  it("uses the same readiness bucket for ready and needs-setup filters", () => {
    expect(
      repositoryMatchesSearchFilter(
        { repository: { visibility: "public" }, readiness: "ready" },
        "ready",
      ),
    ).toBe(true);
    expect(
      repositoryMatchesSearchFilter(
        { repository: { visibility: "public" }, readiness: "needs_setup" },
        "ready",
      ),
    ).toBe(false);
    expect(
      repositoryMatchesSearchFilter(
        { repository: { visibility: "public" }, readiness: "needs_setup" },
        "needs_setup",
      ),
    ).toBe(true);
    expect(
      repositoryMatchesSearchFilter(
        { repository: { visibility: "public" }, readiness: "needs_attention" },
        "needs_attention",
      ),
    ).toBe(true);
    expect(
      repositoryMatchesSearchFilter(
        { repository: { visibility: "public" }, readiness: "needs_attention" },
        "needs_setup",
      ),
    ).toBe(false);
  });
});
