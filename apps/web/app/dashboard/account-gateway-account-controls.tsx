"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Badge, Button, Dialog, SelectField } from "@reviewrouter/ui";
import type {
  AccountIntent,
  AccountOAuthIntent,
  AccountOperationView,
  AccountProfileView,
  AccountView,
  AccountsBootstrap,
  AccountsResult,
} from "../../src/server/account-gateway-accounts";
import {
  bindGatewayAccount,
  beginGatewayOAuth,
  detachGatewayAccount,
  changeGatewayOperatorGrant,
  listGatewayAccounts,
  mutateGatewayAccount,
  readGatewayOperation,
  submitGatewayApiKey,
} from "./account-gateway-account-actions";

// Small safe keys: scoped stable user/workspace locator; no signature or secret.
const pageKey = (scope: string, cursor: string | null) =>
  ["gateway-accounts", scope, "page", cursor] as const;
const operationKey = (scope: string, nonce: string) =>
  ["gateway-accounts", scope, "operation", nonce] as const;
const noncePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function savedNonces(key: string): string[] {
  const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? "[]");
  if (
    !Array.isArray(saved) ||
    saved.length > 8 ||
    !saved.every((n) => typeof n === "string" && noncePattern.test(n))
  )
    throw new Error();
  return [...new Set(saved as string[])];
}
const inputClass =
  "min-h-11 rounded-lg border border-cyan-200/20 bg-slate-950 px-3 text-cyan-50";
function statusText(status: AccountsResult<unknown>["status"]) {
  return status === "denied"
    ? "Accounts are available only to current workspace owners and admins."
    : status === "conflict"
      ? "The account changed. Refresh Accounts before trying a new operation."
      : status === "invalid"
        ? "Check the account fields."
        : "Account management is unavailable. Refresh or check an outstanding operation later.";
}

export function AccountGatewayControls({
  bootstrap,
}: {
  bootstrap: AccountsBootstrap;
}) {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <Controls bootstrap={bootstrap} />
    </QueryClientProvider>
  );
}

function Controls({ bootstrap }: { bootstrap: AccountsBootstrap }) {
  const { context } = bootstrap;
  const scope = context.split(".")[0] ?? "";
  const storageKey = `rr-c3-account-operations:${scope}`;
  const client = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);
  const [nonces, setNonces] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const page = useQuery({
    queryKey: pageKey(scope, cursor),
    queryFn: () => listGatewayAccounts(context, cursor),
    initialData: cursor === null ? bootstrap.page : undefined,
    enabled: Boolean(context),
    staleTime: 15000,
    retry: false,
  });
  useEffect(() => {
    try {
      setNonces(savedNonces(storageKey));
      setReady(true);
    } catch {
      setMessage(
        "Operation readback storage is unavailable. Enable session storage before starting an operation.",
      );
    }
  }, [storageKey]);
  const refresh = useCallback(async () => {
    // Refresh every already displayed page with exact keys; no unrelated dashboard cache.
    await Promise.all(
      client
        .getQueryCache()
        .findAll({ queryKey: ["gateway-accounts", scope, "page"] })
        .map((query) =>
          client.invalidateQueries({ queryKey: query.queryKey, exact: true }),
        ),
    );
  }, [client, scope]);
  function reserveNonce(): string | null {
    if (!ready || nonces.length >= 8) {
      setMessage(
        "Check or dismiss completed operations before starting another.",
      );
      return null;
    }
    const nonce = crypto.randomUUID();
    try {
      const next = [...savedNonces(storageKey), nonce];
      if (next.length > 8) throw new Error();
      // Persist BEFORE request entry: a lost response/reload preserves the operation identity.
      sessionStorage.setItem(storageKey, JSON.stringify(next));
      setNonces(next);
      return nonce;
    } catch {
      setMessage(
        "Could not preserve operation readback. Nothing was submitted.",
      );
      return null;
    }
  }
  function dismiss(nonce: string) {
    try {
      const next = savedNonces(storageKey).filter((n) => n !== nonce);
      sessionStorage.setItem(storageKey, JSON.stringify(next));
      setNonces(next);
    } catch {
      setMessage("Could not update operation readback storage.");
    }
  }
  async function accept(
    nonce: string,
    result: AccountsResult<AccountOperationView>,
  ) {
    client.setQueryData(operationKey(scope, nonce), result);
    if (result.status !== "ok") dismiss(nonce); // Adapter proved no management mutation entered.
    setMessage(
      result.status === "ok"
        ? result.value.state === "applied"
          ? "Gateway acknowledged the operation. Cleanup remains unverified; bindings require an active current account."
          : result.value.state === "rejected"
            ? "The gateway rejected the operation."
            : "The operation is unresolved. Check its status; enrollment or credentials will not be submitted again."
        : statusText(result.status),
    );
    await refresh();
  }
  async function beginOAuth(intent: Omit<AccountOAuthIntent, "nonce">) {
    if (submitting.current) return;
    let tab: Window | null = null;
    let nonce: string | null;
    try {
      tab = window.open("about:blank", "_blank");
      if (!tab) throw new Error();
      tab.opener = null;
      const referrer = tab.document.createElement("meta");
      referrer.name = "referrer";
      referrer.content = "no-referrer";
      tab.document.head.append(referrer);
      nonce = reserveNonce();
    } catch {
      tab?.close();
      setMessage(
        "Could not open a safe authorization tab. Allow popups and try again. Nothing was submitted.",
      );
      return;
    }
    if (!nonce) {
      tab.close();
      return;
    }
    submitting.current = true;
    setBusy(true);
    let navigated = false;
    try {
      // Direct ingress: neither the Begin response nor its temporary URL enters
      // a query/mutation cache, component state, storage or a readback request.
      const fresh = await beginGatewayOAuth(context, { ...intent, nonce });
      const safe: AccountsResult<AccountOperationView> =
        fresh.status === "ok"
          ? { status: "ok", value: fresh.value.operation }
          : fresh;
      // The browser gets one fresh handoff. Readback never contains/rebuilds a URL.
      if (
        fresh.status === "ok" &&
        fresh.value.authorizationURL &&
        !tab.closed
      ) {
        const link = tab.document.createElement("a");
        link.target = "_self";
        link.rel = "noreferrer";
        link.referrerPolicy = "no-referrer";
        link.href = fresh.value.authorizationURL;
        try {
          link.click();
          navigated = true;
        } finally {
          link.removeAttribute("href");
        }
      } else tab.close();
      await accept(nonce, safe);
    } catch {
      if (!navigated) tab.close();
      await accept(nonce, {
        status: "ok",
        value: { nonce, state: "unknown", cleanup: "unresolved" },
      });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const metadataMutation = useMutation({
    mutationKey: ["gateway-accounts", scope, "metadata"] as const,
    mutationFn: (intent: AccountIntent) =>
      mutateGatewayAccount(context, intent),
    retry: false,
    gcTime: 0,
  });
  async function submit(
    intent: Omit<AccountIntent, "nonce">,
    credential?: string,
  ) {
    if (submitting.current) return;
    const nonce = reserveNonce();
    if (!nonce) return;
    submitting.current = true;
    setBusy(true);
    try {
      // Secrets bypass React Query entirely. Its mutation cache receives safe metadata only.
      const request = { ...intent, nonce };
      const result =
        credential === undefined
          ? await metadataMutation.mutateAsync(request)
          : await submitGatewayApiKey(context, request, credential);
      await accept(nonce, result);
    } catch {
      await accept(nonce, {
        status: "ok",
        value: { nonce, state: "unknown", cleanup: "unresolved" },
      });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const bindingMutation = useMutation({
    mutationKey: ["gateway-accounts", scope, "binding"] as const,
    mutationFn: (account: AccountView) =>
      bindGatewayAccount(context, {
        connectionId: account.connectionId,
        mirrorRevision: account.mirrorRevision,
        gatewayRevision: account.gatewayRevision,
        bindingRevision: account.binding?.revision ?? 0,
      }),
    retry: false,
    gcTime: 0,
    onSuccess: async (result) => {
      setMessage(
        result.status === "ok"
          ? `${result.value.label} is available for workspace model selection.`
          : statusText(result.status),
      );
      await refresh();
    },
    onError: () =>
      setMessage("Binding status is unavailable. Refresh Accounts."),
  });
  const data = page.data;
  const detachMutation = useMutation({
    mutationFn: (account: AccountView) =>
      detachGatewayAccount(context, {
        connectionId: account.connectionId,
        expectedRevision: account.binding!.revision,
      }),
    retry: false,
    onSuccess: async (result) => {
      setMessage(
        result.status === "ok"
          ? `Workspace use detached; ${result.value.remoteFenceDelivery === "remote_applied" ? "gateway fence acknowledged" : "gateway fence pending"}.`
          : statusText(result.status),
      );
      await refresh();
    },
  });
  const disabled =
    busy ||
    !ready ||
    bindingMutation.isPending ||
    detachMutation.isPending ||
    page.isFetching ||
    data?.status !== "ok";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        {data?.status === "ok" &&
        data.value.profiles.some((p) => p.authKind === "api_key") ? (
          <AccountForm
            profiles={data.value.profiles.filter(
              (p) => p.authKind === "api_key",
            )}
            disabled={disabled}
            submit={submit}
          />
        ) : null}
        {data?.status === "ok" &&
        data.value.profiles.some((p) => p.authKind === "oauth") ? (
          <OAuthForm
            profiles={data.value.profiles.filter((p) => p.authKind === "oauth")}
            disabled={disabled}
            begin={beginOAuth}
          />
        ) : null}
        <Button
          variant="outline"
          size="sm"
          disabled={!context || page.isFetching}
          onClick={() => void refresh()}
        >
          Refresh accounts
        </Button>
      </div>
      {message ? (
        <p role="status" className="text-sm text-slate-300">
          {message}
        </p>
      ) : null}
      {data?.status !== "ok" ? (
        <p role="status" className="text-sm text-slate-400">
          {statusText(data?.status ?? "unavailable")}
        </p>
      ) : (
        <div className="divide-y divide-cyan-200/10">
          {!data.value.accounts.length ? (
            <p className="py-4 text-sm text-slate-400">
              No workspace accounts on this page.
            </p>
          ) : null}
          {data.value.accounts.map((account) => (
            <div
              key={account.connectionId}
              className="flex flex-wrap items-center justify-between gap-4 py-4"
            >
              <div>
                <p className="font-medium text-cyan-50">{account.label}</p>
                <p className="mt-1 text-sm text-slate-400">
                  {account.profileLabel} ·{" "}
                  {
                    data.value.profiles.find((p) => p.id === account.profileId)
                      ?.protocol
                  }
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge tone="neutral">{account.state}</Badge>
                  {account.binding ? (
                    <Badge tone="neutral">
                      {account.binding.fencePending
                        ? "Binding locally denied; remote fence pending"
                        : account.binding.state === "active"
                          ? "Workspace binding ready"
                          : "Binding revoked"}
                    </Badge>
                  ) : null}
                </div>
                {account.state === "disabled" ||
                account.state === "tombstoned" ? (
                  <p className="mt-1 text-xs text-slate-400">
                    Logical denial only; credential erasure and transport
                    cleanup are unverified.
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <AccountForm
                  account={account}
                  mode="rename"
                  profiles={data.value.profiles}
                  disabled={disabled || account.canManage !== true}
                  submit={submit}
                />
                {account.authKind === "api_key" &&
                data.value.profiles.find((p) => p.id === account.profileId)
                  ?.canReconnect ? (
                  <AccountForm
                    account={account}
                    mode="reconnect"
                    profiles={data.value.profiles}
                    disabled={
                      disabled ||
                      account.canManage !== true ||
                      account.state === "tombstoned"
                    }
                    submit={submit}
                  />
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    disabled ||
                    account.canManage !== true ||
                    account.state === "tombstoned"
                  }
                  onClick={() =>
                    void submit({
                      kind: "disable",
                      connectionId: account.connectionId,
                      gatewayRevision: account.gatewayRevision,
                      mirrorRevision: account.mirrorRevision,
                    })
                  }
                >
                  Disable
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    disabled ||
                    account.state !== "active" ||
                    Boolean(account.binding?.fencePending) ||
                    (account.canManage !== true &&
                      account.binding?.state !== "active")
                  }
                  onClick={() => bindingMutation.mutate(account)}
                >
                  {account.binding?.state === "active"
                    ? "Select workspace binding"
                    : "Create workspace binding"}
                </Button>
                {account.binding?.state === "active" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => detachMutation.mutate(account)}
                  >
                    Detach workspace use
                  </Button>
                ) : null}
                {data.value.canGrantOperatorUse &&
                account.canManage === true ? (
                  <OperatorGrantForm
                    context={context}
                    account={account}
                    disabled={disabled}
                    refresh={refresh}
                  />
                ) : null}
              </div>
            </div>
          ))}
          <div className="flex gap-2 pt-3">
            {cursor ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCursor(null)}
              >
                First page
              </Button>
            ) : null}
            {data.value.nextCursor ? (
              <Button
                variant="outline"
                size="sm"
                disabled={page.isFetching}
                onClick={() => setCursor(data.value.nextCursor)}
              >
                Next page
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {nonces.length ? (
        <div className="space-y-2 border-t border-cyan-200/10 pt-4">
          <h4 className="text-sm font-semibold text-cyan-50">
            Operation readback
          </h4>
          <p className="text-xs text-slate-400">
            Only operation nonces are retained in this tab. Keys are cleared
            after submission. Pending or unknown operations are never
            automatically resubmitted. Acknowledgment does not prove credential
            erasure or transport cleanup. OAuth authorization is offered only
            once after a fresh enrollment; status readback cannot reopen it.
            Allow the authorization tab if your browser blocks popups.
          </p>
          {nonces.map((nonce, index) => (
            <OperationReadback
              key={nonce}
              context={context}
              scope={scope}
              nonce={nonce}
              index={index + 1}
              dismiss={() => dismiss(nonce)}
              refresh={refresh}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function OperatorGrantForm({
  context,
  account,
  disabled,
  refresh,
}: {
  context: string;
  account: AccountView;
  disabled: boolean;
  refresh(): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  async function applyGrant(intent: {
    workspaceId: string;
    expectedRevision: number;
    state: "active" | "revoked";
  }) {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    try {
      const result = await changeGatewayOperatorGrant(context, {
        ...intent,
        connectionId: account.connectionId,
      });
      setMessage(
        result.status === "ok"
          ? `Use ${intent.state === "active" ? "granted" : "revoked"} at binding revision ${result.value.revision}.${result.value.remoteFenceDelivery === "remote_pending" ? " Gateway fence pending." : result.value.remoteFenceDelivery === "remote_applied" ? " Gateway fence acknowledged." : ""}`
          : statusText(result.status),
      );
      await refresh();
    } catch {
      setMessage(
        "Grant status is unavailable. Check the current binding before submitting another change.",
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        render={<Button variant="outline" size="sm" disabled={disabled} />}
      >
        Manage operator grant
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup>
          <Dialog.Title>Workspace use grant</Dialog.Title>
          <Dialog.Description>
            Grant or revoke use of {account.label} for a workspace by its stable
            ID.
          </Dialog.Description>
          <form
            className="mt-4 grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              void applyGrant({
                workspaceId: String(values.get("workspaceId")),
                expectedRevision: Number(values.get("revision")),
                state: values.get("state") === "revoked" ? "revoked" : "active",
              });
            }}
          >
            <label className="grid gap-2 text-sm">
              Workspace ID
              <input
                className={inputClass}
                name="workspaceId"
                required
                maxLength={128}
              />
            </label>
            <label className="grid gap-2 text-sm">
              Expected binding revision (0 for new use)
              <input
                className={inputClass}
                name="revision"
                type="number"
                min={0}
                max={2147483646}
                defaultValue={0}
                required
              />
            </label>
            <SelectField
              name="state"
              label="Use"
              defaultValue="active"
              options={[
                { value: "active", label: "Grant" },
                { value: "revoked", label: "Revoke" },
              ]}
            />
            <Button type="submit" disabled={disabled || pending}>
              Apply
            </Button>
            {message ? (
              <p role="status" className="text-sm text-slate-300">
                {message}
              </p>
            ) : null}
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function OAuthForm({
  profiles,
  disabled,
  begin,
}: {
  profiles: AccountProfileView[];
  disabled: boolean;
  begin(intent: Omit<AccountOAuthIntent, "nonce">): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        render={<Button variant="outline" size="sm" disabled={disabled} />}
      >
        Connect Codex OAuth
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup>
          <Dialog.Title className="text-lg font-semibold">
            Connect Codex OAuth
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-slate-400">
            Authorize Codex in a new browser tab. No API key is needed.
            Enrollment stays pending until confirmed; an unresolved result
            requires status readback. Reconnecting an existing OAuth account is
            unavailable.
          </Dialog.Description>
          <form
            className="mt-4 grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const values = new FormData(form);
              const intent = {
                profileId: String(values.get("profileId") ?? ""),
                label: String(values.get("label") ?? ""),
              };
              form.reset();
              setOpen(false);
              void begin(intent);
            }}
          >
            <SelectField
              name="profileId"
              label="Provider profile"
              defaultValue={profiles[0]?.id ?? ""}
              options={profiles.map((p) => ({
                value: p.id,
                label: `${p.label} · ${p.protocol}`,
                description: p.models.join(", "),
              }))}
            />
            <label className="grid gap-2 text-sm">
              Account label
              <input
                className={inputClass}
                name="label"
                required
                maxLength={120}
              />
            </label>
            <Button type="submit" disabled={disabled}>
              Authorize Codex
            </Button>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function OperationReadback({
  context,
  scope,
  nonce,
  index,
  dismiss,
  refresh,
}: {
  context: string;
  scope: string;
  nonce: string;
  index: number;
  dismiss(): void;
  refresh(): Promise<void>;
}) {
  const [pollUntil] = useState(() => Date.now() + 60000);
  const operation = useQuery({
    queryKey: operationKey(scope, nonce),
    queryFn: () => readGatewayOperation(context, nonce),
    staleTime: 3000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.data?.status === "ok" &&
      query.state.data.value.state === "pending" &&
      Date.now() < pollUntil
        ? 3000
        : false,
  });
  const data = operation.data;
  const state = data?.status === "ok" ? data.value.state : "unresolved";
  useEffect(() => {
    if (state === "applied") void refresh();
  }, [state, refresh]); // refresh exact account pages after promotion
  const terminal = state === "applied" || state === "rejected";
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
      <span>
        Operation {index}: {state}
        {data?.status === "ok" && data.value.account
          ? ` · ${data.value.account.label}`
          : ""}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={operation.isFetching}
        onClick={() => void operation.refetch()}
      >
        Check status
      </Button>
      {terminal ? (
        <Button variant="outline" size="sm" onClick={dismiss}>
          Dismiss
        </Button>
      ) : null}
    </div>
  );
}

function AccountForm({
  account,
  mode = "connect",
  profiles,
  disabled,
  submit,
}: {
  account?: AccountView;
  mode?: "connect" | "rename" | "reconnect";
  profiles: AccountProfileView[];
  disabled: boolean;
  submit(
    intent: Omit<AccountIntent, "nonce">,
    credential?: string,
  ): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const title =
    mode === "rename"
      ? "Rename account"
      : mode === "reconnect"
        ? "Reconnect API key"
        : "Connect API key";
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        render={<Button variant="outline" size="sm" disabled={disabled} />}
      >
        {title}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup>
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-slate-400">
            {mode === "rename"
              ? "Update the friendly account label."
              : "Submit a write-only API key. An unresolved result requires status readback; it does not resubmit the key."}
          </Dialog.Description>
          <form
            className="mt-4 grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const values = new FormData(form);
              const credential =
                mode === "rename"
                  ? undefined
                  : String(values.get("credential") ?? "");
              const intent: Omit<AccountIntent, "nonce"> = account
                ? {
                    kind: mode,
                    connectionId: account.connectionId,
                    gatewayRevision: account.gatewayRevision,
                    mirrorRevision: account.mirrorRevision,
                    ...(mode === "rename"
                      ? { label: String(values.get("label") ?? "") }
                      : {}),
                  }
                : {
                    kind: "connect",
                    profileId: String(values.get("profileId") ?? ""),
                    label: String(values.get("label") ?? ""),
                  };
              form.reset();
              values.delete("credential");
              setOpen(false);
              void submit(intent, credential);
            }}
          >
            {mode === "connect" ? (
              <SelectField
                name="profileId"
                label="Provider profile"
                defaultValue={profiles[0]?.id ?? ""}
                options={profiles.map((p) => ({
                  value: p.id,
                  label: `${p.label} · ${p.protocol}`,
                  description: p.models.join(", "),
                }))}
              />
            ) : null}
            {mode !== "reconnect" ? (
              <label className="grid gap-2 text-sm">
                Account label
                <input
                  className={inputClass}
                  name="label"
                  required
                  maxLength={120}
                  defaultValue={account?.label ?? ""}
                />
              </label>
            ) : null}
            {mode !== "rename" ? (
              <label className="grid gap-2 text-sm">
                API key
                <input
                  className={inputClass}
                  name="credential"
                  type="password"
                  required
                  maxLength={16384}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            ) : null}
            <Button type="submit" disabled={disabled}>
              Submit
            </Button>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
