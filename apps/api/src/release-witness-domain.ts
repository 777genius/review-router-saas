export type CleanupObservationSeed = Readonly<{
  jobId: string;
  serviceId: string;
  cleanupCanary: string;
  observedAt: string;
  providerCreationNotBefore: string;
}>;

export type ProviderTerminalStatus = "succeeded" | "failed" | "canceled";

export type NormalizedCleanupEvidence = Readonly<{
  jobId: string;
  canary: string;
  providerStatus: ProviderTerminalStatus;
  containerTerminated: true;
  logSha256: string;
  removedPaths: readonly string[];
  remainingPaths: readonly [];
  providerLogId: string;
  providerCreatedAt: string;
  providerObservedAt: string;
}>;

export interface CleanupObservationSeedPort {
  load(jobId: string): Promise<CleanupObservationSeed>;
}

export interface CleanupEvidencePort {
  persist(jobId: string, evidence: NormalizedCleanupEvidence): Promise<void>;
}

export interface RenderCleanupObservationPort {
  observe(seed: CleanupObservationSeed): Promise<NormalizedCleanupEvidence>;
}

/** Application-facing authority fence; infrastructure owns how readiness is observed. */
export interface ReleaseAuthorityMutationReadinessPort {
  assertReady(): Promise<void>;
}

import {
  runtimeDatabaseIdentityIsCanonical,
  type RuntimeDatabaseIdentity,
} from "./release-authority/domain/database-identity.js";

export type ReleaseWitnessGeneration = Readonly<{
  renderResourceId: string;
  databaseName: string;
  systemIdentifier: string;
  majorVersion: 16 | 17;
  recoveryWitnessSha256: string;
}>;

export type ReleaseWitnessExecution = Readonly<{
  repository: string;
  workflowPath: string;
  workflowRef: string;
  commitSha: string;
  runId: string;
  runAttempt: number;
}>;

export type ReleaseWitnessDeployment = Readonly<{
  serviceId: string;
  deployId: string;
  revision: string;
}>;

/** Caller supplies only selectors. Every fact is independently re-observed. */
export type ReleaseWitnessRequest = Readonly<{
  rolloutId: string;
  execution: ReleaseWitnessExecution;
  source: ReleaseWitnessGeneration;
  target: ReleaseWitnessGeneration;
  deployments: readonly ReleaseWitnessDeployment[];
}>;

export type ReleaseWitnessDatabaseObservation = Readonly<{
  roleName: string;
  databaseIdentity: RuntimeDatabaseIdentity;
  systemIdentifier: string;
  postgresMajor: number;
  schemaVersion: number;
  migrationManifestIdentity: string;
  catalogFingerprint: string;
  catalogVerifier: string;
  activationMigrationManifestIdentity: string;
  activationNamespaceFingerprint: string;
  installerRoutineBodySha256: string;
  readerRoutineBodySha256: string;
  exact: boolean;
}>;

export type ReleaseWitnessGenerationObservation = Readonly<{
  roleName: string;
  databaseIdentity: RuntimeDatabaseIdentity;
  systemIdentifier: string;
  postgresMajor: number;
}>;

export type ReleaseWitnessAttestation = Readonly<{
  schemaVersion: 1;
  rolloutId: string;
  execution: ReleaseWitnessExecution;
  sourceDatabaseIdentity: RuntimeDatabaseIdentity;
  authorityDatabaseIdentity: RuntimeDatabaseIdentity;
  targetDatabaseIdentity: RuntimeDatabaseIdentity;
  releaseAuthority: Readonly<{
    schemaVersion: number;
    migrationManifestIdentity: string;
    catalogFingerprint: string;
    catalogVerifier: string;
  }>;
  activation: Readonly<{
    migrationManifestIdentity: string;
    namespaceFingerprint: string;
    installerRoutineBodySha256: string;
    readerRoutineBodySha256: string;
  }>;
  source: ReleaseWitnessGeneration;
  target: ReleaseWitnessGeneration;
  deployments: readonly ReleaseWitnessDeployment[];
  observedAt: string;
  expiresAt: string;
  bindingSha256: string;
  signature: Readonly<{
    algorithm: "Ed25519";
    keyId: string;
    value: string;
  }>;
}>;

export interface ReleaseWitnessDatabasePort {
  observeSource(): Promise<ReleaseWitnessGenerationObservation>;
  observeAuthority(): Promise<ReleaseWitnessDatabaseObservation>;
  observeTarget(): Promise<ReleaseWitnessDatabaseObservation>;
}

export interface ReleaseWitnessExecutionPort {
  observe(
    expected: ReleaseWitnessExecution,
    rolloutId: string,
  ): Promise<ReleaseWitnessExecution>;
}

export interface ReleaseWitnessDeploymentPort {
  observe(
    expected: readonly ReleaseWitnessDeployment[],
  ): Promise<readonly ReleaseWitnessDeployment[]>;
}

export interface ReleaseWitnessGenerationPort {
  observe(
    source: ReleaseWitnessGeneration,
    target: ReleaseWitnessGeneration,
  ): Promise<readonly [ReleaseWitnessGeneration, ReleaseWitnessGeneration]>;
}

export interface ReleaseWitnessSignerPort {
  sign(bindingSha256: string): Readonly<{
    algorithm: "Ed25519";
    keyId: string;
    value: string;
  }>;
}

export type TrustedReleaseWitnessPolicy = Readonly<{
  repository: string;
  workflowPath: string;
  sourceDatabaseIdentity: RuntimeDatabaseIdentity;
  authorityDatabaseIdentity: RuntimeDatabaseIdentity;
  targetDatabaseIdentity: RuntimeDatabaseIdentity;
  sourceGeneration: ReleaseWitnessGeneration;
  targetGeneration: ReleaseWitnessGeneration;
  authorityCatalogFingerprint: string;
  authorityCatalogVerifier: string;
  authorityMigrationManifestIdentity: string;
  activationMigrationManifestIdentity: string;
  activationNamespaceFingerprint: string;
  installerRoutineBodySha256: string;
  readerRoutineBodySha256: string;
  maximumAgeMilliseconds: number;
}>;

const sha256 = /^[a-f0-9]{64}$/u;
const sha256Prefixed = /^sha256:[a-f0-9]{64}$/u;
const commitSha = /^[a-f0-9]{40}$/u;
const opaque = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/u;

export function releaseWitnessRequestIsCanonical(
  value: ReleaseWitnessRequest,
): boolean {
  return (
    !!value &&
    Object.keys(value).length === 5 &&
    opaque.test(value.rolloutId) &&
    Object.keys(value.execution ?? {}).length === 6 &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.execution.repository) &&
    /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(
      value.execution.workflowPath,
    ) &&
    /^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(
      value.execution.workflowRef,
    ) &&
    commitSha.test(value.execution.commitSha) &&
    /^[1-9][0-9]*$/u.test(value.execution.runId) &&
    Number.isSafeInteger(value.execution.runAttempt) &&
    value.execution.runAttempt > 0 &&
    generationIsCanonical(value.source, 16) &&
    generationIsCanonical(value.target, 17) &&
    value.source.systemIdentifier !== value.target.systemIdentifier &&
    Array.isArray(value.deployments) &&
    value.deployments.length > 0 &&
    new Set(value.deployments.map((item) => item.serviceId)).size ===
      value.deployments.length &&
    value.deployments.every(
      (item) =>
        Object.keys(item).length === 3 &&
        opaque.test(item.serviceId) &&
        opaque.test(item.deployId) &&
        (commitSha.test(item.revision) ||
          /^sha256:[a-f0-9]{64}$/u.test(item.revision)),
    )
  );
}

const generationIsCanonical = (
  value: ReleaseWitnessGeneration,
  expectedMajor: 16 | 17,
): boolean =>
  !!value &&
  Object.keys(value).length === 5 &&
  opaque.test(value.renderResourceId) &&
  opaque.test(value.databaseName) &&
  /^[0-9]{1,64}$/u.test(value.systemIdentifier) &&
  value.majorVersion === expectedMajor &&
  sha256.test(value.recoveryWitnessSha256);

export function releaseWitnessPolicyIsCanonical(
  value: TrustedReleaseWitnessPolicy,
): boolean {
  return (
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository) &&
    /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(value.workflowPath) &&
    runtimeDatabaseIdentityIsCanonical(value.sourceDatabaseIdentity) &&
    runtimeDatabaseIdentityIsCanonical(value.authorityDatabaseIdentity) &&
    runtimeDatabaseIdentityIsCanonical(value.targetDatabaseIdentity) &&
    value.sourceDatabaseIdentity.serverIdentity !==
      value.targetDatabaseIdentity.serverIdentity &&
    value.sourceDatabaseIdentity.serverIdentity !==
      value.authorityDatabaseIdentity.serverIdentity &&
    value.authorityDatabaseIdentity.serverIdentity !==
      value.targetDatabaseIdentity.serverIdentity &&
    generationIsCanonical(value.sourceGeneration, 16) &&
    generationIsCanonical(value.targetGeneration, 17) &&
    value.sourceGeneration.systemIdentifier ===
      value.sourceDatabaseIdentity.serverIdentity &&
    value.targetGeneration.systemIdentifier ===
      value.targetDatabaseIdentity.serverIdentity &&
    sha256Prefixed.test(value.authorityCatalogFingerprint) &&
    sha256Prefixed.test(value.authorityMigrationManifestIdentity) &&
    sha256Prefixed.test(value.activationMigrationManifestIdentity) &&
    sha256Prefixed.test(value.activationNamespaceFingerprint) &&
    sha256.test(value.installerRoutineBodySha256) &&
    sha256.test(value.readerRoutineBodySha256) &&
    Number.isSafeInteger(value.maximumAgeMilliseconds) &&
    value.maximumAgeMilliseconds > 0
  );
}

const instant = (value: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error("release_witness_timestamp_invalid");
  return parsed;
};

/**
 * Domain temporal contract: the authority's pre-dispatch boundary is the
 * lower bound for provider creation. The later durable observation is only an
 * ordering assertion and never replaces that lower bound.
 */
export function assertCleanupProviderTemporalContract(input: {
  seed: CleanupObservationSeed;
  providerCreatedAt: string;
  providerFinishedAt: string;
}): Readonly<{ createdAt: number; finishedAt: number }> {
  const notBefore = instant(input.seed.providerCreationNotBefore);
  const persistedObservation = instant(input.seed.observedAt);
  const createdAt = instant(input.providerCreatedAt);
  const finishedAt = instant(input.providerFinishedAt);
  if (
    persistedObservation < notBefore ||
    createdAt < notBefore ||
    finishedAt < createdAt
  )
    throw new Error("release_witness_terminal_window_invalid");
  return Object.freeze({ createdAt, finishedAt });
}
