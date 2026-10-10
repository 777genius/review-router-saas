"use server";

import {
  accountsServerAdapter,
  type AccountIntent,
  type AccountOAuthIntent,
  type AccountOAuthBeginView,
  type AccountOperationView,
  type AccountsPage,
  type AccountsResult,
} from "../../src/server/account-gateway-accounts";

// Client-facing adapter functions. Secret submissions use direct one-off calls,
// never React Query mutation variables. Configuration/session errors are sanitized here too.
export async function listGatewayAccounts(
  context: string,
  cursor: string | null,
): Promise<AccountsResult<AccountsPage>> {
  try {
    return await (await accountsServerAdapter()).list(context, cursor);
  } catch {
    return { status: "unavailable" };
  }
}
export async function mutateGatewayAccount(
  context: string,
  intent: AccountIntent,
): Promise<AccountsResult<AccountOperationView>> {
  if (intent?.kind === "connect" || intent?.kind === "reconnect")
    return { status: "invalid" };
  try {
    return await (await accountsServerAdapter()).mutate(context, intent);
  } catch {
    return { status: "unavailable" };
  }
}
export async function submitGatewayApiKey(
  context: string,
  intent: AccountIntent,
  credential: string,
): Promise<AccountsResult<AccountOperationView>> {
  if (intent?.kind !== "connect" && intent?.kind !== "reconnect")
    return { status: "invalid" };
  try {
    return await (
      await accountsServerAdapter()
    ).mutate(context, intent, credential);
  } catch {
    return { status: "unavailable" };
  }
}
export async function readGatewayOperation(
  context: string,
  nonce: string,
): Promise<AccountsResult<AccountOperationView>> {
  try {
    return await (await accountsServerAdapter()).operation(context, nonce);
  } catch {
    return { status: "unavailable" };
  }
}
export async function beginGatewayOAuth(
  context: string,
  intent: AccountOAuthIntent,
): Promise<AccountsResult<AccountOAuthBeginView>> {
  try {
    return await (await accountsServerAdapter()).beginOAuth(context, intent);
  } catch {
    return { status: "unavailable" };
  }
}
export async function bindGatewayAccount(
  context: string,
  intent: {
    connectionId: string;
    mirrorRevision: number;
    gatewayRevision: number;
    bindingRevision: number;
  },
): Promise<AccountsResult<{ label: string }>> {
  try {
    return await (await accountsServerAdapter()).bind(context, intent);
  } catch {
    return { status: "unavailable" };
  }
}

export async function changeGatewayOperatorGrant(
  context: string,
  intent: {
    workspaceId: string;
    connectionId: string;
    expectedRevision: number;
    state: "active" | "revoked";
  },
) {
  try {
    return await (await accountsServerAdapter()).changeGrant(context, intent);
  } catch {
    return { status: "unavailable" as const };
  }
}

export async function detachGatewayAccount(
  context: string,
  intent: {
    connectionId: string;
    expectedRevision: number;
  },
) {
  try {
    return await (await accountsServerAdapter()).detach(context, intent);
  } catch {
    return { status: "unavailable" as const };
  }
}

export async function reconcileGatewayAccountFence(
  context: string,
  intent: {
    workspaceId: string;
    connectionId: string;
  },
) {
  try {
    return await (
      await accountsServerAdapter()
    ).reconcileFence(context, intent);
  } catch {
    return { status: "unavailable" as const };
  }
}
