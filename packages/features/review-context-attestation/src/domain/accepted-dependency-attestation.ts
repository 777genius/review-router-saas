import {
  canonicalContextAttestationManifestBytes,
  contextAttestationManifestEventCount,
  createContextAttestationManifest,
  type ContextAttestationManifest,
} from "./context-attestation-manifest";
import {
  GatewaySessionState,
  acceptGatewaySession,
  type GatewaySession,
} from "./gateway-session";

export const acceptedDependencyAttestationMaxRetentionMs =
  30 * 24 * 60 * 60 * 1_000;

export type AcceptedDependencyAttestation = Readonly<{
  attestationId: string;
  attestationHash: string;
  sessionId: string;
  sourceExecutionId: string;
  sourceWorkSlotId: string;
  attemptId: string;
  sourceLeaseId: string;
  sourceFencingToken: string;
  sourceReviewRevisionHash: string;
  trustedCapabilityProfile: string;
  manifest: ContextAttestationManifest;
  actualModel: string;
  terminalOutcomeHash: string;
  replayMaterialHash: string;
  acceptedAtMs: number;
  reuseExpiresAtMs: number;
}>;

export type AcceptDependencyAttestationCandidate = Readonly<{
  attestationId: string;
  attestationHash: string;
  session: GatewaySession;
  manifest: ContextAttestationManifest;
  actualModel: string;
  terminalOutcomeHash: string;
  replayMaterialHash: string;
  acceptedAtMs: number;
  reuseExpiresAtMs: number;
}>;

export function createAcceptedDependencyAttestation(
  candidate: AcceptDependencyAttestationCandidate,
): Readonly<{
  session: GatewaySession;
  attestation: AcceptedDependencyAttestation;
}> {
  assertIdentifier(candidate.attestationId, "context_attestation_id");
  assertSha256(candidate.attestationHash, "context_attestation_hash");
  assertSha256(candidate.terminalOutcomeHash, "terminal_outcome_hash");
  assertSha256(candidate.replayMaterialHash, "replay_material_hash");
  assertBoundedString(candidate.actualModel, "actual_model");
  assertEpoch(candidate.acceptedAtMs, "accepted_at_ms");
  assertEpoch(candidate.reuseExpiresAtMs, "reuse_expires_at_ms");
  if (
    candidate.session.state !== GatewaySessionState.Sealed ||
    candidate.session.sealedAtMs === null
  ) {
    throw new Error("gateway_session_not_sealed");
  }
  if (
    candidate.acceptedAtMs < candidate.session.sealedAtMs ||
    candidate.acceptedAtMs >= candidate.session.expiresAtMs
  ) {
    throw new Error("context_attestation_acceptance_time_invalid");
  }
  if (
    candidate.reuseExpiresAtMs <= candidate.acceptedAtMs ||
    candidate.reuseExpiresAtMs - candidate.acceptedAtMs >
      acceptedDependencyAttestationMaxRetentionMs
  ) {
    throw new Error("context_attestation_retention_invalid");
  }
  const manifest = createContextAttestationManifest(candidate.manifest);
  if (
    manifest.gatewayBinaryHash !== candidate.session.gatewayBinaryHash ||
    manifest.gatewayPolicyVersion !== candidate.session.gatewayPolicyVersion ||
    manifest.checkoutTreeOid !==
      candidate.session.sourceRevision.checkoutTreeOid
  ) {
    throw new Error("context_attestation_gateway_binding_mismatch");
  }
  if (
    contextAttestationManifestEventCount(manifest) !==
    candidate.session.eventCount
  ) {
    throw new Error("context_attestation_event_count_mismatch");
  }

  return Object.freeze({
    session: acceptGatewaySession(candidate.session),
    attestation: Object.freeze({
      attestationId: candidate.attestationId,
      attestationHash: candidate.attestationHash,
      sessionId: candidate.session.sessionId,
      sourceExecutionId: candidate.session.sourceExecutionId,
      sourceWorkSlotId: candidate.session.sourceWorkSlotId,
      attemptId: candidate.session.attemptId,
      sourceLeaseId: candidate.session.sourceLeaseId,
      sourceFencingToken: candidate.session.sourceFencingToken,
      sourceReviewRevisionHash:
        candidate.session.sourceRevision.reviewRevisionHash,
      trustedCapabilityProfile: candidate.session.trustedCapabilityProfile,
      manifest,
      actualModel: candidate.actualModel,
      terminalOutcomeHash: candidate.terminalOutcomeHash,
      replayMaterialHash: candidate.replayMaterialHash,
      acceptedAtMs: candidate.acceptedAtMs,
      reuseExpiresAtMs: candidate.reuseExpiresAtMs,
    }),
  });
}

export function canonicalAcceptedDependencyAttestationBytes(
  candidate: Omit<AcceptedDependencyAttestation, "attestationHash">,
): Uint8Array {
  const manifestBytes = canonicalContextAttestationManifestBytes(
    candidate.manifest,
  );
  const envelope = JSON.stringify({
    acceptedAtMs: candidate.acceptedAtMs,
    actualModel: candidate.actualModel,
    attestationId: candidate.attestationId,
    manifest: new TextDecoder().decode(manifestBytes),
    reuseExpiresAtMs: candidate.reuseExpiresAtMs,
    replayMaterialHash: candidate.replayMaterialHash,
    sessionId: candidate.sessionId,
    sourceExecutionId: candidate.sourceExecutionId,
    sourceFencingToken: candidate.sourceFencingToken,
    sourceLeaseId: candidate.sourceLeaseId,
    sourceReviewRevisionHash: candidate.sourceReviewRevisionHash,
    sourceWorkSlotId: candidate.sourceWorkSlotId,
    terminalOutcomeHash: candidate.terminalOutcomeHash,
    trustedCapabilityProfile: candidate.trustedCapabilityProfile,
  });
  return new TextEncoder().encode(envelope);
}

function assertEpoch(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field}_invalid`);
  }
}

function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field}_invalid`);
}

function assertIdentifier(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) {
    throw new Error(`${field}_invalid`);
  }
}

function assertBoundedString(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.includes("\0")
  ) {
    throw new Error(`${field}_invalid`);
  }
}
