import type {
  PersistedJob,
  PersistedProviderCleanupWitness,
  ProvisioningIntent,
  ActivationPermitInstallerPort,
  ReleaseAuthorityLedgerPort,
  ReleaseRolloutReconciliationPort,
  RolloutBinding,
  RunnerCleanupWitnessPort,
  TargetActivationReceiptReaderPort,
  RunnerOperationsLedgerPort,
} from "../domain/model.js";
import type {
  RunnerIdentity,
  StepObservation,
} from "@reviewrouter/features-release-rollout";
export class ReleaseAuthorityService {
  constructor(
    private readonly repository: ReleaseAuthorityLedgerPort,
    private readonly permitInstaller?: ActivationPermitInstallerPort,
    private readonly targetReceiptReader?: TargetActivationReceiptReaderPort,
  ) {}
  claim = (input: RolloutBinding) => this.repository.claim(input);
  cas = (input: Parameters<ReleaseAuthorityLedgerPort["compareAndSet"]>[0]) =>
    this.repository.compareAndSet(input);
  markUncertain = (input: RolloutBinding) =>
    this.repository.markActivationUncertain(input);
  fenceTargetSwitch = (
    input: RolloutBinding & { previousReceiptSha256: string },
  ) => this.repository.fenceTargetSwitch(input);
  authorizeActivation = (
    input: Parameters<ReleaseAuthorityLedgerPort["authorizeActivation"]>[0],
  ) => this.repository.authorizeActivation(input);
  authorizeAndInstall = async (
    input: Parameters<ReleaseAuthorityLedgerPort["authorizeActivation"]>[0],
  ) => {
    const authorization = await this.repository.authorizeActivation(input);
    if (!this.permitInstaller)
      throw new Error("activation_permit_installer_unavailable");
    await this.permitInstaller.install(authorization);
    return authorization;
  };
  finalize = async (
    input: Parameters<ReleaseAuthorityLedgerPort["finalizeActivation"]>[0],
  ) => {
    if (!this.targetReceiptReader)
      throw new Error("target_activation_receipt_reader_unavailable");
    const receipt = await this.targetReceiptReader.read(
      input.authorization.rolloutId,
    );
    if (!receipt) throw new Error("target_activation_receipt_missing");
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
    return this.repository.finalizeActivation(input);
  };
  state = (
    input: Parameters<ReleaseAuthorityLedgerPort["activationState"]>[0],
  ) => this.repository.activationState(input);
  authorityState = (
    input: Parameters<ReleaseAuthorityLedgerPort["authorityState"]>[0],
  ) => this.repository.authorityState(input);
  verifyFinalAuthority = (
    input: Parameters<ReleaseAuthorityLedgerPort["verifyFinalAuthority"]>[0],
  ) => this.repository.verifyFinalAuthority(input);
}

export class ProviderAuthorityDecisionService {
  constructor(private readonly repository: ReleaseAuthorityLedgerPort) {}
  decide = (
    input: Parameters<ReleaseAuthorityLedgerPort["decideProviderOperation"]>[0],
  ) => this.repository.decideProviderOperation(input);
}

export class RunnerOperationsService {
  constructor(private readonly repository: RunnerOperationsLedgerPort) {}
  persistIntent = (input: ProvisioningIntent) =>
    this.repository.persistIntent(input);
  listIntents = (rolloutId: string) => this.repository.listIntents(rolloutId);
  recordIntentOutcome = (
    input: Parameters<RunnerOperationsLedgerPort["recordIntentOutcome"]>[0],
  ) => this.repository.recordIntentOutcome(input);
  persistJob = (input: PersistedJob) => this.repository.persistJob(input);
  listOpenJobs = (rolloutId: string) => this.repository.listOpenJobs(rolloutId);
  persistIdentity = (
    jobId: string,
    identity: RunnerIdentity,
    observation: StepObservation,
  ) => this.repository.persistIdentity(jobId, identity, observation);
  currentRunner = (rolloutId: string, lifecycle: "role" | "cutover") =>
    this.repository.currentRunner(rolloutId, lifecycle);
  markTerminal = (jobId: string, observation: StepObservation) =>
    this.repository.markTerminal(jobId, observation);
  cleanupObservation = (jobId: string) =>
    this.repository.cleanupObservation(jobId);
  cleanupWitness = (jobId: string) => this.repository.cleanupWitness(jobId);
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

export class ReleaseRolloutReconciliationService {
  constructor(private readonly repository: ReleaseRolloutReconciliationPort) {}
  reconcile = (rolloutId: string) => this.repository.reconcile(rolloutId);
}
