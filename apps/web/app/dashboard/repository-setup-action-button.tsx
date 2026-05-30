"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactElement } from "react";
import { Button } from "@reviewrouter/ui";
import { ActionToast } from "../action-toast";
import { dashboardErrorText } from "./dashboard-copy";
import {
  confirmSetupPullRequestMergedClientAction,
  createSetupPullRequestClientAction,
} from "./actions";

type SetupActionToast = {
  readonly key: number;
  readonly tone: "success" | "warning" | "danger" | "accent";
  readonly title: string;
  readonly body: string;
  readonly actionUrl?: string;
  readonly actionLabel?: string;
};

export function RepositorySetupActionButton({
  workspaceId,
  repositoryId,
  selected,
  archived,
  setupStatus,
  workflowCurrent,
  mutationsEnabled,
  variant = "solid",
  onComplete,
}: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly selected: boolean;
  readonly archived: boolean;
  readonly setupStatus: string;
  readonly workflowCurrent: boolean;
  readonly mutationsEnabled: boolean;
  readonly variant?: "solid" | "soft" | "outline" | "ghost";
  readonly onComplete?: (params: Record<string, string>) => void;
}): ReactElement {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<SetupActionToast | null>(null);
  const disabled =
    !mutationsEnabled || !selected || archived || workflowCurrent || isPending;

  function completeWithoutUrl(params: Record<string, string>): void {
    setToast((current) => ({
      ...setupActionToast(params),
      key: (current?.key ?? 0) + 1,
    }));
    cleanDashboardActionUrl("repositories");
    router.refresh();
  }

  return (
    <form
      action={(formData) => {
        startTransition(() => {
          void createSetupPullRequestClientAction(formData)
            .then(({ params }) => {
              if (onComplete) {
                onComplete(params);
                return;
              }
              completeWithoutUrl(params);
            })
            .catch(() => {
              const fallbackParams = {
                error: "dashboard_action_stale",
                workspace: workspaceId,
                section: "repositories",
              };
              if (onComplete) {
                onComplete(fallbackParams);
                return;
              }
              completeWithoutUrl(fallbackParams);
            });
        });
      }}
      className="min-w-0"
    >
      {toast ? (
        <ActionToast
          key={toast.key}
          tone={toast.tone}
          title={toast.title}
          body={toast.body}
          actionUrl={toast.actionUrl}
          actionLabel={toast.actionLabel}
        />
      ) : null}
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="repositoryId" value={repositoryId} />
      <input type="hidden" name="workflowStyle" value="reusable" />
      <Button
        type="submit"
        variant={variant}
        size="sm"
        className="min-h-11 w-full min-w-0 rounded-lg px-3 sm:w-auto sm:min-w-[9.5rem] sm:px-5"
        disabled={disabled}
        aria-busy={isPending}
      >
        {isPending ? (
          <span className="inline-flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
            />
            <span>
              {setupStatus === "setup_pr_open"
                ? "Updating setup PR..."
                : setupStatus === "needs_attention"
                  ? "Recreating setup PR..."
                  : "Creating setup PR..."}
            </span>
          </span>
        ) : workflowCurrent ? (
          "Installed"
        ) : (
          <>
            <SetupPrIcon />
            {setupPrButtonLabel(setupStatus)}
          </>
        )}
      </Button>
    </form>
  );
}

export function RepositorySetupMergedButton({
  workspaceId,
  repositoryId,
  selected,
  archived,
  mutationsEnabled,
  onComplete,
}: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly selected: boolean;
  readonly archived: boolean;
  readonly mutationsEnabled: boolean;
  readonly onComplete?: (params: Record<string, string>) => void;
}): ReactElement {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<SetupActionToast | null>(null);
  const disabled = !mutationsEnabled || !selected || archived || isPending;

  function completeWithoutUrl(params: Record<string, string>): void {
    setToast((current) => ({
      ...setupActionToast(params),
      key: (current?.key ?? 0) + 1,
    }));
    cleanDashboardActionUrl("repositories");
    router.refresh();
  }

  return (
    <form
      action={(formData) => {
        startTransition(() => {
          void confirmSetupPullRequestMergedClientAction(formData)
            .then(({ params }) => {
              if (onComplete) {
                onComplete(params);
                return;
              }
              completeWithoutUrl(params);
            })
            .catch(() => {
              const fallbackParams = {
                error: "dashboard_action_stale",
                workspace: workspaceId,
                section: "repositories",
              };
              if (onComplete) {
                onComplete(fallbackParams);
                return;
              }
              completeWithoutUrl(fallbackParams);
            });
        });
      }}
      className="min-w-0"
    >
      {toast ? (
        <ActionToast
          key={toast.key}
          tone={toast.tone}
          title={toast.title}
          body={toast.body}
          actionUrl={toast.actionUrl}
          actionLabel={toast.actionLabel}
        />
      ) : null}
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="repositoryId" value={repositoryId} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        className="min-h-9 w-full min-w-0 rounded-lg border border-cyan-300/20 bg-cyan-300/[0.035] px-3 text-xs sm:w-auto"
        disabled={disabled}
        aria-busy={isPending}
      >
        {isPending ? (
          <span className="inline-flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent"
            />
            Checking...
          </span>
        ) : (
          "I merged it"
        )}
      </Button>
    </form>
  );
}

function SetupPrIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0"
      fill="none"
    >
      <path
        d="M4 2.5h5l3 3v8H4z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M9 2.5V6h3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M8 8.3v3.2M6.4 9.9h3.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function setupPrButtonLabel(setupStatus: string): string {
  if (setupStatus === "setup_pr_open") return "Update setup PR";
  if (setupStatus === "needs_attention") return "Recreate setup PR";
  return "Create setup PR";
}

function setupActionToast(
  params: Record<string, string>,
): Omit<SetupActionToast, "key"> {
  if (params.error) {
    return {
      tone: "danger",
      title: "Action needs attention",
      body: setupActionErrorText(params.error),
    };
  }

  switch (params.notice) {
    case "setup_pr_ready":
      return {
        tone: "success",
        title: "Setup PR ready",
        body: params.repository
          ? `Setup PR is ready for ${params.repository}.`
          : "Setup PR is ready.",
        ...(params.pr ? { actionUrl: params.pr } : {}),
        ...(params.pr ? { actionLabel: "Open setup PR" } : {}),
      };
    case "setup_pr_merged":
      return {
        tone: "success",
        title: "Setup PR merged",
        body: params.repository
          ? `Setup PR merge was confirmed for ${params.repository}.`
          : "Setup PR merge was confirmed.",
      };
    case "workflow_already_current":
      return {
        tone: "success",
        title: "Workflow installed",
        body: params.repository
          ? `ReviewRouter workflow is already current for ${params.repository}.`
          : "ReviewRouter workflow is already current.",
      };
    default:
      return {
        tone: "success",
        title: "Action complete",
        body: "Repository setup was updated.",
      };
  }
}

function setupActionErrorText(error: string): string {
  switch (error) {
    case "dashboard_action_stale":
      return "The dashboard was updated while this page was open. Refresh the page, then click again.";
    case "dashboard_action_failed":
      return "The dashboard action failed. Retry once, then inspect server logs if it repeats.";
    case "setup_pr_not_merged":
      return "GitHub does not show the workflow on the setup PR target branch yet. If you just merged the setup PR, wait a few seconds.";
    case "setup_pr_closed":
      return "The saved setup PR was closed before it was merged. Recreate the setup PR, then merge the new one.";
    case "setup_pr_branch_deleted":
      return "The saved setup PR branch was deleted. Recreate the setup PR to continue.";
    case "setup_pr_wrong_base_branch":
      return "The saved setup PR was merged outside the allowed setup branches. Recreate the setup PR, then merge it into dev, develop, or the repository default branch.";
    case "github_operation_forbidden":
      return "GitHub refused the setup PR update. Check GitHub App Contents, Workflows, and Pull requests write permissions, then retry.";
    case "github_operation_not_found":
      return "GitHub could not find the repository or setup branch. Sync the installation, confirm repository access, then retry.";
    case "github_operation_conflict":
      return "GitHub reported a write conflict while updating the setup PR. Retry once after the current GitHub operation settles.";
    case "github_validation_failed":
      return "GitHub rejected the setup PR update. Check whether the setup PR can be reopened, or delete the setup branch and retry.";
    case "github_service_unavailable":
      return "GitHub is temporarily unavailable for this setup action. Retry after GitHub recovers.";
    case "github_operation_failed":
      return "GitHub did not complete the setup PR action. Check audit events or server logs for the safe error code.";
    case "rate_limited":
      return "Too many dashboard requests for this repository. Wait a bit before retrying.";
    case "repository_not_selected":
      return "This repository is no longer selected for the GitHub App installation.";
    case "repository_archived":
      return "Archived repositories cannot be provisioned.";
    default:
      return dashboardErrorText(error);
  }
}

function cleanDashboardActionUrl(section: string): void {
  const url = new URL(window.location.href);
  let changed = false;

  for (const key of ["notice", "error", "pr"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  if (url.searchParams.get("section") !== section) {
    url.searchParams.set("section", section);
    changed = true;
  }

  if (!changed) return;

  const search = url.searchParams.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${search ? `?${search}` : ""}${url.hash}`,
  );
}
