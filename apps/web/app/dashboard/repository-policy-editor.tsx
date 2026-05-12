"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState, type FocusEvent } from "react";
import * as RadixSelect from "@radix-ui/react-select";
import * as Tooltip from "@radix-ui/react-tooltip";
import type {
  ReviewConfiguration,
  ReviewProviderConfiguration,
} from "@reviewrouter/features-review-config";
import { FormSubmitButton } from "../form-submit-button";
import {
  checkProviderRepositorySecretClientAction,
  clearRepositoryReviewConfigClientAction,
  saveRepositoryReviewConfigClientAction,
} from "./actions";

type DashboardFormAction = (formData: FormData) => void | Promise<void>;

type RepositoryPolicyEditorRepository = {
  readonly id: string;
  readonly fullName: string;
  readonly selected: boolean;
  readonly archived: boolean;
};

type RepositoryPolicyEditorConfig = {
  readonly version: number;
  readonly config: ReviewConfiguration;
} | null;

type RepositorySecretCheckTarget = {
  readonly workspaceId: string;
  readonly repositoryId: string;
};

type ProviderSecretStatus =
  | "checking"
  | "available_repository"
  | "available_organization"
  | "not_available_to_repository"
  | "missing"
  | "permission_required"
  | "unknown";

type ReviewModelOption = {
  readonly value: string;
  readonly label: string;
  readonly provider: "codex" | "openrouter";
  readonly description?: string;
  readonly badge?: "FREE RECOMMENDED" | "FREE" | "PAID" | "Unsupported";
  readonly disabled?: boolean;
};

const providerAuthOptions = [
  {
    value: "codex_subscription_oauth",
    label: "Codex OAuth",
    description: "Uses the user's Codex subscription in GitHub Actions.",
  },
  {
    value: "codex_openai_api_key",
    label: "Codex API key",
    description: "Uses OPENAI_API_KEY from GitHub Actions secrets.",
  },
  {
    value: "openrouter_api_key",
    label: "OpenRouter API key",
    description: "Uses OPENROUTER_API_KEY from GitHub Actions secrets.",
  },
] as const;

const reasoningEffortOptions = [
  { value: "low", label: "Low", description: "Faster and cheaper." },
  { value: "medium", label: "Medium", description: "Balanced default." },
  { value: "high", label: "High", description: "Deeper review pass." },
  { value: "xhigh", label: "XHigh", description: "Maximum reasoning depth." },
] as const;

const failOnSeverityOptions = [
  { value: "off", label: "Off", description: "Never fail the check." },
  {
    value: "critical",
    label: "Critical",
    description: "Block only critical findings.",
  },
  { value: "major", label: "Major", description: "Block major and critical." },
] as const;

const agenticContextOptions = [
  {
    value: "true",
    label: "Enabled",
    description: "Codex can read related files in read-only sandbox.",
  },
  {
    value: "false",
    label: "Disabled",
    description: "Use supplied diff and deterministic context only.",
  },
] as const;

type DashboardSelectOption = {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
};

const fieldHelp = {
  providerAuthMode:
    "Where the review action gets model credentials. Codex OAuth uses the connected Codex subscription; API-key modes use GitHub Actions secrets.",
  model:
    "Model passed to the review runtime. Pick a known model or type a custom model name.",
  reasoningEffort:
    "How much reasoning depth Codex should spend on a review. Higher values can improve depth but usually cost more time.",
  fastMode:
    "When enabled, ReviewRouter asks the runtime to favor shorter, faster review passes.",
  failOnSeverity:
    "Controls which finding severity makes the GitHub check fail.",
  inlineMaxComments:
    "Maximum number of inline PR comments ReviewRouter should post in one review run.",
  targetTokensPerBatch:
    "Approximate context budget per review batch. Higher values let the runtime inspect more context per pass.",
  agenticContext:
    "Allows Codex to inspect related files in the repository instead of relying only on the supplied diff.",
  providers: "Run one or more providers in parallel and merge their findings.",
  providerMaxParallel:
    "Maximum number of selected providers ReviewRouter may run at the same time.",
  inlineMinAgreement:
    "Number of providers that should agree before an inline finding is treated as agreed.",
} as const;

const defaultCodexProvider = {
  kind: "codex",
  authMode: "codex_subscription_oauth",
  model: "gpt-5.5",
  reasoningEffort: "medium",
  agenticContext: true,
  fastMode: false,
} satisfies ReviewProviderConfiguration;

const secretMetadataByAuthMode = {
  codex_subscription_oauth: {
    providerKind: "codex",
    secretName: "CODEX_AUTH_JSON",
    label: "Codex OAuth",
    description:
      "Codex OAuth uses CODEX_AUTH_JSON from GitHub Actions secrets.",
    commandSuffix: "< ~/.codex/auth.json",
    recovery:
      "Run the Codex OAuth setup command from the setup panel, or seed auth.json from a trusted machine.",
  },
  codex_openai_api_key: {
    providerKind: "codex",
    secretName: "OPENAI_API_KEY",
    label: "Codex API key",
    description:
      "Codex API-key mode uses OPENAI_API_KEY from GitHub Actions secrets.",
    commandSuffix: "",
    recovery: "Create an OpenAI API key, then store it as a GitHub secret.",
  },
  openrouter_api_key: {
    providerKind: "openrouter",
    secretName: "OPENROUTER_API_KEY",
    label: "OpenRouter API key",
    description:
      "OpenRouter providers use OPENROUTER_API_KEY from GitHub Actions secrets.",
    commandSuffix: "",
    recovery: "Create an OpenRouter API key, then store it as a GitHub secret.",
  },
} as const satisfies Record<
  ReviewProviderConfiguration["authMode"],
  {
    readonly providerKind: ReviewProviderConfiguration["kind"];
    readonly secretName: string;
    readonly label: string;
    readonly description: string;
    readonly commandSuffix: string;
    readonly recovery: string;
  }
>;

function ProviderSecretNotice({
  authMode,
  repositoryFullName,
  secretCheckTarget,
}: {
  readonly authMode: ReviewProviderConfiguration["authMode"];
  readonly repositoryFullName?: string | undefined;
  readonly secretCheckTarget?: RepositorySecretCheckTarget | undefined;
}): React.ReactElement {
  const [secretStatus, setSecretStatus] = useState<ProviderSecretStatus>(
    secretCheckTarget ? "checking" : "missing",
  );
  const [refreshVersion, setRefreshVersion] = useState(0);
  const metadata = secretMetadataByAuthMode[authMode];
  const command = repositoryFullName
    ? `gh secret set ${metadata.secretName} --repo ${repositoryFullName}${metadata.commandSuffix ? ` ${metadata.commandSuffix}` : ""}`
    : `gh secret set ${metadata.secretName} --repo <owner>/<repo>${metadata.commandSuffix ? ` ${metadata.commandSuffix}` : ""}`;
  const secretWorkspaceId = secretCheckTarget?.workspaceId;
  const secretRepositoryId = secretCheckTarget?.repositoryId;

  useEffect(() => {
    if (!secretWorkspaceId || !secretRepositoryId) {
      setSecretStatus("missing");
      return;
    }

    let cancelled = false;
    const formData = new FormData();
    formData.set("workspaceId", secretWorkspaceId);
    formData.set("repositoryId", secretRepositoryId);
    formData.set("providerKind", metadata.providerKind);
    formData.set("authMode", authMode);
    setSecretStatus("checking");

    void checkProviderRepositorySecretClientAction(formData)
      .then((result) => {
        if (!cancelled) setSecretStatus(result.status);
      })
      .catch(() => {
        if (!cancelled) setSecretStatus("unknown");
      });

    return () => {
      cancelled = true;
    };
  }, [
    authMode,
    metadata.providerKind,
    refreshVersion,
    secretRepositoryId,
    secretWorkspaceId,
  ]);

  if (secretStatus === "checking") {
    return (
      <div
        role="status"
        className="rounded-xl border border-cyan-300/25 bg-cyan-300/[0.045] p-3 text-xs leading-5 text-cyan-100"
      >
        <p className="inline-flex items-center gap-2 font-semibold text-cyan-50">
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
          />
          Checking GitHub Actions secret metadata...
        </p>
        <p className="mt-1 text-cyan-100/80">
          ReviewRouter is checking whether{" "}
          <code className="font-mono">{metadata.secretName}</code> is available
          for the selected {metadata.label} provider.
        </p>
      </div>
    );
  }

  if (
    secretStatus === "available_repository" ||
    secretStatus === "available_organization"
  ) {
    return (
      <div
        role="status"
        className="rounded-xl border border-emerald-300/30 bg-emerald-300/[0.07] p-3 text-xs leading-5 text-emerald-100"
      >
        <p className="font-semibold text-emerald-50">
          <code className="font-mono">{metadata.secretName}</code>{" "}
          {secretStatus === "available_repository"
            ? "is set in this repository's GitHub Actions secrets."
            : "is available to this repository from organization GitHub Actions secrets."}
        </p>
        <p className="mt-1 text-emerald-100/85">
          {metadata.label} can use this secret in CI.
        </p>
        <SecretRefreshButton
          busy={false}
          onRefresh={() => setRefreshVersion((value) => value + 1)}
        />
      </div>
    );
  }

  return (
    <div
      role="note"
      className="rounded-xl border border-amber-300/30 bg-amber-300/[0.06] p-3 text-xs leading-5 text-amber-100"
    >
      <p className="font-semibold text-amber-50">
        {secretStatus === "not_available_to_repository" ? (
          <>
            An organization{" "}
            <code className="font-mono">{metadata.secretName}</code> secret
            exists, but this repository is not selected for access.
          </>
        ) : (
          <>
            {metadata.description} Add{" "}
            <code className="font-mono">{metadata.secretName}</code> as a
            repository secret or an organization secret available to this
            repository.
          </>
        )}
      </p>
      {secretStatus === "permission_required" || secretStatus === "unknown" ? (
        <p className="mt-1 text-amber-100/85">
          ReviewRouter could not verify GitHub secret metadata right now, so
          keep this setup command handy.
        </p>
      ) : null}
      <p className="mt-1 text-amber-100/85">
        Set a repository secret from a terminal opened in the repository
        directory:
      </p>
      <pre className="mt-1.5 overflow-x-auto rounded-md bg-slate-950/80 px-2.5 py-1.5 font-mono text-[11px] leading-5 text-amber-50">
        {command}
      </pre>
      <p className="mt-1.5 text-amber-100/85">
        {metadata.recovery} Without this secret, this provider will fail in CI.
      </p>
      {secretStatus === "not_available_to_repository" ? (
        <p className="mt-1.5 text-amber-100/85">
          Alternatively, ask an organization owner to open the organization
          Actions secret and add this repository under Repository access.
        </p>
      ) : null}
      <SecretRefreshButton
        busy={false}
        onRefresh={() => setRefreshVersion((value) => value + 1)}
      />
    </div>
  );
}

function SecretRefreshButton({
  busy,
  onRefresh,
}: {
  readonly busy: boolean;
  readonly onRefresh: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onRefresh}
      className="mt-2 inline-flex min-h-8 items-center rounded-lg border border-current/25 px-2.5 py-1 text-xs font-semibold transition hover:bg-white/[0.06] disabled:cursor-wait disabled:opacity-60"
    >
      Refresh secret status
    </button>
  );
}

export function RepositoryPolicyEditor({
  workspaceId,
  repository,
  repositoryConfig,
  effectiveConfig,
  modelOptions,
  mutationsEnabled,
  compact = false,
}: {
  readonly workspaceId: string;
  readonly repository: RepositoryPolicyEditorRepository;
  readonly repositoryConfig: RepositoryPolicyEditorConfig;
  readonly effectiveConfig: ReviewConfiguration;
  readonly modelOptions: readonly ReviewModelOption[];
  readonly mutationsEnabled: boolean;
  readonly compact?: boolean;
}): React.ReactElement {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const canEdit =
    mutationsEnabled && repository.selected && !repository.archived;
  const policyMode = repositoryConfig ? "override" : "inherits workspace";
  const panelId = `repo-settings-${repository.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  async function saveRepositorySettings(formData: FormData): Promise<void> {
    await runRepositorySettingsAction(
      () => saveRepositoryReviewConfigClientAction(formData),
      router,
      workspaceId,
    );
  }

  async function clearRepositorySettings(formData: FormData): Promise<void> {
    await runRepositorySettingsAction(
      () => clearRepositoryReviewConfigClientAction(formData),
      router,
      workspaceId,
    );
  }

  return (
    <div className={compact ? "grid gap-3" : "w-full"}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={[
          "flex w-full min-w-0 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl border border-cyan-300/25 px-4 py-3 text-xs font-semibold text-cyan-100 transition duration-200 ease-out hover:-translate-y-0.5 hover:border-cyan-300/50 hover:bg-cyan-300/[0.06] hover:saturate-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200",
          compact ? "px-3 sm:px-4" : "",
        ].join(" ")}
      >
        <span className="font-mono uppercase tracking-[0.14em]">
          Edit settings
        </span>
        <span className="inline-flex min-w-0 items-center gap-2 text-right text-slate-300">
          <span className={compact ? "hidden truncate sm:inline" : "truncate"}>
            {policyMode}
          </span>
          <ChevronIcon open={open} />
        </span>
      </button>

      {open ? (
        <div
          id={panelId}
          className={[
            "mt-4 grid gap-4 px-1 pb-1 sm:px-2",
            compact ? "col-span-full w-full flex-[1_0_100%]" : "",
          ].join(" ")}
        >
          <ReviewConfigForm
            action={saveRepositorySettings}
            config={effectiveConfig}
            modelOptions={modelOptions}
            hiddenFields={[
              { name: "workspaceId", value: workspaceId },
              { name: "repositoryId", value: repository.id },
            ]}
            mutationsEnabled={canEdit}
            submitLabel={
              repositoryConfig ? "Update repo settings" : "Save repo settings"
            }
            repositoryFullName={repository.fullName}
            repositorySecretCheckTarget={{
              workspaceId,
              repositoryId: repository.id,
            }}
          />

          {repositoryConfig ? (
            <form action={clearRepositorySettings}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="repositoryId" value={repository.id} />
              <FormSubmitButton
                variant="outline"
                size="sm"
                disabled={!canEdit}
                idleLabel="Inherit workspace default"
                pendingLabel="Saving..."
              />
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

async function runRepositorySettingsAction(
  action: () => Promise<{ readonly params: Record<string, string> }>,
  router: ReturnType<typeof useRouter>,
  workspaceId: string,
): Promise<void> {
  try {
    const { params } = await action();
    router.replace(buildDashboardMutationUrl(params), { scroll: false });
  } catch {
    router.replace(
      buildDashboardMutationUrl({
        error: "dashboard_action_failed",
        workspace: workspaceId,
        section: "repositories",
      }),
      { scroll: false },
    );
  }

  router.refresh();
}

function buildDashboardMutationUrl(params: Record<string, string>): string {
  const search = new URLSearchParams(window.location.search);

  search.delete("notice");
  search.delete("error");
  search.delete("pr");
  search.delete("version");

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      search.set(key, value);
    }
  }

  return `/dashboard?${search.toString()}`;
}

export function ReviewConfigForm({
  action,
  config,
  modelOptions,
  hiddenFields,
  mutationsEnabled,
  submitLabel,
  repositoryFullName,
  repositorySecretCheckTarget,
}: {
  readonly action: DashboardFormAction;
  readonly config: ReviewConfiguration;
  readonly modelOptions: readonly ReviewModelOption[];
  readonly hiddenFields: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly mutationsEnabled: boolean;
  readonly submitLabel: string;
  readonly repositoryFullName?: string | undefined;
  readonly repositorySecretCheckTarget?:
    | RepositorySecretCheckTarget
    | undefined;
}): React.ReactElement {
  const initialProviders =
    config.providers.length > 0 ? [...config.providers] : [config.provider];
  const [providers, setProviders] = useState(initialProviders);
  const [providerMaxParallel, setProviderMaxParallel] = useState(
    Math.min(config.execution.providerMaxParallel, initialProviders.length),
  );
  const [inlineMinAgreement, setInlineMinAgreement] = useState(
    Math.min(config.execution.inlineMinAgreement, initialProviders.length),
  );

  const modelOptionsByProvider = useMemo(
    () => ({
      codex: modelOptions.filter((option) => option.provider === "codex"),
      openrouter: modelOptions.filter(
        (option) => option.provider === "openrouter",
      ),
    }),
    [modelOptions],
  );

  function updateProvider(
    index: number,
    updater: (
      provider: ReviewProviderConfiguration,
    ) => ReviewProviderConfiguration,
  ): void {
    setProviders((current) =>
      current.map((provider, providerIndex) =>
        providerIndex === index ? updater(provider) : provider,
      ),
    );
  }

  function addProvider(): void {
    const openRouterDefault = firstSelectableModel(
      modelOptionsByProvider.openrouter,
    );
    setProviders((current) => {
      const nextProvider: ReviewProviderConfiguration = openRouterDefault
        ? {
            kind: "openrouter",
            authMode: "openrouter_api_key",
            model: openRouterDefault.value,
            reasoningEffort: "medium",
            agenticContext: true,
            fastMode: false,
          }
        : defaultCodexProvider;
      const next = [...current, nextProvider];
      setProviderMaxParallel((value) =>
        Math.min(Math.max(value, 2), next.length),
      );
      return next;
    });
  }

  function removeProvider(index: number): void {
    setProviders((current) => {
      if (current.length <= 1) {
        return current;
      }
      const next = current.filter(
        (_, providerIndex) => providerIndex !== index,
      );
      setProviderMaxParallel((value) => Math.min(value, next.length));
      setInlineMinAgreement((value) => Math.min(value, next.length));
      return next;
    });
  }

  function changeProviderAuth(
    index: number,
    authMode: ReviewProviderConfiguration["authMode"],
  ): void {
    const kind = authMode === "openrouter_api_key" ? "openrouter" : "codex";
    const nextOptions = modelOptionsByProvider[kind];
    updateProvider(index, (provider) => ({
      ...provider,
      kind,
      authMode,
      model:
        nextOptions.find(
          (option) => option.value === provider.model && !option.disabled,
        )?.value ??
        firstSelectableModel(nextOptions)?.value ??
        nextOptions[0]?.value ??
        provider.model,
    }));
  }

  return (
    <Tooltip.Provider delayDuration={180} skipDelayDuration={80}>
      <form action={action} className="grid gap-5">
        {hiddenFields.map((field) => (
          <input
            key={`${field.name}:${field.value}`}
            type="hidden"
            name={field.name}
            value={field.value}
          />
        ))}
        <input type="hidden" name="providerCount" value={providers.length} />
        <input
          type="hidden"
          name="inlineMaxComments"
          value={config.limits.inlineMaxComments}
        />
        <input
          type="hidden"
          name="targetTokensPerBatch"
          value={config.limits.targetTokensPerBatch}
        />

        <section className="grid gap-3">
          <div>
            <div className="font-mono text-sm font-semibold uppercase tracking-[0.18em] text-slate-400">
              Providers
            </div>
            <p className="mt-1 text-sm leading-6 text-slate-400">
              Run one or more providers in parallel and merge their findings.
            </p>
          </div>

          <div className="grid gap-4">
            {providers.map((provider, index) => {
              const providerOptions = modelOptionsByProvider[provider.kind];
              return (
                <div
                  key={`${index}:${provider.authMode}`}
                  className="grid gap-5 rounded-xl border border-cyan-200/20 bg-slate-950/45 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] md:p-5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="text-base font-semibold text-cyan-50">
                        Provider {index + 1}
                      </span>
                      {index === 0 ? (
                        <span className="rounded-full bg-slate-700/70 px-2 py-0.5 text-xs font-semibold text-slate-300">
                          Default
                        </span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      disabled={!mutationsEnabled || providers.length === 1}
                      onClick={() => removeProvider(index)}
                      className="text-sm font-semibold text-cyan-300 transition hover:text-cyan-100 disabled:cursor-not-allowed disabled:text-slate-500"
                    >
                      Remove
                    </button>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2 md:gap-x-8 md:gap-y-5">
                    <DashboardSelectField
                      name={`providerAuthMode.${index}`}
                      label="Provider auth"
                      helpText={fieldHelp.providerAuthMode}
                      value={provider.authMode}
                      disabled={!mutationsEnabled}
                      options={providerAuthOptions}
                      onValueChange={(value) =>
                        changeProviderAuth(
                          index,
                          value as ReviewProviderConfiguration["authMode"],
                        )
                      }
                    />
                    <DashboardModelField
                      name={`providerModel.${index}`}
                      label="Model"
                      helpText={fieldHelp.model}
                      value={provider.model}
                      disabled={!mutationsEnabled}
                      options={providerOptions}
                      onValueChange={(value) =>
                        updateProvider(index, (current) => ({
                          ...current,
                          model: value,
                        }))
                      }
                    />
                    {provider.kind === "codex" ? (
                      <>
                        <DashboardSelectField
                          name={`providerReasoningEffort.${index}`}
                          label="Reasoning effort"
                          helpText={fieldHelp.reasoningEffort}
                          value={provider.reasoningEffort}
                          disabled={!mutationsEnabled}
                          options={reasoningEffortOptions}
                          onValueChange={(value) =>
                            updateProvider(index, (current) => ({
                              ...current,
                              reasoningEffort:
                                value as ReviewProviderConfiguration["reasoningEffort"],
                            }))
                          }
                        />
                        <DashboardSwitchField
                          name={`providerFastMode.${index}`}
                          label="Fast mode"
                          helpText={fieldHelp.fastMode}
                          checked={provider.fastMode}
                          disabled={!mutationsEnabled}
                          onCheckedChange={(checked) =>
                            updateProvider(index, (current) => ({
                              ...current,
                              fastMode: checked,
                            }))
                          }
                        />
                        <DashboardSelectField
                          name={`providerAgenticContext.${index}`}
                          label="Agentic context"
                          helpText={fieldHelp.agenticContext}
                          value={String(provider.agenticContext)}
                          disabled={!mutationsEnabled}
                          options={agenticContextOptions}
                          onValueChange={(value) =>
                            updateProvider(index, (current) => ({
                              ...current,
                              agenticContext: value === "true",
                            }))
                          }
                        />
                      </>
                    ) : (
                      <>
                        <input
                          type="hidden"
                          name={`providerReasoningEffort.${index}`}
                          value={provider.reasoningEffort}
                        />
                        <input
                          type="hidden"
                          name={`providerFastMode.${index}`}
                          value={String(provider.fastMode)}
                        />
                        <input
                          type="hidden"
                          name={`providerAgenticContext.${index}`}
                          value={String(provider.agenticContext)}
                        />
                      </>
                    )}
                  </div>
                  {repositorySecretCheckTarget ? (
                    <ProviderSecretNotice
                      authMode={provider.authMode}
                      repositoryFullName={repositoryFullName}
                      secretCheckTarget={repositorySecretCheckTarget}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>

          <button
            type="button"
            aria-label="Add provider"
            disabled={!mutationsEnabled}
            onClick={addProvider}
            className="inline-flex w-fit items-center gap-2 rounded-lg border border-cyan-300/50 px-3 py-2 text-sm font-semibold text-cyan-300 transition hover:border-cyan-200 hover:bg-cyan-300/[0.08] hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-lg leading-none">+</span>
            Add provider
          </button>
        </section>

        <section className="grid gap-3">
          <div className="font-mono text-sm font-semibold uppercase tracking-[0.18em] text-slate-400">
            Execution
          </div>
          <div className="grid gap-4 md:grid-cols-3 md:gap-x-8">
            <DashboardNumberField
              name="providerMaxParallel"
              label="Max parallel providers"
              helpText={fieldHelp.providerMaxParallel}
              value={providerMaxParallel}
              min={1}
              max={providers.length}
              disabled={!mutationsEnabled}
              onValueChange={setProviderMaxParallel}
            />
            <DashboardNumberField
              name="inlineMinAgreement"
              label="Inline agreement"
              helpText={fieldHelp.inlineMinAgreement}
              value={inlineMinAgreement}
              min={1}
              max={providers.length}
              disabled={!mutationsEnabled}
              onValueChange={setInlineMinAgreement}
            />
            <DashboardSelectField
              name="failOnSeverity"
              label="Fail on severity"
              helpText={fieldHelp.failOnSeverity}
              value={config.blockingPolicy.failOnSeverity}
              disabled={!mutationsEnabled}
              options={failOnSeverityOptions}
            />
          </div>
        </section>

        <div className="flex min-w-0 items-end border-t border-cyan-200/10 pt-4">
          <FormSubmitButton
            variant="solid"
            className="w-full sm:w-auto sm:min-w-64"
            disabled={!mutationsEnabled}
            idleLabel={submitLabel}
            pendingLabel="Saving..."
          />
        </div>
      </form>
    </Tooltip.Provider>
  );
}

function firstSelectableModel(
  options: readonly ReviewModelOption[],
): ReviewModelOption | undefined {
  return options.find((option) => !option.disabled) ?? options[0];
}

function DashboardFieldLabel({
  label,
  helpText,
}: {
  readonly label: string;
  readonly helpText: string;
}): React.ReactElement {
  return (
    <span className="relative block w-full min-w-0 pr-5">
      <span className="block min-w-0 truncate">{label}</span>
      <DashboardFieldHelp label={label} helpText={helpText} />
    </span>
  );
}

function DashboardFieldHelp({
  label,
  helpText,
}: {
  readonly label: string;
  readonly helpText: string;
}): React.ReactElement {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span
          role="button"
          tabIndex={0}
          aria-label={`${label} help`}
          onClick={(event) => event.stopPropagation()}
          className="absolute right-0 top-0 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border border-slate-600/55 text-[0.55rem] font-bold lowercase leading-none tracking-normal text-slate-500 transition hover:border-slate-400/70 hover:text-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200"
        >
          i
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="z-[80] max-w-72 rounded-lg border border-cyan-200/20 bg-[#0a101c] px-3 py-2 text-xs font-medium normal-case leading-5 tracking-normal text-slate-200 shadow-[0_18px_60px_rgba(0,0,0,0.62),0_0_44px_-30px_rgba(103,232,249,0.8)]"
        >
          {helpText}
          <Tooltip.Arrow className="fill-[#0a101c]" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function DashboardNumberField({
  name,
  label,
  helpText,
  value,
  min,
  max,
  disabled,
  onValueChange,
}: {
  readonly name: string;
  readonly label: string;
  readonly helpText: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly disabled: boolean;
  readonly onValueChange: (value: number) => void;
}): React.ReactElement {
  return (
    <label className="grid min-w-0 gap-2 text-sm text-slate-300">
      <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
        <DashboardFieldLabel label={label} helpText={helpText} />
      </span>
      <input
        name={name}
        type="number"
        min={min}
        max={max}
        value={Math.min(value, max)}
        disabled={disabled}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) {
            onValueChange(Math.min(Math.max(parsed, min), max));
          }
        }}
        className={dashboardInputClassName}
      />
    </label>
  );
}

function DashboardSelectField({
  name,
  label,
  helpText,
  value,
  disabled,
  options,
  onValueChange,
}: {
  readonly name: string;
  readonly label: string;
  readonly helpText: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly options: readonly DashboardSelectOption[];
  readonly onValueChange?: (value: string) => void;
}): React.ReactElement {
  const isControlled = onValueChange !== undefined;
  const [uncontrolledValue, setUncontrolledValue] = useState(value);
  const currentValue = isControlled ? value : uncontrolledValue;
  const selectedOption = options.find(
    (option) => option.value === currentValue,
  );

  return (
    <label className="grid min-w-0 gap-2 text-sm text-slate-300">
      <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
        <DashboardFieldLabel label={label} helpText={helpText} />
      </span>
      <RadixSelect.Root
        name={name}
        value={currentValue}
        disabled={disabled}
        onValueChange={(next) => {
          if (!isControlled) setUncontrolledValue(next);
          onValueChange?.(next);
        }}
      >
        <RadixSelect.Trigger
          aria-label={label}
          className={[
            dashboardInputClassName,
            "flex items-center justify-between gap-3 text-left",
          ].join(" ")}
        >
          <RadixSelect.Value>
            <span className="min-w-0 truncate">
              {selectedOption?.label ?? currentValue}
            </span>
          </RadixSelect.Value>
          <RadixSelect.Icon className="grid h-7 w-7 shrink-0 place-items-center text-cyan-100/80">
            <ChevronIcon open={false} />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            position="popper"
            sideOffset={8}
            collisionPadding={12}
            className="z-[90] max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-cyan-200/20 bg-[#061015] p-1 text-cyan-50 shadow-[0_20px_70px_rgba(0,0,0,0.62),0_0_50px_-34px_rgba(103,232,249,0.8)]"
          >
            <RadixSelect.Viewport>
              {options.map((option) => (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  textValue={option.label}
                  className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2 text-sm text-slate-300 outline-none transition data-[highlighted]:bg-cyan-300/[0.08] data-[highlighted]:text-cyan-50 data-[state=checked]:bg-cyan-300/[0.1] data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                >
                  <RadixSelect.ItemIndicator className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center text-emerald-300">
                    ✓
                  </RadixSelect.ItemIndicator>
                  <RadixSelect.ItemText>
                    <span className="block font-semibold">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 block text-xs leading-5 text-slate-400">
                        {option.description}
                      </span>
                    ) : null}
                  </RadixSelect.ItemText>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </label>
  );
}

function DashboardSwitchField({
  name,
  label,
  helpText,
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly name: string;
  readonly label: string;
  readonly helpText: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}): React.ReactElement {
  return (
    <label className="grid min-w-0 gap-2 text-sm text-slate-300">
      <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
        <DashboardFieldLabel label={label} helpText={helpText} />
      </span>
      <span className="flex min-h-11 w-full min-w-0 items-center justify-between gap-4 rounded-xl border border-cyan-200/15 bg-slate-950/80 px-3 py-2 text-cyan-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition hover:border-cyan-200/30 has-[:focus-visible]:border-cyan-300/55 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-cyan-300/20 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
        <span className="min-w-0 truncate">
          {checked ? "Enabled" : "Disabled"}
        </span>
        <span className="relative shrink-0">
          <input
            className="peer sr-only"
            type="checkbox"
            name={name}
            value="true"
            checked={checked}
            disabled={disabled}
            onChange={(event) => onCheckedChange(event.target.checked)}
          />
          <input type="hidden" name={name} value="false" disabled={disabled} />
          <span
            aria-hidden="true"
            className="relative block h-7 w-12 rounded-full border border-cyan-200/20 bg-slate-900 transition after:absolute after:left-1 after:top-1 after:block after:h-5 after:w-5 after:translate-x-0 after:rounded-full after:bg-slate-600 after:shadow-[0_8px_22px_rgba(0,0,0,0.32)] after:transition peer-checked:border-cyan-200/60 peer-checked:bg-cyan-300/20 peer-checked:after:translate-x-5 peer-checked:after:bg-cyan-100"
          />
        </span>
      </span>
    </label>
  );
}

function DashboardModelField({
  name,
  label,
  helpText,
  value,
  disabled,
  options,
  onValueChange,
}: {
  readonly name: string;
  readonly label: string;
  readonly helpText: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly options: readonly ReviewModelOption[];
  readonly onValueChange: (value: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const selectedOption = options.find((option) => option.value === value);
  const filteredOptions = useMemo(() => {
    const query = normalizeModelSearchQuery(value);
    if (!query) {
      return options;
    }
    return options.filter((option) => modelOptionMatchesQuery(option, query));
  }, [options, value]);

  function closeWhenFocusLeaves(event: FocusEvent<HTMLLabelElement>): void {
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Node &&
      event.currentTarget.contains(nextTarget)
    ) {
      return;
    }
    setOpen(false);
  }

  return (
    <label
      className="relative grid min-w-0 gap-2 text-sm text-slate-300"
      onBlur={closeWhenFocusLeaves}
    >
      <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
        <DashboardFieldLabel label={label} helpText={helpText} />
      </span>
      <span className="relative block">
        <input
          name={name}
          value={value}
          disabled={disabled}
          onChange={(event) => onValueChange(event.target.value)}
          onFocus={() => setOpen(true)}
          aria-controls={listboxId}
          aria-expanded={open}
          aria-autocomplete="list"
          aria-label={label}
          className={[
            dashboardInputClassName,
            getModelInputPaddingClassName(selectedOption?.badge),
          ].join(" ")}
        />
        {selectedOption?.badge ? (
          <span className="pointer-events-none absolute right-11 top-1/2 -translate-y-1/2">
            <ModelBadge badge={selectedOption.badge} />
          </span>
        ) : null}
        <button
          type="button"
          disabled={disabled}
          aria-label="Open model options"
          onClick={() => setOpen((current) => !current)}
          className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-cyan-100/80 transition hover:bg-cyan-300/[0.08] hover:text-cyan-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ChevronIcon open={open} />
        </button>
      </span>
      {open ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-40 mt-2 max-h-96 overflow-y-auto rounded-xl border border-cyan-200/20 bg-[#061015] p-1 shadow-[0_20px_70px_rgba(0,0,0,0.62),0_0_50px_-34px_rgba(103,232,249,0.8)]"
        >
          {filteredOptions.length === 0 ? (
            <div className="px-3 py-3 text-sm text-slate-400">
              No listed model matches. This custom model value will be saved.
            </div>
          ) : null}
          {filteredOptions.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (option.disabled) {
                    return;
                  }
                  onValueChange(option.value);
                  setOpen(false);
                }}
                disabled={option.disabled}
                className={[
                  "grid w-full gap-0.5 rounded-lg px-3 py-2 text-left transition hover:bg-cyan-300/[0.08] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-200 disabled:cursor-not-allowed disabled:opacity-55",
                  selected
                    ? "bg-cyan-300/[0.1] text-cyan-50"
                    : "text-slate-300",
                ].join(" ")}
              >
                <span className="flex min-w-0 items-center justify-between gap-3 text-sm font-semibold">
                  <span className="min-w-0 truncate">{option.label}</span>
                  {option.badge ? <ModelBadge badge={option.badge} /> : null}
                </span>
                <span className="text-xs text-slate-500">{option.value}</span>
                {option.description ? (
                  <span className="text-xs leading-5 text-slate-400">
                    {option.description}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </label>
  );
}

function ModelBadge({
  badge,
}: {
  readonly badge: NonNullable<ReviewModelOption["badge"]>;
}): React.ReactElement {
  const className =
    badge === "FREE RECOMMENDED"
      ? "border-cyan-300/60 bg-cyan-300/15 text-cyan-100"
      : badge === "FREE"
        ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-300"
        : badge === "PAID"
          ? "border-amber-300/50 bg-amber-300/10 text-amber-200"
          : "border-slate-500/60 bg-slate-500/10 text-slate-300";
  return (
    <span
      className={[
        "rounded-md border px-1.5 py-0.5 text-[0.62rem] font-bold uppercase leading-none",
        className,
      ].join(" ")}
    >
      {badge}
    </span>
  );
}

function getModelInputPaddingClassName(
  badge: ReviewModelOption["badge"] | undefined,
): string {
  if (badge === "FREE RECOMMENDED") {
    return "pr-44";
  }
  return badge ? "pr-24" : "pr-12";
}

function normalizeModelSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

function modelOptionMatchesQuery(
  option: ReviewModelOption,
  query: string,
): boolean {
  return [option.label, option.value, option.description ?? ""].some((value) =>
    value.toLowerCase().includes(query),
  );
}

const dashboardInputClassName =
  "min-h-11 w-full rounded-xl border border-cyan-200/15 bg-slate-950/80 px-3 py-2 text-cyan-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] outline-none transition placeholder:text-slate-500 hover:border-cyan-200/30 focus:border-cyan-300/55 focus:ring-2 focus:ring-cyan-300/20 disabled:cursor-not-allowed disabled:opacity-50";

function ChevronIcon({ open }: { readonly open: boolean }): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={[
        "h-4 w-4 shrink-0 text-cyan-100 transition",
        open ? "rotate-180" : "",
      ].join(" ")}
      fill="none"
    >
      <path
        d="m4 6 4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
