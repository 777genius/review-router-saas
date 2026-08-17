import type {
  PersistedJob,
  PersistedProviderCleanupWitness,
  ActivationPermitInstallerPort,
  ReleaseAuthorityLedgerPort,
  ReleaseRolloutReconciliationPort,
  RolloutBinding,
  RolloutClaimBinding,
  RunnerCleanupWitnessPort,
  TargetActivationReceiptReaderPort,
  TargetMigrationReceiptReaderPort,
  RunnerOperationsLedgerPort,
  ReleaseServiceTransitionLedgerPort,
  ReleaseProviderMutationAuthorityPort,
} from "../domain/model.js";
import type {
  RunnerIdentity,
  StepObservation,
} from "@reviewrouter/features-release-rollout";
import { sha256Canonical } from "@reviewrouter/features-release-rollout";
import {
  assertReleaseMigrationTransition,
  TargetManifestPhase,
  type ReleaseMigrationTransitionV1,
} from "@reviewrouter/features-release-rollout";
import { targetActivationIdentityMatches } from "./target-activation-invariant.js";

export type ExecuteFreshReleaseAuthorityMutation = <Result>(
  target: ReleaseAuthorityMutationTarget,
  mutation: (
    attestation: ReleaseAuthorityFencedAttestation,
  ) => Promise<Result> | Result,
  targetManifestPhase?:
    | "pre_migration"
    | "migration_recovery"
    | "post_migration"
    | "control_only",
) => Promise<Result>;

export type ReleaseAuthorityFencedAttestation = Readonly<{
  systemIdentifier: string;
  recoveryWitnessSha256: string;
}>;

export type ReleaseAuthorityMutationTarget =
  | "control"
  | "provider"
  | "installer"
  | "reader";

/**
 * Application policy port for exclusive, freshly attested mutation sequences.
 * Cross-database operations have one deadlock-safe order: acquire and retain
 * the target activation fence first, then acquire the control-authority fence.
 * No control-authority mutation may call back into a target fence.
 */
export interface ReleaseAuthorityHighRiskMutationGate {
  execute<Result>(
    sequence: (
      executeFresh: ExecuteFreshReleaseAuthorityMutation,
    ) => Promise<Result> | Result,
  ): Promise<Result>;
}

export class ReleaseAuthorityService {
  constructor(
    private readonly repository: ReleaseAuthorityLedgerPort,
    private readonly permitInstaller: ActivationPermitInstallerPort | undefined,
    private readonly targetReceiptReader:
      | TargetActivationReceiptReaderPort
      | undefined,
    private readonly highRiskGate: ReleaseAuthorityHighRiskMutationGate,
    private readonly trustedMigrationTransition?: ReleaseMigrationTransitionV1,
    private readonly targetMigrationReceiptReader?: TargetMigrationReceiptReaderPort,
  ) {}
  claim = (input: RolloutClaimBinding) => {
    if (!this.trustedMigrationTransition)
      throw new Error("trusted_release_migration_transition_missing");
    assertReleaseMigrationTransition(
      input.migrationTransition,
      this.trustedMigrationTransition,
    );
    return this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "installer",
        async (target) => {
          if (
            target.systemIdentifier === input.sourceSystemIdentifier ||
            target.systemIdentifier !== input.targetSystemIdentifier ||
            target.recoveryWitnessSha256 !==
              input.targetRecoveryWitnessSha256 ||
            !/^[1-9][0-9]{0,19}$/u.test(target.systemIdentifier) ||
            !/^[a-f0-9]{64}$/u.test(target.recoveryWitnessSha256)
          )
            throw new Error("release_migration_target_identity_untrusted");
          return executeFresh(
            "control",
            () =>
              this.repository.claim({
                ...input,
                targetSystemIdentifier: target.systemIdentifier,
                targetRecoveryWitnessSha256: target.recoveryWitnessSha256,
              }),
            TargetManifestPhase.PreMigration,
          );
        },
        TargetManifestPhase.PreMigration,
      ),
    );
  };
  beginReleaseMigration = async (
    input: Parameters<ReleaseAuthorityLedgerPort["beginReleaseMigration"]>[0],
  ) => {
    if (
      !this.trustedMigrationTransition ||
      input.transitionSha256 !==
        this.trustedMigrationTransition.transitionSha256
    )
      throw new Error("release_migration_transition_untrusted");
    const trustedMigrationTransition = this.trustedMigrationTransition;
    const checkpoint = await this.repository.loadReleaseMigrationCheckpoint({
      rolloutId: input.rolloutId,
      targetSystemIdentifier: input.targetSystemIdentifier,
    });
    if (
      checkpoint.targetManifestPhase !== TargetManifestPhase.PreMigration &&
      checkpoint.targetManifestPhase !== TargetManifestPhase.Migrating
    )
      throw new Error("release_migration_begin_phase_invalid");
    const targetManifestPhase =
      checkpoint.targetManifestPhase === TargetManifestPhase.Migrating
        ? ("migration_recovery" as const)
        : TargetManifestPhase.PreMigration;
    return this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "installer",
        async (target) => {
          if (
            target.systemIdentifier === input.sourceSystemIdentifier ||
            target.systemIdentifier !== input.targetSystemIdentifier ||
            target.recoveryWitnessSha256 !==
              input.targetRecoveryWitnessSha256 ||
            !/^[1-9][0-9]{0,19}$/u.test(target.systemIdentifier) ||
            !/^[a-f0-9]{64}$/u.test(target.recoveryWitnessSha256)
          )
            throw new Error("release_migration_target_identity_untrusted");
          const permit = await executeFresh(
            "control",
            async () => {
              const checkpoint =
                await this.repository.loadReleaseMigrationCheckpoint({
                  rolloutId: input.rolloutId,
                  targetSystemIdentifier: target.systemIdentifier,
                });
              if (
                checkpoint.targetManifestPhase !==
                  TargetManifestPhase.PreMigration &&
                checkpoint.targetManifestPhase !== TargetManifestPhase.Migrating
              )
                throw new Error("release_migration_begin_phase_invalid");
              return this.repository.beginReleaseMigration({
                ...input,
                targetSystemIdentifier: target.systemIdentifier,
                targetRecoveryWitnessSha256: target.recoveryWitnessSha256,
              });
            },
            targetManifestPhase,
          );
          if (!this.permitInstaller)
            throw new Error("release_migration_permit_installer_missing");
          await this.permitInstaller.installMigrationPermit({
            permit,
            sourceSystemIdentifier: input.sourceSystemIdentifier,
            expectedPostManifestIdentity:
              trustedMigrationTransition.postManifestIdentity,
            expectedPostCatalogDigest:
              trustedMigrationTransition.postCatalogDigest,
          });
          return permit;
        },
        targetManifestPhase,
      ),
    );
  };
  completeReleaseMigration = async (
    input: Parameters<
      ReleaseAuthorityLedgerPort["completeReleaseMigration"]
    >[0],
  ) => {
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "installer",
        async (target) => {
          if (
            target.systemIdentifier !== input.permit.targetSystemIdentifier ||
            target.systemIdentifier !== input.receipt.targetSystemIdentifier ||
            target.recoveryWitnessSha256 !==
              input.permit.targetRecoveryWitnessSha256
          )
            throw new Error("release_migration_target_identity_untrusted");
          if (!this.permitInstaller)
            throw new Error("release_migration_permit_installer_missing");
          await this.permitInstaller.terminalizeMigrationPermit({
            permit: input.permit,
            outcome: "completed",
          });
        },
        TargetManifestPhase.PostMigration,
      ),
    );
    if (!this.targetMigrationReceiptReader)
      throw new Error("target_migration_receipt_reader_missing");
    const targetReceipt = await this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "reader",
        (target) => {
          if (
            target.systemIdentifier !== input.permit.targetSystemIdentifier ||
            target.recoveryWitnessSha256 !==
              input.permit.targetRecoveryWitnessSha256
          )
            throw new Error("release_migration_target_identity_untrusted");
          return this.targetMigrationReceiptReader!.readMigrationReceipt(
            input.permit,
          );
        },
        TargetManifestPhase.PostMigration,
      ),
    );
    if (
      targetReceipt.sourceSystemIdentifier !==
        input.receipt.sourceSystemIdentifier ||
      targetReceipt.postManifestIdentity !==
        input.receipt.postManifestIdentity ||
      targetReceipt.postCatalogDigest !== input.receipt.postCatalogDigest ||
      targetReceipt.targetMigrationReceiptSha256 !==
        input.receipt.targetMigrationReceiptSha256 ||
      targetReceipt.effectFingerprint !==
        input.receipt.targetMigrationEffectFingerprint
    )
      throw new Error("release_migration_target_receipt_conflict");
    return this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "control",
        () => this.repository.completeReleaseMigration(input),
        TargetManifestPhase.PostMigration,
      ),
    );
  };
  failReleaseMigration = async (
    input: Parameters<ReleaseAuthorityLedgerPort["failReleaseMigration"]>[0],
  ) => {
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "installer",
        async (target) => {
          if (
            target.systemIdentifier !== input.permit.targetSystemIdentifier ||
            target.recoveryWitnessSha256 !==
              input.permit.targetRecoveryWitnessSha256
          )
            throw new Error("release_migration_target_identity_untrusted");
          if (!this.permitInstaller)
            throw new Error("release_migration_permit_installer_missing");
          await this.permitInstaller.terminalizeMigrationPermit({
            permit: input.permit,
            outcome: "quarantined",
          });
        },
        "migration_recovery",
      ),
    );
    return this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "control",
        () => this.repository.failReleaseMigration(input),
        "control_only",
      ),
    );
  };
  loadReleaseMigrationCheckpoint = (
    input: Parameters<
      ReleaseAuthorityLedgerPort["loadReleaseMigrationCheckpoint"]
    >[0],
  ) => this.repository.loadReleaseMigrationCheckpoint(input);
  completeSourceFreeze = (
    input: Parameters<ReleaseAuthorityLedgerPort["completeSourceFreeze"]>[0],
  ) => this.repository.completeSourceFreeze(input);
  prepareSourceFreezeMutation = (
    input: Parameters<
      ReleaseAuthorityLedgerPort["prepareSourceFreezeMutation"]
    >[0],
  ) => this.repository.prepareSourceFreezeMutation(input);
  recordSourceFreezeMutation = (
    input: Parameters<
      ReleaseAuthorityLedgerPort["recordSourceFreezeMutation"]
    >[0],
  ) => this.repository.recordSourceFreezeMutation(input);
  cas = async (
    input: Parameters<ReleaseAuthorityLedgerPort["compareAndSet"]>[0],
  ) => {
    if (input.step === "run_release_migration")
      throw new Error("release_migration_requires_phase_protocol");
    const targetManifestPhase = [
      "stage_target_services",
      "activate_target_generation",
      "cleanup_cutover_runner",
      "resume_target_services",
      "verify_live_canary",
      "verify_trusted_rollout",
    ].includes(input.step)
      ? TargetManifestPhase.PostMigration
      : TargetManifestPhase.PreMigration;
    return this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "control",
        () => this.repository.compareAndSet(input),
        targetManifestPhase,
      ),
    );
  };
  markUncertain = async (input: RolloutBinding) =>
    this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "control",
        () => this.repository.markActivationUncertain(input),
        "control_only",
      ),
    );
  fenceTargetSwitch = async (
    input: RolloutBinding & { previousReceiptSha256: string },
  ) =>
    this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "control",
        () => this.repository.fenceTargetSwitch(input),
        TargetManifestPhase.PostMigration,
      ),
    );
  authorizeActivation = async (
    input: Parameters<ReleaseAuthorityLedgerPort["authorizeActivation"]>[0],
  ) => {
    if (
      this.trustedMigrationTransition &&
      (input.transitionSha256 !==
        this.trustedMigrationTransition.transitionSha256 ||
        input.postManifestIdentity !==
          this.trustedMigrationTransition.postManifestIdentity ||
        input.migrationChecksum !==
          this.trustedMigrationTransition.postManifestIdentity)
    )
      throw new Error("activation_migration_transition_untrusted");
    return await this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "control",
        () => this.repository.authorizeActivation(input),
        TargetManifestPhase.PostMigration,
      ),
    );
  };
  authorizeAndInstall = (
    input: Parameters<ReleaseAuthorityLedgerPort["authorizeActivation"]>[0],
  ) =>
    this.highRiskGate.execute(async (executeFresh) => {
      if (
        this.trustedMigrationTransition &&
        (input.transitionSha256 !==
          this.trustedMigrationTransition.transitionSha256 ||
          input.postManifestIdentity !==
            this.trustedMigrationTransition.postManifestIdentity ||
          input.migrationChecksum !==
            this.trustedMigrationTransition.postManifestIdentity)
      )
        throw new Error("activation_migration_transition_untrusted");
      const authorization = await executeFresh(
        "control",
        () => this.repository.authorizeActivation(input),
        TargetManifestPhase.PostMigration,
      );
      const permitInstaller = this.permitInstaller;
      if (!permitInstaller)
        throw new Error("activation_permit_installer_unavailable");
      await executeFresh(
        "installer",
        () => permitInstaller.install(authorization),
        TargetManifestPhase.PostMigration,
      );
      return authorization;
    });
  finalize = async (
    input: Parameters<ReleaseAuthorityLedgerPort["finalizeActivation"]>[0],
  ) =>
    this.highRiskGate.execute(async (executeFresh) => {
      if (!this.targetReceiptReader)
        throw new Error("target_activation_receipt_reader_unavailable");
      const targetReceiptReader = this.targetReceiptReader;
      const receipt = await executeFresh(
        "reader",
        () => targetReceiptReader.read(input.authorization.rolloutId),
        TargetManifestPhase.PostMigration,
      );
      if (!receipt || "receiptAbsent" in receipt)
        throw new Error("target_activation_receipt_missing");
      if (
        !targetActivationIdentityMatches({
          target: receipt,
          authorization: input.authorization,
          proposedReceipt: input.activationReceipt,
          expectedReceiptSha256: input.nextReceiptSha256,
        })
      )
        throw new Error("target_activation_receipt_mismatch");
      return executeFresh(
        "control",
        () => this.repository.finalizeActivation(input),
        TargetManifestPhase.PostMigration,
      );
    });
  state = (
    input: Parameters<ReleaseAuthorityLedgerPort["activationState"]>[0],
  ) => this.repository.activationState(input);
  authorityState = (
    input: Parameters<ReleaseAuthorityLedgerPort["authorityState"]>[0],
  ) => this.repository.authorityState(input);
  compensationCheckpoint = (
    input: Parameters<ReleaseAuthorityLedgerPort["compensationCheckpoint"]>[0],
  ) => this.repository.compensationCheckpoint(input);
  verifyFinalAuthority = (
    input: Parameters<ReleaseAuthorityLedgerPort["verifyFinalAuthority"]>[0],
  ) => this.repository.verifyFinalAuthority(input);
}

export class ProviderAuthorityDecisionService {
  constructor(
    private readonly repository: ReleaseAuthorityLedgerPort,
    private readonly highRiskGate: ReleaseAuthorityHighRiskMutationGate,
  ) {}
  decide = async (
    input: Parameters<ReleaseAuthorityLedgerPort["decideProviderOperation"]>[0],
  ) =>
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "provider",
        () => this.repository.decideProviderOperation(input),
        input.operation === "resume_source" ||
          input.operation === "freeze_source"
          ? "control_only"
          : TargetManifestPhase.PostMigration,
      ),
    );
}

export class RunnerOperationsService {
  constructor(private readonly repository: RunnerOperationsLedgerPort) {}
  persistProvisioningIntent = (
    input: Parameters<
      RunnerOperationsLedgerPort["persistProvisioningIntent"]
    >[0],
  ) => this.repository.persistProvisioningIntent(input);
  listIntents = (rolloutId: string) => this.repository.listIntents(rolloutId);
  acquireProviderDispatchPermit = (
    input: Parameters<
      RunnerOperationsLedgerPort["acquireProviderDispatchPermit"]
    >[0],
  ) => this.repository.acquireProviderDispatchPermit(input);
  abandonPreparedEffect = (
    input: Parameters<RunnerOperationsLedgerPort["abandonPreparedEffect"]>[0],
  ) => this.repository.abandonPreparedEffect(input);
  reconcileProvisioningEffect = (
    input: Parameters<
      RunnerOperationsLedgerPort["reconcileProvisioningEffect"]
    >[0],
  ) => this.repository.reconcileProvisioningEffect(input);
  persistJob = (input: PersistedJob) => this.repository.persistJob(input);
  listOpenJobs = (rolloutId: string) => this.repository.listOpenJobs(rolloutId);
  persistIdentity = (
    jobId: string,
    identity: RunnerIdentity,
    observation: StepObservation,
  ) => this.repository.persistIdentity(jobId, identity, observation);
  currentRunner = (rolloutId: string, lifecycle: "role" | "cutover") =>
    this.repository.currentRunner(rolloutId, lifecycle);
  markTerminal = async (jobId: string, observation: StepObservation) => {
    await this.repository.cleanupWitness(jobId);
    await this.repository.markTerminal(jobId, observation);
  };
  cleanupObservation = (jobId: string) =>
    this.repository.cleanupObservation(jobId);
  cleanupWitness = (jobId: string) => this.repository.cleanupWitness(jobId);
  terminalCleanupFact = (rolloutId: string, lifecycle: "role" | "cutover") =>
    this.repository.terminalCleanupFact(rolloutId, lifecycle);
  persistRegistration = (
    input: Parameters<RunnerOperationsLedgerPort["persistRegistration"]>[0],
  ) => this.repository.persistRegistration(input);
}

export class RunnerCleanupWitnessService {
  constructor(private readonly repository: RunnerCleanupWitnessPort) {}
  persistProviderWitness = (
    jobId: string,
    witness: PersistedProviderCleanupWitness,
  ) => this.repository.persistProviderWitness(jobId, witness);
}

export class ReleaseServiceTransitionService {
  constructor(
    private readonly repository: ReleaseServiceTransitionLedgerPort,
  ) {}
  begin = (input: Parameters<ReleaseServiceTransitionLedgerPort["begin"]>[0]) =>
    this.repository.begin(input);
  append = (
    input: Parameters<ReleaseServiceTransitionLedgerPort["append"]>[0],
  ) => this.repository.append(input);
  read = (rolloutId: string) => this.repository.read(rolloutId);
  readContract = (rolloutId: string) => this.repository.readContract(rolloutId);
  complete = (
    input: Parameters<ReleaseServiceTransitionLedgerPort["complete"]>[0],
  ) => this.repository.complete(input);
  intendRecoveryEffect = (
    input: Parameters<
      ReleaseServiceTransitionLedgerPort["intendRecoveryEffect"]
    >[0],
  ) => this.repository.intendRecoveryEffect(input);
  claimRecoveryEffect = (
    input: Parameters<
      ReleaseServiceTransitionLedgerPort["claimRecoveryEffect"]
    >[0],
  ) => this.repository.claimRecoveryEffect(input);
  consumeRecoveryEffectPermit = (
    input: Parameters<
      ReleaseServiceTransitionLedgerPort["consumeRecoveryEffectPermit"]
    >[0],
  ) => this.repository.consumeRecoveryEffectPermit(input);
  validateRecoveryEffectExecution = (
    input: Parameters<
      ReleaseServiceTransitionLedgerPort["validateRecoveryEffectExecution"]
    >[0],
  ) => this.repository.validateRecoveryEffectExecution(input);
  completeRecoveryEffect = (
    input: Parameters<
      ReleaseServiceTransitionLedgerPort["completeRecoveryEffect"]
    >[0],
  ) => this.repository.completeRecoveryEffect(input);
  reconcileRecoveryEffect = (
    input: Parameters<
      ReleaseServiceTransitionLedgerPort["reconcileRecoveryEffect"]
    >[0],
  ) => this.repository.reconcileRecoveryEffect(input);
}

export class ProviderMutationAuthorityService {
  constructor(
    private readonly repository: ReleaseProviderMutationAuthorityPort,
    private readonly highRiskGate: ReleaseAuthorityHighRiskMutationGate,
  ) {}
  recover = async (
    input: Parameters<ReleaseProviderMutationAuthorityPort["recover"]>[0],
  ) =>
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "control",
        () => this.repository.recover(input),
        "control_only",
      ),
    );
  issue = async (
    input: Parameters<ReleaseProviderMutationAuthorityPort["issue"]>[0],
  ) =>
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "control",
        () => this.repository.issue(input),
        "control_only",
      ),
    );
  consume = async (
    input: Parameters<ReleaseProviderMutationAuthorityPort["consume"]>[0],
  ) =>
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "control",
        () => this.repository.consume(input),
        "control_only",
      ),
    );
  validateExecution = async (
    input: Parameters<
      ReleaseProviderMutationAuthorityPort["validateExecution"]
    >[0],
  ) =>
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "control",
        () => this.repository.validateExecution(input),
        "control_only",
      ),
    );
  complete = async (
    input: Parameters<ReleaseProviderMutationAuthorityPort["complete"]>[0],
  ) =>
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "control",
        () => this.repository.complete(input),
        "control_only",
      ),
    );
  reconcile = async (
    input: Parameters<ReleaseProviderMutationAuthorityPort["reconcile"]>[0],
  ) =>
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "control",
        () => this.repository.reconcile(input),
        "control_only",
      ),
    );
}

export class ReleaseRolloutReconciliationService {
  constructor(
    private readonly repository: ReleaseRolloutReconciliationPort,
    private readonly targetReceiptReader:
      | TargetActivationReceiptReaderPort
      | undefined,
    private readonly highRiskGate: ReleaseAuthorityHighRiskMutationGate,
  ) {}

  private write = (
    input: Parameters<ReleaseRolloutReconciliationPort["reconcile"]>[0],
  ) =>
    this.highRiskGate.execute((executeFresh) =>
      executeFresh(
        "control",
        () => this.repository.reconcile(input),
        "control_only",
      ),
    );

  reconcile = async (rolloutId: string) => {
    const context = await this.repository.context(rolloutId);
    if (context.activationBoundary !== "uncertain")
      return this.write({
        rolloutId,
        targetObservation: { kind: "not_required" },
      });
    if (!this.targetReceiptReader)
      return this.write({
        rolloutId,
        targetObservation: { kind: "target_read_unavailable" },
      });

    let target;
    try {
      target = await this.targetReceiptReader.read(rolloutId);
    } catch {
      return this.write({
        rolloutId,
        targetObservation: { kind: "target_read_unavailable" },
      });
    }
    if (target && "receiptAbsent" in target)
      return this.write({
        rolloutId,
        targetObservation: { kind: "activation_absent_without_revocation" },
      });
    if (!target)
      return this.write({
        rolloutId,
        targetObservation: { kind: "target_receipt_absent" },
      });

    const authorization = context.authorization;
    if (
      !authorization ||
      !targetActivationIdentityMatches({ target, authorization })
    )
      return this.write({
        rolloutId,
        targetObservation: { kind: "target_receipt_conflict" },
      });
    const activationReceipt = activationReceiptFromTarget(
      context,
      authorization,
      target,
    );
    return this.write({
      rolloutId,
      targetObservation: {
        kind: "matching_activation_receipt",
        authorization,
        nextReceiptSha256: activationReceipt.receiptSha256,
        activationReceipt,
      },
    });
  };
}

function activationReceiptFromTarget(
  context: import("../domain/model.js").ReleaseRolloutReconciliationContext,
  authorization: import("@reviewrouter/features-release-rollout").ActivationAuthorization,
  target: Exclude<
    Awaited<ReturnType<TargetActivationReceiptReaderPort["read"]>>,
    null | { receiptAbsent: true }
  >,
): import("@reviewrouter/features-release-rollout").ActivationReceipt {
  const facts = {
    rolloutId: target.rolloutId,
    sourceSystemIdentifier: target.sourceSystemIdentifier,
    targetSystemIdentifier: target.targetSystemIdentifier,
    postgresMajor: target.postgresMajor,
    expectedCommitSha: target.expectedCommitSha,
    migrationChecksum: target.migrationChecksum,
    transitionSha256: authorization.transitionSha256,
    postManifestIdentity: authorization.postManifestIdentity,
    targetDeployIds: target.targetDeployIds,
    permitEpoch: target.permitEpoch,
    permitNonce: target.permitNonce,
    canonicalPrivilegesSha256: target.canonicalPrivilegesSha256,
    catalogFactsSha256: target.catalogFactsSha256,
    preactivationCatalogPolicySha256: target.preactivationCatalogPolicySha256,
    activatedCatalogPolicySha256: target.activatedCatalogPolicySha256,
    beforePrincipalInventorySha256: target.beforePrincipalInventorySha256,
    beforePrincipalPolicySha256: target.beforePrincipalPolicySha256,
    activatedPrincipalInventorySha256: target.activatedPrincipalInventorySha256,
    activatedPrincipalPolicySha256: target.activatedPrincipalPolicySha256,
    firstWriteReceiptSha256: target.firstWriteReceiptSha256,
    transactionId: target.transactionId,
    activatedAt: target.activatedAt,
    firstWriteBoundary: true as const,
    observationSha256: target.activationObservationSha256,
  };
  const base = {
    step: "activate_target_generation" as const,
    receiptId: `${authorization.rolloutId}:activate_target_generation:${context.receiptOrdinal + 1}`,
    observedAt: target.activatedAt,
    rolloutId: authorization.rolloutId,
    expectedCommitSha: authorization.expectedCommitSha,
    runId: context.runId,
    runAttempt: context.runAttempt,
    sourceSystemIdentifier: authorization.sourceSystemIdentifier,
    targetSystemIdentifier: authorization.targetSystemIdentifier,
    provider: undefined,
    observationSha256: `sha256:${sha256Canonical(facts)}`,
    previousReceiptSha256: authorization.previousReceiptSha256,
    canonicalPrivilegesSha256: target.canonicalPrivilegesSha256,
    catalogFactsSha256: target.catalogFactsSha256,
    preactivationCatalogPolicySha256: target.preactivationCatalogPolicySha256,
    activatedCatalogPolicySha256: target.activatedCatalogPolicySha256,
    beforePrincipalInventorySha256: target.beforePrincipalInventorySha256,
    beforePrincipalPolicySha256: target.beforePrincipalPolicySha256,
    activatedPrincipalInventorySha256: target.activatedPrincipalInventorySha256,
    activatedPrincipalPolicySha256: target.activatedPrincipalPolicySha256,
    transactionId: target.transactionId,
    firstWriteReceiptSha256: target.firstWriteReceiptSha256,
    firstWriteBoundary: true as const,
    postgresMajor: target.postgresMajor,
    migrationChecksum: target.migrationChecksum,
    transitionSha256: authorization.transitionSha256,
    postManifestIdentity: authorization.postManifestIdentity,
    permitEpoch: target.permitEpoch,
    permitNonce: target.permitNonce,
    targetDeployIds: target.targetDeployIds,
  };
  return { ...base, receiptSha256: `sha256:${sha256Canonical(base)}` };
}
