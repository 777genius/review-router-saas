export type RepositoryHealthStatus =
  | "healthy"
  | "setup_pr_open"
  | "missing_workflow"
  | "version_mismatch"
  | "workflow_check_unavailable"
  | "provider_needs_setup"
  | "provider_unhealthy"
  | "needs_attention";

export type RepositoryWorkflowCheck =
  | { readonly status: "present"; readonly expectedActionRefFound: boolean }
  | { readonly status: "missing" }
  | { readonly status: "unavailable"; readonly reason: string };

export type RepositoryHealthInput = {
  readonly repositoryId: string;
  readonly fullName: string;
  readonly owner?: string;
  readonly name?: string;
  readonly defaultBranch?: string;
  readonly githubInstallationId?: string;
  readonly setupStatus:
    | "not_configured"
    | "setup_pr_open"
    | "configured"
    | "needs_attention";
  readonly expectedActionRef: string;
  readonly workflowCheck?: RepositoryWorkflowCheck;
  readonly workflowYaml?: string | null;
  readonly latestProviderHealth?:
    | "ok"
    | "skipped"
    | "failed"
    | "degraded"
    | null;
  readonly latestProviderSetupState?:
    | "unknown"
    | "missing"
    | "configured"
    | "stale_or_invalid"
    | "unavailable_in_fork_pr"
    | null;
};

export type RepositoryHealthSnapshot = {
  readonly repositoryId: string;
  readonly fullName: string;
  readonly status: RepositoryHealthStatus;
  readonly summary: string;
  readonly checkedAt: Date;
};

export function evaluateRepositoryHealth(
  input: RepositoryHealthInput,
  checkedAt = new Date(),
): RepositoryHealthSnapshot {
  if (input.setupStatus === "needs_attention") {
    return snapshot(
      input,
      "needs_attention",
      "Setup needs attention",
      checkedAt,
    );
  }
  if (input.setupStatus === "setup_pr_open") {
    return snapshot(
      input,
      "setup_pr_open",
      "Setup pull request is open",
      checkedAt,
    );
  }
  if (input.setupStatus === "not_configured") {
    return snapshot(
      input,
      "missing_workflow",
      "ReviewRouter workflow is not configured",
      checkedAt,
    );
  }
  if (input.workflowCheck?.status === "missing") {
    return snapshot(
      input,
      "missing_workflow",
      "ReviewRouter workflow file is missing from the default branch",
      checkedAt,
    );
  }
  if (
    input.workflowCheck?.status === "present" &&
    !input.workflowCheck.expectedActionRefFound
  ) {
    return snapshot(
      input,
      "version_mismatch",
      "Workflow does not use the expected ReviewRouter action version",
      checkedAt,
    );
  }
  if (input.workflowCheck?.status === "unavailable") {
    return snapshot(
      input,
      "workflow_check_unavailable",
      "Workflow file could not be checked from GitHub",
      checkedAt,
    );
  }
  if (input.workflowYaml !== undefined && input.workflowYaml !== null) {
    if (!input.workflowYaml.includes(input.expectedActionRef)) {
      return snapshot(
        input,
        "version_mismatch",
        "Workflow does not use the expected ReviewRouter action version",
        checkedAt,
      );
    }
  }
  if (
    input.latestProviderSetupState === "missing" ||
    input.latestProviderSetupState === "stale_or_invalid"
  ) {
    return snapshot(
      input,
      "provider_needs_setup",
      "Provider credentials need setup",
      checkedAt,
    );
  }
  if (
    input.latestProviderHealth === "failed" ||
    input.latestProviderHealth === "degraded"
  ) {
    return snapshot(
      input,
      "provider_unhealthy",
      "Latest action run reported provider issues",
      checkedAt,
    );
  }

  return snapshot(input, "healthy", "Ready", checkedAt);
}

function snapshot(
  input: RepositoryHealthInput,
  status: RepositoryHealthStatus,
  summary: string,
  checkedAt: Date,
): RepositoryHealthSnapshot {
  return {
    repositoryId: input.repositoryId,
    fullName: input.fullName,
    status,
    summary,
    checkedAt,
  };
}
