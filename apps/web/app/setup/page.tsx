import { Badge, Card, LinkButton } from "@reviewrouter/ui";
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
import { ActionToast } from "../action-toast";
import {
  GitHubSignInButton,
  GitHubSignOutButton,
} from "../github-sign-in-button";
import { LogoMark } from "../logo-mark";
import { safeGitHubDashboardLink } from "../../src/server/safe-dashboard-link";
import { resolveCodexSeedScriptUrl } from "../../src/server/codex-seed-script-url";
import { ProviderSecretSetupChooser } from "./provider-secret-setup-chooser";
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
  const appInstallReturned = Boolean(setupNotice);
  const heroBody = buildSetupHeroBody({
    installation,
    setupNotice,
    signedIn: mutationStatus.signedIn,
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
          {mutationStatus.signedIn ? (
            <>
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 font-mono text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-300">
                Signed in
                {mutationStatus.githubLogin
                  ? ` as ${mutationStatus.githubLogin}`
                  : ""}
              </span>
              <GitHubSignOutButton
                variant="ghost"
                size="sm"
                className="rounded-xl"
              />
            </>
          ) : null}
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="min-w-0 space-y-4">
            <h1 className="max-w-full text-3xl font-extrabold leading-[1.08] tracking-[-0.035em] text-cyan-50 [overflow-wrap:anywhere] sm:max-w-3xl sm:text-4xl sm:tracking-[-0.04em] md:text-6xl">
              Finish repository setup.
            </h1>
            <p className="max-w-full text-base leading-7 text-[#a0a8c0] [overflow-wrap:anywhere] sm:max-w-2xl">
              {heroBody}
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
                Refresh repository list
              </LinkButton>
            ) : appInstallReturned ? (
              <LinkButton
                href={buildSetupRefreshHref({ installationId, setupAction })}
                size="lg"
                className="w-full rounded-2xl sm:min-w-44 sm:w-auto"
              >
                Refresh install status
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
            ) : appInstallUrl && !installation && !appInstallReturned ? (
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

      {setupNotice ? (
        <GitHubAppInstallHandoffCard
          appInstallUrl={appInstallUrl}
          installation={installation}
          notice={setupNotice}
          signedIn={mutationStatus.signedIn}
          signInCallbackUrl={signInCallbackUrl}
        />
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

      {!mutationStatus.signedIn ? (
        setupNotice ? null : (
          <Card className="rounded-2xl p-5 sm:p-6">
            <Badge tone="accent">Next</Badge>
            <h2 className="mt-4 text-2xl font-semibold text-cyan-50">
              One sign-in finishes the handoff.
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
              After sign-in, ReviewRouter maps this GitHub App installation to
              your workspace, lets you refresh selected repositories, and creates
              the setup PR from the same guided page.
            </p>
          </Card>
        )
      ) : installation ? (
        <SignedInSetup
          installation={installation}
          mutationsEnabled={mutationStatus.enabled}
          setupAction={setupAction}
          syncQueued={readParam(params.notice) === "sync_requested"}
          setupRepositoryFullName={readParam(params.repository)}
        />
      ) : !installationId ? (
        <SetupStartCard appInstallUrl={appInstallUrl} />
      ) : setupNotice ? null : (
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

function buildSetupHeroBody(input: {
  readonly installation: SetupInstallation | null;
  readonly setupNotice: ReturnType<typeof buildGitHubAppSetupNotice>;
  readonly signedIn: boolean;
}): string {
  if (!input.setupNotice) {
    return "Install the GitHub App, sign in, refresh the repository list if needed, and create the setup PR from one guided flow.";
  }

  if (!input.signedIn) {
    return "GitHub confirmed the App installation. Sign in once to link it to your ReviewRouter workspace and continue setup.";
  }

  if (input.installation) {
    return `${input.installation.accountLogin} is linked. Repository metadata normally syncs automatically from GitHub. Refresh if repositories are missing, then create the setup PR.`;
  }

  return "GitHub confirmed the App installation. ReviewRouter is waiting for the signed GitHub webhook, which normally arrives within a few seconds.";
}

function GitHubAppInstallHandoffCard({
  appInstallUrl,
  installation,
  notice,
  signedIn,
  signInCallbackUrl,
}: {
  readonly appInstallUrl: string | null;
  readonly installation: SetupInstallation | null;
  readonly notice: NonNullable<ReturnType<typeof buildGitHubAppSetupNotice>>;
  readonly signedIn: boolean;
  readonly signInCallbackUrl: string;
}): React.ReactElement {
  const state = !signedIn
    ? {
        badge: "Next step",
        title: "GitHub confirmed the App install. Sign in to finish setup.",
        body: "One GitHub sign-in maps this installation to your ReviewRouter workspace. After that you can refresh repositories if needed and create the setup PR.",
        tone: "accent" as const,
      }
    : installation
      ? {
          badge: "Ready",
          title: `${installation.accountLogin} is connected.`,
          body: `${formatAccountType(installation.accountType)} install. GitHub webhooks normally sync repository metadata automatically. Use refresh if repositories are missing, then choose one repository and create the setup PR. ReviewRouter will not create PRs in every repository automatically.`,
          tone: "success" as const,
        }
      : {
          badge: "Waiting",
          title: "GitHub confirmed the App install. ReviewRouter is waiting for the signed webhook.",
          body: "This normally updates within a few seconds. Refresh this page, or open the dashboard after GitHub metadata catches up.",
          tone: "warning" as const,
        };

  return (
    <Card className="rounded-2xl border-lime-300/20 bg-lime-300/[0.045] p-5 sm:p-6">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success">GitHub App installed</Badge>
            <Badge tone={state.tone}>{state.badge}</Badge>
            {installation ? (
              <Badge tone="accent">
                {formatAccountTypeBadge(installation.accountType)}
              </Badge>
            ) : null}
            <span className="rounded-full border border-white/10 bg-slate-950/50 px-3 py-1 font-mono text-[0.66rem] font-semibold uppercase tracking-[0.14em] text-slate-300">
              Installation #{notice.installationId}
            </span>
          </div>
          <h2 className="mt-4 text-2xl font-semibold text-cyan-50">
            {state.title}
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
            {state.body}
          </p>
        </div>
        <div className="grid gap-3 sm:flex sm:flex-wrap lg:justify-end">
          {!signedIn ? (
            <GitHubSignInButton
              callbackUrl={signInCallbackUrl}
              className="rounded-2xl"
            >
              Sign in with GitHub
            </GitHubSignInButton>
          ) : installation ? (
            <LinkButton href="#sync-repositories" className="rounded-2xl">
              Refresh repository list
            </LinkButton>
          ) : (
            <LinkButton
              href={buildSetupRefreshHref({
                installationId: notice.installationId,
                setupAction: "install",
              })}
              className="rounded-2xl"
            >
              Refresh status
            </LinkButton>
          )}
          {appInstallUrl ? (
            <LinkButton
              href={appInstallUrl}
              variant="outline"
              className="rounded-2xl"
            >
              Manage App access
            </LinkButton>
          ) : null}
        </div>
      </div>
    </Card>
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
            ReviewRouter, then GitHub will send you back here to refresh the
            repository list if needed and create the setup PR.
          </p>
          <div className="mt-4 rounded-2xl border border-cyan-200/10 bg-cyan-300/[0.04] p-4 text-sm leading-6 text-slate-300">
            <p className="font-semibold text-cyan-50">
              Choose personal account on GitHub
            </p>
            <p className="mt-1">
              On the GitHub install screen, pick your username for a personal
              repository or pick an organization for organization repositories.
              ReviewRouter shows each install as a separate workspace after you
              sign in.
            </p>
          </div>
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
  syncQueued,
  setupRepositoryFullName,
}: {
  readonly installation: SetupInstallation;
  readonly mutationsEnabled: boolean;
  readonly setupAction: string;
  readonly syncQueued: boolean;
  readonly setupRepositoryFullName: string;
}): React.ReactElement {
  const setupRepository = setupRepositoryFullName
    ? installation.repositories.find(
        (repository) => repository.fullName === setupRepositoryFullName,
      )
    : null;
  const codexOAuthGuidance = setupRepository
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
  const codexApiKeyGuidance = setupRepository
    ? buildProviderSecretSetupGuidance({
        provider: "openai_api_key",
        repoFullName: setupRepository.fullName,
        organizationLogin:
          installation.accountType === "Organization"
            ? installation.accountLogin
            : null,
      })
    : null;
  const repositoriesSynced = installation.repositories.length > 0;
  const selectedRepositorySetupStatus = setupRepository?.setupStatus ?? null;

  return (
    <div className="grid gap-6">
      <SetupProgressTracker
        repositoriesSynced={repositoriesSynced}
        repositorySelected={Boolean(setupRepository)}
        selectedRepositorySetupStatus={selectedRepositorySetupStatus}
        syncQueued={syncQueued}
      />

      <SetupStepCard
        id="sync-repositories"
        badge="Step 2"
        status={repositoriesSynced ? "done" : syncQueued ? "current" : "todo"}
        title="Refresh repository list"
        body={`${installation.accountLogin} is connected as a ${formatAccountType(installation.accountType).toLowerCase()} install. GitHub webhooks normally refresh repository metadata automatically. Use this only if repositories are missing or you changed App access.`}
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
              idleLabel="Refresh repository list"
              pendingLabel="Refreshing repositories..."
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
            No repositories are synced yet. Refresh the repository list above,
            then reload this page or open the dashboard.
          </p>
        ) : (
          <RepositoryPicker
            workspaceId={installation.workspace.id}
            installationId={installation.githubInstallationId}
            setupAction={setupAction}
            initialQuery={setupRepository?.fullName ?? ""}
            mutationsEnabled={mutationsEnabled}
            repositories={installation.repositories}
          />
        )}
      </Card>

      {codexOAuthGuidance && codexApiKeyGuidance && setupRepository ? (
        <SetupStepCard
          badge="Step 3"
          status="current"
          title={`Connect provider secrets for ${setupRepository.fullName}`}
          body="Choose how ReviewRouter should authenticate the model, then run the exact GitHub secret command. Credentials go directly to GitHub Actions secrets, not to ReviewRouter SaaS."
          primary={null}
        >
          <ProviderSecretSetupChooser
            repositoryFullName={setupRepository.fullName}
            organizationLogin={
              installation.accountType === "Organization"
                ? installation.accountLogin
                : null
            }
            codexOAuthGuidance={codexOAuthGuidance}
            codexApiKeyGuidance={codexApiKeyGuidance}
          />
        </SetupStepCard>
      ) : (
        <SetupStepCard
          badge="Step 3"
          status="todo"
          title="Choose a repository, then connect Codex"
          body="Refresh repositories if needed, create the setup PR for one repository, then this step will show exact commands for Codex subscription OAuth or Codex API key mode. The commands write only to GitHub Actions secrets."
          primary={null}
        />
      )}
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
              ? "GitHub grants the App access to all current and future repositories for this account. ReviewRouter syncs metadata from webhooks, then you choose which repositories receive setup PRs and provider secrets. It will not spam every repository with a PR."
              : "To add another repository, manage the GitHub App installation and select it there. GitHub should sync it automatically, but you can refresh here if it is missing."}
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
                  No selected repositories are synced yet. Refresh the
                  installation, then reload this page.
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

type SetupStepStatus = "done" | "current" | "todo";

function SetupProgressTracker({
  repositoriesSynced,
  repositorySelected,
  selectedRepositorySetupStatus,
  syncQueued,
}: {
  readonly repositoriesSynced: boolean;
  readonly repositorySelected: boolean;
  readonly selectedRepositorySetupStatus: string | null;
  readonly syncQueued: boolean;
}): React.ReactElement {
  const setupPrStatus = setupStepStatus({
    repositoriesSynced,
    repositorySelected,
    selectedRepositorySetupStatus,
  });
  const providerSecretStatus = repositorySelected ? "current" : "todo";
  const steps = [
    {
      label: "Install App",
      body: "GitHub App is connected.",
      status: "done" as const,
    },
    {
      label: "Repo list",
      body: repositoriesSynced
        ? "Repository metadata is available."
        : syncQueued
          ? "Refresh is queued. Reload in a few seconds."
          : "GitHub webhook syncs automatically. Refresh only if needed.",
      status: repositoriesSynced
        ? ("done" as const)
        : syncQueued
          ? ("current" as const)
          : ("todo" as const),
    },
    {
      label: "Setup PR",
      body: setupStepBody({
        repositoriesSynced,
        repositorySelected,
        selectedRepositorySetupStatus,
      }),
      status: setupPrStatus,
    },
    {
      label: "Provider secret",
      body: repositorySelected
        ? "Run the command shown below."
        : "Appears after repository selection.",
      status: providerSecretStatus,
    },
  ];

  return (
    <Card className="rounded-2xl p-4 sm:p-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((step, index) => (
          <div
            key={step.label}
            className={`rounded-2xl border p-4 ${
              step.status === "done"
                ? "border-lime-300/25 bg-lime-300/[0.07]"
                : step.status === "current"
                  ? "border-cyan-300/30 bg-cyan-300/[0.08]"
                  : "border-white/10 bg-white/[0.03]"
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`grid h-7 w-7 place-items-center rounded-full border text-xs font-bold ${
                  step.status === "done"
                    ? "border-lime-300/40 bg-lime-300/15 text-lime-100"
                    : step.status === "current"
                      ? "border-cyan-300/45 bg-cyan-300/15 text-cyan-100"
                      : "border-white/15 bg-white/[0.04] text-slate-400"
                }`}
              >
                {step.status === "done" ? "✓" : index + 1}
              </span>
              <p className="font-mono text-[0.66rem] font-semibold uppercase tracking-[0.16em] text-cyan-50">
                {step.label}
              </p>
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-400">
              {step.body}
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function setupStepStatus(input: {
  readonly repositoriesSynced: boolean;
  readonly repositorySelected: boolean;
  readonly selectedRepositorySetupStatus: string | null;
}): SetupStepStatus {
  if (input.selectedRepositorySetupStatus === "configured") return "done";
  if (input.repositorySelected) return "current";
  if (input.repositoriesSynced) return "current";
  return "todo";
}

function setupStepBody(input: {
  readonly repositoriesSynced: boolean;
  readonly repositorySelected: boolean;
  readonly selectedRepositorySetupStatus: string | null;
}): string {
  if (input.selectedRepositorySetupStatus === "configured") {
    return "Workflow is installed.";
  }
  if (input.selectedRepositorySetupStatus === "setup_pr_open") {
    return "Setup PR is open. Merge it.";
  }
  if (input.repositorySelected) {
    return "Create and merge the setup PR.";
  }
  if (input.repositoriesSynced) {
    return "Choose a repository and create setup PR.";
  }
  return "Waiting for repository sync.";
}

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

function buildSetupRefreshHref(input: {
  readonly installationId: string;
  readonly setupAction: string;
}): string {
  const query = new URLSearchParams();
  if (input.installationId) query.set("installation_id", input.installationId);
  query.set("setup_action", input.setupAction || "install");
  return `/setup?${query.toString()}`;
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
