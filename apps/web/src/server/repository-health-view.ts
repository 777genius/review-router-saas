import type { RepositoryHealthStatus } from "@reviewrouter/features-repo-health";

export type RepositoryHealthTone = "success" | "warning" | "danger" | "neutral";

export type RepositoryHealthView = {
  readonly tone: RepositoryHealthTone;
  readonly label: string;
  readonly summary: string;
  readonly nextAction: string;
  readonly blocksReview: boolean;
};

export type WorkspaceHealthSummary = {
  readonly ready: number;
  readonly needsSetup: number;
  readonly needsAttention: number;
  readonly unknown: number;
  readonly label: string;
  readonly tone: RepositoryHealthTone;
};

export function describeRepositoryHealth(
  status: RepositoryHealthStatus | undefined,
  rawSummary?: string | null,
): RepositoryHealthView {
  const fallbackSummary = cleanSummary(rawSummary) ?? "No health data yet";

  switch (status) {
    case "healthy":
      return {
        tone: "success",
        label: "Ready",
        summary:
          rawSummary === "Ready" || !rawSummary
            ? "Workflow is installed and ready for PR review."
            : fallbackSummary,
        nextAction: "Open or update a pull request to trigger ReviewRouter.",
        blocksReview: false,
      };
    case "setup_pr_open":
      return {
        tone: "warning",
        label: "Setup PR open",
        summary:
          "The workflow setup pull request exists but is not on the default branch yet.",
        nextAction:
          "Open and merge the setup PR, then rerun repository health.",
        blocksReview: true,
      };
    case "missing_workflow":
      return {
        tone: "warning",
        label: "Workflow missing",
        summary: fallbackSummary,
        nextAction:
          "Create or update the setup PR and merge it into the default branch.",
        blocksReview: true,
      };
    case "version_mismatch":
      return {
        tone: "warning",
        label: "Update needed",
        summary: fallbackSummary,
        nextAction:
          "Create or update the setup PR so the repo uses the expected action version.",
        blocksReview: false,
      };
    case "workflow_check_unavailable":
      return {
        tone: "neutral",
        label: "Check unavailable",
        summary:
          "ReviewRouter could not read the workflow file through the GitHub App.",
        nextAction:
          "Check GitHub App repository selection, permissions, and API rate limits.",
        blocksReview: false,
      };
    case "provider_needs_setup":
      return {
        tone: "warning",
        label: "Provider setup needed",
        summary: fallbackSummary,
        nextAction:
          "Seed Codex OAuth or API-key secrets directly into GitHub Actions.",
        blocksReview: true,
      };
    case "provider_unhealthy":
      return {
        tone: "danger",
        label: "Provider unhealthy",
        summary: fallbackSummary,
        nextAction:
          "Open the latest Actions run and reseed credentials if Codex/API auth failed.",
        blocksReview: true,
      };
    case "provider_report_stale":
      return {
        tone: "warning",
        label: "No recent run",
        summary: fallbackSummary,
        nextAction:
          "Open or update a PR, or run the workflow manually to refresh health.",
        blocksReview: false,
      };
    case "needs_attention":
      return {
        tone: "danger",
        label: "Needs attention",
        summary: fallbackSummary,
        nextAction:
          "Review the setup error below, then retry the setup PR after fixing permissions/config.",
        blocksReview: true,
      };
    case undefined:
      return {
        tone: "neutral",
        label: "Unknown",
        summary: fallbackSummary,
        nextAction:
          "Refresh repositories or run a setup PR to collect health data.",
        blocksReview: false,
      };
  }
}

export function summarizeWorkspaceHealth(
  statuses: readonly (RepositoryHealthStatus | undefined)[],
): WorkspaceHealthSummary {
  const counts = statuses.reduce(
    (accumulator, status) => {
      const view = describeRepositoryHealth(status);
      if (view.tone === "success") accumulator.ready += 1;
      else if (view.tone === "danger") accumulator.needsAttention += 1;
      else if (view.tone === "warning") accumulator.needsSetup += 1;
      else accumulator.unknown += 1;
      return accumulator;
    },
    { ready: 0, needsSetup: 0, needsAttention: 0, unknown: 0 },
  );

  if (statuses.length === 0) {
    return {
      ...counts,
      label: "No repositories synced",
      tone: "neutral",
    };
  }
  if (counts.needsAttention > 0) {
    return {
      ...counts,
      label: `${counts.needsAttention} need attention`,
      tone: "danger",
    };
  }
  if (counts.needsSetup > 0) {
    return {
      ...counts,
      label: `${counts.needsSetup} need setup`,
      tone: "warning",
    };
  }
  if (counts.ready > 0 && counts.unknown === 0) {
    return {
      ...counts,
      label: "All synced repos ready",
      tone: "success",
    };
  }
  return {
    ...counts,
    label: `${counts.ready} ready, ${counts.unknown} unknown`,
    tone: "neutral",
  };
}

function cleanSummary(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
