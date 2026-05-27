// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRepositorySearchHelperText,
  RepositoryLiveSearch,
  type RepositorySearchIndexItem,
} from "./repository-live-search";

const routerMock = vi.hoisted(() => ({
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const baseInput = {
  activeFilter: "all" as const,
  hasActiveQuery: false,
  isSearchLoading: false,
  matchingCount: 37,
  renderedCountLabel: 24,
  renderedRepositoryCount: 24,
  rowLimit: 24,
  totalRepositoryCount: 60,
};

describe("buildRepositorySearchHelperText", () => {
  it("does not show optimistic match counts while updated repository rows load", () => {
    expect(
      buildRepositorySearchHelperText({
        ...baseInput,
        hasActiveQuery: true,
        isSearchLoading: true,
      }),
    ).toBe("Loading updated results...");
  });

  it("shows match counts once repository rows are ready", () => {
    expect(
      buildRepositorySearchHelperText({
        ...baseInput,
        hasActiveQuery: true,
      }),
    ).toBe("37 matching repositories. Showing first 24.");
  });

  it("keeps newly typed searches in loading state until server rows catch up", () => {
    renderRepositoryLiveSearch();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Find repository" }),
      {
        target: { value: "p" },
      },
    );

    expect(screen.getByText("Loading updated results...")).toBeTruthy();
    expect(document.body.textContent).not.toContain("37 matching repositories");
  });
});

function renderRepositoryLiveSearch(): void {
  render(
    <div data-repository-table>
      <RepositoryLiveSearch
        workspaceKey="workspace_1"
        selectedRepositoryFullName={null}
        initialQuery=""
        initialFilter="all"
        searchIndex={repositorySearchIndex()}
        totalRepositoryCount={37}
        renderedRepositoryCount={2}
        rowLimit={24}
      />
      <div data-repository-search-loader hidden />
      <div data-repository-results>
        <div data-repository-row-id="repo_1">repo 1</div>
        <div data-repository-row-id="repo_2">repo 2</div>
      </div>
    </div>,
  );
}

function repositorySearchIndex(): RepositorySearchIndexItem[] {
  return Array.from({ length: 37 }, (_, index) => ({
    id: `repo_${index + 1}`,
    searchText: `personal/project-${index + 1}`,
    visibility: "private",
    readiness: "ready",
  }));
}
