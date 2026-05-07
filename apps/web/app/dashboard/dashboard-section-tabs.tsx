"use client";

import { Tabs } from "@base-ui/react/tabs";

export type DashboardSectionTabItem = {
  readonly section: string;
  readonly label: string;
  readonly description: string;
  readonly href: string;
};

export function DashboardSectionTabs({
  items,
  selectedSection,
}: {
  readonly items: readonly DashboardSectionTabItem[];
  readonly selectedSection: string;
}): React.ReactElement {
  return (
    <Tabs.Root value={selectedSection} orientation="vertical">
      <Tabs.List
        aria-label="Dashboard sections"
        activateOnFocus
        className="grid gap-1 border-l border-cyan-200/15 pl-3"
      >
        {items.map((item) => (
          <Tabs.Tab
            key={item.section}
            value={item.section}
            nativeButton={false}
            render={
              <a
                href={item.href}
                title={item.description}
                aria-current={
                  selectedSection === item.section ? "page" : undefined
                }
              />
            }
            className={({ active }) =>
              [
                "group relative -ml-[0.82rem] grid min-h-14 border-l-2 px-4 py-2.5 text-left transition duration-200 ease-out hover:translate-x-0.5 hover:saturate-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200 active:translate-x-0",
                active
                  ? "border-cyan-200 text-cyan-50"
                  : "border-transparent text-slate-300 hover:border-cyan-300/35 hover:text-cyan-50",
              ].join(" ")
            }
          >
            <span className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.16em]">
              {item.label}
            </span>
            <span className="mt-1 overflow-hidden text-xs leading-4 text-slate-500 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] group-hover:text-slate-300 group-data-[active]:text-cyan-100/80">
              {item.description}
            </span>
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs.Root>
  );
}
