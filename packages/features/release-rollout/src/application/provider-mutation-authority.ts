import {
  assertOneShotMutationPermit,
  assertMutationExecutionReceipt,
  sameProviderState,
  sameProviderResource,
  type ExpectedProviderState,
  type MutationExecutionReceipt,
  type ObservedProviderPostcondition,
  type OneShotMutationPermit,
  type ProviderMutationReconciliation,
  type ProviderResourceIdentity,
} from "../domain/provider-mutation";

export interface ProviderMutationAuthorityPort {
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
  }): Promise<AuthorizedMutationOutcome> {
    const permit = assertOneShotMutationPermit(
      await this.authority.issue({
        rolloutId: input.rolloutId,
        operation: input.operation,
        resource: input.resource,
        ownerId: input.ownerId,
        expected: input.expected,
        leaseSeconds: input.leaseSeconds ?? 60,
      }),
      this.now(),
    );
    if (
      permit.rolloutId !== input.rolloutId ||
      permit.operation !== input.operation ||
      !sameProviderResource(permit.resource, input.resource) ||
      permit.ownerId !== input.ownerId ||
      !sameProviderState(permit.expected, input.expected)
    )
      throw new Error("provider_mutation_permit_binding_invalid");
    const receipt = assertMutationExecutionReceipt(
      await this.authority.consume(permit),
      permit,
    );
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
        Date.parse(permit.expiresAt) > this.now().getTime() &&
        (await this.authority.validateExecution(receipt));
    } catch {
      authorized = false;
    }
    if (!authorized) {
      await this.authority.reconcile({
        result: "execution_not_authorized",
        receipt,
        observation: before,
      });
      throw new Error("provider_mutation_execution_not_authorized");
    }
    try {
      await input.mutate();
    } catch {
      return this.reconcileAfterAmbiguous(input, receipt);
    }
    let after: ObservedProviderPostcondition;
    try {
      after = await input.observe();
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

  private async reconcileAfterAmbiguous(
    input: {
      expectedPostcondition:
        | ExpectedProviderState
        | ((observation: ObservedProviderPostcondition) => boolean);
      observe: () => Promise<ObservedProviderPostcondition>;
    },
    receipt: MutationExecutionReceipt,
  ): Promise<AuthorizedMutationOutcome> {
    let observation: ObservedProviderPostcondition;
    try {
      observation = await input.observe();
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
