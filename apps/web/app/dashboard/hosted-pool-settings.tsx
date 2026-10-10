"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, SelectField } from "@reviewrouter/ui";
import type { HostedAccountSafeSummary } from "@reviewrouter/features-hosted-account-pool";
import type {
  HostedPoolDashboardView,
  HostedPoolRepositoryView,
} from "../../src/server/hosted-pool-dashboard";
import { FormSubmitButton } from "../form-submit-button";
import { HostedPoolAccountCards } from "./hosted-pool-account-card";
import {
  DashboardActionForm,
  type DashboardActionFormAction,
} from "./dashboard-action-form";
import {
  HostedPoolDeviceLogin,
  type HostedPoolDeviceLoginFlight,
  type HostedPoolDeviceLoginPollResult,
  type HostedPoolDeviceLoginStartResult,
} from "./hosted-pool-device-login";

type HostedPoolSettingsActions = Readonly<{
  importAccount: DashboardActionFormAction;
  startDeviceLogin: (
    formData: FormData,
  ) => Promise<HostedPoolDeviceLoginStartResult>;
  pollDeviceLogin: (
    formData: FormData,
  ) => Promise<HostedPoolDeviceLoginPollResult>;
  setAccountState: DashboardActionFormAction;
  removeAccount: DashboardActionFormAction;
  setRepositorySource: DashboardActionFormAction;
}>;

const fieldClassName =
  "min-h-11 rounded-xl border border-cyan-200/15 bg-slate-950/80 px-3 text-cyan-50 outline-none focus:border-cyan-200/40";

export function HostedPoolSettingsPanel({
  workspaceId,
  view,
  actions,
  mutationsEnabled,
  previewDeviceLoginFlight,
}: {
  readonly workspaceId: string;
  readonly view: HostedPoolDashboardView;
  readonly actions: HostedPoolSettingsActions;
  readonly mutationsEnabled: boolean;
  readonly previewDeviceLoginFlight?: HostedPoolDeviceLoginFlight | undefined;
}): React.ReactElement | null {
  const [accounts, setAccounts] = useState(view.accounts);
  const [reconnectAccount, setReconnectAccount] =
    useState<HostedAccountSafeSummary | null>(null);
  useEffect(() => setAccounts(view.accounts), [view.accounts]);
  const addImportedAccount = useCallback(
    (account: HostedAccountSafeSummary) => {
      setReconnectAccount(null);
      setAccounts((current) =>
        [...current.filter((item) => item.id !== account.id), account].sort(
          (left, right) =>
            left.priority - right.priority ||
            left.createdAt.getTime() - right.createdAt.getTime() ||
            String(left.id).localeCompare(String(right.id)),
        ),
      );
    },
    [],
  );

  if (view.gate === "feature_disabled") {
    return (
      <section className="rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/60 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
        <h3 className="text-sm font-semibold text-cyan-50">
          Hosted ChatGPT pool is not enabled
        </h3>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-400">
          Enrollment into the hosted ChatGPT pool is paused on this deployment.
          Manage gateway accounts in Workspace accounts above.
        </p>
      </section>
    );
  }
  if (view.gate === "entitlement_denied") {
    return (
      <section className="rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/60 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
        <h3 className="text-sm font-semibold text-cyan-50">
          ChatGPT accounts for reviews
        </h3>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          This workspace is not active. Hosted account management is available
          when the workspace is active.
        </p>
      </section>
    );
  }

  const healthy = accounts.filter(
    (account) => account.availability.status === "healthy",
  ).length;
  const total = Math.max(view.pool?.accountCount ?? 0, accounts.length);
  const enrolled = accounts.length > 0;
  const hasHealthyAccount =
    healthy > 0 ||
    accounts.some((account) => account.availability.status === "healthy");
  return (
    <section className="rounded-[1.5rem] border border-cyan-200/10 bg-slate-950/60 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-cyan-50">
              ChatGPT accounts for reviews
            </h3>
            <Badge tone={hasHealthyAccount ? "success" : "warning"}>
              {poolStatusLabel({
                enrolled,
                hasHealthyAccount,
                healthy,
                total,
              })}
            </Badge>
          </div>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300 break-words">
            {enrolled ? (
              hasHealthyAccount ? (
                <>
                  Add more accounts for capacity. Pause or remove one without
                  affecting the others.
                </>
              ) : (
                <>
                  None of these accounts are ready for reviews right now. Use
                  one again or sign in with ChatGPT again.
                </>
              )
            ) : (
              <>
                Connect ChatGPT so ReviewRouter can run hosted reviews. Upload a
                local{" "}
                <span className="whitespace-nowrap font-mono">auth.json</span>{" "}
                only if ChatGPT sign-in is unavailable.
              </>
            )}
          </p>
        </div>
      </div>

      {enrolled ? (
        <HostedPoolDeviceLogin
          workspaceId={workspaceId}
          mutationsEnabled={mutationsEnabled}
          enrolled
          reconnectAccount={reconnectAccount}
          onClearReconnect={() => setReconnectAccount(null)}
          startAction={actions.startDeviceLogin}
          pollAction={actions.pollDeviceLogin}
          onImported={addImportedAccount}
          previewFlight={previewDeviceLoginFlight}
          header={
            <div>
              <h3 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                {total === 1 ? "1 account" : `${total} accounts`}
              </h3>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                {hasHealthyAccount
                  ? "Reviews use ready accounts first, then the next one in line."
                  : "Use one for reviews again, or sign in with ChatGPT again."}
              </p>
            </div>
          }
        >
          <HostedPoolAccountCards
            workspaceId={workspaceId}
            accounts={accounts}
            setAccountState={actions.setAccountState}
            removeAccount={actions.removeAccount}
            mutationsEnabled={mutationsEnabled}
            onReconnect={setReconnectAccount}
          />
        </HostedPoolDeviceLogin>
      ) : (
        <HostedPoolDeviceLogin
          workspaceId={workspaceId}
          mutationsEnabled={mutationsEnabled}
          startAction={actions.startDeviceLogin}
          pollAction={actions.pollDeviceLogin}
          onImported={addImportedAccount}
          previewFlight={previewDeviceLoginFlight}
        />
      )}

      <HostedPoolAuthJsonFallback
        workspaceId={workspaceId}
        importAccount={actions.importAccount}
        mutationsEnabled={mutationsEnabled}
      />
    </section>
  );
}

function poolStatusLabel(input: {
  readonly enrolled: boolean;
  readonly hasHealthyAccount: boolean;
  readonly healthy: number;
  readonly total: number;
}): string {
  if (!input.enrolled) return "Connect ChatGPT";
  if (input.total <= 0) return "No accounts yet";
  if (input.healthy === 0) {
    return input.total === 1 ? "Not ready" : "None ready";
  }
  if (input.healthy === input.total) {
    return input.total === 1 ? "1 ready" : `${input.total} ready`;
  }
  return `${input.healthy} of ${input.total} ready`;
}

function HostedPoolAuthJsonFallback({
  workspaceId,
  importAccount,
  mutationsEnabled,
}: {
  readonly workspaceId: string;
  readonly importAccount: DashboardActionFormAction;
  readonly mutationsEnabled: boolean;
}): React.ReactElement {
  return (
    <details className="mt-4 rounded-xl border border-cyan-200/8 bg-transparent p-3">
      <summary className="cursor-pointer list-none text-sm text-slate-500">
        <span className="text-xs font-medium tracking-wide text-slate-500">
          Upload auth.json fallback
        </span>
        <p className="mt-1 text-xs leading-5 text-slate-600">
          Optional. Use only if ChatGPT sign-in is unavailable.
        </p>
      </summary>
      <p className="mt-3 text-xs leading-5 text-slate-500">
        Run <span className="font-mono">codex login</span> locally, then upload{" "}
        <span className="font-mono">~/.codex/auth.json</span>. We encrypt the
        file before it is stored. Stored sessions are never returned to the
        browser.
      </p>
      <DashboardActionForm
        action={importAccount}
        fallbackParams={{
          error: "hosted_pool_action_failed",
          workspace: workspaceId,
          section: "setup",
        }}
        className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,1.1fr)_auto] sm:items-end"
      >
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="priority" value="100" />
        <label className="grid min-w-0 gap-2 text-sm text-slate-300">
          <span className="text-xs font-medium text-slate-400">
            Fallback label
          </span>
          <input
            name="label"
            required
            maxLength={80}
            autoComplete="off"
            placeholder="Fallback session"
            className={fieldClassName}
          />
        </label>
        <label className="grid min-w-0 gap-2 text-sm text-slate-300">
          <span className="text-xs font-medium text-slate-400">auth.json</span>
          <input
            name="authJson"
            type="file"
            required
            accept="application/json,.json"
            className="block min-h-11 min-w-0 overflow-hidden rounded-xl border border-cyan-200/15 bg-slate-950/80 px-2 py-1.5 text-xs text-slate-400 file:mr-2 file:inline-flex file:h-8 file:shrink-0 file:items-center file:rounded-lg file:border file:border-cyan-200/20 file:bg-cyan-300/10 file:px-3 file:text-cyan-50"
          />
        </label>
        <FormSubmitButton
          variant="outline"
          size="sm"
          className="min-h-11 whitespace-nowrap"
          disabled={!mutationsEnabled}
          idleLabel="Add account"
          pendingLabel="Importing..."
        />
      </DashboardActionForm>
    </details>
  );
}

export function RepositorySessionSourceSelector({
  workspaceId,
  repository,
  action,
  mutationsEnabled,
  hostedPoolReady,
}: {
  readonly workspaceId: string;
  readonly repository: HostedPoolRepositoryView;
  readonly action: DashboardActionFormAction;
  readonly mutationsEnabled: boolean;
  readonly hostedPoolReady: boolean;
}): React.ReactElement {
  const canChooseHosted =
    repository.source === "hosted_workspace_pool" ||
    (repository.eligible && hostedPoolReady);
  return (
    <div className="border-t border-cyan-200/10 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-cyan-50">
          Codex session source
        </p>
        {repository.activation === "pending" ? (
          <Badge tone="warning">Pending workflow activation</Badge>
        ) : null}
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-400">
        Repository-owned GitHub Secret is the default. Hosted workspace pool is
        opt-in and means ReviewRouter custodizes the session and relays model
        traffic for this repository.
      </p>
      <DashboardActionForm
        action={action}
        fallbackParams={{
          error: "hosted_pool_action_failed",
          workspace: workspaceId,
          section: "repositories",
        }}
        className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end"
      >
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="repositoryId" value={repository.id} />
        <input
          type="hidden"
          name="expectedVersion"
          value={repository.bindingVersion}
        />
        <SelectField
          name="source"
          label="Source"
          defaultValue={repository.source}
          className="flex-1"
          disabled={!mutationsEnabled}
          options={[
            {
              value: "repository_secret",
              label: "Repository-owned GitHub Secret",
              description:
                "Current/default mode. ReviewRouter does not custody the session.",
            },
            ...(canChooseHosted
              ? [
                  {
                    value: "hosted_workspace_pool",
                    label: "Hosted workspace pool",
                    description:
                      "Selected GitHub repositories. Activates after the exact workflow update.",
                  },
                ]
              : []),
          ]}
        />
        <FormSubmitButton
          variant="outline"
          size="sm"
          disabled={!mutationsEnabled}
          idleLabel="Save source"
          pendingLabel="Saving..."
        />
      </DashboardActionForm>
      {!repository.eligible ? (
        <p className="mt-2 text-xs text-amber-200/80">
          This repository is not eligible for the hosted pool.
        </p>
      ) : !hostedPoolReady ? (
        <p className="mt-2 text-xs text-amber-200/80">
          Add a healthy hosted account before opting in this repository.
        </p>
      ) : null}
    </div>
  );
}
