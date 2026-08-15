import type {
  AuthoritativeGenerationLedger,
  DatabaseGenerationIdentity,
  ReleaseRollout,
  RunnerIdentity,
  StepObservation,
  TargetSwitchFence,
} from "../domain/release-rollout";
import type {
  ReleaseMigrationObservation,
  ReleaseMigrationPermit,
  ReleaseMigrationTransitionV1,
} from "../domain/release-migration-transition";
import type { LegacyAmbiguityEvidence } from "../domain/trusted-rollout-evidence";

export interface ProviderControlPort {
  freezeAndObserve(): Promise<StepObservation>;
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
  readonly sourceFreeze: SourceFreezeEvidence;
}
export interface SourceFreezeServiceEvidence {
  readonly serviceId: string;
  readonly latestSuccessfulDeployId: string;
  readonly observedAt: string;
}
export interface SourceFreezeEvidence {
  readonly status: "none" | "partial" | "complete" | "unknown";
  readonly serviceIds: readonly string[];
  readonly services: readonly SourceFreezeServiceEvidence[];
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
    transition: ReleaseMigrationTransitionV1,
    permit: ReleaseMigrationPermit,
    sourceLegacyAmbiguity: LegacyAmbiguityEvidence,
  ): Promise<
    StepObservation<ReleaseMigrationObservation & Record<string, unknown>>
  >;
  activate(rolloutId: string): Promise<StepObservation>;
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
