"use client";

import { Tabs } from "@base-ui/react/tabs";

export type DashboardWorkspaceTabItem = {
  readonly id: string;
  readonly label: string;
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
        className="flex gap-8 overflow-x-auto border-b border-cyan-200/15"
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
                "group relative -mb-px inline-flex min-h-12 shrink-0 items-center gap-2 border-b-2 px-0 py-3 text-sm font-semibold transition duration-200 ease-out hover:-translate-y-0.5 hover:saturate-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200 active:translate-y-0",
                active
                  ? "border-cyan-200 text-cyan-50"
                  : "border-transparent text-slate-300 hover:border-cyan-300/35 hover:text-cyan-50",
              ].join(" ")
            }
          >
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
