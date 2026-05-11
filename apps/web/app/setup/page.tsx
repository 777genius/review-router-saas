import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Badge, Card, LinkButton } from "@reviewrouter/ui";
import {
  getDashboardMutationStatus,
  getDashboardWorkspaceScope,
  type DashboardWorkspaceScope,
} from "../../src/server/dashboard-mutations";
import { countConnectedGitHubInstallations } from "../../src/server/connected-installations";
import { getGitHubAppInstallUrl } from "../../src/server/github-app-install-url";
import { buildGitHubAppSetupNotice } from "../../src/server/github-app-setup-notice";
import { getPrisma } from "../../src/server/prisma";
import { ActionToast } from "../action-toast";
import { GitHubAppInstallPermissionDialog } from "../github-app-install-permission-dialog";
import { GitHubSignInButton } from "../github-sign-in-button";
import { LoadingLinkButton } from "../loading-link-button";
import { LogoMark } from "../logo-mark";
import { safeGitHubDashboardLink } from "../../src/server/safe-dashboard-link";
import { createNoIndexPageMetadata } from "../seo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = createNoIndexPageMetadata({
  title: "Setup",
  description:
    "ReviewRouter GitHub App setup flow for connecting installations to the private dashboard.",
});

type SetupPageProps = {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
};

type SetupInstallation = NonNullable<
  Awaited<ReturnType<typeof loadSetupInstallation>>
>;

function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

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
  const signInCallbackUrl = buildSetupSignInCallbackUrl(params);
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
  const connectedInstallations = mutationStatus.signedIn
    ? await countConnectedGitHubInstallations(workspaceScope)
    : 0;
  if (mutationStatus.signedIn && installation) {
    redirect(buildSetupDashboardRedirect(installation));
  }

  const appInstallReturned = Boolean(setupNotice);
  const heroBody = buildSetupHeroBody({
    installation,
    setupNotice,
    signedIn: mutationStatus.signedIn,
  });
  const setupHeroTitle =
    setupNotice || installationId
      ? "Finish ReviewRouter setup"
      : "Set up ReviewRouter";
  const primarySetupAction = buildPrimarySetupAction({
    appInstallReturned,
    appInstallUrl,
    installation,
    installationId,
    mutationStatusSignedIn: mutationStatus.signedIn,
    setupAction,
    signInCallbackUrl,
  });
  const secondarySetupAction = buildSecondarySetupAction({
    appInstallReturned,
    installation,
    installationId,
    mutationStatusSignedIn: mutationStatus.signedIn,
    signInCallbackUrl,
  });

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 md:py-12">
      <section className="min-w-0 rounded-[2rem] border border-cyan-300/[0.12] bg-[#0a0a0f]/80 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.42),0_0_90px_-54px_rgba(0,240,255,0.9)] backdrop-blur-2xl sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <LogoMark size="sm" />
          <Badge tone={setupNotice ? "success" : "accent"}>
            {setupNotice?.title ?? "Setup"}
          </Badge>
          {setupNotice ? (
            <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-cyan-100">
              Installation #{setupNotice.installationId}
            </span>
          ) : null}
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="min-w-0 space-y-4">
            <h1 className="max-w-full text-3xl font-extrabold leading-[1.08] tracking-[-0.035em] text-cyan-50 [overflow-wrap:anywhere] sm:max-w-3xl sm:text-4xl sm:tracking-[-0.04em] md:text-6xl">
              {setupHeroTitle}
            </h1>
            <p className="max-w-full text-base leading-7 text-[#a0a8c0] [overflow-wrap:anywhere] sm:max-w-2xl">
              {heroBody}
            </p>
          </div>
          <div className="grid w-full gap-3 sm:flex sm:w-auto sm:flex-wrap lg:justify-end">
            {primarySetupAction}
            {secondarySetupAction}
          </div>
        </div>
      </section>

      {setupNotice && mutationStatus.signedIn ? (
        <GitHubAppInstallHandoffCard notice={setupNotice} />
      ) : null}

      {resultNotice ? (
        <ActionToast
          tone={resultNotice.tone}
          title={resultNotice.title}
          body={resultNotice.body}
          actionUrl={resultNotice.prUrl}
          actionLabel={resultNotice.prUrl ? "Open setup PR" : undefined}
          autoOpenUrl={resultNotice.prUrl}
          storageKey={
            resultNotice.prUrl
              ? `reviewrouter:setup-pr:${resultNotice.prUrl}`
              : undefined
          }
        />
      ) : null}

      {!mutationStatus.signedIn ? null : !installationId ? (
        <SetupStartCard
          appInstallUrl={appInstallUrl}
          connectedInstallations={connectedInstallations}
        />
      ) : setupNotice ? null : (
        <SetupStepCard
          badge="Waiting"
          title="Installation webhook is not synced yet"
          body="If you just installed the App, wait a few seconds and refresh. If it still does not appear, confirm the App was installed on selected repositories and that the setup URL points back to this environment."
          primary={<LinkButton href="/dashboard">Open dashboard</LinkButton>}
          secondary={
            appInstallUrl ? (
              <GitHubAppInstallPermissionDialog
                href={appInstallUrl}
                variant="outline"
                continueLabel="Continue to GitHub App access"
              >
                Manage App access
              </GitHubAppInstallPermissionDialog>
            ) : null
          }
        />
      )}
    </main>
  );
}

function buildSetupDashboardRedirect(installation: SetupInstallation): string {
  const query = new URLSearchParams({
    workspace:
      installation.accountLogin ||
      installation.workspace.slug ||
      installation.workspace.id,
    section: "repositories",
    notice: "app_installed",
  });
  return `/dashboard?${query.toString()}`;
}

function buildSetupHeroBody(input: {
  readonly installation: SetupInstallation | null;
  readonly setupNotice: ReturnType<typeof buildGitHubAppSetupNotice>;
  readonly signedIn: boolean;
}): string {
  if (!input.setupNotice) {
    return "Install the GitHub App, sign in, then use the dashboard to choose one repository, create the setup PR, and run the provider command from your machine.";
  }

  if (!input.signedIn) {
    return "GitHub confirmed the App installation. Sign in once so ReviewRouter can show the repositories you just installed the App on.";
  }

  if (input.installation) {
    return `${input.installation.accountLogin} is linked. Repository metadata normally syncs automatically from GitHub. Open the dashboard to choose a repository and create the setup PR.`;
  }

  return "GitHub confirmed the App installation. ReviewRouter is waiting for the signed GitHub webhook, which normally arrives within a few seconds.";
}

function buildPrimarySetupAction(input: {
  readonly appInstallReturned: boolean;
  readonly appInstallUrl: string | null;
  readonly installation: SetupInstallation | null;
  readonly installationId: string;
  readonly mutationStatusSignedIn: boolean;
  readonly setupAction: string;
  readonly signInCallbackUrl: string;
}): React.ReactNode {
  if (!input.mutationStatusSignedIn && input.installationId) {
    return (
      <GitHubSignInButton
        callbackUrl={input.signInCallbackUrl}
        size="lg"
        className="w-full rounded-2xl sm:min-w-52 sm:w-auto"
      >
        Sign in with GitHub
      </GitHubSignInButton>
    );
  }

  if (input.installation) {
    return (
      <LoadingLinkButton
        href="/dashboard"
        size="lg"
        className="w-full rounded-2xl sm:min-w-44 sm:w-auto"
        pendingLabel="Opening dashboard..."
      >
        Open dashboard
      </LoadingLinkButton>
    );
  }

  if (input.appInstallReturned) {
    return (
      <LoadingLinkButton
        href={buildSetupRefreshHref({
          installationId: input.installationId,
          setupAction: input.setupAction,
        })}
        size="lg"
        className="w-full rounded-2xl sm:min-w-44 sm:w-auto"
        pendingLabel="Refreshing..."
      >
        Refresh install status
      </LoadingLinkButton>
    );
  }

  if (input.appInstallUrl) {
    return (
      <GitHubAppInstallPermissionDialog
        href={input.appInstallUrl}
        size="lg"
        className="w-full rounded-2xl sm:min-w-52 sm:w-auto"
      >
        Install GitHub App
      </GitHubAppInstallPermissionDialog>
    );
  }

  return (
    <span className="inline-flex min-h-14 w-full items-center justify-center rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] px-6 py-3 text-center font-mono text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-amber-100 sm:min-w-52 sm:w-auto">
      Install URL not configured
    </span>
  );
}

function buildSecondarySetupAction(input: {
  readonly appInstallReturned: boolean;
  readonly installation: SetupInstallation | null;
  readonly installationId: string;
  readonly mutationStatusSignedIn: boolean;
  readonly signInCallbackUrl: string;
}): React.ReactNode {
  if (!input.mutationStatusSignedIn && !input.installationId) {
    return (
      <GitHubSignInButton
        callbackUrl={input.signInCallbackUrl}
        size="lg"
        variant="outline"
        className="w-full rounded-2xl sm:min-w-36 sm:w-auto"
      >
        Already installed? Sign in
      </GitHubSignInButton>
    );
  }

  if (
    input.mutationStatusSignedIn &&
    !input.installation &&
    !input.appInstallReturned
  ) {
    return (
      <LoadingLinkButton
        href="/dashboard"
        variant="outline"
        size="lg"
        className="w-full rounded-2xl sm:min-w-36 sm:w-auto"
        pendingLabel="Opening dashboard..."
      >
        Open dashboard
      </LoadingLinkButton>
    );
  }

  return null;
}

function GitHubAppInstallHandoffCard({
  notice,
}: {
  readonly notice: NonNullable<ReturnType<typeof buildGitHubAppSetupNotice>>;
}): React.ReactElement {
  return (
    <Card className="rounded-2xl border-lime-300/20 bg-lime-300/[0.045] p-5 sm:p-6">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success">GitHub App installed</Badge>
            <Badge tone="warning">Syncing</Badge>
            <span className="rounded-full border border-white/10 bg-slate-950/50 px-3 py-1 font-mono text-[0.66rem] font-semibold uppercase tracking-[0.14em] text-slate-300">
              Installation #{notice.installationId}
            </span>
          </div>
          <h2 className="mt-4 min-w-0 text-2xl font-semibold text-cyan-50">
            Waiting for GitHub metadata.
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
            GitHub confirmed the App installation. ReviewRouter is waiting for
            the signed webhook, which normally arrives within a few seconds.
            Refresh this page or open the dashboard after metadata catches up.
          </p>
        </div>
        <div className="grid gap-3 sm:flex sm:flex-wrap lg:justify-end">
          <LoadingLinkButton
            href={buildSetupRefreshHref({
              installationId: notice.installationId,
              setupAction: "install",
            })}
            className="rounded-2xl"
            pendingLabel="Refreshing..."
          >
            Refresh status
          </LoadingLinkButton>
          <LoadingLinkButton
            href="/dashboard"
            variant="outline"
            className="rounded-2xl"
            pendingLabel="Opening dashboard..."
          >
            Open dashboard
          </LoadingLinkButton>
        </div>
      </div>
    </Card>
  );
}

function SetupStartCard({
  appInstallUrl,
  connectedInstallations,
}: {
  readonly appInstallUrl: string | null;
  readonly connectedInstallations: number;
}): React.ReactElement {
  const hasConnectedApp = connectedInstallations > 0;

  return (
    <Card className="rounded-2xl p-5 sm:p-7">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div>
          <Badge tone={hasConnectedApp ? "success" : "accent"}>
            {hasConnectedApp ? "GitHub App connected" : "Choose installation"}
          </Badge>
          <h2 className="mt-4 text-2xl font-semibold text-cyan-50">
            {hasConnectedApp
              ? "Open your dashboard."
              : "Start by selecting repositories."}
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            {hasConnectedApp
              ? "ReviewRouter already has an active GitHub App installation for this signed-in account. Open the dashboard to choose repositories, create setup PRs, and connect provider credentials."
              : "Install the GitHub App for a personal account or organization. Select only the repositories that should run ReviewRouter, then GitHub will send you back here with a link to the dashboard. You can manage repository access later from GitHub."}
          </p>
          {!hasConnectedApp ? (
            <div className="mt-4 rounded-2xl border border-cyan-200/10 bg-cyan-300/[0.04] p-4 text-sm leading-6 text-slate-300">
              <p className="font-semibold text-cyan-50">
                Choose personal account on GitHub
              </p>
              <p className="mt-1">
                On the GitHub install screen, pick your username for a personal
                repository or pick an organization for organization
                repositories. ReviewRouter shows each install as a separate
                workspace after you sign in.
              </p>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-3 lg:justify-end">
          {hasConnectedApp ? (
            <LoadingLinkButton
              href="/dashboard"
              size="lg"
              pendingLabel="Opening dashboard..."
            >
              Open dashboard
            </LoadingLinkButton>
          ) : appInstallUrl ? (
            <GitHubAppInstallPermissionDialog href={appInstallUrl} size="lg">
              Install GitHub App
            </GitHubAppInstallPermissionDialog>
          ) : null}
          {appInstallUrl ? (
            <GitHubAppInstallPermissionDialog
              href={appInstallUrl}
              variant="outline"
              size="lg"
              continueLabel="Continue to GitHub App access"
            >
              {hasConnectedApp ? "Manage App access" : "Already installed?"}
            </GitHubAppInstallPermissionDialog>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

type SetupStepStatus = "done" | "current" | "todo";

function SetupStepCard({
  id,
  badge,
  status = "current",
  title,
  body,
  primary,
  secondary,
  children,
}: {
  readonly id?: string;
  readonly badge: string;
  readonly status?: SetupStepStatus;
  readonly title: string;
  readonly body: string;
  readonly primary: React.ReactNode;
  readonly secondary?: React.ReactNode;
  readonly children?: React.ReactNode;
}): React.ReactElement {
  const statusBadge =
    status === "done"
      ? { tone: "success" as const, label: "✓ Done" }
      : status === "current"
        ? { tone: "accent" as const, label: "Current" }
        : { tone: "neutral" as const, label: "Waiting" };
  return (
    <Card id={id} className="scroll-mt-24 rounded-2xl p-5 sm:p-6">
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={status === "done" ? "success" : "accent"}>
              {badge}
            </Badge>
            <Badge tone={statusBadge.tone}>{statusBadge.label}</Badge>
          </div>
          <h2 className="mt-4 text-2xl font-semibold text-cyan-50">{title}</h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            {body}
          </p>
        </div>
        {primary || secondary ? (
          <div className="flex flex-wrap gap-3 md:justify-end">
            {primary}
            {secondary}
          </div>
        ) : null}
      </div>
      {children ? <div className="mt-5">{children}</div> : null}
    </Card>
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
        title: "Repository refresh queued",
        body: "ReviewRouter queued a repository metadata refresh. If the list does not update immediately, reload this page in a few seconds after GitHub metadata catches up.",
      };
    case "sync_already_requested":
      return {
        tone: "accent",
        title: "Repository refresh already queued",
        body: "A repository metadata refresh was already requested recently. Reload this page in a few seconds.",
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
      accountAvatarUrl: true,
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
    accountAvatarUrl: installation.accountAvatarUrl,
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

function buildSetupSignInCallbackUrl(
  params: Record<string, string | string[] | undefined>,
): string {
  const callbackParams = new URLSearchParams();
  for (const key of ["installation_id", "setup_action"]) {
    const value = readParam(params[key]);
    if (value) callbackParams.set(key, value);
  }
  const query = callbackParams.toString();
  const callbackPath = query ? `/setup?${query}` : "/setup";
  return callbackPath;
}

function buildSetupRefreshHref(input: {
  readonly installationId: string;
  readonly setupAction: string;
}): string {
  const query = new URLSearchParams();
  if (input.installationId) query.set("installation_id", input.installationId);
  query.set("setup_action", input.setupAction || "install");
  return `/setup?${query.toString()}`;
}
