"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, LinkButton } from "@reviewrouter/ui";
import type { ProviderAuthMode } from "@reviewrouter/features-review-providers";
import { ActionToast } from "../action-toast";
import {
  RepositorySetupActionButton,
  RepositorySetupMergedButton,
} from "./repository-setup-action-button";
import { dashboardErrorText as sharedDashboardErrorText } from "./dashboard-copy";
import {
  providerSetupConfirmedEventName,
  setupPullRequestMergedEvent,
  setupPullRequestMergedEventName,
  type ProviderSetupConfirmedEventDetail,
  type SetupPullRequestMergedEventDetail,
} from "./repository-setup-optimistic-events";

type SetupStep = 1 | 2 | 3 | 4;

type SetupToast = {
  readonly tone: "success" | "danger";
  readonly title: string;
  readonly body: string;
  readonly errorCode?: string;
  readonly actionUrl?: string;
  readonly actionLabel?: string;
};

type SetupIssue = "setup_pr_closed" | "setup_pr_branch_deleted";

export function RepositorySetupProgressPanel({
  workspaceId,
  repositoryId,
  repositoryFullName,
  selected,
  archived,
  initialSetupStatus,
  initialSetupPullRequestUrl,
  initialSetupIssue,
  workflowCurrent,
  mutationsEnabled,
  initialStep,
  expectedProviderAuthModes = [],
  enableReviewAction,
}: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly selected: boolean;
  readonly archived: boolean;
  readonly initialSetupStatus: string;
  readonly initialSetupPullRequestUrl: string | null;
  readonly initialSetupIssue?: string | null;
  readonly workflowCurrent: boolean;
  readonly mutationsEnabled: boolean;
  readonly initialStep: SetupStep;
  readonly expectedProviderAuthModes?: readonly ProviderAuthMode[];
  readonly enableReviewAction?: ReactNode;
}): React.ReactElement {
  const router = useRouter();
  const [setupStatus, setSetupStatus] = useState(initialSetupStatus);
  const [setupPullRequestUrl, setSetupPullRequestUrl] = useState(
    initialSetupPullRequestUrl,
  );
  const [setupIssue, setSetupIssue] = useState<SetupIssue | null>(
    normalizeSetupIssue(initialSetupIssue),
  );
  const [currentStep, setCurrentStep] = useState(initialStep);
  const optimisticProviderAuthModesRef = useRef(new Set<ProviderAuthMode>());
  const [toast, setToast] = useState<SetupToast | null>(null);
  const canManage = mutationsEnabled && selected && !archived;

  useEffect(() => {
    optimisticProviderAuthModesRef.current = new Set();
    setSetupStatus(initialSetupStatus);
    setSetupPullRequestUrl(initialSetupPullRequestUrl);
    setSetupIssue(normalizeSetupIssue(initialSetupIssue));
    setCurrentStep(initialStep);
    if (initialStep > 2) {
      setToast((current) =>
        current?.errorCode === "setup_pr_not_merged" ? null : current,
      );
    }
  }, [
    initialSetupIssue,
    initialSetupPullRequestUrl,
    initialSetupStatus,
    initialStep,
  ]);

  useEffect(() => {
    function handleSetupPullRequestMerged(event: Event): void {
      const detail = (event as CustomEvent<SetupPullRequestMergedEventDetail>)
        .detail;
      if (detail?.repositoryId !== repositoryId) return;

      setSetupStatus("configured");
      setSetupIssue(null);
      setCurrentStep((current) => (current < 3 ? 3 : current));
    }

    function handleProviderSetupConfirmed(event: Event): void {
      const detail = (event as CustomEvent<ProviderSetupConfirmedEventDetail>)
        .detail;
      if (detail?.repositoryId !== repositoryId) return;
      if (
        !providerSetupConfirmationMatchesAnyExpectedAuthMode(
          detail,
          expectedProviderAuthModes,
        )
      ) {
        return;
      }

      if (detail.authMode !== undefined) {
        optimisticProviderAuthModesRef.current.add(detail.authMode);
      }
      router.refresh();
      if (
        !providerSetupConfirmationsComplete(
          optimisticProviderAuthModesRef.current,
          expectedProviderAuthModes,
        )
      ) {
        return;
      }

      setSetupStatus("configured");
      setSetupIssue(null);
      setCurrentStep(4);
    }

    window.addEventListener(
      setupPullRequestMergedEventName,
      handleSetupPullRequestMerged,
    );
    window.addEventListener(
      providerSetupConfirmedEventName,
      handleProviderSetupConfirmed,
    );
    return () => {
      window.removeEventListener(
        setupPullRequestMergedEventName,
        handleSetupPullRequestMerged,
      );
      window.removeEventListener(
        providerSetupConfirmedEventName,
        handleProviderSetupConfirmed,
      );
    };
  }, [expectedProviderAuthModes, repositoryId, router]);

  const handleSetupMutation = (params: Record<string, string>) => {
    clearTransientDashboardUrlParams("repositories");

    if (params.error) {
      const issue = normalizeSetupIssue(params.error);
      if (issue) {
        setSetupStatus("needs_attention");
        setSetupIssue(issue);
        setCurrentStep(1);
        router.refresh();
      }
      setToast({
        tone: "danger",
        title: issue ? "Setup PR needs recovery" : "Action needs attention",
        body: dashboardErrorText(params.error),
        errorCode: params.error,
      });
      return;
    }

    if (params.notice === "setup_pr_ready") {
      const pullRequestUrl = params.pr || setupPullRequestUrl || undefined;
      setSetupStatus("setup_pr_open");
      setSetupPullRequestUrl(pullRequestUrl ?? null);
      setSetupIssue(null);
      setCurrentStep(2);
      setToast({
        tone: "success",
        title: "Setup PR ready",
        body: `Setup PR is ready for ${params.repository || repositoryFullName}.`,
        ...(pullRequestUrl ? { actionUrl: pullRequestUrl } : {}),
        actionLabel: "Open setup PR",
      });
      openOnce(pullRequestUrl);
      return;
    }

    if (params.notice === "workflow_already_current") {
      setSetupStatus("configured");
      setSetupIssue(null);
      setCurrentStep(3);
      router.refresh();
      setToast({
        tone: "success",
        title: "Workflow installed",
        body: `ReviewRouter workflow is already current for ${
          params.repository || repositoryFullName
        }.`,
      });
      return;
    }
  };

  const handleMergeMutation = (params: Record<string, string>) => {
    clearTransientDashboardUrlParams("repositories");

    if (params.error) {
      const issue = normalizeSetupIssue(params.error);
      if (issue) {
        setSetupStatus("needs_attention");
        setSetupIssue(issue);
        setCurrentStep(1);
        router.refresh();
      }
      setToast({
        tone: "danger",
        title: issue ? "Setup PR needs recovery" : "Action needs attention",
        body: dashboardErrorText(params.error),
        errorCode: params.error,
      });
      return;
    }

    if (params.notice === "setup_pr_merged") {
      setSetupStatus("configured");
      setSetupIssue(null);
      setCurrentStep(3);
      window.dispatchEvent(setupPullRequestMergedEvent({ repositoryId }));
      router.refresh();
      setToast({
        tone: "success",
        title: "Setup PR merged",
        body: `Setup PR merge was confirmed for ${
          params.repository || repositoryFullName
        }.`,
      });
    }
  };

  const steps = buildSetupSteps({
    workspaceId,
    repositoryId,
    selected,
    archived,
    setupStatus,
    setupPullRequestUrl,
    setupIssue,
    workflowCurrent,
    mutationsEnabled,
    currentStep,
    enableReviewAction: canManage ? enableReviewAction : null,
    onSetupComplete: handleSetupMutation,
    onMergeComplete: handleMergeMutation,
  });

  return (
    <section className="mb-4 pt-1">
      {toast ? (
        <ActionToast
          tone={toast.tone}
          title={toast.title}
          body={toast.body}
          actionUrl={toast.actionUrl}
          actionLabel={toast.actionLabel}
          storageKey={
            toast.actionUrl
              ? `reviewrouter:dashboard-setup-pr:${toast.actionUrl}`
              : undefined
          }
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-cyan-100">
          Setup progress
        </p>
        <span className="font-mono text-xs text-slate-400">
          {repositorySetupProgressSummary(currentStep)}
        </span>
      </div>

      <div className="relative mt-3">
        <span
          aria-hidden="true"
          className="absolute left-4 right-4 top-6 hidden h-px bg-cyan-300/12 md:block"
        />
        <span
          aria-hidden="true"
          className="absolute left-4 top-6 hidden h-px bg-cyan-300/45 md:block"
          style={{ width: repositorySetupProgressTrackWidth(currentStep) }}
        />
        <ol className="relative z-10 grid gap-3 md:grid-cols-4">
          {steps.map((step) => (
            <RepositorySetupProgressStepItem
              key={step.number}
              step={step}
              currentStep={currentStep}
            />
          ))}
        </ol>
      </div>
    </section>
  );
}

function providerSetupConfirmationMatchesAnyExpectedAuthMode(
  detail: ProviderSetupConfirmedEventDetail,
  expectedProviderAuthModes: readonly ProviderAuthMode[],
): boolean {
  if (expectedProviderAuthModes.length === 0) {
    return true;
  }
  return (
    detail.authMode !== undefined &&
    expectedProviderAuthModes.includes(detail.authMode)
  );
}

function providerSetupConfirmationsComplete(
  confirmedAuthModes: ReadonlySet<ProviderAuthMode>,
  expectedProviderAuthModes: readonly ProviderAuthMode[],
): boolean {
  const uniqueExpected = [...new Set(expectedProviderAuthModes)];
  if (uniqueExpected.length === 0) {
    return true;
  }
  return uniqueExpected.every((authMode) => confirmedAuthModes.has(authMode));
}

function buildSetupSteps({
  workspaceId,
  repositoryId,
  selected,
  archived,
  setupStatus,
  setupPullRequestUrl,
  setupIssue,
  workflowCurrent,
  mutationsEnabled,
  currentStep,
  enableReviewAction,
  onSetupComplete,
  onMergeComplete,
}: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly selected: boolean;
  readonly archived: boolean;
  readonly setupStatus: string;
  readonly setupPullRequestUrl: string | null;
  readonly setupIssue: SetupIssue | null;
  readonly workflowCurrent: boolean;
  readonly mutationsEnabled: boolean;
  readonly currentStep: SetupStep;
  readonly enableReviewAction?: ReactNode;
  readonly onSetupComplete: (params: Record<string, string>) => void;
  readonly onMergeComplete: (params: Record<string, string>) => void;
}): readonly RepositorySetupProgressStep[] {
  const setupPrAction =
    setupStatus === "setup_pr_open" && setupPullRequestUrl ? (
      <LinkButton
        href={setupPullRequestUrl}
        target="_blank"
        rel="noreferrer"
        variant="outline"
        size="sm"
        className="min-h-11 w-full min-w-0 rounded-lg px-3 sm:w-auto sm:min-w-[9.5rem] sm:px-5"
      >
        Open setup PR
        <span aria-hidden="true" className="text-xs">
          ↗
        </span>
      </LinkButton>
    ) : currentStep === 1 ? (
      <RepositorySetupActionButton
        workspaceId={workspaceId}
        repositoryId={repositoryId}
        selected={selected}
        archived={archived}
        setupStatus={setupStatus}
        workflowCurrent={workflowCurrent}
        mutationsEnabled={mutationsEnabled}
        onComplete={onSetupComplete}
      />
    ) : null;
  const mergeConfirmAction =
    currentStep === 2 ? (
      <RepositorySetupMergedButton
        workspaceId={workspaceId}
        repositoryId={repositoryId}
        selected={selected}
        archived={archived}
        mutationsEnabled={mutationsEnabled}
        onComplete={onMergeComplete}
      />
    ) : null;
  const shouldRenderProviderAction =
    Boolean(enableReviewAction) && currentStep >= 3;
  const lockedReviewAction =
    currentStep < 4 ? (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 w-full min-w-0 rounded-lg px-3 sm:w-auto sm:min-w-[9.5rem] sm:px-5"
        disabled
      >
        Enable review
        <SetupProgressLockIcon />
      </Button>
    ) : null;
  const reviewAction = shouldRenderProviderAction
    ? enableReviewAction
    : lockedReviewAction;

  const setupPrHelper = setupIssue
    ? setupIssueHelperText(setupIssue)
    : currentStep > 1
      ? "Setup PR exists."
      : "Add the workflow by PR.";

  return [
    {
      number: 1,
      title: setupIssue ? "Recover setup PR" : "Create setup PR",
      helper: setupPrHelper,
      action: setupPrAction,
    },
    {
      number: 2,
      title: "Merge setup PR",
      helper:
        currentStep > 2
          ? "Workflow is on the default branch."
          : "Merge on GitHub.",
      action: mergeConfirmAction,
    },
    {
      number: 3,
      title: "Enable review",
      helper:
        currentStep > 3
          ? "Provider access is configured."
          : currentStep === 3
            ? "Seed provider access."
            : "Available after merge.",
      action: reviewAction,
    },
    {
      number: 4,
      title: "Ready",
      helper: null,
    },
  ];
}

type RepositorySetupProgressStep = {
  readonly number: SetupStep;
  readonly title: string;
  readonly helper: string | null;
  readonly action?: ReactNode;
};

function RepositorySetupProgressStepItem({
  step,
  currentStep,
}: {
  readonly step: RepositorySetupProgressStep;
  readonly currentStep: number;
}): React.ReactElement {
  const isActive = step.number === currentStep;
  const isComplete = step.number < currentStep;
  const isFuture = step.number > currentStep;
  const circleClass = isActive
    ? "border-cyan-200 bg-cyan-200 text-slate-950 shadow-[0_0_18px_rgba(103,232,249,0.28)]"
    : isComplete
      ? "border-cyan-300/45 bg-slate-950 text-cyan-100 shadow-[inset_0_0_18px_rgba(103,232,249,0.12)]"
      : "border-slate-700 bg-slate-950 text-slate-500";
  const desktopAlignment =
    step.number === 1
      ? "md:items-start md:text-left"
      : step.number === 4
        ? "md:items-end md:text-right"
        : "md:items-center md:text-center";

  return (
    <li className="relative min-w-0">
      <div
        className={[
          "relative z-10 flex min-w-0 items-start gap-3 py-2 pr-3 md:flex-col md:gap-0 md:pr-0",
          "md:min-h-[8.25rem]",
          desktopAlignment,
        ].join(" ")}
      >
        <span
          className={[
            "grid h-8 w-8 shrink-0 place-items-center rounded-full border font-mono text-xs font-bold leading-none",
            circleClass,
          ].join(" ")}
        >
          {step.number}
        </span>
        <div className="min-w-0 md:mt-3">
          <p
            className={[
              "text-sm font-semibold leading-5",
              isFuture ? "text-slate-500" : "text-cyan-50",
            ].join(" ")}
          >
            {step.title}
          </p>
          {step.helper ? (
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {step.helper}
            </p>
          ) : null}
          {step.action ? (
            <div
              className={[
                "mt-3",
                step.number === 4
                  ? "md:flex md:justify-end"
                  : step.number === 1
                    ? "md:flex md:justify-start"
                    : "md:flex md:justify-center",
              ].join(" ")}
            >
              {step.action}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function repositorySetupProgressSummary(step: SetupStep): string {
  switch (step) {
    case 1:
      return "1 of 4 - setup PR needed";
    case 2:
      return "2 of 4 - merge setup PR";
    case 3:
      return "3 of 4 - enable review";
    case 4:
      return "4 of 4 - complete";
  }
}

function repositorySetupProgressTrackWidth(step: SetupStep): string {
  switch (step) {
    case 1:
      return "0";
    case 2:
      return "calc(37.5% - 1rem)";
    case 3:
      return "calc(62.5% - 1rem)";
    case 4:
      return "calc(100% - 2rem)";
  }
}

function SetupProgressLockIcon(): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0"
      fill="none"
    >
      <path
        d="M5 7V5.4C5 3.7 6.3 2.5 8 2.5s3 1.2 3 2.9V7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M4.2 7h7.6v5.8H4.2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function clearTransientDashboardUrlParams(section: string): void {
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

function openOnce(url: string | undefined): void {
  if (!url) return;

  const storageKey = `reviewrouter:dashboard-setup-pr:${url}`;
  try {
    if (window.sessionStorage.getItem(storageKey) === "1") return;
    window.sessionStorage.setItem(storageKey, "1");
  } catch {
    // Privacy settings can block storage. The explicit link remains visible.
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

function dashboardErrorText(error: string): string {
  switch (error) {
    case "dashboard_action_stale":
      return "The dashboard was updated while this page was open. Refresh the page, then click again.";
    case "setup_pr_not_merged":
      return "GitHub does not show the workflow on the default branch yet. If you just merged the setup PR, wait a few seconds; the dashboard will advance automatically when GitHub metadata catches up.";
    case "setup_pr_closed":
      return "The saved setup PR was closed before it was merged. Recreate the setup PR, then merge the new one.";
    case "setup_pr_branch_deleted":
      return "The saved setup PR branch was deleted, so GitHub cannot merge that PR anymore. Recreate the setup PR to continue.";
    case "dashboard_action_failed":
      return "The dashboard action failed. Retry once, then inspect server logs if it repeats.";
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
    default:
      return sharedDashboardErrorText(error);
  }
}

function normalizeSetupIssue(
  value: string | null | undefined,
): SetupIssue | null {
  return value === "setup_pr_closed" || value === "setup_pr_branch_deleted"
    ? value
    : null;
}

function setupIssueHelperText(issue: SetupIssue): string {
  switch (issue) {
    case "setup_pr_closed":
      return "Previous setup PR was closed. Recreate it.";
    case "setup_pr_branch_deleted":
      return "Setup PR branch was deleted. Recreate it.";
  }
}
