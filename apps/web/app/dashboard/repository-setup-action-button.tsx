"use client";

import { useRouter } from "next/navigation";
import { useTransition, type ReactElement } from "react";
import { Button } from "@reviewrouter/ui";
import { createSetupPullRequestClientAction } from "./actions";

export function RepositorySetupActionButton({
  workspaceId,
  repositoryId,
  selected,
  archived,
  setupStatus,
  workflowCurrent,
  mutationsEnabled,
  variant = "solid",
}: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly selected: boolean;
  readonly archived: boolean;
  readonly setupStatus: string;
  readonly workflowCurrent: boolean;
  readonly mutationsEnabled: boolean;
  readonly variant?: "solid" | "soft" | "outline" | "ghost";
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
              router.replace(buildDashboardMutationUrl(params), {
                scroll: false,
              });
              router.refresh();
            })
            .catch(() => {
              router.replace(
                buildDashboardMutationUrl({
                  error: "dashboard_action_failed",
                  workspace: workspaceId,
                  section: "repositories",
                }),
                { scroll: false },
              );
              router.refresh();
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
        className="w-full min-w-0 px-3 sm:w-auto sm:min-w-[9.5rem] sm:px-5"
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
                : "Creating setup PR..."}
            </span>
          </span>
        ) : workflowCurrent ? (
          "Installed"
        ) : (
          setupPrButtonLabel(setupStatus)
        )}
      </Button>
    </form>
  );
}

function setupPrButtonLabel(setupStatus: string): string {
  return setupStatus === "setup_pr_open"
    ? "Update setup PR"
    : "Create setup PR";
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

  return `/dashboard?${search.toString()}`;
}
