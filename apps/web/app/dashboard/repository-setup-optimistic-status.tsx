"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  providerSetupConfirmedEventName,
  setupPullRequestMergedEventName,
  type ProviderSetupConfirmedEventDetail,
  type SetupPullRequestMergedEventDetail,
} from "./repository-setup-optimistic-events";

type SetupStep = 1 | 2 | 3 | 4;

export function RepositorySetupDisclosureToggle({
  repositoryId,
  disclosureId,
  currentStep,
}: {
  readonly repositoryId: string;
  readonly disclosureId: string;
  readonly currentStep: SetupStep;
}): React.ReactElement {
  const optimisticStep = useOptimisticSetupStep({ repositoryId, currentStep });

  const isComplete = optimisticStep === 4;
  return (
    <label
      htmlFor={disclosureId}
      title={repositorySetupProgressSummary(optimisticStep)}
      className={[
        "setup-toggle inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 font-mono text-xs font-semibold uppercase tracking-[0.12em] transition duration-200 ease-out hover:saturate-125",
        isComplete
          ? "border-emerald-300/40 bg-emerald-400/[0.09] text-emerald-100 hover:border-emerald-300/60 hover:bg-emerald-400/[0.14]"
          : "border-cyan-300/25 bg-cyan-300/[0.035] text-cyan-100 hover:border-cyan-300/50 hover:bg-cyan-300/[0.075]",
      ].join(" ")}
    >
      <span>Setup</span>
      <span
        className={[
          "text-[0.65rem] tracking-normal",
          isComplete ? "text-emerald-200/80" : "text-slate-400",
        ].join(" ")}
      >
        {optimisticStep}/4
      </span>
      {isComplete ? <SetupCompleteCheckIcon /> : <SetupDisclosureChevron />}
    </label>
  );
}

export function RepositorySetupReadyGate({
  repositoryId,
  currentStep,
  children,
}: {
  readonly repositoryId: string;
  readonly currentStep: SetupStep;
  readonly children: ReactNode;
}): React.ReactElement | null {
  const optimisticStep = useOptimisticSetupStep({ repositoryId, currentStep });

  return optimisticStep === 4 ? <>{children}</> : null;
}

function useOptimisticSetupStep({
  repositoryId,
  currentStep,
}: {
  readonly repositoryId: string;
  readonly currentStep: SetupStep;
}): SetupStep {
  const [optimisticStep, setOptimisticStep] = useState(currentStep);

  useEffect(() => {
    setOptimisticStep(currentStep);
  }, [currentStep]);

  useEffect(() => {
    function handleSetupPullRequestMerged(event: Event): void {
      const detail = (event as CustomEvent<SetupPullRequestMergedEventDetail>)
        .detail;
      if (detail?.repositoryId === repositoryId) {
        setOptimisticStep((current) => (current < 3 ? 3 : current));
      }
    }

    function handleProviderSetupConfirmed(event: Event): void {
      const detail = (event as CustomEvent<ProviderSetupConfirmedEventDetail>)
        .detail;
      if (detail?.repositoryId === repositoryId) {
        setOptimisticStep(4);
      }
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
  }, [repositoryId]);

  return optimisticStep;
}

export function RepositorySetupRowDisclosureController(): null {
  useEffect(() => {
    function handleRowClick(event: MouseEvent): void {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(repositoryRowInteractiveSelector)) return;

      const row = target.closest<HTMLElement>("[data-repository-setup-row]");
      if (!row) return;
      if (target.closest("[data-repository-setup-panel]")) return;

      const disclosureId = row.dataset.disclosureId;
      if (!disclosureId) return;

      const input = document.getElementById(disclosureId);
      if (!(input instanceof HTMLInputElement)) return;

      input.checked = !input.checked;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    document.addEventListener("click", handleRowClick);
    return () => document.removeEventListener("click", handleRowClick);
  }, []);

  return null;
}

const repositoryRowInteractiveSelector = [
  "a",
  "button",
  "input",
  "label",
  "select",
  "textarea",
  "[role='button']",
  "[role='link']",
  "[role='tab']",
  "[data-ignore-repository-row-toggle]",
].join(",");

function SetupDisclosureChevron(): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="setup-chevron h-3.5 w-3.5 shrink-0 text-cyan-100 transition-transform duration-200 ease-out motion-reduce:transition-none"
      fill="none"
    >
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SetupCompleteCheckIcon(): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0 text-emerald-200"
      fill="none"
    >
      <path
        d="M3.5 8.5l3 3 6-6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
