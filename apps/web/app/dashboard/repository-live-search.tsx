"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type RepositorySearchIndexItem = {
  readonly id: string;
  readonly searchText: string;
};

type SearchResponse = {
  readonly repositoryIds: readonly string[];
  readonly total: number;
  readonly query: string;
};

export function RepositoryLiveSearch({
  workspaceKey,
  selectedRepositoryFullName,
  initialQuery,
  totalCount,
  searchIndex,
}: {
  readonly workspaceKey: string;
  readonly selectedRepositoryFullName: string | null;
  readonly initialQuery: string;
  readonly totalCount: number;
  readonly searchIndex: readonly RepositorySearchIndexItem[];
}): React.ReactElement {
  const [query, setQuery] = useState(initialQuery);
  const [matchingIds, setMatchingIds] = useState<ReadonlySet<string>>(
    () => new Set(filterLocalSearch(searchIndex, initialQuery)),
  );
  const [state, setState] = useState<"idle" | "searching" | "error">("idle");
  const latestRequestId = useRef(0);
  const normalizedQuery = query.trim();
  const matchingCount = matchingIds.size;
  const hasActiveQuery = normalizedQuery.length > 0;

  useEffect(() => {
    applyRepositoryVisibility(matchingIds);
  }, [matchingIds]);

  useEffect(() => {
    const requestId = latestRequestId.current + 1;
    latestRequestId.current = requestId;
    const controller = new AbortController();

    updateSearchUrl({
      workspaceKey,
      selectedRepositoryFullName,
      query: normalizedQuery,
    });

    if (!hasActiveQuery) {
      setState("idle");
      setMatchingIds(new Set(searchIndex.map((item) => item.id)));
      return () => controller.abort();
    }

    setState("searching");
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams({
        workspace: workspaceKey,
        q: normalizedQuery,
      });
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
            new Set(filterLocalSearch(searchIndex, normalizedQuery)),
          );
          setState("error");
        });
    }, 280);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [
    hasActiveQuery,
    normalizedQuery,
    searchIndex,
    selectedRepositoryFullName,
    workspaceKey,
  ]);

  const helperText = useMemo(() => {
    if (state === "searching") return "Searching synced repositories...";
    if (state === "error") {
      return "Live API search is temporarily unavailable. Showing local matches.";
    }
    if (hasActiveQuery) {
      return `${matchingCount} matching ${matchingCount === 1 ? "repository" : "repositories"}.`;
    }
    return `Showing all ${totalCount} synced repositories. Type to filter without reloading the dashboard.`;
  }, [hasActiveQuery, matchingCount, state, totalCount]);

  return (
    <div className="grid gap-2" data-repository-live-search>
      <label className="grid gap-2">
        <span className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-500">
          Find repository
        </span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="owner/repo, branch, public, setup..."
          className="min-h-12 w-full rounded-2xl border border-cyan-200/15 bg-slate-950/80 px-4 py-3 text-sm text-cyan-50 outline-none transition placeholder:text-slate-600 hover:border-cyan-200/30 focus:border-cyan-300/55 focus:ring-2 focus:ring-cyan-300/20"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="flex min-h-7 flex-wrap items-center gap-3">
        <p
          className={[
            "text-xs leading-5",
            state === "error" ? "text-amber-100" : "text-slate-500",
          ].join(" ")}
          aria-live="polite"
        >
          {helperText}
        </p>
        {hasActiveQuery ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="inline-flex rounded-lg text-xs font-semibold text-cyan-100 underline decoration-cyan-300/50 underline-offset-4 transition hover:text-cyan-50"
          >
            Clear search
          </button>
        ) : null}
      </div>
      {hasActiveQuery && matchingCount === 0 ? (
        <div className="rounded-2xl border border-amber-300/20 bg-amber-300/[0.055] p-4">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-amber-100">
            No matches
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            No synced repository matches "{normalizedQuery}". Try owner/repo,
            branch, visibility, setup status, or refresh repositories from the
            Setup section if the repo was recently added.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function filterLocalSearch(
  searchIndex: readonly RepositorySearchIndexItem[],
  query: string,
): string[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return searchIndex.map((item) => item.id);
  return searchIndex
    .filter((item) => tokens.every((token) => item.searchText.includes(token)))
    .map((item) => item.id);
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

function updateSearchUrl({
  workspaceKey,
  selectedRepositoryFullName,
  query,
}: {
  readonly workspaceKey: string;
  readonly selectedRepositoryFullName: string | null;
  readonly query: string;
}): void {
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

  const nextUrl = `${window.location.pathname}?${params.toString()}`;
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (nextUrl !== currentUrl) {
    window.history.replaceState(null, "", nextUrl);
  }
}
