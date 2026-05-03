import { Badge, Button, Card } from "@reviewrouter/ui";
import { PrismaRepositoryConnectionRepository } from "@reviewrouter/features-repositories";
import {
  listWorkspaceRepositoryHealth,
  PrismaRepositoryHealthRepository,
} from "@reviewrouter/features-repo-health";
import {
  freeBetaEntitlement,
  PrismaEntitlementRepository,
} from "@reviewrouter/features-entitlements";
import { buildProviderSecretSetupGuidance } from "@reviewrouter/features-provider-setup";
import {
  findReviewConfiguration,
  PrismaReviewConfigurationRepository,
  safeDefaultReviewConfiguration,
} from "@reviewrouter/features-review-config";
import {
  getDashboardMutationStatus,
  getDashboardWorkspaceScope,
} from "../../src/server/dashboard-mutations";
import { getPrisma } from "../../src/server/prisma";
import {
  createSetupPullRequestAction,
  requestInstallationSyncAction,
  saveWorkspaceReviewConfigAction,
} from "./actions";

export const dynamic = "force-dynamic";

type DashboardWorkspace = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly installations: readonly {
    readonly accountLogin: string;
    readonly accountType: string;
    readonly githubInstallationId: string;
    readonly status: string;
    readonly repositorySelection: string;
  }[];
  readonly auditEvents: readonly {
    readonly action: string;
    readonly actor: string;
    readonly targetType: string;
    readonly createdAt: Date;
  }[];
};

async function loadDashboardData(
  scope: Awaited<ReturnType<typeof getDashboardWorkspaceScope>>,
) {
  if (scope.kind === "none") {
    return [];
  }
  if (scope.kind === "workspace_ids" && scope.workspaceIds.length === 0) {
    return [];
  }

  const prisma = getPrisma();
  const workspaceWhere =
    scope.kind === "workspace_ids"
      ? { id: { in: [...scope.workspaceIds] } }
      : undefined;
  const workspaces = await prisma.workspace.findMany({
    ...(workspaceWhere ? { where: workspaceWhere } : {}),
    orderBy: { createdAt: "desc" },
    take: 10,
    include: {
      installations: {
        orderBy: { updatedAt: "desc" },
        take: 3,
        select: {
          accountLogin: true,
          accountType: true,
          githubInstallationId: true,
          status: true,
          repositorySelection: true,
        },
      },
      auditEvents: {
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          action: true,
          actor: true,
          targetType: true,
          createdAt: true,
        },
      },
    },
  });
  const repositoryStore = new PrismaRepositoryConnectionRepository(prisma);
  const healthStore = new PrismaRepositoryHealthRepository(prisma);
  const entitlementStore = new PrismaEntitlementRepository(prisma);
  const reviewConfigStore = new PrismaReviewConfigurationRepository(prisma);

  return Promise.all(
    workspaces.map(
      async (
        workspace,
      ): Promise<{
        workspace: DashboardWorkspace;
        repositoryCount: number;
        repositories: readonly Awaited<
          ReturnType<typeof repositoryStore.listWorkspaceRepositories>
        >[number][];
        health: readonly Awaited<
          ReturnType<typeof listWorkspaceRepositoryHealth>
        >[number][];
        entitlement: ReturnType<typeof freeBetaEntitlement>;
        reviewConfig: Awaited<ReturnType<typeof findReviewConfiguration>>;
      }> => {
        const repositories = await repositoryStore.listWorkspaceRepositories(
          workspace.id,
        );
        const entitlement =
          (await entitlementStore.findWorkspaceEntitlement(workspace.id)) ??
          freeBetaEntitlement(workspace.id);
        const health = await listWorkspaceRepositoryHealth(
          {
            workspaceId: workspace.id,
            expectedActionRef:
              process.env.REVIEW_ROUTER_ACTION_REF ??
              "777genius/review-router@v1",
          },
          { repositories: healthStore },
        );
        const reviewConfig = await findReviewConfiguration(
          { scope: "workspace", workspaceId: workspace.id },
          { configurations: reviewConfigStore },
        );

        return {
          workspace: {
            id: workspace.id,
            name: workspace.name,
            slug: workspace.slug,
            installations: workspace.installations.map((installation) => ({
              ...installation,
              githubInstallationId:
                installation.githubInstallationId.toString(),
            })),
            auditEvents: workspace.auditEvents,
          },
          repositoryCount: repositories.length,
          repositories: repositories.slice(0, 8),
          entitlement,
          health,
          reviewConfig,
        };
      },
    ),
  );
}

type DashboardWorkspaceData = Awaited<
  ReturnType<typeof loadDashboardData>
>[number];

type DashboardPageProps = {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
};

export default async function DashboardPage({
  searchParams,
}: DashboardPageProps): Promise<React.ReactElement> {
  const [mutationStatus, workspaceScope] = await Promise.all([
    getDashboardMutationStatus(),
    getDashboardWorkspaceScope(),
  ]);
  const workspaces = await loadDashboardData(workspaceScope);
  const params = searchParams ? await searchParams : {};

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-10">
      <section className="space-y-3">
        <Badge tone="accent">Dashboard</Badge>
        <h1 className="text-4xl font-semibold tracking-tight text-cyan-50 md:text-6xl">
          Connected repositories
        </h1>
        <p className="max-w-3xl text-base leading-7 text-slate-300">
          Repository sync is App-driven. The dashboard reads normalized
          installation and repository metadata, not code, diffs, PR bodies, or
          commit messages.
        </p>
      </section>

      <DashboardNotice params={params} mutationStatus={mutationStatus} />

      <section className="grid gap-5">
        {workspaces.length === 0 ? (
          <Card className="space-y-3">
            <Badge tone="warning">No workspace yet</Badge>
            <p className="text-sm leading-6 text-slate-300">
              Sign in with GitHub and install the ReviewRouter App to create a
              workspace and start syncing repositories.
            </p>
          </Card>
        ) : (
          workspaces.map((workspace) => (
            <WorkspaceCard
              key={workspace.workspace.id}
              data={workspace}
              mutationsEnabled={mutationStatus.enabled}
            />
          ))
        )}
      </section>
    </main>
  );
}

function WorkspaceCard({
  data,
  mutationsEnabled,
}: {
  readonly data: DashboardWorkspaceData;
  readonly mutationsEnabled: boolean;
}): React.ReactElement {
  const { workspace, repositoryCount, repositories, entitlement, health } =
    data;
  const activeConfig =
    data.reviewConfig?.config ?? safeDefaultReviewConfiguration;
  const activeConfigVersion = data.reviewConfig?.version ?? 1;
  const primaryRepository =
    repositories.find((repository) => repository.selected) ?? repositories[0];
  const primaryInstallation = workspace.installations[0];
  const providerGuidance = primaryRepository
    ? buildProviderSecretSetupGuidance({
        provider: "codex_oauth",
        repoFullName: primaryRepository.fullName,
        organizationLogin:
          primaryInstallation?.accountType === "Organization"
            ? primaryInstallation.accountLogin
            : null,
      })
    : null;

  return (
    <Card className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-cyan-50">
            {workspace.name}
          </h2>
          <p className="text-sm text-slate-400">{workspace.slug}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone="success">{repositoryCount} repositories</Badge>
          <Badge tone="accent">
            {entitlement.plan.replace("_", " ")} / {entitlement.status}
          </Badge>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {workspace.installations.map((installation) => (
          <div
            key={`${workspace.id}-${installation.githubInstallationId}`}
            className="space-y-3 rounded-xl border border-cyan-200/10 bg-cyan-300/5 p-3"
          >
            <div>
              <p className="text-sm font-semibold text-cyan-50">
                {installation.accountLogin}
              </p>
              <p className="text-xs uppercase tracking-[0.16em] text-slate-400">
                {installation.accountType} / {installation.status} /{" "}
                {installation.repositorySelection}
              </p>
            </div>
            <form action={requestInstallationSyncAction}>
              <input type="hidden" name="workspaceId" value={workspace.id} />
              <input
                type="hidden"
                name="githubInstallationId"
                value={installation.githubInstallationId}
              />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={!mutationsEnabled || installation.status !== "active"}
              >
                Sync repos
              </Button>
            </form>
          </div>
        ))}
      </div>

      {providerGuidance ? (
        <div className="rounded-xl border border-emerald-300/20 bg-emerald-300/10 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge tone="success">Codex OAuth setup</Badge>
            <span className="text-xs uppercase tracking-[0.16em] text-emerald-100">
              {providerGuidance.recommendedScope.replaceAll("_", " ")}
            </span>
          </div>
          <p className="mb-4 text-sm leading-6 text-emerald-50">
            Run this on a trusted machine where Codex CLI is already logged in.
            The command writes directly to GitHub Actions secrets through{" "}
            <code>gh</code>; ReviewRouter SaaS never receives{" "}
            <code>CODEX_AUTH_JSON</code>.
          </p>
          <div className="grid gap-3">
            {providerGuidance.commands.map((command) => (
              <div
                key={command.title}
                className="rounded-lg border border-emerald-200/10 bg-slate-950/80 p-3"
              >
                <p className="text-sm font-semibold text-emerald-50">
                  {command.title}
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  {command.description}
                </p>
                <pre className="mt-3 overflow-x-auto rounded-md bg-black/40 p-3 text-xs text-cyan-100">
                  <code>{command.command}</code>
                </pre>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="rounded-xl border border-cyan-200/10 bg-cyan-300/5 p-4">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Badge tone="accent">Review config</Badge>
          <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
            workspace default / v{activeConfigVersion}
          </span>
        </div>
        <form
          action={saveWorkspaceReviewConfigAction}
          className="grid gap-3 md:grid-cols-3"
        >
          <input type="hidden" name="workspaceId" value={workspace.id} />
          <label className="space-y-1 text-sm text-slate-300">
            <span>Provider auth</span>
            <select
              name="providerAuthMode"
              defaultValue={activeConfig.provider.authMode}
              disabled={!mutationsEnabled}
              className="w-full rounded-lg border border-cyan-200/15 bg-slate-950 px-3 py-2 text-cyan-50"
            >
              <option value="codex_subscription_oauth">Codex OAuth</option>
              <option value="codex_openai_api_key">Codex API key</option>
              <option value="openrouter_api_key">OpenRouter API key</option>
            </select>
          </label>
          <label className="space-y-1 text-sm text-slate-300">
            <span>Model</span>
            <input
              name="model"
              defaultValue={activeConfig.provider.model}
              disabled={!mutationsEnabled}
              className="w-full rounded-lg border border-cyan-200/15 bg-slate-950 px-3 py-2 text-cyan-50"
            />
          </label>
          <label className="space-y-1 text-sm text-slate-300">
            <span>Reasoning effort</span>
            <select
              name="reasoningEffort"
              defaultValue={activeConfig.provider.reasoningEffort}
              disabled={!mutationsEnabled}
              className="w-full rounded-lg border border-cyan-200/15 bg-slate-950 px-3 py-2 text-cyan-50"
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
          <label className="space-y-1 text-sm text-slate-300">
            <span>Fail on severity</span>
            <select
              name="failOnSeverity"
              defaultValue={activeConfig.blockingPolicy.failOnSeverity}
              disabled={!mutationsEnabled}
              className="w-full rounded-lg border border-cyan-200/15 bg-slate-950 px-3 py-2 text-cyan-50"
            >
              <option value="off">off</option>
              <option value="critical">critical</option>
              <option value="major">major</option>
            </select>
          </label>
          <label className="space-y-1 text-sm text-slate-300">
            <span>Inline max comments</span>
            <input
              name="inlineMaxComments"
              type="number"
              min={0}
              max={50}
              defaultValue={activeConfig.limits.inlineMaxComments}
              disabled={!mutationsEnabled}
              className="w-full rounded-lg border border-cyan-200/15 bg-slate-950 px-3 py-2 text-cyan-50"
            />
          </label>
          <label className="space-y-1 text-sm text-slate-300">
            <span>Target tokens per batch</span>
            <input
              name="targetTokensPerBatch"
              type="number"
              min={4000}
              max={200000}
              step={1000}
              defaultValue={activeConfig.limits.targetTokensPerBatch}
              disabled={!mutationsEnabled}
              className="w-full rounded-lg border border-cyan-200/15 bg-slate-950 px-3 py-2 text-cyan-50"
            />
          </label>
          <input
            type="hidden"
            name="agenticContext"
            value={String(activeConfig.provider.agenticContext)}
          />
          <div className="flex items-end">
            <Button type="submit" variant="solid" disabled={!mutationsEnabled}>
              Save config
            </Button>
          </div>
        </form>
      </div>

      {repositories.some((repository) => repository.visibility === "public") ? (
        <div className="rounded-xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm leading-6 text-amber-100">
          Public repository warning: fork pull requests are skipped by default
          for secret-backed providers. Maintainers can add a trusted rerun flow
          later, but v1 keeps provider secrets out of untrusted fork code paths.
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-cyan-200/10">
        <table className="w-full text-left text-sm">
          <thead className="bg-cyan-300/10 text-xs uppercase tracking-[0.16em] text-cyan-100">
            <tr>
              <th className="px-4 py-3">Repository</th>
              <th className="px-4 py-3">Visibility</th>
              <th className="px-4 py-3">Default branch</th>
              <th className="px-4 py-3">Setup</th>
              <th className="px-4 py-3">Health</th>
              <th className="px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cyan-200/10 text-slate-200">
            {repositories.map((repository) => {
              const repositoryHealth = health.find(
                (item) => item.repositoryId === repository.id,
              );
              return (
                <tr
                  key={repository.id}
                  className={repository.selected ? "" : "opacity-50"}
                >
                  <td className="px-4 py-3 font-medium">
                    {repository.fullName}
                  </td>
                  <td className="px-4 py-3">{repository.visibility}</td>
                  <td className="px-4 py-3">{repository.defaultBranch}</td>
                  <td className="px-4 py-3">{repository.setupStatus}</td>
                  <td className="px-4 py-3">
                    <span className="block text-cyan-100">
                      {repositoryHealth?.status ?? "unknown"}
                    </span>
                    <span className="text-xs text-slate-400">
                      {repositoryHealth?.summary ?? "No health data"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <form action={createSetupPullRequestAction}>
                      <input
                        type="hidden"
                        name="workspaceId"
                        value={workspace.id}
                      />
                      <input
                        type="hidden"
                        name="repositoryId"
                        value={repository.id}
                      />
                      <Button
                        type="submit"
                        variant="soft"
                        size="sm"
                        disabled={
                          !mutationsEnabled ||
                          !repository.selected ||
                          repository.archived
                        }
                      >
                        {repository.setupStatus === "setup_pr_open"
                          ? "Update PR"
                          : "Setup PR"}
                      </Button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-cyan-200/10 bg-slate-950/60 p-4">
        <p className="mb-3 text-xs uppercase tracking-[0.16em] text-cyan-100">
          Recent audit
        </p>
        {workspace.auditEvents.length === 0 ? (
          <p className="text-sm text-slate-400">No audit events yet.</p>
        ) : (
          <ul className="space-y-2 text-sm text-slate-300">
            {workspace.auditEvents.map((event) => (
              <li
                key={`${event.action}-${event.targetType}-${event.createdAt.toISOString()}`}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <span>
                  {event.action} by {event.actor}
                </span>
                <span className="text-xs text-slate-500">
                  {event.createdAt.toISOString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function DashboardNotice({
  params,
  mutationStatus,
}: {
  readonly params: Record<string, string | string[] | undefined>;
  readonly mutationStatus: Awaited<
    ReturnType<typeof getDashboardMutationStatus>
  >;
}): React.ReactElement | null {
  const notice = readParam(params.notice);
  const error = readParam(params.error);
  if (notice) {
    return (
      <Card className="border-lime-300/25 bg-lime-300/10">
        <Badge tone="success">Done</Badge>
        <p className="mt-3 text-sm leading-6 text-lime-50">
          {dashboardNoticeText(notice, readParam(params.repository))}
          {params.pr ? (
            <>
              {" "}
              <a
                className="text-cyan-100 underline decoration-cyan-300/50 underline-offset-4"
                href={readParam(params.pr)}
                target="_blank"
                rel="noreferrer"
              >
                Open pull request
              </a>
            </>
          ) : null}
        </p>
      </Card>
    );
  }
  if (error) {
    return (
      <Card className="border-red-300/25 bg-red-300/10">
        <Badge tone="danger">Action failed</Badge>
        <p className="mt-3 text-sm leading-6 text-red-50">
          {dashboardErrorText(error)}
        </p>
      </Card>
    );
  }
  if (!mutationStatus.enabled) {
    return (
      <Card className="border-amber-300/25 bg-amber-300/10">
        <Badge tone="warning">Read-only dashboard</Badge>
        <p className="mt-3 text-sm leading-6 text-amber-50">
          {mutationStatus.reason === "signed_out"
            ? "Sign in with GitHub to request repository syncs or setup PRs."
            : "Dashboard mutations are disabled. Set REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS=1 for local beta provisioning."}
          {mutationStatus.reason === "signed_out" ? (
            <>
              {" "}
              <a
                className="text-cyan-100 underline decoration-cyan-300/50 underline-offset-4"
                href="/api/auth/signin"
              >
                Sign in
              </a>
            </>
          ) : null}
        </p>
      </Card>
    );
  }

  return null;
}

function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function dashboardNoticeText(notice: string, repository: string): string {
  switch (notice) {
    case "sync_requested":
      return "Repository sync was queued. Run the worker or wait for the worker to process the outbox.";
    case "sync_already_requested":
      return "Repository sync was already queued for this installation recently.";
    case "setup_pr_ready":
      return repository
        ? `Setup PR is ready for ${repository}.`
        : "Setup PR is ready.";
    case "review_config_saved":
      return "Review configuration was saved. Future action runs can fetch it through OIDC.";
    default:
      return "Dashboard action completed.";
  }
}

function dashboardErrorText(error: string): string {
  switch (error) {
    case "dashboard_mutations_disabled":
      return "Dashboard mutations are disabled on this environment.";
    case "dashboard_mutation_requires_sign_in":
      return "Sign in with GitHub before changing repository setup.";
    case "workspace_mutation_forbidden":
      return "Your GitHub user is not an owner/admin for this workspace.";
    case "operation_already_running":
      return "Another setup or sync operation is already running. Try again shortly.";
    case "server_misconfigured":
      return "Server GitHub App credentials are missing. Check local environment settings.";
    case "repository_not_selected":
      return "This repository is no longer selected for the GitHub App installation.";
    case "repository_archived":
      return "Archived repositories cannot be provisioned.";
    case "installation_not_active":
      return "The GitHub App installation is not active.";
    default:
      return "GitHub operation failed. Check audit events or server logs for the safe error code.";
  }
}
