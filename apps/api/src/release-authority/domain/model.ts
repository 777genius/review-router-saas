import type {
  ActivationAuthorization,
  ActivationReceipt,
  ExternalEffectControlReconciliation,
  ExternalEffectRecord,
  RunnerProvisioningIntentRecord,
  ProviderAuthorityDecision,
  ProviderAuthorityRequest,
  ProviderCreationBoundary,
  RunnerIdentity,
  StepObservation,
  TargetSwitchFence,
} from "@reviewrouter/features-release-rollout";
import type {
  ServiceTransitionCheckpoint,
  ServiceTransitionLedger,
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
export type ProvisioningIntent = RunnerProvisioningIntentRecord;
export type CreateProvisioningIntent = Omit<
  ProvisioningIntent,
  "creationLeaseOwner" | "creationLeaseExpiresAt" | "effect"
> & { creationLeaseOwner: string };
export type PersistedJob = ProviderCreationBoundary & {
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
export type ProviderJobStatus = "succeeded" | "failed" | "canceled";
export type PersistedProviderCleanupWitness = Readonly<{
  jobId: string;
  canary: string;
  providerStatus: ProviderJobStatus;
  containerTerminated: true;
  logSha256: string;
  removedPaths: readonly string[];
  remainingPaths: readonly [];
  providerLogId: string;
  providerCreatedAt: string;
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
export type WitnessGatedTerminalCleanupFact = Readonly<{
  jobId: string;
  lifecycle: "role" | "cutover";
  canary: string;
  terminalAt: string;
  observation: StepObservation;
  witness: IndependentCleanupWitness;
}>;
export type ReleaseCompensationCheckpoint = Readonly<{
  activationBoundary: "before" | "uncertain" | "activated";
  state: ReleaseAuthorityState;
  lastReceiptSha256: string;
  lastStep: string | null;
  receiptCount: number;
  sourceFreeze: Readonly<{
    status: "none" | "partial" | "complete" | "unknown";
    serviceIds: readonly string[];
    services: readonly Readonly<{
      serviceId: string;
      latestSuccessfulDeployId: string;
      observedAt: string;
    }>[];
  }>;
}>;
export type RecordSourceFreezeMutation = RolloutBinding & {
  serviceId: string;
  latestSuccessfulDeployId: string;
  observedAt: string;
  declaredServiceIds: readonly string[];
};
export type PrepareSourceFreezeMutation = RecordSourceFreezeMutation & {
  beforeSuspended: boolean;
};

export interface ReleaseAuthorityLedgerPort {
  completeSourceFreeze(
    input: RolloutBinding & {
      declaredServiceIds: readonly string[];
      observedAt: string;
    },
  ): Promise<"recorded" | "existing">;
  prepareSourceFreezeMutation(
    input: PrepareSourceFreezeMutation,
  ): Promise<boolean>;
  recordSourceFreezeMutation(
    input: RecordSourceFreezeMutation,
  ): Promise<"recorded" | "existing">;
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
  compensationCheckpoint(
    input: Pick<
      RolloutBinding,
      "rolloutId" | "sourceSystemIdentifier" | "targetSystemIdentifier"
    >,
  ): Promise<ReleaseCompensationCheckpoint>;
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

export interface ReleaseServiceTransitionLedgerPort extends ServiceTransitionLedger {
  append(
    checkpoint: Omit<ServiceTransitionCheckpoint, "sequence">,
  ): Promise<ServiceTransitionCheckpoint>;
}

export interface ActivationPermitInstallerPort {
  install(
    authorization: ActivationAuthorization,
  ): Promise<"installed" | "existing">;
}

export type TargetActivationFacts = Readonly<
  Pick<
    ActivationReceipt,
    | "rolloutId"
    | "expectedCommitSha"
    | "sourceSystemIdentifier"
    | "targetSystemIdentifier"
    | "canonicalPrivilegesSha256"
    | "catalogFactsSha256"
    | "transactionId"
    | "firstWriteReceiptSha256"
    | "firstWriteBoundary"
    | "postgresMajor"
    | "migrationChecksum"
    | "permitEpoch"
    | "permitNonce"
    | "targetDeployIds"
  > & {
    readonly activatedAt: string;
    readonly activationObservationSha256: string;
  }
>;

export type TargetActivationAbsenceProof = Readonly<{
  receiptAbsent: true;
  permitAbsent: true;
}>;

export interface TargetActivationReceiptReaderPort {
  read(
    rolloutId: string,
  ): Promise<TargetActivationFacts | TargetActivationAbsenceProof | null>;
}

export interface RunnerOperationsLedgerPort {
  persistProvisioningIntent(
    input: CreateProvisioningIntent,
  ): Promise<ExternalEffectRecord>;
  listIntents(rolloutId: string): Promise<readonly ProvisioningIntent[]>;
  acquireProviderDispatchPermit(input: {
    intentId: string;
    claimantId: string;
    startCommandSha256: string;
    expectedEpoch: number;
    leaseSeconds: number;
  }): Promise<ExternalEffectRecord>;
  abandonPreparedEffect(input: {
    intentId: string;
    claimantId: string;
    expectedEpoch: number;
  }): Promise<ExternalEffectRecord>;
  reconcileProvisioningEffect(input: {
    intentId: string;
    claimantId: string;
    expectedEpoch: number;
    jobId?: string;
    reconciliation: ExternalEffectControlReconciliation;
    observation?: StepObservation;
  }): Promise<ExternalEffectRecord>;
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
  terminalCleanupFact(
    rolloutId: string,
    lifecycle: "role" | "cutover",
  ): Promise<WitnessGatedTerminalCleanupFact>;
  persistRegistration(input: PersistRunnerRegistrationInput): Promise<void>;
}

export interface RunnerCleanupWitnessPort {
  persistProviderWitness(
    jobId: string,
    witness: PersistedProviderCleanupWitness,
  ): Promise<void>;
}

export interface ReleaseRolloutReconciliationPort {
  context(rolloutId: string): Promise<ReleaseRolloutReconciliationContext>;
  reconcile(
    input: ReleaseRolloutReconciliationInput,
  ): Promise<Record<string, unknown>>;
}

export type ReleaseRolloutReconciliationContext = Readonly<{
  rolloutId: string;
  runId: string;
  runAttempt: number;
  state: ReleaseAuthorityState;
  activationBoundary: "before" | "uncertain" | "activated";
  receiptOrdinal: number;
  authorization: ActivationAuthorization | null;
}>;

export type ReleaseRolloutReconciliationInput = Readonly<{
  rolloutId: string;
  targetObservation:
    | Readonly<{
        kind: "matching_activation_receipt";
        authorization: ActivationAuthorization;
        nextReceiptSha256: string;
        activationReceipt: ActivationReceipt;
      }>
    | Readonly<{
        kind:
          | "activation_absent_without_revocation"
          | "target_read_unavailable"
          | "target_receipt_absent"
          | "target_receipt_conflict"
          | "not_required";
      }>;
}>;
