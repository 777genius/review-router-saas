"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import { Tabs } from "@base-ui/react/tabs";
import type { ProviderSecretSetupGuidance } from "@reviewrouter/features-provider-setup";
import { Badge, Button, CodeBlock } from "@reviewrouter/ui";
import { providerSetupConfirmedEvent } from "./repository-setup-optimistic-events";

type ProviderChoice = "codex_oauth" | "codex_api_key" | "openrouter_api_key";
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
  readonly organizationLogin: string | null;
  readonly codexOAuthGuidance: ProviderSecretSetupGuidance;
  readonly codexApiKeyGuidance: ProviderSecretSetupGuidance;
  readonly openRouterApiKeyGuidance: ProviderSecretSetupGuidance;
};

export function ProviderSecretSetupChooser({
  workspaceId,
  repositoryId,
  repositoryFullName,
  organizationLogin,
  codexOAuthGuidance,
  codexApiKeyGuidance,
  openRouterApiKeyGuidance,
}: ProviderSecretSetupChooserProps): React.ReactElement {
  const [providerChoice, setProviderChoice] =
    useState<ProviderChoice>("codex_oauth");
  const [useOrganizationSecret, setUseOrganizationSecret] = useState(
    Boolean(organizationLogin),
  );
  const [verificationError, setVerificationError] =
    useState<VerificationFallbackError | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [isPending, startTransition] = useTransition();

  const activeGuidance =
    providerChoice === "codex_oauth"
      ? codexOAuthGuidance
      : providerChoice === "codex_api_key"
        ? codexApiKeyGuidance
        : openRouterApiKeyGuidance;
  const repositoryCommand = activeGuidance.commands.find(
    (command) => command.storesSecretIn === "github_repository_secret",
  );
  const organizationCommand = activeGuidance.commands.find(
    (command) => command.storesSecretIn === "github_org_secret",
  );
  const activeCommand =
    useOrganizationSecret && organizationCommand
      ? organizationCommand
      : repositoryCommand;
  const secretNames = activeCommand?.secretNames.join(", ") ?? "GitHub secret";
  const providerSetupSelection = providerChoiceToSetupSelection(providerChoice);
  const secretScope =
    activeCommand?.storesSecretIn === "github_org_secret"
      ? "organization_selected_repositories"
      : "repository";

  const providerDetails = useMemo(
    () =>
      providerChoice === "codex_oauth"
        ? {
            badge: "Codex subscription",
            title: "Use your ChatGPT Codex subscription",
            body: `Run this from your own computer, in a terminal opened in the ${repositoryFullName} repository directory. The script validates the active Codex account and writes CODEX_AUTH_JSON directly to GitHub Actions secrets.`,
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
              body: `Run this from your own computer, in a terminal opened in the ${repositoryFullName} repository directory. The command will prompt you to paste your OpenAI API key, then store it as the OPENAI_API_KEY secret in GitHub Actions for this repository.`,
              footnote:
                "This does not use the ChatGPT subscription OAuth file. It uses normal OpenAI API billing.",
              apiKey: {
                label: "Get an OpenAI API key",
                url: "https://platform.openai.com/api-keys",
              },
            }
          : {
              badge: "OpenRouter API key",
              title: "Use OpenRouter billing",
              body: `Run this from your own computer, in a terminal opened in the ${repositoryFullName} repository directory. The command will prompt you to paste your OpenRouter API key, then store it as the OPENROUTER_API_KEY secret in GitHub Actions for this repository.`,
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
          className="grid overflow-hidden rounded-2xl border border-cyan-200/15 bg-slate-950/70 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:grid-cols-3"
        >
          {providerChoices.map((choice) => (
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

      {organizationLogin ? (
        <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-cyan-200/10 bg-slate-950/70 p-4 text-sm leading-6 text-slate-300 transition hover:border-cyan-200/25 hover:bg-cyan-300/[0.04]">
          <input
            data-testid="provider-scope-organization"
            type="checkbox"
            checked={useOrganizationSecret}
            onChange={(event) => {
              setUseOrganizationSecret(event.currentTarget.checked);
              setVerificationError(null);
              setSubmitError(null);
              setConfirmed(false);
            }}
            className="mt-1 h-4 w-4 accent-cyan-300"
          />
          <span>
            <span className="block font-semibold text-cyan-50">
              Organization selected-repository secret
            </span>
            <span className="block text-slate-400">
              Recommended for organization repos. The secret is stored once in{" "}
              {organizationLogin} and granted only to {repositoryFullName}.
            </span>
          </span>
        </label>
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
            On your own computer, open a terminal in the {repositoryFullName}{" "}
            repository directory.
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
                  setConfirmed(true);
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
            value={verificationError ? "manual" : "verified"}
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
                  {verificationError ? "Saving..." : "Checking secrets..."}
                </span>
              ) : verificationError ? (
                "Confirm manually"
              ) : confirmed ? (
                "Confirmed"
              ) : (
                "I ran this script"
              )}
            </Button>
            {confirmed ? <Badge tone="success">Setup confirmed</Badge> : null}
            {verificationError ? (
              <p className="max-w-xl text-xs leading-5 text-amber-100/85">
                Could not verify automatically. Confirm manually if GitHub shows
                the secret.
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
                Provider setup is marked complete for {repositoryFullName}.
              </p>
              <p className="mt-1 text-emerald-100/80">
                The setup progress was updated. Keep this open if you want to
                copy another provider command, or close it when done.
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
    case "entitlement_denied":
      return "This workspace plan does not allow provider setup confirmation.";
    default:
      return "The dashboard could not save provider setup. Retry once, then check server logs if it repeats.";
  }
}

function providerChoiceToSetupSelection(value: ProviderChoice): {
  readonly providerKind: "codex" | "openrouter";
  readonly authMode:
    | "codex_subscription_oauth"
    | "codex_openai_api_key"
    | "openrouter_api_key";
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

function readSubmittedConfirmationMode(
  formData: FormData,
): "verified" | "manual" {
  return formData.get("confirmationMode") === "manual" ? "manual" : "verified";
}
