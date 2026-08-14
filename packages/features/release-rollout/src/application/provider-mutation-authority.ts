import {
  assertOneShotMutationPermit,
  assertMutationExecutionReceipt,
  sameProviderState,
  sameProviderResource,
  type ExpectedProviderState,
  type MutationExecutionReceipt,
  type ObservedProviderPostcondition,
  type OneShotMutationPermit,
  type MutationTerminalOutcome,
  type ProviderMutationRecovery,
  type ProviderMutationRecoveryRequest,
  type ProviderMutationReconciliation,
  type ProviderMutationResultIdentity,
  type ProviderResourceIdentity,
} from "../domain/provider-mutation";

export interface ProviderMutationAuthorityPort {
  /** Read/recover the durable idempotency record before issuing authority. */
  recover(
    input: ProviderMutationRecoveryRequest,
  ): Promise<ProviderMutationRecovery>;
  issue(input: {
    rolloutId: string;
    operation: string;
    resource: ProviderResourceIdentity;
    ownerId: string;
    expected: ExpectedProviderState;
    leaseSeconds: number;
  }): Promise<OneShotMutationPermit>;
  /** Exact committed retries return the bound receipt, never a new receipt. */
  consume(input: OneShotMutationPermit): Promise<MutationExecutionReceipt>;
  /** Authority-backed validation is deliberately adjacent to provider I/O. */
  validateExecution(input: MutationExecutionReceipt): Promise<boolean>;
  /** Exact committed retries resolve successfully without reopening authority. */
  complete(input: {
    receipt: MutationExecutionReceipt;
    observation: ObservedProviderPostcondition;
  }): Promise<void>;
  reconcile(input: ProviderMutationReconciliation): Promise<void>;
}

export type AuthorizedMutationOutcome =
  | Readonly<{
      status: "applied";
      receipt: MutationExecutionReceipt;
      observation: ObservedProviderPostcondition;
    }>
  | Readonly<{
      status: "reconciled";
      receipt: MutationExecutionReceipt;
      observation: ObservedProviderPostcondition;
    }>;

/**
 * Serializes a mutation at authority and proves pre/post state around one I/O.
 * Providers without conditional writes (including Render) do not gain native CAS.
 */
export class AuthoritySerializedMutation {
  constructor(
    private readonly authority: ProviderMutationAuthorityPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: {
    rolloutId: string;
    operation: string;
    resource: ProviderResourceIdentity;
    ownerId: string;
    expected: ExpectedProviderState;
    expectedPostcondition:
      | ExpectedProviderState
      | ((observation: ObservedProviderPostcondition) => boolean);
    leaseSeconds?: number;
    observe: () => Promise<ObservedProviderPostcondition>;
    mutate: () => Promise<void>;
    identifyResult?: (
      observation: ObservedProviderPostcondition,
      receipt: MutationExecutionReceipt,
    ) => ProviderMutationResultIdentity | null;
  }): Promise<AuthorizedMutationOutcome> {
    const request = {
      rolloutId: input.rolloutId,
      operation: input.operation,
      resource: input.resource,
      ownerId: input.ownerId,
      expected: input.expected,
      leaseSeconds: input.leaseSeconds ?? 60,
    };
    const recovery = await this.authority.recover(request);
    if (recovery.status === "terminal")
      return this.terminalOutcome(recovery.outcome, input);
    if (recovery.status === "receipt" && recovery.phase === "executing") {
      if (!recovery.reconciliationOnly)
        throw new Error("provider_mutation_execution_in_progress");
      return this.reconcileRecoveredExecution(input, recovery.receipt);
    }
    const permit =
      recovery.status === "permit"
        ? assertOneShotMutationPermit(recovery.permit, this.now())
        : recovery.status === "absent"
          ? assertOneShotMutationPermit(
              await this.authority.issue(request),
              this.now(),
            )
          : null;
    const receipt =
      recovery.status === "receipt"
        ? recovery.receipt
        : assertMutationExecutionReceipt(
            await this.authority.consume(permit as OneShotMutationPermit),
            permit as OneShotMutationPermit,
          );
    if (recovery.status !== "receipt") {
      const boundPermit = permit as OneShotMutationPermit;
      if (
        boundPermit.rolloutId !== input.rolloutId ||
        boundPermit.operation !== input.operation ||
        !sameProviderResource(boundPermit.resource, input.resource) ||
        boundPermit.ownerId !== input.ownerId ||
        !sameProviderState(boundPermit.expected, input.expected)
      )
        throw new Error("provider_mutation_permit_binding_invalid");
    } else if (!this.receiptMatchesInput(receipt, input)) {
      throw new Error("provider_mutation_receipt_binding_invalid");
    }
    const before = await input.observe();
    if (!sameProviderState(before.state, input.expected)) {
      await this.authority.reconcile({
        result: "precondition_drift",
        receipt,
        observation: before,
      });
      throw new Error("provider_mutation_precondition_drift");
    }
    let authorized: boolean;
    try {
      authorized =
        (recovery.status === "receipt" ||
          Date.parse((permit as OneShotMutationPermit).expiresAt) >
            this.now().getTime()) &&
        (await this.authority.validateExecution(receipt));
    } catch {
      authorized = false;
    }
    if (!authorized)
      return this.resolveUncertainValidation(request, input, receipt);
    try {
      await input.mutate();
    } catch {
      return this.reconcileAfterAmbiguous(input, receipt);
    }
    let after: ObservedProviderPostcondition;
    try {
      after = this.withResultIdentity(await input.observe(), input, receipt);
    } catch {
      await this.authority.reconcile({
        result: "ambiguous_forward_repair",
        receipt,
        observation: null,
      });
      throw new Error("provider_mutation_forward_repair_required");
    }
    if (!this.matchesPostcondition(after, input.expectedPostcondition)) {
      await this.authority.reconcile({
        result: "ambiguous_forward_repair",
        receipt,
        observation: after,
      });
      throw new Error("provider_mutation_forward_repair_required");
    }
    await this.authority.complete({ receipt, observation: after });
    return { status: "applied", receipt, observation: after };
  }

  private async resolveUncertainValidation(
    request: ProviderMutationRecoveryRequest,
    input: Parameters<AuthoritySerializedMutation["execute"]>[0],
    receipt: MutationExecutionReceipt,
  ): Promise<AuthorizedMutationOutcome> {
    let recovery: ProviderMutationRecovery;
    try {
      recovery = await this.authority.recover(request);
    } catch {
      // A lost validator response may have committed executing. Never convert
      // an authority read failure into a terminal denial that clears its fence.
      throw new Error("provider_mutation_execution_authority_uncertain");
    }
    if (recovery.status === "terminal")
      return this.terminalOutcome(recovery.outcome, input);
    if (recovery.status === "receipt") {
      if (!this.receiptMatchesInput(recovery.receipt, input))
        throw new Error("provider_mutation_receipt_binding_invalid");
      if (
        recovery.receipt.receiptId !== receipt.receiptId ||
        recovery.receipt.epoch !== receipt.epoch ||
        recovery.receipt.permitId !== receipt.permitId
      )
        throw new Error("provider_mutation_execution_not_authorized");
      if (recovery.phase === "executing") {
        if (!recovery.reconciliationOnly)
          throw new Error("provider_mutation_execution_in_progress");
        return this.reconcileRecoveredExecution(input, recovery.receipt);
      }
      throw new Error("provider_mutation_execution_authority_uncertain");
    }
    // Absent or rotated permit authority proves this receipt cannot execute.
    // It does not authorize reconciling the stale receipt or clearing the
    // resource fence now owned by another permit.
    throw new Error("provider_mutation_execution_not_authorized");
  }

  private async reconcileRecoveredExecution(
    input: Parameters<AuthoritySerializedMutation["execute"]>[0],
    receipt: MutationExecutionReceipt,
  ): Promise<AuthorizedMutationOutcome> {
    if (!this.receiptMatchesInput(receipt, input))
      throw new Error("provider_mutation_receipt_binding_invalid");
    let observation: ObservedProviderPostcondition;
    try {
      observation = this.withResultIdentity(
        await input.observe(),
        input,
        receipt,
      );
    } catch {
      await this.authority.reconcile({
        result: "ambiguous_forward_repair",
        receipt,
        observation: null,
      });
      throw new Error("provider_mutation_forward_repair_required");
    }
    if (this.matchesPostcondition(observation, input.expectedPostcondition)) {
      await this.authority.reconcile({
        result: "exact_postcondition",
        receipt,
        observation,
      });
      return { status: "reconciled", receipt, observation };
    }
    await this.authority.reconcile({
      result: "ambiguous_forward_repair",
      receipt,
      observation,
    });
    throw new Error("provider_mutation_forward_repair_required");
  }

  private terminalOutcome(
    outcome: MutationTerminalOutcome,
    input: Parameters<AuthoritySerializedMutation["execute"]>[0],
  ): AuthorizedMutationOutcome {
    if (
      outcome.rolloutId !== input.rolloutId ||
      outcome.operation !== input.operation ||
      outcome.ownerId !== input.ownerId ||
      !sameProviderResource(outcome.resource, input.resource) ||
      (outcome.observation !== null &&
        !sameProviderResource(outcome.observation.resource, input.resource))
    )
      throw new Error("provider_mutation_terminal_binding_invalid");
    if (outcome.result !== "exact_postcondition" || !outcome.observation)
      throw new Error(
        outcome.result === "precondition_drift"
          ? "provider_mutation_precondition_drift"
          : outcome.result === "execution_not_authorized"
            ? "provider_mutation_execution_not_authorized"
            : "provider_mutation_forward_repair_required",
      );
    return {
      status: "reconciled",
      receipt: {
        rolloutId: outcome.rolloutId,
        operation: outcome.operation,
        resource: outcome.resource,
        ownerId: outcome.ownerId,
        epoch: outcome.epoch,
        permitId: outcome.permitId,
        receiptId: outcome.receiptId,
        expected: outcome.expected,
        consumedAt: outcome.consumedAt,
      },
      observation: outcome.observation,
    };
  }

  private receiptMatchesInput(
    receipt: MutationExecutionReceipt,
    input: Parameters<AuthoritySerializedMutation["execute"]>[0],
  ): boolean {
    return (
      receipt.rolloutId === input.rolloutId &&
      receipt.operation === input.operation &&
      receipt.ownerId === input.ownerId &&
      sameProviderResource(receipt.resource, input.resource)
    );
  }

  private async reconcileAfterAmbiguous(
    input: {
      expectedPostcondition:
        | ExpectedProviderState
        | ((observation: ObservedProviderPostcondition) => boolean);
      observe: () => Promise<ObservedProviderPostcondition>;
      identifyResult?: (
        observation: ObservedProviderPostcondition,
        receipt: MutationExecutionReceipt,
      ) => ProviderMutationResultIdentity | null;
    },
    receipt: MutationExecutionReceipt,
  ): Promise<AuthorizedMutationOutcome> {
    let observation: ObservedProviderPostcondition;
    try {
      observation = this.withResultIdentity(
        await input.observe(),
        input,
        receipt,
      );
    } catch {
      await this.authority.reconcile({
        result: "ambiguous_forward_repair",
        receipt,
        observation: null,
      });
      throw new Error("provider_mutation_forward_repair_required");
    }
    if (this.matchesPostcondition(observation, input.expectedPostcondition)) {
      await this.authority.reconcile({
        result: "exact_postcondition",
        receipt,
        observation,
      });
      return { status: "reconciled", receipt, observation };
    }
    await this.authority.reconcile({
      result: "ambiguous_forward_repair",
      receipt,
      observation,
    });
    throw new Error("provider_mutation_forward_repair_required");
  }

  private withResultIdentity(
    observation: ObservedProviderPostcondition,
    input: {
      identifyResult?: (
        observation: ObservedProviderPostcondition,
        receipt: MutationExecutionReceipt,
      ) => ProviderMutationResultIdentity | null;
    },
    receipt: MutationExecutionReceipt,
  ): ObservedProviderPostcondition {
    const resultIdentity = input.identifyResult?.(observation, receipt);
    return resultIdentity ? { ...observation, resultIdentity } : observation;
  }

  private matchesPostcondition(
    observation: ObservedProviderPostcondition,
    expected:
      | ExpectedProviderState
      | ((observation: ObservedProviderPostcondition) => boolean),
  ): boolean {
    return typeof expected === "function"
      ? expected(observation)
      : sameProviderState(observation.state, expected);
  }
}
