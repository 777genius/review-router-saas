import { Badge, Card, LinkButton } from "@reviewrouter/ui";
import {
  getDashboardMutationStatus,
  getDashboardWorkspaceScope,
  type DashboardWorkspaceScope,
} from "../../src/server/dashboard-mutations";
import { getGitHubAppInstallUrl } from "../../src/server/github-app-install-url";
import { buildGitHubAppSetupNotice } from "../../src/server/github-app-setup-notice";
import { getPrisma } from "../../src/server/prisma";
import {
  requestInstallationSyncAction,
} from "../dashboard/actions";
import { FormSubmitButton } from "../form-submit-button";
import { LogoMark } from "../logo-mark";
import { safeGitHubDashboardLink } from "../../src/server/safe-dashboard-link";
import { RepositoryPicker } from "./repository-picker";

export const dynamic = "force-dynamic";

type SetupPageProps = {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
};

type SetupInstallation = NonNullable<
  Awaited<ReturnType<typeof loadSetupInstallation>>
>;

export default async function SetupPage({
  searchParams,
}: SetupPageProps): Promise<React.ReactElement> {
  const params = searchParams ? await searchParams : {};
  const installationId = readParam(params.installation_id);
  const setupAction = readParam(params.setup_action);
  const [mutationStatus, workspaceScope] = await Promise.all([
    getDashboardMutationStatus(),
    getDashboardWorkspaceScope(),
  ]);
  const appInstallUrl = getGitHubAppInstallUrl();
  const signInHref = buildSetupSignInHref(params);
  const setupNotice = buildGitHubAppSetupNotice({
    installationId,
    setupAction,
    signedIn: mutationStatus.signedIn,
  });
  const resultNotice = buildSetupResultNotice(params);
  const installation =
    mutationStatus.signedIn && installationId
      ? await loadSetupInstallation({ installationId, workspaceScope })
      : null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 md:py-12">
      <section className="rounded-[2rem] border border-cyan-300/[0.12] bg-[#0a0a0f]/80 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.42),0_0_90px_-54px_rgba(0,240,255,0.9)] backdrop-blur-2xl sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <LogoMark size="sm" />
          <Badge tone={setupNotice ? "success" : "accent"}>
            {setupNotice?.title ?? "Setup"}
          </Badge>
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="min-w-0 space-y-4">
            <h1 className="max-w-3xl text-4xl font-extrabold leading-[1.05] tracking-[-0.04em] text-cyan-50 md:text-6xl">
              Finish repository setup.
            </h1>
            <p className="max-w-2xl text-base leading-7 text-[#a0a8c0]">
              {setupNotice
                ? `${setupNotice.body} The dashboard stays focused on connected repositories after setup.`
                : "Install the GitHub App, sign in, sync repositories, and create the setup PR from one guided flow."}
            </p>
          </div>
          <div className="flex flex-wrap gap-3 lg:justify-end">
            {!mutationStatus.signedIn ? (
              <LinkButton
                href={signInHref}
                size="lg"
                className="min-w-52 rounded-2xl"
              >
                Sign in with GitHub
              </LinkButton>
            ) : (
              <LinkButton
                href="/dashboard"
                variant="outline"
                size="lg"
                className="min-w-44 rounded-2xl"
              >
                Open dashboard
              </LinkButton>
            )}
            {appInstallUrl && !installation ? (
              <LinkButton
                href={appInstallUrl}
                variant="outline"
                size="lg"
                className="min-w-36 rounded-2xl"
              >
                Manage App
              </LinkButton>
            ) : null}
          </div>
        </div>
      </section>

      {resultNotice ? <SetupResultNotice notice={resultNotice} /> : null}

      {!mutationStatus.signedIn ? (
        <Card className="rounded-2xl p-5 sm:p-6">
          <Badge tone="accent">Next</Badge>
          <h2 className="mt-4 text-2xl font-semibold text-cyan-50">
            One sign-in finishes the handoff.
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            After sign-in, ReviewRouter maps this GitHub App installation to
            your workspace, lets you sync selected repositories, and creates the
            setup PR from the same guided page.
          </p>
        </Card>
      ) : installation ? (
        <SignedInSetup
          installation={installation}
          mutationsEnabled={mutationStatus.enabled}
          setupAction={setupAction}
        />
      ) : (
        <SetupStepCard
          badge="Waiting"
          title="Installation webhook is not synced yet"
          body="If you just installed the App, wait a few seconds and refresh. If it still does not appear, confirm the App was installed on selected repositories and the webhook URL is api.reviewrouter.site."
          primary={<LinkButton href="/dashboard">Open dashboard</LinkButton>}
          secondary={
            appInstallUrl ? (
              <LinkButton href={appInstallUrl} variant="outline">
                Manage App access
              </LinkButton>
            ) : null
          }
        />
      )}
    </main>
  );
}

function SignedInSetup({
  installation,
  mutationsEnabled,
  setupAction,
}: {
  readonly installation: SetupInstallation;
  readonly mutationsEnabled: boolean;
  readonly setupAction: string;
}): React.ReactElement {
  return (
    <div className="grid gap-6">
      <SetupStepCard
        badge="Step 2"
        title="Sync selected repositories"
        body={`${installation.accountLogin} is connected. Import the selected repositories, then create a workflow setup PR for the repo you want to test first.`}
        primary={
          <form action={requestInstallationSyncAction}>
            <SetupReturnFields
              installationId={installation.githubInstallationId}
              setupAction={setupAction}
            />
            <input
              type="hidden"
              name="workspaceId"
              value={installation.workspace.id}
            />
            <input
              type="hidden"
              name="githubInstallationId"
              value={installation.githubInstallationId}
            />
            <FormSubmitButton
              disabled={!mutationsEnabled}
              idleLabel="Sync repositories"
              pendingLabel="Syncing repositories..."
            />
          </form>
        }
        secondary={
          <LinkButton href="/dashboard" variant="outline">
            Open dashboard
          </LinkButton>
        }
      />

      <Card className="rounded-2xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Badge tone="accent">Selected repositories</Badge>
            <h2 className="mt-3 text-2xl font-semibold text-cyan-50">
              {installation.workspace.name}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              {installation.repositoryCount} repositories synced from this App
              installation.
            </p>
          </div>
          <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 font-mono text-xs uppercase tracking-[0.14em] text-cyan-100">
            {installation.repositorySelection}
          </span>
        </div>

        {installation.repositories.length === 0 ? (
          <p className="mt-5 text-sm leading-6 text-slate-300">
            No repositories are synced yet. Click sync above, then refresh this
            page or open the dashboard.
          </p>
        ) : (
          <RepositoryPicker
            workspaceId={installation.workspace.id}
            installationId={installation.githubInstallationId}
            setupAction={setupAction}
            mutationsEnabled={mutationsEnabled}
            repositories={installation.repositories}
          />
        )}
      </Card>
    </div>
  );
}

function SetupStepCard({
  badge,
  title,
  body,
  primary,
  secondary,
}: {
  readonly badge: string;
  readonly title: string;
  readonly body: string;
  readonly primary: React.ReactNode;
  readonly secondary?: React.ReactNode;
}): React.ReactElement {
  return (
    <Card className="rounded-2xl p-5 sm:p-6">
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <Badge tone="accent">{badge}</Badge>
          <h2 className="mt-4 text-2xl font-semibold text-cyan-50">{title}</h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            {body}
          </p>
        </div>
        <div className="flex flex-wrap gap-3 md:justify-end">
          {primary}
          {secondary}
        </div>
      </div>
    </Card>
  );
}

function SetupResultNotice({
  notice,
}: {
  readonly notice: {
    readonly tone: "success" | "warning" | "danger" | "accent";
    readonly title: string;
    readonly body: string;
    readonly prUrl?: string;
  };
}): React.ReactElement {
  return (
    <Card className="rounded-2xl border-cyan-200/15 p-5 sm:p-6">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <Badge tone={notice.tone}>{notice.title}</Badge>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-200">
            {notice.body}
          </p>
        </div>
        {notice.prUrl ? (
          <LinkButton href={notice.prUrl} target="_blank" rel="noreferrer">
            Open setup PR
          </LinkButton>
        ) : null}
      </div>
    </Card>
  );
}

function SetupReturnFields({
  installationId,
  setupAction,
}: {
  readonly installationId: string;
  readonly setupAction: string;
}): React.ReactElement {
  return (
    <>
      <input type="hidden" name="returnTo" value="setup" />
      <input type="hidden" name="installation_id" value={installationId} />
      <input
        type="hidden"
        name="setup_action"
        value={setupAction || "install"}
      />
    </>
  );
}

function buildSetupResultNotice(
  params: Record<string, string | string[] | undefined>,
): {
  readonly tone: "success" | "warning" | "danger" | "accent";
  readonly title: string;
  readonly body: string;
  readonly prUrl?: string;
} | null {
  const notice = readParam(params.notice);
  const error = readParam(params.error);
  const repository = readParam(params.repository);
  const prUrl = safeGitHubDashboardLink(readParam(params.pr)) ?? "";

  if (error) {
    return {
      tone: "danger",
      title: "Action needs attention",
      body: setupErrorText(error),
    };
  }

  switch (notice) {
    case "sync_requested":
      return {
        tone: "success",
        title: "Repository sync queued",
        body: "ReviewRouter queued a repository sync. If the list does not update immediately, refresh this page after the worker processes the event.",
      };
    case "sync_already_requested":
      return {
        tone: "accent",
        title: "Repository sync already queued",
        body: "A repository sync was already requested recently. Refresh this page in a few seconds.",
      };
    case "setup_pr_ready":
      return stripUndefinedPrUrl({
        tone: "success",
        title: "Setup PR is ready",
        body: repository
          ? `ReviewRouter opened or updated the setup PR for ${repository}. Merge it to install the workflow.`
          : "ReviewRouter opened or updated the setup PR. Merge it to install the workflow.",
        prUrl,
      });
    case "workflow_already_current":
      return {
        tone: "success",
        title: "Workflow already installed",
        body: repository
          ? `The ReviewRouter workflow is already current for ${repository}.`
          : "The ReviewRouter workflow is already current.",
      };
    default:
      return null;
  }
}

function stripUndefinedPrUrl(input: {
  readonly tone: "success" | "warning" | "danger" | "accent";
  readonly title: string;
  readonly body: string;
  readonly prUrl: string;
}): {
  readonly tone: "success" | "warning" | "danger" | "accent";
  readonly title: string;
  readonly body: string;
  readonly prUrl?: string;
} {
  if (!input.prUrl) {
    return {
      tone: input.tone,
      title: input.title,
      body: input.body,
    };
  }
  return input;
}

function setupErrorText(error: string): string {
  switch (error) {
    case "repository_not_selected":
      return "This repository is not selected for the GitHub App installation.";
    case "repository_archived":
      return "Archived repositories cannot receive setup PRs.";
    case "operation_already_running":
      return "The same operation is already running. Wait a few seconds and refresh.";
    case "rate_limited":
      return "This action hit the beta rate limit. Wait a bit before retrying.";
    case "server_misconfigured":
      return "Server setup is incomplete. Check GitHub App credentials and public API URL.";
    default:
      return "The action failed. Check the dashboard diagnostics or retry after refreshing.";
  }
}

async function loadSetupInstallation(input: {
  readonly installationId: string;
  readonly workspaceScope: DashboardWorkspaceScope;
}) {
  if (!/^\d+$/.test(input.installationId)) return null;
  if (input.workspaceScope.kind === "none") return null;
  if (
    input.workspaceScope.kind === "workspace_ids" &&
    input.workspaceScope.workspaceIds.length === 0
  ) {
    return null;
  }

  const installation = await getPrisma().gitHubInstallation.findFirst({
    where: {
      githubInstallationId: BigInt(input.installationId),
      ...(input.workspaceScope.kind === "workspace_ids"
        ? { workspaceId: { in: [...input.workspaceScope.workspaceIds] } }
        : {}),
    },
    select: {
      workspaceId: true,
      githubInstallationId: true,
      accountLogin: true,
      accountType: true,
      repositorySelection: true,
      workspace: {
        select: { id: true, name: true, slug: true },
      },
      repositories: {
        orderBy: [{ selected: "desc" }, { fullName: "asc" }],
        select: {
          id: true,
          fullName: true,
          defaultBranch: true,
          visibility: true,
          selected: true,
          archived: true,
          setupStatus: true,
          provisioning: {
            orderBy: { updatedAt: "desc" },
            take: 1,
            select: { pullRequestUrl: true },
          },
        },
      },
      _count: { select: { repositories: true } },
    },
  });

  if (!installation) return null;

  return {
    workspace: installation.workspace,
    githubInstallationId: installation.githubInstallationId.toString(),
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    repositorySelection: installation.repositorySelection,
    repositoryCount: installation._count.repositories,
    repositories: installation.repositories.map((repository) => ({
      ...repository,
      setupPullRequestUrl: safeGitHubDashboardLink(
        repository.provisioning[0]?.pullRequestUrl ?? "",
      ),
      provisioning: undefined,
    })),
  };
}

function buildSetupSignInHref(
  params: Record<string, string | string[] | undefined>,
): string {
  const callbackParams = new URLSearchParams();
  for (const key of ["installation_id", "setup_action"]) {
    const value = readParam(params[key]);
    if (value) callbackParams.set(key, value);
  }
  const query = callbackParams.toString();
  const callbackPath = query ? `/setup?${query}` : "/setup";
  return `/api/auth/signin?callbackUrl=${encodeURIComponent(callbackPath)}`;
}

function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}
