export const ExternalEffectState = Object.freeze({
  Prepared: "prepared",
  Dispatching: "dispatching",
  Bound: "bound",
  Cleaned: "cleaned",
  Abandoned: "abandoned",
  Blocked: "blocked",
} as const);
export type ExternalEffectState =
  (typeof ExternalEffectState)[keyof typeof ExternalEffectState];

export interface ExternalEffectRecord {
  readonly state: ExternalEffectState;
  readonly ownerId: string | null;
  readonly epoch: number;
  readonly providerId: string | null;
  readonly safeForCompensation: boolean;
}

export type ExternalEffectReconciliation =
  | { readonly result: "clean"; readonly safeForCompensation: true }
  | { readonly result: "pending"; readonly safeForCompensation: false }
  | {
      readonly result: "blocked";
      readonly safeForCompensation: false;
      readonly reason:
        | "unknown"
        | "duplicate"
        | "timeout"
        | "unresolved_legacy";
    };

export function assertExternalEffectRecord(
  value: ExternalEffectRecord,
): ExternalEffectRecord {
  if (
    !Object.values(ExternalEffectState).includes(value.state) ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 0 ||
    (value.ownerId !== null && value.ownerId.length < 3) ||
    (value.providerId !== null && value.providerId.length < 1)
  )
    throw new Error("external_effect_record_invalid");
  if (
    (value.state === ExternalEffectState.Prepared &&
      (value.ownerId === null ||
        value.providerId !== null ||
        value.safeForCompensation)) ||
    (value.state === ExternalEffectState.Dispatching &&
      (value.ownerId === null ||
        value.epoch < 1 ||
        value.providerId !== null)) ||
    (value.state === ExternalEffectState.Bound && value.providerId === null) ||
    ((value.state === ExternalEffectState.Cleaned ||
      value.state === ExternalEffectState.Abandoned) &&
      !value.safeForCompensation) ||
    (value.state === ExternalEffectState.Abandoned &&
      value.providerId !== null) ||
    (value.safeForCompensation &&
      value.state !== ExternalEffectState.Cleaned &&
      value.state !== ExternalEffectState.Abandoned)
  )
    throw new Error("external_effect_state_invariant_violated");
  return value;
}

export function mayDispatchProviderPost(input: {
  readonly record: ExternalEffectRecord;
  readonly permitOwnerId: string;
  readonly permitEpoch: number;
}): boolean {
  const record = assertExternalEffectRecord(input.record);
  return (
    record.state === ExternalEffectState.Dispatching &&
    record.ownerId === input.permitOwnerId &&
    record.epoch === input.permitEpoch
  );
}

export function classifyExternalEffectDiscovery(input: {
  readonly matchingProviderIds: readonly string[];
  readonly timedOut: boolean;
  readonly legacyUnresolved?: boolean;
}): ExternalEffectReconciliation {
  if (input.legacyUnresolved)
    return {
      result: "blocked",
      safeForCompensation: false,
      reason: "unresolved_legacy",
    };
  if (input.matchingProviderIds.length > 1)
    return {
      result: "blocked",
      safeForCompensation: false,
      reason: "duplicate",
    };
  if (input.matchingProviderIds.length === 0 && input.timedOut)
    return {
      result: "blocked",
      safeForCompensation: false,
      reason: "timeout",
    };
  return { result: "pending", safeForCompensation: false };
}
