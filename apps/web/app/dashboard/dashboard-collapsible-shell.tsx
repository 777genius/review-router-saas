"use client";

import { useState, type ReactElement, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@reviewrouter/ui";

export function DashboardCollapsibleShell({
  children,
  defaultCollapsed = false,
  nav,
}: {
  readonly children: ReactNode;
  readonly defaultCollapsed?: boolean;
  readonly nav: ReactNode;
}): ReactElement {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <div
      className={[
        "grid min-w-0 gap-5 transition-[grid-template-columns] duration-200 ease-out",
        collapsed
          ? "lg:grid-cols-[minmax(0,1fr)]"
          : "lg:grid-cols-[18rem_minmax(0,1fr)]",
      ].join(" ")}
    >
      <div
        id="dashboard-section-sidebar"
        className={["min-w-0", collapsed ? "hidden" : "block"].join(" ")}
      >
        {nav}
      </div>
      <div className="min-w-0">
        <div className="mb-3 flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-controls="dashboard-section-sidebar"
            aria-expanded={!collapsed}
            className="inline-flex items-center gap-2"
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" className="h-4 w-4" />
            ) : (
              <PanelLeftClose aria-hidden="true" className="h-4 w-4" />
            )}
            {collapsed ? "Show sidebar" : "Hide sidebar"}
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
