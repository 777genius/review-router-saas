import type {
  AuthoritativeGenerationLedger,
  DatabaseGenerationIdentity,
  ReleaseRollout,
  RunnerIdentity,
  StepObservation,
  TargetSwitchFence,
} from "../domain/release-rollout";

export interface ProviderControlPort {
  freezeAndObserve(): Promise<StepObservation>;
  compensateAndObserve(input: {
    decision: ProviderAuthorityDecision;
    databaseWitness: DatabaseAclWitness;
  }): Promise<ProviderStateWitness>;
}

export const ProviderAuthorityOperation = Object.freeze({
  DeployTarget: "deploy_target",
  ResumeTarget: "resume_target",
  ResumeSource: "resume_source",
} as const);
export type ProviderAuthorityOperation =
  (typeof ProviderAuthorityOperation)[keyof typeof ProviderAuthorityOperation];
export interface ProviderAuthorityRequest {
  readonly rolloutId: string;
  readonly operation: ProviderAuthorityOperation;
  readonly sourceSystemIdentifier: string;
  readonly targetSystemIdentifier: string;
  readonly expectedReceiptSha256: string;
  readonly activationBoundary: "before" | "activated";
}
export interface ProviderAuthorityDecision extends ProviderAuthorityRequest {
  readonly decision: "allow";
  readonly decisionId: string;
  readonly decidedAt: string;
}
export interface ProviderAuthorityDecisionPort {
  decide(input: ProviderAuthorityRequest): Promise<ProviderAuthorityDecision>;
}
export interface CompensationCheckpoint {
  readonly activationBoundary: "before" | "uncertain" | "activated";
  readonly state:
    | "pre_activation"
    | "compensating"
    | "compensated"
    | "activation_authorized"
    | "activated"
    | "outcome_unknown"
    | "forward_repair_required";
  readonly lastReceiptSha256: string;
  readonly lastStep: string | null;
  readonly receiptCount: number;
}
export interface DatabaseAclWitness {
  readonly systemIdentifier: string;
  readonly aclSha256: string;
  readonly observedAt: string;
  readonly sourceWritesRestored: true;
}
export interface ProviderStateWitness {
  readonly serviceIds: readonly string[];
  readonly deployIds: readonly string[];
  readonly observedAt: string;
  readonly resumed: true;
}

export interface ReleasePreflightPort {
  observeProtectedEnvironment(): Promise<StepObservation>;
}

export interface PrivateRunnerPort {
  provision(): Promise<{
    identity: RunnerIdentity;
    observation: StepObservation;
  }>;
  cleanup(identity: RunnerIdentity): Promise<StepObservation>;
  reconcileOrphans(rolloutId: string): Promise<readonly StepObservation[]>;
}

export interface DatabaseRolloutPort {
  captureBackup(source: DatabaseGenerationIdentity): Promise<StepObservation>;
  quiesce(source: DatabaseGenerationIdentity): Promise<StepObservation>;
  copy(
    source: DatabaseGenerationIdentity,
    target: DatabaseGenerationIdentity,
  ): Promise<StepObservation>;
  verifyEquivalence(
    source: DatabaseGenerationIdentity,
    target: DatabaseGenerationIdentity,
  ): Promise<StepObservation>;
  bootstrapTargetRoles(
    target: DatabaseGenerationIdentity,
  ): Promise<StepObservation>;
  runReleaseMigration(
    target: DatabaseGenerationIdentity,
  ): Promise<StepObservation>;
  activate(rolloutId: string): Promise<StepObservation>;
  compensateSource(
    source: DatabaseGenerationIdentity,
  ): Promise<DatabaseAclWitness>;
}

export interface TargetServicesPort {
  stageTarget(
    fence: TargetSwitchFence,
    decision: ProviderAuthorityDecision,
  ): Promise<StepObservation>;
  resumeDeployAndObserve(
    decision: ProviderAuthorityDecision,
  ): Promise<StepObservation>;
  verifyLiveCanary(): Promise<StepObservation>;
}

export interface TrustedEvidencePort {
  assembleAndVerify(rollout: ReleaseRollout): Promise<StepObservation>;
}

export type RolloutLedgerPort = AuthoritativeGenerationLedger;
