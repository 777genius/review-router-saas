import { describe, expect, it } from "vitest";
import {
  describeRepositoryHealth,
  summarizeWorkspaceHealth,
} from "./repository-health-view";

describe("repository health view", () => {
  it("turns raw health statuses into actionable tester copy", () => {
    expect(describeRepositoryHealth("healthy")).toMatchObject({
      tone: "success",
      label: "Ready",
      blocksReview: false,
    });
    expect(describeRepositoryHealth("provider_needs_setup")).toMatchObject({
      tone: "warning",
      label: "Provider setup needed",
      nextAction:
        "Seed Codex, Claude Code, OpenAI, or OpenRouter secrets directly into GitHub Actions.",
      blocksReview: true,
    });
    expect(describeRepositoryHealth("provider_unhealthy")).toMatchObject({
      tone: "danger",
      label: "Provider unhealthy",
      blocksReview: true,
    });
    expect(describeRepositoryHealth(undefined)).toMatchObject({
      tone: "neutral",
      label: "Unknown",
      blocksReview: false,
    });
  });

  it("preserves safe domain summaries when they add useful context", () => {
    expect(
      describeRepositoryHealth(
        "missing_workflow",
        "ReviewRouter workflow file is missing from the default branch",
      ),
    ).toMatchObject({
      summary: "ReviewRouter workflow file is missing from the default branch",
      nextAction:
        "Create or update the setup PR and merge it into its target branch.",
    });
  });

  it("summarizes workspace readiness without hiding blocking states", () => {
    expect(summarizeWorkspaceHealth([])).toMatchObject({
      tone: "neutral",
      label: "No repositories synced",
    });
    expect(
      summarizeWorkspaceHealth(["healthy", "provider_report_stale"]),
    ).toMatchObject({
      tone: "warning",
      label: "1 need setup",
      ready: 1,
      needsSetup: 1,
    });
    expect(
      summarizeWorkspaceHealth(["healthy", "provider_unhealthy"]),
    ).toMatchObject({
      tone: "danger",
      label: "1 need attention",
      ready: 1,
      needsAttention: 1,
    });
    expect(summarizeWorkspaceHealth(["healthy"])).toMatchObject({
      tone: "success",
      label: "All synced repos ready",
    });
  });
});
