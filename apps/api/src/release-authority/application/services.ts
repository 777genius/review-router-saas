import type {
  PersistedJob,
  PersistedProviderCleanupWitness,
  ActivationPermitInstallerPort,
  ReleaseAuthorityLedgerPort,
  ReleaseRolloutReconciliationPort,
  RolloutBinding,
  RunnerCleanupWitnessPort,
  TargetActivationReceiptReaderPort,
  RunnerOperationsLedgerPort,
  ReleaseServiceTransitionLedgerPort,
  ReleaseProviderMutationAuthorityPort,
} from "../domain/model.js";
import type {
  RunnerIdentity,
  StepObservation,
} from "@reviewrouter/features-release-rollout";
import {
  activationCatalogPolicyDigestsEqual,
  sha256Canonical,
} from "@reviewrouter/features-release-rollout";

export type ExecuteFreshReleaseAuthorityMutation = <Result>(
  target: ReleaseAuthorityMutationTarget,
  mutation: () => Promise<Result> | Result,
) => Promise<Result>;

export type ReleaseAuthorityMutationTarget =
  | "control"
  | "provider"
  | "installer"
  | "reader";

/** Application policy port for exclusive, freshly attested mutation sequences. */
export interface ReleaseAuthorityHighRiskMutationGate {
  execute<Result>(
    sequence: (
      executeFresh: ExecuteFreshReleaseAuthorityMutation,
    ) => Promise<Result> | Result,
  ): Promise<Result>;
}

const withoutHighRiskGate: ReleaseAuthorityHighRiskMutationGate = {
  execute: async (sequence) =>
    await sequence(async (_target, mutation) => await mutation()),
};

export class ReleaseAuthorityService {
  constructor(
    private readonly repository: ReleaseAuthorityLedgerPort,
    private readonly permitInstaller?: ActivationPermitInstallerPort,
    private readonly targetReceiptReader?: TargetActivationReceiptReaderPort,
    private readonly highRiskGate: ReleaseAuthorityHighRiskMutationGate = withoutHighRiskGate,
  ) {}
  claim = (input: RolloutBinding) => this.repository.claim(input);
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
  ) =>
    this.highRiskGate.execute((executeFresh) =>
      executeFresh("control", () => this.repository.compareAndSet(input)),
    );
  markUncertain = async (input: RolloutBinding) =>
    this.highRiskGate.execute((executeFresh) =>
      executeFresh("control", () =>
        this.repository.markActivationUncertain(input),
      ),
    );
  fenceTargetSwitch = async (
    input: RolloutBinding & { previousReceiptSha256: string },
  ) =>
    this.highRiskGate.execute((executeFresh) =>
      executeFresh("control", () => this.repository.fenceTargetSwitch(input)),
    );
  authorizeActivation = async (
    input: Parameters<ReleaseAuthorityLedgerPort["authorizeActivation"]>[0],
  ) =>
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh("control", () => this.repository.authorizeActivation(input)),
    );
  authorizeAndInstall = (
    input: Parameters<ReleaseAuthorityLedgerPort["authorizeActivation"]>[0],
  ) =>
    this.highRiskGate.execute(async (executeFresh) => {
      const authorization = await executeFresh("control", () =>
        this.repository.authorizeActivation(input),
      );
      const permitInstaller = this.permitInstaller;
      if (!permitInstaller)
        throw new Error("activation_permit_installer_unavailable");
      await executeFresh("installer", () =>
        permitInstaller.install(authorization),
      );
      return authorization;
    });
  finalize = async (
    input: Parameters<ReleaseAuthorityLedgerPort["finalizeActivation"]>[0],
  ) => {
    if (!this.targetReceiptReader)
      throw new Error("target_activation_receipt_reader_unavailable");
    const receipt = await this.targetReceiptReader.read(
      input.authorization.rolloutId,
    );
    if (!receipt || "receiptAbsent" in receipt)
      throw new Error("target_activation_receipt_missing");
    const proposed = input.activationReceipt;
    const authorization = input.authorization;
    if (
      proposed.rolloutId !== authorization.rolloutId ||
      proposed.expectedCommitSha !== authorization.expectedCommitSha ||
      proposed.sourceSystemIdentifier !==
        authorization.sourceSystemIdentifier ||
      proposed.targetSystemIdentifier !==
        authorization.targetSystemIdentifier ||
      proposed.previousReceiptSha256 !== authorization.previousReceiptSha256 ||
      proposed.postgresMajor !== authorization.postgresMajor ||
      proposed.migrationChecksum !== authorization.migrationChecksum ||
      proposed.permitEpoch !== authorization.epoch ||
      proposed.permitNonce !== authorization.nonce ||
      JSON.stringify(proposed.targetDeployIds) !==
        JSON.stringify(authorization.targetDeployIds) ||
      proposed.canonicalPrivilegesSha256 !==
        receipt.canonicalPrivilegesSha256 ||
      proposed.catalogFactsSha256 !== receipt.catalogFactsSha256 ||
      proposed.preactivationCatalogPolicySha256 !==
        receipt.preactivationCatalogPolicySha256 ||
      proposed.activatedCatalogPolicySha256 !==
        receipt.activatedCatalogPolicySha256 ||
      !activationCatalogPolicyDigestsEqual(proposed) ||
      !activationCatalogPolicyDigestsEqual(receipt) ||
      proposed.beforePrincipalInventorySha256 !==
        receipt.beforePrincipalInventorySha256 ||
      proposed.beforePrincipalPolicySha256 !==
        receipt.beforePrincipalPolicySha256 ||
      proposed.activatedPrincipalInventorySha256 !==
        receipt.activatedPrincipalInventorySha256 ||
      proposed.activatedPrincipalPolicySha256 !==
        receipt.activatedPrincipalPolicySha256 ||
      proposed.transactionId !== receipt.transactionId ||
      proposed.firstWriteReceiptSha256 !== receipt.firstWriteReceiptSha256 ||
      proposed.firstWriteBoundary !== receipt.firstWriteBoundary ||
      proposed.postgresMajor !== receipt.postgresMajor ||
      proposed.migrationChecksum !== receipt.migrationChecksum ||
      proposed.permitEpoch !== receipt.permitEpoch ||
      proposed.permitNonce !== receipt.permitNonce ||
      JSON.stringify(proposed.targetDeployIds) !==
        JSON.stringify(receipt.targetDeployIds) ||
      proposed.receiptSha256 !== input.nextReceiptSha256
    )
      throw new Error("target_activation_receipt_mismatch");
    return this.highRiskGate.execute((executeFresh) =>
      executeFresh("control", () => this.repository.finalizeActivation(input)),
    );
  };
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
    private readonly highRiskGate: ReleaseAuthorityHighRiskMutationGate = withoutHighRiskGate,
  ) {}
  decide = async (
    input: Parameters<ReleaseAuthorityLedgerPort["decideProviderOperation"]>[0],
  ) =>
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh("provider", () =>
        this.repository.decideProviderOperation(input),
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
    private readonly highRiskGate: ReleaseAuthorityHighRiskMutationGate = withoutHighRiskGate,
  ) {}
  recover = async (
    input: Parameters<ReleaseProviderMutationAuthorityPort["recover"]>[0],
  ) =>
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh("control", () => this.repository.recover(input)),
    );
  issue = async (
    input: Parameters<ReleaseProviderMutationAuthorityPort["issue"]>[0],
  ) =>
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh("control", () => this.repository.issue(input)),
    );
  consume = async (
    input: Parameters<ReleaseProviderMutationAuthorityPort["consume"]>[0],
  ) =>
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh("control", () => this.repository.consume(input)),
    );
  validateExecution = async (
    input: Parameters<
      ReleaseProviderMutationAuthorityPort["validateExecution"]
    >[0],
  ) =>
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh("control", () => this.repository.validateExecution(input)),
    );
  complete = async (
    input: Parameters<ReleaseProviderMutationAuthorityPort["complete"]>[0],
  ) =>
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh("control", () => this.repository.complete(input)),
    );
  reconcile = async (
    input: Parameters<ReleaseProviderMutationAuthorityPort["reconcile"]>[0],
  ) =>
    await this.highRiskGate.execute((executeFresh) =>
      executeFresh("control", () => this.repository.reconcile(input)),
    );
}

export class ReleaseRolloutReconciliationService {
  constructor(
    private readonly repository: ReleaseRolloutReconciliationPort,
    private readonly targetReceiptReader?: TargetActivationReceiptReaderPort,
    private readonly highRiskGate: ReleaseAuthorityHighRiskMutationGate = withoutHighRiskGate,
  ) {}

  private write = (
    input: Parameters<ReleaseRolloutReconciliationPort["reconcile"]>[0],
  ) =>
    this.highRiskGate.execute((executeFresh) =>
      executeFresh("control", () => this.repository.reconcile(input)),
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
    if (!authorization || !targetMatchesAuthorization(target, authorization))
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

function targetMatchesAuthorization(
  target: Exclude<
    Awaited<ReturnType<TargetActivationReceiptReaderPort["read"]>>,
    null | { receiptAbsent: true }
  >,
  authorization: import("@reviewrouter/features-release-rollout").ActivationAuthorization,
): boolean {
  const digest = /^sha256:[a-f0-9]{64}$/u;
  return (
    target.rolloutId === authorization.rolloutId &&
    target.expectedCommitSha === authorization.expectedCommitSha &&
    target.sourceSystemIdentifier === authorization.sourceSystemIdentifier &&
    target.targetSystemIdentifier === authorization.targetSystemIdentifier &&
    target.postgresMajor === authorization.postgresMajor &&
    target.migrationChecksum === authorization.migrationChecksum &&
    target.permitEpoch === authorization.epoch &&
    target.permitNonce === authorization.nonce &&
    JSON.stringify(target.targetDeployIds) ===
      JSON.stringify(authorization.targetDeployIds) &&
    target.firstWriteBoundary === true &&
    digest.test(target.canonicalPrivilegesSha256) &&
    digest.test(target.catalogFactsSha256) &&
    digest.test(target.preactivationCatalogPolicySha256) &&
    digest.test(target.activatedCatalogPolicySha256) &&
    activationCatalogPolicyDigestsEqual(target) &&
    digest.test(target.beforePrincipalInventorySha256) &&
    digest.test(target.beforePrincipalPolicySha256) &&
    digest.test(target.activatedPrincipalInventorySha256) &&
    digest.test(target.activatedPrincipalPolicySha256) &&
    digest.test(target.firstWriteReceiptSha256) &&
    digest.test(target.activationObservationSha256) &&
    /^[0-9]+$/u.test(target.transactionId) &&
    Number.isFinite(Date.parse(target.activatedAt))
  );
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
    permitEpoch: target.permitEpoch,
    permitNonce: target.permitNonce,
    targetDeployIds: target.targetDeployIds,
  };
  return { ...base, receiptSha256: `sha256:${sha256Canonical(base)}` };
}
