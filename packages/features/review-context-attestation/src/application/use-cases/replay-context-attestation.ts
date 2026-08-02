import {
  ContextDependencyReplayDenialReason,
  ContextDependencyReplayStatus,
  decideContextDependencyReplay,
  decideContextGatewayV4Replay,
  type ContextDependencyReplayDecision,
} from "../../domain/context-replay-decision";
import {
  createTargetReplayProof,
  targetReplayProofMaxLifetimeMs,
  type TargetReplayProof,
} from "../../domain/target-replay-proof";
import {
  ContextAttestationPersistenceStatus,
  type ContextAttestationClockPort,
  type ContextAttestationIdentityPort,
  type ContextAttestationStorePort,
  type TrustedTargetReplayFactsPort,
} from "../ports/context-attestation-ports";
import {
  isLegacyContextDependencyManifest,
  type ContextAttestationManifest,
} from "../../domain/context-attestation-manifest";

export enum ReplayContextAttestationStatus {
  Accepted = "accepted",
  Idempotent = "idempotent",
  Denied = "denied",
  Conflict = "conflict",
}

export type ReplayContextAttestationResult = Readonly<{
  status: ReplayContextAttestationStatus;
  replayDecision: ContextDependencyReplayDecision | null;
  proof: TargetReplayProof | null;
}>;

export class ReplayContextAttestation {
  constructor(
    private readonly dependencies: Readonly<{
      store: ContextAttestationStorePort;
      targetFacts: TrustedTargetReplayFactsPort;
      identities: ContextAttestationIdentityPort;
      clock: ContextAttestationClockPort;
    }>,
  ) {}

  async execute(command: {
    readonly sourceAttestationId: string;
    readonly sourceAttestationHash: string;
    readonly targetExecutionId: string;
    readonly targetWorkSlotId: string;
    readonly replayCapabilityId: string;
    readonly replayedManifest: ContextAttestationManifest;
  }): Promise<ReplayContextAttestationResult> {
    const nowMs = this.dependencies.clock.nowMs();
    const [source, target] = await Promise.all([
      this.dependencies.store.findAcceptedAttestation(
        command.sourceAttestationId,
      ),
      this.dependencies.targetFacts.resolveTargetReplayFacts(command),
    ]);
    if (
      !source ||
      !target ||
      source.attestationHash !== command.sourceAttestationHash ||
      source.reuseExpiresAtMs <= nowMs ||
      target.targetExecutionId !== command.targetExecutionId ||
      target.targetWorkSlotId !== command.targetWorkSlotId ||
      !Number.isSafeInteger(target.proofLifetimeMs) ||
      target.proofLifetimeMs <= 0 ||
      target.proofLifetimeMs > targetReplayProofMaxLifetimeMs
    ) {
      return result(ReplayContextAttestationStatus.Denied, null, null);
    }
    const replayDecision = replayDecisionFor(
      source.manifest,
      command.replayedManifest,
      target.sourceOperationReceiptIds,
    );
    if (replayDecision.status !== ContextDependencyReplayStatus.Matched) {
      return result(
        ReplayContextAttestationStatus.Denied,
        replayDecision,
        null,
      );
    }
    const proof = createTargetReplayProof(
      {
        replayProofId: this.dependencies.identities.nextReplayProofId(),
        sourceAttestationId: source.attestationId,
        sourceAttestationHash: source.attestationHash,
        sourceOperationReceiptIdsHash:
          target.sourceOperationReceiptIdsHash,
        targetExecutionId: target.targetExecutionId,
        targetWorkSlotId: target.targetWorkSlotId,
        targetReviewRevisionHash: target.targetRevision.reviewRevisionHash,
        targetCheckoutTreeOid: target.targetRevision.checkoutTreeOid,
        replayBinaryHash: target.replayBinaryHash,
        replayPolicyVersion: target.replayPolicyVersion,
        reusePolicyVectorHash: target.reusePolicyVectorHash,
        createdAtMs: nowMs,
        expiresAtMs: Math.min(
          source.reuseExpiresAtMs,
          nowMs + target.proofLifetimeMs,
        ),
      },
      replayDecision,
    );
    const persisted = await this.dependencies.store.saveReplayProof(proof);
    if (persisted.status === ContextAttestationPersistenceStatus.Conflict) {
      return result(
        ReplayContextAttestationStatus.Conflict,
        replayDecision,
        null,
      );
    }
    return result(
      persisted.status === ContextAttestationPersistenceStatus.Created
        ? ReplayContextAttestationStatus.Accepted
        : ReplayContextAttestationStatus.Idempotent,
      replayDecision,
      persisted.value,
    );
  }
}

function replayDecisionFor(
  source: ContextAttestationManifest,
  target: ContextAttestationManifest,
  sourceOperationReceiptIds: readonly string[],
): ContextDependencyReplayDecision {
  if (
    isLegacyContextDependencyManifest(source) &&
    isLegacyContextDependencyManifest(target) &&
    sourceOperationReceiptIds.length === 0
  ) {
    return decideContextDependencyReplay(source, target);
  }
  if (
    !isLegacyContextDependencyManifest(source) &&
    !isLegacyContextDependencyManifest(target) &&
    sourceOperationReceiptIds.length > 0
  ) {
    return decideContextGatewayV4Replay(
      source,
      target,
      sourceOperationReceiptIds,
    );
  }
  return Object.freeze({
    status: ContextDependencyReplayStatus.Denied,
    reason: ContextDependencyReplayDenialReason.ManifestVersionMismatch,
    mismatchedOperationKey: null,
  });
}

function result(
  status: ReplayContextAttestationStatus,
  replayDecision: ContextDependencyReplayDecision | null,
  proof: TargetReplayProof | null,
): ReplayContextAttestationResult {
  return Object.freeze({ status, replayDecision, proof });
}
