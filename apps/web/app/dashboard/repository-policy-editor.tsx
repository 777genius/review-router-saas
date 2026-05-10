"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FocusEvent } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { SelectField } from "@reviewrouter/ui";
import type { ReviewConfiguration } from "@reviewrouter/features-review-config";
import { FormSubmitButton } from "../form-submit-button";
import {
  clearRepositoryReviewConfigClientAction,
  saveRepositoryReviewConfigClientAction,
} from "./actions";

type DashboardFormAction = (formData: FormData) => void | Promise<void>;

type RepositoryPolicyEditorRepository = {
  readonly id: string;
  readonly selected: boolean;
  readonly archived: boolean;
};

type RepositoryPolicyEditorConfig = {
  readonly version: number;
  readonly config: ReviewConfiguration;
} | null;

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

const modelOptions = [
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
  { value: "gpt-5.2", label: "GPT-5.2" },
] as const;

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
} as const;

export function RepositoryPolicyEditor({
  workspaceId,
  repository,
  repositoryConfig,
  effectiveConfig,
  mutationsEnabled,
  compact = false,
}: {
  readonly workspaceId: string;
  readonly repository: RepositoryPolicyEditorRepository;
  readonly repositoryConfig: RepositoryPolicyEditorConfig;
  readonly effectiveConfig: ReviewConfiguration;
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
            hiddenFields={[
              { name: "workspaceId", value: workspaceId },
              { name: "repositoryId", value: repository.id },
            ]}
            mutationsEnabled={canEdit}
            submitLabel={
              repositoryConfig ? "Update repo settings" : "Save repo settings"
            }
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
  hiddenFields,
  mutationsEnabled,
  submitLabel,
}: {
  readonly action: DashboardFormAction;
  readonly config: ReviewConfiguration;
  readonly hiddenFields: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly mutationsEnabled: boolean;
  readonly submitLabel: string;
}): React.ReactElement {
  return (
    <Tooltip.Provider delayDuration={180} skipDelayDuration={80}>
      <form
        action={action}
        className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(13rem,1fr))]"
      >
        {hiddenFields.map((field) => (
          <input
            key={`${field.name}:${field.value}`}
            type="hidden"
            name={field.name}
            value={field.value}
          />
        ))}
        <SelectField
          name="providerAuthMode"
          label={
            <DashboardFieldLabel
              label="Provider auth"
              helpText={fieldHelp.providerAuthMode}
            />
          }
          defaultValue={config.provider.authMode}
          disabled={!mutationsEnabled}
          options={providerAuthOptions}
        />
        <DashboardModelField
          name="model"
          label="Model"
          helpText={fieldHelp.model}
          defaultValue={config.provider.model}
          disabled={!mutationsEnabled}
          options={modelOptions}
        />
        <SelectField
          name="reasoningEffort"
          label={
            <DashboardFieldLabel
              label="Reasoning effort"
              helpText={fieldHelp.reasoningEffort}
            />
          }
          defaultValue={config.provider.reasoningEffort}
          disabled={!mutationsEnabled}
          options={reasoningEffortOptions}
        />
        <DashboardSwitchField
          name="fastMode"
          label="Fast mode"
          helpText={fieldHelp.fastMode}
          defaultChecked={config.provider.fastMode}
          disabled={!mutationsEnabled}
        />
        <SelectField
          name="failOnSeverity"
          label={
            <DashboardFieldLabel
              label="Fail on severity"
              helpText={fieldHelp.failOnSeverity}
            />
          }
          defaultValue={config.blockingPolicy.failOnSeverity}
          disabled={!mutationsEnabled}
          options={failOnSeverityOptions}
        />
        <DashboardTextField
          name="inlineMaxComments"
          label="Inline max comments"
          helpText={fieldHelp.inlineMaxComments}
          type="number"
          min={0}
          max={50}
          defaultValue={config.limits.inlineMaxComments}
          disabled={!mutationsEnabled}
        />
        <DashboardTextField
          name="targetTokensPerBatch"
          label="Target tokens per batch"
          helpText={fieldHelp.targetTokensPerBatch}
          type="number"
          min={4000}
          max={200000}
          step={1000}
          defaultValue={config.limits.targetTokensPerBatch}
          disabled={!mutationsEnabled}
        />
        <SelectField
          name="agenticContext"
          label={
            <DashboardFieldLabel
              label="Agentic context"
              helpText={fieldHelp.agenticContext}
            />
          }
          defaultValue={String(config.provider.agenticContext)}
          disabled={!mutationsEnabled}
          options={agenticContextOptions}
        />
        <div className="flex min-w-0 items-end">
          <FormSubmitButton
            variant="solid"
            className="w-full"
            disabled={!mutationsEnabled}
            idleLabel={submitLabel}
            pendingLabel="Saving..."
          />
        </div>
      </form>
    </Tooltip.Provider>
  );
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

function DashboardTextField({
  name,
  label,
  helpText,
  defaultValue,
  disabled,
  type = "text",
  min,
  max,
  step,
}: {
  readonly name: string;
  readonly label: string;
  readonly helpText: string;
  readonly defaultValue: string | number;
  readonly disabled: boolean;
  readonly type?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}): React.ReactElement {
  return (
    <label className="grid min-w-0 gap-2 text-sm text-slate-300">
      <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
        <DashboardFieldLabel label={label} helpText={helpText} />
      </span>
      <input
        name={name}
        type={type}
        min={min}
        max={max}
        step={step}
        defaultValue={defaultValue}
        disabled={disabled}
        className={dashboardInputClassName}
      />
    </label>
  );
}

function DashboardSwitchField({
  name,
  label,
  helpText,
  defaultChecked,
  disabled,
}: {
  readonly name: string;
  readonly label: string;
  readonly helpText: string;
  readonly defaultChecked: boolean;
  readonly disabled: boolean;
}): React.ReactElement {
  const [checked, setChecked] = useState(defaultChecked);

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
            onChange={(event) => setChecked(event.target.checked)}
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
  defaultValue,
  disabled,
  options,
}: {
  readonly name: string;
  readonly label: string;
  readonly helpText: string;
  readonly defaultValue: string;
  readonly disabled: boolean;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
}): React.ReactElement {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const listboxId = useId();

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
          onChange={(event) => setValue(event.target.value)}
          disabled={disabled}
          autoComplete="off"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-haspopup="listbox"
          className={[dashboardInputClassName, "pr-12"].join(" ")}
        />
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
          className="absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-xl border border-cyan-200/20 bg-[#061015] p-1 shadow-[0_20px_70px_rgba(0,0,0,0.62),0_0_50px_-34px_rgba(103,232,249,0.8)]"
        >
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setValue(option.value);
                  setOpen(false);
                }}
                className={[
                  "grid w-full gap-0.5 rounded-lg px-3 py-2 text-left transition hover:bg-cyan-300/[0.08] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-200",
                  selected
                    ? "bg-cyan-300/[0.1] text-cyan-50"
                    : "text-slate-300",
                ].join(" ")}
              >
                <span className="text-sm font-semibold">{option.value}</span>
                <span className="text-xs text-slate-500">{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </label>
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
