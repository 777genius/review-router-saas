"use client";

import { useRouter } from "next/navigation";
import { Children, useEffect, useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  CircleAlert,
  Globe2,
  ListFilter,
  LockKeyhole,
  Search,
  Wrench,
} from "lucide-react";
import { RepositorySetupRowDisclosureController } from "./repository-setup-optimistic-status";
import { GatewayRepositoryBatchTargetToggle } from "./gateway-repository-batch-controls";

export type RepositorySearchFilter =
  | "all"
  | "private"
  | "public"
  | "needs_setup"
  | "needs_attention"
  | "ready";

export type RepositorySearchIndexItem = {
  readonly id: string;
  readonly fullName: string;
  readonly sourceUrl: string | null;
  readonly searchText: string;
  readonly visibility: string;
  readonly readiness: "ready" | "needs_setup" | "needs_attention";
  readonly stargazersCount: number;
  readonly archived: boolean;
};

const repositoryFilterOptions = [
  { value: "all", label: "All", icon: ListFilter },
  { value: "private", label: "Private", icon: LockKeyhole },
  { value: "public", label: "Public", icon: Globe2 },
  { value: "needs_setup", label: "Needs setup", icon: Wrench },
  { value: "needs_attention", label: "Needs attention", icon: CircleAlert },
  { value: "ready", label: "Ready", icon: CheckCircle2 },
] as const;

export function RepositoryLiveSearch({
  workspaceKey,
  initialWorkspaceParam,
  selectedRepositoryFullName,
  selectedRepositoryId,
  initialQuery,
  initialFilter,
  searchIndex,
  totalRepositoryCount,
  rowLimit,
  richRowIds,
  children,
}: {
  readonly workspaceKey: string;
  readonly initialWorkspaceParam: string | null;
  readonly selectedRepositoryFullName: string | null;
  readonly selectedRepositoryId: string | null;
  readonly initialQuery: string;
  readonly initialFilter: RepositorySearchFilter;
  readonly searchIndex: readonly RepositorySearchIndexItem[];
  readonly totalRepositoryCount: number;
  readonly rowLimit: number;
  readonly richRowIds: readonly string[];
  readonly children: React.ReactNode;
}): React.ReactElement {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [activeFilter, setActiveFilter] =
    useState<RepositorySearchFilter>(initialFilter);
  const [pendingRepositoryId, setPendingRepositoryId] = useState<string | null>(
    null,
  );
  const normalizedQuery = query.trim();
  const matchingIds = useMemo(
    () => filterLocalSearch(searchIndex, normalizedQuery, activeFilter),
    [searchIndex, normalizedQuery, activeFilter],
  );
  const visibleIds = selectVisibleRepositoryIds(
    matchingIds,
    rowLimit,
    selectedRepositoryId,
  );
  const richRows = Children.toArray(children);
  const richRowById = new Map(
    richRowIds.map((id, index) => [id, richRows[index]] as const),
  );
  const visibleIdSet = new Set(visibleIds);
  const orderedIds = [
    ...visibleIds,
    ...richRowIds.filter((id) => !visibleIdSet.has(id)),
  ];
  const summaryById = new Map(searchIndex.map((item) => [item.id, item]));
  const matchingCount = matchingIds.length;
  const hasActiveQuery = normalizedQuery.length > 0;
  const hasActiveFilter = hasActiveQuery || activeFilter !== "all";
  const renderedCountLabel = visibleIds.length;
  const helperText = useRepositorySearchHelperText({
    hasActiveQuery,
    activeFilter,
    matchingCount,
    renderedCountLabel,
    renderedRepositoryCount: visibleIds.length,
    rowLimit,
    totalRepositoryCount,
  });

  useEffect(() => {
    if (!isCurrentRepositoryScope(workspaceKey, initialWorkspaceParam)) return;
    const nextUrl = buildSearchUrl({
      workspaceKey,
      query: normalizedQuery,
      filter: activeFilter,
    });

    if (!searchUrlMatchesCurrentPage(nextUrl)) {
      // Next copies its current history state when the patched API receives null.
      window.history.replaceState(null, "", nextUrl);
    }
  }, [activeFilter, initialWorkspaceParam, normalizedQuery, workspaceKey]);

  useEffect(() => {
    const restoreSearchFromUrl = () => {
      if (!isCurrentRepositoryScope(workspaceKey, initialWorkspaceParam))
        return;
      const params = new URLSearchParams(window.location.search);
      const restoredQuery = params.get("q") ?? "";
      const restoredFilter = readRepositorySearchFilter(params);
      setQuery(restoredQuery);
      setActiveFilter(restoredFilter);
      setPendingRepositoryId(null);
    };

    window.addEventListener("popstate", restoreSearchFromUrl);
    return () => window.removeEventListener("popstate", restoreSearchFromUrl);
  }, [initialWorkspaceParam, workspaceKey]);

  useEffect(() => {
    setPendingRepositoryId(null);
  }, [selectedRepositoryFullName, workspaceKey]);

  const searchControls = (
    <section
      className="border-b border-cyan-200/10 bg-transparent px-4 py-4 sm:px-5 sm:py-5 xl:px-7 xl:py-6"
      data-repository-live-search
    >
      <p className="mb-3 font-mono text-[0.62rem] font-semibold uppercase tracking-[0.22em] text-slate-500">
        Find repository
      </p>

      <div className="grid gap-3 xl:grid-cols-[minmax(20rem,1fr)_auto] xl:items-start">
        <div className="grid min-w-0 gap-2">
          <label className="relative block min-w-0">
            <span className="sr-only">Find repository</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              strokeWidth={2}
            />
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPendingRepositoryId(null);
              }}
              placeholder="repo, branch, setup status..."
              className="h-11 w-full rounded-xl border border-cyan-300/45 bg-slate-950/70 pl-10 pr-3 text-sm font-medium text-cyan-50 shadow-[0_0_44px_-34px_rgba(103,232,249,0.95),inset_0_1px_0_rgba(255,255,255,0.04)] outline-none transition placeholder:text-slate-600 hover:border-cyan-300/70 focus:border-cyan-200 focus:ring-2 focus:ring-cyan-300/20 2xl:pr-14"
              autoComplete="off"
              spellCheck={false}
            />
            <span
              aria-hidden="true"
              className="absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md border border-cyan-200/12 bg-cyan-200/[0.035] px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold text-slate-500 2xl:inline-flex"
            >
              ⌘ K
            </span>
          </label>

          {helperText || hasActiveFilter ? (
            <div className="flex flex-wrap items-center gap-3 px-1">
              {helperText ? (
                <p
                  className={[
                    "text-xs font-medium leading-5",
                    "text-slate-500",
                  ].join(" ")}
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <span>{helperText}</span>
                </p>
              ) : null}
              {hasActiveFilter ? (
                <>
                  {helperText ? (
                    <span
                      aria-hidden="true"
                      className="hidden h-3.5 w-px bg-slate-700/75 sm:block"
                    />
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setActiveFilter("all");
                      setPendingRepositoryId(null);
                    }}
                    className="inline-flex text-xs font-semibold text-cyan-200 transition hover:text-cyan-50"
                  >
                    Clear
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        <div
          className="grid items-stretch gap-1 rounded-xl border border-slate-700/70 bg-slate-950/55 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] sm:grid-cols-3 2xl:h-11 2xl:grid-cols-6"
          role="group"
          aria-label="Repository filters"
        >
          {repositoryFilterOptions.map((option) => {
            const selected = activeFilter === option.value;
            const Icon = option.icon;

            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  setActiveFilter(option.value);
                  setPendingRepositoryId(null);
                }}
                className={[
                  "relative flex min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition duration-200 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan-200 2xl:min-h-0 2xl:h-full",
                  selected
                    ? "bg-cyan-300/[0.08] text-cyan-100 ring-1 ring-inset ring-cyan-300/70 shadow-[0_0_45px_-32px_rgba(103,232,249,0.95)]"
                    : "text-slate-500 hover:bg-cyan-300/[0.035] hover:text-slate-300",
                ].join(" ")}
              >
                <Icon
                  aria-hidden="true"
                  className={[
                    "h-4 w-4 shrink-0",
                    selected ? "text-cyan-200" : "text-slate-500",
                  ].join(" ")}
                  strokeWidth={2.1}
                />
                <span className="whitespace-nowrap">{option.label}</span>
                {selected ? (
                  <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-cyan-200 text-slate-950">
                    <Check
                      aria-hidden="true"
                      className="h-2.5 w-2.5"
                      strokeWidth={3}
                    />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {hasActiveFilter && matchingCount === 0 ? (
        <div className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.055] p-3">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-amber-100">
            No matches
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            No synced repository matches
            {normalizedQuery ? ` "${normalizedQuery}"` : " these filters"}. Try
            repo name, branch, visibility, setup status, or refresh repositories
            from the Setup section if the repo was recently added.
          </p>
        </div>
      ) : null}
    </section>
  );

  return (
    <>
      {searchControls}
      <div data-repository-results className="grid text-slate-200">
        <RepositorySetupRowDisclosureController />
        {orderedIds.map((id) => {
          const richRow = richRowById.get(id);
          if (richRow) {
            return (
              <div
                key={id}
                hidden={!visibleIdSet.has(id)}
                data-repository-result-slot
              >
                <GatewayRepositoryBatchTargetToggle repositoryId={id} />
                {richRow}
              </div>
            );
          }
          const item = summaryById.get(id);
          return item ? (
            <div key={id} data-repository-result-slot>
              <GatewayRepositoryBatchTargetToggle repositoryId={id} />
              <RepositorySummaryRow
                item={item}
                pending={pendingRepositoryId === id}
                selected={id === selectedRepositoryId}
                onOpen={() => {
                  setPendingRepositoryId(id);
                  router.replace(
                    buildRepositorySelectionUrl(workspaceKey, item.fullName),
                    { scroll: false },
                  );
                }}
              />
            </div>
          ) : null;
        })}
      </div>
    </>
  );
}

function useRepositorySearchHelperText({
  hasActiveQuery,
  activeFilter,
  matchingCount,
  renderedCountLabel,
  renderedRepositoryCount,
  rowLimit,
  totalRepositoryCount,
}: {
  readonly hasActiveQuery: boolean;
  readonly activeFilter: RepositorySearchFilter;
  readonly matchingCount: number;
  readonly renderedCountLabel: number;
  readonly renderedRepositoryCount: number;
  readonly rowLimit: number;
  readonly totalRepositoryCount: number;
}): string {
  return useMemo(() => {
    return buildRepositorySearchHelperText({
      hasActiveQuery,
      activeFilter,
      matchingCount,
      renderedCountLabel,
      renderedRepositoryCount,
      rowLimit,
      totalRepositoryCount,
    });
  }, [
    activeFilter,
    hasActiveQuery,
    matchingCount,
    renderedCountLabel,
    renderedRepositoryCount,
    rowLimit,
    totalRepositoryCount,
  ]);
}

export function buildRepositorySearchHelperText({
  hasActiveQuery,
  activeFilter,
  matchingCount,
  renderedCountLabel,
  renderedRepositoryCount,
  rowLimit,
  totalRepositoryCount,
}: {
  readonly hasActiveQuery: boolean;
  readonly activeFilter: RepositorySearchFilter;
  readonly matchingCount: number;
  readonly renderedCountLabel: number;
  readonly renderedRepositoryCount: number;
  readonly rowLimit: number;
  readonly totalRepositoryCount: number;
}): string {
  if (hasActiveQuery || activeFilter !== "all") {
    const label = repositoryFilterResultLabel(activeFilter);
    if (matchingCount > rowLimit) {
      return `${matchingCount} ${label}. Showing ${renderedCountLabel} rows.`;
    }
    return `${matchingCount} ${label}.`;
  }
  if (renderedRepositoryCount < totalRepositoryCount) {
    return `Showing ${renderedRepositoryCount} of ${totalRepositoryCount}. Search or filter to find a repository.`;
  }
  return "";
}

function repositoryFilterResultLabel(filter: RepositorySearchFilter): string {
  switch (filter) {
    case "private":
      return "private repositories";
    case "public":
      return "public repositories";
    case "needs_setup":
      return "repositories need setup";
    case "needs_attention":
      return "repositories need attention";
    case "ready":
      return "ready repositories";
    case "all":
      return "matching repositories";
  }
}

function filterLocalSearch(
  searchIndex: readonly RepositorySearchIndexItem[],
  query: string,
  filter: RepositorySearchFilter,
): string[] {
  const tokens = tokenize(query);
  return searchIndex
    .filter(
      (item) =>
        repositoryMatchesFilter(item, filter) &&
        tokens.every((token) => item.searchText.includes(token)),
    )
    .map((item) => item.id);
}

function repositoryMatchesFilter(
  item: RepositorySearchIndexItem,
  filter: RepositorySearchFilter,
): boolean {
  switch (filter) {
    case "private":
      return item.visibility === "private";
    case "public":
      return item.visibility === "public";
    case "needs_setup":
      return item.readiness === "needs_setup";
    case "needs_attention":
      return item.readiness === "needs_attention";
    case "ready":
      return item.readiness === "ready";
    case "all":
      return true;
  }
}

function tokenize(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function selectVisibleRepositoryIds(
  matchingIds: readonly string[],
  rowLimit: number,
  selectedRepositoryId: string | null,
): string[] {
  if (rowLimit <= 0) return [];
  const firstPage = matchingIds.slice(0, rowLimit);
  if (
    selectedRepositoryId &&
    matchingIds.includes(selectedRepositoryId) &&
    !firstPage.includes(selectedRepositoryId)
  ) {
    return [selectedRepositoryId, ...firstPage.slice(0, rowLimit - 1)];
  }
  return firstPage;
}

function RepositorySummaryRow({
  item,
  pending,
  selected,
  onOpen,
}: {
  readonly item: RepositorySearchIndexItem;
  readonly pending: boolean;
  readonly selected: boolean;
  readonly onOpen: () => void;
}): React.ReactElement {
  const readinessLabel = {
    ready: "Ready",
    needs_setup: "Needs setup",
    needs_attention: "Needs attention",
  }[item.readiness];

  return (
    <div
      data-repository-row-id={item.id}
      data-repository-summary-row
      className={[
        "grid gap-2 border-t border-cyan-200/10 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center lg:px-6",
        selected ? "bg-cyan-300/[0.045]" : "hover:bg-cyan-300/[0.035]",
      ].join(" ")}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {item.sourceUrl ? (
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="break-words text-sm font-semibold text-cyan-50 hover:underline"
            >
              {item.fullName}
            </a>
          ) : (
            <span className="break-words text-sm font-semibold text-cyan-50">
              {item.fullName}
            </span>
          )}
          <span className="text-xs text-slate-400">{item.visibility}</span>
          {item.archived ? (
            <span className="text-xs text-amber-200">Archived</span>
          ) : null}
          {item.stargazersCount > 0 ? (
            <span className="text-xs text-amber-200">
              {item.stargazersCount} stars
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-slate-400">{readinessLabel}</p>
      </div>
      <button
        type="button"
        onClick={onOpen}
        disabled={pending}
        aria-label={`Open setup/settings for ${item.fullName}`}
        className="w-fit rounded-lg border border-cyan-300/35 px-3 py-2 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-300/[0.08] disabled:cursor-wait disabled:opacity-70"
      >
        {pending ? "Opening..." : "Open setup/settings"}
      </button>
    </div>
  );
}

function buildRepositorySelectionUrl(
  workspaceKey: string,
  fullName: string,
): string {
  const params = new URLSearchParams(window.location.search);
  params.set("workspace", workspaceKey);
  params.set("section", "repositories");
  params.set("repository", fullName);
  return `${window.location.pathname}?${params.toString()}`;
}

function isCurrentRepositoryScope(
  workspaceKey: string,
  initialWorkspaceParam: string | null,
): boolean {
  if (window.location.pathname !== "/dashboard") return false;
  const params = new URLSearchParams(window.location.search);
  const section = params.get("section");
  if (section && section !== "repositories") return false;
  const workspace = params.get("workspace");
  if (!workspace) return !initialWorkspaceParam;
  return workspace === workspaceKey || workspace === initialWorkspaceParam;
}

function buildSearchUrl({
  workspaceKey,
  query,
  filter,
}: {
  readonly workspaceKey: string;
  readonly query: string;
  readonly filter: RepositorySearchFilter;
}): string {
  const params = new URLSearchParams(window.location.search);
  params.set("workspace", workspaceKey);
  params.set("section", "repositories");
  if (query) {
    params.set("q", query);
  } else {
    params.delete("q");
  }
  appendFilterParams(params, filter);

  return `${window.location.pathname}?${params.toString()}`;
}

function appendFilterParams(
  params: URLSearchParams,
  filter: RepositorySearchFilter,
): void {
  params.delete("visibility");
  params.delete("setup");

  if (filter === "private" || filter === "public") {
    params.set("visibility", filter);
  }
  if (filter === "needs_setup") {
    params.set("setup", "needed");
  }
  if (filter === "needs_attention") {
    params.set("setup", "attention");
  }
  if (filter === "ready") {
    params.set("setup", "ready");
  }
}

function searchUrlMatchesCurrentPage(nextUrl: string): boolean {
  const current = new URL(window.location.href);
  const next = new URL(nextUrl, window.location.origin);
  if (current.pathname !== next.pathname) return false;

  return [
    "workspace",
    "section",
    "repository",
    "q",
    "visibility",
    "setup",
  ].every(
    (key) =>
      (current.searchParams.get(key) ?? "") ===
      (next.searchParams.get(key) ?? ""),
  );
}

function readRepositorySearchFilter(
  params: URLSearchParams,
): RepositorySearchFilter {
  switch (params.get("setup")) {
    case "needed":
      return "needs_setup";
    case "attention":
      return "needs_attention";
    case "ready":
      return "ready";
  }
  const visibility = params.get("visibility");
  return visibility === "private" || visibility === "public"
    ? visibility
    : "all";
}
