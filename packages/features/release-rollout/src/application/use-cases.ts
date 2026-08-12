import {
  assertRunnerIdentity,
  beginCompensation,
  completeCompensation,
  RolloutStep,
  transitionFailure,
  transitionFromObservation,
  type ReleaseRollout,
  type RunnerIdentity,
  type StepObservation,
} from "../domain/release-rollout";
import type {
  DatabaseRolloutPort,
  PrivateRunnerPort,
  ProviderControlPort,
  RolloutLedgerPort,
  TargetServicesPort,
  TrustedEvidencePort,
} from "./ports";

export class ReleaseRolloutUseCases {
  constructor(
    private readonly ports: {
      provider: ProviderControlPort;
      runner: PrivateRunnerPort;
      database: DatabaseRolloutPort;
      services: TargetServicesPort;
      evidence: TrustedEvidencePort;
      ledger: RolloutLedgerPort;
    },
  ) {}

  private async accept(
    r: ReleaseRollout,
    observation: StepObservation,
    step: string,
  ): Promise<ReleaseRollout> {
    if (observation.step !== step)
      throw new Error("adapter_observation_step_mismatch");
    const next = transitionFromObservation(r, observation);
    const activated = next.sourcePermanentlyIneligible;
    const changed = await this.ports.ledger.compareAndSet({
      rolloutId: r.rolloutId,
      expectedReceiptSha256:
        r.receipts.at(-1)?.receiptSha256 ?? `sha256:${"0".repeat(64)}`,
      nextReceiptSha256: next.receipts.at(-1)!.receiptSha256,
      authoritativeSystemIdentifier: activated
        ? r.target.systemIdentifier
        : r.source.systemIdentifier,
      activationBoundary: activated ? "activated" : "before",
    });
    if (!changed)
      throw new Error(
        step === RolloutStep.ActivateTargetGeneration
          ? "authoritative_generation_cas_failed_activation_uncertain"
          : "rollout_receipt_ledger_cas_failed",
      );
    return next;
  }

  async claimRollout(r: ReleaseRollout): Promise<ReleaseRollout> {
    const claimed = await this.ports.ledger.claim({
      rolloutId: r.rolloutId,
      expectedCommitSha: r.expectedCommitSha,
      runId: r.execution.runId,
      runAttempt: r.execution.runAttempt,
      sourceSystemIdentifier: r.source.systemIdentifier,
      targetSystemIdentifier: r.target.systemIdentifier,
    });
    if (claimed !== "claimed") throw new Error("rollout_id_already_claimed");
    return await this.accept(
      r,
      {
        step: RolloutStep.ClaimRollout,
        observedAt: new Date().toISOString(),
        facts: { durableClaim: true },
      },
      RolloutStep.ClaimRollout,
    );
  }
  async freezeProviderServices(r: ReleaseRollout) {
    return await this.accept(
      r,
      await this.ports.provider.freezeAndObserve(),
      RolloutStep.FreezeProviderServices,
    );
  }
  private async provisionRunner(
    r: ReleaseRollout,
    step:
      | typeof RolloutStep.ProvisionRoleRunner
      | typeof RolloutStep.ProvisionCutoverRunner,
  ) {
    const result = await this.ports.runner.provision();
    assertRunnerIdentity(result.identity, r);
    return {
      rollout: await this.accept(r, result.observation, step),
      runner: result.identity,
    };
  }
  async provisionPrivateRunner(r: ReleaseRollout) {
    return await this.provisionRunner(r, RolloutStep.ProvisionRoleRunner);
  }
  async provisionCutoverRunner(r: ReleaseRollout) {
    return await this.provisionRunner(r, RolloutStep.ProvisionCutoverRunner);
  }
  async captureSourceBackup(r: ReleaseRollout) {
    return await this.accept(
      r,
      await this.ports.database.captureBackup(r.source),
      RolloutStep.CaptureSourceBackup,
    );
  }
  async quiesceSource(r: ReleaseRollout) {
    return await this.accept(
      r,
      await this.ports.database.quiesce(r.source),
      RolloutStep.QuiesceSource,
    );
  }
  async copyDatabaseGeneration(r: ReleaseRollout) {
    return await this.accept(
      r,
      await this.ports.database.copy(r.source, r.target),
      RolloutStep.CopyDatabaseGeneration,
    );
  }
  async verifyDataEquivalence(r: ReleaseRollout) {
    return await this.accept(
      r,
      await this.ports.database.verifyEquivalence(r.source, r.target),
      RolloutStep.VerifyDataEquivalence,
    );
  }
  async bootstrapTargetRoles(r: ReleaseRollout) {
    return await this.accept(
      r,
      await this.ports.database.bootstrapTargetRoles(r.target),
      RolloutStep.BootstrapTargetRoles,
    );
  }
  async cleanupRoleRunner(r: ReleaseRollout, identity: RunnerIdentity) {
    return await this.accept(
      r,
      await this.ports.runner.cleanup(identity),
      RolloutStep.CleanupRoleRunner,
    );
  }
  async runReleaseMigration(r: ReleaseRollout) {
    return await this.accept(
      r,
      await this.ports.database.runReleaseMigration(r.target),
      RolloutStep.RunReleaseMigration,
    );
  }
  async stageTargetServices(r: ReleaseRollout) {
    return await this.accept(
      r,
      await this.ports.services.stageTarget(),
      RolloutStep.StageTargetServices,
    );
  }
  async activateTargetGeneration(r: ReleaseRollout) {
    return await this.accept(
      r,
      await this.ports.database.activate(r.source, r.target),
      RolloutStep.ActivateTargetGeneration,
    );
  }
  async cleanupCutoverRunner(r: ReleaseRollout, identity: RunnerIdentity) {
    return await this.accept(
      r,
      await this.ports.runner.cleanup(identity),
      RolloutStep.CleanupCutoverRunner,
    );
  }
  async resumeTargetServices(r: ReleaseRollout) {
    return await this.accept(
      r,
      await this.ports.services.resumeDeployAndObserve(),
      RolloutStep.ResumeTargetServices,
    );
  }
  async verifyLiveCanary(r: ReleaseRollout) {
    return await this.accept(
      r,
      await this.ports.services.verifyLiveCanary(),
      RolloutStep.VerifyLiveCanary,
    );
  }
  async verifyTrustedRollout(r: ReleaseRollout) {
    return await this.accept(
      r,
      await this.ports.evidence.assembleAndVerify(r),
      RolloutStep.VerifyTrustedRollout,
    );
  }

  async recoverFromFailure(
    r: ReleaseRollout,
    failure: "definite_pre_activation" | "activation_uncertain",
  ): Promise<ReleaseRollout> {
    const failed = transitionFailure(r, failure);
    await this.ports.runner.reconcileOrphans(r.rolloutId);
    if (
      failure === "activation_uncertain" ||
      failed.sourcePermanentlyIneligible
    ) {
      const current =
        r.receipts.at(-1)?.receiptSha256 ?? `sha256:${"0".repeat(64)}`;
      if (
        !(await this.ports.ledger.compareAndSet({
          rolloutId: r.rolloutId,
          expectedReceiptSha256: current,
          nextReceiptSha256: current,
          authoritativeSystemIdentifier: r.target.systemIdentifier,
          activationBoundary: "uncertain",
        }))
      )
        throw new Error("activation_uncertain_ledger_cas_failed");
      return failed;
    }
    const compensating = beginCompensation(failed);
    await this.ports.database.compensateSource(r.source);
    await this.ports.provider.compensateAndObserve();
    return completeCompensation(compensating);
  }
}
