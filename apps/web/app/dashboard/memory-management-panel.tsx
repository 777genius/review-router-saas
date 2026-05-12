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
} from "@reviewrouter/ui";
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
  editMemoryItemAction,
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
        <MemoryModeTabs
          activeCount={viewModel.activeItems.length}
          pendingCount={viewModel.pendingSuggestionCount}
        />

        {!mutationsEnabled ? <MemoryReadOnlyBanner /> : null}

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
            <MemoryTableFooter
              shownCount={memoryItems.length}
              totalCount={memoryItems.length}
            />
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

function MemoryModeTabs({
  activeCount,
  pendingCount,
}: {
  readonly activeCount: number;
  readonly pendingCount: number;
}): React.ReactElement {
  return (
    <div className="grid gap-3 rounded-[1.25rem] border border-cyan-200/10 bg-slate-950/60 p-3 md:grid-cols-3">
      <MemoryModeTab label="Confirmed" count={activeCount} selected />
      <MemoryModeTab label="Pending" count={pendingCount} />
      <MemoryModeTab label="Audit" count={0} />
    </div>
  );
}

function MemoryModeTab({
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
      aria-current={selected ? "page" : undefined}
      className={[
        "flex min-h-12 items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm font-semibold",
        selected
          ? "border-emerald-300/30 bg-emerald-300/10 text-emerald-100 shadow-[inset_0_-2px_0_rgba(110,231,183,0.75)]"
          : "border-cyan-200/10 bg-cyan-300/[0.035] text-slate-400",
      ].join(" ")}
    >
      <span>{label}</span>
      <span className="rounded-full border border-cyan-200/10 bg-slate-950 px-2 py-0.5 font-mono text-xs text-cyan-100">
        {count}
      </span>
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
        <MemorySuggestionEditConfirmDialog
          workspaceId={workspaceId}
          suggestion={suggestion}
          disabled={!mutationsEnabled || suggestion.isExpired}
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
  return (
    <DialogRoot>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className="w-full"
          >
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
          <form action={confirmMemorySuggestionAction} className="mt-5 grid gap-4">
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
          <MemoryEditActionDialog
            workspaceId={workspaceId}
            item={item}
            disabled={!mutable}
          />
          <MemoryDangerActionDialog
            action={disableMemoryItemAction}
            workspaceId={workspaceId}
            memoryItemId={item.id}
            expectedVersion={item.version}
            triggerLabel="Disable"
            pendingLabel="Disabling..."
            disabled={!mutable || item.status === "disabled"}
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
            disabled={!mutable}
            title="Delete memory?"
            description="Deleted memory is removed from active management views and queued for retrieval index deletion. Audit records remain for accountability."
            confirmLabel="Delete memory"
          />
        </div>
      </td>
    </tr>
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
  return (
    <DialogRoot>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
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
            <input
              type="hidden"
              name="expectedVersion"
              value={item.version}
            />
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
  return (
    <DialogRoot>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
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
