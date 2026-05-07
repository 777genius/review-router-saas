"use client";

import { useMemo, useState } from "react";
import type { ProviderSecretSetupGuidance } from "@reviewrouter/features-provider-setup";
import { Badge, CodeBlock } from "@reviewrouter/ui";

type ProviderChoice = "codex_oauth" | "codex_api_key" | "openrouter_api_key";

export type ProviderSecretSetupChooserProps = {
  readonly repositoryFullName: string;
  readonly organizationLogin: string | null;
  readonly codexOAuthGuidance: ProviderSecretSetupGuidance;
  readonly codexApiKeyGuidance: ProviderSecretSetupGuidance;
  readonly openRouterApiKeyGuidance: ProviderSecretSetupGuidance;
};

export function ProviderSecretSetupChooser({
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

  const providerDetails = useMemo(
    () =>
      providerChoice === "codex_oauth"
        ? {
            badge: "Codex subscription",
            title: "Use your ChatGPT Codex subscription",
            body: `Run this from your own computer, in a terminal opened in the ${repositoryFullName} repository directory. The script validates the active Codex account and writes CODEX_AUTH_JSON directly to GitHub Actions secrets.`,
            footnote:
              "If Codex later says the token is stale, run codex login again and rerun this same command.",
          }
        : providerChoice === "codex_api_key"
          ? {
              badge: "Codex API key",
              title: "Use OpenAI API billing for Codex",
              body: `Run this from your own computer, in a terminal opened in the ${repositoryFullName} repository directory. It stores OPENAI_API_KEY directly in GitHub Actions secrets, then the dashboard policy can use Codex API key mode for this repository.`,
              footnote:
                "This does not use the ChatGPT subscription OAuth file. It uses normal OpenAI API billing.",
            }
          : {
              badge: "OpenRouter API key",
              title: "Use OpenRouter billing",
              body: `Run this from your own computer, in a terminal opened in the ${repositoryFullName} repository directory. It stores OPENROUTER_API_KEY directly in GitHub Actions secrets, then the dashboard policy can use OpenRouter mode for this repository.`,
              footnote:
                "This does not use Codex OAuth. It uses your OpenRouter API key from GitHub Actions secrets.",
            },
    [providerChoice],
  );

  return (
    <div className="grid gap-5">
      <div className="grid gap-3 lg:grid-cols-3">
        <ProviderChoiceButton
          active={providerChoice === "codex_oauth"}
          testId="provider-choice-codex-oauth"
          title="Codex subscription"
          body="Use Codex CLI OAuth from your ChatGPT account."
          onClick={() => setProviderChoice("codex_oauth")}
        />
        <ProviderChoiceButton
          active={providerChoice === "codex_api_key"}
          testId="provider-choice-codex-api-key"
          title="Codex API key"
          body="Use OPENAI_API_KEY and API billing."
          onClick={() => setProviderChoice("codex_api_key")}
        />
        <ProviderChoiceButton
          active={providerChoice === "openrouter_api_key"}
          testId="provider-choice-openrouter-api-key"
          title="OpenRouter API key"
          body="Use OPENROUTER_API_KEY from GitHub Actions."
          onClick={() => setProviderChoice("openrouter_api_key")}
        />
      </div>

      {organizationLogin ? (
        <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-cyan-200/10 bg-slate-950/70 p-4 text-sm leading-6 text-slate-300 transition hover:border-cyan-200/25 hover:bg-cyan-300/[0.04]">
          <input
            data-testid="provider-scope-organization"
            type="checkbox"
            checked={useOrganizationSecret}
            onChange={(event) =>
              setUseOrganizationSecret(event.currentTarget.checked)
            }
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
            On your own computer, open a terminal in the {repositoryFullName}
            repository directory.
          </li>
          <li>
            Run the command below to connect this AI provider to the repository.
          </li>
          <li>Open a test pull request and ReviewRouter will run in CI.</li>
        </ol>
        {activeCommand ? (
          <CodeBlock
            code={activeCommand.command}
            className="mt-4 rounded-xl p-3 text-xs leading-5"
          />
        ) : (
          <p className="mt-4 rounded-xl border border-red-300/20 bg-red-300/[0.08] p-3 text-sm text-red-100">
            No command is available for this provider and scope.
          </p>
        )}
        <p className="mt-3 text-xs leading-5 text-emerald-100/80">
          {providerDetails.footnote} ReviewRouter SaaS never receives provider
          credentials.
        </p>
      </div>
    </div>
  );
}

function ProviderChoiceButton({
  active,
  testId,
  title,
  body,
  onClick,
}: {
  readonly active: boolean;
  readonly testId: string;
  readonly title: string;
  readonly body: string;
  readonly onClick: () => void;
}): React.ReactElement {
  return (
    <button
      data-testid={testId}
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-2xl border p-4 text-left transition duration-200 hover:-translate-y-0.5 hover:saturate-125 active:translate-y-0 ${
        active
          ? "border-cyan-300/45 bg-cyan-300/[0.12] shadow-[0_16px_40px_-28px_rgba(0,240,255,0.95)]"
          : "border-cyan-200/10 bg-slate-950/60 hover:border-cyan-200/25 hover:bg-cyan-300/[0.04]"
      }`}
    >
      <span className="block text-sm font-semibold text-cyan-50">{title}</span>
      <span className="mt-1 block text-xs leading-5 text-slate-400">
        {body}
      </span>
    </button>
  );
}
