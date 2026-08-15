import {
  assertRunnerIdentity,
  beginReleaseMigrationAttempt,
  recoverCompletedReleaseMigration,
  RolloutStep,
  sha256Canonical,
  transitionFailure,
  transitionFromObservation,
  type ReleaseRollout,
  type ReleaseMigrationReceipt,
  type RunnerIdentity,
  type StepObservation,
} from "../domain/release-rollout";
import {
  assertLegacyAmbiguityEvidence,
  type LegacyAmbiguityEvidence,
} from "../domain/trusted-rollout-evidence";
import type {
  DatabaseRolloutPort,
  ProviderAuthorityDecisionPort,
  ProviderAuthorityRequest,
  PrivateRunnerPort,
  ProviderControlPort,
  ReleasePreflightPort,
  RolloutLedgerPort,
  TargetServicesPort,
  TrustedEvidencePort,
} from "./ports";
import { ProviderAuthorityOperation } from "./ports";

export class ReleaseRolloutUseCases {
  constructor(
    private readonly ports: {
      provider: ProviderControlPort;
      authority?: ProviderAuthorityDecisionPort;
      preflight: ReleasePreflightPort;
      runner: PrivateRunnerPort;
      database: DatabaseRolloutPort;
      services: TargetServicesPort;
      evidence: TrustedEvidencePort;
      ledger: RolloutLedgerPort;
      /** Unified authority-mediated compensation implementation. */
      compensation?: {
        recover(rollout: ReleaseRollout): Promise<ReleaseRollout>;
      };
    },
  ) {}

  private async authorize(
    r: ReleaseRollout,
    operation: ProviderAuthorityRequest["operation"],
    activationBoundary: ProviderAuthorityRequest["activationBoundary"],
  ) {
    const request = {
      rolloutId: r.rolloutId,
      operation,
      sourceSystemIdentifier: r.source.systemIdentifier,
      targetSystemIdentifier: r.target.systemIdentifier,
      expectedReceiptSha256:
        r.receipts.at(-1)?.receiptSha256 ?? `sha256:${"0".repeat(64)}`,
      activationBoundary,
    } as const;
    let decision;
    try {
      if (!this.ports.authority)
        throw new Error("provider_authority_not_configured");
      decision = await this.ports.authority.decide(request);
    } catch (error) {
      throw new Error("provider_authority_unavailable_or_denied", {
        cause: error,
      });
    }
    if (
      decision.decision !== "allow" ||
      !decision.decisionId ||
      Number.isNaN(Date.parse(decision.decidedAt)) ||
      Object.entries(request).some(
        ([key, value]) => decision[key as keyof typeof decision] !== value,
      )
    )
      throw new Error("provider_authority_decision_invalid");
    return decision;
  }

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
    const expectedActivationBoundary = r.activated
      ? "activated"
      : r.activationUncertain || r.sourcePermanentlyIneligible
        ? "uncertain"
        : "before";
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
      expectedActivationBoundary,
      nextActivationBoundary: activated ? "activated" : "before",
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
      targetRecoveryWitnessSha256: r.target.recoveryWitnessSha256,
      migrationTransition: r.migrationTransition,
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
  async runReleaseMigration(
    r: ReleaseRollout,
    sourceLegacyAmbiguity: LegacyAmbiguityEvidence,
  ) {
    const trustedSourceLegacyAmbiguity = assertLegacyAmbiguityEvidence(
      sourceLegacyAmbiguity,
    );
    if (
      !this.ports.ledger.beginReleaseMigration ||
      !this.ports.ledger.completeReleaseMigration ||
      !this.ports.ledger.failReleaseMigration ||
      !this.ports.ledger.loadReleaseMigrationCheckpoint
    )
      throw new Error("release_migration_phase_protocol_unavailable");
    const checkpoint = await this.ports.ledger.loadReleaseMigrationCheckpoint({
      rolloutId: r.rolloutId,
      targetSystemIdentifier: r.target.systemIdentifier,
    });
    if (checkpoint.targetManifestPhase === "quarantined")
      throw new Error("release_migration_quarantined");
    if (checkpoint.targetManifestPhase === "post_migration") {
      if (!checkpoint.permit || !checkpoint.receipt)
        throw new Error("release_migration_checkpoint_invalid");
      return recoverCompletedReleaseMigration(
        r,
        checkpoint.permit,
        checkpoint.receipt,
        trustedSourceLegacyAmbiguity,
      );
    }
    const previousReceiptSha256 =
      r.receipts.at(-1)?.receiptSha256 ?? `sha256:${"0".repeat(64)}`;
    const permit = await this.ports.ledger.beginReleaseMigration({
      rolloutId: r.rolloutId,
      expectedCommitSha: r.expectedCommitSha,
      runId: r.execution.runId,
      runAttempt: r.execution.runAttempt,
      sourceSystemIdentifier: r.source.systemIdentifier,
      targetSystemIdentifier: r.target.systemIdentifier,
      targetRecoveryWitnessSha256: r.target.recoveryWitnessSha256,
      transitionSha256: r.migrationTransition.transitionSha256,
      expectedPreviousReceiptSha256: previousReceiptSha256,
      sourceLegacyAmbiguity: trustedSourceLegacyAmbiguity,
    });
    const migrating = beginReleaseMigrationAttempt(
      r,
      permit,
      trustedSourceLegacyAmbiguity,
    );
    // A transport failure leaves the durable authority checkpoint in
    // `migrating`; an exact retry uses the stored permit and target receipt.
    const observation: StepObservation =
      await this.ports.database.runReleaseMigration(
        r.target,
        r.migrationTransition,
        permit,
        trustedSourceLegacyAmbiguity,
      );
    let completed: ReleaseRollout;
    let receipt: ReleaseMigrationReceipt;
    try {
      if (observation.step !== RolloutStep.RunReleaseMigration)
        throw new Error("adapter_observation_step_mismatch");
      completed = transitionFromObservation(migrating, observation);
      receipt = completed.receipts.at(-1) as ReleaseMigrationReceipt;
    } catch (error) {
      const reasonSha256 = `sha256:${sha256Canonical({
        code: error instanceof Error ? error.message : "unknown",
      })}`;
      await this.ports.ledger.failReleaseMigration({ permit, reasonSha256 });
      throw error;
    }
    const canonical = await this.ports.ledger.completeReleaseMigration({
      permit,
      receipt,
    });
    if (canonical.receiptSha256 !== receipt.receiptSha256)
      throw new Error("release_migration_receipt_recovery_conflict");
    return completed;
  }
  async stageTargetServices(r: ReleaseRollout) {
    const previousReceiptSha256 = r.receipts.at(-1)!.receiptSha256;
    const fence = await this.ports.ledger.fenceTargetSwitch({
      rolloutId: r.rolloutId,
      expectedCommitSha: r.expectedCommitSha,
      runId: r.execution.runId,
      runAttempt: r.execution.runAttempt,
      sourceSystemIdentifier: r.source.systemIdentifier,
      targetSystemIdentifier: r.target.systemIdentifier,
      previousReceiptSha256,
    });
    if (!fence) throw new Error("target_switch_fence_cas_failed");
    const decision = await this.authorize(
      r,
      ProviderAuthorityOperation.DeployTarget,
      "before",
    );
    return await this.accept(
      r,
      await this.ports.services.stageTarget(fence, decision),
      RolloutStep.StageTargetServices,
    );
  }
  async activateTargetGeneration(r: ReleaseRollout, jobId: string) {
    const previousReceiptSha256 =
      r.receipts.at(-1)?.receiptSha256 ?? `sha256:${"0".repeat(64)}`;
    const targetDeployIds = r.receipts.at(-1)?.provider?.renderDeployIds;
    if (!targetDeployIds?.length)
      throw new Error("activation_target_deploy_binding_missing");
    const migrationChecksum = (
      r.receipts.find(
        (receipt) => receipt.step === RolloutStep.RunReleaseMigration,
      ) as ReleaseMigrationReceipt | undefined
    )?.migrationChecksum;
    if (
      typeof migrationChecksum !== "string" ||
      migrationChecksum.length !== 71 ||
      !migrationChecksum.startsWith("sha256:") ||
      [...migrationChecksum.slice(7)].some(
        (character) => !"0123456789abcdef".includes(character),
      )
    )
      throw new Error("activation_migration_checksum_missing");
    let authorized = false;
    try {
      const authorization = await this.ports.ledger.authorizeActivation({
        rolloutId: r.rolloutId,
        expectedCommitSha: r.expectedCommitSha,
        runId: r.execution.runId,
        jobId,
        runAttempt: r.execution.runAttempt,
        sourceSystemIdentifier: r.source.systemIdentifier,
        targetSystemIdentifier: r.target.systemIdentifier,
        previousReceiptSha256,
        targetDeployIds,
        postgresMajor: 17,
        migrationChecksum,
        transitionSha256: r.migrationTransition.transitionSha256,
        postManifestIdentity: r.migrationTransition.postManifestIdentity,
      });
      this.assertActivationAuthorization(r, authorization, {
        jobId,
        previousReceiptSha256,
        targetDeployIds,
        migrationChecksum,
      });
      authorized = true;
      const rawObservation = await this.ports.database.activate(r.rolloutId);
      const observation = {
        ...rawObservation,
        facts: {
          ...(rawObservation.facts as Record<string, unknown>),
          transitionSha256: authorization.transitionSha256,
          postManifestIdentity: authorization.postManifestIdentity,
        },
      };
      if (observation.step !== RolloutStep.ActivateTargetGeneration)
        throw new Error("activation_receipt_step_mismatch");
      const next = transitionFromObservation(r, observation);
      this.assertPermitBoundActivationReceipt(
        r,
        authorization,
        next.activationReceipt!,
      );
      const changed = await this.ports.ledger.finalizeActivation({
        authorization,
        provider: observation.provider,
        nextReceiptSha256: next.receipts.at(-1)!.receiptSha256,
        activationReceipt: next.activationReceipt!,
      });
      if (!changed)
        throw new Error("authoritative_generation_activation_finalize_failed");
      return next;
    } catch (error) {
      if (!authorized) throw error;
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

  private assertActivationAuthorization(
    r: ReleaseRollout,
    authorization: import("../domain/release-rollout").ActivationAuthorization,
    expected: {
      jobId: string;
      previousReceiptSha256: string;
      targetDeployIds: readonly string[];
      migrationChecksum: string;
    },
  ): void {
    if (
      authorization.rolloutId !== r.rolloutId ||
      authorization.expectedCommitSha !== r.expectedCommitSha ||
      authorization.postgresMajor !== 17 ||
      authorization.migrationChecksum !== expected.migrationChecksum ||
      authorization.transitionSha256 !==
        r.migrationTransition.transitionSha256 ||
      authorization.postManifestIdentity !==
        r.migrationTransition.postManifestIdentity ||
      authorization.sourceSystemIdentifier !== r.source.systemIdentifier ||
      authorization.targetSystemIdentifier !== r.target.systemIdentifier ||
      authorization.previousReceiptSha256 !== expected.previousReceiptSha256 ||
      !Number.isSafeInteger(authorization.epoch) ||
      authorization.epoch < 1 ||
      !/^[a-f0-9]{32}$/u.test(authorization.nonce) ||
      JSON.stringify(authorization.targetDeployIds) !==
        JSON.stringify(expected.targetDeployIds) ||
      Number.isNaN(Date.parse(authorization.authorizedAt))
    )
      throw new Error("activation_authorization_identity_mismatch");
  }

  private assertPermitBoundActivationReceipt(
    r: ReleaseRollout,
    authorization: import("../domain/release-rollout").ActivationAuthorization,
    receipt: import("../domain/release-rollout").ActivationReceipt,
  ): void {
    if (
      receipt.rolloutId !== authorization.rolloutId ||
      receipt.expectedCommitSha !== r.expectedCommitSha ||
      authorization.expectedCommitSha !== r.expectedCommitSha ||
      receipt.postgresMajor !== authorization.postgresMajor ||
      receipt.migrationChecksum !== authorization.migrationChecksum ||
      receipt.transitionSha256 !== authorization.transitionSha256 ||
      receipt.postManifestIdentity !== authorization.postManifestIdentity ||
      receipt.sourceSystemIdentifier !== authorization.sourceSystemIdentifier ||
      receipt.targetSystemIdentifier !== authorization.targetSystemIdentifier ||
      receipt.previousReceiptSha256 !== authorization.previousReceiptSha256 ||
      receipt.permitEpoch !== authorization.epoch ||
      receipt.permitNonce !== authorization.nonce ||
      JSON.stringify(receipt.targetDeployIds) !==
        JSON.stringify(authorization.targetDeployIds)
    )
      throw new Error("activation_receipt_authorization_mismatch");
  }
  async cleanupCutoverRunner(r: ReleaseRollout, identity: RunnerIdentity) {
    return await this.accept(
      r,
      await this.ports.runner.cleanup(identity),
      RolloutStep.CleanupCutoverRunner,
    );
  }
  async resumeTargetServices(r: ReleaseRollout) {
    const decision = await this.authorize(
      r,
      ProviderAuthorityOperation.ResumeTarget,
      "activated",
    );
    return await this.accept(
      r,
      await this.ports.services.resumeDeployAndObserve(decision),
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
    if (
      !r.activationReceipt ||
      !(await this.ports.ledger.verifyFinalAuthority({
        rolloutId: r.rolloutId,
        expectedCommitSha: r.expectedCommitSha,
        runId: r.execution.runId,
        runAttempt: r.execution.runAttempt,
        sourceSystemIdentifier: r.source.systemIdentifier,
        targetSystemIdentifier: r.target.systemIdentifier,
        expectedReceiptSha256: r.receipts.at(-1)!.receiptSha256,
        activationReceipt: r.activationReceipt,
      }))
    )
      throw new Error("trusted_rollout_authoritative_ledger_mismatch");
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
    if (!this.ports.compensation)
      throw new Error("authority_mediated_compensation_not_configured");
    return this.ports.compensation.recover(failed);
  }
}

/** Application boundary for hosted controller commands that do not own the aggregate artifact. */
export class PrivateRunnerControlUseCases<Provision, Cleanup, Reconciliation> {
  constructor(
    private readonly runner: {
      provision(input: Provision): Promise<unknown>;
      cleanup(input: Cleanup): Promise<StepObservation>;
      reconcileOrphans(
        rolloutId: string,
        apiKey: string,
      ): Promise<Reconciliation>;
    },
  ) {}

  async provision(input: Provision) {
    return await this.runner.provision(input);
  }

  async cleanup(input: Cleanup) {
    return await this.runner.cleanup(input);
  }

  async reconcile(rolloutId: string, apiKey: string) {
    return await this.runner.reconcileOrphans(rolloutId, apiKey);
  }
}
