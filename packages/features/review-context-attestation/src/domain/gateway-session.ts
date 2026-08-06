export const gatewaySessionMaxLifetimeMs = 60 * 60 * 1_000;

export enum ContextProviderKind {
  Codex = "codex",
  ClaudeCode = "claude_code",
  OpenRouter = "openrouter",
}

export enum ContextLeaseAuthorityKind {
  StandardExecution = "standard_execution",
  InvestigationShadow = "investigation_shadow",
}

export enum GatewaySessionState {
  Opened = "opened",
  Active = "active",
  Sealed = "sealed",
  Accepted = "accepted",
  Rejected = "rejected",
  Revoked = "revoked",
  Expired = "expired",
}

export type ContextAttestationScope = Readonly<{
  workspaceId: string;
  repositoryConnectionId: string;
  scmRepositoryIdentityId: string;
  pullRequestNumber: number;
}>;

export type ContextAttestationRevision = Readonly<{
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
  reviewRevisionHash: string;
  checkoutTreeOid: string;
}>;

export type GatewaySession = Readonly<{
  sessionId: string;
  scope: ContextAttestationScope;
  sourceRevision: ContextAttestationRevision;
  sourceExecutionId: string;
  sourceWorkSlotId: string;
  attemptId: string;
  openingIntentHash: string;
  sourceLeaseAuthorityKind: ContextLeaseAuthorityKind;
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
  state: GatewaySessionState;
  eventCount: number;
  openedAtMs: number;
  expiresAtMs: number;
  sealedAtMs: number | null;
  revokedAtMs: number | null;
}>;

export type OpenGatewaySessionCandidate = Omit<
  GatewaySession,
  "state" | "eventCount" | "sealedAtMs" | "revokedAtMs"
>;

export function openGatewaySession(
  candidate: OpenGatewaySessionCandidate,
): GatewaySession {
  assertIdentifier(candidate.sessionId, "gateway_session_id");
  validateScope(candidate.scope);
  validateRevision(candidate.sourceRevision);
  assertIdentifier(candidate.sourceExecutionId, "source_execution_id");
  assertIdentifier(candidate.sourceWorkSlotId, "source_work_slot_id");
  assertIdentifier(candidate.attemptId, "attempt_id");
  assertSha256(candidate.openingIntentHash, "opening_intent_hash");
  if (
    !Object.values(ContextLeaseAuthorityKind).includes(
      candidate.sourceLeaseAuthorityKind,
    )
  ) {
    throw new Error("source_lease_authority_kind_invalid");
  }
  assertIdentifier(candidate.sourceLeaseId, "source_lease_id");
  assertPositiveIntegerString(
    candidate.sourceFencingToken,
    "source_fencing_token",
  );
  if (!Object.values(ContextProviderKind).includes(candidate.providerKind)) {
    throw new Error("context_provider_kind_invalid");
  }
  assertBoundedString(candidate.requestedModel, "requested_model");
  assertIdentifier(
    candidate.trustedCapabilityProfile,
    "trusted_capability_profile",
  );
  assertSha256(candidate.gatewayBinaryHash, "gateway_binary_hash");
  assertIdentifier(candidate.gatewayPolicyVersion, "gateway_policy_version");
  assertIdentifier(candidate.producerReleaseId, "producer_release_id");
  assertIdentifier(
    candidate.selectedProtocolVersion,
    "selected_protocol_version",
  );
  assertSha256(candidate.confinementProofHash, "confinement_proof_hash");
  assertSha256(candidate.eventChainSeedHash, "event_chain_seed_hash");
  assertEpoch(candidate.openedAtMs, "opened_at_ms");
  assertEpoch(candidate.expiresAtMs, "expires_at_ms");
  if (
    candidate.expiresAtMs <= candidate.openedAtMs ||
    candidate.expiresAtMs - candidate.openedAtMs > gatewaySessionMaxLifetimeMs
  ) {
    throw new Error("gateway_session_lifetime_invalid");
  }
  return Object.freeze({
    ...candidate,
    scope: Object.freeze({ ...candidate.scope }),
    sourceRevision: Object.freeze({ ...candidate.sourceRevision }),
    state: GatewaySessionState.Opened,
    eventCount: 0,
    sealedAtMs: null,
    revokedAtMs: null,
  });
}

export function activateGatewaySession(
  session: GatewaySession,
  nowMs: number,
): GatewaySession {
  assertTransitionTime(session, nowMs);
  if (session.state !== GatewaySessionState.Opened) {
    throw new Error("gateway_session_not_opened");
  }
  return Object.freeze({ ...session, state: GatewaySessionState.Active });
}

export function sealGatewaySession(
  session: GatewaySession,
  input: Readonly<{ eventCount: number; sealedAtMs: number }>,
): GatewaySession {
  assertTransitionTime(session, input.sealedAtMs);
  if (session.state !== GatewaySessionState.Active) {
    throw new Error("gateway_session_not_active");
  }
  if (
    !Number.isSafeInteger(input.eventCount) ||
    input.eventCount < 1 ||
    input.eventCount > 2_000
  ) {
    throw new Error("gateway_session_event_count_invalid");
  }
  return Object.freeze({
    ...session,
    state: GatewaySessionState.Sealed,
    eventCount: input.eventCount,
    sealedAtMs: input.sealedAtMs,
  });
}

export function acceptGatewaySession(session: GatewaySession): GatewaySession {
  if (session.state !== GatewaySessionState.Sealed) {
    throw new Error("gateway_session_not_sealed");
  }
  return Object.freeze({ ...session, state: GatewaySessionState.Accepted });
}

export function revokeGatewaySession(
  session: GatewaySession,
  nowMs: number,
): GatewaySession {
  assertEpoch(nowMs, "revoked_at_ms");
  if (
    session.state === GatewaySessionState.Accepted ||
    session.state === GatewaySessionState.Rejected ||
    session.state === GatewaySessionState.Revoked ||
    session.state === GatewaySessionState.Expired
  ) {
    throw new Error("gateway_session_terminal");
  }
  return Object.freeze({
    ...session,
    state: GatewaySessionState.Revoked,
    revokedAtMs: nowMs,
  });
}

function assertTransitionTime(session: GatewaySession, nowMs: number): void {
  assertEpoch(nowMs, "gateway_session_transition_time");
  if (nowMs < session.openedAtMs || nowMs >= session.expiresAtMs) {
    throw new Error("gateway_session_expired");
  }
}

function validateScope(scope: ContextAttestationScope): void {
  assertIdentifier(scope.workspaceId, "workspace_id");
  assertIdentifier(scope.repositoryConnectionId, "repository_connection_id");
  assertIdentifier(scope.scmRepositoryIdentityId, "scm_repository_identity_id");
  if (
    !Number.isSafeInteger(scope.pullRequestNumber) ||
    scope.pullRequestNumber < 1
  ) {
    throw new Error("pull_request_number_invalid");
  }
}

function validateRevision(revision: ContextAttestationRevision): void {
  assertGitOid(revision.baseSha, "base_sha");
  assertGitOid(revision.mergeBaseSha, "merge_base_sha");
  assertGitOid(revision.headSha, "head_sha");
  assertSha256(revision.reviewRevisionHash, "review_revision_hash");
  assertGitOid(revision.checkoutTreeOid, "checkout_tree_oid");
}

function assertEpoch(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field}_invalid`);
  }
}

function assertGitOid(value: string, field: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
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

function assertPositiveIntegerString(value: string, field: string): void {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new Error(`${field}_invalid`);
  }
}
