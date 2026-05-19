"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ActionToast } from "../action-toast";

export type DashboardActionFormAction = (
  formData: FormData,
) => Promise<{ readonly params: Record<string, string> }>;

type DashboardActionToast = {
  readonly key: number;
  readonly tone: "success" | "warning" | "danger" | "accent";
  readonly title: string;
  readonly body: string;
  readonly actionUrl?: string;
  readonly actionLabel?: string;
};

export function DashboardActionForm({
  action,
  fallbackParams,
  className,
  refresh = true,
  children,
}: {
  readonly action: DashboardActionFormAction;
  readonly fallbackParams: Record<string, string>;
  readonly className?: string;
  readonly refresh?: boolean;
  readonly children: ReactNode;
}): React.ReactElement {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [toast, setToast] = useState<DashboardActionToast | null>(null);

  async function submit(formData: FormData): Promise<void> {
    let params: Record<string, string>;
    try {
      ({ params } = await action(formData));
    } catch {
      params = fallbackParams;
    }

    replaceDashboardContextUrl(params);
    setToast((current) => ({
      ...dashboardActionToast(params),
      key: (current?.key ?? 0) + 1,
    }));
    if (refresh) {
      startTransition(() => router.refresh());
    }
  }

  return (
    <form action={submit} className={className}>
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
      {children}
    </form>
  );
}

function replaceDashboardContextUrl(params: Record<string, string>): void {
  const url = new URL(window.location.href);
  let changed = false;

  for (const key of ["notice", "error", "pr", "version", "provisioning"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  for (const key of ["workspace", "section", "memory_mode"] as const) {
    const value = params[key];
    if (value && url.searchParams.get(key) !== value) {
      url.searchParams.set(key, value);
      changed = true;
    }
  }

  if (!changed) return;

  const search = url.searchParams.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${search ? `?${search}` : ""}${url.hash}`,
  );
}

function dashboardActionToast(
  params: Record<string, string>,
): Omit<DashboardActionToast, "key"> {
  if (params.error) {
    return {
      tone: "danger",
      title: "Action needs attention",
      body: dashboardActionErrorText(params.error),
    };
  }

  switch (params.notice) {
    case "sync_requested":
      return {
        tone: "success",
        title: "Repository refresh queued",
        body: "ReviewRouter queued a repository metadata refresh. Reload in a few seconds if GitHub metadata is still catching up.",
      };
    case "sync_already_requested":
      return {
        tone: "accent",
        title: "Repository refresh already queued",
        body: "A repository metadata refresh was already requested recently.",
      };
    case "repository_access_refreshed":
      return {
        tone: "success",
        title: "Access refreshed",
        body: "GitHub repository access was refreshed for your account.",
      };
    case "org_ruleset_queued":
      return {
        tone: "success",
        title: "Org-wide setup queued",
        body: "Organization-wide required workflow setup was queued.",
      };
    case "memory_saved":
      return {
        tone: "success",
        title: "Memory saved",
        body: "Memory was saved after policy and safety checks.",
      };
    case "memory_suggestion_confirmed":
      return {
        tone: "success",
        title: "Suggestion approved",
        body: "Suggested memory was confirmed and queued for retrieval indexing.",
      };
    case "memory_suggestion_rejected":
      return {
        tone: "success",
        title: "Suggestion rejected",
        body: "Suggested memory was rejected and will not be used in runtime context.",
      };
    case "memory_disabled":
      return {
        tone: "success",
        title: "Memory disabled",
        body: "Memory was disabled and queued for removal from retrieval.",
      };
    case "memory_deleted":
      return {
        tone: "success",
        title: "Memory deleted",
        body: "Memory was deleted and queued for removal from retrieval.",
      };
    case "memory_duplicate":
      return {
        tone: "accent",
        title: "Duplicate skipped",
        body: "A matching active memory already exists, so nothing was changed.",
      };
    case "memory_already_confirmed":
    case "memory_already_rejected":
    case "memory_already_disabled":
    case "memory_already_deleted":
    case "memory_noop":
      return {
        tone: "accent",
        title: "Memory unchanged",
        body: "Memory state was already up to date.",
      };
    case "outbox_retry_queued":
      return {
        tone: "success",
        title: "Retry queued",
        body: "Failed background event was queued for retry.",
      };
    case "outbox_retry_not_found":
    case "outbox_retry_not_dead_letter":
      return {
        tone: "warning",
        title: "Retry skipped",
        body: "The background event could not be manually retried in its current state.",
      };
    default:
      return {
        tone: "success",
        title: "Action complete",
        body: "Dashboard action completed.",
      };
  }
}

function dashboardActionErrorText(error: string): string {
  switch (error) {
    case "dashboard_action_failed":
      return "The dashboard could not complete this action. Refresh and try again.";
    case "dashboard_mutation_requires_sign_in":
      return "Sign in with GitHub before changing repository setup.";
    case "workspace_mutation_forbidden":
      return "Your GitHub user is not an owner/admin for this workspace.";
    case "repository_mutation_forbidden":
      return "Your GitHub user needs write, maintain, or admin access on this repository.";
    case "operation_already_running":
      return "Another setup or sync operation is already running. Try again shortly.";
    case "rate_limited":
      return "Too many dashboard requests for this resource. Wait a bit before retrying.";
    case "invalid_form":
      return "The submitted form is invalid. Refresh the dashboard and try again.";
    case "entitlement_denied":
      return "This workspace plan does not allow that action.";
    case "memory_not_found":
      return "Memory was not found or was already changed.";
    case "memory_safety_blocked":
      return "Memory was blocked by safety checks.";
    case "memory_active_item_quota_exceeded":
    case "memory_pending_suggestion_quota_exceeded":
      return "This workspace hit the memory quota for this beta.";
    case "contains_code_block":
    case "contains_diff_hunk":
    case "contains_large_stacktrace":
    case "contains_prompt_injection":
    case "contains_secret_like_text":
    case "too_long":
      return "Memory text did not pass safety and shape checks.";
    default:
      return "The dashboard action could not be completed.";
  }
}
