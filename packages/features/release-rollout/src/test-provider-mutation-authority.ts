import { createHash } from "node:crypto";
import type { ProviderMutationAuthorityPort } from "./application/provider-mutation-authority";
import type {
  MutationExecutionReceipt,
  OneShotMutationPermit,
} from "./domain/provider-mutation";

/** Deterministic test double. Production compositions must use the HTTP/DB authority. */
export class TestProviderMutationAuthority implements ProviderMutationAuthorityPort {
  private sequence = 0;
  private readonly states = new Map<
    string,
    "issued" | "consumed" | "executing" | "done"
  >();
  private hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
  async issue(
    input: Parameters<ProviderMutationAuthorityPort["issue"]>[0],
  ): Promise<OneShotMutationPermit> {
    const epoch = ++this.sequence;
    const permitId = this.hash(`permit:${epoch}`);
    const key = permitId;
    this.states.set(key, "issued");
    return {
      ...input,
      epoch,
      permitId,
      token: this.hash(`token:${epoch}`),
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      singleUse: true,
    };
  }
  async consume(
    permit: OneShotMutationPermit,
  ): Promise<MutationExecutionReceipt> {
    if (this.states.get(permit.permitId) !== "issued")
      throw new Error("test_permit_replayed");
    this.states.set(permit.permitId, "consumed");
    return {
      rolloutId: permit.rolloutId,
      operation: permit.operation,
      resource: permit.resource,
      ownerId: permit.ownerId,
      epoch: permit.epoch,
      permitId: permit.permitId,
      receiptId: this.hash(`receipt:${permit.epoch}`),
      expected: permit.expected,
      consumedAt: "2026-01-01T00:00:01.000Z",
    };
  }
  async validateExecution(receipt: MutationExecutionReceipt): Promise<boolean> {
    if (this.states.get(receipt.permitId) !== "consumed") return false;
    this.states.set(receipt.permitId, "executing");
    return true;
  }
  async complete(
    input: Parameters<ProviderMutationAuthorityPort["complete"]>[0],
  ): Promise<void> {
    this.states.set(input.receipt.permitId, "done");
  }
  async reconcile(
    input: Parameters<ProviderMutationAuthorityPort["reconcile"]>[0],
  ): Promise<void> {
    this.states.set(input.receipt.permitId, "done");
  }
}
