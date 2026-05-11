import type React from "react";
import { Badge } from "@reviewrouter/ui";
import type {
  MemoryDashboardItemDto,
  MemoryDashboardSuggestionDto,
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
  rejectMemorySuggestionAction,
} from "./actions";

export type MemoryManagementWorkspace = {
  readonly id: string;
};

export function MemoryManagementPanel({
  workspace,
  repositories,
  memoryItems,
  memorySuggestions,
  mutationsEnabled,
}: {
  readonly workspace: MemoryManagementWorkspace;
  readonly repositories: readonly MemoryDashboardRepositoryOption[];
  readonly memoryItems: readonly MemoryDashboardItemDto[];
  readonly memorySuggestions: readonly MemoryDashboardSuggestionDto[];
  readonly mutationsEnabled: boolean;
}): React.ReactElement {
  const viewModel = buildMemoryDashboardViewModel({
    repositories,
    memoryItems,
    memorySuggestions,
  });

  return (
    <section className="grid gap-4 xl:grid-cols-[14rem_minmax(0,1fr)_20rem]">
      <aside className="rounded-[1.25rem] border border-cyan-200/10 bg-slate-950/60 p-4">
        <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-cyan-100">
          Scope
        </p>
        <div className="mt-3 grid gap-2 text-sm">
          <MemoryScopeFilterRow
            label="Repository"
            count={viewModel.scopeCounts.repository}
          />
          <MemoryScopeFilterRow
            label="Workspace"
            count={viewModel.scopeCounts.workspace}
          />
          <MemoryScopeFilterRow
            label="User prefs"
            count={viewModel.scopeCounts.userPrefs}
          />
        </div>

        <div className="mt-5 border-t border-cyan-200/10 pt-4">
          <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Repositories
          </p>
          <div className="mt-3 grid gap-2">
            {viewModel.repositoryRows.map((repository) => (
              <MemoryRepositoryRow
                key={repository.id}
                label={repository.label}
                count={repository.count}
              />
            ))}
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
        <div className="rounded-[1.25rem] border border-cyan-200/10 bg-slate-950/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Badge tone="accent">Add memory</Badge>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                Maintainer-approved guidance only. Code, diffs, secrets, and
                prompts are blocked before storage.
              </p>
            </div>
            <Badge tone="neutral">{memoryItems.length} total</Badge>
          </div>
          <form action={createMemoryItemAction} className="mt-4 grid gap-3">
            <input type="hidden" name="workspaceId" value={workspace.id} />
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
                  defaultValue={viewModel.defaultRepository?.id ?? ""}
                  className="min-h-11 rounded-xl border border-cyan-200/10 bg-slate-950 px-3 text-sm normal-case tracking-normal text-cyan-50 outline-none transition focus:border-cyan-200/45"
                >
                  {viewModel.defaultRepository ? null : (
                    <option value="">No active repository</option>
                  )}
                  {viewModel.selectedRepositories.map((repository) => (
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
                disabled={!mutationsEnabled}
                idleLabel="Add memory"
                pendingLabel="Saving..."
              />
            </div>
          </form>
        </div>

        <div className="rounded-[1.25rem] border border-cyan-200/10 bg-slate-950/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Badge tone="warning">Pending</Badge>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                Model suggestions stay out of runtime context until a maintainer
                confirms them.
              </p>
            </div>
            <Badge tone="neutral">
              {viewModel.pendingSuggestionCount} pending
            </Badge>
          </div>
          <div className="mt-4 grid gap-3">
            {memorySuggestions.length === 0 ? (
              <p className="rounded-xl border border-cyan-200/10 bg-cyan-300/[0.04] p-4 text-sm text-slate-400">
                No pending suggestions.
              </p>
            ) : (
              memorySuggestions.map((suggestion) => (
                <MemorySuggestionRow
                  key={suggestion.id}
                  workspaceId={workspace.id}
                  suggestion={suggestion}
                  mutationsEnabled={mutationsEnabled}
                />
              ))
            )}
          </div>
        </div>

        <div className="rounded-[1.25rem] border border-cyan-200/10 bg-slate-950/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Badge tone="success">Confirmed</Badge>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                Approved memory available to retrieval, filtered by scope and
                repository.
              </p>
            </div>
            <Badge tone="neutral">{viewModel.activeItems.length} active</Badge>
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
                    Confidence
                  </th>
                  <th className="border-b border-cyan-200/10 px-3 py-2 font-semibold">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {memoryItems.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-3 py-5 text-center text-sm text-slate-400"
                    >
                      No confirmed memories yet.
                    </td>
                  </tr>
                ) : (
                  memoryItems.map((item) => (
                    <MemoryItemRow
                      key={item.id}
                      workspaceId={workspace.id}
                      item={item}
                      mutationsEnabled={mutationsEnabled}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <aside className="rounded-[1.25rem] border border-cyan-200/10 bg-slate-950/60 p-4">
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

          <div className="border-t border-cyan-200/10 pt-4">
            <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Details
            </p>
            {viewModel.firstDetail ? (
              <div className="mt-3 grid gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={memoryStatusTone(viewModel.firstDetail.status)}>
                    {viewModel.firstDetail.status}
                  </Badge>
                  <Badge tone="neutral">
                    {memoryScopeLabel(viewModel.firstDetail.scope)}
                  </Badge>
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
              </div>
            ) : (
              <p className="mt-3 text-sm leading-6 text-slate-400">
                Select or create memory to populate retrieval preview.
              </p>
            )}
          </div>
        </div>
      </aside>
    </section>
  );
}

function MemoryScopeFilterRow({
  label,
  count,
}: {
  readonly label: string;
  readonly count: number;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-cyan-200/10 bg-cyan-300/[0.04] px-3 py-2">
      <span className="min-w-0 truncate text-slate-300">{label}</span>
      <span className="font-mono text-xs font-semibold text-cyan-100">
        {count}
      </span>
    </div>
  );
}

function MemoryRepositoryRow({
  label,
  count,
}: {
  readonly label: string;
  readonly count: number;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="min-w-0 truncate text-slate-400">{label}</span>
      <span className="font-mono text-slate-500">{count}</span>
    </div>
  );
}

function MemorySuggestionRow({
  workspaceId,
  suggestion,
  mutationsEnabled,
}: {
  readonly workspaceId: string;
  readonly suggestion: MemoryDashboardSuggestionDto;
  readonly mutationsEnabled: boolean;
}): React.ReactElement {
  return (
    <div className="grid gap-3 rounded-xl border border-cyan-200/10 bg-cyan-300/[0.04] p-4 md:grid-cols-[minmax(0,1fr)_12rem]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={memoryRiskTone(suggestion.safety.riskLevel)}>
            {suggestion.safety.riskLevel}
          </Badge>
          <Badge tone="neutral">
            {memoryScopeLabel(suggestion.suggestedScope)}
          </Badge>
          {suggestion.isExpired ? <Badge tone="warning">Expired</Badge> : null}
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
            disabled={!mutationsEnabled || suggestion.isExpired}
            idleLabel="Approve"
            pendingLabel="Approving..."
          />
        </form>
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

function MemoryItemRow({
  workspaceId,
  item,
  mutationsEnabled,
}: {
  readonly workspaceId: string;
  readonly item: MemoryDashboardItemDto;
  readonly mutationsEnabled: boolean;
}): React.ReactElement {
  const mutable = mutationsEnabled && item.status !== "deleted";
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
        <Badge tone="neutral">{memoryScopeLabel(item.scope)}</Badge>
      </td>
      <td className="border-b border-cyan-200/10 px-3 py-3">
        <Badge tone={memoryStatusTone(item.status)}>{item.status}</Badge>
      </td>
      <td className="border-b border-cyan-200/10 px-3 py-3 font-mono text-xs text-cyan-100">
        {formatPercent(item.confidence)}
      </td>
      <td className="border-b border-cyan-200/10 px-3 py-3">
        <div className="flex flex-wrap gap-2">
          <form action={disableMemoryItemAction}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="memoryItemId" value={item.id} />
            <FormSubmitButton
              variant="outline"
              size="sm"
              disabled={!mutable || item.status === "disabled"}
              idleLabel="Disable"
              pendingLabel="Saving..."
            />
          </form>
          <form action={deleteMemoryItemAction}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="memoryItemId" value={item.id} />
            <FormSubmitButton
              variant="outline"
              size="sm"
              disabled={!mutable}
              idleLabel="Delete"
              pendingLabel="Deleting..."
            />
          </form>
        </div>
      </td>
    </tr>
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
