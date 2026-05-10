"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Globe2,
  ListFilter,
  LockKeyhole,
  Search,
  Wrench,
} from "lucide-react";

export type RepositorySearchFilter =
  | "all"
  | "private"
  | "public"
  | "needs_setup";

export type RepositorySearchIndexItem = {
  readonly id: string;
  readonly searchText: string;
  readonly visibility: string;
  readonly needsSetup: boolean;
};

type SearchResponse = {
  readonly repositoryIds: readonly string[];
  readonly total: number;
  readonly query: string;
  readonly filter: RepositorySearchFilter;
};

const repositoryFilterOptions = [
  { value: "all", label: "All", icon: ListFilter },
  { value: "private", label: "Private", icon: LockKeyhole },
  { value: "public", label: "Public", icon: Globe2 },
  { value: "needs_setup", label: "Needs setup", icon: Wrench },
] as const;

export function RepositoryLiveSearch({
  workspaceKey,
  selectedRepositoryFullName,
  initialQuery,
  initialFilter,
  searchIndex,
  totalRepositoryCount,
  renderedRepositoryCount,
  rowLimit,
}: {
  readonly workspaceKey: string;
  readonly selectedRepositoryFullName: string | null;
  readonly initialQuery: string;
  readonly initialFilter: RepositorySearchFilter;
  readonly searchIndex: readonly RepositorySearchIndexItem[];
  readonly totalRepositoryCount: number;
  readonly renderedRepositoryCount: number;
  readonly rowLimit: number;
}): React.ReactElement {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [activeFilter, setActiveFilter] =
    useState<RepositorySearchFilter>(initialFilter);
  const [matchingIds, setMatchingIds] = useState<ReadonlySet<string>>(
    () => new Set(filterLocalSearch(searchIndex, initialQuery, initialFilter)),
  );
  const [state, setState] = useState<"idle" | "searching" | "error">("idle");
  const latestRequestId = useRef(0);
  const normalizedQuery = query.trim();
  const matchingCount = matchingIds.size;
  const hasActiveQuery = normalizedQuery.length > 0;
  const hasActiveFilter = hasActiveQuery || activeFilter !== "all";
  const renderedCountLabel = Math.min(matchingCount, rowLimit);
  const helperText = useRepositorySearchHelperText({
    state,
    hasActiveQuery,
    activeFilter,
    matchingCount,
    renderedCountLabel,
    renderedRepositoryCount,
    rowLimit,
    totalRepositoryCount,
  });

  useEffect(() => {
    applyRepositoryVisibility(matchingIds);
  }, [matchingIds]);

  useEffect(() => {
    const requestId = latestRequestId.current + 1;
    latestRequestId.current = requestId;
    const controller = new AbortController();

    const nextUrl = buildSearchUrl({
      workspaceKey,
      selectedRepositoryFullName,
      query: normalizedQuery,
      filter: activeFilter,
    });

    if (!hasActiveQuery) {
      setState("idle");
      setMatchingIds(new Set(filterLocalSearch(searchIndex, "", activeFilter)));
      replaceSearchUrl(router, nextUrl);
      return () => controller.abort();
    }

    setState("searching");
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams({
        workspace: workspaceKey,
        q: normalizedQuery,
      });
      appendFilterParams(params, activeFilter);
      fetch(`/api/dashboard/repositories/search?${params.toString()}`, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`search_failed:${response.status}`);
          }
          return (await response.json()) as SearchResponse;
        })
        .then((payload) => {
          if (latestRequestId.current !== requestId) return;
          setMatchingIds(new Set(payload.repositoryIds));
          setState("idle");
          replaceSearchUrl(router, nextUrl);
        })
        .catch((error: unknown) => {
          if (
            controller.signal.aborted ||
            latestRequestId.current !== requestId
          ) {
            return;
          }
          console.warn(
            "ReviewRouter repository search fell back locally",
            error,
          );
          setMatchingIds(
            new Set(
              filterLocalSearch(searchIndex, normalizedQuery, activeFilter),
            ),
          );
          setState("error");
        });
    }, 280);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [
    activeFilter,
    hasActiveQuery,
    normalizedQuery,
    router,
    searchIndex,
    selectedRepositoryFullName,
    workspaceKey,
  ]);

  return (
    <section
      className="bg-transparent px-4 py-4 sm:px-5 sm:py-5 xl:px-7 xl:py-6"
      data-repository-live-search
    >
      <p className="mb-3 font-mono text-[0.62rem] font-semibold uppercase tracking-[0.22em] text-slate-500">
        Find repository
      </p>

      <div className="grid gap-3 xl:grid-cols-[minmax(20rem,1fr)_auto] xl:items-center">
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
            onChange={(event) => setQuery(event.target.value)}
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

        <div
          className="grid items-stretch gap-1 rounded-xl border border-slate-700/70 bg-slate-950/55 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] sm:h-11 sm:grid-cols-4"
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
                onClick={() => setActiveFilter(option.value)}
                className={[
                  "relative flex min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition duration-200 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan-200 sm:min-h-0 sm:h-full",
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

      {helperText || hasActiveFilter ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-4">
          {helperText ? (
            <p
              className={[
                "text-xs font-medium leading-5",
                state === "error" ? "text-amber-100" : "text-slate-500",
              ].join(" ")}
              aria-live="polite"
            >
              {helperText}
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
                }}
                className="inline-flex text-xs font-semibold text-cyan-200 transition hover:text-cyan-50"
              >
                Clear
              </button>
            </>
          ) : null}
        </div>
      ) : null}

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
}

function useRepositorySearchHelperText({
  state,
  hasActiveQuery,
  activeFilter,
  matchingCount,
  renderedCountLabel,
  renderedRepositoryCount,
  rowLimit,
  totalRepositoryCount,
}: {
  readonly state: "idle" | "searching" | "error";
  readonly hasActiveQuery: boolean;
  readonly activeFilter: RepositorySearchFilter;
  readonly matchingCount: number;
  readonly renderedCountLabel: number;
  readonly renderedRepositoryCount: number;
  readonly rowLimit: number;
  readonly totalRepositoryCount: number;
}): string {
  return useMemo(() => {
    if (state === "searching") return "Searching synced repositories...";
    if (state === "error") {
      return "Live API search is temporarily unavailable. Showing local matches.";
    }
    if (hasActiveQuery || activeFilter !== "all") {
      const label = repositoryFilterResultLabel(activeFilter);
      if (matchingCount > rowLimit) {
        return `${matchingCount} ${label}. Showing first ${renderedCountLabel}.`;
      }
      return `${matchingCount} ${label}.`;
    }
    if (renderedRepositoryCount < totalRepositoryCount) {
      return `Showing first ${renderedRepositoryCount} of ${totalRepositoryCount}. Search to load matching repositories.`;
    }
    return "";
  }, [
    activeFilter,
    hasActiveQuery,
    matchingCount,
    renderedCountLabel,
    renderedRepositoryCount,
    rowLimit,
    state,
    totalRepositoryCount,
  ]);
}

function repositoryFilterResultLabel(filter: RepositorySearchFilter): string {
  switch (filter) {
    case "private":
      return "private repositories";
    case "public":
      return "public repositories";
    case "needs_setup":
      return "repositories need setup";
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
      return item.needsSetup;
    case "all":
      return true;
  }
}

function tokenize(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function applyRepositoryVisibility(matchingIds: ReadonlySet<string>): void {
  document
    .querySelectorAll<HTMLElement>("[data-repository-row-id]")
    .forEach((element) => {
      const id = element.dataset.repositoryRowId;
      element.hidden = Boolean(id && !matchingIds.has(id));
    });
}

function buildSearchUrl({
  workspaceKey,
  selectedRepositoryFullName,
  query,
  filter,
}: {
  readonly workspaceKey: string;
  readonly selectedRepositoryFullName: string | null;
  readonly query: string;
  readonly filter: RepositorySearchFilter;
}): string {
  const params = new URLSearchParams(window.location.search);
  params.set("workspace", workspaceKey);
  params.set("section", "repositories");
  if (selectedRepositoryFullName) {
    params.set("repository", selectedRepositoryFullName);
  }
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
}

function replaceSearchUrl(
  router: ReturnType<typeof useRouter>,
  nextUrl: string,
): void {
  if (searchUrlMatchesCurrentPage(nextUrl)) return;

  router.replace(nextUrl, { scroll: false });
  router.refresh();
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
