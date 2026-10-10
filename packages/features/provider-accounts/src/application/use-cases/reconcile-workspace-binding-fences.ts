import {
  ProviderAccountError,
  assertOpaqueReference,
  snapshotBindingFence,
  type ScopedBindingFence,
} from "../../domain/provider-account";
import type {
  BindingFenceResponse,
  WorkspaceBindingFenceDeliveryPort,
  WorkspaceBindingFenceRepositoryPort,
} from "../ports/workspace-binding-fence-port";

function matchesReceipt(
  response: BindingFenceResponse,
  intent: ScopedBindingFence,
): boolean {
  return (
    response.state === "applied" &&
    response.operationId === intent.operationId &&
    response.policySubject === intent.policySubject &&
    response.policyRevision === intent.policyRevision
  );
}

/** One bounded pass, at most two fence I/O calls per row. No scheduler/inference
 * retry. After restart, read the same persisted operation. A cursor lets the
 * caller visit later rows without evicting unresolved requirements.
 */
export async function reconcileWorkspaceBindingFences(
  request: { readonly limit: number; readonly afterBindingId?: string },
  dependencies: {
    readonly accounts: WorkspaceBindingFenceRepositoryPort;
    readonly delivery: WorkspaceBindingFenceDeliveryPort;
  },
): Promise<{
  readonly results: readonly {
    readonly bindingId: string;
    readonly requiredPolicyRevision: number;
    readonly remoteFenceDelivery: "remote_applied" | "remote_pending";
  }[];
  readonly nextAfterBindingId: string | null;
}> {
  const input = {
    limit: request.limit,
    ...(request.afterBindingId !== undefined
      ? { afterBindingId: request.afterBindingId }
      : {}),
  };
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new ProviderAccountError("invalid_input");
  if (input.afterBindingId !== undefined)
    assertOpaqueReference(input.afterBindingId);
  const rows = await dependencies.accounts.listPendingBindingFences(input);
  // Snapshot every intent before the first delivery await.
  const intents = rows.slice(0, input.limit).map((row) => {
    if (!row.pendingFence) throw new ProviderAccountError("invalid_input");
    // Row identity owns the scope; metadata can supply only fence primitives.
    return snapshotBindingFence({
      bindingId: row.id,
      workspaceId: row.workspaceId,
      operationId: row.pendingFence.operationId,
      policySubject: row.pendingFence.policySubject,
      policyRevision: row.pendingFence.policyRevision,
    });
  });
  const results = [];
  for (const intent of intents) {
    let applied = false;
    try {
      let receipt: BindingFenceResponse = { state: "unknown" };
      try {
        receipt = await dependencies.delivery.submitFence(intent);
      } catch {
        /* Lost submit ACK: read back under the same operation. */
      }
      if (!matchesReceipt(receipt, intent))
        receipt = await dependencies.delivery.readFenceOperation(intent);
      if (matchesReceipt(receipt, intent))
        applied = await dependencies.accounts.acknowledgeBindingFence(intent);
    } catch {
      /* Unknown delivery/storage facts remain pending; no private error output. */
    }
    results.push({
      bindingId: intent.bindingId,
      requiredPolicyRevision: intent.policyRevision,
      remoteFenceDelivery: applied
        ? ("remote_applied" as const)
        : ("remote_pending" as const),
    });
  }
  return { results, nextAfterBindingId: intents.at(-1)?.bindingId ?? null };
}
