export const ProviderIdentifier = Object.freeze({
  Render: "render",
} as const);
export type ProviderIdentifier =
  (typeof ProviderIdentifier)[keyof typeof ProviderIdentifier];

export const ProviderResourceKind = Object.freeze({
  Service: "service",
  ServiceEnvironment: "service_environment",
  DeployCreationSlot: "deploy_creation_slot",
  JobCreationIntent: "job_creation_intent",
} as const);
export type ProviderResourceKind =
  (typeof ProviderResourceKind)[keyof typeof ProviderResourceKind];

export interface ProviderResourceIdentity {
  readonly provider: ProviderIdentifier;
  readonly kind: ProviderResourceKind;
  readonly id: string;
}

export interface ExpectedProviderState {
  /** Canonical provider-neutral state witness, not a claim of provider-native CAS. */
  readonly fingerprint: string;
  readonly version: string | null;
}

export const ProviderResourceLeaseState = Object.freeze({
  Claimed: "claimed",
  Consumed: "consumed",
  Executing: "executing",
  ForwardRepair: "forward_repair",
} as const);
export type ProviderResourceLeaseState =
  (typeof ProviderResourceLeaseState)[keyof typeof ProviderResourceLeaseState];

/** Resource-wide fence, independent of rollout and operation identity. */
export type ProviderResourceLease = Readonly<{
  resource: ProviderResourceIdentity;
  fenceEpoch: number;
  state: ProviderResourceLeaseState;
  rolloutId: string;
  operation: string;
  permitId: string;
}>;

export interface MutationLeaseIdentity {
  readonly rolloutId: string;
  readonly operation: string;
  readonly resource: ProviderResourceIdentity;
  readonly ownerId: string;
  /** Monotonic epoch of the resource-wide fence. */
  readonly epoch: number;
}

export interface OneShotMutationPermit extends MutationLeaseIdentity {
  readonly permitId: string;
  readonly token: string;
  readonly expected: ExpectedProviderState;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly singleUse: true;
}

export interface MutationExecutionReceipt extends MutationLeaseIdentity {
  readonly permitId: string;
  readonly receiptId: string;
  readonly expected: ExpectedProviderState;
  readonly consumedAt: string;
}

export interface ObservedProviderPostcondition {
  readonly resource: ProviderResourceIdentity;
  readonly state: ExpectedProviderState;
  readonly observedAt: string;
}

export type ProviderMutationReconciliation = Readonly<{
  result:
    | "exact_postcondition"
    | "precondition_drift"
    | "execution_not_authorized"
    | "ambiguous_forward_repair";
  receipt: MutationExecutionReceipt;
  observation: ObservedProviderPostcondition | null;
}>;

export const ProviderMutationTerminalResult = Object.freeze({
  ExactPostcondition: "exact_postcondition",
  PreconditionDrift: "precondition_drift",
  ExecutionNotAuthorized: "execution_not_authorized",
  AmbiguousForwardRepair: "ambiguous_forward_repair",
  ExpiredUnconsumed: "expired_unconsumed",
} as const);
export type ProviderMutationTerminalResult =
  (typeof ProviderMutationTerminalResult)[keyof typeof ProviderMutationTerminalResult];

type MutationTerminalOutcomeBase = Readonly<{
  status: "terminal";
  rolloutId: string;
  operation: string;
  resource: ProviderResourceIdentity;
  ownerId: string;
  epoch: number;
  permitId: string;
  expected: ExpectedProviderState;
  completedAt: string;
}>;

export type MutationTerminalOutcome = MutationTerminalOutcomeBase &
  (
    | Readonly<{
        result: Exclude<ProviderMutationTerminalResult, "expired_unconsumed">;
        receiptId: string;
        consumedAt: string;
        observation: ObservedProviderPostcondition | null;
      }>
    | Readonly<{
        result: "expired_unconsumed";
        receiptId: null;
        consumedAt: null;
        observation: null;
      }>
  );

export type ProviderMutationRecoveryRequest = Readonly<{
  rolloutId: string;
  operation: string;
  resource: ProviderResourceIdentity;
  ownerId: string;
  expected: ExpectedProviderState;
  leaseSeconds: number;
}>;

/**
 * Durable authority state for an idempotent mutation identity. An executing
 * receipt is reconciliation-only: provider I/O may already have happened and
 * must never be replayed from this state.
 */
export type ProviderMutationRecovery =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "permit"; permit: OneShotMutationPermit }>
  | Readonly<{
      status: "receipt";
      phase: "consumed" | "executing";
      reconciliationOnly: boolean;
      receipt: MutationExecutionReceipt;
    }>
  | Readonly<{ status: "terminal"; outcome: MutationTerminalOutcome }>;

const sha256 = /^sha256:[a-f0-9]{64}$/u;
const token = /^[a-f0-9]{64}$/u;
const bounded = (value: unknown, max = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const timestamp = (value: string): boolean =>
  Number.isFinite(Date.parse(value));
const providerKinds = new Set<ProviderResourceKind>(
  Object.values(ProviderResourceKind),
);

export function assertOneShotMutationPermit(
  value: OneShotMutationPermit,
  now: Date,
): OneShotMutationPermit {
  if (
    !bounded(value.rolloutId) ||
    !bounded(value.operation) ||
    value.resource.provider !== ProviderIdentifier.Render ||
    !providerKinds.has(value.resource.kind) ||
    !bounded(value.resource.id) ||
    !bounded(value.ownerId) ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 1 ||
    !bounded(value.permitId) ||
    !token.test(value.token) ||
    !sha256.test(value.expected.fingerprint) ||
    (value.expected.version !== null && !bounded(value.expected.version)) ||
    !timestamp(value.issuedAt) ||
    !timestamp(value.expiresAt) ||
    Date.parse(value.issuedAt) > now.getTime() ||
    Date.parse(value.expiresAt) <= now.getTime() ||
    value.singleUse !== true
  )
    throw new Error("provider_mutation_permit_invalid_or_expired");
  return value;
}

export function sameProviderState(
  left: ExpectedProviderState,
  right: ExpectedProviderState,
): boolean {
  return (
    left.fingerprint === right.fingerprint && left.version === right.version
  );
}

export function sameProviderResource(
  left: ProviderResourceIdentity,
  right: ProviderResourceIdentity,
): boolean {
  return (
    left.provider === right.provider &&
    left.kind === right.kind &&
    left.id === right.id
  );
}

export function assertMutationExecutionReceipt(
  receipt: MutationExecutionReceipt,
  permit: OneShotMutationPermit,
): MutationExecutionReceipt {
  if (
    receipt.rolloutId !== permit.rolloutId ||
    receipt.operation !== permit.operation ||
    !sameProviderResource(receipt.resource, permit.resource) ||
    receipt.ownerId !== permit.ownerId ||
    receipt.epoch !== permit.epoch ||
    receipt.permitId !== permit.permitId ||
    !sameProviderState(receipt.expected, permit.expected) ||
    !bounded(receipt.receiptId) ||
    !timestamp(receipt.consumedAt)
  )
    throw new Error("provider_mutation_receipt_binding_invalid");
  return receipt;
}
