import {
  applyStepReceipt,
  assertRunnerIdentity,
  RolloutStep,
  type ReleaseRollout,
  type RunnerIdentity,
  type StepReceipt,
} from "../domain/release-rollout";
import type {
  DatabaseRolloutPort,
  PrivateRunnerPort,
  ProviderFreezePort,
  ServiceStagingPort,
  TrustedEvidencePort,
} from "./ports";

function accept(
  rollout: ReleaseRollout,
  receipt: StepReceipt,
  expected: string,
): ReleaseRollout {
  if (receipt.step !== expected)
    throw new Error("adapter_receipt_step_mismatch");
  return applyStepReceipt(rollout, receipt);
}

export class ReleaseRolloutUseCases {
  constructor(
    private readonly ports: {
      provider: ProviderFreezePort;
      runner: PrivateRunnerPort;
      database: DatabaseRolloutPort;
      services: ServiceStagingPort;
      evidence: TrustedEvidencePort;
    },
  ) {}
  async freezeProviderServices(r: ReleaseRollout) {
    return accept(
      r,
      await this.ports.provider.freezeAndObserve(),
      RolloutStep.FreezeProviderServices,
    );
  }
  async provisionPrivateRunner(
    r: ReleaseRollout,
    expected: Parameters<typeof assertRunnerIdentity>[1],
  ) {
    const result = await this.ports.runner.provision();
    assertRunnerIdentity(result.identity, expected);
    return {
      rollout: accept(r, result.receipt, RolloutStep.ProvisionPrivateRunner),
      runner: result.identity,
    };
  }
  async captureSourceBackup(r: ReleaseRollout) {
    return accept(
      r,
      await this.ports.database.captureBackup(r.source),
      RolloutStep.CaptureSourceBackup,
    );
  }
  async quiesceSource(r: ReleaseRollout) {
    return accept(
      r,
      await this.ports.database.quiesce(r.source),
      RolloutStep.QuiesceSource,
    );
  }
  async copyDatabaseGeneration(r: ReleaseRollout) {
    return accept(
      r,
      await this.ports.database.copy(r.source, r.target),
      RolloutStep.CopyDatabaseGeneration,
    );
  }
  async verifyDataEquivalence(r: ReleaseRollout) {
    return accept(
      r,
      await this.ports.database.verifyEquivalence(r.source, r.target),
      RolloutStep.VerifyDataEquivalence,
    );
  }
  async bootstrapTargetRoles(r: ReleaseRollout) {
    return accept(
      r,
      await this.ports.database.bootstrapTargetRoles(r.target),
      RolloutStep.BootstrapTargetRoles,
    );
  }
  async runReleaseMigration(r: ReleaseRollout) {
    return accept(
      r,
      await this.ports.database.runReleaseMigration(r.target),
      RolloutStep.RunReleaseMigration,
    );
  }
  async stageTargetServices(r: ReleaseRollout) {
    return accept(
      r,
      await this.ports.services.stageTarget(),
      RolloutStep.StageTargetServices,
    );
  }
  async activateTargetGeneration(r: ReleaseRollout) {
    return accept(
      r,
      await this.ports.database.activate(r.source, r.target),
      RolloutStep.ActivateTargetGeneration,
    );
  }
  async verifyTrustedRollout(r: ReleaseRollout) {
    return accept(
      r,
      await this.ports.evidence.verify(),
      RolloutStep.VerifyTrustedRollout,
    );
  }
  async cleanupEphemeralRunner(r: ReleaseRollout, identity: RunnerIdentity) {
    return accept(
      r,
      await this.ports.runner.cleanup(identity),
      RolloutStep.CleanupEphemeralRunner,
    );
  }
}
