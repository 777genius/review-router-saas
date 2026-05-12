import type React from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  buildMemoryDashboardPreviewData,
  type MemoryDashboardPreviewScenario,
} from "../../../src/features/memory/application/memory-dashboard-preview-fixtures";
import {
  MemoryManagementPanel,
  type MemoryManagementMode,
  type MemoryManagementModeLinks,
  type MemoryManagementNotice,
} from "../memory-management-panel";
import { createNoIndexPageMetadata } from "../../seo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = createNoIndexPageMetadata({
  title: "Memory Preview",
  description:
    "No-index ReviewRouter memory management preview with deterministic safe fixtures.",
});

type MemoryPreviewPageProps = {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
};

export default async function MemoryPreviewPage({
  searchParams,
}: MemoryPreviewPageProps): Promise<React.ReactElement> {
  if (process.env.REVIEW_ROUTER_ENABLE_MEMORY_PREVIEW !== "1") {
    notFound();
  }

  const params = searchParams ? await searchParams : {};
  const mode = resolveMemoryMode(readParam(params.mode));
  const scenario = resolvePreviewScenario(readParam(params.state));
  const data = buildMemoryDashboardPreviewData({ scenario });

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 md:py-10">
      <section className="rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/62 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200">
              Memory management
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-normal text-cyan-50">
              Balanced memory preview
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
              Deterministic UI fixture for design QA. It uses only synthetic
              memory snippets and keeps the production dashboard auth path
              unchanged.
            </p>
          </div>
          <span className="rounded-full border border-cyan-200/10 bg-cyan-300/[0.04] px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-cyan-100">
            {scenario.replaceAll("_", " ")}
          </span>
        </div>
      </section>
      <MemoryManagementPanel
        workspace={data.workspace}
        repositories={data.repositories}
        memoryItems={data.memoryItems}
        memorySuggestions={data.memorySuggestions}
        mutationsEnabled={data.mutationsEnabled}
        memoryWritesEnabled={data.memoryWritesEnabled}
        mode={mode}
        modeLinks={buildPreviewModeLinks(scenario)}
        notices={buildPreviewNotices(scenario)}
      />
    </main>
  );
}

function resolveMemoryMode(value: string): MemoryManagementMode {
  if (value === "suggestions" || value === "table" || value === "knowledge") {
    return value;
  }
  return "knowledge";
}

function resolvePreviewScenario(value: string): MemoryDashboardPreviewScenario {
  if (
    value === "empty" ||
    value === "readonly" ||
    value === "writes_disabled" ||
    value === "over_quota" ||
    value === "stale_edit" ||
    value === "indexing_degraded"
  ) {
    return value;
  }
  return "normal";
}

function buildPreviewModeLinks(
  scenario: MemoryDashboardPreviewScenario,
): MemoryManagementModeLinks {
  return {
    knowledge: previewHref("knowledge", scenario),
    suggestions: previewHref("suggestions", scenario),
    table: previewHref("table", scenario),
  };
}

function previewHref(
  mode: MemoryManagementMode,
  scenario: MemoryDashboardPreviewScenario,
): string {
  const query = new URLSearchParams({ mode });
  if (scenario !== "normal") query.set("state", scenario);
  return `/dashboard/memory-preview?${query.toString()}`;
}

function buildPreviewNotices(
  scenario: MemoryDashboardPreviewScenario,
): readonly MemoryManagementNotice[] {
  switch (scenario) {
    case "over_quota":
      return [
        {
          id: "quota",
          tone: "warning",
          title: "Workspace memory quota is almost full",
          body: "Maintainers can still disable, delete, export and reject items. New approvals stay blocked until quota is freed or upgraded.",
        },
      ];
    case "stale_edit":
      return [
        {
          id: "stale-version",
          tone: "danger",
          title: "Memory changed before this edit was saved",
          body: "Reload the latest version, compare the distilled body, then retry. The stale update is not written.",
        },
      ];
    case "indexing_degraded":
      return [
        {
          id: "indexing",
          tone: "warning",
          title: "Retrieval index is degraded",
          body: "Confirmed memory remains visible and auditable. Failed index rows are excluded from runtime retrieval until the outbox retries succeed.",
        },
      ];
    case "empty":
    case "normal":
    case "readonly":
    case "writes_disabled":
      return [];
  }
}

function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value?.trim() ?? "";
}
