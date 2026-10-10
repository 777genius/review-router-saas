import type {
  ScopedBindingFence,
  WorkspaceAccountBinding,
} from "../../domain/provider-account";

/** Trusted gateway boundary: "applied" means a durable fence receipt for these
 * exact fields, never HTTP success, local denial or native closure proof.
 * Implementations bound their own I/O and perform no inference, epoch change,
 * occupancy release or allowance reset. SDK/HTTP construction and authenticated
 * response validation belong to later server composition.
 */
export type BindingFenceResponse =
  | {
      readonly state: "applied";
      readonly operationId: string;
      readonly policySubject: string;
      readonly policyRevision: number;
    }
  | { readonly state: "pending" | "unknown" | "rejected" | "not_found" };

export interface WorkspaceBindingFenceDeliveryPort {
  submitFence(intent: ScopedBindingFence): Promise<BindingFenceResponse>;
  readFenceOperation(intent: ScopedBindingFence): Promise<BindingFenceResponse>;
}

export interface WorkspaceBindingFenceRepositoryPort {
  listPendingBindingFences(input: {
    readonly limit: number;
    readonly afterBindingId?: string;
  }): Promise<readonly WorkspaceAccountBinding[]>;
  /** Exact pending-intent CAS only. A stale ACK returns false and cannot clear a
   * replacement. This is trusted bookkeeping, not an authorization grant. */
  acknowledgeBindingFence(intent: ScopedBindingFence): Promise<boolean>;
}
