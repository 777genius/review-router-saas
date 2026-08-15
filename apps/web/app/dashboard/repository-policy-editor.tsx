"use client";

import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useState,
  useTransition,
  type FocusEvent,
} from "react";
import * as RadixSelect from "@radix-ui/react-select";
import * as Tooltip from "@radix-ui/react-tooltip";
import type {
  ReviewConfiguration,
  ReviewProviderConfiguration,
} from "@reviewrouter/features-review-config";
import {
  getDefaultProviderConfigForAuthMode,
  getProviderAuthModeMetadata,
  providerKindForAuthMode,
  type ProviderAuthMode,
  type ProviderKind,
  type ReviewModelOption,
} from "@reviewrouter/features-review-providers";
import { FormSubmitButton } from "../form-submit-button";
import { ActionToast } from "../action-toast";
import {
  checkProviderRepositorySecretClientAction,
  clearRepositoryReviewConfigClientAction,
  saveRepositoryReviewConfigClientAction,
  saveWorkspaceReviewConfigClientAction,
} from "./actions";
import {
  checkProviderSecretStatusWithCache,
  clearProviderSecretStatusCacheForTest,
  type ProviderSecretAvailabilityStatus,
} from "./provider-secret-status-cache";
import { ProviderAuthLogoFrame } from "./provider-auth-logo";

export { clearProviderSecretStatusCacheForTest };

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

type ProviderSecretStatus = "checking" | ProviderSecretAvailabilityStatus;
type ReviewConfigActionParams = Record<string, string>;
type ReviewConfigActionResult = {
  readonly params: ReviewConfigActionParams;
};
type ReviewConfigActionToast = {
  readonly key: number;
  readonly tone: "success" | "warning" | "danger" | "accent";
  readonly title: string;
  readonly body: string;
};

const providerAuthModeOrder = [
  "codex_subscription_oauth_rotating",
  "claude_code_oauth",
  "openrouter_api_key",
] as const satisfies readonly ProviderAuthMode[];

const providerAuthOptionCopyByAuthMode = {
  codex_subscription_oauth_hosted_pool: {
    label: "Hosted workspace pool",
    description:
      "Uses the explicitly bound workspace pool without a repository credential secret.",
  },
  codex_subscription_oauth_rotating: {
    label: "Codex OAuth with refresh",
    description:
      "Uses a server-authorized versioned namespace with automatic GitHub-hosted refresh.",
  },
  codex_subscription_oauth: {
    label: "Codex legacy OAuth",
    description: "Uses static CODEX_AUTH_JSON without automatic refresh.",
  },
  codex_openai_api_key: {
    label: "Codex API key",
    description: "Uses OPENAI_API_KEY from GitHub Actions secrets.",
  },
  claude_code_oauth: {
    label: "Claude Code subscription",
    description: "Uses CLAUDE_CODE_OAUTH_TOKEN from GitHub Actions secrets.",
  },
  openrouter_api_key: {
    label: "OpenRouter API key",
    description: "Uses OPENROUTER_API_KEY from GitHub Actions secrets.",
  },
} as const satisfies Record<
  ProviderAuthMode,
  { readonly label: string; readonly description: string }
>;

function buildProviderAuthOptions(input: {
  readonly codexRotatingOAuthEnabled: boolean;
  readonly claudeCodeProviderEnabled: boolean;
  readonly providers: readonly ReviewProviderConfiguration[];
}): readonly DashboardSelectOption[] {
  return providerAuthModeOrder
    .filter(
      (authMode) =>
        (authMode !== "codex_subscription_oauth_rotating" ||
          input.codexRotatingOAuthEnabled) &&
        (authMode !== "claude_code_oauth" || input.claudeCodeProviderEnabled),
    )
    .map((authMode) => ({
      value: authMode,
      providerAuthMode: authMode,
      ...providerAuthOptionCopyByAuthMode[authMode],
    }));
}

const reasoningEffortOptions = [
  { value: "low", label: "Low", description: "Faster and cheaper." },
  { value: "medium", label: "Medium", description: "Balanced review pass." },
  { value: "high", label: "High", description: "Deeper review pass." },
  {
    value: "xhigh",
    label: "XHigh",
    description: "Maximum reasoning depth. Default.",
  },
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
    description: "The provider can inspect related files in read-only mode.",
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
  readonly providerAuthMode?: ProviderAuthMode;
  readonly disabled?: boolean;
};

const fieldHelp = {
  providerAuthMode:
    "Where the review action gets model credentials. Subscription modes use GitHub Actions secrets seeded from the provider CLI; API-key modes use provider API keys.",
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
    "Allows supported providers to inspect related files in the repository instead of relying only on the supplied diff.",
  providers: "Run one or more providers in parallel and merge their findings.",
  providerMaxParallel:
    "Maximum number of selected providers ReviewRouter may run at the same time.",
  inlineMinAgreement:
    "Number of providers that should agree before an inline finding is treated as agreed.",
  requiredHealthy:
    "Required providers must pass health checks and return valid review output. They do not need to produce findings.",
  reviewLanguage:
    "Natural language for the review comments and summaries (free text, e.g. Russian). Leave empty to inherit the workspace default, which is English.",
} as const;

const defaultCodexProvider = {
  ...getDefaultProviderConfigForAuthMode("codex_subscription_oauth_rotating"),
  requiredHealthy: true,
} satisfies ReviewProviderConfiguration;

const secretCopyByAuthMode = {
  codex_subscription_oauth_hosted_pool: {
    label: "Hosted workspace pool",
    description:
      "The repository uses its explicit hosted binding. No GitHub credential secret is read.",
    commandSuffix: "",
    recovery:
      "Ask a workspace owner or admin to reconnect the hosted account or switch this repository back to repository-owned mode.",
  },
  codex_subscription_oauth_rotating: {
    label: "Codex OAuth with refresh",
    description:
      "Rotating Codex OAuth uses a server-authorized, never-reused versioned namespace.",
    commandSuffix: "",
    recovery:
      "Run the rotating Codex OAuth setup command from the provider setup panel.",
  },
  codex_subscription_oauth: {
    label: "Codex OAuth",
    description:
      "Codex OAuth uses CODEX_AUTH_JSON from GitHub Actions secrets.",
    commandSuffix: "< ~/.codex/auth.json",
    recovery:
      "Run the Codex OAuth setup command from the setup panel, or seed auth.json from a trusted machine.",
  },
  codex_openai_api_key: {
    label: "Codex API key",
    description:
      "Codex API-key mode uses OPENAI_API_KEY from GitHub Actions secrets.",
    commandSuffix: "",
    recovery: "Create an OpenAI API key, then store it as a GitHub secret.",
  },
  claude_code_oauth: {
    label: "Claude Code subscription",
    description:
      "Claude Code subscription mode uses CLAUDE_CODE_OAUTH_TOKEN from GitHub Actions secrets.",
    commandSuffix: "--app actions",
    recovery:
      "Run claude setup-token on a trusted machine, then store only the printed token value.",
  },
  openrouter_api_key: {
    label: "OpenRouter API key",
    description:
      "OpenRouter providers use OPENROUTER_API_KEY from GitHub Actions secrets.",
    commandSuffix: "",
    recovery: "Create an OpenRouter API key, then store it as a GitHub secret.",
  },
} as const satisfies Record<
  ProviderAuthMode,
  {
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
  sharedProviderCount = 1,
}: {
  readonly authMode: ReviewProviderConfiguration["authMode"];
  readonly repositoryFullName?: string | undefined;
  readonly secretCheckTarget?: RepositorySecretCheckTarget | undefined;
  readonly sharedProviderCount?: number;
}): React.ReactElement {
  const rotatingCodex = authMode === "codex_subscription_oauth_rotating";
  const hostedCodex = authMode === "codex_subscription_oauth_hosted_pool";
  const [secretStatus, setSecretStatus] = useState<ProviderSecretStatus>(
    secretCheckTarget ? "checking" : "missing",
  );
  const [refreshVersion, setRefreshVersion] = useState(0);
  const authMetadata = getProviderAuthModeMetadata(authMode);
  const metadata = rotatingCodex || hostedCodex ? null : getSecretMetadata(authMode);
  const command = metadata
    ? repositoryFullName
      ? `gh secret set ${metadata.secretName} --repo ${repositoryFullName}${metadata.commandSuffix ? ` ${metadata.commandSuffix}` : ""}`
      : `gh secret set ${metadata.secretName} --repo <owner>/<repo>${metadata.commandSuffix ? ` ${metadata.commandSuffix}` : ""}`
    : null;
  const secretWorkspaceId = secretCheckTarget?.workspaceId;
  const secretRepositoryId = secretCheckTarget?.repositoryId;
  const sharedProviderCopy =
    sharedProviderCount > 1
      ? `Checked once for ${sharedProviderCount} providers using ${providerAuthOptionCopyByAuthMode[authMode].label}.`
      : null;

  useEffect(() => {
    if (!secretWorkspaceId || !secretRepositoryId) {
      setSecretStatus("missing");
      return;
    }

    let cancelled = false;
    const formData = new FormData();
    formData.set("workspaceId", secretWorkspaceId);
    formData.set("repositoryId", secretRepositoryId);
    formData.set("providerKind", authMetadata.providerKind);
    formData.set("authMode", authMode);
    setSecretStatus("checking");

    void checkProviderSecretStatusWithCache({
      authMode,
      check: checkProviderRepositorySecretClientAction,
      formData,
      forceRefresh: refreshVersion > 0,
      repositoryId: secretRepositoryId,
      workspaceId: secretWorkspaceId,
    })
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
    authMetadata.providerKind,
    refreshVersion,
    secretRepositoryId,
    secretWorkspaceId,
  ]);

  if (rotatingCodex) {
    return (
      <div
        role={secretStatus === "missing" ? "note" : "status"}
        className={
          secretStatus === "checking"
            ? "rounded-xl border border-cyan-300/25 bg-cyan-300/[0.045] p-3 text-xs leading-5 text-cyan-100"
            : secretStatus === "available_repository" ||
                secretStatus === "available_organization"
              ? "rounded-xl border border-emerald-300/30 bg-emerald-300/[0.07] p-3 text-xs leading-5 text-emerald-100"
              : "rounded-xl border border-amber-300/30 bg-amber-300/[0.06] p-3 text-xs leading-5 text-amber-100"
        }
      >
        <p className="font-semibold">
          {secretStatus === "checking"
            ? "Checking authorized versioned setup..."
            : secretStatus === "available_repository" ||
                secretStatus === "available_organization"
              ? "Authorized versioned Codex setup is active for this repository."
              : "Rotating Codex setup is not ready for this repository."}
        </p>
        <p className="mt-1 opacity-85">
          {secretStatus === "checking"
            ? "ReviewRouter is validating the exact server-owned claim, confirmed attempt, active namespace, workflow evidence, and provider activation outcome."
            : secretStatus === "available_repository" ||
                secretStatus === "available_organization"
              ? "Readiness comes from the confirmed versioned claim and namespace activation chain; GitHub-hosted runs refresh the active namespace without rewriting the protected default branch."
              : "Run the rotating OAuth setup command from the provider setup panel. A generic repository secret cannot satisfy this readiness check."}
        </p>
        {sharedProviderCopy ? (
          <p className="mt-1 opacity-75">{sharedProviderCopy}</p>
        ) : null}
        <SecretRefreshButton
          busy={secretStatus === "checking"}
          onRefresh={() => setRefreshVersion((value) => value + 1)}
        />
      </div>
    );
  }

  if (!metadata || !command) {
    throw new Error(`missing_provider_secret_metadata:${authMode}`);
  }

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
        {sharedProviderCopy ? (
          <p className="mt-1 text-cyan-100/70">{sharedProviderCopy}</p>
        ) : null}
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
        {sharedProviderCopy ? (
          <p className="mt-1 text-emerald-100/75">{sharedProviderCopy}</p>
        ) : null}
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
        Set a repository secret from any terminal where GitHub CLI is
        authenticated. The command targets this repository with{" "}
        <code className="font-mono">--repo</code>:
      </p>
      {sharedProviderCopy ? (
        <p className="mt-1 text-amber-100/80">{sharedProviderCopy}</p>
      ) : null}
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

function getSecretMetadata(authMode: ProviderAuthMode): {
  readonly providerKind: ProviderKind;
  readonly secretName: string;
  readonly label: string;
  readonly description: string;
  readonly commandSuffix: string;
  readonly recovery: string;
} {
  const authMetadata = getProviderAuthModeMetadata(authMode);
  const secretName = authMetadata.secretNames[0];
  if (!secretName) {
    throw new Error(`missing_provider_secret_name:${authMode}`);
  }
  return {
    providerKind: authMetadata.providerKind,
    secretName,
    ...secretCopyByAuthMode[authMode],
  };
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

export function RepositoryPolicyOverrideDetails({
  workspaceId,
  repository,
  repositoryConfig,
  effectiveConfig,
  configVersion,
  modelOptions,
  mutationsEnabled,
  editDisabledReason,
  codexRotatingOAuthEnabled = false,
  claudeCodeProviderEnabled = true,
}: {
  readonly workspaceId: string;
  readonly repository: RepositoryPolicyEditorRepository;
  readonly repositoryConfig: RepositoryPolicyEditorConfig;
  readonly effectiveConfig: ReviewConfiguration;
  readonly configVersion: number;
  readonly modelOptions: readonly ReviewModelOption[];
  readonly mutationsEnabled: boolean;
  readonly editDisabledReason?: string | undefined;
  readonly codexRotatingOAuthEnabled?: boolean;
  readonly claudeCodeProviderEnabled?: boolean;
}): React.ReactElement {
  const reviewConfigAction = useReviewConfigActionToast();
  const [open, setOpen] = useState(false);
  const panelId = `repo-review-config-${repository.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const canEdit =
    mutationsEnabled && repository.selected && !repository.archived;

  async function saveRepositoryOverride(formData: FormData): Promise<void> {
    await reviewConfigAction.run(
      () => saveRepositoryReviewConfigClientAction(formData),
      {
        error: "dashboard_action_stale",
        workspace: workspaceId,
        section: "policy",
      },
    );
  }

  async function clearRepositoryOverride(formData: FormData): Promise<void> {
    await reviewConfigAction.run(
      () => clearRepositoryReviewConfigClientAction(formData),
      {
        error: "dashboard_action_stale",
        workspace: workspaceId,
        section: "policy",
      },
    );
  }

  return (
    <>
      {reviewConfigAction.toast}
      <div className="rounded-2xl border border-cyan-200/10 bg-cyan-300/[0.04] p-4">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          className="w-full cursor-pointer rounded-xl text-left outline-none transition focus-visible:ring-2 focus-visible:ring-cyan-300/40"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-cyan-50">
                {repository.fullName}
              </p>
              <p className="text-xs text-slate-400">
                {repositoryConfig
                  ? `Repository override / v${configVersion}`
                  : `Inherits workspace default / v${configVersion}`}
              </p>
            </div>
            <span
              className={[
                "rounded-full border px-3 py-1 font-mono text-xs font-semibold uppercase tracking-[0.16em]",
                repositoryConfig
                  ? "border-amber-300/40 bg-amber-300/[0.08] text-amber-100"
                  : "border-emerald-300/30 bg-emerald-300/[0.07] text-emerald-100",
              ].join(" ")}
            >
              {repositoryConfig ? "override" : "inherits"}
            </span>
          </div>
        </button>

        {open ? (
          <div id={panelId} className="mt-4 space-y-3">
            <ReviewConfigForm
              action={saveRepositoryOverride}
              config={effectiveConfig}
              modelOptions={modelOptions}
              codexRotatingOAuthEnabled={codexRotatingOAuthEnabled}
              claudeCodeProviderEnabled={claudeCodeProviderEnabled}
              hiddenFields={[
                { name: "workspaceId", value: workspaceId },
                { name: "repositoryId", value: repository.id },
              ]}
              mutationsEnabled={canEdit}
              repositoryFullName={repository.fullName}
              repositorySecretCheckTarget={{
                workspaceId,
                repositoryId: repository.id,
              }}
              submitLabel={
                repositoryConfig ? "Update override" : "Save override"
              }
            />
            {!canEdit && editDisabledReason ? (
              <p className="text-xs leading-5 text-amber-100/85">
                {editDisabledReason}
              </p>
            ) : null}
            {repositoryConfig ? (
              <form action={clearRepositoryOverride}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input
                  type="hidden"
                  name="repositoryId"
                  value={repository.id}
                />
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
    </>
  );
}

export function RepositoryPolicyEditor({
  workspaceId,
  repository,
  repositoryConfig,
  effectiveConfig,
  modelOptions,
  mutationsEnabled,
  editDisabledReason,
  codexRotatingOAuthEnabled = false,
  claudeCodeProviderEnabled = true,
  compact = false,
}: {
  readonly workspaceId: string;
  readonly repository: RepositoryPolicyEditorRepository;
  readonly repositoryConfig: RepositoryPolicyEditorConfig;
  readonly effectiveConfig: ReviewConfiguration;
  readonly modelOptions: readonly ReviewModelOption[];
  readonly mutationsEnabled: boolean;
  readonly editDisabledReason?: string | undefined;
  readonly codexRotatingOAuthEnabled?: boolean;
  readonly claudeCodeProviderEnabled?: boolean;
  readonly compact?: boolean;
}): React.ReactElement {
  const reviewConfigAction = useReviewConfigActionToast();
  const [open, setOpen] = useState(false);
  const canEdit =
    mutationsEnabled && repository.selected && !repository.archived;
  const policyMode = repositoryConfig ? "override" : "inherits workspace";
  const panelId = `repo-settings-${repository.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  async function saveRepositorySettings(formData: FormData): Promise<void> {
    await reviewConfigAction.run(
      () => saveRepositoryReviewConfigClientAction(formData),
      {
        error: "dashboard_action_stale",
        workspace: workspaceId,
        section: "repositories",
      },
    );
  }

  async function clearRepositorySettings(formData: FormData): Promise<void> {
    await reviewConfigAction.run(
      () => clearRepositoryReviewConfigClientAction(formData),
      {
        error: "dashboard_action_stale",
        workspace: workspaceId,
        section: "repositories",
      },
    );
  }

  return (
    <div
      className={
        compact
          ? "grid gap-3 justify-items-end"
          : "grid w-full justify-items-end"
      }
    >
      {reviewConfigAction.toast}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={[
          "inline-flex max-w-full min-w-0 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl border border-cyan-300/25 px-4 py-3 text-xs font-semibold text-cyan-100 transition duration-200 ease-out hover:-translate-y-0.5 hover:border-cyan-300/50 hover:bg-cyan-300/[0.06] hover:saturate-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200",
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
            "mt-4 grid w-full justify-self-stretch gap-4 px-1 pb-1 sm:px-2",
            compact ? "col-span-full w-full flex-[1_0_100%]" : "",
          ].join(" ")}
        >
          <ReviewConfigForm
            action={saveRepositorySettings}
            config={effectiveConfig}
            modelOptions={modelOptions}
            codexRotatingOAuthEnabled={codexRotatingOAuthEnabled}
            claudeCodeProviderEnabled={claudeCodeProviderEnabled}
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
          {!canEdit && editDisabledReason ? (
            <p className="text-xs leading-5 text-amber-100/85">
              {editDisabledReason}
            </p>
          ) : null}

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

function useReviewConfigActionToast(): {
  readonly toast: React.ReactElement | null;
  readonly run: (
    action: () => Promise<ReviewConfigActionResult>,
    fallbackParams: ReviewConfigActionParams,
  ) => Promise<void>;
} {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [toast, setToast] = useState<ReviewConfigActionToast | null>(null);

  return {
    toast: toast ? (
      <ActionToast
        key={toast.key}
        tone={toast.tone}
        title={toast.title}
        body={toast.body}
      />
    ) : null,
    run: async (action, fallbackParams) => {
      let params: ReviewConfigActionParams;
      try {
        ({ params } = await action());
      } catch {
        params = fallbackParams;
      }

      replaceDashboardContextUrl(params);
      setToast((current) => ({
        ...reviewConfigActionToast(params),
        key: (current?.key ?? 0) + 1,
      }));
      startTransition(() => router.refresh());
    },
  };
}

function replaceDashboardContextUrl(params: ReviewConfigActionParams): void {
  const url = new URL(window.location.href);
  let changed = false;

  for (const key of ["notice", "error", "pr", "version"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  for (const key of ["workspace", "section"] as const) {
    const value = params[key];
    if (value && url.searchParams.get(key) !== value) {
      url.searchParams.set(key, value);
      changed = true;
    }
  }

  if (!changed) return;

  const search = url.searchParams.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${search ? `?${search}` : ""}${url.hash}`,
  );
}

function reviewConfigActionToast(
  params: ReviewConfigActionParams,
): Omit<ReviewConfigActionToast, "key"> {
  if (params.error) {
    return {
      tone: "danger",
      title: "Action needs attention",
      body: reviewConfigActionErrorText(params.error),
    };
  }

  switch (params.notice) {
    case "review_config_saved":
      return {
        tone: "success",
        title: "Model settings saved",
        body: "Review configuration was saved. Future action runs can fetch it through OIDC.",
      };
    case "repository_review_config_saved":
      return {
        tone: "success",
        title: "Model settings saved",
        body: params.repository
          ? `Repository review configuration was saved for ${params.repository}.`
          : "Repository review configuration was saved.",
      };
    case "repository_review_config_cleared":
      return {
        tone: "success",
        title: "Model settings saved",
        body: params.repository
          ? `${params.repository} now inherits the workspace review configuration.`
          : "Repository override was cleared.",
      };
    default:
      return {
        tone: "success",
        title: "Action complete",
        body: "Dashboard settings were saved.",
      };
  }
}

function reviewConfigActionErrorText(error: string): string {
  switch (error) {
    case "dashboard_action_stale":
      return "The dashboard was updated while this page was open. Refresh the page, then try again.";
    case "dashboard_action_failed":
      return "The dashboard could not complete this action. Refresh and try again.";
    case "dashboard_mutation_requires_sign_in":
      return "Sign in with GitHub before changing repository setup.";
    case "workspace_mutation_forbidden":
      return "Your GitHub user is not an owner/admin for this workspace.";
    case "repository_config_mutation_forbidden":
      return "Your GitHub user needs maintain or admin access on this repository to change ReviewRouter runtime settings directly.";
    case "repository_mutation_forbidden":
      return "Your GitHub user needs write, maintain, or admin access on this repository to change repository-level ReviewRouter settings.";
    case "repository_not_selected":
      return "This repository is no longer selected for the GitHub App installation.";
    case "repository_archived":
      return "Archived repositories cannot be changed.";
    case "rate_limited":
      return "Too many dashboard requests for this resource. Wait a bit before retrying.";
    case "invalid_form":
      return "The submitted form is invalid. Refresh the dashboard and try again.";
    case "entitlement_denied":
      return "This workspace plan does not allow that action. Check the plan status or feature flags.";
    case "codex_rotating_not_enabled":
      return "Rotating Codex OAuth is not enabled for this ReviewRouter deployment.";
    case "codex_rotating_repository_scope_required":
      return "Codex rotating OAuth must be configured per repository, not as a workspace default.";
    case "codex_rotating_single_provider_required":
      return "Codex rotating OAuth supports exactly one Codex provider in this repository.";
    case "duplicate_review_provider":
      return "Duplicate provider/model rows are not supported yet. Pick a different model for duplicate providers.";
    case "codex_legacy_auth_requires_reconnect":
      return "Legacy Codex OAuth is disabled. Reconnect Codex with the rotating setup command.";
    case "codex_api_key_setup_disabled":
      return "Codex API-key setup is disabled. Use Codex OAuth rotating instead.";
    default:
      return "The dashboard could not save these settings. Retry once, then check server logs if it repeats.";
  }
}

export function WorkspaceReviewConfigForm({
  workspaceId,
  config,
  modelOptions,
  codexRotatingOAuthEnabled = false,
  claudeCodeProviderEnabled = true,
  mutationsEnabled,
}: {
  readonly workspaceId: string;
  readonly config: ReviewConfiguration;
  readonly modelOptions: readonly ReviewModelOption[];
  readonly codexRotatingOAuthEnabled?: boolean;
  readonly claudeCodeProviderEnabled?: boolean;
  readonly mutationsEnabled: boolean;
}): React.ReactElement {
  const reviewConfigAction = useReviewConfigActionToast();

  async function saveWorkspaceSettings(formData: FormData): Promise<void> {
    await reviewConfigAction.run(
      () => saveWorkspaceReviewConfigClientAction(formData),
      {
        error: "dashboard_action_stale",
        workspace: workspaceId,
        section: "policy",
      },
    );
  }

  return (
    <>
      {reviewConfigAction.toast}
      <ReviewConfigForm
        action={saveWorkspaceSettings}
        config={config}
        modelOptions={modelOptions}
        codexRotatingOAuthEnabled={codexRotatingOAuthEnabled}
        claudeCodeProviderEnabled={claudeCodeProviderEnabled}
        hiddenFields={[{ name: "workspaceId", value: workspaceId }]}
        mutationsEnabled={mutationsEnabled}
        submitLabel="Save workspace default"
      />
    </>
  );
}

export function ReviewConfigForm({
  action,
  config,
  modelOptions,
  codexRotatingOAuthEnabled = false,
  claudeCodeProviderEnabled = true,
  hiddenFields,
  mutationsEnabled,
  submitLabel,
  repositoryFullName,
  repositorySecretCheckTarget,
}: {
  readonly action: DashboardFormAction;
  readonly config: ReviewConfiguration;
  readonly modelOptions: readonly ReviewModelOption[];
  readonly codexRotatingOAuthEnabled?: boolean;
  readonly claudeCodeProviderEnabled?: boolean;
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
  const configuredProviders =
    config.providers.length > 0 ? [...config.providers] : [config.provider];
  const legacyCodexReconnectRequired = configuredProviders.some(
    isDisabledCodexAuthMode,
  );
  const initialProviders = ensureAtLeastOneRequiredProvider(
    normalizeCodexRotatingProvidersForForm(
      configuredProviders.map(replaceDisabledCodexProvider),
    ),
  );
  const [providers, setProviders] = useState(initialProviders);
  const [providerMaxParallel, setProviderMaxParallel] = useState(
    Math.min(config.execution.providerMaxParallel, initialProviders.length),
  );
  const [inlineMinAgreement, setInlineMinAgreement] = useState(
    Math.min(config.execution.inlineMinAgreement, initialProviders.length),
  );
  const providerAuthOptions = useMemo(
    () =>
      buildProviderAuthOptions({
        codexRotatingOAuthEnabled,
        claudeCodeProviderEnabled,
        providers,
      }),
    [codexRotatingOAuthEnabled, claudeCodeProviderEnabled, providers],
  );

  const modelOptionsByProvider = useMemo(
    (): Record<ProviderKind, readonly ReviewModelOption[]> => ({
      codex: modelOptions.filter((option) => option.provider === "codex"),
      claude: modelOptions.filter((option) => option.provider === "claude"),
      openrouter: modelOptions.filter(
        (option) => option.provider === "openrouter",
      ),
    }),
    [modelOptions],
  );
  const providerSecretUsageCounts = useMemo(() => {
    const counts = new Map<ReviewProviderConfiguration["authMode"], number>();

    for (const provider of providers) {
      counts.set(provider.authMode, (counts.get(provider.authMode) ?? 0) + 1);
    }

    return counts;
  }, [providers]);

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
            reasoningEffort: "xhigh",
            agenticContext: true,
            fastMode: false,
            requiredHealthy: false,
          }
        : { ...defaultCodexProvider, requiredHealthy: false };
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
      return ensureAtLeastOneRequiredProvider(next);
    });
  }

  function changeProviderAuth(
    index: number,
    authMode: ReviewProviderConfiguration["authMode"],
  ): void {
    const kind = providerKindForAuthMode(authMode);
    const defaultProvider = getDefaultProviderConfigForAuthMode(authMode);
    const nextOptions = modelOptionsByProvider[kind];
    setProviders((current) => {
      const fallbackProvider = {
        ...defaultProvider,
        requiredHealthy: false,
      } satisfies ReviewProviderConfiguration;
      const nextProvider = resolveProviderAfterAuthChange({
        provider: current[index] ?? fallbackProvider,
        authMode,
        kind,
        defaultProvider: fallbackProvider,
        nextOptions,
      });
      if (
        authMode === "codex_subscription_oauth_rotating" &&
        current.some(
          (provider, providerIndex) =>
            providerIndex !== index &&
            provider.authMode === "codex_subscription_oauth_rotating",
        )
      ) {
        return current;
      }
      return ensureAtLeastOneRequiredProvider(
        current.map((provider, providerIndex) =>
          providerIndex === index ? nextProvider : provider,
        ),
      );
    });
  }

  const codexRotatingSelected = providers.some(
    (provider) => provider.authMode === "codex_subscription_oauth_rotating",
  );

  function providerAuthOptionsForProvider(
    provider: ReviewProviderConfiguration,
  ): readonly DashboardSelectOption[] {
    return providerAuthOptions.map((option) => {
      if (
        option.providerAuthMode === "codex_subscription_oauth_rotating" &&
        codexRotatingSelected &&
        provider.authMode !== "codex_subscription_oauth_rotating"
      ) {
        return {
          ...option,
          disabled: true,
          description:
            "Only one Codex OAuth with refresh provider is supported per repository.",
        };
      }
      return option;
    });
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
        {Object.entries(config.investigationRollout).map(([name, enabled]) => (
          <input
            key={name}
            type="hidden"
            name={`investigationRollout.${name}`}
            value={String(enabled)}
          />
        ))}
        {legacyCodexReconnectRequired ? (
          <div className="rounded-xl border border-amber-300/25 bg-amber-300/[0.08] p-3 text-sm leading-6 text-amber-50">
            Legacy Codex setup requires reconnect. This form has switched Codex
            to the production rotating OAuth mode; save the config, create the
            setup PR, and run the fresh Codex setup command.
          </div>
        ) : null}

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
              const requiredProviderCount = providers.filter(
                (candidate) => candidate.requiredHealthy,
              ).length;
              const firstProviderWithAuthModeIndex = providers.findIndex(
                (candidate) => candidate.authMode === provider.authMode,
              );
              const showProviderSecretNotice =
                repositorySecretCheckTarget &&
                firstProviderWithAuthModeIndex === index;

              return (
                <div
                  key={`${index}:${provider.authMode}`}
                  className={`grid gap-5 ${
                    index > 0 ? "border-t border-cyan-200/10 pt-6" : ""
                  }`}
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
                      options={providerAuthOptionsForProvider(provider)}
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
                    <DashboardSwitchField
                      name={`providerRequiredHealthy.${index}`}
                      label="Required healthy"
                      helpText={fieldHelp.requiredHealthy}
                      checked={
                        provider.authMode ===
                        "codex_subscription_oauth_rotating"
                          ? true
                          : provider.requiredHealthy
                      }
                      disabled={
                        !mutationsEnabled ||
                        provider.authMode ===
                          "codex_subscription_oauth_rotating"
                      }
                      onCheckedChange={(checked) => {
                        if (!checked && requiredProviderCount <= 1) return;
                        updateProvider(index, (current) => ({
                          ...current,
                          requiredHealthy: checked,
                        }));
                      }}
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
                  {showProviderSecretNotice ? (
                    <ProviderSecretNotice
                      authMode={provider.authMode}
                      repositoryFullName={repositoryFullName}
                      secretCheckTarget={repositorySecretCheckTarget}
                      sharedProviderCount={
                        providerSecretUsageCounts.get(provider.authMode) ?? 1
                      }
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

        <section className="grid gap-3">
          <div className="font-mono text-sm font-semibold uppercase tracking-[0.18em] text-slate-400">
            Output
          </div>
          <div className="grid gap-4 md:grid-cols-3 md:gap-x-8">
            <DashboardReviewLanguageField
              defaultValue={config.reviewLanguage ?? ""}
              disabled={!mutationsEnabled}
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

function isDisabledCodexAuthMode(
  provider: ReviewProviderConfiguration,
): boolean {
  return (
    provider.authMode === "codex_subscription_oauth" ||
    provider.authMode === "codex_openai_api_key"
  );
}

function replaceDisabledCodexProvider(
  provider: ReviewProviderConfiguration,
): ReviewProviderConfiguration {
  if (!isDisabledCodexAuthMode(provider)) {
    return provider;
  }
  return {
    ...provider,
    kind: "codex",
    authMode: "codex_subscription_oauth_rotating",
  };
}

function normalizeCodexRotatingProvidersForForm(
  providers: readonly ReviewProviderConfiguration[],
): ReviewProviderConfiguration[] {
  return providers.map((provider) =>
    provider.authMode === "codex_subscription_oauth_rotating"
      ? { ...provider, kind: "codex", requiredHealthy: true }
      : provider,
  );
}

function resolveProviderAfterAuthChange(input: {
  readonly provider: ReviewProviderConfiguration;
  readonly authMode: ReviewProviderConfiguration["authMode"];
  readonly kind: ProviderKind;
  readonly defaultProvider: ReviewProviderConfiguration;
  readonly nextOptions: readonly ReviewModelOption[];
}): ReviewProviderConfiguration {
  const { provider, authMode, kind, defaultProvider, nextOptions } = input;
  return {
    ...provider,
    kind,
    authMode,
    model:
      nextOptions.find(
        (option) => option.value === provider.model && !option.disabled,
      )?.value ??
      firstSelectableModel(nextOptions)?.value ??
      nextOptions[0]?.value ??
      defaultProvider.model,
    reasoningEffort:
      kind === "codex" && provider.kind === "codex"
        ? provider.reasoningEffort
        : defaultProvider.reasoningEffort,
    agenticContext:
      supportsAgenticContext(kind) && supportsAgenticContext(provider.kind)
        ? provider.agenticContext
        : defaultProvider.agenticContext,
    fastMode:
      kind === "codex" && provider.kind === "codex"
        ? provider.fastMode
        : defaultProvider.fastMode,
    requiredHealthy:
      authMode === "codex_subscription_oauth_rotating"
        ? true
        : provider.requiredHealthy,
  };
}

function supportsAgenticContext(kind: ProviderKind): boolean {
  return kind === "codex" || kind === "claude" || kind === "openrouter";
}

function ensureAtLeastOneRequiredProvider(
  providers: readonly ReviewProviderConfiguration[],
): ReviewProviderConfiguration[] {
  if (providers.some((provider) => provider.requiredHealthy)) {
    return [...providers];
  }

  return providers.map((provider, index) => ({
    ...provider,
    requiredHealthy: index === 0,
  }));
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
          className="z-[80] max-w-72 rounded-lg border border-cyan-200/20 bg-[var(--rr-surface-menu)] px-3 py-2 text-xs font-medium normal-case leading-5 tracking-normal text-slate-200 shadow-[0_18px_60px_rgba(0,0,0,0.62),0_0_44px_-30px_rgba(103,232,249,0.8)]"
        >
          {helpText}
          <Tooltip.Arrow className="fill-[var(--rr-surface-menu)]" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const reviewLanguageSuggestions = [
  "English",
  "Russian",
  "Ukrainian",
  "Spanish",
  "Portuguese",
  "French",
  "German",
  "Italian",
  "Chinese",
  "Japanese",
  "Korean",
] as const;

function DashboardReviewLanguageField({
  defaultValue,
  disabled,
}: {
  readonly defaultValue: string;
  readonly disabled: boolean;
}): React.ReactElement {
  const listId = "review-language-suggestions";
  return (
    <label className="grid min-w-0 gap-2 text-sm text-slate-300">
      <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
        <DashboardFieldLabel
          label="Review language"
          helpText={fieldHelp.reviewLanguage}
        />
      </span>
      <input
        name="reviewLanguage"
        type="text"
        defaultValue={defaultValue}
        placeholder="English (default)"
        maxLength={40}
        autoComplete="off"
        spellCheck={false}
        list={listId}
        disabled={disabled}
        className={dashboardInputClassName}
      />
      <datalist id={listId}>
        {reviewLanguageSuggestions.map((language) => (
          <option key={language} value={language} />
        ))}
      </datalist>
    </label>
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
            <span className="flex min-w-0 items-center gap-2">
              {selectedOption?.providerAuthMode ? (
                <ProviderAuthLogoFrame
                  authMode={selectedOption.providerAuthMode}
                />
              ) : null}
              <span className="min-w-0 truncate">
                {selectedOption?.label ?? currentValue}
              </span>
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
            className="z-[90] max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-cyan-200/20 bg-[var(--rr-surface-menu)] p-1 text-cyan-50 shadow-[0_20px_70px_rgba(0,0,0,0.62),0_0_50px_-34px_rgba(103,232,249,0.8)]"
          >
            <RadixSelect.Viewport>
              {options.map((option) => (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  textValue={option.label}
                  disabled={option.disabled === true}
                  className="group flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2 text-sm text-slate-300 outline-none transition data-[highlighted]:bg-cyan-300/[0.08] data-[highlighted]:text-cyan-50 data-[state=checked]:bg-cyan-300/[0.1] data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                >
                  <RadixSelect.ItemIndicator className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center text-emerald-300">
                    ✓
                  </RadixSelect.ItemIndicator>
                  {option.providerAuthMode ? (
                    <ProviderAuthLogoFrame authMode={option.providerAuthMode} />
                  ) : null}
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
            aria-label={label}
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
          className="absolute left-0 right-0 top-full z-40 mt-2 max-h-96 overflow-y-auto rounded-xl border border-cyan-200/20 bg-[var(--rr-surface-menu)] p-1 shadow-[0_20px_70px_rgba(0,0,0,0.62),0_0_50px_-34px_rgba(103,232,249,0.8)]"
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
