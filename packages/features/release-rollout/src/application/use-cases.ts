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
  ReleasePreflightPort,
  RolloutLedgerPort,
  TargetServicesPort,
  TrustedEvidencePort,
} from "./ports";

export class ReleaseRolloutUseCases {
  constructor(
    private readonly ports: {
      provider: ProviderControlPort;
      preflight: ReleasePreflightPort;
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
    if (step === RolloutStep.ActivateTargetGeneration)
      throw new Error("activation_requires_durable_fence");
    if (observation.step !== step)
      throw new Error("adapter_observation_step_mismatch");
    const next = transitionFromObservation(r, observation);
    const activated = next.sourcePermanentlyIneligible;
    const changed = await this.ports.ledger.compareAndSet({
      rolloutId: r.rolloutId,
      expectedCommitSha: r.expectedCommitSha,
      runId: r.execution.runId,
      runAttempt: r.execution.runAttempt,
      sourceSystemIdentifier: r.source.systemIdentifier,
      targetSystemIdentifier: r.target.systemIdentifier,
      step: observation.step,
      provider: observation.provider,
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
  async verifyProtectedEnvironment(r: ReleaseRollout) {
    return await this.accept(
      r,
      await this.ports.preflight.observeProtectedEnvironment(),
      RolloutStep.VerifyProtectedEnvironment,
    );
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
    assertRunnerIdentity(
      result.identity,
      r,
      step === RolloutStep.ProvisionRoleRunner ? "role" : "cutover",
    );
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
  async activateTargetGeneration(r: ReleaseRollout, jobId: string) {
    const previousReceiptSha256 =
      r.receipts.at(-1)?.receiptSha256 ?? `sha256:${"0".repeat(64)}`;
    let fenced = false;
    try {
      const fence = await this.ports.ledger.fenceActivation({
        rolloutId: r.rolloutId,
        expectedCommitSha: r.expectedCommitSha,
        runId: r.execution.runId,
        jobId,
        runAttempt: r.execution.runAttempt,
        sourceSystemIdentifier: r.source.systemIdentifier,
        targetSystemIdentifier: r.target.systemIdentifier,
        previousReceiptSha256,
      });
      if (!fence) throw new Error("activation_fence_cas_failed");
      fenced = true;
      const observation = await this.ports.database.activate(
        r.source,
        r.target,
        fence,
      );
      if (
        observation.step !== RolloutStep.ActivateTargetGeneration ||
        (observation.facts as Record<string, unknown>).fenceNonce !==
          fence.nonce ||
        (observation.facts as Record<string, unknown>).fenceVersion !==
          fence.version
      )
        throw new Error("activation_receipt_fence_mismatch");
      const next = transitionFromObservation(r, observation);
      const changed = await this.ports.ledger.finalizeActivation({
        fence,
        provider: observation.provider,
        nextReceiptSha256: next.receipts.at(-1)!.receiptSha256,
        activationReceipt: next.activationReceipt!,
      });
      if (!changed)
        throw new Error("authoritative_generation_activation_finalize_failed");
      return next;
    } catch (error) {
      if (!fenced) throw error;
      try {
        await this.ports.ledger.markActivationUncertain({
          rolloutId: r.rolloutId,
          expectedCommitSha: r.expectedCommitSha,
          runId: r.execution.runId,
          runAttempt: r.execution.runAttempt,
          sourceSystemIdentifier: r.source.systemIdentifier,
          targetSystemIdentifier: r.target.systemIdentifier,
        });
      } catch (ledgerError) {
        throw new AggregateError(
          [error, ledgerError],
          "activation_uncertain_and_ledger_mark_failed",
          { cause: ledgerError },
        );
      }
      throw new Error(
        `activation_uncertain:${error instanceof Error ? error.message : "unknown"}`,
        { cause: error },
      );
    }
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
    const durableActivationState =
      await this.ports.ledger.observeActivationState({
        rolloutId: r.rolloutId,
        sourceSystemIdentifier: r.source.systemIdentifier,
        targetSystemIdentifier: r.target.systemIdentifier,
      });
    if (
      failure === "activation_uncertain" ||
      failed.sourcePermanentlyIneligible ||
      durableActivationState !== "before"
    ) {
      await this.ports.ledger.markActivationUncertain({
        rolloutId: r.rolloutId,
        expectedCommitSha: r.expectedCommitSha,
        runId: r.execution.runId,
        runAttempt: r.execution.runAttempt,
        sourceSystemIdentifier: r.source.systemIdentifier,
        targetSystemIdentifier: r.target.systemIdentifier,
      });
      return failed;
    }
    const compensating = beginCompensation(failed);
    await this.ports.database.compensateSource(r.source);
    await this.ports.provider.compensateAndObserve();
    return completeCompensation(compensating);
  }
}
