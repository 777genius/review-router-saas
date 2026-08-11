import type {
  ActivationReceipt,
  DatabaseGenerationIdentity,
  RunnerIdentity,
  StepReceipt,
} from "../domain/release-rollout";

export interface ProviderFreezePort {
  freezeAndObserve(): Promise<StepReceipt>;
}
export interface PrivateRunnerPort {
  provision(): Promise<{ identity: RunnerIdentity; receipt: StepReceipt }>;
  cleanup(identity: RunnerIdentity): Promise<StepReceipt>;
}
export interface DatabaseRolloutPort {
  captureBackup(source: DatabaseGenerationIdentity): Promise<StepReceipt>;
  quiesce(source: DatabaseGenerationIdentity): Promise<StepReceipt>;
  copy(
    source: DatabaseGenerationIdentity,
    target: DatabaseGenerationIdentity,
  ): Promise<StepReceipt>;
  verifyEquivalence(
    source: DatabaseGenerationIdentity,
    target: DatabaseGenerationIdentity,
  ): Promise<StepReceipt>;
  bootstrapTargetRoles(
    target: DatabaseGenerationIdentity,
  ): Promise<StepReceipt>;
  runReleaseMigration(target: DatabaseGenerationIdentity): Promise<StepReceipt>;
  activate(
    source: DatabaseGenerationIdentity,
    target: DatabaseGenerationIdentity,
  ): Promise<ActivationReceipt>;
}
export interface ServiceStagingPort {
  stageTarget(): Promise<StepReceipt>;
}
export interface TrustedEvidencePort {
  verify(): Promise<StepReceipt>;
}
