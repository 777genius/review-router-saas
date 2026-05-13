"use client";

import { useEffect, useMemo, useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { GitHubAccountAvatar } from "../github-account-avatar";

export type DashboardWorkspaceTabItem = {
  readonly id: string;
  readonly label: string;
  readonly avatarUrl?: string | null;
  readonly repositoryCount?: number;
  readonly statusLabel?: string;
  readonly href: string;
};

export type DashboardPendingWorkspaceTabItem = {
  readonly id: string;
  readonly label: string;
  readonly avatarUrl?: string | null;
  readonly repositoryCount?: number;
  readonly href: string;
  readonly statusLabel: string;
};

export function DashboardWorkspaceTabs({
  items,
  selectedWorkspaceId,
  pendingInstallRequest,
}: {
  readonly items: readonly DashboardWorkspaceTabItem[];
  readonly selectedWorkspaceId: string;
  readonly pendingInstallRequest?: DashboardPendingWorkspaceTabItem | null;
}): React.ReactElement {
  const [showPendingRequest, setShowPendingRequest] = useState(false);
  const activeLabels = useMemo(
    () => new Set(items.map((item) => item.label.toLowerCase())),
    [items],
  );
  const visibleItems =
    showPendingRequest &&
    pendingInstallRequest &&
    !activeLabels.has(pendingInstallRequest.label.toLowerCase())
      ? [...items, pendingInstallRequest]
      : items;

  useEffect(() => {
    if (!pendingInstallRequest) return;
    if (!isLikelyGitHubRedirect()) return;
    if (activeLabels.has(pendingInstallRequest.label.toLowerCase())) return;

    const key = `reviewrouter:github-app-request-tab:${pendingInstallRequest.label}`;
    try {
      if (window.sessionStorage.getItem(key) === "1") return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      // Storage can be blocked. Keep this page render ephemeral.
    }

    setShowPendingRequest(true);
  }, [activeLabels, pendingInstallRequest]);

  return (
    <Tabs.Root value={selectedWorkspaceId}>
      <Tabs.List
        aria-label="Workspace"
        activateOnFocus
        className="flex gap-4 overflow-x-auto overflow-y-hidden border-b border-cyan-200/15 pb-px [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {visibleItems.map((item) => (
          <Tabs.Tab
            key={item.id}
            value={item.id}
            nativeButton={false}
            render={
              <a
                href={item.href}
                aria-current={
                  selectedWorkspaceId === item.id ? "page" : undefined
                }
              />
            }
            className={({ active }) =>
              [
                "group relative inline-flex min-h-12 shrink-0 items-center gap-2 rounded-t-xl border-b-2 px-2 py-3 text-sm font-semibold transition duration-200 ease-out hover:bg-cyan-300/[0.04] hover:saturate-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200",
                active
                  ? "border-cyan-200 text-cyan-50"
                  : "border-transparent text-slate-300 hover:border-cyan-300/35 hover:text-cyan-50",
              ].join(" ")
            }
          >
            <GitHubAccountAvatar
              avatarUrl={item.avatarUrl}
              login={item.label}
              size="sm"
              className="-my-1"
            />
            <span>{item.label}</span>
            <span
              className={[
                "font-mono text-xs group-hover:text-slate-300 group-data-[active]:text-cyan-100/80",
                item.statusLabel ? "text-amber-200/85" : "text-slate-500",
              ].join(" ")}
            >
              {item.statusLabel ?? `${item.repositoryCount ?? 0} repos`}
            </span>
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs.Root>
  );
}

function isLikelyGitHubRedirect(): boolean {
  try {
    const referrer = new URL(document.referrer);
    return (
      referrer.hostname === "github.com" ||
      referrer.hostname.endsWith(".github.com")
    );
  } catch {
    return false;
  }
}
