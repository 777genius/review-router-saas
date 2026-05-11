"use client";

import { useEffect, useMemo, type ReactNode } from "react";
import { toast } from "sonner";

type ActionToastTone = "success" | "warning" | "danger" | "accent";

type ActionToastProps = {
  readonly tone: ActionToastTone;
  readonly title: string;
  readonly body: string;
  readonly actionUrl?: string | undefined;
  readonly actionLabel?: string | undefined;
  readonly secondaryAction?: ReactNode | undefined;
  readonly autoOpenUrl?: string | undefined;
  readonly storageKey?: string | undefined;
};

const toneClassNames: Record<ActionToastTone, string> = {
  accent: "border-cyan-300/25 bg-cyan-300/[0.09] text-cyan-50",
  danger: "border-rose-300/30 bg-rose-400/[0.11] text-rose-50",
  success: "border-lime-300/25 bg-lime-300/[0.1] text-lime-50",
  warning: "border-amber-300/30 bg-amber-300/[0.1] text-amber-50",
};

export function ActionToast({
  tone,
  title,
  body,
  actionUrl,
  actionLabel = "Open",
  secondaryAction,
  autoOpenUrl,
  storageKey,
}: ActionToastProps): null {
  const toastId = useMemo(
    () => `action-toast:${tone}|${title}|${body}|${actionUrl ?? ""}`,
    [tone, title, body, actionUrl],
  );
  const autoOpenStorageKey = useMemo(
    () => storageKey ?? `reviewrouter:auto-open:${autoOpenUrl ?? ""}`,
    [autoOpenUrl, storageKey],
  );

  useEffect(() => {
    toast.custom(
      (id) => (
        <div
          className={`rounded-2xl border p-4 shadow-[0_20px_70px_rgba(0,0,0,0.45)] backdrop-blur-2xl ${toneClassNames[tone]}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.16em] opacity-80">
                {title}
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-100">{body}</p>
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 text-slate-200 transition hover:border-cyan-300/35 hover:bg-white/[0.08] hover:text-cyan-50"
              onClick={() => toast.dismiss(id)}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
          {actionUrl || secondaryAction ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {secondaryAction}
              {actionUrl ? (
                <a
                  href={actionUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-semibold text-cyan-100 underline decoration-cyan-300/55 underline-offset-4 transition hover:text-cyan-50 hover:decoration-cyan-100"
                >
                  {actionLabel}
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      ),
      { id: toastId },
    );
  }, [
    toastId,
    tone,
    title,
    body,
    actionUrl,
    actionLabel,
    secondaryAction,
  ]);

  useEffect(() => {
    if (!autoOpenUrl) return;

    try {
      if (window.sessionStorage.getItem(autoOpenStorageKey) === "1") return;
      window.sessionStorage.setItem(autoOpenStorageKey, "1");
    } catch {
      // Browser privacy settings can block storage. The explicit link remains.
    }

    window.open(autoOpenUrl, "_blank", "noopener,noreferrer");
  }, [autoOpenStorageKey, autoOpenUrl]);

  return null;
}
