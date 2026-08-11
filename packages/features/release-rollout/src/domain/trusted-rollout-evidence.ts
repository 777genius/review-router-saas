import {
  canonicalJson,
  sha256Canonical,
  type ActivationReceipt,
  type DatabaseGenerationIdentity,
  type RunnerIdentity,
} from "./release-rollout";

export interface BackupIdentity {
  readonly backupId: string;
  readonly pitrIdentity: string;
  readonly capturedAt: string;
}

export interface QuiescenceEvidence {
  readonly writersSuspended: true;
  readonly nonCutoverSessionCount: 0;
  readonly sourceRuntimeConnectRevoked: true;
}

export interface EquivalenceEvidence {
  readonly tables: readonly {
    readonly table: string;
    readonly sourceRows: number;
    readonly targetRows: number;
    readonly sourceSha256: string;
    readonly targetSha256: string;
  }[];
  readonly sequencesSha256: string;
  readonly constraintsSha256: string;
  readonly indexesSha256: string;
  readonly migrationHistorySha256: string;
  readonly equivalent: true;
}

export interface CleanupEvidence {
  readonly renderJobTerminal: true;
  readonly workspaceRemoved: true;
  readonly bootstrapCredentialsAbsent: true;
  readonly observedAt: string;
}

export interface TrustedRolloutEvidence {
  readonly schemaVersion: 1;
  readonly rolloutId: string;
  readonly releaseCommitSha: string;
  readonly runner: RunnerIdentity;
  readonly source: DatabaseGenerationIdentity;
  readonly target: DatabaseGenerationIdentity;
  readonly backup: BackupIdentity;
  readonly quiescence: QuiescenceEvidence;
  readonly dumpSha256: string;
  readonly equivalence: EquivalenceEvidence;
  readonly aclGateBeforeActivation: "closed";
  readonly activation: ActivationReceipt;
  readonly cleanup: CleanupEvidence;
  readonly evidenceSha256: string;
}

const digest = /^sha256:[a-f0-9]{64}$/u;
const sha = /^[a-f0-9]{40}$/u;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;
const exact = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function withoutDigest(
  value: Omit<TrustedRolloutEvidence, "evidenceSha256">,
): Omit<TrustedRolloutEvidence, "evidenceSha256"> {
  return value;
}

export function assembleTrustedRolloutEvidence(
  value: Omit<TrustedRolloutEvidence, "schemaVersion" | "evidenceSha256">,
): TrustedRolloutEvidence {
  const unsigned = Object.freeze({ ...value, schemaVersion: 1 as const });
  const evidence = Object.freeze({
    ...unsigned,
    evidenceSha256: `sha256:${sha256Canonical(unsigned)}`,
  });
  assertTrustedRolloutEvidence(evidence);
  return evidence;
}

export function assertTrustedRolloutEvidence(
  value: TrustedRolloutEvidence,
): TrustedRolloutEvidence {
  if (
    !exact(value, [
      "schemaVersion",
      "rolloutId",
      "releaseCommitSha",
      "runner",
      "source",
      "target",
      "backup",
      "quiescence",
      "dumpSha256",
      "equivalence",
      "aclGateBeforeActivation",
      "activation",
      "cleanup",
      "evidenceSha256",
    ]) ||
    !exact(value.runner, [
      "repository",
      "runId",
      "runAttempt",
      "commitSha",
      "jitLabel",
      "runnerName",
      "baseServiceId",
      "baseDeployId",
      "imageDigest",
    ]) ||
    !exact(value.source, [
      "renderResourceId",
      "systemIdentifier",
      "majorVersion",
      "recoveryWitnessSha256",
    ]) ||
    !exact(value.target, [
      "renderResourceId",
      "systemIdentifier",
      "majorVersion",
      "recoveryWitnessSha256",
    ]) ||
    !exact(value.backup, ["backupId", "pitrIdentity", "capturedAt"]) ||
    !exact(value.quiescence, [
      "writersSuspended",
      "nonCutoverSessionCount",
      "sourceRuntimeConnectRevoked",
    ]) ||
    !exact(value.equivalence, [
      "tables",
      "sequencesSha256",
      "constraintsSha256",
      "indexesSha256",
      "migrationHistorySha256",
      "equivalent",
    ]) ||
    value.equivalence.tables.some(
      (table) =>
        !exact(table, [
          "table",
          "sourceRows",
          "targetRows",
          "sourceSha256",
          "targetSha256",
        ]),
    ) ||
    !exact(value.activation, [
      "step",
      "receiptId",
      "observedAt",
      "payloadSha256",
      "sourceSystemIdentifier",
      "targetSystemIdentifier",
      "canonicalPrivilegesSha256",
      "transactionId",
      "firstWriteBoundary",
    ]) ||
    !exact(value.cleanup, [
      "renderJobTerminal",
      "workspaceRemoved",
      "bootstrapCredentialsAbsent",
      "observedAt",
    ]) ||
    value.schemaVersion !== 1 ||
    !identifier.test(value.rolloutId) ||
    !sha.test(value.releaseCommitSha) ||
    value.source.majorVersion !== 16 ||
    value.target.majorVersion !== 17 ||
    value.source.renderResourceId === value.target.renderResourceId ||
    value.source.systemIdentifier === value.target.systemIdentifier ||
    !identifier.test(value.backup.backupId) ||
    !identifier.test(value.backup.pitrIdentity) ||
    !timestamp.test(value.backup.capturedAt) ||
    value.quiescence.writersSuspended !== true ||
    value.quiescence.nonCutoverSessionCount !== 0 ||
    value.quiescence.sourceRuntimeConnectRevoked !== true ||
    !digest.test(value.dumpSha256) ||
    value.equivalence.equivalent !== true ||
    value.equivalence.tables.length === 0 ||
    value.equivalence.tables.some(
      (table) =>
        table.sourceRows !== table.targetRows ||
        table.sourceSha256 !== table.targetSha256 ||
        !digest.test(table.sourceSha256) ||
        !digest.test(table.targetSha256),
    ) ||
    !digest.test(value.equivalence.sequencesSha256) ||
    !digest.test(value.equivalence.constraintsSha256) ||
    !digest.test(value.equivalence.indexesSha256) ||
    !digest.test(value.equivalence.migrationHistorySha256) ||
    value.aclGateBeforeActivation !== "closed" ||
    value.activation.firstWriteBoundary !== true ||
    value.activation.step !== "activate_target_generation" ||
    value.activation.sourceSystemIdentifier !== value.source.systemIdentifier ||
    value.activation.targetSystemIdentifier !== value.target.systemIdentifier ||
    value.cleanup.renderJobTerminal !== true ||
    value.cleanup.workspaceRemoved !== true ||
    value.cleanup.bootstrapCredentialsAbsent !== true ||
    !timestamp.test(value.cleanup.observedAt)
  )
    throw new Error("trusted_rollout_evidence_invariant_failed");
  const { evidenceSha256, ...unsigned } = value;
  if (
    !digest.test(evidenceSha256) ||
    evidenceSha256 !== `sha256:${sha256Canonical(withoutDigest(unsigned))}`
  )
    throw new Error("trusted_rollout_evidence_digest_mismatch");
  if (canonicalJson(value).includes("postgresql://"))
    throw new Error("trusted_rollout_evidence_contains_secret_url");
  return value;
}
