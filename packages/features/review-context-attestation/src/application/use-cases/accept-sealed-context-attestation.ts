import {
  canonicalAcceptedDependencyAttestationBytes,
  createAcceptedDependencyAttestation,
  type AcceptedDependencyAttestation,
} from "../../domain/accepted-dependency-attestation";
import { sealGatewaySession } from "../../domain/gateway-session";
import { contextAttestationManifestEventCount } from "../../domain/context-attestation-manifest";
import { createEncryptedContextReplayMaterial } from "../../domain/encrypted-context-replay-material";
import {
  ContextAttestationPersistenceStatus,
  type ContextAttestationClockPort,
  type ContextAttestationDigestPort,
  type ContextAttestationIdentityPort,
  type ContextAttestationStorePort,
  type TrustedSealedGatewayTranscriptPort,
} from "../ports/context-attestation-ports";

export enum AcceptSealedContextAttestationStatus {
  Accepted = "accepted",
  Idempotent = "idempotent",
  Denied = "denied",
  Conflict = "conflict",
}

export type AcceptSealedContextAttestationResult = Readonly<{
  status: AcceptSealedContextAttestationStatus;
  attestation: AcceptedDependencyAttestation | null;
}>;

export class AcceptSealedContextAttestation {
  constructor(
    private readonly dependencies: Readonly<{
      transcripts: TrustedSealedGatewayTranscriptPort;
      store: ContextAttestationStorePort;
      identities: ContextAttestationIdentityPort;
      digest: ContextAttestationDigestPort;
      clock: ContextAttestationClockPort;
      reuseTtlMs: number;
    }>,
  ) {
    if (
      !Number.isSafeInteger(dependencies.reuseTtlMs) ||
      dependencies.reuseTtlMs <= 0
    ) {
      throw new Error("context_attestation_reuse_ttl_invalid");
    }
  }

  async execute(command: {
    readonly sessionId: string;
    readonly sealCapabilityId: string;
  }): Promise<AcceptSealedContextAttestationResult> {
    const [session, existing] = await Promise.all([
      this.dependencies.store.findSession(command.sessionId),
      this.dependencies.store.findAcceptedAttestationBySessionId(
        command.sessionId,
      ),
    ]);
    if (existing) {
      return result(AcceptSealedContextAttestationStatus.Idempotent, existing);
    }
    const transcript =
      await this.dependencies.transcripts.loadSealedTranscript(command);
    if (
      !session ||
      !transcript ||
      transcript.sessionId !== session.sessionId ||
      transcript.confinementProofHash !== session.confinementProofHash ||
      !transcript.providerSucceeded ||
      !transcript.schemaValidated ||
      !transcript.fullyConsumed
    ) {
      return result(AcceptSealedContextAttestationStatus.Denied, null);
    }
    const nowMs = this.dependencies.clock.nowMs();
    const reuseExpiresAtMs = nowMs + this.dependencies.reuseTtlMs;
    let replayMaterial;
    try {
      replayMaterial = createEncryptedContextReplayMaterial(
        transcript.replayMaterial,
      );
    } catch {
      return result(AcceptSealedContextAttestationStatus.Denied, null);
    }
    if (
      replayMaterial.sessionId !== session.sessionId ||
      replayMaterial.expiresAtMs < reuseExpiresAtMs
    ) {
      return result(AcceptSealedContextAttestationStatus.Denied, null);
    }
    let sealed;
    try {
      sealed = sealGatewaySession(session, {
        eventCount: contextAttestationManifestEventCount(transcript.manifest),
        sealedAtMs: nowMs,
      });
    } catch {
      return result(AcceptSealedContextAttestationStatus.Denied, null);
    }
    const attestationId = this.dependencies.identities.nextAttestationId();
    const candidateWithoutHash = {
      attestationId,
      sessionId: sealed.sessionId,
      sourceExecutionId: sealed.sourceExecutionId,
      sourceWorkSlotId: sealed.sourceWorkSlotId,
      attemptId: sealed.attemptId,
      sourceLeaseId: sealed.sourceLeaseId,
      sourceFencingToken: sealed.sourceFencingToken,
      sourceReviewRevisionHash: sealed.sourceRevision.reviewRevisionHash,
      trustedCapabilityProfile: sealed.trustedCapabilityProfile,
      manifest: transcript.manifest,
      actualModel: transcript.actualModel,
      terminalOutcomeHash: transcript.terminalOutcomeHash,
      replayMaterialHash: replayMaterial.plaintextHash,
      acceptedAtMs: nowMs,
      reuseExpiresAtMs,
    };
    const attestationHash = await this.dependencies.digest.digest(
      canonicalAcceptedDependencyAttestationBytes(candidateWithoutHash),
    );
    const accepted = createAcceptedDependencyAttestation({
      attestationId,
      attestationHash,
      session: sealed,
      manifest: transcript.manifest,
      actualModel: transcript.actualModel,
      terminalOutcomeHash: transcript.terminalOutcomeHash,
      replayMaterialHash: replayMaterial.plaintextHash,
      acceptedAtMs: nowMs,
      reuseExpiresAtMs,
    });
    const persisted = await this.dependencies.store.acceptAttestation({
      expectedSession: sealed,
      acceptedSession: accepted.session,
      attestation: accepted.attestation,
      replayMaterial,
    });
    switch (persisted.status) {
      case ContextAttestationPersistenceStatus.Created:
        return result(
          AcceptSealedContextAttestationStatus.Accepted,
          persisted.value,
        );
      case ContextAttestationPersistenceStatus.Idempotent:
        return result(
          AcceptSealedContextAttestationStatus.Idempotent,
          persisted.value,
        );
      case ContextAttestationPersistenceStatus.Conflict:
        return result(AcceptSealedContextAttestationStatus.Conflict, null);
    }
  }
}

function result(
  status: AcceptSealedContextAttestationStatus,
  attestation: AcceptedDependencyAttestation | null,
): AcceptSealedContextAttestationResult {
  return Object.freeze({ status, attestation });
}
