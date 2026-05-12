import type { RepositoryHealthStatus } from "@reviewrouter/features-repo-health";
import { describeRepositoryHealth } from "./repository-health-view";

export type RepositorySetupStatus =
  | "not_configured"
  | "setup_pr_open"
  | "configured"
  | "needs_attention";

export type RepositorySearchFilter =
  | "all"
  | "private"
  | "public"
  | "needs_setup"
  | "needs_attention"
  | "ready";
export type RepositorySearchReadiness =
  | "ready"
  | "needs_setup"
  | "needs_attention";

export type RepositorySetupStep = 1 | 2 | 3 | 4;

export function buildRepositorySearchText({
  fullName,
  owner,
  name,
  defaultBranch,
  visibility,
  stargazersCount,
  archived,
  selected,
  setupStatus,
  healthStatus,
  healthSummary,
}: {
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly visibility: string;
  readonly stargazersCount: number;
  readonly archived: boolean;
  readonly selected: boolean;
  readonly setupStatus: string;
  readonly healthStatus: RepositoryHealthStatus | undefined;
  readonly healthSummary?: string | null | undefined;
}): string {
  const setupView = describeRepositorySetup(setupStatus, healthStatus);
  const healthView = describeRepositoryHealth(healthStatus, healthSummary);

  return [
    fullName,
    owner,
    name,
    defaultBranch,
    visibility,
    `${stargazersCount} stars`,
    archived ? "archived" : "active",
    selected ? "selected" : "not selected unselected",
    setupStatus,
    setupView.label,
    setupView.hint ?? "",
    healthView.label,
    healthView.summary,
    healthView.nextAction,
  ]
    .join(" ")
    .toLowerCase();
}

export function repositoryMatchesSearchFilter(
  row: {
    readonly repository: { readonly visibility: string };
    readonly readiness: RepositorySearchReadiness;
  },
  filter: RepositorySearchFilter,
): boolean {
  switch (filter) {
    case "private":
      return row.repository.visibility === "private";
    case "public":
      return row.repository.visibility === "public";
    case "needs_setup":
      return row.readiness === "needs_setup";
    case "needs_attention":
      return row.readiness === "needs_attention";
    case "ready":
      return row.readiness === "ready";
    case "all":
      return true;
  }
}

export function tokenizeRepositorySearch(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function repositorySetupProgressStep({
  setupStatus,
  healthStatus,
  workflowCurrent,
  providerSetupConfirmed,
}: {
  readonly setupStatus: string;
  readonly healthStatus: string | undefined;
  readonly workflowCurrent: boolean;
  readonly providerSetupConfirmed: boolean;
}): RepositorySetupStep {
  if (healthStatus === "healthy") return 4;
  if (workflowCurrent && providerSetupConfirmed) return 4;
  if (workflowCurrent) return 3;
  if (setupStatus === "setup_pr_open" || healthStatus === "setup_pr_open") {
    return 2;
  }

  return 1;
}

export function repositorySearchReadiness({
  setupProgressStep,
  healthStatus,
}: {
  readonly setupProgressStep: RepositorySetupStep;
  readonly healthStatus: RepositoryHealthStatus | undefined;
}): RepositorySearchReadiness {
  const healthView = describeRepositoryHealth(healthStatus);
  if (healthView.tone === "danger") return "needs_attention";
  return setupProgressStep === 4 ? "ready" : "needs_setup";
}

export function workflowSetupAlreadyCurrent(
  status: string | undefined,
): boolean {
  return [
    "healthy",
    "provider_needs_setup",
    "provider_unhealthy",
    "provider_report_stale",
  ].includes(status ?? "");
}

export function describeRepositorySetup(
  setupStatus: string,
  healthStatus: string | undefined,
): {
  readonly label: string;
  readonly tone: "success" | "warning" | "danger" | "neutral";
  readonly hint: string | null;
} {
  if (healthStatus === "missing_workflow") {
    return {
      label: "Setup PR needed",
      tone: "warning",
      hint: "Workflow is not on the default branch yet.",
    };
  }

  switch (setupStatus) {
    case "not_configured":
      return {
        label: "No setup PR",
        tone: "neutral",
        hint: "Create and merge the setup PR first.",
      };
    case "setup_pr_open":
      return {
        label: "Setup PR open",
        tone: "warning",
        hint: "Merge it to install the workflow.",
      };
    case "configured":
      return {
        label: "Setup recorded",
        tone: "success",
        hint: null,
      };
    case "needs_attention":
      return {
        label: "Needs attention",
        tone: "danger",
        hint: "Fix the setup error, then retry.",
      };
    default:
      return {
        label: setupStatus.replaceAll("_", " "),
        tone: "neutral",
        hint: null,
      };
  }
}
