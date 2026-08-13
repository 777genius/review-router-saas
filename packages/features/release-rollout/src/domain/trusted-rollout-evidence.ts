import {
  canonicalJson,
  sha256Canonical,
  type ActivationReceipt,
  type DatabaseGenerationIdentity,
  type ReleaseExecutionIdentity,
  RolloutStep,
  type RunnerIdentity,
  type StepReceipt,
} from "./release-rollout";
import {
  assertVerifiedReleaseImageProvenance,
  type VerifiedReleaseImageProvenance,
} from "./release-image-provenance";

export interface BackupIdentity {
  readonly renderResourceId: string;
  readonly internalHostname: string;
  readonly databaseName: string;
  readonly systemIdentifier: string;
  readonly lsn: string;
  readonly capturedAt: string;
  readonly recoveryWindowStartsAt: string | null;
  readonly recoveryWindowEndsAt: string;
  readonly dumpSha256: string;
  readonly externalWitnessSha256: string;
  readonly recoveryStatus: "AVAILABLE";
}
export interface QuiescenceEvidence {
  readonly writerServices: readonly {
    readonly serviceId: string;
    readonly suspended: true;
    readonly observedAt: string;
  }[];
  readonly aclSha256: string;
  readonly stabilizationSeries: readonly number[];
  readonly reconnectDeniedRoles: readonly string[];
  readonly legacyAmbiguity: LegacyAmbiguityEvidence;
  readonly complete: true;
}
export interface LegacyAmbiguityEvidence {
  readonly inventorySha256: string;
  readonly activeLeaseIds: readonly string[];
  readonly fetchedSetupIds: readonly string[];
  readonly pendingIntentIds: readonly string[];
  readonly intentStatuses: readonly string[];
  readonly observations: readonly [
    { readonly observedAt: string; readonly inventorySha256: string },
    { readonly observedAt: string; readonly inventorySha256: string },
  ];
  readonly stable: true;
}
export interface EquivalenceEvidence {
  readonly tables: readonly {
    readonly table: string;
    readonly sourceRows: number;
    readonly targetRows: number;
    readonly sourceSha256: string;
    readonly targetSha256: string;
  }[];
  readonly catalogSha256: Readonly<
    Record<
      | "sequences"
      | "columnsDefaults"
      | "constraintsIndexesTriggers"
      | "policiesRls"
      | "functionsViewsSchemas"
      | "aclOwnershipDefaults"
      | "migrationHistory",
      string
    >
  >;
  readonly equivalent: true;
  readonly streamingHash: true;
  readonly maxProcessBufferBytes: number;
}
export interface CleanupEvidence {
  readonly renderJobId: string;
  readonly providerStatus: "succeeded" | "failed" | "canceled";
  readonly listenerStopped: true;
  readonly workspaceRemoved: true;
  readonly credentialProcessGone: true;
  readonly cleanupCanary: string;
  readonly observedAt: string;
}
export interface LegacyReconciliationEvidence {
  readonly version: 1;
  readonly acknowledgement: "all_prior_installers_and_writers_are_stopped";
  readonly inventory: Readonly<{
    activeLeaseIds: readonly string[];
    fetchedSetupIds: readonly string[];
    pendingIntentIds: readonly string[];
    intentStatuses: readonly string[];
  }>;
  readonly inventorySha256: string;
  readonly stableSamples: 2;
  readonly after: Readonly<{
    activeLeaseIds: readonly [];
    fetchedSetupIds: readonly [];
    pendingIntentIds: readonly [];
    intentStatuses: readonly string[];
  }>;
  readonly status: "reconciled";
}
export interface TrustedRolloutEvidence {
  readonly schemaVersion: 5;
  readonly rolloutId: string;
  readonly releaseCommitSha: string;
  readonly releaseImageProvenance: VerifiedReleaseImageProvenance;
  readonly targetDeploys: readonly {
    readonly serviceId: string;
    readonly deployId: string;
    readonly imageDigest: string;
  }[];
  readonly execution: ReleaseExecutionIdentity;
  readonly runners: readonly [RunnerIdentity, RunnerIdentity];
  readonly source: DatabaseGenerationIdentity;
  readonly target: DatabaseGenerationIdentity;
  readonly backup: BackupIdentity;
  readonly quiescence: QuiescenceEvidence;
  readonly equivalence: EquivalenceEvidence;
  readonly legacyReconciliation: LegacyReconciliationEvidence;
  readonly protectedEnvironmentPreflightSha256: string;
  readonly receipts: readonly StepReceipt[];
  readonly activation: ActivationReceipt;
  readonly resumedTargetDeployIds: readonly string[];
  readonly liveCanarySha256: string;
  readonly cleanups: readonly [CleanupEvidence, CleanupEvidence];
  readonly assembledAt: string;
  readonly evidenceSha256: string;
}

const digest = /^sha256:[a-f0-9]{64}$/u;
const sha = /^[a-f0-9]{40}$/u;
const timestamp = (value: string): boolean => {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};
const exact = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export function assembleTrustedRolloutEvidence(
  value: Omit<TrustedRolloutEvidence, "schemaVersion" | "evidenceSha256">,
): TrustedRolloutEvidence {
  const unsigned = Object.freeze({ ...value, schemaVersion: 5 as const });
  const evidence = Object.freeze({
    ...unsigned,
    evidenceSha256: `sha256:${sha256Canonical(unsigned)}`,
  });
  return assertTrustedRolloutEvidence(evidence);
}

export function assertTrustedRolloutEvidence(
  value: TrustedRolloutEvidence,
): TrustedRolloutEvidence {
  if (
    !exact(value, [
      "schemaVersion",
      "rolloutId",
      "releaseCommitSha",
      "releaseImageProvenance",
      "targetDeploys",
      "execution",
      "runners",
      "source",
      "target",
      "backup",
      "quiescence",
      "equivalence",
      "legacyReconciliation",
      "protectedEnvironmentPreflightSha256",
      "receipts",
      "activation",
      "resumedTargetDeployIds",
      "liveCanarySha256",
      "cleanups",
      "assembledAt",
      "evidenceSha256",
    ]) ||
    value.schemaVersion !== 5 ||
    !sha.test(value.releaseCommitSha) ||
    value.execution.runAttempt !== 1 ||
    value.execution.event !== "workflow_dispatch" ||
    value.execution.controlRepository.split("/")[0] !==
      value.execution.organization ||
    value.source.majorVersion !== 16 ||
    value.target.majorVersion !== 17 ||
    value.source.systemIdentifier === value.target.systemIdentifier ||
    value.backup.renderResourceId !== value.source.renderResourceId ||
    value.backup.internalHostname !== value.source.internalHostname ||
    value.backup.databaseName !== value.source.databaseName ||
    value.backup.systemIdentifier !== value.source.systemIdentifier ||
    !digest.test(value.backup.dumpSha256) ||
    !digest.test(value.backup.externalWitnessSha256) ||
    !timestamp(value.backup.capturedAt) ||
    value.quiescence.complete !== true ||
    !value.quiescence.writerServices.length ||
    value.quiescence.stabilizationSeries.length < 3 ||
    value.quiescence.stabilizationSeries.some((count) => count !== 0) ||
    value.quiescence.reconnectDeniedRoles.length !== 4 ||
    !digest.test(value.quiescence.aclSha256) ||
    !digest.test(value.quiescence.legacyAmbiguity.inventorySha256) ||
    value.quiescence.legacyAmbiguity.stable !== true ||
    value.quiescence.legacyAmbiguity.observations.length !== 2 ||
    value.quiescence.legacyAmbiguity.observations.some(
      (item) =>
        !timestamp(item.observedAt) ||
        item.inventorySha256 !==
          value.quiescence.legacyAmbiguity.inventorySha256,
    ) ||
    Date.parse(value.quiescence.legacyAmbiguity.observations[1].observedAt) <=
      Date.parse(value.quiescence.legacyAmbiguity.observations[0].observedAt) ||
    value.equivalence.equivalent !== true ||
    value.equivalence.streamingHash !== true ||
    value.equivalence.maxProcessBufferBytes > 8 * 1024 * 1024 ||
    !value.equivalence.tables.length ||
    value.equivalence.tables.some(
      (table) =>
        table.sourceRows !== table.targetRows ||
        table.sourceSha256 !== table.targetSha256 ||
        !digest.test(table.sourceSha256),
    ) ||
    Object.keys(value.equivalence.catalogSha256).length !== 7 ||
    Object.values(value.equivalence.catalogSha256).some(
      (item) => !digest.test(item),
    ) ||
    value.legacyReconciliation.version !== 1 ||
    value.legacyReconciliation.acknowledgement !==
      "all_prior_installers_and_writers_are_stopped" ||
    value.legacyReconciliation.stableSamples !== 2 ||
    value.legacyReconciliation.status !== "reconciled" ||
    !digest.test(value.legacyReconciliation.inventorySha256) ||
    value.legacyReconciliation.after.activeLeaseIds.length !== 0 ||
    value.legacyReconciliation.after.fetchedSetupIds.length !== 0 ||
    value.legacyReconciliation.after.pendingIntentIds.length !== 0 ||
    canonicalJson(value.legacyReconciliation.inventory) !==
      canonicalJson({
        activeLeaseIds: value.quiescence.legacyAmbiguity.activeLeaseIds,
        fetchedSetupIds: value.quiescence.legacyAmbiguity.fetchedSetupIds,
        pendingIntentIds: value.quiescence.legacyAmbiguity.pendingIntentIds,
        intentStatuses: value.quiescence.legacyAmbiguity.intentStatuses,
      }) ||
    value.legacyReconciliation.inventorySha256 !==
      value.quiescence.legacyAmbiguity.inventorySha256 ||
    !digest.test(value.protectedEnvironmentPreflightSha256) ||
    !digest.test(value.liveCanarySha256) ||
    !timestamp(value.assembledAt) ||
    value.runners.length !== 2 ||
    value.cleanups.length !== 2 ||
    !value.resumedTargetDeployIds.length
  )
    throw new Error("trusted_rollout_evidence_invariant_failed");
  assertVerifiedReleaseImageProvenance(value.releaseImageProvenance, {
    sourceRepository: value.execution.controlRepository,
    sourceRevision: value.releaseCommitSha,
    imageRepository: value.releaseImageProvenance.claim.imageRepository,
    verificationPolicySha256:
      value.releaseImageProvenance.verification.policySha256,
  });
  if (
    value.targetDeploys.length === 0 ||
    new Set(value.targetDeploys.map((deploy) => deploy.serviceId)).size !==
      value.targetDeploys.length ||
    new Set(value.targetDeploys.map((deploy) => deploy.deployId)).size !==
      value.targetDeploys.length ||
    value.targetDeploys.some(
      (deploy) =>
        !/^[A-Za-z0-9_-]+$/u.test(deploy.serviceId) ||
        !/^[A-Za-z0-9_-]+$/u.test(deploy.deployId) ||
        deploy.imageDigest !==
          value.releaseImageProvenance.identity.imageDigest,
    )
  )
    throw new Error("trusted_rollout_evidence_target_image_invalid");
  const zero = `sha256:${"0".repeat(64)}`;
  const requiredSteps = [
    RolloutStep.ClaimRollout,
    RolloutStep.VerifyProtectedEnvironment,
    RolloutStep.FreezeProviderServices,
    RolloutStep.ProvisionRoleRunner,
    RolloutStep.CaptureSourceBackup,
    RolloutStep.QuiesceSource,
    RolloutStep.CopyDatabaseGeneration,
    RolloutStep.BootstrapTargetRoles,
    RolloutStep.VerifyDataEquivalence,
    RolloutStep.CleanupRoleRunner,
    RolloutStep.ProvisionCutoverRunner,
    RolloutStep.RunReleaseMigration,
    RolloutStep.StageTargetServices,
    RolloutStep.ActivateTargetGeneration,
    RolloutStep.CleanupCutoverRunner,
    RolloutStep.ResumeTargetServices,
    RolloutStep.VerifyLiveCanary,
  ];
  if (
    value.receipts.length !== requiredSteps.length ||
    value.receipts.some(
      (receipt, index) => receipt.step !== requiredSteps[index],
    )
  )
    throw new Error("trusted_rollout_evidence_required_receipts_missing");
  for (let index = 0; index < value.receipts.length; index += 1) {
    const receipt = value.receipts[index]!;
    const previous = value.receipts[index - 1]?.receiptSha256 ?? zero;
    if (
      receipt.rolloutId !== value.rolloutId ||
      receipt.expectedCommitSha !== value.releaseCommitSha ||
      receipt.runId !== value.execution.runId ||
      receipt.runAttempt !== value.execution.runAttempt ||
      receipt.sourceSystemIdentifier !== value.source.systemIdentifier ||
      receipt.targetSystemIdentifier !== value.target.systemIdentifier ||
      receipt.previousReceiptSha256 !== previous ||
      !digest.test(receipt.receiptSha256) ||
      !digest.test(receipt.observationSha256) ||
      receipt.receiptSha256 !==
        `sha256:${sha256Canonical(
          Object.fromEntries(
            Object.entries(receipt).filter(([key]) => key !== "receiptSha256"),
          ),
        )}`
    )
      throw new Error("trusted_rollout_evidence_receipt_chain_invalid");
  }
  if (
    value.receipts.find(
      (receipt) => receipt.step === RolloutStep.VerifyProtectedEnvironment,
    )?.observationSha256 !== value.protectedEnvironmentPreflightSha256 ||
    canonicalJson(
      value.receipts.find(
        (receipt) => receipt.step === RolloutStep.ResumeTargetServices,
      )?.provider?.renderDeployIds,
    ) !== canonicalJson(value.resumedTargetDeployIds) ||
    canonicalJson(value.targetDeploys.map((deploy) => deploy.deployId)) !==
      canonicalJson(value.resumedTargetDeployIds) ||
    !value.receipts.some(
      (receipt) => canonicalJson(receipt) === canonicalJson(value.activation),
    ) ||
    value.activation.firstWriteBoundary !== true ||
    value.activation.sourceSystemIdentifier !== value.source.systemIdentifier ||
    value.activation.targetSystemIdentifier !== value.target.systemIdentifier ||
    !digest.test(value.activation.firstWriteReceiptSha256) ||
    !digest.test(value.activation.catalogFactsSha256)
  )
    throw new Error("trusted_rollout_evidence_activation_invalid");
  value.runners.forEach((runner, index) => {
    if (
      runner.organization !== value.execution.organization ||
      runner.repository !== value.execution.controlRepository ||
      runner.workflowPath !== value.execution.workflowPath ||
      runner.workflowRef !== value.execution.workflowRef ||
      runner.runId !== value.execution.runId ||
      runner.runAttempt !== value.execution.runAttempt ||
      runner.commitSha !== value.releaseCommitSha ||
      runner.renderJobId !== value.cleanups[index]?.renderJobId ||
      value.cleanups[index]?.cleanupCanary !== runner.cleanupCanary ||
      value.cleanups[index]?.listenerStopped !== true ||
      value.cleanups[index]?.workspaceRemoved !== true ||
      value.cleanups[index]?.credentialProcessGone !== true ||
      !timestamp(value.cleanups[index]!.observedAt)
    )
      throw new Error("trusted_rollout_evidence_runner_lifecycle_invalid");
  });
  const latestPrerequisite = Math.max(
    ...value.cleanups.map((cleanup) => Date.parse(cleanup.observedAt)),
    Date.parse(value.activation.observedAt),
  );
  if (Date.parse(value.assembledAt) <= latestPrerequisite)
    throw new Error("trusted_rollout_evidence_assembled_too_early");
  const { evidenceSha256, ...unsigned } = value;
  if (evidenceSha256 !== `sha256:${sha256Canonical(unsigned)}`)
    throw new Error("trusted_rollout_evidence_digest_mismatch");
  if (
    /postgres(?:ql)?:\/\/|BEGIN [A-Z ]*PRIVATE KEY|password|token/iu.test(
      canonicalJson(value),
    )
  )
    throw new Error("trusted_rollout_evidence_contains_secret");
  return value;
}
