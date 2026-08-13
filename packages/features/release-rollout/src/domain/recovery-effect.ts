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
  Executing: "executing",
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

export interface RecoveryEffectExecutionAuthorization {
  readonly receipt: string;
  readonly rolloutId: string;
  readonly effectKey: string;
  readonly kind: RecoveryEffectKind;
  readonly ownerId: string;
  readonly epoch: number;
  readonly permitToken: string;
}

export interface RecoveryEffectConsumptionResult {
  readonly record: RecoveryEffectRecord;
  /** Present only in the response to the transaction that changed claimed -> consumed. */
  readonly executionAuthorization: RecoveryEffectExecutionAuthorization | null;
}

const token = /^[a-f0-9]{64}$/u;
const effectKey = /^[a-z][a-z0-9_]*(?::[A-Za-z0-9._-]+)?$/u;
const bounded = (value: unknown, length = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= length;
const exactKeys = (value: object, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
};
const sha256 = /^sha256:[a-f0-9]{64}$/u;
const serviceId = /^srv-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const deployId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const systemIdentifier = /^[0-9]{1,64}$/u;
const isoTimestamp =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/u;

export function assertRecoveryEffectObservation(
  kind: RecoveryEffectKind,
  value: unknown,
): Readonly<Record<string, string | boolean>> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("recovery_effect_observation_invalid");
  const item = value as Record<string, unknown>;
  const valid =
    (kind === RecoveryEffectKind.RestoreServiceConfig &&
      exactKeys(item, ["serviceId", "serviceContractSha256", "suspended"]) &&
      serviceId.test(String(item.serviceId)) &&
      sha256.test(String(item.serviceContractSha256)) &&
      typeof item.suspended === "boolean") ||
    (kind === RecoveryEffectKind.RestoreServiceEnvironment &&
      exactKeys(item, ["serviceId", "environmentSha256"]) &&
      serviceId.test(String(item.serviceId)) &&
      sha256.test(String(item.environmentSha256))) ||
    (kind === RecoveryEffectKind.RestoreServiceDeploy &&
      exactKeys(item, ["serviceId", "deployId"]) &&
      serviceId.test(String(item.serviceId)) &&
      deployId.test(String(item.deployId))) ||
    (kind === RecoveryEffectKind.RestoreDatabaseWrites &&
      ((exactKeys(item, ["sourceWritesRestored", "observedAt"]) &&
        item.sourceWritesRestored === true &&
        typeof item.observedAt === "string" &&
        isoTimestamp.test(item.observedAt) &&
        Number.isFinite(Date.parse(item.observedAt))) ||
        (exactKeys(item, [
          "systemIdentifier",
          "aclSha256",
          "observedAt",
          "sourceWritesRestored",
        ]) &&
          systemIdentifier.test(String(item.systemIdentifier)) &&
          sha256.test(String(item.aclSha256)) &&
          typeof item.observedAt === "string" &&
          isoTimestamp.test(item.observedAt) &&
          Number.isFinite(Date.parse(item.observedAt)) &&
          item.sourceWritesRestored === true))) ||
    (kind === RecoveryEffectKind.ResumeSourceService &&
      exactKeys(item, [
        "serviceId",
        "resumed",
        "serviceContractSha256",
        "environmentSha256",
      ]) &&
      serviceId.test(String(item.serviceId)) &&
      item.resumed === true &&
      sha256.test(String(item.serviceContractSha256)) &&
      sha256.test(String(item.environmentSha256)));
  if (!valid) throw new Error("recovery_effect_observation_invalid");
  return item as Readonly<Record<string, string | boolean>>;
}

/** Domain invariant shared by every recovery adapter boundary. */
export function assertRecoveryEffectRecord(
  value: unknown,
): RecoveryEffectRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("recovery_effect_record_invalid");
  const record = value as RecoveryEffectRecord;
  if (
    !bounded(record.rolloutId) ||
    !effectKey.test(record.effectKey) ||
    !Object.values(RecoveryEffectKind).includes(record.kind) ||
    (record.kind === RecoveryEffectKind.RestoreDatabaseWrites) !==
      (record.serviceId === null) ||
    (record.serviceId !== null && !bounded(record.serviceId)) ||
    !Object.values(RecoveryEffectState).includes(record.state) ||
    !Number.isSafeInteger(record.epoch) ||
    record.epoch < 0 ||
    (record.claimOwnerId !== null &&
      (typeof record.claimOwnerId !== "string" ||
        record.claimOwnerId.length < 3 ||
        record.claimOwnerId.length > 128)) ||
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
    record.state === RecoveryEffectState.Executing ||
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
  if (record.observation !== null) {
    const observation = assertRecoveryEffectObservation(
      record.kind,
      record.observation,
    );
    if (
      "serviceId" in observation &&
      observation.serviceId !== record.serviceId
    )
      throw new Error("recovery_effect_observation_binding_invalid");
  }
  return record;
}

export function assertRecoveryEffectRecordBinding(
  recordValue: unknown,
  expected: {
    rolloutId: string;
    effectKey: string;
    kind?: RecoveryEffectKind;
    serviceId?: string | null;
    ownerId?: string;
    epoch?: number;
    permitToken?: string;
  },
): RecoveryEffectRecord {
  const record = assertRecoveryEffectRecord(recordValue);
  if (
    record.rolloutId !== expected.rolloutId ||
    record.effectKey !== expected.effectKey ||
    (expected.kind !== undefined && record.kind !== expected.kind) ||
    (expected.serviceId !== undefined &&
      record.serviceId !== expected.serviceId) ||
    (expected.ownerId !== undefined &&
      record.claimOwnerId !== expected.ownerId) ||
    (expected.epoch !== undefined && record.epoch !== expected.epoch) ||
    (expected.permitToken !== undefined &&
      record.permitToken !== expected.permitToken)
  )
    throw new Error("recovery_effect_response_binding_invalid");
  return record;
}

export function assertRecoveryEffectConsumptionResult(
  value: unknown,
  expected: {
    rolloutId: string;
    effectKey: string;
    ownerId: string;
    epoch: number;
    permitToken: string;
    kind?: RecoveryEffectKind;
  },
): RecoveryEffectConsumptionResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("recovery_effect_consumption_result_invalid");
  const result = value as RecoveryEffectConsumptionResult;
  if (!exactKeys(result, ["record", "executionAuthorization"]))
    throw new Error("recovery_effect_consumption_result_invalid");
  const record = assertRecoveryEffectRecordBinding(result.record, expected);
  const authorization = result.executionAuthorization;
  if (authorization !== null) {
    if (
      !authorization ||
      typeof authorization !== "object" ||
      !exactKeys(authorization, [
        "receipt",
        "rolloutId",
        "effectKey",
        "kind",
        "ownerId",
        "epoch",
        "permitToken",
      ]) ||
      !token.test(authorization.receipt) ||
      authorization.rolloutId !== expected.rolloutId ||
      authorization.effectKey !== expected.effectKey ||
      authorization.kind !== record.kind ||
      authorization.ownerId !== expected.ownerId ||
      authorization.epoch !== expected.epoch ||
      authorization.permitToken !== expected.permitToken ||
      (record.state !== RecoveryEffectState.Consumed &&
        record.state !== RecoveryEffectState.Executing)
    )
      throw new Error("recovery_effect_execution_authorization_invalid");
  }
  return { record, executionAuthorization: authorization };
}

export function assertRecoveryEffectExecutionAuthorization(
  value: unknown,
  expected: Omit<RecoveryEffectExecutionAuthorization, "receipt"> & {
    receipt: string;
  },
): RecoveryEffectExecutionAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("recovery_effect_execution_authorization_invalid");
  const authorization = value as RecoveryEffectExecutionAuthorization;
  if (
    !exactKeys(authorization, [
      "receipt",
      "rolloutId",
      "effectKey",
      "kind",
      "ownerId",
      "epoch",
      "permitToken",
    ]) ||
    !token.test(authorization.receipt) ||
    authorization.receipt !== expected.receipt ||
    authorization.rolloutId !== expected.rolloutId ||
    authorization.effectKey !== expected.effectKey ||
    authorization.kind !== expected.kind ||
    authorization.ownerId !== expected.ownerId ||
    authorization.epoch !== expected.epoch ||
    authorization.permitToken !== expected.permitToken
  )
    throw new Error("recovery_effect_execution_authorization_invalid");
  return authorization;
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
