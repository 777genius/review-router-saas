import type {
  AuthoritativeGenerationLedger,
  DatabaseGenerationIdentity,
  ReleaseRollout,
  RunnerIdentity,
  StepObservation,
} from "../domain/release-rollout";

export interface ProviderControlPort {
  freezeAndObserve(): Promise<StepObservation>;
  compensateAndObserve(): Promise<StepObservation>;
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
  activate(
    source: DatabaseGenerationIdentity,
    target: DatabaseGenerationIdentity,
  ): Promise<StepObservation>;
  compensateSource(
    source: DatabaseGenerationIdentity,
  ): Promise<StepObservation>;
}

export interface TargetServicesPort {
  stageTarget(): Promise<StepObservation>;
  resumeDeployAndObserve(): Promise<StepObservation>;
  verifyLiveCanary(): Promise<StepObservation>;
}

export interface TrustedEvidencePort {
  assembleAndVerify(rollout: ReleaseRollout): Promise<StepObservation>;
}

export type RolloutLedgerPort = AuthoritativeGenerationLedger;
