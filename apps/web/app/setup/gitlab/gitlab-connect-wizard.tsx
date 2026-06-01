"use client";

import { useMemo, useState } from "react";
import { Badge, Button, CodeBlock, LinkButton } from "@reviewrouter/ui";

type GitLabProject = {
  readonly projectId: string;
  readonly fullName: string;
  readonly name: string;
  readonly defaultBranch: string | null;
  readonly webUrl: string | null;
  readonly visibility?: "public" | "internal" | "private" | undefined;
  readonly archived: boolean;
};

type DiscoveryResult = {
  readonly source: {
    readonly inputPath: string;
    readonly resolvedKind: "group" | "project";
    readonly baseUrl: string;
    readonly parentGroupPath: string | null;
  };
  readonly projects: readonly GitLabProject[];
};

type InstallResult = {
  readonly installationId: string;
  readonly namespacePath: string;
  readonly requested: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly setupMergeRequests: readonly {
    readonly projectId: string;
    readonly mergeRequestUrl: string;
  }[];
};

type CodexCommandResult = {
  readonly command: string;
  readonly secretName: "CODEX_AUTH_JSON";
  readonly sendsSecretToReviewRouter: false;
  readonly targetLabel: string;
};

type Phase = "discover" | "select" | "installing" | "result";

export function GitLabConnectWizard({
  initialSourceUrl = "",
  workspaceId,
}: {
  readonly initialSourceUrl?: string;
  readonly workspaceId: string;
}): React.ReactElement {
  const [sourceUrl, setSourceUrl] = useState(initialSourceUrl);
  const [token, setToken] = useState("");
  const [phase, setPhase] = useState<Phase>("discover");
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [installResult, setInstallResult] = useState<InstallResult | null>(
    null,
  );
  const [codexCommand, setCodexCommand] = useState<CodexCommandResult | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const selectedCount = selectedProjectIds.size;
  const selectedProjects = useMemo(
    () =>
      discovery?.projects.filter((project) =>
        selectedProjectIds.has(project.projectId),
      ) ?? [],
    [discovery, selectedProjectIds],
  );

  async function discover(): Promise<void> {
    setError(null);
    setPhase("discover");
    try {
      const result = await postJson<DiscoveryResult>(
        "/api/dashboard/gitlab/discover",
        { workspaceId, sourceUrl, token },
      );
      setDiscovery(result);
      setSelectedProjectIds(
        new Set(result.projects.map((project) => project.projectId)),
      );
      setPhase("select");
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function install(): Promise<void> {
    setError(null);
    setPhase("installing");
    try {
      const result = await postJson<InstallResult>(
        "/api/dashboard/gitlab/install",
        {
          workspaceId,
          sourceUrl,
          token,
          selectedProjectIds: [...selectedProjectIds],
        },
      );
      setToken("");
      setInstallResult(result);
      setCodexCommand(null);
      setPhase("result");
      void loadCodexCommand(result.installationId);
    } catch (caught) {
      setPhase(shouldReturnToTokenInput(caught) ? "discover" : "select");
      setError(errorText(caught));
    }
  }

  async function loadCodexCommand(installationId: string): Promise<void> {
    try {
      setCodexCommand(
        await postJson<CodexCommandResult>(
          "/api/dashboard/gitlab/codex-command",
          { workspaceId, installationId },
        ),
      );
    } catch {
      setCodexCommand(null);
    }
  }

  return (
    <section className="rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/62 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <StepBadge active={phase === "discover"} done={phase !== "discover"}>
          1. Discover
        </StepBadge>
        <StepBadge
          active={phase === "select"}
          done={phase === "installing" || phase === "result"}
        >
          2. Select
        </StepBadge>
        <StepBadge active={phase === "installing"} done={phase === "result"}>
          3. Install
        </StepBadge>
      </div>

      {phase === "discover" ? (
        <div className="mt-6 grid gap-5">
          <FieldLabel htmlFor="gitlab-source-url">
            Paste your GitLab group or project URL
          </FieldLabel>
          <input
            id="gitlab-source-url"
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            placeholder="https://gitlab.com/acme/platform"
            className="min-h-12 rounded-xl border border-cyan-200/15 bg-slate-950/70 px-4 text-cyan-50 outline-none transition placeholder:text-slate-600 focus:border-cyan-200/45 focus:ring-2 focus:ring-cyan-300/20"
          />

          <FieldLabel htmlFor="gitlab-access-token">
            GitLab access token
          </FieldLabel>
          <input
            id="gitlab-access-token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            type="password"
            autoComplete="off"
            placeholder="glpat-..."
            className="min-h-12 rounded-xl border border-cyan-200/15 bg-slate-950/70 px-4 text-cyan-50 outline-none transition placeholder:text-slate-600 focus:border-cyan-200/45 focus:ring-2 focus:ring-cyan-300/20"
          />
          <p className="-mt-2 text-xs leading-5 text-slate-500">
            Token is used only for this request. ReviewRouter does not store it.
          </p>

          {error ? <ErrorNotice message={error} /> : null}

          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              onClick={() => void discover()}
              disabled={!sourceUrl.trim() || !token.trim()}
              className="rounded-xl"
            >
              Discover repositories
            </Button>
            <LinkButton href="/dashboard" variant="outline">
              Back to dashboard
            </LinkButton>
          </div>
        </div>
      ) : null}

      {phase === "select" && discovery ? (
        <div className="mt-6 grid gap-5">
          <div>
            <Badge tone="success">
              {discovery.source.resolvedKind === "group"
                ? "Group discovered"
                : "Project discovered"}
            </Badge>
            <h2 className="mt-3 text-2xl font-semibold text-cyan-50">
              Select repositories
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              Found {discovery.projects.length} project
              {discovery.projects.length === 1 ? "" : "s"} under{" "}
              <code>{discovery.source.inputPath}</code>.
            </p>
          </div>

          <div className="grid max-h-[28rem] gap-2 overflow-y-auto rounded-2xl border border-cyan-200/10 bg-slate-950/50 p-2">
            {discovery.projects.map((project) => (
              <label
                key={project.projectId}
                className="grid cursor-pointer gap-3 rounded-xl border border-cyan-200/10 bg-cyan-300/[0.035] p-3 transition hover:border-cyan-200/25 hover:bg-cyan-300/[0.065] sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
              >
                <input
                  type="checkbox"
                  checked={selectedProjectIds.has(project.projectId)}
                  onChange={() => toggleProject(project.projectId)}
                  className="mt-1 h-4 w-4 accent-cyan-300 sm:mt-0"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-cyan-50">
                    {project.fullName}
                  </span>
                  <span className="mt-1 block text-xs text-slate-500">
                    Default branch {project.defaultBranch ?? "not set"}
                  </span>
                </span>
                {project.archived ? (
                  <Badge tone="warning">Archived</Badge>
                ) : (
                  <Badge tone="neutral">Project #{project.projectId}</Badge>
                )}
              </label>
            ))}
          </div>

          {error ? <ErrorNotice message={error} /> : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={() => void install()}
              disabled={selectedCount === 0}
              className="rounded-xl"
            >
              Install ReviewRouter
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setSelectedProjectIds(
                  new Set(
                    selectedCount === discovery.projects.length
                      ? []
                      : discovery.projects.map((project) => project.projectId),
                  ),
                )
              }
              className="rounded-xl"
            >
              {selectedCount === discovery.projects.length
                ? "Clear selection"
                : "Select all"}
            </Button>
            <span className="text-sm text-slate-400">
              {selectedCount} selected
            </span>
          </div>
        </div>
      ) : null}

      {phase === "installing" ? (
        <div className="mt-6 rounded-2xl border border-cyan-200/10 bg-cyan-300/[0.045] p-5">
          <Badge tone="accent">Installing</Badge>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            Writing GitLab CI variables and configuring selected projects.
          </p>
        </div>
      ) : null}

      {phase === "result" && installResult ? (
        <GitLabInstallResult
          workspaceId={workspaceId}
          result={installResult}
          selectedProjects={selectedProjects}
          codexCommand={codexCommand}
        />
      ) : null}
    </section>
  );

  function toggleProject(projectId: string): void {
    setSelectedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }
}

function GitLabInstallResult({
  workspaceId,
  result,
  selectedProjects,
  codexCommand,
}: {
  readonly workspaceId: string;
  readonly result: InstallResult;
  readonly selectedProjects: readonly GitLabProject[];
  readonly codexCommand: CodexCommandResult | null;
}): React.ReactElement {
  const readyCount = result.succeeded - result.setupMergeRequests.length;
  return (
    <div className="mt-6 grid gap-5">
      <div className="rounded-2xl border border-lime-300/20 bg-lime-300/[0.05] p-5">
        <Badge tone={result.failed > 0 ? "warning" : "success"}>
          Install result
        </Badge>
        <h2 className="mt-3 text-2xl font-semibold text-cyan-50">
          {result.failed > 0
            ? "Some projects need attention"
            : "GitLab is connected"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-300">
          {readyCount} ready, {result.setupMergeRequests.length} setup MR
          {result.setupMergeRequests.length === 1 ? "" : "s"}, {result.failed}{" "}
          failed.
        </p>
      </div>

      {result.setupMergeRequests.length > 0 ? (
        <div className="rounded-2xl border border-amber-300/20 bg-amber-300/[0.06] p-5">
          <Badge tone="warning">Action needed</Badge>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            Merge these setup MRs where ReviewRouter could not safely set
            <code>ci_config_path</code> directly.
          </p>
          <div className="mt-4 grid gap-2">
            {result.setupMergeRequests.map((mergeRequest) => (
              <LinkButton
                key={`${mergeRequest.projectId}-${mergeRequest.mergeRequestUrl}`}
                href={mergeRequest.mergeRequestUrl}
                target="_blank"
                rel="noreferrer"
                variant="outline"
                size="sm"
                className="w-fit rounded-xl"
              >
                Open setup MR for project #{mergeRequest.projectId}
              </LinkButton>
            ))}
          </div>
        </div>
      ) : null}

      <div className="rounded-2xl border border-cyan-200/10 bg-cyan-300/[0.04] p-5">
        <Badge tone="warning">Codex auth missing</Badge>
        <h3 className="mt-3 text-lg font-semibold text-cyan-50">
          Run this once from a trusted machine.
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-300">
          This writes <code>CODEX_AUTH_JSON</code> directly to GitLab CI/CD
          variables. ReviewRouter never receives the auth JSON.
        </p>
        {codexCommand ? (
          <div className="mt-4">
            <CodeBlock code={codexCommand.command} />
          </div>
        ) : (
          <p className="mt-4 text-sm text-slate-500">
            Preparing command. If it does not appear, refresh the dashboard and
            open GitLab setup again.
          </p>
        )}
      </div>

      {selectedProjects.length > 0 ? (
        <div className="rounded-2xl border border-cyan-200/10 bg-slate-950/55 p-5">
          <Badge tone="neutral">Selected repositories</Badge>
          <div className="mt-3 flex flex-wrap gap-2">
            {selectedProjects.slice(0, 12).map((project) => (
              <span
                key={project.projectId}
                className="rounded-full border border-cyan-300/15 bg-cyan-300/[0.08] px-2.5 py-1 text-[0.7rem] font-semibold text-cyan-50"
              >
                {project.fullName}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <LinkButton href="/dashboard" className="rounded-xl">
          Open dashboard
        </LinkButton>
        <LinkButton
          href={`/setup/gitlab?workspaceId=${encodeURIComponent(workspaceId)}`}
          variant="outline"
          className="rounded-xl"
        >
          Connect another GitLab source
        </LinkButton>
      </div>
    </div>
  );
}

function StepBadge({
  active,
  done,
  children,
}: {
  readonly active: boolean;
  readonly done: boolean;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <Badge tone={done ? "success" : active ? "accent" : "neutral"}>
      {children}
    </Badge>
  );
}

function FieldLabel({
  htmlFor,
  children,
}: {
  readonly htmlFor: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <label
      htmlFor={htmlFor}
      className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-cyan-100"
    >
      {children}
    </label>
  );
}

function ErrorNotice({ message }: { readonly message: string }) {
  return (
    <div className="rounded-2xl border border-red-300/25 bg-red-300/10 p-4 text-sm leading-6 text-red-50">
      {message}
    </div>
  );
}

async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(readApiError(data));
  }
  return data as T;
}

function readApiError(data: unknown): string {
  if (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "object" &&
    data.error !== null &&
    "code" in data.error &&
    typeof data.error.code === "string"
  ) {
    return data.error.code;
  }
  if (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "string"
  ) {
    return data.error;
  }
  return "gitlab_connect_failed";
}

function errorText(error: unknown): string {
  const code = error instanceof Error ? error.message : "gitlab_connect_failed";
  switch (code) {
    case "gitlab_source_url_required":
      return "Paste your GitLab group or project URL.";
    case "gitlab_source_url_host_unsupported":
      return "This setup currently supports the configured GitLab host only.";
    case "gitlab_api_error_401":
    case "gitlab_api_error_403":
      return "GitLab refused the token. Check token scopes and permissions.";
    case "gitlab_api_error_404":
      return "GitLab could not find that group or project for this token.";
    case "gitlab_connect_projects_required":
      return "Select at least one GitLab project.";
    default:
      return code.replaceAll("_", " ");
  }
}

function shouldReturnToTokenInput(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === "gitlab_api_error_401" ||
    error.message === "gitlab_api_error_403" ||
    error.message === "gitlab_api_error_404"
  );
}
