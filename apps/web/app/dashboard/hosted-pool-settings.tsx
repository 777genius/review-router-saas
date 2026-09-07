import { Badge, SelectField } from "@reviewrouter/ui";
import type {
  HostedPoolDashboardView,
  HostedPoolRepositoryView,
} from "../../src/server/hosted-pool-dashboard";
import { FormSubmitButton } from "../form-submit-button";
import {
  DashboardActionForm,
  type DashboardActionFormAction,
} from "./dashboard-action-form";

type HostedPoolSettingsActions = Readonly<{
  importAccount: DashboardActionFormAction;
  setAccountState: DashboardActionFormAction;
  setRepositorySource: DashboardActionFormAction;
}>;

export function HostedPoolSettingsPanel({
  workspaceId,
  view,
  actions,
  mutationsEnabled,
}: {
  readonly workspaceId: string;
  readonly view: HostedPoolDashboardView;
  readonly actions: HostedPoolSettingsActions;
  readonly mutationsEnabled: boolean;
}): React.ReactElement | null {
  if (view.gate === "feature_disabled") return null;
  if (view.gate === "entitlement_denied") {
    return (
      <section className="border-t border-cyan-200/10 pt-5">
        <Badge tone="neutral">Hosted Codex pool</Badge>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          Hosted session custody is not enabled for this workspace plan.
          Repository-owned GitHub secrets remain unchanged.
        </p>
      </section>
    );
  }

  const healthy = view.pool?.healthyAccountCount ?? 0;
  const total = view.pool?.accountCount ?? view.accounts.length;
  return (
    <section className="border-t border-cyan-200/10 pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={healthy > 0 ? "success" : "warning"}>
              Hosted Codex pool
            </Badge>
            <Badge tone="neutral">
              {healthy} healthy / {total} total
            </Badge>
          </div>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
            Add workspace-owned Codex sessions for explicitly opted-in GitHub
            repositories. ReviewRouter stores the session and transiently relays
            model prompts, tool results, and responses.
          </p>
        </div>
      </div>

      <DashboardActionForm
        action={actions.importAccount}
        fallbackParams={{
          error: "hosted_pool_action_failed",
          workspace: workspaceId,
          section: "setup",
        }}
        className="mt-5 grid gap-3 border-t border-cyan-200/10 pt-5 sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-end"
      >
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <label className="grid gap-2 text-sm text-slate-300">
          <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
            Account label
          </span>
          <input
            name="label"
            required
            maxLength={80}
            autoComplete="off"
            placeholder="Primary"
            className="min-h-11 rounded-xl border border-cyan-200/15 bg-slate-950/80 px-3 text-cyan-50 outline-none focus:border-cyan-200/40"
          />
          <input
            name="authJson"
            type="file"
            required
            accept="application/json,.json"
            className="text-xs text-slate-400 file:mr-3 file:rounded-lg file:border file:border-cyan-200/20 file:bg-cyan-300/10 file:px-3 file:py-2 file:text-cyan-50"
          />
        </label>
        <label className="grid gap-2 text-sm text-slate-300">
          <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
            Priority
          </span>
          <input
            name="priority"
            type="number"
            min={0}
            defaultValue={100}
            required
            className="min-h-11 rounded-xl border border-cyan-200/15 bg-slate-950/80 px-3 text-cyan-50 outline-none focus:border-cyan-200/40"
          />
        </label>
        <FormSubmitButton
          variant="outline"
          size="sm"
          disabled={!mutationsEnabled}
          idleLabel="Add account"
          pendingLabel="Importing..."
        />
      </DashboardActionForm>

      <div className="mt-5 divide-y divide-cyan-200/10 border-y border-cyan-200/10">
        {view.accounts.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">
            No hosted accounts yet. No repository can activate hosted mode until
            a healthy account is available.
          </p>
        ) : (
          view.accounts.map((account) => {
            const state = account.availability.status;
            const paused = state === "paused";
            return (
              <div
                key={String(account.id)}
                className="flex flex-wrap items-center justify-between gap-3 py-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-cyan-50">
                    {account.label}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    Priority {account.priority} · {safeAccountStateLabel(state)}
                  </p>
                </div>
                {(state === "healthy" || state === "paused") && (
                  <DashboardActionForm
                    action={actions.setAccountState}
                    fallbackParams={{
                      error: "hosted_pool_action_failed",
                      workspace: workspaceId,
                      section: "setup",
                    }}
                  >
                    <input
                      type="hidden"
                      name="workspaceId"
                      value={workspaceId}
                    />
                    <input
                      type="hidden"
                      name="accountId"
                      value={String(account.id)}
                    />
                    <input
                      type="hidden"
                      name="expectedVersion"
                      value={account.healthVersion}
                    />
                    <input
                      type="hidden"
                      name="state"
                      value={paused ? "healthy" : "paused"}
                    />
                    <FormSubmitButton
                      variant="ghost"
                      size="sm"
                      disabled={!mutationsEnabled}
                      idleLabel={paused ? "Resume" : "Pause"}
                      pendingLabel="Saving..."
                    />
                  </DashboardActionForm>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
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

function safeAccountStateLabel(status: string): string {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "paused":
      return "Paused";
    case "cooldown":
      return "Cooling down";
    case "quarantined":
      return "Needs reconnect";
    default:
      return "Unavailable";
  }
}
