import { describe, expect, it } from "vitest";
import {
  repositoryMatchesSearchFilter,
  repositorySearchReadiness,
} from "./repository-search";

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
