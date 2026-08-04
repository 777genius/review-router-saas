import type { AcceptedDependencyAttestation } from "../../domain/accepted-dependency-attestation";
import type { ContextAttestationManifest } from "../../domain/context-attestation-manifest";
import type { EncryptedContextReplayMaterial } from "../../domain/encrypted-context-replay-material";
import type {
  ContextAttestationRevision,
  ContextAttestationScope,
  ContextProviderKind,
  GatewaySession,
} from "../../domain/gateway-session";
import type { TargetReplayProof } from "../../domain/target-replay-proof";

export type TrustedGatewaySessionOpeningFacts = Readonly<{
  scope: ContextAttestationScope;
  sourceRevision: ContextAttestationRevision;
  sourceExecutionId: string;
  sourceWorkSlotId: string;
  attemptId: string;
  openingIntentHash: string;
  sourceLeaseId: string;
  sourceFencingToken: string;
  providerKind: ContextProviderKind;
  requestedModel: string;
  trustedCapabilityProfile: string;
  gatewayBinaryHash: string;
  gatewayPolicyVersion: string;
  producerReleaseId: string;
  selectedProtocolVersion: string;
  confinementProofHash: string;
  eventChainSeedHash: string;
  sessionLifetimeMs: number;
}>;

export interface TrustedGatewaySessionOpeningFactsPort {
  resolveOpeningFacts(input: {
    readonly attemptId: string;
    readonly leaseCapabilityId: string;
    readonly confinementEvidenceId: string;
  }): Promise<TrustedGatewaySessionOpeningFacts | null>;
}

export type TrustedSealedGatewayTranscript = Readonly<{
  sessionId: string;
  confinementProofHash: string;
  manifest: ContextAttestationManifest;
  actualModel: string;
  terminalOutcomeHash: string;
  providerSucceeded: boolean;
  schemaValidated: boolean;
  fullyConsumed: boolean;
  replayMaterial: EncryptedContextReplayMaterial;
}>;

export interface TrustedSealedGatewayTranscriptPort {
  loadSealedTranscript(input: {
    readonly sessionId: string;
    readonly sealCapabilityId: string;
  }): Promise<TrustedSealedGatewayTranscript | null>;
}

export enum ContextAttestationPersistenceStatus {
  Created = "created",
  Idempotent = "idempotent",
  Conflict = "conflict",
}

export type ContextAttestationPersistenceResult<T> =
  | Readonly<{
      status:
        | ContextAttestationPersistenceStatus.Created
        | ContextAttestationPersistenceStatus.Idempotent;
      value: T;
    }>
  | Readonly<{
      status: ContextAttestationPersistenceStatus.Conflict;
    }>;

export interface ContextAttestationStorePort {
  openSession(
    session: GatewaySession,
  ): Promise<ContextAttestationPersistenceResult<GatewaySession>>;
  findSession(sessionId: string): Promise<GatewaySession | null>;
  acceptAttestation(input: {
    readonly expectedSession: GatewaySession;
    readonly acceptedSession: GatewaySession;
    readonly attestation: AcceptedDependencyAttestation;
    readonly replayMaterial: EncryptedContextReplayMaterial;
  }): Promise<
    ContextAttestationPersistenceResult<AcceptedDependencyAttestation>
  >;
  findAcceptedAttestation(
    attestationId: string,
  ): Promise<AcceptedDependencyAttestation | null>;
  findAcceptedAttestationBySessionId(
    sessionId: string,
  ): Promise<AcceptedDependencyAttestation | null>;
  findReplayMaterialByAttestationId(
    attestationId: string,
  ): Promise<EncryptedContextReplayMaterial | null>;
  saveReplayProof(
    proof: TargetReplayProof,
  ): Promise<ContextAttestationPersistenceResult<TargetReplayProof>>;
  findReplayProof(replayProofId: string): Promise<TargetReplayProof | null>;
}

export interface ContextAttestationIdentityPort {
  nextGatewaySessionId(): string;
  nextAttestationId(): string;
  nextReplayProofId(): string;
}

export interface ContextAttestationDigestPort {
  digest(bytes: Uint8Array): Promise<string>;
}

export interface ContextAttestationClockPort {
  nowMs(): number;
}

export interface ContextReplayMaterialCipherPort {
  encrypt(input: {
    readonly sessionId: string;
    readonly plaintextCanonicalJson: string;
    readonly associatedDataCanonicalJson: string;
    readonly expiresAtMs: number;
  }): Promise<EncryptedContextReplayMaterial>;
  decrypt(input: {
    readonly material: EncryptedContextReplayMaterial;
    readonly associatedDataCanonicalJson: string;
  }): Promise<string>;
}

export type TargetReplayFacts = Readonly<{
  targetExecutionId: string;
  targetWorkSlotId: string;
  targetRevision: ContextAttestationRevision;
  replayBinaryHash: string;
  replayPolicyVersion: string;
  reusePolicyVectorHash: string;
  sourceOperationReceiptIds: readonly string[];
  sourceOperationReceiptIdsHash: string | null;
  proofLifetimeMs: number;
}>;

export interface TrustedTargetReplayFactsPort {
  resolveTargetReplayFacts(input: {
    readonly targetExecutionId: string;
    readonly targetWorkSlotId: string;
    readonly replayCapabilityId: string;
  }): Promise<TargetReplayFacts | null>;
}
