import { Badge, Card, CodeBlock, LinkButton } from "@reviewrouter/ui";
import { buildProviderSecretSetupGuidance } from "@reviewrouter/features-provider-setup";
import {
  getDashboardMutationStatus,
  getDashboardWorkspaceScope,
  type DashboardWorkspaceScope,
} from "../../src/server/dashboard-mutations";
import { getGitHubAppInstallUrl } from "../../src/server/github-app-install-url";
import { buildGitHubAppSetupNotice } from "../../src/server/github-app-setup-notice";
import { getPrisma } from "../../src/server/prisma";
import { requestInstallationSyncAction } from "../dashboard/actions";
import { FormSubmitButton } from "../form-submit-button";
import { GitHubSignInButton } from "../github-sign-in-button";
import { LogoMark } from "../logo-mark";
import { safeGitHubDashboardLink } from "../../src/server/safe-dashboard-link";
import { resolveCodexSeedScriptUrl } from "../../src/server/codex-seed-script-url";
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
              Finish repository setup.
            </h1>
            <p className="max-w-full text-base leading-7 text-[#a0a8c0] [overflow-wrap:anywhere] sm:max-w-2xl">
              {setupNotice
                ? `${setupNotice.body} The dashboard stays focused on connected repositories after setup.`
                : "Install the GitHub App, sign in, sync repositories, and create the setup PR from one guided flow."}
            </p>
          </div>
          <div className="grid w-full gap-3 sm:flex sm:w-auto sm:flex-wrap lg:justify-end">
            {!mutationStatus.signedIn && installationId ? (
              <GitHubSignInButton
                callbackUrl={signInCallbackUrl}
                size="lg"
                className="w-full rounded-2xl sm:min-w-52 sm:w-auto"
              >
                Sign in with GitHub
              </GitHubSignInButton>
            ) : !mutationStatus.signedIn && appInstallUrl ? (
              <LinkButton
                href={appInstallUrl}
                size="lg"
                className="w-full rounded-2xl sm:min-w-52 sm:w-auto"
              >
                Install or manage App
              </LinkButton>
            ) : installation ? (
              <LinkButton
                href="#sync-repositories"
                size="lg"
                className="w-full rounded-2xl sm:min-w-44 sm:w-auto"
              >
                Sync repositories
              </LinkButton>
            ) : appInstallUrl ? (
              <LinkButton
                href={appInstallUrl}
                size="lg"
                className="w-full rounded-2xl sm:min-w-44 sm:w-auto"
              >
                Install or manage App
              </LinkButton>
            ) : (
              <LinkButton
                href="/dashboard"
                variant="outline"
                size="lg"
                className="w-full rounded-2xl sm:min-w-44 sm:w-auto"
              >
                Open dashboard
              </LinkButton>
            )}
            {!mutationStatus.signedIn && !installationId ? (
              <GitHubSignInButton
                callbackUrl={signInCallbackUrl}
                size="lg"
                variant="outline"
                className="w-full rounded-2xl sm:min-w-36 sm:w-auto"
              >
                Sign in
              </GitHubSignInButton>
            ) : appInstallUrl && !installation ? (
              <LinkButton
                href="/dashboard"
                variant="outline"
                size="lg"
                className="w-full rounded-2xl sm:min-w-36 sm:w-auto"
              >
                Open dashboard
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
          setupRepositoryFullName={readParam(params.repository)}
        />
      ) : !installationId ? (
        <SetupStartCard appInstallUrl={appInstallUrl} />
      ) : (
        <SetupStepCard
          badge="Waiting"
          title="Installation webhook is not synced yet"
          body="If you just installed the App, wait a few seconds and refresh. If it still does not appear, confirm the App was installed on selected repositories and that the setup URL points back to this environment."
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

function SetupStartCard({
  appInstallUrl,
}: {
  readonly appInstallUrl: string | null;
}): React.ReactElement {
  return (
    <Card className="rounded-2xl p-5 sm:p-7">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div>
          <Badge tone="accent">Choose installation</Badge>
          <h2 className="mt-4 text-2xl font-semibold text-cyan-50">
            Start by selecting repositories.
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            Install or manage the GitHub App for a personal account or
            organization. Select only the repositories that should run
            ReviewRouter, then GitHub will send you back here to sync and create
            the setup PR.
          </p>
        </div>
        <div className="flex flex-wrap gap-3 lg:justify-end">
          {appInstallUrl ? (
            <LinkButton href={appInstallUrl} size="lg">
              Install or manage App
            </LinkButton>
          ) : null}
          <LinkButton href="/dashboard" variant="outline" size="lg">
            Open dashboard
          </LinkButton>
        </div>
      </div>
    </Card>
  );
}

function SignedInSetup({
  installation,
  mutationsEnabled,
  setupAction,
  setupRepositoryFullName,
}: {
  readonly installation: SetupInstallation;
  readonly mutationsEnabled: boolean;
  readonly setupAction: string;
  readonly setupRepositoryFullName: string;
}): React.ReactElement {
  const setupRepository = setupRepositoryFullName
    ? installation.repositories.find(
        (repository) => repository.fullName === setupRepositoryFullName,
      )
    : null;
  const providerGuidance = setupRepository
    ? buildProviderSecretSetupGuidance({
        provider: "codex_oauth",
        repoFullName: setupRepository.fullName,
        seedScriptUrl: resolveCodexSeedScriptUrl(),
        organizationLogin:
          installation.accountType === "Organization"
            ? installation.accountLogin
            : null,
      })
    : null;

  return (
    <div className="grid gap-6">
      <SetupStepCard
        id="sync-repositories"
        badge="Step 2"
        title="Sync selected repositories"
        body={`${installation.accountLogin} is connected. Sync imports repository metadata only. ReviewRouter does not open setup PRs automatically, even when the GitHub App is installed on all repositories.`}
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

      <RepositorySelectionExplainer installation={installation} />

      {providerGuidance && setupRepository ? (
        <ProviderSecretSetupCard
          repositoryFullName={setupRepository.fullName}
          guidance={providerGuidance}
        />
      ) : (
        <SetupStepCard
          badge="Step 3"
          title="Connect Codex after choosing a repository"
          body="After you create and merge a setup PR, this page will show the exact Codex OAuth command for that repository. The command writes CODEX_AUTH_JSON directly to GitHub Actions secrets through gh; ReviewRouter SaaS does not receive it."
          primary={
            <LinkButton href="/getting-started" variant="outline">
              Read provider setup
            </LinkButton>
          }
        />
      )}

      <Card className="rounded-2xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Badge tone="accent">Selected repositories</Badge>
            <h2 className="mt-3 text-2xl font-semibold text-cyan-50">
              {installation.workspace.name}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              {installation.repositoryCount} repositories synced from{" "}
              {formatAccountType(installation.accountType)}{" "}
              {installation.accountLogin}.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">
              {formatAccountTypeBadge(installation.accountType)}
            </Badge>
            <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 font-mono text-xs uppercase tracking-[0.14em] text-cyan-100">
              {installation.repositorySelection}
            </span>
          </div>
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

function RepositorySelectionExplainer({
  installation,
}: {
  readonly installation: SetupInstallation;
}): React.ReactElement {
  const isAllRepositories = installation.repositorySelection === "all";
  const settingsUrl = appInstallationSettingsUrl(installation);
  const selectedRepositories = installation.repositories
    .filter((repository) => repository.selected)
    .map((repository) => repository.fullName);
  const visibleSelectedRepositories = selectedRepositories.slice(0, 8);
  const hiddenSelectedRepositoryCount =
    selectedRepositories.length - visibleSelectedRepositories.length;

  return (
    <Card className="rounded-2xl border-cyan-200/15 bg-cyan-300/[0.04] p-5 sm:p-6">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div>
          <Badge tone={isAllRepositories ? "warning" : "success"}>
            {isAllRepositories ? "All repositories install" : "Selected repos"}
          </Badge>
          <h2 className="mt-4 text-2xl font-semibold text-cyan-50">
            {isAllRepositories
              ? "All repos are available, but setup is still per repository."
              : "Only selected repositories are available here."}
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
            {isAllRepositories
              ? "GitHub grants the App access to all current and future repositories for this account. ReviewRouter syncs metadata, then you choose which repositories receive setup PRs and provider secrets. It will not spam every repository with a PR."
              : "To add another repository, manage the GitHub App installation and select it there. Then sync here and create a setup PR for the repository you want to enable."}
          </p>
          {installation.accountType === "Organization" ? (
            <div className="mt-4 rounded-2xl border border-cyan-200/10 bg-slate-950/65 p-4">
              <p className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-cyan-100/70">
                Organization repository access
              </p>
              {isAllRepositories ? (
                <p className="mt-2 text-sm leading-6 text-slate-300">
                  The App is installed for all repositories in{" "}
                  {installation.accountLogin}. Setup PRs and provider secrets
                  are still created only for repositories you choose here.
                </p>
              ) : visibleSelectedRepositories.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {visibleSelectedRepositories.map((repositoryFullName) => (
                    <span
                      key={repositoryFullName}
                      className="rounded-full border border-cyan-300/15 bg-cyan-300/[0.08] px-3 py-1 text-xs font-semibold text-cyan-50"
                    >
                      {repositoryFullName}
                    </span>
                  ))}
                  {hiddenSelectedRepositoryCount > 0 ? (
                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-semibold text-slate-300">
                      +{hiddenSelectedRepositoryCount} more
                    </span>
                  ) : null}
                </div>
              ) : (
                <p className="mt-2 text-sm leading-6 text-slate-300">
                  No selected repositories are synced yet. Sync the
                  installation, then refresh this page.
                </p>
              )}
            </div>
          ) : null}
        </div>
        {settingsUrl ? (
          <LinkButton href={settingsUrl} variant="outline" target="_blank">
            Manage App access
          </LinkButton>
        ) : null}
      </div>
    </Card>
  );
}

function ProviderSecretSetupCard({
  repositoryFullName,
  guidance,
}: {
  readonly repositoryFullName: string;
  readonly guidance: ReturnType<typeof buildProviderSecretSetupGuidance>;
}): React.ReactElement {
  const recommendedCommand = guidance.commands[0];

  return (
    <Card className="rounded-2xl border-emerald-300/20 bg-emerald-300/[0.08] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Badge tone="success">Step 3 - Codex OAuth</Badge>
          <h2 className="mt-4 text-2xl font-semibold text-cyan-50">
            Seed Codex for {repositoryFullName}
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-emerald-50">
            Run the recommended command on a trusted machine where Codex CLI is
            already logged in. It writes secrets directly to GitHub Actions
            through <code>gh</code>; ReviewRouter never receives your Codex
            OAuth file.
          </p>
        </div>
        <Badge tone="success">
          {guidance.recommendedScope.replaceAll("_", " ")}
        </Badge>
      </div>

      {recommendedCommand ? (
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <SetupFact
            label="Secret destination"
            value={recommendedCommand.targetLabel}
          />
          <SetupFact
            label="Selected repositories"
            value={recommendedCommand.selectedRepositories.join(", ")}
          />
          <SetupFact
            label="Validation"
            value={
              recommendedCommand.validatesBeforeWrite
                ? "Checks Codex auth JSON before writing"
                : "GitHub validates secret write"
            }
          />
        </div>
      ) : null}

      {guidance.warnings.length > 0 ? (
        <ul className="mt-4 list-disc space-y-1 pl-5 text-xs leading-5 text-emerald-100/90">
          {guidance.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <div className="mt-5 grid gap-3">
        {guidance.commands.map((command, index) => (
          <div
            key={command.title}
            className="rounded-2xl border border-emerald-200/10 bg-slate-950/80 p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={index === 0 ? "success" : "neutral"}>
                {index === 0 ? "Recommended" : "Alternative"}
              </Badge>
              <h3 className="text-sm font-semibold text-emerald-50">
                {command.title}
              </h3>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-400">
              {command.description}
            </p>
            <div className="mt-3 grid gap-2 text-xs leading-5 text-slate-300 sm:grid-cols-3">
              <span>
                <strong className="text-emerald-100">Secrets:</strong>{" "}
                {command.secretNames.join(", ")}
              </span>
              <span>
                <strong className="text-emerald-100">Target:</strong>{" "}
                {command.targetLabel}
              </span>
              <span>
                <strong className="text-emerald-100">Recovery:</strong>{" "}
                {command.failureRecovery}
              </span>
            </div>
            <CodeBlock
              code={command.command}
              className="mt-3 rounded-xl p-3 text-xs leading-5"
            />
          </div>
        ))}
      </div>
    </Card>
  );
}

function SetupFact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.ReactElement {
  return (
    <div className="min-w-0 rounded-2xl border border-emerald-200/10 bg-slate-950/70 p-4">
      <p className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-emerald-100/70">
        {label}
      </p>
      <p className="mt-2 break-words text-sm font-semibold leading-6 text-emerald-50">
        {value}
      </p>
    </div>
  );
}

function SetupStepCard({
  id,
  badge,
  title,
  body,
  primary,
  secondary,
}: {
  readonly id?: string;
  readonly badge: string;
  readonly title: string;
  readonly body: string;
  readonly primary: React.ReactNode;
  readonly secondary?: React.ReactNode;
}): React.ReactElement {
  return (
    <Card id={id} className="scroll-mt-24 rounded-2xl p-5 sm:p-6">
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
        body: "ReviewRouter queued a repository sync. If the list does not update immediately, refresh this page in a few seconds after GitHub metadata catches up.",
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

function appInstallationSettingsUrl(
  installation: SetupInstallation,
): string | null {
  if (!/^\d+$/.test(installation.githubInstallationId)) return null;
  if (installation.accountType === "Organization") {
    return `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.githubInstallationId}`;
  }
  return `https://github.com/settings/installations/${installation.githubInstallationId}`;
}

function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function formatAccountType(accountType: string): string {
  return accountType === "Organization" ? "organization" : "personal account";
}

function formatAccountTypeBadge(accountType: string): string {
  return accountType === "Organization" ? "Organization" : "Personal";
}
