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

/** Canonical wire/domain DTO returned when persisted runner intents are listed. */
export interface RunnerProvisioningIntentRecord {
  readonly id: string;
  readonly rolloutId: string;
  readonly serviceId: string;
  readonly lifecycle: "role" | "cutover";
  readonly workflowJobId: string;
  readonly runnerName: string;
  readonly createdAt: string;
  readonly startCommandSha256: string;
  readonly creationLeaseOwner: string | null;
  readonly creationLeaseExpiresAt: string | null;
  readonly effect: ExternalEffectRecord;
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
export type ExternalEffectControlReconciliation = Exclude<
  ExternalEffectReconciliation,
  { readonly result: "clean" }
>;

export function assertExternalEffectRecord(
  value: unknown,
): ExternalEffectRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("external_effect_record_invalid");
  const record = value as ExternalEffectRecord;
  if (
    !Object.values(ExternalEffectState).includes(record.state) ||
    !Number.isSafeInteger(record.epoch) ||
    record.epoch < 0 ||
    (record.ownerId !== null &&
      (typeof record.ownerId !== "string" || record.ownerId.length < 3)) ||
    (record.providerId !== null &&
      (typeof record.providerId !== "string" ||
        record.providerId.length < 1)) ||
    typeof record.safeForCompensation !== "boolean"
  )
    throw new Error("external_effect_record_invalid");
  if (
    (record.state === ExternalEffectState.Prepared &&
      (record.ownerId === null ||
        record.providerId !== null ||
        record.safeForCompensation)) ||
    (record.state === ExternalEffectState.Dispatching &&
      (record.ownerId === null ||
        record.epoch < 1 ||
        record.providerId !== null)) ||
    (record.state === ExternalEffectState.Bound &&
      record.providerId === null) ||
    ((record.state === ExternalEffectState.Cleaned ||
      record.state === ExternalEffectState.Abandoned) &&
      !record.safeForCompensation) ||
    (record.state === ExternalEffectState.Abandoned &&
      record.providerId !== null) ||
    (record.safeForCompensation &&
      record.state !== ExternalEffectState.Cleaned &&
      record.state !== ExternalEffectState.Abandoned)
  )
    throw new Error("external_effect_state_invariant_violated");
  return record;
}

/**
 * Validates the complete listed-intent contract at every adapter boundary.
 *
 * The owner identifies the effect attempt and therefore survives the prepared
 * lease. Only prepared effects have an active lease expiry; dispatching and
 * all later states may legally retain their owner with a null expiry.
 */
export function assertRunnerProvisioningIntentRecord(
  value: unknown,
): RunnerProvisioningIntentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("runner_provisioning_intent_invalid");
  const intent = value as RunnerProvisioningIntentRecord;
  if (
    typeof intent.id !== "string" ||
    typeof intent.rolloutId !== "string" ||
    typeof intent.serviceId !== "string" ||
    (intent.lifecycle !== "role" && intent.lifecycle !== "cutover") ||
    typeof intent.workflowJobId !== "string" ||
    typeof intent.runnerName !== "string" ||
    typeof intent.createdAt !== "string" ||
    typeof intent.startCommandSha256 !== "string" ||
    (intent.creationLeaseOwner !== null &&
      typeof intent.creationLeaseOwner !== "string") ||
    (intent.creationLeaseExpiresAt !== null &&
      typeof intent.creationLeaseExpiresAt !== "string")
  )
    throw new Error("runner_provisioning_intent_invalid");

  const effect = assertExternalEffectRecord(intent.effect);
  if (
    intent.creationLeaseOwner !== effect.ownerId ||
    (effect.state === ExternalEffectState.Prepared
      ? intent.creationLeaseExpiresAt === null
      : intent.creationLeaseExpiresAt !== null)
  )
    throw new Error("runner_provisioning_intent_lease_invariant_violated");
  return intent;
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
}): ExternalEffectControlReconciliation {
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
  // Provider absence and timeouts are not terminal evidence. Dispatch remains
  // unsafe and may be discovered again, but can never authorize another POST.
  return { result: "pending", safeForCompensation: false };
}
