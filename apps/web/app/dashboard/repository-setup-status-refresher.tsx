"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

export function RepositorySetupStatusRefresher({
  enabled,
  disclosureId,
  intervalMs = 12_000,
}: {
  readonly enabled: boolean;
  readonly disclosureId?: string;
  readonly intervalMs?: number;
}): null {
  const router = useRouter();
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [, startTransition] = useTransition();

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

    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      startTransition(() => {
        router.refresh();
      });
    };
    const interval = window.setInterval(refresh, intervalMs);
    return () => window.clearInterval(interval);
  }, [disclosureOpen, enabled, intervalMs, router, startTransition]);

  return null;
}
