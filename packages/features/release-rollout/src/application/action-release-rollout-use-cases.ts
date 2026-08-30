import {
  assertVerifiedActionReleaseV2,
  fixedCanaryTargetIdentity,
  immutableEvidenceArtifactLocator,
  sameActionRef,
  terminalCanaryReceiptIdentityDigest,
  verifiedActionReleaseV2,
  type ActionRepositoryIdentity,
  type ImmutableEvidenceArtifactLocator,
  type Sha256,
  type VerifiedActionReleaseV2,
  type WorkflowActionSelection,
} from "../domain/action-release-identity";
import {
  abortActionReleaseCandidate,
  acceptFixedTerminalCanaryReceipt,
  ActionReleaseAdmissionEffectOperation,
  ActionReleaseRolloutPhase,
  armFixedActionReleaseCanary,
  authorizeFixedActionReleaseCanaryProvisioning,
  assertUncertainPromotionReachedCandidate,
  beginActionReleaseOverlapStaging,
  beginActionReleasePromotion,
  beginActionReleaseRecoveryAdmissionReopen,
  beginFixedTerminalCanaryReceiptVerification,
  beginPredecessorRemoval,
  beginPredecessorAdmissionClose,
  clearActionReleaseOverlapAfterDefiniteNoEffect,
  completeActionReleasePromotion,
  completeActionReleaseRecoveryAdmissionReopen,
  completePredecessorRemoval,
  confirmFixedActionReleaseCanaryProvisioned,
  confirmActionReleaseRecoveryAdmissionClosed,
  enterActionReleaseRecoveryOnly,
  enterUncertainPromotionRecoveryOnly,
  exactProductionActionConfiguration,
  markActionReleaseOverlapUncertain,
  markActionReleaseAdmissionEffectUncertain,
  markActionReleasePromotionUncertain,
  markFixedActionReleaseCanaryProvisioningUncertain,
  markFixedTerminalCanaryReceiptVerificationUncertain,
  markPredecessorRemovalUncertain,
  markPredecessorAdmissionCloseUncertain,
  prepareActionReleasePromotion,
  recordPredecessorAdmissionFence,
  recordPredecessorZeroCapture,
  registerActionReleaseCandidate,
  resolveAttestedLiveNamespaceSelection,
  resolveIsolatedCandidateSelection,
  resolveProductionPrimarySelection,
  resumeFixedTerminalCanaryReceiptVerification,
  stageActionReleaseOverlap,
  type ActionReleaseRollout,
  type CandidateAbortedActionReleaseRollout,
  type CandidateRegisteredActionReleaseRollout,
  type CanaryArmedActionReleaseRollout,
  type CanaryVerifiedActionReleaseRollout,
  type IsolatedCandidateSelectionContext,
  type OverlapStagedActionReleaseRollout,
  type PromotionPreparedActionReleaseRollout,
  type PromotingActionReleaseRollout,
  type PromotionUncertainActionReleaseRollout,
  type RecoveryOnlyActionReleaseRollout,
  type SteadyActionReleaseRollout,
} from "../domain/action-release-rollout";
import {
  predecessorRemovalProof,
  zeroPredecessorReferenceCapture,
} from "../domain/live-action-reference-inventory";
import {
  ActionReleaseRepositoryWriteResult,
  type ActionReleaseClockPort,
  type ActionReleaseDigestPort,
  type ActionReleaseIdPort,
  type ActionReleaseRolloutRepositoryPort,
  type AdmissionFencePort,
  type CandidateWorkflowProvisioningPort,
  type ExactActionReleaseVerificationPorts,
  type FixedCanaryTargetPort,
  type FixedTerminalCanaryReceiptVerifierPort,
  type LiveActionReferenceInventoryPort,
  type ProductionActionConfigurationOutcome,
  type ProductionActionConfigurationPort,
  type RepositoryActionEligibilityDecision,
  type RepositoryActionEligibilityPort,
  type RepositoryActionSelectionContext,
} from "./action-release-rollout-ports";

export const ActionReleaseApplicationErrorCode = Object.freeze({
  StaleVersion: "action_release_rollout_stale_version",
  ActiveCandidateConflict: "action_release_active_candidate_conflict",
  AttemptConflict: "action_release_attempt_conflict",
  ReceiptConflict: "action_release_receipt_conflict",
  ArtifactConflict: "action_release_artifact_conflict",
  ReceiptAlreadyConsumed: "action_release_receipt_already_consumed",
  EffectUncertain: "action_release_effect_uncertain",
  ExactReleaseVerificationFailed: "exact_action_release_verification_failed",
  FixedTargetMismatch: "fixed_canary_target_mismatch",
  ProvisioningMismatch: "fixed_canary_provisioning_mismatch",
  InventoryStale: "live_action_reference_inventory_stale",
  EligibilityRejected: "action_release_eligibility_rejected",
  ReconcileOnly: "action_release_reconcile_only",
} as const);

export type ActionReleaseApplicationErrorCode =
  (typeof ActionReleaseApplicationErrorCode)[keyof typeof ActionReleaseApplicationErrorCode];

export class ActionReleaseApplicationError extends Error {
  readonly code: ActionReleaseApplicationErrorCode;

  constructor(code: ActionReleaseApplicationErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "ActionReleaseApplicationError";
    this.code = code;
  }
}

function applicationFail(
  code: ActionReleaseApplicationErrorCode,
  cause?: unknown,
): never {
  throw new ActionReleaseApplicationError(
    code,
    cause === undefined ? undefined : { cause },
  );
}

function assertExpectedVersion(
  rollout: ActionReleaseRollout,
  expectedAggregateVersion: bigint,
): void {
  if (rollout.aggregateVersion !== expectedAggregateVersion)
    applicationFail(ActionReleaseApplicationErrorCode.StaleVersion);
}

function assertExactCandidateAttempt(
  rollout: ActionReleaseRollout,
  attemptId: string,
): void {
  if (!("candidate" in rollout) || rollout.candidate.attemptId !== attemptId)
    applicationFail(ActionReleaseApplicationErrorCode.AttemptConflict);
}

function assertWriteCommitted(result: string): void {
  switch (result) {
    case ActionReleaseRepositoryWriteResult.Committed:
      return;
    case ActionReleaseRepositoryWriteResult.Stale:
      return applicationFail(ActionReleaseApplicationErrorCode.StaleVersion);
    case ActionReleaseRepositoryWriteResult.ActiveCandidateConflict:
      return applicationFail(
        ActionReleaseApplicationErrorCode.ActiveCandidateConflict,
      );
    case ActionReleaseRepositoryWriteResult.AttemptConflict:
      return applicationFail(ActionReleaseApplicationErrorCode.AttemptConflict);
    case ActionReleaseRepositoryWriteResult.ReceiptConflict:
      return applicationFail(ActionReleaseApplicationErrorCode.ReceiptConflict);
    case ActionReleaseRepositoryWriteResult.ArtifactConflict:
      return applicationFail(
        ActionReleaseApplicationErrorCode.ArtifactConflict,
      );
    case ActionReleaseRepositoryWriteResult.ReceiptAlreadyConsumed:
      return applicationFail(
        ActionReleaseApplicationErrorCode.ReceiptAlreadyConsumed,
      );
    default:
      return applicationFail(ActionReleaseApplicationErrorCode.StaleVersion);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

export class VerifyExactTaggedActionRelease {
  constructor(private readonly ports: ExactActionReleaseVerificationPorts) {}

  async execute(input: {
    readonly repository: ActionRepositoryIdentity;
    readonly tag: string;
  }): Promise<VerifiedActionReleaseV2> {
    try {
      const source = await this.ports.source.inspectExact(input);
      if (
        source.identity.repository.repositoryId !==
          input.repository.repositoryId ||
        source.identity.repository.fullName.toLowerCase() !==
          input.repository.fullName.toLowerCase() ||
        source.identity.tag !== input.tag ||
        source.detached !== true ||
        source.clean !== true ||
        source.untrackedInputs !== false ||
        source.shallow !== false ||
        source.replaceRefs !== false ||
        source.executableSymlink !== false ||
        source.ambiguousTag !== false
      )
        applicationFail(
          ActionReleaseApplicationErrorCode.ExactReleaseVerificationFailed,
        );
      const build = await this.ports.build.rebuildTwice({ source });
      if (
        build.firstDetachedPathDigest === build.secondDetachedPathDigest ||
        !bytesEqual(build.firstExecutableBytes, build.secondExecutableBytes) ||
        !bytesEqual(build.firstExecutableBytes, source.committedExecutableBytes)
      )
        applicationFail(
          ActionReleaseApplicationErrorCode.ExactReleaseVerificationFailed,
        );
      const committedDigest = this.ports.digest.digestBytes(
        source.committedExecutableBytes,
      );
      if (
        committedDigest !== source.identity.executable.sha256 ||
        source.identity.executable.byteLength !==
          source.committedExecutableBytes.byteLength
      )
        applicationFail(
          ActionReleaseApplicationErrorCode.ExactReleaseVerificationFailed,
        );
      const published = await this.ports.published.fetchExact({
        repository: input.repository,
        tag: input.tag,
        commitSha: source.identity.tagRef.peeledCommitSha,
      });
      if (
        !bytesEqual(published.executableBytes, source.committedExecutableBytes)
      )
        applicationFail(
          ActionReleaseApplicationErrorCode.ExactReleaseVerificationFailed,
        );
      const publishedDigest = this.ports.digest.digestBytes(
        published.executableBytes,
      );
      const publishedArtifactDigest = this.ports.digest.digestBytes(
        published.artifactBytes,
      );
      if (
        publishedDigest !== published.publishedBundle.executableSha256 ||
        publishedArtifactDigest !== published.publishedBundle.artifactSha256
      )
        applicationFail(
          ActionReleaseApplicationErrorCode.ExactReleaseVerificationFailed,
        );
      const attestation = await this.ports.attestation.verifyExact({
        source,
        publishedBundle: published.publishedBundle,
        release: published.release,
        installer: published.installer,
      });
      if (attestation.expectedExecutableSha256 !== publishedDigest)
        applicationFail(
          ActionReleaseApplicationErrorCode.ExactReleaseVerificationFailed,
        );
      const tagReadback = await this.ports.source.reobserveTag(input);
      if (
        tagReadback.tagRef.objectSha !== source.identity.tagRef.objectSha ||
        tagReadback.tagRef.objectType !== source.identity.tagRef.objectType ||
        tagReadback.tagRef.peeledCommitSha !==
          source.identity.tagRef.peeledCommitSha ||
        tagReadback.commitTreeSha !== source.identity.commitTreeSha
      )
        applicationFail(
          ActionReleaseApplicationErrorCode.ExactReleaseVerificationFailed,
        );
      return verifiedActionReleaseV2({
        ...source.identity,
        toolchainSha256: build.toolchainSha256,
        dependencyInstallationSha256: build.dependencyInstallationSha256,
        rebuiltExecutableSha256: this.ports.digest.digestBytes(
          build.firstExecutableBytes,
        ),
        publishedBundle: published.publishedBundle,
        release: published.release,
        attestation: attestation.attestation,
        trustedWorkflow: attestation.trustedWorkflow,
        installer: published.installer,
      });
    } catch (error) {
      if (error instanceof ActionReleaseApplicationError) throw error;
      applicationFail(
        ActionReleaseApplicationErrorCode.ExactReleaseVerificationFailed,
        error,
      );
    }
  }
}

interface BasicUseCasePorts {
  readonly repository: ActionReleaseRolloutRepositoryPort;
  readonly clock: ActionReleaseClockPort;
}

export class RegisterActionReleaseCandidate {
  constructor(
    private readonly ports: BasicUseCasePorts & {
      readonly id: ActionReleaseIdPort;
    },
  ) {}

  async execute(input: {
    readonly expectedAggregateVersion: bigint;
    readonly candidateRelease: VerifiedActionReleaseV2;
    readonly policyRevision: bigint;
  }): Promise<CandidateRegisteredActionReleaseRollout> {
    const current = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(current, input.expectedAggregateVersion);
    if (
      current.phase !== ActionReleaseRolloutPhase.Steady &&
      current.phase !== ActionReleaseRolloutPhase.RecoveryOnly &&
      current.phase !== ActionReleaseRolloutPhase.CandidateAborted
    )
      applicationFail(
        ActionReleaseApplicationErrorCode.ActiveCandidateConflict,
      );
    const next = registerActionReleaseCandidate(current, {
      attemptId: this.ports.id.nextId("attempt"),
      candidateRelease: assertVerifiedActionReleaseV2(input.candidateRelease),
      policyRevision: input.policyRevision,
      registeredAt: this.ports.clock.now(),
    });
    assertWriteCommitted(
      await this.ports.repository.createCandidateCas({
        expectedAggregateVersion: current.aggregateVersion,
        next,
      }),
    );
    return next;
  }
}

export class StageCandidateOverlap {
  constructor(
    private readonly ports: BasicUseCasePorts & {
      readonly id: ActionReleaseIdPort;
      readonly digest: ActionReleaseDigestPort;
      readonly production: ProductionActionConfigurationPort;
    },
  ) {}

  async execute(input: {
    readonly expectedAggregateVersion: bigint;
    readonly attemptId: string;
  }): Promise<
    OverlapStagedActionReleaseRollout | CandidateRegisteredActionReleaseRollout
  > {
    const current = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(current, input.expectedAggregateVersion);
    if (current.phase !== ActionReleaseRolloutPhase.CandidateRegistered)
      applicationFail(
        ActionReleaseApplicationErrorCode.ActiveCandidateConflict,
      );
    assertExactCandidateAttempt(current, input.attemptId);
    if (current.overlapEffect !== null)
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    const expected = await this.ports.production.readExact();
    const startedAt = this.ports.clock.now();
    const intent = beginActionReleaseOverlapStaging(current, {
      attemptId: input.attemptId,
      expectedConfiguration: expected,
      effectId: this.ports.id.nextId("effect"),
      effectEpoch: current.aggregateVersion + 1n,
      startedAt,
    });
    assertWriteCommitted(
      await this.ports.repository.compareAndSet({
        expectedAggregateVersion: current.aggregateVersion,
        next: intent,
      }),
    );
    const effect = intent.overlapEffect;
    if (!effect)
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    let outcome: ProductionActionConfigurationOutcome;
    try {
      outcome = await this.ports.production.stageAdditiveOverlap({
        expected: effect.expectedConfiguration,
        primaryRef: intent.primaryRef,
        candidateRelease: intent.candidate.candidateRelease,
        candidateAttemptId: intent.candidate.attemptId,
        effectId: effect.effectId,
        effectEpoch: effect.epoch,
      });
    } catch {
      outcome = {
        status: "uncertain",
        observationDigest: this.ports.digest.digestCanonical({
          kind: "overlap_provider_exception",
          attemptId: intent.candidate.attemptId,
          effectId: effect.effectId,
          effectEpoch: effect.epoch.toString(),
        }),
      };
    }
    if (outcome.status === "exact") {
      const staged = stageActionReleaseOverlap(intent, {
        attemptId: input.attemptId,
        configuration: outcome.configuration,
      });
      assertWriteCommitted(
        await this.ports.repository.compareAndSet({
          expectedAggregateVersion: intent.aggregateVersion,
          next: staged,
        }),
      );
      return staged;
    }
    if (outcome.status === "definite_no_effect") {
      const cleared = clearActionReleaseOverlapAfterDefiniteNoEffect(intent, {
        attemptId: input.attemptId,
        configuration: outcome.configuration,
        clearedAt: this.ports.clock.now(),
      });
      assertWriteCommitted(
        await this.ports.repository.compareAndSet({
          expectedAggregateVersion: intent.aggregateVersion,
          next: cleared,
        }),
      );
      return cleared;
    }
    const uncertain = markActionReleaseOverlapUncertain(intent, {
      attemptId: input.attemptId,
      observationDigest: outcome.observationDigest,
      observedAt: this.ports.clock.now(),
    });
    assertWriteCommitted(
      await this.ports.repository.compareAndSet({
        expectedAggregateVersion: intent.aggregateVersion,
        next: uncertain,
      }),
    );
    return uncertain;
  }
}

export class ReconcileCandidateOverlap {
  constructor(
    private readonly ports: BasicUseCasePorts & {
      readonly digest: ActionReleaseDigestPort;
      readonly production: ProductionActionConfigurationPort;
    },
  ) {}

  async execute(input: {
    readonly expectedAggregateVersion: bigint;
    readonly attemptId: string;
  }): Promise<
    OverlapStagedActionReleaseRollout | CandidateRegisteredActionReleaseRollout
  > {
    const current = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(current, input.expectedAggregateVersion);
    if (
      current.phase !== ActionReleaseRolloutPhase.CandidateRegistered ||
      current.overlapEffect === null
    )
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    assertExactCandidateAttempt(current, input.attemptId);
    let outcome: ProductionActionConfigurationOutcome;
    try {
      outcome = await this.ports.production.reconcileAdditiveOverlap({
        expected: current.overlapEffect.expectedConfiguration,
        primaryRef: current.primaryRef,
        candidateRelease: current.candidate.candidateRelease,
        candidateAttemptId: current.candidate.attemptId,
        effect: current.overlapEffect,
      });
    } catch {
      outcome = {
        status: "uncertain",
        observationDigest: this.ports.digest.digestCanonical({
          kind: "overlap_reconciliation_exception",
          attemptId: current.candidate.attemptId,
          effectId: current.overlapEffect.effectId,
          effectEpoch: current.overlapEffect.epoch.toString(),
        }),
      };
    }
    if (outcome.status === "exact") {
      const staged = stageActionReleaseOverlap(current, {
        attemptId: input.attemptId,
        configuration: outcome.configuration,
      });
      assertWriteCommitted(
        await this.ports.repository.compareAndSet({
          expectedAggregateVersion: current.aggregateVersion,
          next: staged,
        }),
      );
      return staged;
    }
    if (outcome.status === "definite_no_effect") {
      const cleared = clearActionReleaseOverlapAfterDefiniteNoEffect(current, {
        attemptId: input.attemptId,
        configuration: outcome.configuration,
        clearedAt: this.ports.clock.now(),
      });
      assertWriteCommitted(
        await this.ports.repository.compareAndSet({
          expectedAggregateVersion: current.aggregateVersion,
          next: cleared,
        }),
      );
      return cleared;
    }
    const uncertain = markActionReleaseOverlapUncertain(current, {
      attemptId: input.attemptId,
      observationDigest: outcome.observationDigest,
      observedAt: this.ports.clock.now(),
    });
    assertWriteCommitted(
      await this.ports.repository.compareAndSet({
        expectedAggregateVersion: current.aggregateVersion,
        next: uncertain,
      }),
    );
    return uncertain;
  }
}

function candidateContextFromBinding(
  armed: CanaryArmedActionReleaseRollout,
): IsolatedCandidateSelectionContext {
  return {
    schemaVersion: 5,
    rolloutAttemptId: armed.candidate.attemptId,
    policyRevision: armed.candidate.policyRevision,
    githubRepositoryId: armed.canary.target.githubRepositoryId,
    githubRepositoryNodeId: armed.canary.target.githubRepositoryNodeId,
    repositoryFullName: armed.canary.target.repositoryFullName,
    providerInstanceId: armed.canary.target.providerInstanceId,
    pullRequestNumber: armed.canary.target.pullRequestNumber,
    reviewedHeadSha: armed.canary.reviewedHeadSha,
    namespaceId: armed.canary.namespaceId,
    namespaceEpoch: armed.canary.namespaceEpoch,
    challengeSha256: armed.canary.challengeSha256,
    reviewWorkflowPath: armed.canary.target.reviewWorkflowPath,
    interactionWorkflowPath: armed.canary.target.interactionWorkflowPath,
    reviewSource: armed.canary.reviewSource,
    interactionSource: armed.canary.interactionSource,
    bindingDigest: armed.canary.bindingDigest,
  };
}

function candidateEligibilityContext(
  armed: CanaryArmedActionReleaseRollout,
): RepositoryActionSelectionContext {
  return {
    githubRepositoryId: armed.canary.target.githubRepositoryId,
    repositoryFullName: armed.canary.target.repositoryFullName,
    providerInstanceId: armed.canary.target.providerInstanceId,
    namespaceId: armed.canary.namespaceId,
    namespaceEpoch: armed.canary.namespaceEpoch,
    workflowSourceDigest: armed.canary.bindingDigest,
  };
}

function eligibilityDecisionFromAuthorization(
  authorization: AuthorizedActionReleaseSelection,
): RepositoryActionEligibilityDecision {
  return {
    allowed: true,
    policyRevision: authorization.policyRevision,
    channelVersion: authorization.channelVersion,
    selectionDigest: authorization.selectionDigest,
    contextDigest: authorization.contextDigest,
    decisionDigest: authorization.decisionDigest,
  };
}

function provisioningEligibilityFromAuthorization(
  authorization: AuthorizedActionReleaseSelection,
) {
  if (authorization.phase !== ActionReleaseRolloutPhase.CanaryArmed)
    applicationFail(ActionReleaseApplicationErrorCode.EligibilityRejected);
  return Object.freeze({
    aggregateVersion: authorization.aggregateVersion,
    phase: authorization.phase,
    admissionMode: authorization.admissionMode,
    policyRevision: authorization.policyRevision,
    channelVersion: authorization.channelVersion,
    selectionDigest: authorization.selectionDigest,
    contextDigest: authorization.contextDigest,
    decisionDigest: authorization.decisionDigest,
  });
}

function exactSelectionContextDigest(
  digest: ActionReleaseDigestPort,
  context: RepositoryActionSelectionContext,
): Sha256 {
  return digest.digestCanonical({
    ...context,
    namespaceEpoch: context.namespaceEpoch?.toString() ?? null,
  });
}

function exactWorkflowActionSelectionDigest(
  digest: ActionReleaseDigestPort,
  selection: WorkflowActionSelection,
): Sha256 {
  return digest.digestCanonical({
    ...selection,
    ...(selection.kind === "production_primary"
      ? { channelVersion: selection.channelVersion.toString() }
      : {}),
    ...(selection.kind === "attested_live_namespace"
      ? { namespaceEpoch: selection.namespaceEpoch.toString() }
      : {}),
    ...(selection.kind === "isolated_candidate"
      ? {
          policyRevision: selection.policyRevision.toString(),
          namespaceEpoch: selection.namespaceEpoch.toString(),
        }
      : {}),
    actionRef: {
      repositoryId: selection.actionRef.repository.repositoryId,
      repositoryFullName: selection.actionRef.repository.fullName,
      commitSha: selection.actionRef.commitSha,
    },
  });
}

function persistedProvisioningAuthorization(
  rollout: CanaryArmedActionReleaseRollout,
  digest: ActionReleaseDigestPort,
): AuthorizedActionReleaseSelection {
  const eligibility = rollout.provisioning.eligibility;
  if (eligibility === null)
    applicationFail(ActionReleaseApplicationErrorCode.EligibilityRejected);
  const selection = resolveIsolatedCandidateSelection(
    rollout,
    candidateContextFromBinding(rollout),
  );
  const contextDigest = exactSelectionContextDigest(
    digest,
    candidateEligibilityContext(rollout),
  );
  const selectionDigest = exactWorkflowActionSelectionDigest(digest, selection);
  const expectedDecisionDigest = digest.digestCanonical({
    allowed: true,
    policyRevision: eligibility.policyRevision.toString(),
    channelVersion: eligibility.channelVersion.toString(),
    selectionDigest,
    contextDigest,
  });
  if (
    eligibility.aggregateVersion + 1n !== rollout.provisioning.epoch ||
    eligibility.phase !== ActionReleaseRolloutPhase.CanaryArmed ||
    eligibility.admissionMode !== rollout.admissionMode ||
    eligibility.policyRevision !== rollout.candidate.policyRevision ||
    eligibility.channelVersion !== rollout.channelVersion ||
    eligibility.selectionDigest !== selectionDigest ||
    eligibility.contextDigest !== contextDigest ||
    eligibility.decisionDigest !== expectedDecisionDigest
  )
    applicationFail(ActionReleaseApplicationErrorCode.EligibilityRejected);
  return authorizedActionReleaseSelection({
    selection,
    ...eligibility,
  });
}

export class ArmAndProvisionFixedCanary {
  constructor(
    private readonly ports: BasicUseCasePorts & {
      readonly target: FixedCanaryTargetPort;
      readonly provisioning: CandidateWorkflowProvisioningPort;
      readonly digest: ActionReleaseDigestPort;
      readonly eligibility: RepositoryActionEligibilityPort;
    },
  ) {}

  async execute(input: {
    readonly expectedAggregateVersion: bigint;
    readonly attemptId: string;
  }): Promise<CanaryArmedActionReleaseRollout> {
    const current = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(current, input.expectedAggregateVersion);
    if (current.phase !== ActionReleaseRolloutPhase.OverlapStaged)
      applicationFail(
        ActionReleaseApplicationErrorCode.ActiveCandidateConflict,
      );
    assertExactCandidateAttempt(current, input.attemptId);
    const target = fixedCanaryTargetIdentity(
      await this.ports.target.getFixedTarget(),
    );
    const binding = await this.ports.provisioning.prepareFixedBinding({
      target,
      rolloutAttemptId: current.candidate.attemptId,
      policyRevision: current.candidate.policyRevision,
      candidateRelease: current.candidate.candidateRelease,
    });
    if (
      this.ports.digest.digestCanonical(binding.target) !==
      this.ports.digest.digestCanonical(target)
    )
      applicationFail(ActionReleaseApplicationErrorCode.FixedTargetMismatch);
    const armed = armFixedActionReleaseCanary(current, {
      attemptId: input.attemptId,
      binding,
    });
    assertWriteCommitted(
      await this.ports.repository.compareAndSet({
        expectedAggregateVersion: current.aggregateVersion,
        next: armed,
      }),
    );
    const authorization = await new ResolveActionReleaseSelection({
      repository: this.ports.repository,
      eligibility: this.ports.eligibility,
      digest: this.ports.digest,
    }).isolatedCandidate({
      expectedAggregateVersion: armed.aggregateVersion,
      context: candidateContextFromBinding(armed),
      eligibilityContext: candidateEligibilityContext(armed),
    });
    const dispatching = authorizeFixedActionReleaseCanaryProvisioning(armed, {
      eligibility: provisioningEligibilityFromAuthorization(authorization),
      authorizedAt: this.ports.clock.now(),
    });
    assertWriteCommitted(
      await this.ports.repository.compareAndSet({
        expectedAggregateVersion: armed.aggregateVersion,
        next: dispatching,
      }),
    );
    let provisioned: Readonly<{ expectationDigest: Sha256 }>;
    try {
      provisioned = await this.ports.provisioning.provision({
        selection: authorization.selection as Extract<
          WorkflowActionSelection,
          { readonly kind: "isolated_candidate" }
        >,
        schemaVersion: 5,
        binding: dispatching.canary,
        eligibility: eligibilityDecisionFromAuthorization(authorization),
        effectId: dispatching.provisioning.effectId,
        effectEpoch: dispatching.provisioning.epoch,
      });
    } catch (error) {
      const uncertain = markFixedActionReleaseCanaryProvisioningUncertain(
        dispatching,
        {
          observationDigest: this.ports.digest.digestCanonical({
            kind: "candidate_provisioning_exception",
            attemptId: dispatching.candidate.attemptId,
            expectationDigest: dispatching.expectation.expectationDigest,
          }),
          observedAt: this.ports.clock.now(),
        },
      );
      assertWriteCommitted(
        await this.ports.repository.compareAndSet({
          expectedAggregateVersion: dispatching.aggregateVersion,
          next: uncertain,
        }),
      );
      applicationFail(ActionReleaseApplicationErrorCode.EffectUncertain, error);
    }
    if (
      provisioned.expectationDigest !==
      dispatching.expectation.expectationDigest
    ) {
      const uncertain = markFixedActionReleaseCanaryProvisioningUncertain(
        dispatching,
        {
          observationDigest: this.ports.digest.digestCanonical({
            kind: "candidate_provisioning_readback_mismatch",
            expected: dispatching.expectation.expectationDigest,
            observed: provisioned.expectationDigest,
          }),
          observedAt: this.ports.clock.now(),
        },
      );
      assertWriteCommitted(
        await this.ports.repository.compareAndSet({
          expectedAggregateVersion: dispatching.aggregateVersion,
          next: uncertain,
        }),
      );
      applicationFail(ActionReleaseApplicationErrorCode.ProvisioningMismatch);
    }
    const confirmed = confirmFixedActionReleaseCanaryProvisioned(dispatching, {
      expectationDigest: provisioned.expectationDigest,
      decisionDigest: authorization.decisionDigest,
      confirmedAt: this.ports.clock.now(),
    });
    assertWriteCommitted(
      await this.ports.repository.compareAndSet({
        expectedAggregateVersion: dispatching.aggregateVersion,
        next: confirmed,
      }),
    );
    return confirmed;
  }
}

export class ReconcileFixedCanaryProvisioning {
  constructor(
    private readonly ports: BasicUseCasePorts & {
      readonly provisioning: CandidateWorkflowProvisioningPort;
      readonly digest: ActionReleaseDigestPort;
      readonly eligibility: RepositoryActionEligibilityPort;
    },
  ) {}

  async execute(input: {
    readonly expectedAggregateVersion: bigint;
    readonly attemptId: string;
  }): Promise<CanaryArmedActionReleaseRollout> {
    const current = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(current, input.expectedAggregateVersion);
    if (
      current.phase !== ActionReleaseRolloutPhase.CanaryArmed ||
      current.provisioning.state === "verified" ||
      current.receiptVerification !== null
    )
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    assertExactCandidateAttempt(current, input.attemptId);

    let authorization: AuthorizedActionReleaseSelection;
    let working = current;
    if (current.provisioning.state === "prepared") {
      authorization = await new ResolveActionReleaseSelection({
        repository: this.ports.repository,
        eligibility: this.ports.eligibility,
        digest: this.ports.digest,
      }).isolatedCandidate({
        expectedAggregateVersion: current.aggregateVersion,
        context: candidateContextFromBinding(current),
        eligibilityContext: candidateEligibilityContext(current),
      });
      const authorized = authorizeFixedActionReleaseCanaryProvisioning(
        current,
        {
          eligibility: provisioningEligibilityFromAuthorization(authorization),
          authorizedAt: this.ports.clock.now(),
        },
      );
      assertWriteCommitted(
        await this.ports.repository.compareAndSet({
          expectedAggregateVersion: current.aggregateVersion,
          next: authorized,
        }),
      );
      working = authorized;
    } else
      authorization = persistedProvisioningAuthorization(
        current,
        this.ports.digest,
      );

    let outcome:
      | Readonly<{ status: "exact"; expectationDigest: Sha256 }>
      | Readonly<{
          status: "pending" | "definite_no_effect";
          observationDigest: Sha256;
        }>;
    try {
      if (current.provisioning.state === "prepared") {
        const provisioned = await this.ports.provisioning.provision({
          selection: authorization.selection as Extract<
            WorkflowActionSelection,
            { readonly kind: "isolated_candidate" }
          >,
          schemaVersion: 5,
          binding: working.canary,
          eligibility: eligibilityDecisionFromAuthorization(authorization),
          effectId: working.provisioning.effectId,
          effectEpoch: working.provisioning.epoch,
        });
        outcome = { ...provisioned, status: "exact" };
      } else {
        outcome = await this.ports.provisioning.reconcile({
          selection: authorization.selection as Extract<
            WorkflowActionSelection,
            { readonly kind: "isolated_candidate" }
          >,
          schemaVersion: 5,
          binding: current.canary,
          eligibility: eligibilityDecisionFromAuthorization(authorization),
          effectId: current.provisioning.effectId,
          effectEpoch: current.provisioning.epoch,
        });
        if (outcome.status === "definite_no_effect") {
          const provisioned = await this.ports.provisioning.provision({
            selection: authorization.selection as Extract<
              WorkflowActionSelection,
              { readonly kind: "isolated_candidate" }
            >,
            schemaVersion: 5,
            binding: working.canary,
            eligibility: eligibilityDecisionFromAuthorization(authorization),
            effectId: working.provisioning.effectId,
            effectEpoch: working.provisioning.epoch,
          });
          outcome = { ...provisioned, status: "exact" };
        }
      }
    } catch {
      outcome = {
        status: "pending",
        observationDigest: this.ports.digest.digestCanonical({
          kind: "candidate_provisioning_reconciliation_exception",
          attemptId: working.candidate.attemptId,
          effectId: working.provisioning.effectId,
          effectEpoch: working.provisioning.epoch.toString(),
        }),
      };
    }

    if (
      outcome.status === "exact" &&
      outcome.expectationDigest === working.expectation.expectationDigest
    ) {
      const confirmed = confirmFixedActionReleaseCanaryProvisioned(working, {
        expectationDigest: outcome.expectationDigest,
        decisionDigest: authorization.decisionDigest,
        confirmedAt: this.ports.clock.now(),
      });
      assertWriteCommitted(
        await this.ports.repository.compareAndSet({
          expectedAggregateVersion: working.aggregateVersion,
          next: confirmed,
        }),
      );
      return confirmed;
    }

    const uncertain = markFixedActionReleaseCanaryProvisioningUncertain(
      working,
      {
        observationDigest:
          outcome.status === "exact"
            ? this.ports.digest.digestCanonical({
                kind: "candidate_provisioning_reconciliation_mismatch",
                expected: working.expectation.expectationDigest,
                observed: outcome.expectationDigest,
              })
            : outcome.observationDigest,
        observedAt: this.ports.clock.now(),
      },
    );
    assertWriteCommitted(
      await this.ports.repository.compareAndSet({
        expectedAggregateVersion: working.aggregateVersion,
        next: uncertain,
      }),
    );
    return uncertain;
  }
}

interface ReceiptVerificationUseCasePorts extends BasicUseCasePorts {
  readonly verifier: FixedTerminalCanaryReceiptVerifierPort;
  readonly digest: ActionReleaseDigestPort;
  readonly verificationLeaseMs: number;
}

function receiptVerificationLeaseExpiresAt(
  startedAt: string,
  verificationLeaseMs: number,
): string {
  if (!Number.isSafeInteger(verificationLeaseMs) || verificationLeaseMs < 1)
    applicationFail(ActionReleaseApplicationErrorCode.EffectUncertain);
  return new Date(Date.parse(startedAt) + verificationLeaseMs).toISOString();
}

async function persistReceiptVerificationUncertain(
  ports: ReceiptVerificationUseCasePorts,
  rollout: CanaryArmedActionReleaseRollout,
  kind: "verifier_unknown" | "verified_receipt_mismatch",
): Promise<void> {
  const verification = rollout.receiptVerification;
  if (verification === null)
    applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
  const uncertain = markFixedTerminalCanaryReceiptVerificationUncertain(
    rollout,
    {
      attemptId: rollout.candidate.attemptId,
      observationDigest: ports.digest.digestCanonical({
        kind,
        effectId: verification.effectId,
        epoch: verification.epoch.toString(),
        artifactId: verification.locator.artifactId,
        artifactSha256: verification.locator.artifactSha256,
      }),
      observedAt: ports.clock.now(),
    },
  );
  assertWriteCommitted(
    await ports.repository.compareAndSet({
      expectedAggregateVersion: rollout.aggregateVersion,
      next: uncertain,
    }),
  );
}

async function verifyAndAttachFixedTerminalReceipt(
  ports: ReceiptVerificationUseCasePorts,
  rollout: CanaryArmedActionReleaseRollout,
  attemptId: string,
): Promise<CanaryVerifiedActionReleaseRollout> {
  const verification = rollout.receiptVerification;
  if (verification === null || verification.state !== "dispatching")
    applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
  let receipt;
  try {
    receipt = await ports.verifier.verifyExact({
      locator: verification.locator,
      expected: rollout.expectation,
    });
  } catch (cause) {
    await persistReceiptVerificationUncertain(
      ports,
      rollout,
      "verifier_unknown",
    );
    applicationFail(ActionReleaseApplicationErrorCode.EffectUncertain, cause);
  }
  if (
    receipt.artifactId !== verification.locator.artifactId ||
    receipt.artifactSha256 !== verification.locator.artifactSha256
  ) {
    await persistReceiptVerificationUncertain(
      ports,
      rollout,
      "verified_receipt_mismatch",
    );
    applicationFail(ActionReleaseApplicationErrorCode.ArtifactConflict);
  }
  let next: CanaryVerifiedActionReleaseRollout;
  try {
    next = acceptFixedTerminalCanaryReceipt(rollout, {
      attemptId,
      receipt,
    });
  } catch (cause) {
    await persistReceiptVerificationUncertain(
      ports,
      rollout,
      "verified_receipt_mismatch",
    );
    applicationFail(ActionReleaseApplicationErrorCode.ReceiptConflict, cause);
  }
  assertWriteCommitted(
    await ports.repository.attachReceiptOnceAndCas({
      expectedAggregateVersion: rollout.aggregateVersion,
      receiptId: receipt.receiptId,
      artifactId: receipt.artifactId,
      ownerAttemptId: rollout.candidate.attemptId,
      verificationEffectId: verification.effectId,
      verificationEpoch: verification.epoch,
      next,
    }),
  );
  return next;
}

export class AcceptFixedTerminalCanaryReceipt {
  constructor(
    private readonly ports: ReceiptVerificationUseCasePorts & {
      readonly id: ActionReleaseIdPort;
    },
  ) {}

  async execute(input: {
    readonly expectedAggregateVersion: bigint;
    readonly attemptId: string;
    readonly locator: ImmutableEvidenceArtifactLocator;
  }): Promise<CanaryVerifiedActionReleaseRollout> {
    const current = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(current, input.expectedAggregateVersion);
    if (current.phase !== ActionReleaseRolloutPhase.CanaryArmed)
      applicationFail(ActionReleaseApplicationErrorCode.ReceiptConflict);
    assertExactCandidateAttempt(current, input.attemptId);
    if (current.receiptVerification !== null)
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    const locator = immutableEvidenceArtifactLocator(input.locator);
    const startedAt = this.ports.clock.now();
    const dispatching = beginFixedTerminalCanaryReceiptVerification(current, {
      attemptId: input.attemptId,
      locator,
      effectId: this.ports.id.nextId("effect"),
      effectEpoch: current.aggregateVersion + 1n,
      startedAt,
      leaseExpiresAt: receiptVerificationLeaseExpiresAt(
        startedAt,
        this.ports.verificationLeaseMs,
      ),
    });
    const effect = dispatching.receiptVerification;
    if (effect === null)
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    assertWriteCommitted(
      await this.ports.repository.beginReceiptVerificationCas({
        expectedAggregateVersion: current.aggregateVersion,
        effect,
        artifactId: locator.artifactId,
        artifactSha256: locator.artifactSha256,
        ownerAttemptId: current.candidate.attemptId,
        next: dispatching,
      }),
    );
    return verifyAndAttachFixedTerminalReceipt(
      this.ports,
      dispatching,
      input.attemptId,
    );
  }
}

export class ReconcileFixedTerminalCanaryReceiptVerification {
  constructor(private readonly ports: ReceiptVerificationUseCasePorts) {}

  async execute(input: {
    readonly expectedAggregateVersion: bigint;
    readonly attemptId: string;
  }): Promise<CanaryVerifiedActionReleaseRollout> {
    const current = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(current, input.expectedAggregateVersion);
    if (
      current.phase !== ActionReleaseRolloutPhase.CanaryArmed ||
      current.receiptVerification === null
    )
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    assertExactCandidateAttempt(current, input.attemptId);
    const resumedAt = this.ports.clock.now();
    if (
      current.receiptVerification.state === "dispatching" &&
      Date.parse(resumedAt) <
        Date.parse(current.receiptVerification.leaseExpiresAt)
    )
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    const resumed = resumeFixedTerminalCanaryReceiptVerification(current, {
      attemptId: input.attemptId,
      resumedAt,
      leaseExpiresAt: receiptVerificationLeaseExpiresAt(
        resumedAt,
        this.ports.verificationLeaseMs,
      ),
    });
    assertWriteCommitted(
      await this.ports.repository.compareAndSet({
        expectedAggregateVersion: current.aggregateVersion,
        next: resumed,
      }),
    );
    return verifyAndAttachFixedTerminalReceipt(
      this.ports,
      resumed,
      input.attemptId,
    );
  }
}

export class PreparePromotion {
  constructor(
    private readonly ports: BasicUseCasePorts & {
      readonly inventory: LiveActionReferenceInventoryPort;
      readonly production: ProductionActionConfigurationPort;
      readonly maximumCaptureAgeMs: number;
      readonly preparationTtlMs: number;
    },
  ) {}

  async execute(input: {
    readonly expectedAggregateVersion: bigint;
    readonly attemptId: string;
  }): Promise<PromotionPreparedActionReleaseRollout> {
    const current = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(current, input.expectedAggregateVersion);
    if (current.phase !== ActionReleaseRolloutPhase.CanaryVerified)
      applicationFail(
        ActionReleaseApplicationErrorCode.ActiveCandidateConflict,
      );
    assertExactCandidateAttempt(current, input.attemptId);
    const [inventory, configuration] = await Promise.all([
      this.ports.inventory.captureComplete({
        channel: "production-schema-v5",
        policyRevision: current.candidate.policyRevision,
      }),
      this.ports.production.readExact(),
    ]);
    const preparedAt = this.ports.clock.now();
    const nowMilliseconds = Date.parse(preparedAt);
    const inventoryAge = nowMilliseconds - Date.parse(inventory.capturedAt);
    const databaseSnapshotAge =
      nowMilliseconds - Date.parse(inventory.database.serverTime);
    const githubProviderObservationAge =
      nowMilliseconds - Date.parse(inventory.github.providerObservedAt);
    const configurationAge =
      nowMilliseconds - Date.parse(configuration.observedAt);
    if (
      !Number.isSafeInteger(this.ports.maximumCaptureAgeMs) ||
      this.ports.maximumCaptureAgeMs < 1 ||
      !Number.isSafeInteger(this.ports.preparationTtlMs) ||
      this.ports.preparationTtlMs < 1 ||
      inventoryAge < 0 ||
      databaseSnapshotAge < 0 ||
      githubProviderObservationAge < 0 ||
      configurationAge < 0 ||
      inventoryAge > this.ports.maximumCaptureAgeMs ||
      databaseSnapshotAge > this.ports.maximumCaptureAgeMs ||
      githubProviderObservationAge > this.ports.maximumCaptureAgeMs ||
      configurationAge > this.ports.maximumCaptureAgeMs
    )
      applicationFail(ActionReleaseApplicationErrorCode.InventoryStale);
    const next = prepareActionReleasePromotion(current, {
      attemptId: input.attemptId,
      inventory,
      configuration,
      preparedAt,
      validUntil: new Date(
        nowMilliseconds + this.ports.preparationTtlMs,
      ).toISOString(),
    });
    assertWriteCommitted(
      await this.ports.repository.compareAndSet({
        expectedAggregateVersion: current.aggregateVersion,
        next,
      }),
    );
    return next;
  }
}

async function persistPromotionUncertain(
  repository: ActionReleaseRolloutRepositoryPort,
  rollout:
    | PromotingActionReleaseRollout
    | PromotionUncertainActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly observationDigest: Sha256;
    readonly observedAt: string;
  },
): Promise<PromotionUncertainActionReleaseRollout> {
  const uncertain = markActionReleasePromotionUncertain(rollout, input);
  assertWriteCommitted(
    await repository.compareAndSet({
      expectedAggregateVersion: rollout.aggregateVersion,
      next: uncertain,
    }),
  );
  return uncertain;
}

type RecoveryAdmissionUseCasePorts = BasicUseCasePorts & {
  readonly admission: AdmissionFencePort;
  readonly digest: ActionReleaseDigestPort;
};

function admissionEffectFailureDigest(
  digest: ActionReleaseDigestPort,
  kind: string,
  effectId: string,
  effectEpoch: bigint,
): Sha256 {
  return digest.digestCanonical({
    kind,
    effectId,
    effectEpoch: effectEpoch.toString(),
  });
}

async function continueRecoveryAdmissionClose(input: {
  readonly rollout: RecoveryOnlyActionReleaseRollout;
  readonly ports: RecoveryAdmissionUseCasePorts;
  readonly reconcile: boolean;
}): Promise<RecoveryOnlyActionReleaseRollout> {
  const effect = input.rollout.recoveryAdmissionEffect;
  if (effect.state === "verified") return input.rollout;
  let outcome;
  try {
    outcome = input.reconcile
      ? await input.ports.admission.reconcileSetupAndNewWorkClose({ effect })
      : await input.ports.admission.closeSetupAndNewWork({ effect });
  } catch {
    outcome = {
      status: "uncertain" as const,
      observationDigest: admissionEffectFailureDigest(
        input.ports.digest,
        "recovery_admission_close_exception",
        effect.effectId,
        effect.epoch,
      ),
    };
  }
  let next: RecoveryOnlyActionReleaseRollout;
  if (outcome.status === "uncertain") {
    next = markActionReleaseAdmissionEffectUncertain(input.rollout, {
      effectId: effect.effectId,
      effectEpoch: effect.epoch,
      observationDigest: outcome.observationDigest,
      observedAt: input.ports.clock.now(),
    });
  } else {
    try {
      next = confirmActionReleaseRecoveryAdmissionClosed(input.rollout, {
        ...outcome.observation,
        confirmedAt: input.ports.clock.now(),
      });
    } catch {
      next = markActionReleaseAdmissionEffectUncertain(input.rollout, {
        effectId: effect.effectId,
        effectEpoch: effect.epoch,
        observationDigest: admissionEffectFailureDigest(
          input.ports.digest,
          "recovery_admission_close_observation_mismatch",
          effect.effectId,
          effect.epoch,
        ),
        observedAt: input.ports.clock.now(),
      });
    }
  }
  assertWriteCommitted(
    await input.ports.repository.compareAndSet({
      expectedAggregateVersion: input.rollout.aggregateVersion,
      next,
    }),
  );
  return next;
}

async function continueRecoveryAdmissionReopen(input: {
  readonly rollout: PromotionUncertainActionReleaseRollout;
  readonly ports: RecoveryAdmissionUseCasePorts;
  readonly reconcile: boolean;
}): Promise<
  SteadyActionReleaseRollout | PromotionUncertainActionReleaseRollout
> {
  const effect = input.rollout.recoveryAdmissionEffect;
  if (
    !effect ||
    effect.operation !== ActionReleaseAdmissionEffectOperation.ReopenRecovery
  )
    applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
  let outcome;
  try {
    outcome = input.reconcile
      ? await input.ports.admission.reconcileSetupAndNewWorkReopen({ effect })
      : await input.ports.admission.reopenSetupAndNewWork({ effect });
  } catch {
    outcome = {
      status: "uncertain" as const,
      observationDigest: admissionEffectFailureDigest(
        input.ports.digest,
        "recovery_admission_reopen_exception",
        effect.effectId,
        effect.epoch,
      ),
    };
  }
  let next: SteadyActionReleaseRollout | PromotionUncertainActionReleaseRollout;
  if (outcome.status === "uncertain") {
    next = markActionReleaseAdmissionEffectUncertain(input.rollout, {
      effectId: effect.effectId,
      effectEpoch: effect.epoch,
      observationDigest: outcome.observationDigest,
      observedAt: input.ports.clock.now(),
    });
  } else {
    try {
      next = completeActionReleaseRecoveryAdmissionReopen(input.rollout, {
        ...outcome.observation,
        completedAt: input.ports.clock.now(),
      });
    } catch {
      next = markActionReleaseAdmissionEffectUncertain(input.rollout, {
        effectId: effect.effectId,
        effectEpoch: effect.epoch,
        observationDigest: admissionEffectFailureDigest(
          input.ports.digest,
          "recovery_admission_reopen_observation_mismatch",
          effect.effectId,
          effect.epoch,
        ),
        observedAt: input.ports.clock.now(),
      });
    }
  }
  assertWriteCommitted(
    await input.ports.repository.compareAndSet({
      expectedAggregateVersion: input.rollout.aggregateVersion,
      next,
    }),
  );
  return next;
}

export class PromoteActionReleaseCandidate {
  constructor(
    private readonly ports: BasicUseCasePorts & {
      readonly id: ActionReleaseIdPort;
      readonly digest: ActionReleaseDigestPort;
      readonly production: ProductionActionConfigurationPort;
      readonly admission: AdmissionFencePort;
    },
  ) {}

  async execute(input: {
    readonly expectedAggregateVersion: bigint;
    readonly attemptId: string;
  }): Promise<
    SteadyActionReleaseRollout | PromotionUncertainActionReleaseRollout
  > {
    const current = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(current, input.expectedAggregateVersion);
    if (
      current.phase === ActionReleaseRolloutPhase.Promoting ||
      current.phase === ActionReleaseRolloutPhase.PromotionUncertain
    )
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    if (current.phase !== ActionReleaseRolloutPhase.PromotionPrepared)
      applicationFail(
        ActionReleaseApplicationErrorCode.ActiveCandidateConflict,
      );
    assertExactCandidateAttempt(current, input.attemptId);
    const now = this.ports.clock.now();
    const reservation = {
      reservationId: this.ports.id.nextId("reservation"),
      ownerAttemptId: current.candidate.attemptId,
      receiptId: current.receipt.receiptId,
      artifactId: current.receipt.artifactId,
      canonicalPayloadDigest: current.receipt.canonicalPayloadDigest,
      artifactSha256: current.receipt.artifactSha256,
      expectationDigest: current.receipt.expectationDigest,
      receiptIdentityDigest: terminalCanaryReceiptIdentityDigest(
        current.receipt,
      ),
      reservedAt: now,
      epoch: current.aggregateVersion + 1n,
    } as const;
    const promoting = beginActionReleasePromotion(current, {
      attemptId: input.attemptId,
      reservation,
      effectId: this.ports.id.nextId("effect"),
      now,
    });
    assertWriteCommitted(
      await this.ports.repository.consumeReceiptAndBeginPromotionCas({
        expectedAggregateVersion: current.aggregateVersion,
        receiptId: current.receipt.receiptId,
        artifactId: current.receipt.artifactId,
        ownerAttemptId: current.candidate.attemptId,
        reservation,
        next: promoting,
      }),
    );

    let outcome: ProductionActionConfigurationOutcome;
    try {
      outcome = await this.ports.production.promotePrimary({
        rollout: promoting,
        expectedConfigurationDigest: current.preparation.configurationDigest,
        expectedInventoryDigest: current.preparation.inventory.inventoryDigest,
      });
    } catch {
      outcome = {
        status: "uncertain",
        observationDigest: this.ports.digest.digestCanonical({
          kind: "promotion_provider_exception",
          attemptId: current.candidate.attemptId,
          effectId: promoting.effect.effectId,
        }),
      };
    }
    if (outcome.status === "exact") {
      if (promoting.candidate.originRecoveryFence) {
        const reopenStartedAt = this.ports.clock.now();
        const reopening = beginActionReleaseRecoveryAdmissionReopen(promoting, {
          attemptId: input.attemptId,
          configuration: outcome.configuration,
          effectId: this.ports.id.nextId("effect"),
          effectEpoch: promoting.aggregateVersion + 1n,
          observationDigest: this.ports.digest.digestCanonical({
            kind: "promotion_exact_recovery_admission_reopen_pending",
            attemptId: input.attemptId,
            configurationDigest: outcome.configuration.configurationDigest,
          }),
          startedAt: reopenStartedAt,
        });
        assertWriteCommitted(
          await this.ports.repository.compareAndSet({
            expectedAggregateVersion: promoting.aggregateVersion,
            next: reopening,
          }),
        );
        return await continueRecoveryAdmissionReopen({
          rollout: reopening,
          ports: this.ports,
          reconcile: false,
        });
      }
      const steady = completeActionReleasePromotion(promoting, {
        attemptId: input.attemptId,
        configuration: outcome.configuration,
        completedAt: this.ports.clock.now(),
      });
      assertWriteCommitted(
        await this.ports.repository.compareAndSet({
          expectedAggregateVersion: promoting.aggregateVersion,
          next: steady,
        }),
      );
      return steady;
    }
    const observationDigest =
      outcome.status === "uncertain"
        ? outcome.observationDigest
        : this.ports.digest.digestCanonical({
            kind: "definite_no_effect_after_receipt_consumption",
            configurationDigest: outcome.configuration.configurationDigest,
          });
    return await persistPromotionUncertain(this.ports.repository, promoting, {
      attemptId: input.attemptId,
      observationDigest,
      observedAt: this.ports.clock.now(),
    });
  }
}

export class ReconcilePromotion {
  constructor(
    private readonly ports: BasicUseCasePorts & {
      readonly id: ActionReleaseIdPort;
      readonly digest: ActionReleaseDigestPort;
      readonly production: ProductionActionConfigurationPort;
      readonly admission: AdmissionFencePort;
    },
  ) {}

  async execute(input: {
    readonly expectedAggregateVersion: bigint;
    readonly attemptId: string;
  }): Promise<
    | SteadyActionReleaseRollout
    | PromotionUncertainActionReleaseRollout
    | RecoveryOnlyActionReleaseRollout
  > {
    let current = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(current, input.expectedAggregateVersion);
    if (
      current.phase !== ActionReleaseRolloutPhase.Promoting &&
      current.phase !== ActionReleaseRolloutPhase.PromotionUncertain
    )
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    assertExactCandidateAttempt(current, input.attemptId);
    if (
      current.phase === ActionReleaseRolloutPhase.PromotionUncertain &&
      current.recoveryAdmissionEffect?.operation ===
        ActionReleaseAdmissionEffectOperation.ReopenRecovery
    )
      return await continueRecoveryAdmissionReopen({
        rollout: current,
        ports: this.ports,
        reconcile: true,
      });
    if (current.phase === ActionReleaseRolloutPhase.Promoting) {
      current = await persistPromotionUncertain(
        this.ports.repository,
        current,
        {
          attemptId: input.attemptId,
          observationDigest: this.ports.digest.digestCanonical({
            kind: "reconciliation_claimed_after_dispatch",
            effectId: current.effect.effectId,
          }),
          observedAt: this.ports.clock.now(),
        },
      );
    }
    const outcome = await this.ports.production.reconcilePromotion({
      rollout: current,
    });
    if (outcome.status === "completed") {
      if (current.candidate.originRecoveryFence) {
        const reopenStartedAt = this.ports.clock.now();
        const reopening = beginActionReleaseRecoveryAdmissionReopen(current, {
          attemptId: input.attemptId,
          configuration: outcome.configuration,
          effectId: this.ports.id.nextId("effect"),
          effectEpoch: current.aggregateVersion + 1n,
          observationDigest: this.ports.digest.digestCanonical({
            kind: "reconciled_promotion_recovery_admission_reopen_pending",
            attemptId: input.attemptId,
            configurationDigest: outcome.configuration.configurationDigest,
          }),
          startedAt: reopenStartedAt,
        });
        assertWriteCommitted(
          await this.ports.repository.compareAndSet({
            expectedAggregateVersion: current.aggregateVersion,
            next: reopening,
          }),
        );
        return await continueRecoveryAdmissionReopen({
          rollout: reopening,
          ports: this.ports,
          reconcile: false,
        });
      }
      const steady = completeActionReleasePromotion(current, {
        attemptId: input.attemptId,
        configuration: outcome.configuration,
        completedAt: this.ports.clock.now(),
      });
      assertWriteCommitted(
        await this.ports.repository.compareAndSet({
          expectedAggregateVersion: current.aggregateVersion,
          next: steady,
        }),
      );
      return steady;
    }
    if (outcome.status === "pending")
      return await persistPromotionUncertain(this.ports.repository, current, {
        attemptId: input.attemptId,
        observationDigest: outcome.observationDigest,
        observedAt: this.ports.clock.now(),
      });
    assertUncertainPromotionReachedCandidate(current, outcome.configuration);
    const recoveryEffectId = this.ports.id.nextId("effect");
    const recoveryEffectEpoch = current.aggregateVersion + 1n;
    const recovery = enterUncertainPromotionRecoveryOnly(current, {
      effectId: recoveryEffectId,
      effectEpoch: recoveryEffectEpoch,
      recoveryFenceId: recoveryEffectId,
      recoveryFenceEpoch: recoveryEffectEpoch,
      failureDigest: outcome.failureDigest,
      promotedConfiguration: outcome.configuration,
      enteredAt: this.ports.clock.now(),
    });
    assertWriteCommitted(
      await this.ports.repository.compareAndSet({
        expectedAggregateVersion: current.aggregateVersion,
        next: recovery,
      }),
    );
    return await continueRecoveryAdmissionClose({
      rollout: recovery,
      ports: this.ports,
      reconcile: false,
    });
  }
}

export class AbortActionReleaseCandidate {
  constructor(private readonly ports: BasicUseCasePorts) {}

  async execute(input: {
    readonly expectedAggregateVersion: bigint;
    readonly attemptId: string;
    readonly reasonDigest: Sha256;
  }): Promise<CandidateAbortedActionReleaseRollout> {
    const current = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(current, input.expectedAggregateVersion);
    if (
      current.phase === ActionReleaseRolloutPhase.Promoting ||
      current.phase === ActionReleaseRolloutPhase.PromotionUncertain ||
      current.phase === ActionReleaseRolloutPhase.Steady ||
      current.phase === ActionReleaseRolloutPhase.RecoveryOnly ||
      current.phase === ActionReleaseRolloutPhase.CandidateAborted
    )
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    assertExactCandidateAttempt(current, input.attemptId);
    const next = abortActionReleaseCandidate(current, {
      attemptId: input.attemptId,
      abortedAt: this.ports.clock.now(),
      reasonDigest: input.reasonDigest,
    });
    assertWriteCommitted(
      await this.ports.repository.compareAndSet({
        expectedAggregateVersion: current.aggregateVersion,
        next,
      }),
    );
    return next;
  }
}

export class EnterRecoveryOnly {
  constructor(
    private readonly ports: BasicUseCasePorts & {
      readonly id: ActionReleaseIdPort;
      readonly digest: ActionReleaseDigestPort;
      readonly admission: AdmissionFencePort;
    },
  ) {}

  async execute(input: {
    readonly expectedAggregateVersion: bigint;
    readonly failureDigest: Sha256;
  }): Promise<RecoveryOnlyActionReleaseRollout> {
    const current = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(current, input.expectedAggregateVersion);
    if (current.phase !== ActionReleaseRolloutPhase.Steady)
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    if (
      current.lastCompletedPromotion === null ||
      !sameActionRef(
        current.primaryRef,
        current.lastCompletedPromotion.toRelease,
      )
    )
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    const effectId = this.ports.id.nextId("effect");
    const effectEpoch = current.aggregateVersion + 1n;
    const next = enterActionReleaseRecoveryOnly(current, {
      effectId,
      effectEpoch,
      recoveryFenceId: effectId,
      recoveryFenceEpoch: effectEpoch,
      failureDigest: input.failureDigest,
      enteredAt: this.ports.clock.now(),
    });
    assertWriteCommitted(
      await this.ports.repository.compareAndSet({
        expectedAggregateVersion: current.aggregateVersion,
        next,
      }),
    );
    return await continueRecoveryAdmissionClose({
      rollout: next,
      ports: this.ports,
      reconcile: false,
    });
  }
}

export class ReconcileRecoveryAdmission {
  constructor(private readonly ports: RecoveryAdmissionUseCasePorts) {}

  async execute(input: {
    readonly expectedAggregateVersion: bigint;
  }): Promise<RecoveryOnlyActionReleaseRollout> {
    const current = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(current, input.expectedAggregateVersion);
    if (current.phase !== ActionReleaseRolloutPhase.RecoveryOnly)
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    return await continueRecoveryAdmissionClose({
      rollout: current,
      ports: this.ports,
      reconcile: true,
    });
  }
}

type RetainingRollout =
  | SteadyActionReleaseRollout
  | RecoveryOnlyActionReleaseRollout
  | CandidateAbortedActionReleaseRollout;

function retainingRollout(rollout: ActionReleaseRollout): RetainingRollout {
  if (
    rollout.phase !== ActionReleaseRolloutPhase.Steady &&
    rollout.phase !== ActionReleaseRolloutPhase.RecoveryOnly &&
    rollout.phase !== ActionReleaseRolloutPhase.CandidateAborted
  )
    applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
  return rollout;
}

export class ReconcilePredecessorRetention {
  constructor(
    private readonly ports: BasicUseCasePorts & {
      readonly id: ActionReleaseIdPort;
      readonly digest: ActionReleaseDigestPort;
      readonly inventory: LiveActionReferenceInventoryPort;
      readonly production: ProductionActionConfigurationPort;
      readonly admission: AdmissionFencePort;
      readonly maximumCaptureAgeMs: number;
    },
  ) {}

  private async cas(
    current: RetainingRollout,
    next: RetainingRollout,
  ): Promise<RetainingRollout> {
    assertWriteCommitted(
      await this.ports.repository.compareAndSet({
        expectedAggregateVersion: current.aggregateVersion,
        next,
      }),
    );
    return next;
  }

  private async applyRemovalOutcome(
    current: RetainingRollout,
    outcome: ProductionActionConfigurationOutcome,
  ): Promise<RetainingRollout> {
    const retention = current.predecessorRetention;
    if (!retention?.removalEffect)
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    if (outcome.status === "exact")
      return await this.cas(
        current,
        completePredecessorRemoval(current, {
          proof: retention.removalEffect.proof,
          configuration: outcome.configuration,
        }),
      );
    return await this.cas(
      current,
      markPredecessorRemovalUncertain(current, {
        observationDigest:
          outcome.status === "uncertain"
            ? outcome.observationDigest
            : outcome.configuration.configurationDigest,
        observedAt: this.ports.clock.now(),
      }),
    );
  }

  private async continuePredecessorAdmissionClose(
    current: RetainingRollout,
    reconcile: boolean,
  ): Promise<RetainingRollout> {
    const retention = current.predecessorRetention;
    const effect = retention?.admissionEffect;
    if (!retention || !effect)
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    const command = {
      effect,
      predecessorRef: retention.predecessorRef,
      successorRef: current.primaryRef,
      promotionAttemptId: retention.promotionAttemptId,
      repositoryCohortRevision: retention.repositoryCohortRevision,
      repositoryCohortDigest: retention.repositoryCohortDigest,
      githubRepositoryIds: retention.githubRepositoryIds,
      policyRevision: retention.policyRevision,
      inventoryScopeDigest: retention.inventoryScopeDigest,
      requiredWindowMs: retention.requiredWindowMs,
      authorityEstablishedAt: retention.authorityEstablishedAt,
    } as const;
    let outcome;
    try {
      outcome = reconcile
        ? await this.ports.admission.reconcilePredecessorAdmission(command)
        : await this.ports.admission.closePredecessorAdmission(command);
    } catch {
      outcome = {
        status: "uncertain" as const,
        observationDigest: admissionEffectFailureDigest(
          this.ports.digest,
          "predecessor_admission_close_exception",
          effect.effectId,
          effect.epoch,
        ),
      };
    }
    let next: RetainingRollout;
    if (outcome.status === "uncertain") {
      next = markPredecessorAdmissionCloseUncertain(current, {
        effectId: effect.effectId,
        effectEpoch: effect.epoch,
        observationDigest: outcome.observationDigest,
        observedAt: this.ports.clock.now(),
      });
    } else {
      try {
        next = recordPredecessorAdmissionFence(current, outcome.observation);
      } catch {
        next = markPredecessorAdmissionCloseUncertain(current, {
          effectId: effect.effectId,
          effectEpoch: effect.epoch,
          observationDigest: admissionEffectFailureDigest(
            this.ports.digest,
            "predecessor_admission_close_observation_mismatch",
            effect.effectId,
            effect.epoch,
          ),
          observedAt: this.ports.clock.now(),
        });
      }
    }
    return await this.cas(current, next);
  }

  async execute(input: {
    readonly expectedAggregateVersion: bigint;
  }): Promise<RetainingRollout> {
    const loaded = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(loaded, input.expectedAggregateVersion);
    let current = retainingRollout(loaded);
    let retention = current.predecessorRetention;
    if (!retention) return current;

    if (!retention.fence) {
      if (!retention.admissionEffect) {
        const effectId = this.ports.id.nextId("effect");
        current = await this.cas(
          current,
          beginPredecessorAdmissionClose(current, {
            effectId,
            effectEpoch: current.aggregateVersion + 1n,
            fenceId: effectId,
            fenceEpoch: current.aggregateVersion + 1n,
            startedAt: this.ports.clock.now(),
          }),
        );
        return await this.continuePredecessorAdmissionClose(current, false);
      }
      return await this.continuePredecessorAdmissionClose(current, true);
    }
    if (
      !(await this.ports.admission.assertPredecessorAdmissionClosed(
        retention.fence,
      ))
    )
      applicationFail(ActionReleaseApplicationErrorCode.EffectUncertain);

    if (retention.removalEffect) {
      const outcome = await this.ports.production.reconcilePredecessorRemoval({
        currentPrimary: current.primaryRef,
        predecessor: retention.predecessorRef,
        candidateDrainHolds: current.candidateDrainHolds,
        proof: retention.removalEffect.proof,
        expectedInventoryDigest:
          retention.removalEffect.proof.second.inventoryDigest,
        expectedProductionConsensusDigest:
          retention.removalEffect.proof.second.productionConsensusDigest,
        effectId: retention.removalEffect.effectId,
        effectEpoch: retention.removalEffect.epoch,
      });
      return await this.applyRemovalOutcome(current, outcome);
    }

    const inventory = await this.ports.inventory.captureComplete({
      channel: "production-schema-v5",
      policyRevision: retention.policyRevision,
    });
    const observedNow = this.ports.clock.now();
    const zeroCapture = zeroPredecessorReferenceCapture({
      inventory,
      predecessorRef: retention.predecessorRef,
      successorRef: current.primaryRef,
      additionalTrustedRefs: current.candidateDrainHolds,
      expectedInstaller: retention.installer,
      expectedServiceIds: retention.serviceIds,
      fence: retention.fence,
      observedNow,
      maximumCaptureAgeMs: this.ports.maximumCaptureAgeMs,
    });
    if (!zeroCapture) {
      return await this.cas(
        current,
        recordPredecessorZeroCapture(current, null, inventory),
      );
    }
    if (!retention.firstZeroCapture)
      return await this.cas(
        current,
        recordPredecessorZeroCapture(current, zeroCapture, inventory),
      );

    let proof;
    try {
      proof = predecessorRemovalProof({
        predecessorRef: retention.predecessorRef,
        successorRef: current.primaryRef,
        fence: retention.fence,
        first: retention.firstZeroCapture,
        second: zeroCapture,
      });
    } catch {
      const productionAuthorityDrifted =
        retention.firstZeroCapture.productionConsensusDigest !==
          zeroCapture.productionConsensusDigest ||
        retention.firstZeroCapture.productionDeploymentIds.join("\n") !==
          zeroCapture.productionDeploymentIds.join("\n");
      if (productionAuthorityDrifted)
        return await this.cas(
          current,
          recordPredecessorZeroCapture(current, zeroCapture, inventory),
        );
      return current;
    }
    const started = beginPredecessorRemoval(current, {
      proof,
      effectId: this.ports.id.nextId("effect"),
      effectEpoch: current.aggregateVersion + 1n,
      startedAt: this.ports.clock.now(),
    });
    current = await this.cas(current, started);
    retention = current.predecessorRetention;
    if (!retention?.removalEffect)
      applicationFail(ActionReleaseApplicationErrorCode.ReconcileOnly);
    let outcome: ProductionActionConfigurationOutcome;
    try {
      outcome = await this.ports.production.removePredecessor({
        currentPrimary: current.primaryRef,
        predecessor: retention.predecessorRef,
        candidateDrainHolds: current.candidateDrainHolds,
        proof: retention.removalEffect.proof,
        expectedInventoryDigest:
          retention.removalEffect.proof.second.inventoryDigest,
        expectedProductionConsensusDigest:
          retention.removalEffect.proof.second.productionConsensusDigest,
        effectId: retention.removalEffect.effectId,
        effectEpoch: retention.removalEffect.epoch,
      });
    } catch {
      outcome = {
        status: "uncertain",
        observationDigest: retention.removalEffect.proof.proofDigest,
      };
    }
    return await this.applyRemovalOutcome(current, outcome);
  }
}

const authorizedSelectionBrand: unique symbol = Symbol(
  "authorized-action-release-selection",
);

export interface AuthorizedActionReleaseSelection {
  /**
   * Snapshot token, not standalone I/O authority. It is valid only for this
   * exact aggregate version, phase, and admission mode. A side-effecting
   * consumer must atomically consume/fence these fields before provider I/O;
   * the fixed-canary path does so with its aggregate CAS.
   */
  readonly aggregateVersion: bigint;
  readonly phase: ActionReleaseRollout["phase"];
  readonly admissionMode: ActionReleaseRollout["admissionMode"];
  readonly selection: WorkflowActionSelection;
  readonly policyRevision: bigint;
  readonly channelVersion: bigint;
  readonly selectionDigest: Sha256;
  readonly contextDigest: Sha256;
  readonly decisionDigest: Sha256;
  readonly [authorizedSelectionBrand]: true;
}

function authorizedActionReleaseSelection(
  input: Omit<
    AuthorizedActionReleaseSelection,
    typeof authorizedSelectionBrand
  >,
): AuthorizedActionReleaseSelection {
  return Object.freeze({
    ...input,
    [authorizedSelectionBrand]: true as const,
  });
}

export class ResolveActionReleaseSelection {
  constructor(
    private readonly ports: {
      readonly repository: ActionReleaseRolloutRepositoryPort;
      readonly eligibility: RepositoryActionEligibilityPort;
      readonly digest: ActionReleaseDigestPort;
    },
  ) {}

  private async authorize(
    selection: WorkflowActionSelection,
    context: RepositoryActionSelectionContext,
    rollout: ActionReleaseRollout,
    expectedPolicyRevision: bigint,
  ): Promise<AuthorizedActionReleaseSelection> {
    if (expectedPolicyRevision < 1n)
      applicationFail(ActionReleaseApplicationErrorCode.EligibilityRejected);
    const contextDigest = exactSelectionContextDigest(
      this.ports.digest,
      context,
    );
    const selectionDigest = exactWorkflowActionSelectionDigest(
      this.ports.digest,
      selection,
    );
    const decision = await this.ports.eligibility.authorizeExactSelection({
      selection,
      selectionDigest,
      contextDigest,
      expectedChannelVersion:
        selection.kind === "production_primary"
          ? selection.channelVersion
          : rollout.channelVersion,
      expectedPolicyRevision,
    });
    const expectedDecisionDigest = this.ports.digest.digestCanonical({
      allowed: decision.allowed,
      policyRevision: decision.policyRevision.toString(),
      channelVersion: decision.channelVersion.toString(),
      selectionDigest,
      contextDigest,
    });
    if (
      !decision.allowed ||
      decision.channelVersion !== rollout.channelVersion ||
      decision.policyRevision !== expectedPolicyRevision ||
      decision.selectionDigest !== selectionDigest ||
      decision.contextDigest !== contextDigest ||
      decision.decisionDigest !== expectedDecisionDigest
    )
      applicationFail(ActionReleaseApplicationErrorCode.EligibilityRejected);
    const current = await this.ports.repository.load("production-schema-v5");
    if (current.aggregateVersion !== rollout.aggregateVersion)
      applicationFail(ActionReleaseApplicationErrorCode.StaleVersion);
    if (
      current.phase !== rollout.phase ||
      current.admissionMode !== rollout.admissionMode
    )
      applicationFail(ActionReleaseApplicationErrorCode.EligibilityRejected);
    return authorizedActionReleaseSelection({
      aggregateVersion: rollout.aggregateVersion,
      phase: rollout.phase,
      admissionMode: rollout.admissionMode,
      selection,
      policyRevision: decision.policyRevision,
      channelVersion: decision.channelVersion,
      selectionDigest,
      contextDigest,
      decisionDigest: decision.decisionDigest,
    });
  }

  async production(input: {
    readonly expectedAggregateVersion: bigint;
    readonly expectedPolicyRevision: bigint;
    readonly context: RepositoryActionSelectionContext;
  }): Promise<AuthorizedActionReleaseSelection> {
    const rollout = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(rollout, input.expectedAggregateVersion);
    return await this.authorize(
      resolveProductionPrimarySelection(rollout),
      input.context,
      rollout,
      input.expectedPolicyRevision,
    );
  }

  async isolatedCandidate(input: {
    readonly expectedAggregateVersion: bigint;
    readonly context: IsolatedCandidateSelectionContext;
    readonly eligibilityContext: RepositoryActionSelectionContext;
  }): Promise<AuthorizedActionReleaseSelection> {
    const rollout = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(rollout, input.expectedAggregateVersion);
    if (
      rollout.phase !== ActionReleaseRolloutPhase.CanaryArmed &&
      rollout.phase !== ActionReleaseRolloutPhase.CanaryVerified &&
      rollout.phase !== ActionReleaseRolloutPhase.PromotionPrepared
    )
      applicationFail(ActionReleaseApplicationErrorCode.EligibilityRejected);
    const selection = resolveIsolatedCandidateSelection(rollout, input.context);
    if (
      input.eligibilityContext.githubRepositoryId !==
        selection.githubRepositoryId ||
      input.eligibilityContext.repositoryFullName.toLowerCase() !==
        selection.repositoryFullName ||
      input.eligibilityContext.providerInstanceId !==
        selection.providerInstanceId ||
      input.eligibilityContext.namespaceId !== selection.namespaceId ||
      input.eligibilityContext.namespaceEpoch !== selection.namespaceEpoch ||
      input.eligibilityContext.workflowSourceDigest !== selection.bindingDigest
    )
      applicationFail(ActionReleaseApplicationErrorCode.EligibilityRejected);
    return await this.authorize(
      selection,
      input.eligibilityContext,
      rollout,
      selection.policyRevision,
    );
  }

  async attestedLiveNamespace(input: {
    readonly expectedAggregateVersion: bigint;
    readonly expectedPolicyRevision: bigint;
    readonly attestation: Readonly<{
      actionRef: ActionReleaseRollout["primaryRef"];
      namespaceId: string;
      namespaceEpoch: bigint;
      workflowSourceDigest: Sha256;
    }>;
    readonly eligibilityContext: RepositoryActionSelectionContext;
  }): Promise<AuthorizedActionReleaseSelection> {
    const rollout = await this.ports.repository.load("production-schema-v5");
    assertExpectedVersion(rollout, input.expectedAggregateVersion);
    if (
      input.eligibilityContext.namespaceId !== input.attestation.namespaceId ||
      input.eligibilityContext.namespaceEpoch !==
        input.attestation.namespaceEpoch ||
      input.eligibilityContext.workflowSourceDigest !==
        input.attestation.workflowSourceDigest
    )
      applicationFail(ActionReleaseApplicationErrorCode.EligibilityRejected);
    return await this.authorize(
      resolveAttestedLiveNamespaceSelection(rollout, input.attestation),
      input.eligibilityContext,
      rollout,
      input.expectedPolicyRevision,
    );
  }
}

/** Convenience helper for exact promoted readback fakes and pure compositions. */
export function exactPromotedConfiguration(input: {
  readonly revision: bigint;
  readonly observedAt: string;
  readonly serviceIds: readonly string[];
  readonly primary: VerifiedActionReleaseV2;
  readonly retainedPredecessor?: VerifiedActionReleaseV2;
}) {
  const primaryRef = input.primary.actionRef;
  const knownRefs = input.retainedPredecessor
    ? [primaryRef, input.retainedPredecessor.actionRef]
    : [primaryRef];
  return exactProductionActionConfiguration({
    schemaVersion: 1,
    revision: input.revision,
    observedAt: input.observedAt,
    serviceIds: input.serviceIds,
    primaryRef,
    installerRef: primaryRef,
    installer: input.primary.installer,
    reusableWorkflowRef: primaryRef,
    runtimeRef: primaryRef,
    refreshActionRef: primaryRef,
    interactionRuntimeRef: primaryRef,
    knownRefs,
    isolatedCandidateAttemptId: null,
    isolatedCandidateBindingDigest: null,
  });
}

export function sameSelectedAction(
  selection: WorkflowActionSelection,
  release: VerifiedActionReleaseV2,
): boolean {
  return sameActionRef(selection.actionRef, release.actionRef);
}
