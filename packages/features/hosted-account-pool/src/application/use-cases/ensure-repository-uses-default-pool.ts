import { bindRepositoryToDefaultPool } from "./manage-hosted-account-pool";
import type { HostedPoolRepositoryBinding } from "../../domain/account-pool";
import type {
  HostedBindingId,
  RepositoryId,
  WorkspaceId,
} from "../../domain/identifiers";
import type {
  HostedPoolBindingRepositoryPort,
  HostedPoolRepositoryPort,
} from "../ports/hosted-pool-repository-port";

/** Called under the existing repository provisioning lock, after live authority checks.
 * A retry must carry the observed revision; it cannot silently move a binding.
 * This operation changes neither review configuration nor workflow attestation.
 */
export async function ensureRepositoryUsesDefaultPool(
  input: {
    readonly bindingId: HostedBindingId;
    readonly repositoryId: RepositoryId;
    readonly workspaceId: WorkspaceId;
    readonly expectedRevision: number | null;
    readonly now: Date;
  },
  dependencies: {
    readonly pools: HostedPoolRepositoryPort;
    readonly bindings: HostedPoolBindingRepositoryPort;
  },
): Promise<{
  readonly status: "already_active" | "pending_activation";
  readonly binding: HostedPoolRepositoryBinding;
}> {
  const pool = await dependencies.pools.findDefaultByWorkspaceId(
    input.workspaceId,
  );
  if (
    !pool ||
    pool.workspaceId !== input.workspaceId ||
    pool.status !== "active"
  ) {
    throw new Error("hosted_default_pool_unavailable");
  }
  const current = await dependencies.bindings.findByRepositoryId(
    input.repositoryId,
  );
  if ((current?.revision ?? null) !== input.expectedRevision) {
    throw new Error("hosted_pool_binding_revision_conflict");
  }
  if (current) {
    if (
      current.workspaceId !== input.workspaceId ||
      current.repositoryId !== input.repositoryId ||
      current.poolId !== pool.id ||
      current.status === "draining" ||
      current.authMode !== "codex_subscription_oauth_hosted_pool"
    ) {
      throw new Error("hosted_pool_binding_conflict");
    }
    if (
      current.status === "active" &&
      current.attestedBindingRevision !== current.revision
    ) {
      throw new Error("hosted_pool_binding_conflict");
    }
    return {
      status:
        current.status === "active" ? "already_active" : "pending_activation",
      binding: current,
    };
  }
  const binding = await bindRepositoryToDefaultPool(input, dependencies);
  return { status: "pending_activation", binding };
}
