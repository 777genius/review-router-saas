"use client";

import { useRouter } from "next/navigation";
import { useTransition, type ReactElement } from "react";
import { Button } from "@reviewrouter/ui";
import {
  confirmSetupPullRequestMergedClientAction,
  createSetupPullRequestClientAction,
} from "./actions";

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
  const disabled =
    !mutationsEnabled || !selected || archived || workflowCurrent || isPending;

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
              router.replace(buildDashboardMutationUrl(params), {
                scroll: false,
              });
            })
            .catch(() => {
              if (onComplete) {
                onComplete({
                  error: "dashboard_action_failed",
                  workspace: workspaceId,
                  section: "repositories",
                });
                return;
              }
              router.replace(
                buildDashboardMutationUrl({
                  error: "dashboard_action_failed",
                  workspace: workspaceId,
                  section: "repositories",
                }),
                { scroll: false },
              );
            });
        });
      }}
      className="min-w-0"
    >
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
  const disabled = !mutationsEnabled || !selected || archived || isPending;

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
              router.replace(buildDashboardMutationUrl(params), {
                scroll: false,
              });
            })
            .catch(() => {
              if (onComplete) {
                onComplete({
                  error: "dashboard_action_failed",
                  workspace: workspaceId,
                  section: "repositories",
                });
                return;
              }
              router.replace(
                buildDashboardMutationUrl({
                  error: "dashboard_action_failed",
                  workspace: workspaceId,
                  section: "repositories",
                }),
                { scroll: false },
              );
            });
        });
      }}
      className="min-w-0"
    >
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

function buildDashboardMutationUrl(params: Record<string, string>): string {
  const search = new URLSearchParams(window.location.search);

  search.delete("notice");
  search.delete("error");
  search.delete("pr");

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      search.set(key, value);
    }
  }

  return `/dashboard?${search.toString()}${window.location.hash}`;
}
