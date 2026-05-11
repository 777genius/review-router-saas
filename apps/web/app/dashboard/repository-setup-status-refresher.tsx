"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { confirmSetupPullRequestMergedClientAction } from "./actions";

export function RepositorySetupStatusRefresher({
  enabled,
  workspaceId,
  repositoryId,
  disclosureId,
  intervalMs = 12_000,
}: {
  readonly enabled: boolean;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly disclosureId?: string;
  readonly intervalMs?: number;
}): null {
  const router = useRouter();
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [, startTransition] = useTransition();
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled || !disclosureId) {
      setDisclosureOpen(enabled);
      return;
    }

    const input = document.getElementById(disclosureId);
    if (!(input instanceof HTMLInputElement)) {
      setDisclosureOpen(false);
      return;
    }

    const syncOpenState = () => setDisclosureOpen(input.checked);
    syncOpenState();
    input.addEventListener("change", syncOpenState);
    return () => input.removeEventListener("change", syncOpenState);
  }, [disclosureId, enabled]);

  useEffect(() => {
    if (!enabled || !disclosureOpen) return;

    const checkMerged = () => {
      if (document.visibilityState !== "visible") return;
      if (inFlight.current) return;

      inFlight.current = true;
      const formData = new FormData();
      formData.set("workspaceId", workspaceId);
      formData.set("repositoryId", repositoryId);

      startTransition(() => {
        void confirmSetupPullRequestMergedClientAction(formData)
          .then(({ params }) => {
            if (params.notice === "setup_pr_merged") {
              router.refresh();
            }
          })
          .catch(() => {
            // Background refresh should stay silent. The explicit button still
            // reports actionable errors to the user.
          })
          .finally(() => {
            inFlight.current = false;
          });
      });
    };

    const timeout = window.setTimeout(checkMerged, 1_000);
    const interval = window.setInterval(checkMerged, intervalMs);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [
    disclosureOpen,
    enabled,
    intervalMs,
    repositoryId,
    router,
    startTransition,
    workspaceId,
  ]);

  return null;
}
