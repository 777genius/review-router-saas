import type React from "react";
import {
  Badge,
  Button,
  DialogBackdrop,
  DialogClose,
  DialogDescription,
  DialogPopup,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
  LinkButton,
} from "@reviewrouter/ui";
import type {
  MemoryDashboardItemDto,
  MemoryDashboardSuggestionDto,
  MemoryPolicySimulationDecision,
} from "@reviewrouter/features-memory";
import { FormSubmitButton } from "../form-submit-button";
import {
  buildMemoryDashboardViewModel,
  type MemoryDashboardRepositoryOption,
} from "../../src/features/memory/application/memory-dashboard-view-model";
import {
  confirmMemorySuggestionAction,
  createMemoryItemAction,
  deleteMemoryItemAction,
  disableMemoryItemAction,
  editMemoryItemAction,
  rejectMemorySuggestionAction,
} from "./actions";

export type MemoryManagementWorkspace = {
  readonly id: string;
};

export type MemoryManagementMode = "knowledge" | "suggestions" | "table";

export type MemoryManagementNotice = {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tone: "info" | "warning" | "danger";
};

export type MemoryManagementModeLinks = Partial<
  Record<MemoryManagementMode, string>
>;

export function MemoryManagementPanel({
  workspace,
  repositories,
  memoryItems,
  memorySuggestions,
  mutationsEnabled,
  memoryWritesEnabled,
  policySimulation,
  mode = "knowledge",
  modeLinks,
  notices = [],
}: {
  readonly workspace: MemoryManagementWorkspace;
  readonly repositories: readonly MemoryDashboardRepositoryOption[];
  readonly memoryItems: readonly MemoryDashboardItemDto[];
  readonly memorySuggestions: readonly MemoryDashboardSuggestionDto[];
  readonly mutationsEnabled: boolean;
  readonly memoryWritesEnabled: boolean;
  readonly policySimulation?: readonly MemoryPolicySimulationDecision[] | null;
  readonly mode?: MemoryManagementMode;
  readonly modeLinks?: MemoryManagementModeLinks;
  readonly notices?: readonly MemoryManagementNotice[];
}): React.ReactElement {
  const writesEnabled = mutationsEnabled && memoryWritesEnabled;
  const viewModel = buildMemoryDashboardViewModel({
    repositories,
    memoryItems,
    memorySuggestions,
  });

  return (
    <section
      data-testid="memory-management-panel"
      className={[
        "grid gap-4",
        mode === "table"
          ? "xl:grid-cols-[14rem_minmax(0,1fr)]"
          : "xl:grid-cols-[14rem_minmax(0,1fr)_20rem]",
      ].join(" ")}
    >
      <aside
        data-testid="memory-scope-rail"
        className="rounded-[1.25rem] border border-cyan-200/10 bg-slate-950/60 p-4"
      >
        <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-cyan-100">
          Repositories
        </p>
        <label className="mt-3 block">
          <span className="sr-only">Search repositories</span>
          <input
            readOnly
            value=""
            placeholder="Search repositories..."
            className="min-h-10 w-full rounded-xl border border-cyan-200/10 bg-slate-950 px-3 text-sm text-cyan-50 outline-none placeholder:text-slate-600"
          />
        </label>
        <div className="mt-3 grid gap-2">
          {viewModel.repositoryRows.map((repository) => (
            <MemoryScopeFilterRow
              key={repository.id}
              label={repository.label}
              count={repository.count}
              selected={repository.id === "all"}
            />
          ))}
        </div>

        <div className="mt-5 border-t border-cyan-200/10 pt-4">
          <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Scope filter
          </p>
          <div className="mt-3 grid gap-2 text-sm">
            <MemoryScopeFilterRow
              label="All scopes"
              count={memoryItems.length}
              selected
            />
            <MemoryScopeFilterRow
              label="Workspace"
              count={viewModel.scopeCounts.workspace}
            />
            <MemoryScopeFilterRow
              label="Repository"
              count={viewModel.scopeCounts.repository}
            />
            <MemoryScopeFilterRow
              label="User prefs"
              count={viewModel.scopeCounts.userPrefs}
            />
          </div>
        </div>

        <div className="mt-5 border-t border-cyan-200/10 pt-4">
          <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Status
          </p>
          <div className="mt-3 grid gap-2">
            <MemoryScopeFilterRow
              label="Active"
              count={viewModel.activeItems.length}
            />
            <MemoryScopeFilterRow
              label="Disabled"
              count={viewModel.disabledItems.length}
            />
            <MemoryScopeFilterRow
              label="Expired"
              count={viewModel.expiredItems.length}
            />
          </div>
        </div>
      </aside>

      <div className="grid gap-4">
        <MemoryModeTabs
          mode={mode}
          activeCount={viewModel.activeItems.length}
          pendingCount={viewModel.pendingSuggestionCount}
          totalCount={memoryItems.length}
          links={modeLinks}
        />

        {!mutationsEnabled ? <MemoryReadOnlyBanner /> : null}
        {mutationsEnabled && !memoryWritesEnabled ? (
          <MemoryWritesDisabledBanner />
        ) : null}
        {notices.length > 0 ? <MemoryNoticeStack notices={notices} /> : null}

        {mode === "knowledge" ? (
          <>
            <MemoryKnowledgeToolbar
              activeCount={viewModel.activeItems.length}
              totalCount={memoryItems.length}
            />
            <MemoryAddMemoryForm
              workspaceId={workspace.id}
              repositories={viewModel.selectedRepositories}
              defaultRepositoryId={viewModel.defaultRepository?.id ?? ""}
              writesEnabled={writesEnabled}
              totalCount={memoryItems.length}
            />
            <MemoryKnowledgeList
              items={memoryItems}
              workspaceId={workspace.id}
              mutationsEnabled={mutationsEnabled}
              memoryWritesEnabled={memoryWritesEnabled}
            />
          </>
        ) : null}

        {mode === "suggestions" ? (
          <MemorySuggestionInbox
            workspaceId={workspace.id}
            suggestions={memorySuggestions}
            mutationsEnabled={mutationsEnabled}
            memoryWritesEnabled={memoryWritesEnabled}
            pendingCount={viewModel.pendingSuggestionCount}
          />
        ) : null}

        {mode === "table" ? (
          <MemoryConfirmedTable
            workspaceId={workspace.id}
            items={memoryItems}
            mutationsEnabled={mutationsEnabled}
            memoryWritesEnabled={memoryWritesEnabled}
            activeCount={viewModel.activeItems.length}
          />
        ) : null}
      </div>

      {mode === "table" ? null : (
        <aside
          id="memory-policy-panel"
          data-testid="memory-policy-panel"
          className="scroll-mt-28 rounded-[1.25rem] border border-cyan-200/10 bg-slate-950/60 p-4"
        >
          <div className="grid gap-4">
            <div>
              <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-cyan-100">
                Policy safeguards
              </p>
              <div className="mt-3 grid gap-3 text-sm leading-6 text-slate-300">
                <MemoryPolicyLine
                  title="Maintainer confirmation"
                  body="Project memory requires workspace admin or repository maintainer approval."
                />
                <MemoryPolicyLine
                  title="No code or diff stored"
                  body="Secrets, code blocks, diffs, stack traces, and prompt injection text are blocked."
                />
                <MemoryPolicyLine
                  title="Scoped retrieval"
                  body="Repository memory is not shared across repositories; user prefs are limited to safe response preferences."
                />
              </div>
            </div>

            {policySimulation && policySimulation.length > 0 ? (
              <MemoryPolicySimulator decisions={policySimulation} />
            ) : null}

            <div className="border-t border-cyan-200/10 pt-4">
              <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Details
              </p>
              {viewModel.firstDetail ? (
                <div className="mt-3 grid gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <MemoryBadge
                      tone={memoryStatusTone(viewModel.firstDetail.status)}
                    >
                      {viewModel.firstDetail.status}
                    </MemoryBadge>
                    <MemoryBadge tone="neutral">
                      {memoryScopeLabel(viewModel.firstDetail.scope)}
                    </MemoryBadge>
                    <MemoryBadge
                      tone={memoryIndexTone(viewModel.firstDetail.indexState)}
                    >
                      {memoryIndexLabel(viewModel.firstDetail.indexState)}
                    </MemoryBadge>
                  </div>
                  <p className="text-sm leading-6 text-cyan-50">
                    {viewModel.firstDetail.body}
                  </p>
                  <dl className="grid gap-2 text-xs text-slate-400">
                    <MemoryDetailStat
                      label="Confidence"
                      value={formatPercent(viewModel.firstDetail.confidence)}
                    />
                    <MemoryDetailStat
                      label="Source"
                      value={memorySourceLabel(viewModel.firstDetail.source)}
                    />
                    <MemoryDetailStat
                      label="Updated"
                      value={formatIsoDate(viewModel.firstDetail.updatedAt)}
                    />
                  </dl>
                  <div className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-xs leading-5 text-amber-100">
                    Privacy-first: only distilled memory is stored. Raw code,
                    diffs, prompts, and secrets are not saved.
                  </div>
                  <div className="rounded-xl border border-cyan-200/10 bg-cyan-300/[0.04] p-3 text-xs leading-5 text-slate-300">
                    Retrieval preview: scoped queries can include this memory
                    only after status, scope, and index checks pass.
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-sm leading-6 text-slate-400">
                  Select or create memory to populate retrieval preview.
                </p>
              )}
            </div>
          </div>
        </aside>
      )}
    </section>
  );
}

function MemoryBadge({
  className = "",
  ...props
}: React.ComponentProps<typeof Badge>): React.ReactElement {
  return (
    <Badge
      size="xs"
      className={["self-center cursor-default select-none", className].join(
        " ",
      )}
      {...props}
    />
  );
}

function MemoryAddMemoryForm({
  workspaceId,
  repositories,
  defaultRepositoryId,
  writesEnabled,
  totalCount,
}: {
  readonly workspaceId: string;
  readonly repositories: readonly MemoryDashboardRepositoryOption[];
  readonly defaultRepositoryId: string;
  readonly writesEnabled: boolean;
  readonly totalCount: number;
}): React.ReactElement {
  return (
    <div
      data-testid="memory-add-memory"
      className="rounded-[1.25rem] border border-cyan-200/10 bg-slate-950/60 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <MemoryBadge tone="accent">Add memory</MemoryBadge>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Maintainer-approved guidance only. Code, diffs, secrets, and prompts
            are blocked before storage.
          </p>
        </div>
        <MemoryBadge tone="neutral">{totalCount} total</MemoryBadge>
      </div>
      <form action={createMemoryItemAction} className="mt-4 grid gap-3">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <div className="grid gap-3 md:grid-cols-[12rem_minmax(0,1fr)]">
          <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
            Scope
            <select
              name="scope"
              defaultValue="workspace"
              className="min-h-11 rounded-xl border border-cyan-200/10 bg-slate-950 px-3 text-sm normal-case tracking-normal text-cyan-50 outline-none transition focus:border-cyan-200/45"
            >
              <option value="workspace">Workspace</option>
              <option value="repository">Repository</option>
              <option value="user_prefs">User prefs</option>
            </select>
          </label>
          <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
            Repository
            <select
              name="repositoryId"
              defaultValue={defaultRepositoryId}
              className="min-h-11 rounded-xl border border-cyan-200/10 bg-slate-950 px-3 text-sm normal-case tracking-normal text-cyan-50 outline-none transition focus:border-cyan-200/45"
            >
              {defaultRepositoryId ? null : (
                <option value="">No active repository</option>
              )}
              {repositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.fullName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
          Memory
          <textarea
            name="body"
            minLength={8}
            maxLength={1200}
            rows={3}
            placeholder="Prefer guard clauses in service layer methods."
            className="min-h-24 resize-y rounded-xl border border-cyan-200/10 bg-slate-950 px-3 py-2 text-sm normal-case leading-6 tracking-normal text-cyan-50 outline-none transition placeholder:text-slate-600 focus:border-cyan-200/45"
          />
        </label>
        <div className="flex justify-end">
          <FormSubmitButton
            variant="solid"
            size="sm"
            disabled={!writesEnabled}
            idleLabel="Add memory"
            pendingLabel="Saving..."
          />
        </div>
      </form>
    </div>
  );
}

function MemoryKnowledgeToolbar({
  activeCount,
  totalCount,
}: {
  readonly activeCount: number;
  readonly totalCount: number;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1.25rem] border border-cyan-200/10 bg-slate-950/60 p-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-normal text-cyan-50">
          All scopes
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          {totalCount} memories, {activeCount} active in retrieval.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <MemoryBadge tone="neutral">List</MemoryBadge>
        <MemoryBadge tone="success">Detail</MemoryBadge>
      </div>
    </div>
  );
}

function MemoryKnowledgeList({
  items,
  workspaceId,
  mutationsEnabled,
  memoryWritesEnabled,
}: {
  readonly items: readonly MemoryDashboardItemDto[];
  readonly workspaceId: string;
  readonly mutationsEnabled: boolean;
  readonly memoryWritesEnabled: boolean;
}): React.ReactElement {
  if (items.length === 0) {
    return (
      <div
        id="memory-knowledge-list"
        data-testid="memory-knowledge-list"
        className="scroll-mt-28 rounded-[1.25rem] border border-cyan-200/10 bg-slate-950/60 p-5 text-sm leading-6 text-slate-400"
      >
        No confirmed memories yet. The same management layout stays available
        while maintainers approve the first safe memory.
      </div>
    );
  }

  const sections = [
    {
      id: "workspace",
      label: "Workspace",
      items: items.filter((item) => item.scope === "workspace"),
    },
    {
      id: "repository",
      label: "Repository",
      items: items.filter((item) => item.scope === "repository"),
    },
    {
      id: "user_prefs",
      label: "User prefs",
      items: items.filter((item) => item.scope === "user_prefs"),
    },
  ].filter((section) => section.items.length > 0);

  return (
    <div
      id="memory-knowledge-list"
      data-testid="memory-knowledge-list"
      className="grid scroll-mt-28 gap-4"
    >
      {sections.map((section) => (
        <section
          key={section.id}
          className="rounded-[1.25rem] border border-cyan-200/10 bg-slate-950/60 p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-3 border-b border-cyan-200/10 pb-3">
            <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-400">
              {section.label}
            </p>
            <MemoryBadge tone="neutral">{section.items.length}</MemoryBadge>
          </div>
          <div className="grid gap-2">
            {section.items.map((item) => (
              <MemoryKnowledgeCard
                key={item.id}
                workspaceId={workspaceId}
                item={item}
                mutationsEnabled={mutationsEnabled}
                memoryWritesEnabled={memoryWritesEnabled}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function MemoryKnowledgeCard({
  workspaceId,
  item,
  mutationsEnabled,
  memoryWritesEnabled,
}: {
  readonly workspaceId: string;
  readonly item: MemoryDashboardItemDto;
  readonly mutationsEnabled: boolean;
  readonly memoryWritesEnabled: boolean;
}): React.ReactElement {
  return (
    <article className="grid gap-3 rounded-xl border border-cyan-200/10 bg-cyan-300/[0.04] p-4 md:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <MemoryBadge tone={memoryStatusTone(item.status)}>
            {item.status}
          </MemoryBadge>
          <MemoryBadge tone="neutral">
            {memoryScopeLabel(item.scope)}
          </MemoryBadge>
          <MemoryBadge tone={memoryRiskTone(item.riskLevel)}>
            {item.riskLevel}
          </MemoryBadge>
          <MemoryBadge tone={memoryIndexTone(item.indexState)}>
            {memoryIndexLabel(item.indexState)}
          </MemoryBadge>
        </div>
        <p className="mt-3 text-sm leading-6 text-cyan-50">{item.body}</p>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          {memorySourceLabel(item.source)} / updated{" "}
          {formatIsoDate(item.updatedAt)} / confidence{" "}
          {formatPercent(item.confidence)}
        </p>
      </div>
      <MemoryItemActionGroup
        workspaceId={workspaceId}
        item={item}
        mutationsEnabled={mutationsEnabled}
        memoryWritesEnabled={memoryWritesEnabled}
      />
    </article>
  );
}

function MemorySuggestionInbox({
  workspaceId,
  suggestions,
  mutationsEnabled,
  memoryWritesEnabled,
  pendingCount,
}: {
  readonly workspaceId: string;
  readonly suggestions: readonly MemoryDashboardSuggestionDto[];
  readonly mutationsEnabled: boolean;
  readonly memoryWritesEnabled: boolean;
  readonly pendingCount: number;
}): React.ReactElement {
  return (
    <div
      id="memory-suggestion-inbox"
      data-testid="memory-suggestion-inbox"
      className="scroll-mt-28 rounded-[1.25rem] border border-cyan-200/10 bg-slate-950/60 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <MemoryBadge tone="warning">Pending</MemoryBadge>
          <h2 className="mt-3 text-2xl font-semibold tracking-normal text-cyan-50">
            {pendingCount} pending suggestions
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-400">
            Model suggestions stay out of runtime context until a maintainer
            confirms them.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <MemoryBadge tone="neutral">Filters</MemoryBadge>
          <MemoryBadge tone="neutral">Sort newest</MemoryBadge>
        </div>
      </div>
      <div className="mt-4 grid gap-3">
        {suggestions.length === 0 ? (
          <p className="rounded-xl border border-cyan-200/10 bg-cyan-300/[0.04] p-4 text-sm text-slate-400">
            No pending suggestions.
          </p>
        ) : (
          suggestions.map((suggestion) => (
            <MemorySuggestionRow
              key={suggestion.id}
              workspaceId={workspaceId}
              suggestion={suggestion}
              mutationsEnabled={mutationsEnabled}
              memoryWritesEnabled={memoryWritesEnabled}
            />
          ))
        )}
      </div>
    </div>
  );
}

function MemoryConfirmedTable({
  workspaceId,
  items,
  mutationsEnabled,
  memoryWritesEnabled,
  activeCount,
}: {
  readonly workspaceId: string;
  readonly items: readonly MemoryDashboardItemDto[];
  readonly mutationsEnabled: boolean;
  readonly memoryWritesEnabled: boolean;
  readonly activeCount: number;
}): React.ReactElement {
  return (
    <div
      id="memory-confirmed-table"
      data-testid="memory-confirmed-table"
      className="scroll-mt-28 rounded-[1.25rem] border border-cyan-200/10 bg-slate-950/60 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <MemoryBadge tone="success">Confirmed</MemoryBadge>
          <h2 className="mt-3 text-2xl font-semibold tracking-normal text-cyan-50">
            {items.length} memories
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-400">
            Dense operational view for approved memory and retention actions.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <MemoryBadge tone="neutral">{activeCount} active</MemoryBadge>
          <LinkButton
            href={`/api/dashboard/memory/export?workspace=${encodeURIComponent(workspaceId)}`}
            variant="outline"
            size="sm"
          >
            Export JSON
          </LinkButton>
        </div>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full border-separate border-spacing-0 text-left text-sm">
          <thead className="text-xs uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="border-b border-cyan-200/10 px-3 py-2 font-semibold">
                Memory
              </th>
              <th className="border-b border-cyan-200/10 px-3 py-2 font-semibold">
                Scope
              </th>
              <th className="border-b border-cyan-200/10 px-3 py-2 font-semibold">
                Status
              </th>
              <th className="border-b border-cyan-200/10 px-3 py-2 font-semibold">
                Index
              </th>
              <th className="border-b border-cyan-200/10 px-3 py-2 font-semibold">
                Confidence
              </th>
              <th className="border-b border-cyan-200/10 px-3 py-2 font-semibold">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-5 text-center text-sm text-slate-400"
                >
                  No confirmed memories yet.
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <MemoryItemRow
                  key={item.id}
                  workspaceId={workspaceId}
                  item={item}
                  mutationsEnabled={mutationsEnabled}
                  memoryWritesEnabled={memoryWritesEnabled}
                />
              ))
            )}
          </tbody>
        </table>
        <MemoryTableFooter
          shownCount={items.length}
          totalCount={items.length}
        />
      </div>
    </div>
  );
}

function MemoryModeTabs({
  mode,
  activeCount,
  pendingCount,
  totalCount,
  links,
}: {
  readonly mode: MemoryManagementMode;
  readonly activeCount: number;
  readonly pendingCount: number;
  readonly totalCount: number;
  readonly links?: MemoryManagementModeLinks | undefined;
}): React.ReactElement {
  return (
    <div
      data-testid="memory-mode-tabs"
      className="grid gap-3 rounded-[1.25rem] border border-cyan-200/10 bg-slate-950/60 p-3 md:grid-cols-3"
    >
      <MemoryModeTab
        label="Knowledge"
        count={activeCount}
        selected={mode === "knowledge"}
        href={links?.knowledge}
      />
      <MemoryModeTab
        label="Pending"
        count={pendingCount}
        selected={mode === "suggestions"}
        href={links?.suggestions}
      />
      <MemoryModeTab
        label="Table"
        count={totalCount}
        selected={mode === "table"}
        href={links?.table}
      />
    </div>
  );
}

function MemoryModeTab({
  label,
  count,
  selected = false,
  href,
}: {
  readonly label: string;
  readonly count: number;
  readonly selected?: boolean;
  readonly href?: string | undefined;
}): React.ReactElement {
  const className = [
    "flex min-h-12 items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm font-semibold",
    selected
      ? "border-emerald-300/30 bg-emerald-300/10 text-emerald-100 shadow-[inset_0_-2px_0_rgba(110,231,183,0.75)]"
      : "border-cyan-200/10 bg-cyan-300/[0.035] text-slate-400",
  ].join(" ");
  const content = (
    <>
      <span>{label}</span>
      <span className="rounded-full border border-cyan-200/10 bg-slate-950 px-2 py-0.5 font-mono text-xs text-cyan-100">
        {count}
      </span>
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        aria-current={selected ? "page" : undefined}
        className={className}
      >
        {content}
      </a>
    );
  }

  return (
    <div aria-current={selected ? "page" : undefined} className={className}>
      {content}
    </div>
  );
}

function MemoryNoticeStack({
  notices,
}: {
  readonly notices: readonly MemoryManagementNotice[];
}): React.ReactElement {
  return (
    <div className="grid gap-3">
      {notices.map((notice) => (
        <div
          key={notice.id}
          className={[
            "rounded-[1.25rem] border p-4 text-sm leading-6",
            notice.tone === "danger"
              ? "border-rose-300/25 bg-rose-300/10 text-rose-100"
              : notice.tone === "warning"
                ? "border-amber-300/25 bg-amber-300/10 text-amber-100"
                : "border-cyan-200/10 bg-cyan-300/[0.04] text-slate-300",
          ].join(" ")}
        >
          <p className="font-semibold">{notice.title}</p>
          <p className="mt-1 text-xs leading-5 opacity-90">{notice.body}</p>
        </div>
      ))}
    </div>
  );
}

function MemoryReadOnlyBanner(): React.ReactElement {
  return (
    <div className="rounded-[1.25rem] border border-amber-300/25 bg-amber-300/10 p-4 text-sm leading-6 text-amber-100">
      Memory is in read-only mode for this workspace. You can review saved
      knowledge, but approve, reject, disable and delete actions require
      workspace admin or repository maintainer authority.
    </div>
  );
}

function MemoryWritesDisabledBanner(): React.ReactElement {
  return (
    <div className="rounded-[1.25rem] border border-amber-300/25 bg-amber-300/10 p-4 text-sm leading-6 text-amber-100">
      Balanced Memory writes are disabled for this workspace. Existing memory
      can still be exported, disabled, deleted, or rejected by authorized users.
    </div>
  );
}

function MemoryScopeFilterRow({
  label,
  count,
  selected = false,
}: {
  readonly label: string;
  readonly count: number;
  readonly selected?: boolean;
}): React.ReactElement {
  return (
    <div
      className={[
        "flex items-center justify-between gap-3 rounded-xl border px-3 py-2",
        selected
          ? "border-emerald-300/25 bg-emerald-300/10"
          : "border-cyan-200/10 bg-cyan-300/[0.04]",
      ].join(" ")}
    >
      <span className="min-w-0 truncate text-slate-300">{label}</span>
      <span className="font-mono text-xs font-semibold text-cyan-100">
        {count}
      </span>
    </div>
  );
}

function MemorySuggestionRow({
  workspaceId,
  suggestion,
  mutationsEnabled,
  memoryWritesEnabled,
}: {
  readonly workspaceId: string;
  readonly suggestion: MemoryDashboardSuggestionDto;
  readonly mutationsEnabled: boolean;
  readonly memoryWritesEnabled: boolean;
}): React.ReactElement {
  const confirmationEnabled = mutationsEnabled && memoryWritesEnabled;
  return (
    <div className="grid gap-3 rounded-xl border border-cyan-200/10 bg-cyan-300/[0.04] p-4 md:grid-cols-[minmax(0,1fr)_12rem]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <MemoryBadge tone={memoryRiskTone(suggestion.safety.riskLevel)}>
            {suggestion.safety.riskLevel}
          </MemoryBadge>
          <MemoryBadge tone="neutral">
            {memoryScopeLabel(suggestion.suggestedScope)}
          </MemoryBadge>
          {suggestion.isExpired ? (
            <MemoryBadge tone="warning">Expired</MemoryBadge>
          ) : null}
        </div>
        <p className="mt-3 text-sm leading-6 text-cyan-50">
          {suggestion.suggestedBody}
        </p>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          {memorySourceLabel(suggestion.source)} / {suggestion.reason} / expires{" "}
          {formatIsoDate(suggestion.expiresAt)}
        </p>
      </div>
      <div className="grid content-start gap-2">
        <form action={confirmMemorySuggestionAction}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="suggestionId" value={suggestion.id} />
          <FormSubmitButton
            variant="solid"
            size="sm"
            className="w-full"
            disabled={!confirmationEnabled || suggestion.isExpired}
            idleLabel="Approve"
            pendingLabel="Approving..."
          />
        </form>
        <MemorySuggestionEditConfirmDialog
          workspaceId={workspaceId}
          suggestion={suggestion}
          disabled={!confirmationEnabled || suggestion.isExpired}
        />
        <form action={rejectMemorySuggestionAction}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="suggestionId" value={suggestion.id} />
          <input type="hidden" name="reason" value="dashboard_reject" />
          <FormSubmitButton
            variant="outline"
            size="sm"
            className="w-full"
            disabled={!mutationsEnabled || suggestion.isExpired}
            idleLabel="Reject"
            pendingLabel="Rejecting..."
          />
        </form>
      </div>
    </div>
  );
}

function MemorySuggestionEditConfirmDialog({
  workspaceId,
  suggestion,
  disabled,
}: {
  readonly workspaceId: string;
  readonly suggestion: MemoryDashboardSuggestionDto;
  readonly disabled: boolean;
}): React.ReactElement {
  if (disabled) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled
        className="w-full"
      >
        Edit suggestion
      </Button>
    );
  }

  return (
    <DialogRoot>
      <DialogTrigger
        render={
          <Button type="button" variant="outline" size="sm" className="w-full">
            Edit suggestion
          </Button>
        }
      />
      <DialogPortal>
        <DialogBackdrop className="z-50" />
        <DialogPopup className="z-[60] border-amber-300/25 bg-[#061015]">
          <DialogTitle className="text-lg font-semibold text-cyan-50">
            Edit and approve suggestion
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm leading-6 text-slate-300">
            Confirmation uses the edited text only after permission, safety,
            scope and duplicate checks run again.
          </DialogDescription>
          <form
            action={confirmMemorySuggestionAction}
            className="mt-5 grid gap-4"
          >
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="suggestionId" value={suggestion.id} />
            <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
              Scope
              <select
                name="scope"
                defaultValue={suggestion.suggestedScope}
                className="min-h-11 rounded-xl border border-cyan-200/10 bg-slate-950 px-3 text-sm normal-case tracking-normal text-cyan-50 outline-none transition focus:border-cyan-200/45"
              >
                <option value="repository">Repository</option>
                <option value="workspace">Workspace</option>
                {suggestion.userId ? (
                  <option value="user_prefs">User prefs</option>
                ) : null}
              </select>
            </label>
            <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
              Memory
              <textarea
                name="body"
                minLength={8}
                maxLength={1200}
                rows={5}
                defaultValue={suggestion.suggestedBody}
                className="min-h-32 resize-y rounded-xl border border-cyan-200/10 bg-slate-950 px-3 py-2 text-sm normal-case leading-6 tracking-normal text-cyan-50 outline-none transition placeholder:text-slate-600 focus:border-cyan-200/45"
              />
            </label>
            <div className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-xs leading-5 text-amber-100">
              Pending suggestions are never used by runtime. Edited approval
              creates a new confirmed memory item and stores audit-safe hashes.
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <DialogClose
                render={
                  <Button type="button" variant="outline" size="sm">
                    Cancel
                  </Button>
                }
              />
              <FormSubmitButton
                variant="solid"
                size="sm"
                idleLabel="Approve edited"
                pendingLabel="Approving..."
              />
            </div>
          </form>
        </DialogPopup>
      </DialogPortal>
    </DialogRoot>
  );
}

function MemoryItemRow({
  workspaceId,
  item,
  mutationsEnabled,
  memoryWritesEnabled,
}: {
  readonly workspaceId: string;
  readonly item: MemoryDashboardItemDto;
  readonly mutationsEnabled: boolean;
  readonly memoryWritesEnabled: boolean;
}): React.ReactElement {
  return (
    <tr className="align-top text-slate-300">
      <td className="border-b border-cyan-200/10 px-3 py-3">
        <p className="max-w-md text-sm leading-6 text-cyan-50">{item.body}</p>
        <p className="mt-1 text-xs text-slate-500">
          {memorySourceLabel(item.source)} / updated{" "}
          {formatIsoDate(item.updatedAt)}
        </p>
      </td>
      <td className="border-b border-cyan-200/10 px-3 py-3">
        <MemoryBadge tone="neutral">{memoryScopeLabel(item.scope)}</MemoryBadge>
      </td>
      <td className="border-b border-cyan-200/10 px-3 py-3">
        <MemoryBadge tone={memoryStatusTone(item.status)}>
          {item.status}
        </MemoryBadge>
      </td>
      <td className="border-b border-cyan-200/10 px-3 py-3">
        <MemoryBadge tone={memoryIndexTone(item.indexState)}>
          {memoryIndexLabel(item.indexState)}
        </MemoryBadge>
      </td>
      <td className="border-b border-cyan-200/10 px-3 py-3 font-mono text-xs text-cyan-100">
        {formatPercent(item.confidence)}
      </td>
      <td className="border-b border-cyan-200/10 px-3 py-3">
        <MemoryItemActionGroup
          workspaceId={workspaceId}
          item={item}
          mutationsEnabled={mutationsEnabled}
          memoryWritesEnabled={memoryWritesEnabled}
        />
      </td>
    </tr>
  );
}

function MemoryItemActionGroup({
  workspaceId,
  item,
  mutationsEnabled,
  memoryWritesEnabled,
}: {
  readonly workspaceId: string;
  readonly item: MemoryDashboardItemDto;
  readonly mutationsEnabled: boolean;
  readonly memoryWritesEnabled: boolean;
}): React.ReactElement {
  const manageable = mutationsEnabled && item.status !== "deleted";
  const editable = manageable && memoryWritesEnabled;
  return (
    <div className="flex flex-wrap content-start items-start gap-2">
      <MemoryEditActionDialog
        workspaceId={workspaceId}
        item={item}
        disabled={!editable}
      />
      <MemoryDangerActionDialog
        action={disableMemoryItemAction}
        workspaceId={workspaceId}
        memoryItemId={item.id}
        expectedVersion={item.version}
        triggerLabel="Disable"
        pendingLabel="Disabling..."
        disabled={!manageable || item.status === "disabled"}
        title="Disable memory?"
        description="Disabled memory is removed from runtime retrieval, but kept in audit history and can be inspected later."
        confirmLabel="Disable memory"
      />
      <MemoryDangerActionDialog
        action={deleteMemoryItemAction}
        workspaceId={workspaceId}
        memoryItemId={item.id}
        expectedVersion={item.version}
        triggerLabel="Delete"
        pendingLabel="Deleting..."
        disabled={!manageable}
        title="Delete memory?"
        description="Deleted memory is removed from active management views and queued for retrieval index deletion. Audit records remain for accountability."
        confirmLabel="Delete memory"
      />
    </div>
  );
}

function MemoryEditActionDialog({
  workspaceId,
  item,
  disabled,
}: {
  readonly workspaceId: string;
  readonly item: MemoryDashboardItemDto;
  readonly disabled: boolean;
}): React.ReactElement {
  if (disabled) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled
        className="min-w-20"
      >
        Edit
      </Button>
    );
  }

  return (
    <DialogRoot>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-w-20"
          >
            Edit
          </Button>
        }
      />
      <DialogPortal>
        <DialogBackdrop className="z-50" />
        <DialogPopup className="z-[60] border-cyan-300/25 bg-[#061015]">
          <DialogTitle className="text-lg font-semibold text-cyan-50">
            Edit memory
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm leading-6 text-slate-300">
            Updates re-run safety checks and replace the current distilled
            memory text. Previous full body text is not stored in audit.
          </DialogDescription>
          <form action={editMemoryItemAction} className="mt-5 grid gap-4">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="memoryItemId" value={item.id} />
            <input type="hidden" name="expectedVersion" value={item.version} />
            <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
              Memory
              <textarea
                name="body"
                minLength={8}
                maxLength={1200}
                rows={5}
                defaultValue={item.body}
                className="min-h-32 resize-y rounded-xl border border-cyan-200/10 bg-slate-950 px-3 py-2 text-sm normal-case leading-6 tracking-normal text-cyan-50 outline-none transition placeholder:text-slate-600 focus:border-cyan-200/45"
              />
            </label>
            <div className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-xs leading-5 text-amber-100">
              Audit stores safe hashes, versions and scope only. It does not
              store old or new full memory body text.
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <DialogClose
                render={
                  <Button type="button" variant="outline" size="sm">
                    Cancel
                  </Button>
                }
              />
              <FormSubmitButton
                variant="solid"
                size="sm"
                idleLabel="Save changes"
                pendingLabel="Saving..."
              />
            </div>
          </form>
        </DialogPopup>
      </DialogPortal>
    </DialogRoot>
  );
}

function MemoryDangerActionDialog({
  action,
  workspaceId,
  memoryItemId,
  expectedVersion,
  triggerLabel,
  pendingLabel,
  disabled,
  title,
  description,
  confirmLabel,
}: {
  readonly action: (formData: FormData) => Promise<never>;
  readonly workspaceId: string;
  readonly memoryItemId: string;
  readonly expectedVersion: number;
  readonly triggerLabel: string;
  readonly pendingLabel: string;
  readonly disabled: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
}): React.ReactElement {
  if (disabled) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled
        className="min-w-20"
      >
        {triggerLabel}
      </Button>
    );
  }

  return (
    <DialogRoot>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-w-20"
          >
            {triggerLabel}
          </Button>
        }
      />
      <DialogPortal>
        <DialogBackdrop className="z-50" />
        <DialogPopup className="z-[60] border-rose-300/25 bg-[#061015]">
          <DialogTitle className="text-lg font-semibold text-cyan-50">
            {title}
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm leading-6 text-slate-300">
            {description}
          </DialogDescription>
          <form action={action} className="mt-5 grid gap-4">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="memoryItemId" value={memoryItemId} />
            <input
              type="hidden"
              name="expectedVersion"
              value={expectedVersion}
            />
            <div className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-xs leading-5 text-amber-100">
              This does not expose raw source comments, code, diffs, prompts or
              model output. Only the distilled memory record is changed.
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <DialogClose
                render={
                  <Button type="button" variant="outline" size="sm">
                    Cancel
                  </Button>
                }
              />
              <FormSubmitButton
                variant="solid"
                tone="danger"
                size="sm"
                idleLabel={confirmLabel}
                pendingLabel={pendingLabel}
              />
            </div>
          </form>
        </DialogPopup>
      </DialogPortal>
    </DialogRoot>
  );
}

function MemoryTableFooter({
  shownCount,
  totalCount,
}: {
  readonly shownCount: number;
  readonly totalCount: number;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-cyan-200/10 px-3 py-3 text-xs text-slate-400">
      <span>
        Showing {shownCount === 0 ? 0 : 1}-{shownCount} of {totalCount}
      </span>
      <div className="flex items-center gap-2">
        <span>Rows per page</span>
        <span className="rounded-lg border border-cyan-200/10 bg-slate-950 px-2 py-1 font-mono text-cyan-100">
          10
        </span>
      </div>
    </div>
  );
}

function MemoryPolicyLine({
  title,
  body,
}: {
  readonly title: string;
  readonly body: string;
}): React.ReactElement {
  return (
    <div className="rounded-xl border border-cyan-200/10 bg-cyan-300/[0.04] p-3">
      <p className="text-sm font-semibold text-cyan-50">{title}</p>
      <p className="mt-1 text-xs leading-5 text-slate-400">{body}</p>
    </div>
  );
}

function MemoryPolicySimulator({
  decisions,
}: {
  readonly decisions: readonly MemoryPolicySimulationDecision[];
}): React.ReactElement {
  return (
    <div className="border-t border-cyan-200/10 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Policy simulator
        </p>
        <MemoryBadge tone="neutral">Synthetic only</MemoryBadge>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-400">
        Admin-only dry run using the same policy, permission, safety and quota
        gates as real memory writes.
      </p>
      <div className="mt-3 grid gap-2">
        {decisions.map((decision) => (
          <div
            key={`${decision.action}:${decision.scope}:${decision.reason}`}
            className="rounded-xl border border-cyan-200/10 bg-cyan-300/[0.035] p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-cyan-50">
                {memoryPolicySimulationTitle(decision)}
              </p>
              <MemoryBadge
                tone={decision.allowed ? "success" : "danger"}
                className="tracking-[0.08em]"
              >
                {decision.allowed ? "Allow" : "Deny"}
              </MemoryBadge>
            </div>
            <dl className="mt-2 grid gap-1.5 text-xs leading-5 text-slate-400">
              <MemoryDetailStat
                label="Reason"
                value={memoryPolicyReasonLabel(decision.reason)}
              />
              <MemoryDetailStat
                label="Authority"
                value={memoryPolicyAuthorityLabel(decision.requiredAuthority)}
              />
              <MemoryDetailStat
                label="Safety"
                value={memoryPolicySafetyLabel(decision)}
              />
              <MemoryDetailStat
                label="Policy"
                value={`v${decision.policyVersion} ${decision.policyHash}`}
              />
              {decision.invalidates.length > 0 ? (
                <MemoryDetailStat
                  label="Affects"
                  value={decision.invalidates
                    .map(memoryPolicySurfaceLabel)
                    .join(", ")}
                />
              ) : null}
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}

function MemoryDetailStat({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt>{label}</dt>
      <dd className="min-w-0 truncate text-cyan-100">{value}</dd>
    </div>
  );
}

function memoryScopeLabel(scope: MemoryDashboardItemDto["scope"]): string {
  switch (scope) {
    case "repository":
      return "Repository";
    case "workspace":
      return "Workspace";
    case "user_prefs":
      return "User prefs";
  }
}

function memoryPolicySimulationTitle(
  decision: MemoryPolicySimulationDecision,
): string {
  const scope = memoryScopeLabel(decision.scope);
  switch (decision.action) {
    case "direct_save":
      return `${scope} write`;
    case "propose_suggestion":
      return `${scope} suggestion`;
    case "confirm_suggestion":
      return `${scope} approval`;
    case "edit_memory":
      return `${scope} edit`;
  }
}

function memoryPolicyReasonLabel(reason: string): string {
  switch (reason) {
    case "allowed":
      return "Allowed";
    case "memory_disabled":
      return "Memory disabled";
    case "memory_scope_forbidden":
      return "Scope forbidden";
    case "not_repository_maintainer":
      return "Maintainer required";
    case "not_workspace_admin":
      return "Workspace admin required";
    case "not_user_owner":
      return "User owner required";
    case "repository_unavailable":
      return "Repository unavailable";
    case "memory_active_item_quota_exceeded":
      return "Active quota exceeded";
    case "memory_pending_suggestion_quota_exceeded":
      return "Pending quota exceeded";
    case "contains_prompt_injection":
      return "Prompt injection blocked";
    case "contains_secret_like_text":
      return "Secret-like text blocked";
    case "contains_code_block":
      return "Code blocked";
    case "unsafe_for_user_prefs":
      return "Unsafe user preference";
    default:
      return reason.replaceAll("_", " ");
  }
}

function memoryPolicyAuthorityLabel(authority: string): string {
  switch (authority) {
    case "workspace_admin":
      return "Workspace admin";
    case "repository_maintainer_or_workspace_admin":
      return "Repo maintainer/admin";
    case "user_owner":
      return "User owner";
    case "safe_candidate_source":
      return "Safe candidate source";
    default:
      return authority.replaceAll("_", " ");
  }
}

function memoryPolicySafetyLabel(
  decision: MemoryPolicySimulationDecision,
): string {
  if (decision.safety.flags.length === 0) return decision.safety.severity;
  return `${decision.safety.severity}: ${decision.safety.flags
    .map((flag) => flag.replaceAll("_", " "))
    .join(", ")}`;
}

function memoryPolicySurfaceLabel(
  surface: MemoryPolicySimulationDecision["invalidates"][number],
): string {
  switch (surface) {
    case "runtime_bundle":
      return "runtime";
    case "pending_suggestions":
      return "pending";
    case "confirmed_memory":
      return "confirmed";
  }
}

function memoryStatusTone(
  status: MemoryDashboardItemDto["status"],
): "success" | "warning" | "danger" | "neutral" | "accent" {
  switch (status) {
    case "active":
      return "success";
    case "disabled":
      return "warning";
    case "expired":
      return "neutral";
    case "deleted":
      return "danger";
  }
}

function memoryRiskTone(
  risk: MemoryDashboardItemDto["riskLevel"],
): "success" | "warning" | "danger" | "neutral" | "accent" {
  switch (risk) {
    case "low":
      return "success";
    case "medium":
      return "warning";
    case "high":
    case "critical":
      return "danger";
  }
}

function memoryIndexTone(
  state: MemoryDashboardItemDto["indexState"],
): "success" | "warning" | "danger" | "neutral" | "accent" {
  switch (state) {
    case "indexed":
      return "success";
    case "index_pending":
    case "not_indexed":
      return "warning";
    case "index_failed":
      return "danger";
    case "index_deleted":
      return "neutral";
  }
}

function memoryIndexLabel(state: MemoryDashboardItemDto["indexState"]): string {
  switch (state) {
    case "not_indexed":
      return "Not indexed";
    case "index_pending":
      return "Index pending";
    case "indexed":
      return "Indexed";
    case "index_failed":
      return "Index failed";
    case "index_deleted":
      return "Index deleted";
  }
}

function memorySourceLabel(source: MemoryDashboardItemDto["source"]): string {
  const type = source.type.replaceAll("_", " ");
  if (source.githubPullRequestNumber) {
    return `PR #${source.githubPullRequestNumber}`;
  }
  if (source.actorLogin) {
    return `${type} by @${source.actorLogin}`;
  }
  return type;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatIsoDate(value: string): string {
  return value.slice(0, 10);
}
