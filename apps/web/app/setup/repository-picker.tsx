"use client";

import { useMemo, useState } from "react";
import { Badge } from "@reviewrouter/ui";
import { createSetupPullRequestAction } from "../dashboard/actions";
import { FormSubmitButton } from "../form-submit-button";

type SetupRepository = {
  readonly id: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly visibility: "public" | "private" | "internal" | string;
  readonly selected: boolean;
  readonly archived: boolean;
  readonly setupStatus: string;
  readonly setupPullRequestUrl: string | null;
};

export type RepositoryPickerProps = {
  readonly workspaceId: string;
  readonly installationId: string;
  readonly setupAction: string;
  readonly mutationsEnabled: boolean;
  readonly repositories: readonly SetupRepository[];
};

export function RepositoryPicker({
  workspaceId,
  installationId,
  setupAction,
  mutationsEnabled,
  repositories,
}: RepositoryPickerProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredRepositories = useMemo(
    () =>
      normalizedQuery
        ? repositories.filter((repository) =>
            [
              repository.fullName,
              repository.defaultBranch,
              repository.visibility,
              repository.setupStatus.replaceAll("_", " "),
            ]
              .join(" ")
              .toLowerCase()
              .includes(normalizedQuery),
          )
        : repositories,
    [normalizedQuery, repositories],
  );

  return (
    <div className="mt-5 grid gap-4">
      <label className="grid gap-2 text-sm text-slate-300">
        <span className="font-medium text-cyan-50">Find repository</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search by owner, repo, branch, visibility, or setup state"
          className="min-h-12 rounded-2xl border border-cyan-200/15 bg-slate-950/75 px-4 py-3 text-cyan-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] outline-none transition placeholder:text-slate-500 hover:border-cyan-200/30 focus:border-cyan-300/55 focus:ring-2 focus:ring-cyan-300/20"
          type="search"
        />
      </label>

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
        <span>
          Showing {filteredRepositories.length} of {repositories.length} synced
          repositories.
        </span>
        {query ? (
          <button
            type="button"
            className="font-semibold text-cyan-100 underline decoration-cyan-300/40 underline-offset-4"
            onClick={() => setQuery("")}
          >
            Clear search
          </button>
        ) : null}
      </div>

      {filteredRepositories.length === 0 ? (
        <div className="rounded-2xl border border-cyan-200/10 bg-slate-950/50 p-5 text-sm text-slate-300">
          No repositories match this search.
        </div>
      ) : (
        <div className="grid max-h-[42rem] gap-3 overflow-y-auto pr-1">
          {filteredRepositories.map((repository) => (
            <RepositoryRow
              key={repository.id}
              workspaceId={workspaceId}
              installationId={installationId}
              setupAction={setupAction}
              mutationsEnabled={mutationsEnabled}
              repository={repository}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RepositoryRow({
  workspaceId,
  installationId,
  setupAction,
  mutationsEnabled,
  repository,
}: {
  readonly workspaceId: string;
  readonly installationId: string;
  readonly setupAction: string;
  readonly mutationsEnabled: boolean;
  readonly repository: SetupRepository;
}): React.ReactElement {
  return (
    <div className="grid gap-4 rounded-2xl border border-cyan-200/10 bg-slate-950/60 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="min-w-0 truncate font-medium text-cyan-50">
            {repository.fullName}
          </p>
          <VisibilityBadge visibility={repository.visibility} />
          {repository.archived ? <Badge tone="warning">Archived</Badge> : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 font-mono text-slate-300">
            {repository.defaultBranch}
          </span>
          <span>{repository.setupStatus.replaceAll("_", " ")}</span>
          {!repository.selected ? <span>not selected</span> : null}
        </div>
        {repository.setupPullRequestUrl ? (
          <a
            className="mt-2 inline-flex text-xs font-semibold text-cyan-100 underline decoration-cyan-300/50 underline-offset-4"
            href={repository.setupPullRequestUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open existing setup PR
          </a>
        ) : null}
      </div>
      <form action={createSetupPullRequestAction}>
        <input type="hidden" name="returnTo" value="setup" />
        <input type="hidden" name="installation_id" value={installationId} />
        <input
          type="hidden"
          name="setup_action"
          value={setupAction || "install"}
        />
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="repositoryId" value={repository.id} />
        <FormSubmitButton
          size="sm"
          disabled={!mutationsEnabled || !repository.selected || repository.archived}
          idleLabel={setupPrButtonLabel(repository.setupStatus)}
          pendingLabel={
            repository.setupStatus === "setup_pr_open"
              ? "Updating setup PR..."
              : "Creating setup PR..."
          }
        />
      </form>
    </div>
  );
}

function VisibilityBadge({
  visibility,
}: {
  readonly visibility: SetupRepository["visibility"];
}): React.ReactElement {
  const normalized = visibility.toLowerCase();
  const isPrivate = normalized === "private";
  const isInternal = normalized === "internal";
  const icon = isPrivate ? "🔒" : isInternal ? "🏢" : "◎";
  const label = isPrivate ? "Private" : isInternal ? "Internal" : "Public";
  const tone = isPrivate ? "warning" : isInternal ? "accent" : "success";

  return (
    <Badge tone={tone} className="gap-1.5 px-2.5 py-1 text-[0.62rem]">
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </Badge>
  );
}

function setupPrButtonLabel(setupStatus: string): string {
  return setupStatus === "setup_pr_open"
    ? "Update setup PR"
    : "Create setup PR";
}
