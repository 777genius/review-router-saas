import { createHash } from "node:crypto";
import {
  ProviderAccountError,
  assertExpectedRevision,
  assertMetadata,
  assertOpaqueReference,
} from "../../domain/provider-account";
import type { PersonalAccountOperationStore } from "../ports/provider-account-repository-port";
import type { PersonalAccountGatewayPort } from "../ports/provider-account-synchronization-port";

export type PersonalAccountIntent = {
  readonly actorUserId: string;
  readonly clientOperationId: string;
  readonly personalWorkspaceId: string;
} & (
  | {
      readonly action: "connect";
      readonly proposedSourceId: string;
      readonly profileId: string;
      readonly displayName: string;
      readonly ingress: "api-key-create" | "oauth-begin";
    }
  | {
      readonly action: "attach";
      readonly sourceId: string;
      readonly targetWorkspaceId: string;
      readonly expectedSourceMetadataRevision: number;
      readonly expectedGatewayRevision: number;
      readonly predecessorBindingId: string | null;
      readonly expectedPredecessorRevision: number | null;
    }
  | {
      readonly action: "revoke";
      readonly sourceId: string;
      readonly targetWorkspaceId: string;
      readonly expectedSourceMetadataRevision: number;
      readonly expectedGatewayRevision: number;
      readonly bindingId: string;
      readonly expectedBindingRevision: number;
    }
);

/** Detached positive allowlist. Neither credentials nor their fingerprints enter this tuple. */
export function snapshotPersonalIntent(
  input: PersonalAccountIntent,
): PersonalAccountIntent {
  const base = {
    actorUserId: input.actorUserId,
    clientOperationId: input.clientOperationId,
    personalWorkspaceId: input.personalWorkspaceId,
  };
  Object.values(base).forEach(assertOpaqueReference);
  if (input.action === "connect") {
    assertOpaqueReference(input.proposedSourceId);
    assertOpaqueReference(input.profileId);
    const displayName = input.displayName.trim();
    assertMetadata({
      displayName,
      profileRef: input.profileId,
      gatewayOperationRef: null,
      state: "pending",
    });
    if (
      Buffer.byteLength(displayName, "utf8") > 400 ||
      !["api-key-create", "oauth-begin"].includes(input.ingress)
    )
      throw new ProviderAccountError("invalid_input");
    return Object.freeze({
      ...base,
      action: "connect",
      proposedSourceId: input.proposedSourceId,
      profileId: input.profileId,
      displayName,
      ingress: input.ingress,
    });
  }
  assertOpaqueReference(input.sourceId);
  assertOpaqueReference(input.targetWorkspaceId);
  assertExpectedRevision(input.expectedSourceMetadataRevision);
  assertGatewayCounter(input.expectedGatewayRevision);
  const existing = {
    ...base,
    sourceId: input.sourceId,
    targetWorkspaceId: input.targetWorkspaceId,
    expectedSourceMetadataRevision: input.expectedSourceMetadataRevision,
    expectedGatewayRevision: input.expectedGatewayRevision,
  };
  if (input.action === "attach") {
    if (
      (input.predecessorBindingId === null) !==
      (input.expectedPredecessorRevision === null)
    )
      throw new ProviderAccountError("invalid_input");
    if (input.predecessorBindingId !== null) {
      assertOpaqueReference(input.predecessorBindingId);
      assertExpectedRevision(input.expectedPredecessorRevision!);
    }
    return Object.freeze({
      ...existing,
      action: "attach",
      predecessorBindingId: input.predecessorBindingId,
      expectedPredecessorRevision: input.expectedPredecessorRevision,
    });
  }
  if (input.action !== "revoke")
    throw new ProviderAccountError("invalid_input");
  assertOpaqueReference(input.bindingId);
  assertExpectedRevision(input.expectedBindingRevision);
  return Object.freeze({
    ...existing,
    action: "revoke",
    bindingId: input.bindingId,
    expectedBindingRevision: input.expectedBindingRevision,
  });
}
export function assertGatewayCounter(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new ProviderAccountError("connection_unavailable");
}
export function personalOperationId(
  actorUserId: string,
  clientOperationId: string,
): string {
  return `rrpo_${createHash("sha256")
    .update(
      JSON.stringify([
        "rr-personal-operation-v1",
        actorUserId,
        clientOperationId,
      ]),
    )
    .digest("hex")}`;
}
export function personalIntentDigest(input: PersonalAccountIntent): string {
  return createHash("sha256")
    .update(JSON.stringify(snapshotPersonalIntent(input)))
    .digest("hex");
}

type PersonalDependencies = {
  store: PersonalAccountOperationStore;
  gateway: PersonalAccountGatewayPort;
};
/** Submitted is a committed, one-winner claim. The losing invocation only reads back. */
export async function connectPersonalAccount(
  input: PersonalAccountIntent & { action: "connect" },
  dependencies: PersonalDependencies,
  ingress: () => Promise<void>,
) {
  const intent = snapshotPersonalIntent(input) as typeof input;
  const { actorUserId, clientOperationId } = intent;
  const { store } = dependencies;
  await store.reserveConnect(intent);
  if (await store.claimConnect(actorUserId, clientOperationId)) {
    try {
      await ingress();
    } catch {
      await store.noteConnectPhase(actorUserId, clientOperationId, "unknown");
    }
  }
  return readPersonalAccountOperation(
    actorUserId,
    clientOperationId,
    dependencies,
  );
}
export async function readPersonalAccountOperation(
  actorUserId: string,
  clientOperationId: string,
  dependencies: PersonalDependencies,
) {
  const { store, gateway } = dependencies;
  const original = await store.readOperation(actorUserId, clientOperationId);
  if (
    original.intent.action !== "connect" ||
    ["reserved", "applied", "rejected"].includes(original.phase)
  )
    return original;
  // No ingress, even if operation readback returns 404 or not_dispatched.
  try {
    const operation = await gateway.operation(original.id);
    if (operation.operationId !== original.id)
      throw new ProviderAccountError("connection_unavailable");
    if (operation.state === "rejected") {
      await store.noteConnectPhase(actorUserId, clientOperationId, "rejected");
    } else if (operation.state === "applied" && operation.result) {
      const result = operation.result;
      const { profileId, displayName } = original.intent;
      assertGatewayCounter(result.authorizationEpoch);
      assertGatewayCounter(result.metadataRevision);
      const account = await gateway.get(
        actorUserId,
        result.accountRef,
        profileId,
      );
      if (
        account.accountRef !== result.accountRef ||
        account.profileId !== profileId ||
        account.metadataRevision !== result.metadataRevision ||
        account.authorizationEpoch !== result.authorizationEpoch ||
        account.displayName !== displayName ||
        account.state !== "active"
      )
        throw new ProviderAccountError("connection_unavailable");
      return await store.finalizeConnect(
        actorUserId,
        clientOperationId,
        account,
      );
    }
  } catch {
    await store.noteConnectPhase(actorUserId, clientOperationId, "unknown");
  }
  return store.readOperation(actorUserId, clientOperationId);
}
export async function attachPersonalAccount(
  input: PersonalAccountIntent & { action: "attach" },
  dependencies: PersonalDependencies,
) {
  const intent = snapshotPersonalIntent(input) as PersonalAccountIntent & {
    action: "attach";
  };
  const { actorUserId, clientOperationId } = intent;
  const { store, gateway } = dependencies;
  try {
    const original = await store.readOperation(actorUserId, clientOperationId);
    if (personalIntentDigest(original.intent) !== personalIntentDigest(intent))
      throw new ProviderAccountError("operation_conflict");
    return original;
  } catch (error) {
    if (!(error instanceof ProviderAccountError) || error.code !== "not_found")
      throw error;
  }
  const source = await store.findOwnedSource(actorUserId, intent.sourceId);
  const account = await gateway.get(
    actorUserId,
    source.gatewayAccountRef,
    source.profileRef!,
  );
  if (
    account.metadataRevision !== intent.expectedGatewayRevision ||
    account.authorizationEpoch !== source.authorizationEpochMirror ||
    account.state !== "active"
  )
    throw new ProviderAccountError("connection_unavailable");
  return store.attach(intent);
}
