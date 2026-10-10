import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import * as c from "@agent-teams/account-gateway/contracts";
import {
  createManagementClient,
  createConsumerControlClient,
  type ConsumerControlConfig,
  GatewayError,
  type ManagementClient,
} from "@agent-teams/account-gateway/http";
import {
  bindWorkspaceAccount,
  changeOperatorWorkspaceAccountGrant,
  revokeWorkspaceAccountBinding,
  reconcileWorkspaceBindingFences,
  resolveWorkspaceAccountBinding,
  ProviderAccountError,
  PrismaProviderAccountRepository,
  type ProviderAccountAccountsQueryPort,
  type PersonalAccountOperationStore,
  type PersonalOperationResult,
  type ProviderAccountConnection,
  type ProviderAccountDependencies,
  type WorkspaceAccountActor,
  type WorkspaceBindingFenceRepositoryPort,
  type ScopedBindingFence,
} from "@reviewrouter/features-provider-accounts";
import {
  PrismaProviderAccountSynchronization,
  connectPersonalAccount,
  readPersonalAccountOperation,
  attachPersonalAccount,
  snapshotPersonalIntent,
  personalOperationId,
  type PersonalAccountIntent,
  type ProviderAccountSynchronizationPort,
} from "@reviewrouter/features-provider-accounts/synchronization";
import { PrismaWorkspaceAccessRepository } from "@reviewrouter/features-auth";
import { z } from "zod";

// This module is imported at runtime only by RSC/server actions. Client imports are type-only.
export type AccountsResult<T> =
  | { status: "ok"; value: T }
  | {
      status: "denied" | "conflict" | "invalid" | "unavailable";
    };
export type AccountProfileView = {
  id: string;
  label: string;
  protocol: c.Profile["protocol"];
  models: string[];
  // Additive display fields; older safe bootstrap consumers may omit them.
  // The authorized adapter always supplies both from its configured catalog.
  authKind?: c.Profile["authKinds"][number];
  canReconnect?: boolean;
};
export type AccountView = {
  canManage?: boolean;
  connectionId: string;
  label: string;
  profileId: string;
  profileLabel: string;
  authKind?: NonNullable<AccountProfileView["authKind"]>;
  state: c.Account["state"];
  gatewayRevision: number;
  mirrorRevision: number;
  binding: {
    id: string;
    revision: number;
    state: "active" | "revoked";
    fencePending: boolean;
  } | null;
};
export type AccountsPage = {
  canGrantOperatorUse?: boolean;
  accounts: AccountView[];
  profiles: AccountProfileView[];
  nextCursor: string | null;
};
export type AccountOperationView = {
  nonce: string;
  state: c.Operation["state"];
  account?: AccountView;
  // Management disable is logical denial. This SDK supplies no erasure/transport cleanup proof.
  cleanup: "unresolved";
};
export type AccountOAuthIntent = Pick<c.OAuthBegin, "profileId"> & {
  nonce: string;
  label: string;
};
// A fresh Begin response is a one-off handoff, never list/operation/cache metadata.
export type AccountOAuthBeginView = {
  operation: AccountOperationView;
  authorizationURL?: string;
};
export type AccountIntent = {
  kind: "connect" | "rename" | "reconnect" | "disable";
  nonce: string;
  connectionId?: string;
  profileId?: string;
  label?: string;
  gatewayRevision?: number;
  mirrorRevision?: number;
};
export type AccountsBootstrap = {
  context: string;
  page: AccountsResult<AccountsPage>;
};

type Authority = { workspaceId: string; actor: WorkspaceAccountActor };
const uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const label = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((v) =>
    Array.from(v).every(
      (character) =>
        character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
    ),
  );
const mirrorRevision = z.number().int().min(1).max(2147483646);
const existing = {
  connectionId: c.reference,
  gatewayRevision: c.revision,
  mirrorRevision,
};
const codexOAuthProfileId = "openai-codex-oauth-responses-v1";
const oauthIntentSchema = z.strictObject({
  nonce: uuid,
  profileId: c.reference,
  label,
});
const intentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("connect"),
    nonce: uuid,
    profileId: c.reference,
    label,
  }),
  z.strictObject({
    kind: z.literal("rename"),
    nonce: uuid,
    ...existing,
    label,
  }),
  z.strictObject({ kind: z.literal("reconnect"), nonce: uuid, ...existing }),
  z.strictObject({ kind: z.literal("disable"), nonce: uuid, ...existing }),
]);
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
function ownerRef(workspaceId: string) {
  return `rrw_${hash(`rr-workspace-owner-v1\0${workspaceId}`)}`;
}
function operationRef(owner: string, nonce: string) {
  // ALL intents share this namespace: reusing a nonce with changed intent conflicts at the gateway.
  return `rrc3_${hash(owner).slice(0, 48)}_${uuid.parse(nonce)}`;
}
class Denied extends Error {}
function safeFailure(error: unknown): AccountsResult<never> {
  if (error instanceof Denied) return { status: "denied" };
  if (error instanceof z.ZodError) return { status: "invalid" };
  if (error instanceof ProviderAccountError)
    return {
      status:
        error.code === "revision_conflict"
          ? "conflict"
          : error.code === "invalid_input"
            ? "invalid"
            : "denied",
    };
  if (error instanceof GatewayError && error.diagnostic?.code === "conflict")
    return { status: "conflict" };
  // Neither SDK diagnostics nor exception messages cross our server boundary.
  return { status: "unavailable" };
}

/** Consumer-owned server adapter; authorize must resolve stable session + workspace and live admin.
 * No credential/intent ledger. Actual HTTP effects are performed only by the pinned SDK.
 */
export function createAccountsAdapter(input: {
  authorize(context: string): Promise<Authority>;
  gateway: ManagementClient;
  accounts: ProviderAccountAccountsQueryPort;
  synchronization: ProviderAccountSynchronizationPort;
  bindingDependencies: ProviderAccountDependencies;
  fences?: WorkspaceBindingFenceRepositoryPort;
  apiKeyProfiles: ReadonlyMap<string, "MiMo" | "OpenRouter">;
  codexOAuthProfileId?: typeof codexOAuthProfileId;
}) {
  const { gateway, accounts, synchronization, bindingDependencies } = input;
  const approved = new Map<
    string,
    Required<Pick<AccountProfileView, "label" | "authKind" | "canReconnect">>
  >(
    [...input.apiKeyProfiles].map(([id, name]) => [
      id,
      {
        label: name,
        authKind: "api_key",
        canReconnect: true,
      },
    ]),
  );
  if (input.codexOAuthProfileId !== undefined) {
    z.literal(codexOAuthProfileId).parse(input.codexOAuthProfileId);
    if (approved.has(codexOAuthProfileId))
      throw new Error("accounts_unavailable");
    approved.set(codexOAuthProfileId, {
      label: "Codex",
      authKind: "oauth",
      canReconnect: false,
    });
  }
  async function deliverBindingFence(scope: {
    workspaceId: string;
    connectionId: string;
  }) {
    const binding = await accounts.findConnectionBinding(scope);
    if (!binding) return "remote_pending" as const;
    if (!binding.pendingFence)
      return binding.state === "revoked" &&
        binding.fenceAck?.policyRevision === binding.policyRevision
        ? ("remote_applied" as const)
        : ("remote_pending" as const);
    if (!input.fences) return "remote_pending" as const;
    const receipt = (operation: c.Operation, intent: ScopedBindingFence) => {
      const ack = c.acknowledgementOperation.parse(operation);
      return ack.state === "applied" && ack.operationRef === intent.operationId
        ? {
            state: "applied" as const,
            operationId: intent.operationId,
            policySubject: intent.policySubject,
            policyRevision: intent.policyRevision,
          }
        : { state: "unknown" as const };
    };
    const result = await reconcileWorkspaceBindingFences(
      { limit: 1 },
      {
        accounts: {
          listPendingBindingFences: async () => [binding],
          acknowledgeBindingFence: (intent) =>
            input.fences!.acknowledgeBindingFence(intent),
        },
        delivery: {
          submitFence: async (intent) =>
            receipt(
              await gateway.fence({
                operationId: intent.operationId,
                subjectRef: intent.policySubject,
                revision: intent.policyRevision,
              }),
              intent,
            ),
          readFenceOperation: async (intent) =>
            receipt(await gateway.operation(intent.operationId), intent),
        },
      },
    );
    return result.results[0]?.remoteFenceDelivery ?? "remote_pending";
  }
  async function authorize(context: string) {
    try {
      const authority = await input.authorize(
        z.string().min(1).max(2048).parse(context),
      );
      return {
        workspaceId: authority.workspaceId,
        actor: { ...authority.actor },
        owner: ownerRef(authority.workspaceId),
      };
    } catch {
      throw new Denied();
    }
  }
  async function isOperatorAdmin(
    authority: Awaited<ReturnType<typeof authorize>>,
  ) {
    if (authority.workspaceId !== bindingDependencies.operatorWorkspaceId)
      return false;
    const role = authority.actor.userId
      ? await bindingDependencies.workspaceAccess.findWorkspaceRoleByUserId({
          workspaceId: authority.workspaceId,
          userId: authority.actor.userId,
        })
      : await bindingDependencies.workspaceAccess.findWorkspaceRoleByGitHubUserId(
          {
            workspaceId: authority.workspaceId,
            githubUserId: authority.actor.githubUserId,
          },
        );
    return role === "owner" || role === "admin";
  }
  function scoped(
    context: string,
    authority: Awaited<ReturnType<typeof authorize>>,
    onEnter?: () => Promise<void>,
  ) {
    async function checked<T>(
      call: () => Promise<T>,
      mutation = false,
    ): Promise<T> {
      const live = await authorize(context);
      if (
        live.workspaceId !== authority.workspaceId ||
        live.actor.userId !== authority.actor.userId
      )
        throw new Denied();
      if (mutation) await onEnter?.();
      return call();
    }
    return {
      profiles: () => checked(() => gateway.profiles()),
      list: (query: c.ListQuery) => checked(() => gateway.list(query)),
      get: (ref: string) => checked(() => gateway.get(ref)),
      connect: (request: Parameters<ManagementClient["connect"]>[0]) =>
        checked(() => gateway.connect(request), true),
      beginOAuth: (request: c.OAuthBegin) =>
        checked(() => gateway.beginOAuth(request), true),
      reauthorize: () => checked(async () => undefined),
      rename: (ref: string, request: c.Rename) =>
        checked(() => gateway.rename(ref, request), true),
      reconnect: (
        ref: string,
        request: Parameters<ManagementClient["reconnect"]>[1],
      ) => checked(() => gateway.reconnect(ref, request), true),
      disable: (ref: string, request: c.Disable) =>
        checked(() => gateway.disable(ref, request), true),
      denyForDisable: (
        request: Parameters<
          ProviderAccountAccountsQueryPort["denyOwnedConnectionForDisable"]
        >[0],
      ) => checked(() => accounts.denyOwnedConnectionForDisable(request)),
      operation: (ref: string) => checked(() => gateway.operation(ref)),
    };
  }
  type ScopedClient = ReturnType<typeof scoped>;
  async function profiles(client: ScopedClient): Promise<AccountProfileView[]> {
    const catalogue = await client.profiles();
    return catalogue.profiles
      .filter((p) => {
        const configured = approved.get(p.profileId);
        return (
          configured &&
          p.authKinds.includes(configured.authKind) &&
          (configured.authKind !== "oauth" || p.protocol === "openai-responses")
        );
      })
      .map((p) => ({
        id: p.profileId,
        ...approved.get(p.profileId)!,
        protocol: p.protocol,
        models: [...p.modelIds],
      }));
  }
  function verified(
    account: c.Account,
    authority: Awaited<ReturnType<typeof authorize>>,
    catalogue: AccountProfileView[],
  ) {
    if (
      account.ownerRef !== authority.owner ||
      !catalogue.some((p) => p.id === account.profileId)
    )
      throw new Denied();
    // The C1 mirror has a stricter friendly-label bound than the wire catalogue.
    label.parse(account.displayName);
    return account;
  }
  async function synchronize(
    authority: Awaited<ReturnType<typeof authorize>>,
    account: c.Account,
    prior: ProviderAccountConnection | null,
    op: string | null,
  ) {
    const metadata = {
      gatewayOperationRef: op ?? prior?.gatewayOperationRef ?? null,
      profileRef: account.profileId,
      displayName: account.displayName,
      state:
        account.state === "active"
          ? ("active" as const)
          : account.state === "staging"
            ? ("pending" as const)
            : account.state === "disabled" || account.state === "tombstoned"
              ? ("disabled" as const)
              : ("quarantined" as const),
    };
    if (!prior)
      return synchronization.recordWorkspaceConnection({
        id: `agc_${hash(`${authority.owner}\0${account.accountRef}`).slice(0, 60)}`,
        workspaceId: authority.workspaceId,
        gatewayAccountRef: account.accountRef,
        ...metadata,
      });
    if (
      prior.gatewayAccountRef !== account.accountRef ||
      prior.owner.kind !== "workspace" ||
      prior.owner.workspaceId !== authority.workspaceId
    )
      throw new Denied();
    if (
      prior.displayName === metadata.displayName &&
      prior.profileRef === metadata.profileRef &&
      prior.state === metadata.state &&
      prior.gatewayOperationRef === metadata.gatewayOperationRef
    )
      return prior;
    // Capture prior BEFORE gateway GET. A delayed response cannot overwrite a newer mirror CAS.
    return synchronization.synchronizeMetadata({
      workspaceId: authority.workspaceId,
      connectionId: prior.id,
      expectedRevision: prior.metadataRevision,
      ...metadata,
    });
  }
  async function view(
    authority: Awaited<ReturnType<typeof authorize>>,
    account: c.Account,
    mirror: ProviderAccountConnection,
    catalogue: AccountProfileView[],
  ): Promise<AccountView> {
    const binding = await accounts.findConnectionBinding({
      workspaceId: authority.workspaceId,
      connectionId: mirror.id,
    });
    return {
      canManage:
        mirror.owner.kind === "workspace" &&
        mirror.owner.workspaceId === authority.workspaceId,
      connectionId: mirror.id,
      label: account.displayName,
      profileId: account.profileId,
      profileLabel: catalogue.find((p) => p.id === account.profileId)!.label,
      authKind: catalogue.find((p) => p.id === account.profileId)!.authKind!,
      state: account.state,
      gatewayRevision: account.metadataRevision,
      mirrorRevision: mirror.metadataRevision,
      binding: binding
        ? {
            id: binding.id,
            revision: binding.revision,
            state: binding.state,
            fencePending: binding.pendingFence !== null,
          }
        : null,
    };
  }
  async function assertCurrentMirror(
    authority: Awaited<ReturnType<typeof authorize>>,
    prior: ProviderAccountConnection,
  ) {
    const live = await accounts.findOwnedConnection({
      workspaceId: authority.workspaceId,
      connectionId: prior.id,
    });
    if (!live || live.gatewayAccountRef !== prior.gatewayAccountRef)
      throw new Denied();
    if (live.metadataRevision !== prior.metadataRevision)
      throw new ProviderAccountError("revision_conflict");
  }
  async function current(
    authority: Awaited<ReturnType<typeof authorize>>,
    connectionId: string,
    catalogue: AccountProfileView[],
    client: ScopedClient,
  ) {
    const prior = await accounts.findOwnedConnection({
      workspaceId: authority.workspaceId,
      connectionId,
    });
    if (!prior) throw new Denied();
    const account = verified(
      await client.get(prior.gatewayAccountRef),
      authority,
      catalogue,
    );
    if (
      account.accountRef !== prior.gatewayAccountRef ||
      account.profileId !== prior.profileRef
    )
      throw new Denied();
    return { prior, account };
  }
  async function projectOperation(
    authority: Awaited<ReturnType<typeof authorize>>,
    nonce: string,
    operation: c.Operation,
    catalogue: AccountProfileView[],
    client: ScopedClient,
    expected?: { accountRef?: string; profileId: string },
  ) {
    if (operation.operationRef !== operationRef(authority.owner, nonce))
      throw new Denied();
    const result: AccountOperationView = {
      nonce,
      state: operation.state,
      cleanup: "unresolved",
    };
    if (operation.state !== "applied") return result;
    if (operation.result?.kind !== "account") throw new Denied();
    const returned = operation.result;
    if (expected?.accountRef && expected.accountRef !== returned.accountRef)
      throw new Denied();
    const prior = await accounts.findOwnedConnectionByGatewayRef({
      workspaceId: authority.workspaceId,
      gatewayAccountRef: returned.accountRef,
    });
    const account = verified(
      await client.get(returned.accountRef),
      authority,
      catalogue,
    );
    if (
      account.accountRef !== returned.accountRef ||
      account.metadataRevision < returned.metadataRevision ||
      account.authorizationEpoch < returned.authorizationEpoch ||
      (expected && expected.profileId !== account.profileId) ||
      (prior && prior.profileRef !== account.profileId)
    )
      throw new Denied();
    result.account = await view(
      authority,
      account,
      await synchronize(authority, account, prior, operation.operationRef),
      catalogue,
    );
    return result;
  }
  async function list(
    context: string,
    cursor: string | null = null,
  ): Promise<AccountsResult<AccountsPage>> {
    try {
      const savedCursor =
        cursor === null ? undefined : c.reference.parse(cursor);
      const authority = await authorize(context);
      const client = scoped(context, authority);
      const catalogue = await profiles(client);
      const grantCursor = savedCursor?.startsWith("rrgrant_")
        ? savedCursor.slice(8)
        : undefined;
      const page = grantCursor
        ? { accounts: [], nextCursor: null }
        : await client.list({
            ownerRef: authority.owner,
            limit: 25,
            ...(savedCursor ? { cursor: savedCursor } : {}),
          });
      if (page.accounts.length > 25) throw new Denied();
      // Refuse the whole page on an unexpected owner; never project foreign metadata.
      for (const account of page.accounts)
        verified(account, authority, catalogue);
      const rows: AccountView[] = [];
      for (const listed of page.accounts) {
        const prior = await accounts.findOwnedConnectionByGatewayRef({
          workspaceId: authority.workspaceId,
          gatewayAccountRef: listed.accountRef,
        });
        // Re-read after mirror capture; listing is discovery, never synchronization authority.
        const account = verified(
          await client.get(listed.accountRef),
          authority,
          catalogue,
        );
        if (
          account.accountRef !== listed.accountRef ||
          account.profileId !== listed.profileId ||
          account.metadataRevision < listed.metadataRevision ||
          (prior && prior.profileRef !== account.profileId)
        )
          throw new Denied();
        rows.push(
          await view(
            authority,
            account,
            await synchronize(authority, account, prior, null),
            catalogue,
          ),
        );
      }
      let nextCursor = page.nextCursor ?? null;
      const operatorWorkspaceId = bindingDependencies.operatorWorkspaceId;
      if (
        !nextCursor &&
        operatorWorkspaceId &&
        accounts.listOperatorGrantedBindings
      ) {
        const grants = await accounts.listOperatorGrantedBindings({
          workspaceId: authority.workspaceId,
          limit: 25,
          ...(grantCursor ? { afterBindingId: grantCursor } : {}),
        });
        if (grants.length > 25) throw new Denied();
        for (const grant of grants) {
          // Only explicit live bindings discover foreign metadata. Never list the
          // operator owner's accounts or expose its private owner/native identity.
          if (
            grant.connection.owner.kind !== "workspace" ||
            grant.connection.owner.workspaceId !== operatorWorkspaceId
          )
            throw new Denied();
          if (grant.connection.state !== "active") continue;
          try {
            await resolveWorkspaceAccountBinding(
              {
                workspaceId: authority.workspaceId,
                bindingId: grant.binding.id,
                actor: authority.actor,
              },
              bindingDependencies,
            );
          } catch (error) {
            if (
              error instanceof ProviderAccountError &&
              ["binding_unavailable", "connection_unavailable"].includes(
                error.code,
              )
            )
              continue;
            throw error;
          }
          const operatorAuthority = {
            ...authority,
            workspaceId: operatorWorkspaceId,
            owner: ownerRef(operatorWorkspaceId),
          };
          const account = verified(
            await client.get(grant.connection.gatewayAccountRef),
            operatorAuthority,
            catalogue,
          );
          if (
            account.accountRef !== grant.connection.gatewayAccountRef ||
            account.profileId !== grant.connection.profileRef
          )
            throw new Denied();
          const mirror = await synchronize(
            operatorAuthority,
            account,
            grant.connection,
            null,
          );
          // GET can discover owner disable while refreshing the safe mirror.
          if (mirror.state !== "active") continue;
          const projected = await view(authority, account, mirror, catalogue);
          if (
            projected.binding?.state === "active" &&
            !projected.binding.fencePending
          )
            rows.push(projected);
        }
        if (grants.length === 25)
          nextCursor = `rrgrant_${grants[24]!.binding.id}`;
      }
      return {
        status: "ok",
        value: {
          canGrantOperatorUse: await isOperatorAdmin(authority),
          accounts: rows,
          profiles: catalogue,
          nextCursor,
        },
      };
    } catch (error) {
      return safeFailure(error);
    }
  }
  async function mutate(
    context: string,
    raw: AccountIntent,
    credential?: string,
  ): Promise<AccountsResult<AccountOperationView>> {
    let entered = false;
    let savedNonce: string | undefined;
    try {
      const intent = intentSchema.parse(raw); // primitive snapshot before ANY await
      const key =
        intent.kind === "connect" || intent.kind === "reconnect"
          ? z.string().min(1).max(16384).parse(credential)
          : undefined;
      if (key === undefined && credential !== undefined) throw new Denied();
      const authority = await authorize(context);
      const id = operationRef(authority.owner, intent.nonce);
      let effectConnection: ProviderAccountConnection | undefined;
      const client = scoped(context, authority, async () => {
        if (effectConnection)
          await assertCurrentMirror(authority, effectConnection);
        entered = true;
        savedNonce = intent.nonce;
      });
      const catalogue = await profiles(client);
      let operation: c.Operation;
      let expected: { accountRef?: string; profileId: string } | undefined;
      if (intent.kind === "connect") {
        if (
          !catalogue.some(
            (p) => p.id === intent.profileId && p.authKind === "api_key",
          )
        )
          throw new Denied();
        expected = { profileId: intent.profileId };
        operation = await client.connect({
          operationId: id,
          ownerRef: authority.owner,
          profileId: intent.profileId,
          displayName: intent.label,
          credential: { kind: "api_key", value: key! },
        });
      } else {
        const { prior, account } = await current(
          authority,
          intent.connectionId,
          catalogue,
          client,
        );
        if (
          prior.metadataRevision !== intent.mirrorRevision ||
          account.metadataRevision !== intent.gatewayRevision
        )
          return { status: "conflict" };
        effectConnection = prior;
        await assertCurrentMirror(authority, prior);
        expected = {
          accountRef: account.accountRef,
          profileId: account.profileId,
        };
        if (account.state === "tombstoned") throw new Denied();
        if (
          intent.kind === "reconnect" &&
          !catalogue.find((p) => p.id === account.profileId)?.canReconnect
        )
          throw new Denied();
        if (intent.kind === "disable") {
          await client.denyForDisable({
            workspaceId: authority.workspaceId,
            connectionId: prior.id,
            expectedMetadataRevision: prior.metadataRevision,
          });
        }
        const revision = {
          operationId: id,
          expectedMetadataRevision: account.metadataRevision,
        };
        operation =
          intent.kind === "rename"
            ? await client.rename(account.accountRef, {
                ...revision,
                displayName: intent.label,
              })
            : intent.kind === "reconnect"
              ? await client.reconnect(account.accountRef, {
                  ...revision,
                  credential: { kind: "api_key", value: key! },
                })
              : await client.disable(account.accountRef, revision);
      }
      const projected = await projectOperation(
        authority,
        intent.nonce,
        operation,
        catalogue,
        client,
        expected,
      );
      return { status: "ok", value: projected };
    } catch (error) {
      // Once POST may have entered, lost ACK/invalid response/mirror failure is readback only.
      if (
        entered &&
        savedNonce &&
        !(
          error instanceof GatewayError &&
          error.code === "safe_error" &&
          error.effect === "not_dispatched"
        )
      ) {
        return {
          status: "ok",
          value: { nonce: savedNonce, state: "unknown", cleanup: "unresolved" },
        };
      }
      return safeFailure(error);
    }
  }
  async function beginOAuth(
    context: string,
    raw: AccountOAuthIntent,
  ): Promise<AccountsResult<AccountOAuthBeginView>> {
    let entered = false;
    let nonce: string | undefined;
    try {
      const intent = oauthIntentSchema.parse(raw); // snapshot before any await
      nonce = intent.nonce;
      const authority = await authorize(context);
      const client = scoped(context, authority, async () => {
        entered = true;
      });
      const catalogue = await profiles(client);
      if (
        !catalogue.some(
          (p) => p.id === intent.profileId && p.authKind === "oauth",
        )
      )
        throw new Denied();
      const fresh = await client.beginOAuth({
        operationId: operationRef(authority.owner, intent.nonce),
        ownerRef: authority.owner,
        profileId: intent.profileId,
        displayName: intent.label,
      });
      const operation = await projectOperation(
        authority,
        intent.nonce,
        fresh.operation,
        catalogue,
        client,
        { profileId: intent.profileId },
      );
      // Pending projection performs no reads. Explicitly recheck the ORIGINAL live
      // workspace/admin after Begin and all awaited projection before releasing its capability.
      await client.reauthorize();
      return {
        status: "ok",
        value: {
          operation,
          ...(fresh.authorizationURL === undefined
            ? {}
            : { authorizationURL: fresh.authorizationURL }),
        },
      };
    } catch (error) {
      // Permission loss/transport loss after entry cannot claim no effect or lose readback.
      if (entered && nonce)
        return {
          status: "ok",
          value: {
            operation: { nonce, state: "unknown", cleanup: "unresolved" },
          },
        };
      return safeFailure(error);
    }
  }
  async function operation(
    context: string,
    rawNonce: string,
  ): Promise<AccountsResult<AccountOperationView>> {
    let nonce: string | undefined;
    try {
      nonce = uuid.parse(rawNonce);
      const authority = await authorize(context);
      const client = scoped(context, authority);
      const catalogue = await profiles(client);
      return {
        status: "ok",
        value: await projectOperation(
          authority,
          nonce,
          await client.operation(operationRef(authority.owner, nonce)),
          catalogue,
          client,
        ),
      };
    } catch (error) {
      if (
        nonce &&
        error instanceof GatewayError &&
        error.effect === "effect_unknown"
      )
        return {
          status: "ok",
          value: { nonce, state: "unknown", cleanup: "unresolved" },
        };
      return safeFailure(error);
    }
  }
  async function bind(
    context: string,
    raw: {
      connectionId: string;
      mirrorRevision: number;
      gatewayRevision: number;
      bindingRevision: number;
    },
  ): Promise<AccountsResult<{ label: string }>> {
    try {
      const intent = z
        .strictObject({
          ...existing,
          bindingRevision: z.number().int().min(0).max(2147483646),
        })
        .parse(raw);
      const authority = await authorize(context);
      const client = scoped(context, authority);
      const catalogue = await profiles(client);
      const owned = await accounts.findOwnedConnection({
        workspaceId: authority.workspaceId,
        connectionId: intent.connectionId,
      });
      if (!owned && bindingDependencies.operatorWorkspaceId) {
        const binding = await accounts.findConnectionBinding({
          workspaceId: authority.workspaceId,
          connectionId: intent.connectionId,
        });
        if (!binding || binding.revision !== intent.bindingRevision)
          throw new Denied();
        const selected = await resolveWorkspaceAccountBinding(
          {
            workspaceId: authority.workspaceId,
            bindingId: binding.id,
            actor: authority.actor,
          },
          bindingDependencies,
        );
        if (selected.bindingRevision !== intent.bindingRevision)
          return { status: "conflict" };
        const selection = await accounts.findBinding({
          workspaceId: authority.workspaceId,
          bindingId: binding.id,
        });
        if (!selection) throw new Denied();
        const operatorAuthority = {
          ...authority,
          workspaceId: bindingDependencies.operatorWorkspaceId,
          owner: ownerRef(bindingDependencies.operatorWorkspaceId),
        };
        const account = verified(
          await client.get(selection.connection.gatewayAccountRef),
          operatorAuthority,
          catalogue,
        );
        if (
          account.accountRef !== selection.connection.gatewayAccountRef ||
          account.state !== "active" ||
          account.profileId !== selection.connection.profileRef
        )
          throw new Denied();
        if (
          account.metadataRevision !== intent.gatewayRevision ||
          selection.connection.metadataRevision !== intent.mirrorRevision
        )
          return { status: "conflict" };
        const live = await resolveWorkspaceAccountBinding(
          {
            workspaceId: authority.workspaceId,
            bindingId: binding.id,
            actor: authority.actor,
          },
          bindingDependencies,
        );
        if (
          live.bindingRevision !== selected.bindingRevision ||
          live.policyRevision !== selected.policyRevision
        )
          return { status: "conflict" };
        return { status: "ok", value: { label: account.displayName } };
      }
      const { prior, account } = await current(
        authority,
        intent.connectionId,
        catalogue,
        client,
      );
      if (
        prior.metadataRevision !== intent.mirrorRevision ||
        account.metadataRevision !== intent.gatewayRevision
      )
        return { status: "conflict" };
      if (account.state !== "active") throw new Denied();
      const mirror = await synchronize(authority, account, prior, null);
      const scope = {
        workspaceId: authority.workspaceId,
        connectionId: mirror.id,
      };
      let binding = await accounts.findConnectionBinding(scope);
      if ((binding?.revision ?? 0) !== intent.bindingRevision)
        return { status: "conflict" };
      if (binding?.pendingFence) throw new Denied();
      if (binding?.state !== "active")
        binding = await bindWorkspaceAccount(
          {
            ...scope,
            actor: authority.actor,
            expectedRevision: intent.bindingRevision,
          },
          bindingDependencies,
        );
      await resolveWorkspaceAccountBinding(
        {
          workspaceId: authority.workspaceId,
          bindingId: binding.id,
          actor: authority.actor,
        },
        bindingDependencies,
      );
      return { status: "ok", value: { label: account.displayName } };
    } catch (error) {
      return safeFailure(error);
    }
  }
  async function changeGrant(
    context: string,
    raw: {
      workspaceId: string;
      connectionId: string;
      expectedRevision: number;
      state: "active" | "revoked";
    },
  ): Promise<
    AccountsResult<{
      bindingId: string;
      revision: number;
      remoteFenceDelivery: "remote_pending" | "remote_applied" | "not_required";
    }>
  > {
    try {
      const intent = z
        .strictObject({
          workspaceId: c.reference,
          connectionId: c.reference,
          expectedRevision: z.number().int().min(0).max(2147483646),
          state: z.enum(["active", "revoked"]),
        })
        .parse(raw);
      const authority = await authorize(context);
      if (!(await isOperatorAdmin(authority))) throw new Denied();
      if (intent.state === "active") {
        // New authority requires a live owned account read. Revocation commits
        // local denial without waiting on Gateway availability or its catalogue.
        const client = scoped(context, authority);
        const { prior, account } = await current(
          authority,
          intent.connectionId,
          await profiles(client),
          client,
        );
        if (account.state !== "active") throw new Denied();
        await synchronize(authority, account, prior, null);
      }
      const binding = await changeOperatorWorkspaceAccountGrant(
        { ...intent, actor: authority.actor },
        bindingDependencies,
      );
      return {
        status: "ok",
        value: {
          bindingId: binding.id,
          revision: binding.revision,
          remoteFenceDelivery: binding.pendingFence
            ? await deliverBindingFence(intent)
            : "not_required",
        },
      };
    } catch (error) {
      return safeFailure(error);
    }
  }
  async function detach(
    context: string,
    raw: { connectionId: string; expectedRevision: number },
  ): Promise<
    AccountsResult<{ remoteFenceDelivery: "remote_pending" | "remote_applied" }>
  > {
    try {
      const intent = z
        .strictObject({
          connectionId: c.reference,
          expectedRevision: mirrorRevision,
        })
        .parse(raw);
      const authority = await authorize(context);
      await revokeWorkspaceAccountBinding(
        {
          ...intent,
          workspaceId: authority.workspaceId,
          actor: authority.actor,
        },
        bindingDependencies,
      );
      return {
        status: "ok",
        value: {
          remoteFenceDelivery: await deliverBindingFence({
            ...intent,
            workspaceId: authority.workspaceId,
          }),
        },
      };
    } catch (error) {
      return safeFailure(error);
    }
  }
  async function reconcileFence(
    context: string,
    raw: { workspaceId: string; connectionId: string },
  ): Promise<
    AccountsResult<{ remoteFenceDelivery: "remote_pending" | "remote_applied" }>
  > {
    try {
      const scope = z
        .strictObject({ workspaceId: c.reference, connectionId: c.reference })
        .parse(raw);
      const authority = await authorize(context);
      if (scope.workspaceId !== authority.workspaceId) {
        if (!(await isOperatorAdmin(authority))) throw new Denied();
        if (
          !(await accounts.findOwnedConnection({
            ...scope,
            workspaceId: authority.workspaceId,
          }))
        )
          throw new Denied();
      }
      const binding = await accounts.findConnectionBinding(scope);
      if (!binding) throw new Denied();
      if (!binding.pendingFence && !binding.fenceAck) throw new Denied();
      return {
        status: "ok",
        value: {
          remoteFenceDelivery: binding.pendingFence
            ? await deliverBindingFence(scope)
            : "remote_applied",
        },
      };
    } catch (error) {
      return safeFailure(error);
    }
  }
  return {
    list,
    mutate,
    beginOAuth,
    operation,
    bind,
    changeGrant,
    detach,
    reconcileFence,
  };
}

/** Disabled internal composition/test seam. No public action/API calls this factory. */
export function createDisabledPersonalAccountsAdapter(input: {
  authorizeUser(): Promise<string>;
  store: PersonalAccountOperationStore;
  control: ConsumerControlConfig;
  profiles: ReadonlyMap<string, "api-key-create" | "oauth-begin">;
}) {
  const client = createConsumerControlClient(input.control);
  const profiles = new Map(input.profiles);
  for (const [profileId, ingress] of profiles) {
    c.reference.parse(profileId);
    z.enum(["api-key-create", "oauth-begin"]).parse(ingress);
  }
  const userOwner = (userId: string) =>
    `rru_${hash(`rr-user-owner-v1\0${userId}`)}`;
  const gateway = {
    async get(actorUserId: string, accountRef: string, profileId: string) {
      const account = await client.get(accountRef);
      if (
        account.accountRef !== accountRef ||
        account.ownerRef !== userOwner(actorUserId) ||
        account.profileId !== profileId ||
        !profiles.has(profileId)
      )
        throw new ProviderAccountError("connection_unavailable");
      return account;
    },
    async operation(operationId: string) {
      const operation = await client.operation(operationId);
      return {
        operationId: operation.operationRef,
        state: operation.state,
        ...(operation.state === "applied" &&
        operation.result?.kind === "account"
          ? {
              result: {
                accountRef: operation.result.accountRef,
                metadataRevision: operation.result.metadataRevision,
                authorizationEpoch: operation.result.authorizationEpoch,
              },
            }
          : {}),
      };
    },
  };
  const dependencies = { store: input.store, gateway };
  const view = (result: PersonalOperationResult) => ({
    operationId: result.id,
    phase: result.phase,
    sourceId: result.source?.id ?? null,
    bindingId: result.binding?.id ?? null,
    available: result.available,
    state:
      result.intent.action === "connect"
        ? (result.source?.state ?? "pending")
        : (result.binding?.state ?? "revoked"),
  });
  const selection = z.strictObject({
    nonce: uuid,
    sourceId: c.reference,
    targetWorkspaceId: c.reference,
    expectedSourceMetadataRevision: mirrorRevision,
    expectedGatewayRevision: c.revision.refine((v) => v > 0),
  });
  return {
    async connect(
      raw: { nonce: string; profileId: string; label: string },
      credential?: string,
    ) {
      const safe = oauthIntentSchema.parse(raw);
      const key = credential;
      const actorUserId = await input.authorizeUser();
      const ingress = profiles.get(safe.profileId);
      if (!ingress) throw new ProviderAccountError("invalid_input");
      // Capture the one-off key before awaits; never retain it in SQL or safe intent.
      if (
        ingress === "api-key-create" &&
        (typeof key !== "string" || key.length < 1 || key.length > 16384)
      )
        throw new ProviderAccountError("invalid_input");
      if (ingress === "oauth-begin" && key !== undefined)
        throw new ProviderAccountError("invalid_input");
      const personalWorkspaceId =
        await input.store.resolvePersonalWorkspace(actorUserId);
      const intent = snapshotPersonalIntent({
        action: "connect",
        actorUserId,
        personalWorkspaceId,
        clientOperationId: safe.nonce,
        proposedSourceId: `rrps_${hash(JSON.stringify([actorUserId, safe.nonce]))}`,
        profileId: safe.profileId,
        displayName: safe.label,
        ingress,
      }) as PersonalAccountIntent & { action: "connect" };
      let authorizationURL: string | undefined;
      const result = await connectPersonalAccount(
        intent,
        dependencies,
        async () => {
          // Only the committed CAS winner reaches this closure once.
          const original = {
            operationId: personalOperationId(actorUserId, safe.nonce),
            ownerRef: userOwner(actorUserId),
            profileId: intent.profileId,
            displayName: intent.displayName,
          };
          if (intent.ingress === "api-key-create")
            await client.connect({
              ...original,
              credential: { kind: "api_key", value: key! },
            });
          else
            authorizationURL = (await client.beginOAuth(original))
              .authorizationURL;
        },
      );
      if ((await input.authorizeUser()) !== actorUserId)
        throw new ProviderAccountError("connection_unavailable");
      return {
        operation: view(result),
        ...(authorizationURL !== undefined ? { authorizationURL } : {}),
      };
    },
    async operation(nonce: string) {
      const clientOperationId = uuid.parse(nonce);
      return view(
        await readPersonalAccountOperation(
          await input.authorizeUser(),
          clientOperationId,
          dependencies,
        ),
      );
    },
    async attach(
      raw: z.input<typeof selection> & {
        predecessorBindingId: string | null;
        expectedPredecessorRevision: number | null;
      },
    ) {
      const safe = selection
        .extend({
          predecessorBindingId: c.reference.nullable(),
          expectedPredecessorRevision: mirrorRevision.nullable(),
        })
        .parse(raw);
      const actorUserId = await input.authorizeUser();
      const personalWorkspaceId =
        await input.store.resolvePersonalWorkspace(actorUserId);
      return view(
        await attachPersonalAccount(
          {
            ...safe,
            action: "attach",
            actorUserId,
            personalWorkspaceId,
            clientOperationId: safe.nonce,
          },
          dependencies,
        ),
      );
    },
  };
}

// One server-configured origin/management role. Never read a caller URL/token/native ID.
function configuration() {
  const origin =
    process.env.REVIEW_ROUTER_ACCOUNT_GATEWAY_MANAGEMENT_ORIGIN ?? "";
  const token =
    process.env.REVIEW_ROUTER_ACCOUNT_GATEWAY_MANAGEMENT_TOKEN ?? "";
  const contextKey =
    process.env.REVIEW_ROUTER_ACCOUNT_GATEWAY_ACCOUNTS_CONTEXT_SECRET ?? "";
  if (contextKey.length < 32) throw new Error("accounts_unavailable");
  const apiKeyProfiles = new Map<string, "MiMo" | "OpenRouter">();
  for (const [value, name] of [
    [process.env.REVIEW_ROUTER_ACCOUNT_GATEWAY_MIMO_PROFILE_ID, "MiMo"],
    [
      process.env.REVIEW_ROUTER_ACCOUNT_GATEWAY_OPENROUTER_PROFILE_ID,
      "OpenRouter",
    ],
  ] as const)
    if (value) {
      c.reference.parse(value);
      if (apiKeyProfiles.has(value)) throw new Error("accounts_unavailable");
      apiKeyProfiles.set(value, name);
    }
  const configuredOAuth =
    process.env.REVIEW_ROUTER_ACCOUNT_GATEWAY_CODEX_OAUTH_PROFILE_ID;
  const oauthProfile =
    configuredOAuth === undefined || configuredOAuth === ""
      ? undefined
      : z.literal(codexOAuthProfileId).parse(configuredOAuth);
  if (!apiKeyProfiles.size && !oauthProfile)
    throw new Error("accounts_unavailable");
  return {
    contextKey,
    ...(process.env.ACCOUNT_GATEWAY_OPERATOR_WORKSPACE_ID !== undefined
      ? {
          operatorWorkspaceId: c.reference.parse(
            process.env.ACCOUNT_GATEWAY_OPERATOR_WORKSPACE_ID,
          ),
        }
      : {}),
    apiKeyProfiles,
    ...(oauthProfile ? { codexOAuthProfileId: oauthProfile } : {}),
    gateway: createManagementClient({
      role: "management",
      origin,
      token,
      timeoutMs: 10000,
      responseBytes: 65536,
    }),
  };
}
function contextSignature(body: string, key: string) {
  return createHmac("sha256", key)
    .update(`rr-c3-accounts-context-v1\0${body}`)
    .digest("base64url");
}
async function production() {
  const settings = configuration();
  const { getPrisma } = await import("./prisma");
  const { assertDashboardWorkspaceAdminAllowed, getDashboardSignedInActor } =
    await import("./dashboard-mutations");
  const prisma = getPrisma();
  const accounts = new PrismaProviderAccountRepository(
    prisma,
    settings.operatorWorkspaceId,
  );
  const access = new PrismaWorkspaceAccessRepository(prisma);
  const adapter = createAccountsAdapter({
    ...settings,
    accounts,
    fences: accounts,
    synchronization: new PrismaProviderAccountSynchronization(prisma),
    bindingDependencies: {
      accounts,
      operatorGrants: accounts,
      ...(settings.operatorWorkspaceId
        ? { operatorWorkspaceId: settings.operatorWorkspaceId }
        : {}),
      workspaceAccess: access,
      localAdminGithubLogins: (
        process.env.REVIEW_ROUTER_LOCAL_ADMIN_GITHUB_LOGINS ?? ""
      )
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    },
    async authorize(context) {
      const [body, signature, extra] = context.split(".");
      if (!body || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(body))
        throw new Denied();
      const expected = Buffer.from(contextSignature(body, settings.contextKey));
      const actual = Buffer.from(signature);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new Denied();
      const saved = z
        .strictObject({ workspaceId: c.reference, userId: c.reference })
        .parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
      const currentActor = await getDashboardSignedInActor();
      if (!currentActor || currentActor.userId !== saved.userId)
        throw new Denied();
      const workspace = await prisma.workspace.findUnique({
        where: { id: saved.workspaceId },
        select: { id: true, personalOwnerUserId: true },
      });
      if (!workspace || workspace.personalOwnerUserId !== null)
        throw new Denied();
      const actor = await assertDashboardWorkspaceAdminAllowed(workspace.id);
      if (actor.userId !== saved.userId) throw new Denied();
      return {
        workspaceId: workspace.id,
        actor: {
          userId: actor.userId,
          githubUserId: actor.githubUserId ?? "",
          githubLogin: actor.githubLogin ?? "",
        },
      };
    },
  });
  return { adapter, settings, assertDashboardWorkspaceAdminAllowed, prisma };
}
export async function loadAccountsBootstrap(
  workspaceId: string,
): Promise<AccountsBootstrap> {
  try {
    const { adapter, settings, assertDashboardWorkspaceAdminAllowed, prisma } =
      await production();
    // RSC's selected Workspace.id is authoritative, never a slug/login-derived owner.
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, personalOwnerUserId: true },
    });
    if (!workspace || workspace.personalOwnerUserId !== null)
      throw new Denied();
    const actor = await assertDashboardWorkspaceAdminAllowed(
      workspace.id,
    ).catch(() => {
      throw new Denied();
    });
    const body = Buffer.from(
      JSON.stringify({ workspaceId: workspace.id, userId: actor.userId }),
    ).toString("base64url");
    const context = `${body}.${contextSignature(body, settings.contextKey)}`;
    return { context, page: await adapter.list(context) };
  } catch (error) {
    return { context: "", page: safeFailure(error) };
  }
}
export async function accountsServerAdapter() {
  return (await production()).adapter;
}
