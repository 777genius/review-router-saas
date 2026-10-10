"use client";

import { Button } from "@reviewrouter/ui";
import * as Select from "@radix-ui/react-select";
import { useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AccountsPage,
  AccountsResult,
} from "../../src/server/account-gateway-accounts";
import type {
  GatewayBatchRequest,
  GatewayBatchResult,
  GatewayBatchSelection,
  GatewayBatchTarget,
  GatewayBatchTargetResult,
} from "../../src/server/gateway-repository-batch-configuration";

// Kept here as a client-safe constant; the server independently bounds input.
const targetLimit = 100;
export type GatewayBatchInventoryItem = GatewayBatchTarget & {
  readonly fullName: string;
  readonly eligible: boolean;
};
export type GatewayBatchActions = {
  save(request: GatewayBatchRequest): Promise<GatewayBatchResult>;
  read(request: GatewayBatchRequest): Promise<GatewayBatchResult>;
};
const BatchSelectionContext = createContext<{
  selected: readonly GatewayBatchTarget[];
  inventory: readonly GatewayBatchInventoryItem[];
  locked: boolean;
  toggle(item: GatewayBatchInventoryItem): void;
} | null>(null);

export function GatewayRepositoryBatchTargetToggle({
  repositoryId,
}: {
  readonly repositoryId: string;
}) {
  const batch = useContext(BatchSelectionContext);
  const item = batch?.inventory.find(
    (candidate) => candidate.repositoryId === repositoryId,
  );
  if (!batch || !item) return null;
  const checked = batch.selected.some(
    (target) => target.repositoryId === repositoryId,
  );
  return (
    <label className="flex items-center gap-2 px-4 pt-3 text-xs text-slate-300">
      <input
        type="checkbox"
        checked={checked}
        aria-label={`Select ${item.fullName} for gateway configuration`}
        disabled={
          batch.locked ||
          (!checked && (!item.eligible || batch.selected.length >= targetLimit))
        }
        onChange={() => batch.toggle(item)}
      />
      Select {item.fullName} for gateway configuration
      {!item.eligible ? (
        <span className="text-amber-200">Currently unavailable</span>
      ) : null}
    </label>
  );
}

function Choice({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  disabled: boolean;
  onChange(value: string): void;
}) {
  return (
    <div className="grid gap-2">
      <span className="text-xs text-slate-400">{label}</span>
      <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
        <Select.Trigger
          aria-label={label}
          className="flex min-h-11 items-center justify-between rounded-xl border border-cyan-200/15 px-3 text-sm text-cyan-50 disabled:opacity-50"
        >
          <Select.Value placeholder={`Choose ${label.toLowerCase()}`} />
          <Select.Icon>⌄</Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            position="popper"
            sideOffset={6}
            className="z-50 max-h-72 overflow-auto rounded-xl border border-cyan-200/15 bg-slate-950 p-2 text-slate-200"
          >
            <Select.Viewport>
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  className="cursor-pointer rounded-lg p-3 text-sm outline-none data-[highlighted]:bg-cyan-300/10"
                >
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator> ✓</Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}

export function GatewayRepositoryBatchControls({
  workspaceId,
  inventory,
  accounts,
  enabled,
  actions,
  refresh,
  children,
}: {
  readonly workspaceId: string;
  readonly inventory: readonly GatewayBatchInventoryItem[];
  readonly accounts: AccountsResult<AccountsPage> | undefined;
  readonly enabled: boolean;
  readonly actions: GatewayBatchActions;
  readonly refresh: () => void;
  readonly children: ReactNode;
}) {
  // Selection snapshots keep the first-paint expected versions even across RSC
  // refreshes. Inventory/account eligibility never silently drops a selected ID.
  const [selected, setSelected] = useState<readonly GatewayBatchTarget[]>([]);
  const [bindingId, setBindingId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] =
    useState<GatewayBatchSelection["reasoningEffort"]>("high");
  const [agenticContext, setAgenticContext] = useState(true);
  const [fastMode, setFastMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [batch, setBatch] = useState<GatewayBatchRequest | null>(null);
  const [results, setResults] = useState<readonly GatewayBatchTargetResult[]>(
    [],
  );
  const inFlight = useRef(false);
  const page = accounts?.status === "ok" ? accounts.value : null;
  const eligibleAccounts =
    page?.accounts.filter(
      (account) =>
        account.state === "active" &&
        account.binding?.state === "active" &&
        !account.binding.fencePending &&
        page.profiles.some(
          (profile) =>
            profile.id === account.profileId &&
            profile.protocol === "openai-responses" &&
            profile.models.length > 0,
        ),
    ) ?? [];
  const account = eligibleAccounts.find(
    (item) => item.binding?.id === bindingId && item.profileId === profileId,
  );
  const models =
    page?.profiles.find((profile) => profile.id === account?.profileId)
      ?.models ?? [];
  const selectionValid = Boolean(account && models.includes(model));
  const unknown = results.some((result) => result.status === "unknown");
  const unavailableCount = selected.filter(
    (target) =>
      !inventory.some(
        (item) => item.repositoryId === target.repositoryId && item.eligible,
      ),
  ).length;
  const locked = busy || batch !== null;
  const allApplied =
    results.length > 0 &&
    results.every((result) => result.status === "applied");
  function accept(request: GatewayBatchRequest, response: GatewayBatchResult) {
    // A missing/wrong scoped response stays unknown; it never becomes green.
    setResults(
      request.targets.map((target) => {
        const matches =
          response.operationId === request.operationId
            ? response.results.filter(
                (result) => result.repositoryId === target.repositoryId,
              )
            : [];
        return matches.length === 1
          ? matches[0]!
          : { repositoryId: target.repositoryId, status: "unknown" };
      }),
    );
  }
  async function apply() {
    if (
      inFlight.current ||
      locked ||
      !enabled ||
      !selected.length ||
      unavailableCount ||
      !selectionValid ||
      !account
    )
      return;
    inFlight.current = true;
    const selection: GatewayBatchSelection = {
      kind: "codex",
      authMode: "codex_account_gateway",
      gatewayBindingId: bindingId,
      gatewayProfileRef: profileId,
      model,
      reasoningEffort,
      agenticContext,
      fastMode,
      requiredHealthy: true,
    };
    const request: GatewayBatchRequest = {
      workspaceId,
      operationId: crypto.randomUUID(),
      targets: selected.map((target) => ({ ...target })),
      selection,
    };
    setBatch(request);
    setBusy(true);
    setResults(
      request.targets.map((target) => ({
        repositoryId: target.repositoryId,
        status: "unknown",
      })),
    );
    try {
      accept(request, await actions.save(request));
    } catch {
      // Response loss can only read the same durable scoped operation. It cannot
      // regenerate a nonce or submit the save again, including on receipt absence.
      try {
        accept(request, await actions.read(request));
      } catch {
        /* Remain unknown. */
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
      refresh();
    }
  }
  async function readUnknown() {
    if (inFlight.current || !batch) return;
    inFlight.current = true;
    setBusy(true);
    const targets = batch.targets.filter((target) =>
      results.some(
        (result) =>
          result.repositoryId === target.repositoryId &&
          result.status === "unknown",
      ),
    );
    try {
      const response = await actions.read({ ...batch, targets });
      if (response.operationId === batch.operationId)
        setResults((prior) =>
          prior.map((result) => {
            if (result.status !== "unknown") return result;
            const matches = response.results.filter(
              (item) => item.repositoryId === result.repositoryId,
            );
            return matches.length === 1 ? matches[0]! : result;
          }),
        );
    } catch {
      /* Read failure does not authorize another save. */
    } finally {
      inFlight.current = false;
      setBusy(false);
      refresh();
    }
  }
  return (
    <BatchSelectionContext.Provider
      value={{
        selected,
        inventory,
        locked: locked || !enabled,
        toggle(item) {
          if (locked || !enabled) return;
          setSelected((prior) =>
            prior.some((target) => target.repositoryId === item.repositoryId)
              ? prior.filter(
                  (target) => target.repositoryId !== item.repositoryId,
                )
              : item.eligible && prior.length < targetLimit
                ? [
                    ...prior,
                    {
                      repositoryId: item.repositoryId,
                      expectedVersion: item.expectedVersion,
                    },
                  ]
                : prior,
          );
        },
      }}
    >
      <section
        aria-label="Gateway batch configuration"
        className="grid gap-4 border-b border-cyan-200/10 p-5"
      >
        <h3 className="text-sm font-semibold text-cyan-50">
          Configure gateways across repositories
        </h3>
        <p className="text-sm text-slate-400">
          Select up to {targetLimit} synced repositories, including search
          results. This replaces every selected repository’s provider list with
          one required healthy Codex gateway provider and sets provider count,
          parallelism and agreement to 1. Each repository keeps its blocking
          policy, comment/token limits, language and investigation settings.
          Existing admitted runs keep their pinned configuration.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Choice
            label="Gateway account"
            value={account ? bindingId : ""}
            disabled={locked || !enabled}
            options={eligibleAccounts.map((item) => ({
              value: item.binding!.id,
              label: `${item.label} · ${item.profileLabel}`,
            }))}
            onChange={(value) => {
              const chosen = eligibleAccounts.find(
                (item) => item.binding?.id === value,
              );
              if (!chosen) return;
              setBindingId(value);
              setProfileId(chosen.profileId);
              setModel("");
            }}
          />
          <Choice
            label="Gateway model"
            value={models.includes(model) ? model : ""}
            disabled={locked || !enabled || !account}
            options={models.map((value) => ({ value, label: value }))}
            onChange={setModel}
          />
          <Choice
            label="Reasoning effort"
            value={reasoningEffort}
            disabled={locked || !enabled}
            options={(
              ["low", "medium", "high", "xhigh", "max", "ultra"] as const
            ).map((value) => ({ value, label: value }))}
            onChange={(value) => {
              if (
                ["low", "medium", "high", "xhigh", "max", "ultra"].includes(
                  value,
                )
              )
                setReasoningEffort(
                  value as GatewayBatchSelection["reasoningEffort"],
                );
            }}
          />
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-slate-300">
          <label>
            <input
              type="checkbox"
              checked={agenticContext}
              disabled={locked || !enabled}
              onChange={(event) => setAgenticContext(event.target.checked)}
            />{" "}
            Agentic context
          </label>
          <label>
            <input
              type="checkbox"
              checked={fastMode}
              disabled={locked || !enabled}
              onChange={(event) => setFastMode(event.target.checked)}
            />{" "}
            Fast mode
          </label>
          <span>Required healthy: on</span>
        </div>
        {!page ? (
          <p className="text-sm text-amber-200">
            Gateway accounts are unavailable or access was denied.
          </p>
        ) : null}
        {page?.nextCursor ? (
          <p className="text-sm text-slate-400">
            Showing the first account page. Manage other accounts in Accounts.
          </p>
        ) : null}
        {bindingId && !selectionValid ? (
          <p role="status" className="text-sm text-amber-200">
            The chosen account or model is no longer eligible. Your repository
            selection is preserved.
          </p>
        ) : null}
        {unavailableCount ? (
          <p className="text-sm text-amber-200">
            {unavailableCount} selected repositories are currently unavailable.
            Selection is preserved; unselect them or refresh permissions.
          </p>
        ) : null}
        {selected
          .filter(
            (target) =>
              !inventory.some(
                (item) => item.repositoryId === target.repositoryId,
              ),
          )
          .map((target) => (
            <div
              key={target.repositoryId}
              className="flex flex-wrap items-center gap-3 text-sm text-amber-200"
            >
              <span>
                Selected repository {target.repositoryId} is no longer in the
                inventory.
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={locked || !enabled}
                onClick={() =>
                  setSelected((prior) =>
                    prior.filter(
                      (item) => item.repositoryId !== target.repositoryId,
                    ),
                  )
                }
              >
                Remove {target.repositoryId} from selection
              </Button>
            </div>
          ))}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-300">
            {selected.length} repositories selected
          </span>
          <Button
            type="button"
            size="sm"
            disabled={
              locked ||
              !enabled ||
              !selected.length ||
              !selectionValid ||
              unavailableCount > 0
            }
            onClick={() => {
              void apply();
            }}
          >
            Apply gateway configuration
          </Button>
          {!batch ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy || !selected.length}
              onClick={() => setSelected([])}
            >
              Clear selection
            </Button>
          ) : null}
          {unknown ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                void readUnknown();
              }}
            >
              Check saved operation
            </Button>
          ) : null}
          {batch && !busy && !unknown ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setBatch(null);
                setResults([]);
              }}
            >
              Finish viewing results
            </Button>
          ) : null}
        </div>
        {batch ? (
          <div
            aria-live="polite"
            role="status"
            className={allApplied ? "text-lime-200" : "text-amber-200"}
          >
            <p>
              {busy
                ? "Checking configuration results…"
                : allApplied
                  ? "Applied to every selected repository."
                  : "Batch has unapplied or unresolved targets. Review each result."}
            </p>
            <p className="break-all text-xs">Operation: {batch.operationId}</p>
            <ul className="mt-2 grid gap-1 text-sm">
              {results.map((result) => (
                <li key={result.repositoryId}>
                  {inventory.find(
                    (item) => item.repositoryId === result.repositoryId,
                  )?.fullName ?? result.repositoryId}
                  : {result.status}
                  {result.status === "applied"
                    ? ` (version ${result.version})`
                    : ""}
                </li>
              ))}
            </ul>
            {unknown ? (
              <p className="mt-2 text-sm">
                Unknown targets stay locked. Check this exact operation; absence
                of a receipt does not prove the save failed.
              </p>
            ) : null}
            {results.some((result) => result.status === "conflict") ? (
              <p className="mt-2 text-sm">
                Conflicts need fresh versions: finish viewing results, unselect
                and reselect those repositories before applying a new batch.
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
      {children}
    </BatchSelectionContext.Provider>
  );
}

/** RSC supplies server-action references; a refresh never resets the selection. */
export function GatewayRepositoryBatchRefreshBoundary(
  props: Omit<Parameters<typeof GatewayRepositoryBatchControls>[0], "refresh">,
) {
  const router = useRouter();
  return (
    <GatewayRepositoryBatchControls
      {...props}
      refresh={() => router.refresh()}
    />
  );
}
