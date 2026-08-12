import type {
  ActivationAuthorization,
  ActivationReceipt,
  ProviderAuthorityDecision,
  ProviderAuthorityRequest,
  RunnerIdentity,
  StepObservation,
  TargetSwitchFence,
} from "@reviewrouter/features-release-rollout";

export const ReleaseAuthorityState = Object.freeze({
  PreActivation: "pre_activation",
  Compensating: "compensating",
  Compensated: "compensated",
  ActivationAuthorized: "activation_authorized",
  Activated: "activated",
  OutcomeUnknown: "outcome_unknown",
  ForwardRepairRequired: "forward_repair_required",
} as const);

export type ReleaseAuthorityState =
  (typeof ReleaseAuthorityState)[keyof typeof ReleaseAuthorityState];

export type RolloutBinding = {
  rolloutId: string;
  expectedCommitSha: string;
  runId: string;
  runAttempt: number;
  sourceSystemIdentifier: string;
  targetSystemIdentifier: string;
};
export type ProvisioningIntent = {
  id: string;
  rolloutId: string;
  serviceId: string;
  lifecycle: "role" | "cutover";
  workflowJobId: string;
  runnerName: string;
  createdAt: string;
};
export type PersistedJob = {
  rolloutId: string;
  serviceId: string;
  jobId: string;
  observedAt: string;
  cleanupCanary: string;
  lifecycle: "role" | "cutover";
  provisioningIntentId: string;
};
export type PersistedRunnerRegistration = Readonly<{
  runnerId: number;
  runnerGroupId: number;
  labels: readonly string[];
  uniqueLabel: string;
  workFolder: string;
}>;
export type PersistRunnerRegistrationInput = Readonly<{
  rolloutId: string;
  lifecycle: "role" | "cutover";
  workflowJobId: string;
  registration: PersistedRunnerRegistration;
}>;
export type ProviderJobStatus = "succeeded";
export type PersistedProviderCleanupWitness = Readonly<{
  jobId: string;
  canary: string;
  providerStatus: ProviderJobStatus;
  containerTerminated: true;
  logSha256: string;
  removedPaths: readonly string[];
  remainingPaths: readonly [];
  providerLogId: string;
  providerObservedAt: string;
}>;
export type IndependentCleanupWitness = Readonly<{
  providerStatus: ProviderJobStatus;
  listenerStopped: true;
  workspaceRemoved: true;
  credentialProcessGone: true;
  canary: string;
  observedAt: string;
  providerLogSha256: string;
  removedPaths: readonly string[];
  remainingPaths: readonly [];
}>;

export interface ReleaseAuthorityLedgerPort {
  claim(input: RolloutBinding): Promise<"claimed" | "duplicate">;
  compareAndSet(
    input: RolloutBinding & {
      step: string;
      provider?: unknown;
      expectedReceiptSha256: string;
      nextReceiptSha256: string;
      authoritativeSystemIdentifier: string;
      expectedActivationBoundary: "before" | "activated" | "uncertain";
      nextActivationBoundary: "before" | "activated" | "uncertain";
    },
  ): Promise<boolean>;
  markActivationUncertain(input: RolloutBinding): Promise<boolean>;
  fenceTargetSwitch(
    input: RolloutBinding & {
      previousReceiptSha256: string;
    },
  ): Promise<TargetSwitchFence | null>;
  authorizeActivation(
    input: RolloutBinding & {
      jobId: string;
      previousReceiptSha256: string;
      targetDeployIds: readonly string[];
      postgresMajor: 17;
      migrationChecksum: string;
    },
  ): Promise<ActivationAuthorization>;
  finalizeActivation(input: {
    authorization: ActivationAuthorization;
    provider?: unknown;
    nextReceiptSha256: string;
    activationReceipt: ActivationReceipt;
  }): Promise<boolean>;
  activationState(
    input: Pick<
      RolloutBinding,
      "rolloutId" | "sourceSystemIdentifier" | "targetSystemIdentifier"
    >,
  ): Promise<"before" | "uncertain" | "activated">;
  authorityState(
    input: Pick<
      RolloutBinding,
      "rolloutId" | "sourceSystemIdentifier" | "targetSystemIdentifier"
    >,
  ): Promise<ReleaseAuthorityState>;
  verifyFinalAuthority(
    input: RolloutBinding & {
      expectedReceiptSha256: string;
      activationReceipt: ActivationReceipt;
    },
  ): Promise<boolean>;
  decideProviderOperation(
    input: ProviderAuthorityRequest,
  ): Promise<ProviderAuthorityDecision>;
}

export interface ActivationPermitInstallerPort {
  install(
    authorization: ActivationAuthorization,
  ): Promise<"installed" | "existing">;
}

export interface RunnerOperationsLedgerPort {
  persistIntent(input: ProvisioningIntent): Promise<"created" | "existing">;
  listIntents(rolloutId: string): Promise<readonly ProvisioningIntent[]>;
  recordIntentOutcome(input: {
    intentId: string;
    jobId: string;
    outcome:
      | "bound"
      | "persistence_failed_cleaned"
      | "persistence_failed_unknown";
    observation?: StepObservation;
  }): Promise<void>;
  persistJob(input: PersistedJob): Promise<void>;
  listOpenJobs(rolloutId: string): Promise<readonly PersistedJob[]>;
  persistIdentity(
    jobId: string,
    identity: RunnerIdentity,
    observation: StepObservation,
  ): Promise<void>;
  currentRunner(
    rolloutId: string,
    lifecycle: "role" | "cutover",
  ): Promise<{ identity: RunnerIdentity; observation: StepObservation }>;
  markTerminal(jobId: string, observation: StepObservation): Promise<void>;
  cleanupObservation(jobId: string): Promise<StepObservation>;
  cleanupWitness(jobId: string): Promise<IndependentCleanupWitness>;
  persistRegistration(input: PersistRunnerRegistrationInput): Promise<void>;
}

export interface RunnerCleanupWitnessPort {
  persistProviderWitness(
    jobId: string,
    witness: PersistedProviderCleanupWitness,
  ): Promise<void>;
}

export interface ReleaseRolloutReconciliationPort {
  reconcile(rolloutId: string): Promise<Record<string, unknown>>;
}
