export const RecoveryEffectKind = Object.freeze({
  RestoreServiceConfig: "restore_service_config",
  RestoreServiceEnvironment: "restore_service_environment",
  RestoreServiceDeploy: "restore_service_deploy",
  RestoreDatabaseWrites: "restore_database_writes",
  ResumeSourceService: "resume_source_service",
} as const);
export type RecoveryEffectKind =
  (typeof RecoveryEffectKind)[keyof typeof RecoveryEffectKind];

export const RecoveryEffectState = Object.freeze({
  Intended: "intended",
  Claimed: "claimed",
  Consumed: "consumed",
  Completed: "completed",
  ForwardRepair: "forward_repair",
} as const);
export type RecoveryEffectState =
  (typeof RecoveryEffectState)[keyof typeof RecoveryEffectState];

export interface RecoveryEffectRecord {
  readonly rolloutId: string;
  readonly effectKey: string;
  readonly kind: RecoveryEffectKind;
  readonly serviceId: string | null;
  readonly state: RecoveryEffectState;
  readonly epoch: number;
  readonly claimOwnerId: string | null;
  readonly permitToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly consumedAt: string | null;
  readonly completedAt: string | null;
  readonly observation: unknown | null;
}

const token = /^[a-f0-9]{64}$/u;
const effectKey = /^[a-z][a-z0-9_]*(?::[A-Za-z0-9._-]+)?$/u;

/** Domain invariant shared by every recovery adapter boundary. */
export function assertRecoveryEffectRecord(
  value: unknown,
): RecoveryEffectRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("recovery_effect_record_invalid");
  const record = value as RecoveryEffectRecord;
  if (
    typeof record.rolloutId !== "string" ||
    !effectKey.test(record.effectKey) ||
    !Object.values(RecoveryEffectKind).includes(record.kind) ||
    (record.serviceId !== null && typeof record.serviceId !== "string") ||
    !Object.values(RecoveryEffectState).includes(record.state) ||
    !Number.isSafeInteger(record.epoch) ||
    record.epoch < 0 ||
    (record.claimOwnerId !== null && record.claimOwnerId.length < 3) ||
    (record.permitToken !== null && !token.test(record.permitToken)) ||
    (record.leaseExpiresAt !== null &&
      !Number.isFinite(Date.parse(record.leaseExpiresAt))) ||
    (record.consumedAt !== null &&
      !Number.isFinite(Date.parse(record.consumedAt))) ||
    (record.completedAt !== null &&
      !Number.isFinite(Date.parse(record.completedAt)))
  )
    throw new Error("recovery_effect_record_invalid");
  const claimed = record.state === RecoveryEffectState.Claimed;
  const consumed =
    record.state === RecoveryEffectState.Consumed ||
    record.state === RecoveryEffectState.Completed ||
    record.state === RecoveryEffectState.ForwardRepair;
  if (
    (claimed &&
      (record.epoch < 1 ||
        record.claimOwnerId === null ||
        record.permitToken === null ||
        record.leaseExpiresAt === null)) ||
    (!claimed && record.leaseExpiresAt !== null) ||
    (record.state === RecoveryEffectState.Intended &&
      (record.claimOwnerId !== null || record.permitToken !== null)) ||
    (consumed &&
      (record.epoch < 1 ||
        record.claimOwnerId === null ||
        record.permitToken === null ||
        record.consumedAt === null)) ||
    (record.state === RecoveryEffectState.Completed &&
      (record.completedAt === null || record.observation === null)) ||
    (record.completedAt === null) !== (record.observation === null) ||
    (record.state !== RecoveryEffectState.Completed &&
      record.state !== RecoveryEffectState.ForwardRepair &&
      record.completedAt !== null)
  )
    throw new Error("recovery_effect_state_invariant_violated");
  return record;
}

export function mayConsumeRecoveryPermit(input: {
  record: RecoveryEffectRecord;
  ownerId: string;
  epoch: number;
  permitToken: string;
  now: string;
}): boolean {
  const record = assertRecoveryEffectRecord(input.record);
  return (
    record.state === RecoveryEffectState.Claimed &&
    record.claimOwnerId === input.ownerId &&
    record.epoch === input.epoch &&
    record.permitToken === input.permitToken &&
    Date.parse(record.leaseExpiresAt!) > Date.parse(input.now)
  );
}
