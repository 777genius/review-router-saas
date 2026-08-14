export interface ProviderResourceIdentity {
  readonly provider: string;
  readonly kind: string;
  readonly id: string;
}

export interface ExpectedProviderState {
  /** Canonical provider-neutral state witness, not a claim of provider-native CAS. */
  readonly fingerprint: string;
  readonly version: string | null;
}

export interface MutationLeaseIdentity {
  readonly rolloutId: string;
  readonly operation: string;
  readonly resource: ProviderResourceIdentity;
  readonly ownerId: string;
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

const sha256 = /^sha256:[a-f0-9]{64}$/u;
const token = /^[a-f0-9]{64}$/u;
const bounded = (value: unknown, max = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const timestamp = (value: string): boolean =>
  Number.isFinite(Date.parse(value));

export function assertOneShotMutationPermit(
  value: OneShotMutationPermit,
  now: Date,
): OneShotMutationPermit {
  if (
    !bounded(value.rolloutId) ||
    !bounded(value.operation) ||
    !bounded(value.resource.provider, 64) ||
    !bounded(value.resource.kind, 64) ||
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
