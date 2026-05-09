"use client";

import { Tabs } from "@base-ui/react/tabs";
import { GitHubAccountAvatar } from "../github-account-avatar";

export type DashboardWorkspaceTabItem = {
  readonly id: string;
  readonly label: string;
  readonly avatarUrl?: string | null;
  readonly repositoryCount: number;
  readonly href: string;
};

export function DashboardWorkspaceTabs({
  items,
  selectedWorkspaceId,
}: {
  readonly items: readonly DashboardWorkspaceTabItem[];
  readonly selectedWorkspaceId: string;
}): React.ReactElement {
  return (
    <Tabs.Root value={selectedWorkspaceId}>
      <Tabs.List
        aria-label="Workspace"
        activateOnFocus
        className="flex gap-4 overflow-x-auto overflow-y-hidden border-b border-cyan-200/15 pb-px [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((item) => (
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
            <span className="font-mono text-xs text-slate-500 group-hover:text-slate-300 group-data-[active]:text-cyan-100/80">
              {item.repositoryCount} repos
            </span>
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs.Root>
  );
}
