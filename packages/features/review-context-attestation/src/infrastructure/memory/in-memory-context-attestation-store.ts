import {
  ContextAttestationPersistenceStatus,
  type ContextAttestationPersistenceResult,
  type ContextAttestationStorePort,
} from "../../application/ports/context-attestation-ports";
import type { AcceptedDependencyAttestation } from "../../domain/accepted-dependency-attestation";
import {
  canonicalContextAttestationManifest,
  contextAttestationManifestEventCount,
} from "../../domain/context-attestation-manifest";
import type { EncryptedContextReplayMaterial } from "../../domain/encrypted-context-replay-material";
import {
  GatewaySessionState,
  isGatewaySessionTerminal,
  isValidGatewaySessionAbandonTransition,
  sameGatewaySessionIdentity,
  type GatewaySession,
} from "../../domain/gateway-session";
import type { TargetReplayProof } from "../../domain/target-replay-proof";

export class InMemoryContextAttestationStore implements ContextAttestationStorePort {
  private readonly sessions = new Map<string, GatewaySession>();
  private readonly sessionIdsByOpening = new Map<string, string>();
  private readonly attestations = new Map<
    string,
    AcceptedDependencyAttestation
  >();
  private readonly attestationIdsBySession = new Map<string, string>();
  private readonly replayMaterialsByAttestation = new Map<
    string,
    EncryptedContextReplayMaterial
  >();
  private readonly replayProofs = new Map<string, TargetReplayProof>();
  private readonly replayProofIdsByTarget = new Map<string, string>();

  async openSession(
    session: GatewaySession,
  ): Promise<ContextAttestationPersistenceResult<GatewaySession>> {
    const openingKey = sessionOpeningKey(session);
    const existingId = this.sessionIdsByOpening.get(openingKey);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (!existing) throw new Error("gateway_session_index_corrupt");
      return sameOpening(existing, session)
        ? persisted(ContextAttestationPersistenceStatus.Idempotent, existing)
        : conflict();
    }
    if (this.sessions.has(session.sessionId)) return conflict();
    this.sessions.set(session.sessionId, session);
    this.sessionIdsByOpening.set(openingKey, session.sessionId);
    return persisted(ContextAttestationPersistenceStatus.Created, session);
  }

  async findSession(sessionId: string): Promise<GatewaySession | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async abandonSession(input: {
    readonly expectedSession: GatewaySession;
    readonly terminalSession: GatewaySession;
  }): Promise<ContextAttestationPersistenceResult<GatewaySession>> {
    if (!isValidGatewaySessionAbandonTransition(input)) return conflict();
    const current = this.sessions.get(input.expectedSession.sessionId);
    if (
      !current ||
      !sameGatewaySessionIdentity(current, input.expectedSession)
    ) {
      return conflict();
    }
    if (isGatewaySessionTerminal(current)) {
      return persisted(ContextAttestationPersistenceStatus.Idempotent, current);
    }
    if (current.state !== input.expectedSession.state) return conflict();
    this.sessions.set(current.sessionId, input.terminalSession);
    return persisted(
      ContextAttestationPersistenceStatus.Created,
      input.terminalSession,
    );
  }

  async acceptAttestation(input: {
    readonly expectedSession: GatewaySession;
    readonly acceptedSession: GatewaySession;
    readonly attestation: AcceptedDependencyAttestation;
    readonly replayMaterial: EncryptedContextReplayMaterial;
  }): Promise<
    ContextAttestationPersistenceResult<AcceptedDependencyAttestation>
  > {
    if (!validAcceptanceAggregate(input)) return conflict();
    const existingId = this.attestationIdsBySession.get(
      input.expectedSession.sessionId,
    );
    if (existingId) {
      const existing = this.attestations.get(existingId);
      if (!existing) throw new Error("context_attestation_index_corrupt");
      return sameAttestationIntent(existing, input.attestation)
        ? persisted(ContextAttestationPersistenceStatus.Idempotent, existing)
        : conflict();
    }
    const current = this.sessions.get(input.expectedSession.sessionId);
    if (
      !current ||
      current.state !== GatewaySessionState.Active ||
      !sameOpening(current, input.expectedSession) ||
      input.acceptedSession.state !== GatewaySessionState.Accepted ||
      input.attestation.sessionId !== current.sessionId ||
      input.replayMaterial.sessionId !== current.sessionId ||
      input.replayMaterial.plaintextHash !==
        input.attestation.replayMaterialHash
    ) {
      return conflict();
    }
    if (
      this.attestations.has(input.attestation.attestationId) ||
      [...this.attestations.values()].some(
        (item) => item.attestationHash === input.attestation.attestationHash,
      )
    ) {
      return conflict();
    }
    this.sessions.set(current.sessionId, input.acceptedSession);
    this.attestations.set(input.attestation.attestationId, input.attestation);
    this.replayMaterialsByAttestation.set(
      input.attestation.attestationId,
      input.replayMaterial,
    );
    this.attestationIdsBySession.set(
      current.sessionId,
      input.attestation.attestationId,
    );
    return persisted(
      ContextAttestationPersistenceStatus.Created,
      input.attestation,
    );
  }

  async findAcceptedAttestation(
    attestationId: string,
  ): Promise<AcceptedDependencyAttestation | null> {
    return this.attestations.get(attestationId) ?? null;
  }

  async findAcceptedAttestationBySessionId(
    sessionId: string,
  ): Promise<AcceptedDependencyAttestation | null> {
    const id = this.attestationIdsBySession.get(sessionId);
    return id ? (this.attestations.get(id) ?? null) : null;
  }

  async findReplayMaterialByAttestationId(
    attestationId: string,
  ): Promise<EncryptedContextReplayMaterial | null> {
    return this.replayMaterialsByAttestation.get(attestationId) ?? null;
  }

  async saveReplayProof(
    proof: TargetReplayProof,
  ): Promise<ContextAttestationPersistenceResult<TargetReplayProof>> {
    const key = replayTargetKey(proof);
    const existingId = this.replayProofIdsByTarget.get(key);
    if (existingId) {
      const existing = this.replayProofs.get(existingId);
      if (!existing) throw new Error("context_replay_proof_index_corrupt");
      if (existing.expiresAtMs <= proof.createdAtMs) {
        if (
          this.replayProofs.has(proof.replayProofId) &&
          proof.replayProofId !== existing.replayProofId
        ) {
          return conflict();
        }
        this.replayProofs.delete(existing.replayProofId);
        this.replayProofs.set(proof.replayProofId, proof);
        this.replayProofIdsByTarget.set(key, proof.replayProofId);
        return persisted(ContextAttestationPersistenceStatus.Created, proof);
      }
      return sameReplayProof(existing, proof)
        ? persisted(ContextAttestationPersistenceStatus.Idempotent, existing)
        : conflict();
    }
    if (this.replayProofs.has(proof.replayProofId)) return conflict();
    this.replayProofs.set(proof.replayProofId, proof);
    this.replayProofIdsByTarget.set(key, proof.replayProofId);
    return persisted(ContextAttestationPersistenceStatus.Created, proof);
  }

  async findReplayProof(
    replayProofId: string,
  ): Promise<TargetReplayProof | null> {
    return this.replayProofs.get(replayProofId) ?? null;
  }
}

function sameOpening(left: GatewaySession, right: GatewaySession): boolean {
  return (
    JSON.stringify([
      left.scope,
      left.sourceRevision,
      left.sourceExecutionId,
      left.sourceWorkSlotId,
      left.attemptId,
      left.openingIntentHash,
      left.sourceLeaseAuthorityKind,
      left.sourceLeaseId,
      left.sourceFencingToken,
      left.providerKind,
      left.requestedModel,
      left.trustedCapabilityProfile,
      left.gatewayBinaryHash,
      left.gatewayPolicyVersion,
      left.producerReleaseId,
      left.selectedProtocolVersion,
      left.confinementProofHash,
      left.eventChainSeedHash,
      left.expiresAtMs - left.openedAtMs,
    ]) ===
    JSON.stringify([
      right.scope,
      right.sourceRevision,
      right.sourceExecutionId,
      right.sourceWorkSlotId,
      right.attemptId,
      right.openingIntentHash,
      right.sourceLeaseAuthorityKind,
      right.sourceLeaseId,
      right.sourceFencingToken,
      right.providerKind,
      right.requestedModel,
      right.trustedCapabilityProfile,
      right.gatewayBinaryHash,
      right.gatewayPolicyVersion,
      right.producerReleaseId,
      right.selectedProtocolVersion,
      right.confinementProofHash,
      right.eventChainSeedHash,
      right.expiresAtMs - right.openedAtMs,
    ])
  );
}

function sessionOpeningKey(session: GatewaySession): string {
  return `${session.attemptId}:${session.openingIntentHash}`;
}

function replayTargetKey(proof: TargetReplayProof): string {
  return [
    proof.sourceAttestationId,
    proof.targetExecutionId,
    proof.targetWorkSlotId,
    proof.targetReviewRevisionHash,
    proof.reusePolicyVectorHash,
    proof.sourceOperationReceiptIdsHash ?? "legacy_full_attestation",
  ].join("\0");
}

function sameAttestationIntent(
  left: AcceptedDependencyAttestation,
  right: AcceptedDependencyAttestation,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sourceExecutionId === right.sourceExecutionId &&
    left.sourceWorkSlotId === right.sourceWorkSlotId &&
    left.attemptId === right.attemptId &&
    left.sourceLeaseAuthorityKind === right.sourceLeaseAuthorityKind &&
    left.sourceLeaseId === right.sourceLeaseId &&
    left.sourceFencingToken === right.sourceFencingToken &&
    left.sourceReviewRevisionHash === right.sourceReviewRevisionHash &&
    left.trustedCapabilityProfile === right.trustedCapabilityProfile &&
    canonicalContextAttestationManifest(left.manifest) ===
      canonicalContextAttestationManifest(right.manifest) &&
    left.actualModel === right.actualModel &&
    left.terminalOutcomeHash === right.terminalOutcomeHash
  );
}

function validAcceptanceAggregate(input: {
  readonly expectedSession: GatewaySession;
  readonly acceptedSession: GatewaySession;
  readonly attestation: AcceptedDependencyAttestation;
  readonly replayMaterial: EncryptedContextReplayMaterial;
}): boolean {
  const sessionId = input.expectedSession.sessionId;
  return (
    input.expectedSession.state === GatewaySessionState.Sealed &&
    input.acceptedSession.state === GatewaySessionState.Accepted &&
    input.acceptedSession.sessionId === sessionId &&
    sameOpening(input.expectedSession, input.acceptedSession) &&
    input.expectedSession.eventCount ===
      contextAttestationManifestEventCount(input.attestation.manifest) &&
    input.acceptedSession.eventCount === input.expectedSession.eventCount &&
    input.acceptedSession.sealedAtMs === input.expectedSession.sealedAtMs &&
    input.attestation.sessionId === sessionId &&
    input.replayMaterial.sessionId === sessionId &&
    input.replayMaterial.plaintextHash ===
      input.attestation.replayMaterialHash &&
    input.attestation.sourceExecutionId ===
      input.expectedSession.sourceExecutionId &&
    input.attestation.sourceWorkSlotId ===
      input.expectedSession.sourceWorkSlotId &&
    input.attestation.attemptId === input.expectedSession.attemptId &&
    input.attestation.sourceLeaseAuthorityKind ===
      input.expectedSession.sourceLeaseAuthorityKind &&
    input.attestation.sourceLeaseId === input.expectedSession.sourceLeaseId &&
    input.attestation.sourceFencingToken ===
      input.expectedSession.sourceFencingToken &&
    input.attestation.sourceReviewRevisionHash ===
      input.expectedSession.sourceRevision.reviewRevisionHash
  );
}

function sameReplayProof(
  left: TargetReplayProof,
  right: TargetReplayProof,
): boolean {
  return (
    left.sourceAttestationId === right.sourceAttestationId &&
    left.sourceAttestationHash === right.sourceAttestationHash &&
    left.sourceOperationReceiptIdsHash ===
      right.sourceOperationReceiptIdsHash &&
    left.targetExecutionId === right.targetExecutionId &&
    left.targetWorkSlotId === right.targetWorkSlotId &&
    left.targetReviewRevisionHash === right.targetReviewRevisionHash &&
    left.targetCheckoutTreeOid === right.targetCheckoutTreeOid &&
    left.replayBinaryHash === right.replayBinaryHash &&
    left.replayPolicyVersion === right.replayPolicyVersion &&
    left.reusePolicyVectorHash === right.reusePolicyVectorHash
  );
}

function persisted<T>(
  status:
    | ContextAttestationPersistenceStatus.Created
    | ContextAttestationPersistenceStatus.Idempotent,
  value: T,
): ContextAttestationPersistenceResult<T> {
  return Object.freeze({ status, value });
}

function conflict<T>(): ContextAttestationPersistenceResult<T> {
  return Object.freeze({
    status: ContextAttestationPersistenceStatus.Conflict,
  });
}
