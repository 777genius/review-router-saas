"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import { Tabs } from "@base-ui/react/tabs";
import type {
  ProviderSecretScope,
  ProviderSecretSetupGuidance,
} from "@reviewrouter/features-provider-setup";
import type {
  ProviderAuthMode,
  ProviderKind,
} from "@reviewrouter/features-review-providers";
import { Badge, Button, CodeBlock } from "@reviewrouter/ui";
import { clearProviderSecretStatusCache } from "./provider-secret-status-cache";
import { providerSetupConfirmedEvent } from "./repository-setup-optimistic-events";

type ProviderChoice =
  | "codex_oauth"
  | "codex_api_key"
  | "claude_code_oauth"
  | "openrouter_api_key";
type VerificationFallbackError =
  | "repository_not_visible_to_github_app"
  | "provider_secret_not_found"
  | "provider_secret_not_available_to_repository"
  | "provider_secret_check_permission_required";

const providerChoices: readonly {
  readonly value: ProviderChoice;
  readonly testId: string;
  readonly title: string;
  readonly body: string;
}[] = [
  {
    value: "codex_oauth",
    testId: "provider-choice-codex-oauth",
    title: "Codex subscription",
    body: "Use Codex CLI OAuth from your ChatGPT account.",
  },
  {
    value: "codex_api_key",
    testId: "provider-choice-codex-api-key",
    title: "Codex API key",
    body: "Use OPENAI_API_KEY and API billing.",
  },
  {
    value: "claude_code_oauth",
    testId: "provider-choice-claude-code-oauth",
    title: "Claude Code subscription",
    body: "Use CLAUDE_CODE_OAUTH_TOKEN from Claude Code.",
  },
  {
    value: "openrouter_api_key",
    testId: "provider-choice-openrouter-api-key",
    title: "OpenRouter API key",
    body: "Use OPENROUTER_API_KEY from GitHub Actions.",
  },
];

export type ProviderSecretSetupChooserProps = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly repositoryVisibility: string;
  readonly organizationLogin: string | null;
  readonly organizationSecretPolicy: OrganizationSecretPolicy | null;
  readonly codexOAuthGuidance: ProviderSecretSetupGuidance;
  readonly codexApiKeyGuidance: ProviderSecretSetupGuidance;
  readonly claudeCodeOAuthGuidance: ProviderSecretSetupGuidance;
  readonly openRouterApiKeyGuidance: ProviderSecretSetupGuidance;
  readonly claudeCodeProviderEnabled?: boolean;
};

export type OrganizationSecretPolicy = {
  readonly planName: string | null;
  readonly privateRepositoriesAvailable: boolean | null;
  readonly status: "available" | "permission_required" | "unknown";
};

export function ProviderSecretSetupChooser({
  workspaceId,
  repositoryId,
  repositoryFullName,
  repositoryVisibility,
  organizationLogin,
  organizationSecretPolicy,
  codexOAuthGuidance,
  codexApiKeyGuidance,
  claudeCodeOAuthGuidance,
  openRouterApiKeyGuidance,
  claudeCodeProviderEnabled = true,
}: ProviderSecretSetupChooserProps): React.ReactElement {
  const [providerChoice, setProviderChoice] =
    useState<ProviderChoice>("codex_oauth");
  const organizationSecretUnavailableForRepository =
    Boolean(organizationLogin) &&
    repositoryVisibility === "private" &&
    organizationSecretPolicy?.privateRepositoriesAvailable === false;
  const [selectedSecretScope, setSelectedSecretScope] =
    useState<ProviderSecretScope>(
      organizationLogin && !organizationSecretUnavailableForRepository
        ? "organization_selected_repositories"
        : "repository",
    );
  const [verificationError, setVerificationError] =
    useState<VerificationFallbackError | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedMode, setConfirmedMode] = useState<"verified" | "manual">(
    "verified",
  );
  const [isPending, startTransition] = useTransition();

  const activeGuidance =
    providerChoice === "codex_oauth"
      ? codexOAuthGuidance
      : providerChoice === "codex_api_key"
        ? codexApiKeyGuidance
        : providerChoice === "claude_code_oauth"
          ? claudeCodeOAuthGuidance
          : openRouterApiKeyGuidance;
  const repositoryCommand = activeGuidance.commands.find(
    (command) => command.scope === "repository",
  );
  const activeCommand =
    activeGuidance.commands.find(
      (command) => command.scope === selectedSecretScope,
    ) ?? repositoryCommand;
  const secretNames = activeCommand?.secretNames.join(", ") ?? "GitHub secret";
  const providerSetupSelection = providerChoiceToSetupSelection(providerChoice);
  const secretScope = activeCommand?.scope ?? "repository";
  const scopeOptions = providerSecretScopeOptions({
    organizationLogin,
    organizationSecretPolicy,
    repositoryFullName,
    repositoryVisibility,
  });
  const visibleProviderChoices = useMemo(
    () =>
      providerChoices.filter(
        (choice) =>
          choice.value !== "claude_code_oauth" || claudeCodeProviderEnabled,
      ),
    [claudeCodeProviderEnabled],
  );

  const providerDetails = useMemo(
    () =>
      providerChoice === "codex_oauth"
        ? {
            badge: "Codex subscription",
            title: "Use your ChatGPT Codex subscription",
            body: `Run this from any terminal on your own computer. The command targets ${repositoryFullName}, validates the active Codex account, and writes CODEX_AUTH_JSON directly to GitHub Actions secrets.`,
            footnote:
              "If Codex later says the token is stale, run codex login again and rerun this same command.",
            apiKey: null as {
              readonly label: string;
              readonly url: string;
            } | null,
          }
        : providerChoice === "codex_api_key"
          ? {
              badge: "Codex API key",
              title: "Use OpenAI API billing for Codex",
              body: `Run this from any terminal on your own computer. The command targets ${repositoryFullName}, prompts you to paste your OpenAI API key, then stores it as the OPENAI_API_KEY secret in GitHub Actions for this repository.`,
              footnote:
                "This does not use the ChatGPT subscription OAuth file. It uses normal OpenAI API billing.",
              apiKey: {
                label: "Get an OpenAI API key",
                url: "https://platform.openai.com/api-keys",
              },
            }
          : providerChoice === "claude_code_oauth"
            ? {
                badge: "Claude Code subscription",
                title: "Use your Claude Code subscription",
                body: `Run claude setup-token on a trusted machine, then run this GitHub CLI command from your own computer. Store only the printed token value as CLAUDE_CODE_OAUTH_TOKEN for ${repositoryFullName}.`,
                footnote:
                  "Do not paste the shell command, ANTHROPIC_API_KEY, Claude keychain files, or local Claude config files.",
                apiKey: null as {
                  readonly label: string;
                  readonly url: string;
                } | null,
              }
            : {
                badge: "OpenRouter API key",
                title: "Use OpenRouter billing",
                body: `Run this from any terminal on your own computer. The command targets ${repositoryFullName}, prompts you to paste your OpenRouter API key, then stores it as the OPENROUTER_API_KEY secret in GitHub Actions for this repository.`,
                footnote:
                  "This does not use Codex OAuth. It uses your OpenRouter API key from GitHub Actions secrets.",
                apiKey: {
                  label: "Get an OpenRouter API key",
                  url: "https://openrouter.ai/workspaces/default/keys",
                },
              },
    [providerChoice, repositoryFullName],
  );

  return (
    <div className="grid gap-5">
      <Tabs.Root
        value={providerChoice}
        onValueChange={(value) => {
          if (isProviderChoice(value)) {
            setProviderChoice(value);
            setVerificationError(null);
            setSubmitError(null);
            setConfirmed(false);
          }
        }}
      >
        <Tabs.List
          aria-label="Provider credential type"
          activateOnFocus
          className={[
            "grid overflow-hidden rounded-2xl border border-cyan-200/15 bg-slate-950/70 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
            claudeCodeProviderEnabled ? "sm:grid-cols-4" : "sm:grid-cols-3",
          ].join(" ")}
        >
          {visibleProviderChoices.map((choice) => (
            <Tabs.Tab
              key={choice.value}
              value={choice.value}
              data-testid={choice.testId}
              className={({ active }) =>
                [
                  "group min-h-20 rounded-xl px-4 py-3 text-left transition duration-200 ease-out hover:-translate-y-0.5 hover:saturate-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200 active:translate-y-0",
                  active
                    ? "bg-cyan-300/[0.13] text-cyan-50 shadow-[0_16px_40px_-30px_rgba(0,240,255,0.95)]"
                    : "text-slate-300 hover:bg-cyan-300/[0.05] hover:text-cyan-50",
                ].join(" ")
              }
            >
              <span className="block text-sm font-semibold">
                {choice.title}
              </span>
              <span className="mt-1 block text-xs leading-5 text-slate-400 group-hover:text-slate-300 group-data-[active]:text-cyan-100/80">
                {choice.body}
              </span>
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.Root>

      {scopeOptions.length > 1 ? (
        <fieldset className="grid gap-3">
          <legend className="text-sm font-semibold text-cyan-50">
            Secret storage
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {scopeOptions.map((option) => {
              const checked = selectedSecretScope === option.scope;
              return (
                <label
                  key={option.scope}
                  className={[
                    "flex min-h-28 items-start gap-3 rounded-2xl border p-4 text-sm leading-6 transition",
                    option.disabled
                      ? "cursor-not-allowed border-slate-700/70 bg-slate-950/45 text-slate-500"
                      : checked
                        ? "cursor-pointer border-cyan-200/40 bg-cyan-300/[0.08] text-cyan-50 shadow-[0_16px_44px_-36px_rgba(0,240,255,0.9)]"
                        : "cursor-pointer border-cyan-200/10 bg-slate-950/70 text-slate-300 hover:border-cyan-200/25 hover:bg-cyan-300/[0.04]",
                  ].join(" ")}
                >
                  <input
                    data-testid={`provider-scope-${option.scope}`}
                    type="radio"
                    name="providerSecretScopeChoice"
                    checked={checked}
                    disabled={option.disabled}
                    onChange={() => {
                      if (option.disabled) return;
                      setSelectedSecretScope(option.scope);
                      setVerificationError(null);
                      setSubmitError(null);
                      setConfirmed(false);
                    }}
                    className="mt-1 h-4 w-4 accent-cyan-300"
                  />
                  <span>
                    <span className="flex flex-wrap items-center gap-2 font-semibold text-cyan-50">
                      {option.title}
                      {option.badge ? (
                        <Badge tone={option.badgeTone}>{option.badge}</Badge>
                      ) : null}
                    </span>
                    <span
                      className={
                        option.disabled
                          ? "mt-1 block text-slate-500"
                          : "mt-1 block text-slate-400"
                      }
                    >
                      {option.body}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {organizationSecretPolicy?.status === "permission_required" ? (
            <p className="text-xs leading-5 text-amber-100/85">
              ReviewRouter cannot read this organization plan yet. Approve the
              GitHub App Organization plan permission, or use a repository
              secret for private repositories.
            </p>
          ) : null}
          {organizationSecretUnavailableForRepository ? (
            <p className="text-xs leading-5 text-amber-100/85">
              GitHub Free organizations do not make organization secrets
              available to private repositories. Use a repository secret for{" "}
              {repositoryFullName}.
            </p>
          ) : null}
        </fieldset>
      ) : null}

      <div className="rounded-2xl border border-emerald-200/10 bg-slate-950/80 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="success">{providerDetails.badge}</Badge>
          <Badge tone="neutral">{secretNames}</Badge>
        </div>
        <h3 className="mt-4 text-lg font-semibold text-emerald-50">
          {providerDetails.title}
        </h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
          {providerDetails.body}
        </p>
        <ol className="mt-4 grid list-decimal gap-2 pl-5 text-sm leading-6 text-emerald-50/90">
          <li>Merge the setup PR for {repositoryFullName}.</li>
          <li>
            On your own computer, open any terminal where GitHub CLI is
            authenticated.
          </li>
          <li>
            Run the command below to connect this AI provider to the repository.
            {providerDetails.apiKey ? (
              <>
                {" "}
                When the command asks for the secret value, paste your API key.{" "}
                <a
                  href={providerDetails.apiKey.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-semibold text-cyan-200 underline-offset-4 hover:underline"
                >
                  {providerDetails.apiKey.label}
                </a>
                .
              </>
            ) : null}
          </li>
          <li>Open a test pull request and ReviewRouter will run in CI.</li>
        </ol>
        {activeCommand ? (
          <CodeBlock
            code={activeCommand.command}
            language="bash"
            className="mt-4 rounded-xl p-3 text-xs leading-5"
          />
        ) : (
          <p className="mt-4 rounded-xl border border-red-300/20 bg-red-300/[0.08] p-3 text-sm text-red-100">
            No command is available for this provider and scope.
          </p>
        )}
        <form
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            const submittedConfirmationMode =
              readSubmittedConfirmationMode(formData);
            setSubmitError(null);
            setConfirmed(false);
            setConfirmedMode(submittedConfirmationMode);
            startTransition(() => {
              void confirmProviderSecretSetup(formData)
                .then(({ params }) => {
                  if (
                    submittedConfirmationMode === "verified" &&
                    isVerificationFallbackError(params.error)
                  ) {
                    setVerificationError(params.error);
                    setSubmitError(null);
                    return;
                  }
                  if (params.error) {
                    setSubmitError(params.error);
                    return;
                  }
                  setVerificationError(null);
                  setSubmitError(null);
                  setConfirmedMode(submittedConfirmationMode);
                  setConfirmed(true);
                  clearProviderSecretStatusCache({
                    workspaceId,
                    repositoryId,
                    authMode: providerSetupSelection.authMode,
                  });
                  window.dispatchEvent(
                    providerSetupConfirmedEvent({
                      repositoryId,
                      repositoryFullName,
                    }),
                  );
                })
                .catch(() => {
                  setSubmitError("dashboard_action_failed");
                });
            });
          }}
          className="mt-4"
        >
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="repositoryId" value={repositoryId} />
          <input
            type="hidden"
            name="providerKind"
            value={providerSetupSelection.providerKind}
          />
          <input
            type="hidden"
            name="authMode"
            value={providerSetupSelection.authMode}
          />
          <input type="hidden" name="secretScope" value={secretScope} />
          <input
            type="hidden"
            name="confirmationMode"
            value={
              verificationError &&
              verificationErrorAllowsManual(verificationError)
                ? "manual"
                : "verified"
            }
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              variant="solid"
              size="sm"
              className="min-h-11 rounded-xl px-5"
              disabled={isPending || confirmed || !activeCommand}
              aria-busy={isPending}
            >
              {isPending ? (
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
                  />
                  {verificationErrorAllowsManual(verificationError)
                    ? "Saving..."
                    : "Checking secrets..."}
                </span>
              ) : verificationErrorAllowsManual(verificationError) ? (
                "Confirm manually"
              ) : verificationError ? (
                "Check secrets again"
              ) : confirmed ? (
                "Confirmed"
              ) : (
                "I ran this script"
              )}
            </Button>
            {confirmed ? <Badge tone="success">Setup confirmed</Badge> : null}
            {verificationError ? (
              <p className="max-w-xl text-xs leading-5 text-amber-100/85">
                {verificationErrorText({
                  error: verificationError,
                  secretScope,
                  secretNames,
                  repositoryFullName,
                  organizationLogin,
                })}
              </p>
            ) : null}
          </div>
          {submitError ? (
            <p className="mt-3 rounded-xl border border-red-300/25 bg-red-400/[0.08] p-3 text-sm leading-6 text-red-100">
              {providerSetupSubmitErrorText(submitError)}
            </p>
          ) : null}
          {confirmed ? (
            <div
              className="mt-3 rounded-xl border border-emerald-300/25 bg-emerald-300/[0.08] p-3 text-sm leading-6 text-emerald-50"
              role="status"
            >
              <p className="font-semibold">
                {confirmedMode === "manual"
                  ? "Provider setup was manually marked complete"
                  : "Provider secret metadata was verified and setup was marked complete"}{" "}
                for {repositoryFullName}.
              </p>
              <p className="mt-1 text-emerald-100/80">
                {confirmedMode === "manual"
                  ? "ReviewRouter did not verify GitHub secret metadata automatically. The setup progress was updated from your manual confirmation."
                  : "ReviewRouter verified the GitHub secret metadata it can read. Keep this open if you want to copy another provider command, or close it when done."}
              </p>
            </div>
          ) : null}
        </form>
        <p className="mt-3 text-xs leading-5 text-emerald-100/80">
          {providerDetails.footnote} ReviewRouter SaaS never receives provider
          credentials.
        </p>
      </div>
    </div>
  );
}

type DashboardActionResult = {
  readonly params: Record<string, string>;
};

async function confirmProviderSecretSetup(
  formData: FormData,
): Promise<DashboardActionResult> {
  const response = await fetch("/api/dashboard/provider-secret-setup/confirm", {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw new Error("provider_setup_confirm_failed");
  }

  const result: unknown = await response.json();
  if (!isDashboardActionResult(result)) {
    throw new Error("provider_setup_confirm_invalid_response");
  }

  return result;
}

function isDashboardActionResult(
  input: unknown,
): input is DashboardActionResult {
  if (!input || typeof input !== "object" || !("params" in input)) {
    return false;
  }

  const params = (input as { readonly params: unknown }).params;
  if (!params || typeof params !== "object") {
    return false;
  }

  return Object.values(params).every((value) => typeof value === "string");
}

function providerSetupSubmitErrorText(error: string): string {
  switch (error) {
    case "dashboard_action_failed":
      return "The dashboard action failed. Retry once; if it repeats, keep this dialog open and check server logs.";
    case "github_operation_failed":
      return "GitHub did not complete the verification request. Retry once; if the secret exists in GitHub, use manual confirmation after a verification warning.";
    case "invalid_form":
      return "The submitted provider setup form is invalid. Reopen the dialog and try again.";
    case "rate_limited":
      return "Too many dashboard requests for this repository. Wait a bit before retrying.";
    case "workspace_mutation_forbidden":
      return "Your GitHub user is not allowed to change this workspace.";
    case "repository_mutation_forbidden":
      return "Your GitHub user needs write, maintain, or admin access on this repository to confirm provider setup.";
    case "entitlement_denied":
      return "This workspace plan does not allow provider setup confirmation.";
    default:
      return "The dashboard could not save provider setup. Retry once, then check server logs if it repeats.";
  }
}

function providerChoiceToSetupSelection(value: ProviderChoice): {
  readonly providerKind: ProviderKind;
  readonly authMode: ProviderAuthMode;
} {
  switch (value) {
    case "codex_oauth":
      return {
        providerKind: "codex",
        authMode: "codex_subscription_oauth",
      };
    case "codex_api_key":
      return {
        providerKind: "codex",
        authMode: "codex_openai_api_key",
      };
    case "claude_code_oauth":
      return {
        providerKind: "claude",
        authMode: "claude_code_oauth",
      };
    case "openrouter_api_key":
      return {
        providerKind: "openrouter",
        authMode: "openrouter_api_key",
      };
  }
}

function isProviderChoice(value: unknown): value is ProviderChoice {
  return providerChoices.some((choice) => choice.value === value);
}

function isVerificationFallbackError(
  value: unknown,
): value is VerificationFallbackError {
  return (
    value === "repository_not_visible_to_github_app" ||
    value === "provider_secret_not_found" ||
    value === "provider_secret_not_available_to_repository" ||
    value === "provider_secret_check_permission_required"
  );
}

function verificationErrorAllowsManual(
  error: VerificationFallbackError | null,
): boolean {
  return (
    error === "provider_secret_check_permission_required" ||
    error === "repository_not_visible_to_github_app"
  );
}

function verificationErrorText(input: {
  readonly error: VerificationFallbackError;
  readonly secretScope: ProviderSecretScope;
  readonly secretNames: string;
  readonly repositoryFullName: string;
  readonly organizationLogin: string | null;
}): string {
  if (input.error === "provider_secret_not_found") {
    if (input.secretScope !== "repository") {
      return `${input.secretNames} was not found as an organization Actions secret in ${input.organizationLogin ?? "this organization"}. Ask an organization owner to create it, or switch to a repository secret and run the repository command.`;
    }

    return `${input.secretNames} was not found in ${input.repositoryFullName} repository Actions secrets. Run the command below, then check again.`;
  }

  if (input.error === "provider_secret_not_available_to_repository") {
    return `${input.secretNames} exists as an organization Actions secret, but ${input.repositoryFullName} is not selected for access. In GitHub, open the organization secret's Repository access settings and add this repository, or switch to a repository secret.`;
  }

  if (input.error === "repository_not_visible_to_github_app") {
    return "ReviewRouter could not read this repository through the GitHub App installation. Confirm manually only if the App is installed on this repository and GitHub shows the secret.";
  }

  return "ReviewRouter could not verify GitHub secret metadata automatically. Confirm manually only if GitHub shows the secret and the repository has access to it.";
}

function providerSecretScopeOptions(input: {
  readonly organizationLogin: string | null;
  readonly organizationSecretPolicy: OrganizationSecretPolicy | null;
  readonly repositoryFullName: string;
  readonly repositoryVisibility: string;
}): readonly {
  readonly scope: ProviderSecretScope;
  readonly title: string;
  readonly body: string;
  readonly badge?: string;
  readonly badgeTone?: "neutral" | "accent" | "success" | "warning";
  readonly disabled: boolean;
}[] {
  const repositoryOption = {
    scope: "repository" as const,
    title: "Repository secret",
    body: `Store the secret directly in ${input.repositoryFullName}. GitHub requires repo write access for this command.`,
    badge: "Maintainer friendly",
    badgeTone: "success" as const,
    disabled: false,
  };
  if (!input.organizationLogin) {
    return [repositoryOption];
  }

  const privateRepoOrgSecretDisabled =
    input.repositoryVisibility === "private" &&
    input.organizationSecretPolicy?.privateRepositoriesAvailable === false;
  const disabledReason =
    "Unavailable for private repositories on this organization plan.";
  const planName = input.organizationSecretPolicy?.planName;
  const planSuffix = planName ? ` Plan: ${planName}.` : "";

  return [
    repositoryOption,
    {
      scope: "organization_selected_repositories" as const,
      title: "Org selected repositories",
      body: privateRepoOrgSecretDisabled
        ? disabledReason
        : `Store one ${input.organizationLogin} secret and grant this repository access. Add future repositories in GitHub organization settings.${planSuffix}`,
      badge: "Recommended",
      badgeTone: "accent" as const,
      disabled: privateRepoOrgSecretDisabled,
    },
    {
      scope: "organization_private_repositories" as const,
      title: "Org private repositories",
      body: privateRepoOrgSecretDisabled
        ? disabledReason
        : `Make the organization secret available to private repositories in ${input.organizationLogin}.${planSuffix}`,
      badge: "Broad",
      badgeTone: "warning" as const,
      disabled: privateRepoOrgSecretDisabled,
    },
    {
      scope: "organization_all_repositories" as const,
      title: "Org all repositories",
      body: privateRepoOrgSecretDisabled
        ? disabledReason
        : `Make the organization secret available to every repository in ${input.organizationLogin}.${planSuffix}`,
      badge: "Broadest",
      badgeTone: "warning" as const,
      disabled: privateRepoOrgSecretDisabled,
    },
  ];
}

function readSubmittedConfirmationMode(
  formData: FormData,
): "verified" | "manual" {
  return formData.get("confirmationMode") === "manual" ? "manual" : "verified";
}
