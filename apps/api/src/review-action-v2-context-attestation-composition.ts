import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  AbandonContextGatewaySession,
  AbandonContextGatewaySessionStatus,
  AcceptSealedContextAttestation,
  AcceptSealedContextAttestationStatus,
  ContextDependencyKind,
  ContextGatewayV4OperationKind,
  ContextGatewayV4OutcomeKind,
  ContextLeaseAuthorityKind,
  ContextProviderKind,
  OpenContextGatewaySession,
  OpenContextGatewaySessionStatus,
  ReplayContextAttestation,
  ReplayContextAttestationStatus,
  TargetReplayProofVerificationStatus,
  VerifyTargetReplayProof,
  canonicalContextAttestationManifest,
  canonicalContextDependencyOperation,
  canonicalContextDependencyResult,
  contextGatewayV4PolicyVersion,
  createContextAttestationManifest,
  isContextGatewayV4ValidationIssue,
  isLegacyContextDependencyManifest,
  type ContextAttestationStorePort,
  type ContextAttestationManifest,
  type ContextDependencyManifest,
  type ContextGatewayV4Manifest,
  type ContextReplayMaterialCipherPort,
  type GatewaySession,
  type TargetReplayProof,
} from "@reviewrouter/features-review-context-attestation";
import type {
  InvestigationLeaseQueryPort,
  InvestigationReplayPreparationPort,
  InvestigationStorePort,
  PreparedInvestigationReceiptReplay,
  ReviewInvestigationLease,
} from "@reviewrouter/features-review-investigations";
import {
  ReviewInvestigationLeaseProtectedOperation,
  ReviewInvestigationLeaseState,
  ReviewInvestigationTurnPurpose,
  assertReviewInvestigationLeaseAllows,
  reviewInvestigationLeaseBindingIsCurrent,
} from "@reviewrouter/features-review-investigations";
import { AesGcmContextReplayMaterialCipher } from "@reviewrouter/features-review-context-attestation/composition";
import {
  ProviderExecutionProfile,
  ReuseEligibility,
  ReviewReuseDenialReason,
  ReviewReuseEffectMode,
  ReviewReuseTier,
  ReviewProviderKind,
  canonicalizeReviewContextReusePolicyVector,
  decideReviewReuseEligibility,
  normalizeProviderInvocationManifest,
  reviewReuseEligibilityPolicyVersion,
  serializeProviderInvocationManifestCanonicalWireJson,
  stableJson,
  type CurrentReviewReusePolicyPort,
  type ProviderInvocationManifest,
  type ReviewObservation,
  type ReviewObservationQueryPort,
  type ReviewTrustDomain,
} from "@reviewrouter/features-review-evidence";
import {
  InvestigationRolloutCapability,
  InvestigationRolloutProvider,
} from "@reviewrouter/features-review-investigation-operations";
import {
  ReviewExecutionProviderKind,
  ReviewInvocationLeasePurpose,
  ReviewInvocationLeaseState,
  ReviewObservationAttachmentKind,
  type ReviewExecutionQueryPort,
  type ReviewExecutionSnapshot,
  type ReviewInvocationLease,
} from "@reviewrouter/features-review-executions";
import {
  ReviewActionV2RouteFailure,
  type RegisterReviewContextAttestationV2RoutesDependencies,
} from "@reviewrouter/features-action-control-plane/v2";
import {
  ReviewRunAuthorizationState,
  ReviewRunAuthorizationTokenResolutionStatus,
  canonicalJson,
  type ReviewRunAuthorization,
  type ReviewRunAuthorizationTokenResolution,
} from "@reviewrouter/features-review-run-control";
import {
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
  ReviewContextGatewayAbandonResultStatus,
  ReviewContextGatewayOpenResultStatus,
  ReviewContextGatewaySealResultStatus,
  ReviewContextReceiptReplayCommitResultStatus,
  ReviewContextReplayCommitResultStatus,
  canonicalizeReviewContextConfinementEvidence,
  canonicalizeReviewInvestigationContextConfinementEvidence,
  canonicalizeReviewContextGatewayEvent,
  canonicalizeReviewContextReplayChainSeed,
  canonicalizeReviewContextReplayEvent,
  canonicalizeReviewContextReplayHandle,
  canonicalizeReviewContextSearchQuery,
  canonicalizeReviewActionV2Request,
  type ReviewActionV2RequestMap,
  type ReviewContextGatewayOpenRequest,
  type ReviewContextGatewayAbandonRequest,
  type ReviewContextGatewaySealRequest,
  type ReviewInvestigationContextGatewayAbandonRequest,
  type ReviewInvestigationContextGatewayOpenRequest,
  type ReviewInvestigationContextGatewaySealRequest,
  type ReviewContextReceiptReplayCommitRequest,
  type ReviewContextReplayCommitRequest,
} from "@reviewrouter/protocol-review-action-v2";
import {
  type ReviewActionV2ContextReplayAuthority,
  type ReviewActionV2InvestigationReceiptReplayAuthority,
  type ReviewActionV2ExecutionEvidenceCapabilityAdapter,
  type ReviewActionV2ContextGatewaySealAuthority,
  type ReviewActionV2InvestigationContextGatewaySealAuthority,
  type ReviewActionV2ReusableAttachmentAuthority,
  type VerifiedReviewActionV2LeaseCapability,
} from "./review-action-v2-execution-evidence-capabilities.js";
import {
  hasAuthorizedReviewInvestigationExtension,
  type ReviewInvestigationAuthorizedProviderKind,
} from "./review-action-v2-investigation-extension-admission.js";
import type { ReviewInvestigationRolloutGuardPort } from "./review-investigation-rollout-guard.js";
import type {
  ReviewActionV2InvestigationLeaseCapabilityPort,
  VerifiedReviewActionV2InvestigationLeaseCapability,
} from "./review-action-v2-investigation-lease-capabilities.js";

const gatewaySeedDomain = "rr.context-gateway-seed.v1";
const gatewaySecretDomain = "rr.context-gateway-session-secret.v1";
const replayMaterialVersion = 1;
const replayPlanVersion = 1;

export const reviewActionV2ContextSessionSecretEnv =
  "REVIEW_ROUTER_REVIEW_V2_CONTEXT_SESSION_SECRET_BASE64";
export const reviewActionV2ContextReplayActiveKeyIdEnv =
  "REVIEW_ROUTER_REVIEW_V2_CONTEXT_REPLAY_ACTIVE_KEY_ID";
export const reviewActionV2ContextReplayKeysEnv =
  "REVIEW_ROUTER_REVIEW_V2_CONTEXT_REPLAY_KEYS_JSON";
export type ReviewActionV2ContextAttestationConfig = Readonly<{
  sessionLifetimeMs: number;
  reuseTtlMs: number;
  replayProofLifetimeMs: number;
  replayCapabilityLifetimeMs: number;
  attachmentCapabilityLifetimeMs: number;
}>;

export interface ReviewActionV2ContextAuthorizationResolverPort {
  resolveReviewRunAuthorizationToken(input: {
    readonly token: string;
  }): Promise<ReviewRunAuthorizationTokenResolution>;
}

export interface ReviewActionV2ContextDigestPort {
  digestUtf8(value: string): Promise<string>;
  digest(value: Uint8Array): Promise<string>;
}

export interface ReviewActionV2CheckoutTreeResolverPort {
  resolveCheckoutTreeOid(
    authorization: ReviewRunAuthorization,
  ): Promise<string | null>;
}

export interface ReviewActionV2ProducerReleaseProfilePort {
  resolve(input: { readonly producerReleaseId: string }): Promise<Readonly<{
    capabilityProfile: string;
    runtimeCommitSha: string;
    contextGatewayPolicyVersion: string | null;
    contextGatewayEntrypointDigest: string | null;
  }> | null>;
}

type ReplayPlanSourceDependency = Readonly<{
  sequence: number;
  operationKey: string;
  operation: ContextDependencyManifest["dependencies"][number]["operation"];
  replayQuery: string | null;
}>;

export type ReviewActionV2ContextReplayPlan = Readonly<{
  planVersion: typeof replayPlanVersion;
  attestationId: string;
  attestationHash: string;
  gatewayPolicyVersion: string;
  gatewayBinaryHash: string;
  sourceDependencies: readonly ReplayPlanSourceDependency[];
}>;

export type ReviewActionV2ContextReplayPreparation = Readonly<{
  contextDependencyAttestationId: string;
  contextDependencyAttestationHash: string;
  contextReplayCapability: string;
  contextReplayPlanCanonicalJson: string;
  contextReplayPlanHash: string;
}>;

export type ReviewActionV2ContextReplayPrepareInput = Readonly<{
  authorization: ReviewRunAuthorization;
  snapshot: ReviewExecutionSnapshot;
  workSlotId: string;
  manifest: ProviderInvocationManifest;
  manifestKey: string;
  providerInvocationKey: string;
  providerVoteIdentityHash: string;
  trustDomain: ReviewTrustDomain;
  observation: ReviewObservation;
}>;

export interface ReviewActionV2ContextReplayCoordinatorPort {
  prepareReplay(
    input: ReviewActionV2ContextReplayPrepareInput,
  ): Promise<ReviewActionV2ContextReplayPreparation | null>;
  verifyAttachment(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly snapshot: ReviewExecutionSnapshot;
    readonly authority: ReviewActionV2ReusableAttachmentAuthority;
  }): Promise<boolean>;
  assertCurrentPolicy(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly snapshot: ReviewExecutionSnapshot;
  }): Promise<void>;
}

export type ReviewActionV2InvestigationReplayTarget = Readonly<{
  authorization: ReviewRunAuthorization;
  snapshot: ReviewExecutionSnapshot;
  workSlotId: string;
  manifest: ProviderInvocationManifest;
  providerVoteIdentityHash: string;
}>;

export type ReviewActionV2ContextAttestationHandlerDependencies = Readonly<{
  authorizations: ReviewActionV2ContextAuthorizationResolverPort;
  executionQueries: ReviewExecutionQueryPort;
  observations: ReviewObservationQueryPort;
  reusePolicy: CurrentReviewReusePolicyPort;
  store: ContextAttestationStorePort;
  cipher: ContextReplayMaterialCipherPort;
  capabilities: ReviewActionV2ExecutionEvidenceCapabilityAdapter;
  investigationLeaseQueries: InvestigationLeaseQueryPort;
  investigationQueries: Pick<InvestigationStorePort, "findById">;
  investigationLeaseCapabilities: ReviewActionV2InvestigationLeaseCapabilityPort;
  investigationRollout: ReviewInvestigationRolloutGuardPort;
  digest: ReviewActionV2ContextDigestPort;
  checkoutTrees: ReviewActionV2CheckoutTreeResolverPort;
  producerReleases: ReviewActionV2ProducerReleaseProfilePort;
  now: () => Date;
  nextId: (kind: "gateway_session" | "attestation" | "replay_proof") => string;
  sessionSecretKey: Uint8Array;
  config: ReviewActionV2ContextAttestationConfig;
}>;

type BoundContextGatewayLease = Readonly<{
  authorityKind: ContextLeaseAuthorityKind;
  capabilityId: string;
  authorizationId: string;
  mutationEpoch: bigint;
  scopeHash: string;
  executionId: string;
  workSlotId: string;
  leaseId: string;
  attemptId: string;
  providerInvocationKey: string;
  providerVoteIdentityHash: string;
  preparedManifestCanonicalJson: string;
  investigationRolloutCapability: InvestigationRolloutCapability | null;
}>;

export function readReviewActionV2ContextCrypto(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<{
  sessionSecretKey: Uint8Array;
  cipher: ContextReplayMaterialCipherPort;
}> {
  const sessionSecretKey = readBase64Key(
    requiredEnv(env, reviewActionV2ContextSessionSecretEnv),
    "review_context_session_secret_invalid",
  );
  const activeKeyId = requiredEnv(
    env,
    reviewActionV2ContextReplayActiveKeyIdEnv,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredEnv(env, reviewActionV2ContextReplayKeysEnv));
  } catch {
    throw new Error("review_context_replay_keys_invalid");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 16) {
    throw new Error("review_context_replay_keys_invalid");
  }
  const keys = new Map<string, Uint8Array>();
  for (const candidate of parsed) {
    const row = exactConfigRecord(candidate, ["keyId", "secretBase64"]);
    if (
      typeof row.keyId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(row.keyId) ||
      typeof row.secretBase64 !== "string" ||
      keys.has(row.keyId)
    ) {
      throw new Error("review_context_replay_keys_invalid");
    }
    keys.set(
      row.keyId,
      readBase64Key(row.secretBase64, "review_context_replay_keys_invalid"),
    );
  }
  return Object.freeze({
    sessionSecretKey,
    cipher: new AesGcmContextReplayMaterialCipher(activeKeyId, keys),
  });
}

export function composeReviewActionV2ContextAttestationRoutes(input: {
  readonly enabled: boolean;
  readonly runtime: Pick<
    RegisterReviewContextAttestationV2RoutesDependencies,
    "readServerTime" | "createRequestId"
  >;
  readonly handlers?: ReviewActionV2ContextAttestationHandlerDependencies;
}): RegisterReviewContextAttestationV2RoutesDependencies {
  if (!input.enabled) return input.runtime;
  if (!input.handlers) {
    throw new Error("review_context_attestation_dependencies_unavailable");
  }
  const handlers = input.handlers;
  validateConfig(handlers);
  return {
    ...input.runtime,
    openGateway: enabled((request: ReviewContextGatewayOpenRequest) =>
      openGateway(
        request,
        ContextLeaseAuthorityKind.StandardExecution,
        ReviewActionV2OperationId.ReviewContextGatewayOpen,
        handlers,
      ),
    ),
    sealGateway: enabled((request: ReviewContextGatewaySealRequest) =>
      sealGateway(
        request,
        ContextLeaseAuthorityKind.StandardExecution,
        ReviewActionV2OperationId.ReviewContextGatewaySeal,
        handlers,
      ),
    ),
    abandonGateway: enabled((request: ReviewContextGatewayAbandonRequest) =>
      abandonGateway(
        request,
        ContextLeaseAuthorityKind.StandardExecution,
        ReviewActionV2OperationId.ReviewContextGatewayAbandon,
        handlers,
      ),
    ),
    openInvestigationGateway: enabled(
      (request: ReviewInvestigationContextGatewayOpenRequest) =>
        openGateway(
          request,
          ContextLeaseAuthorityKind.InvestigationShadow,
          ReviewActionV2OperationId.ReviewInvestigationContextGatewayOpen,
          handlers,
        ),
    ),
    sealInvestigationGateway: enabled(
      (request: ReviewInvestigationContextGatewaySealRequest) =>
        sealGateway(
          request,
          ContextLeaseAuthorityKind.InvestigationShadow,
          ReviewActionV2OperationId.ReviewInvestigationContextGatewaySeal,
          handlers,
        ),
    ),
    abandonInvestigationGateway: enabled(
      (request: ReviewInvestigationContextGatewayAbandonRequest) =>
        abandonGateway(
          request,
          ContextLeaseAuthorityKind.InvestigationShadow,
          ReviewActionV2OperationId.ReviewInvestigationContextGatewayAbandon,
          handlers,
        ),
    ),
    commitReplay: enabled((request: ReviewContextReplayCommitRequest) =>
      commitReplay(request, handlers),
    ),
    commitReceiptReplay: enabled(
      (request: ReviewContextReceiptReplayCommitRequest) =>
        commitReceiptReplay(request, handlers),
    ),
  };
}

export function createReviewActionV2ContextReplayCoordinator(
  dependencies: ReviewActionV2ContextAttestationHandlerDependencies,
): ReviewActionV2ContextReplayCoordinatorPort {
  validateConfig(dependencies);
  return Object.freeze({
    prepareReplay: (input: ReviewActionV2ContextReplayPrepareInput) =>
      prepareReplay(input, dependencies),
    verifyAttachment: (
      input: Parameters<
        ReviewActionV2ContextReplayCoordinatorPort["verifyAttachment"]
      >[0],
    ) => verifyContextAttachment(input, dependencies),
    assertCurrentPolicy: (
      input: Parameters<
        ReviewActionV2ContextReplayCoordinatorPort["assertCurrentPolicy"]
      >[0],
    ) => assertCurrentContextReusePolicy(input, dependencies),
  });
}

export function createInvestigationReceiptReplayPreparationPort(
  target: ReviewActionV2InvestigationReplayTarget,
  d: ReviewActionV2ContextAttestationHandlerDependencies,
): InvestigationReplayPreparationPort {
  return Object.freeze({
    prepare: (
      input: Parameters<InvestigationReplayPreparationPort["prepare"]>[0],
    ) => prepareInvestigationReceiptReplay(input, target, d),
  });
}

function enabled<Request, Result>(
  execute: (request: Request) => Promise<Result>,
) {
  return { capabilityEnabled: true as const, execute };
}

async function issueContextGatewaySeal(
  authorityKind: ContextLeaseAuthorityKind,
  capabilities: ReviewActionV2ExecutionEvidenceCapabilityAdapter,
  authority: ReviewActionV2ContextGatewaySealAuthority,
  issuedAt: Date,
): Promise<string> {
  switch (authorityKind) {
    case ContextLeaseAuthorityKind.StandardExecution:
      return capabilities.issueContextGatewaySeal(authority, issuedAt);
    case ContextLeaseAuthorityKind.InvestigationShadow:
      return capabilities.issueInvestigationContextGatewaySeal(
        { ...authority, sourceLeaseAuthorityKind: "investigation_shadow" },
        issuedAt,
      );
  }
}

async function verifyContextGatewaySeal(
  authorityKind: ContextLeaseAuthorityKind,
  capabilities: ReviewActionV2ExecutionEvidenceCapabilityAdapter,
  token: string,
  now: Date,
): Promise<
  | ReviewActionV2ContextGatewaySealAuthority
  | ReviewActionV2InvestigationContextGatewaySealAuthority
> {
  switch (authorityKind) {
    case ContextLeaseAuthorityKind.StandardExecution:
      return capabilities.verifyContextGatewaySeal(token, now);
    case ContextLeaseAuthorityKind.InvestigationShadow:
      return capabilities.verifyInvestigationContextGatewaySeal(token, now);
  }
}

function assertAbandonAuthorityKind(
  expected: ContextLeaseAuthorityKind,
  authority:
    | ReviewActionV2ContextGatewaySealAuthority
    | ReviewActionV2InvestigationContextGatewaySealAuthority,
): void {
  const investigationAuthority = "sourceLeaseAuthorityKind" in authority;
  if (
    (expected === ContextLeaseAuthorityKind.InvestigationShadow) !==
    investigationAuthority
  ) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "context_abandon_authority_kind_mismatch",
    );
  }
}

async function openGateway(
  request:
    | ReviewContextGatewayOpenRequest
    | ReviewInvestigationContextGatewayOpenRequest,
  authorityKind: ContextLeaseAuthorityKind,
  operationId:
    | ReviewActionV2OperationId.ReviewContextGatewayOpen
    | ReviewActionV2OperationId.ReviewInvestigationContextGatewayOpen,
  d: ReviewActionV2ContextAttestationHandlerDependencies,
) {
  await assertBodyHash(operationId, request, d.digest);
  const now = d.now();
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  if (
    authorityKind === ContextLeaseAuthorityKind.InvestigationShadow &&
    !hasAuthorizedReviewInvestigationExtension(authorization)
  ) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
      "review_investigation_extension_not_authorized",
    );
  }
  const bound = await resolveBoundContextGatewayLease({
    authorityKind,
    leaseCapability: request.leaseCapability,
    authorization,
    leaseId: request.sourceLeaseId,
    workSlotId: request.sourceWorkSlotId,
    attemptId: request.attemptId,
    fencingToken: request.fencingToken,
    sourceExecutionId: request.sourceExecutionId,
    requireOwnership: true,
    operation: ReviewInvestigationLeaseProtectedOperation.ContextGatewayOpen,
    now,
    dependencies: d,
  });
  await assertInvestigationShadowGatewayAllowed({
    authorization,
    bound,
    dependencies: d,
  });
  requireEqual(
    request.sourceReviewRevisionHash,
    authorization.reviewRevisionHash,
    "context_source_revision_mismatch",
  );
  const facts = await resolveOpeningFacts({
    request,
    authorization,
    snapshot: bound.snapshot,
    lease: bound.lease,
    dependencies: d,
  });
  const sessionSecret = deriveGatewaySessionSecret(
    d.sessionSecretKey,
    gatewaySecretIdentity(facts),
  );
  const eventChainSeedHash = hmacHex(sessionSecret, gatewaySeedIdentity(facts));
  const open = new OpenContextGatewaySession({
    openingFacts: {
      resolveOpeningFacts: async (command) =>
        command.attemptId === facts.attemptId &&
        command.leaseCapabilityId === bound.lease.capabilityId &&
        command.confinementEvidenceId === facts.confinementProofHash
          ? { ...facts, eventChainSeedHash }
          : null,
    },
    store: d.store,
    identities: contextIdentities(d),
    clock: { nowMs: () => d.now().getTime() },
  });
  const outcome = await open.execute({
    attemptId: request.attemptId,
    leaseCapabilityId: bound.lease.capabilityId,
    confinementEvidenceId: request.confinementEvidenceHash,
  });
  if (!outcome.session) {
    return {
      statusCode: 200 as const,
      result: {
        status: mapOpenStatus(outcome.status),
        sessionId: null,
        eventChainSeedHash: null,
        gatewaySessionSecret: null,
        sealCapability: null,
        expiresAt: null,
      },
    };
  }
  const sealCapability = await issueContextGatewaySeal(
    authorityKind,
    d.capabilities,
    {
      authorizationId: authorization.authorizationId,
      mutationEpoch: authorization.mutationEpoch,
      scopeHash: await authorizationScopeHash(authorization, d.digest),
      sessionId: outcome.session.sessionId,
      sourceExecutionId: outcome.session.sourceExecutionId,
      sourceWorkSlotId: outcome.session.sourceWorkSlotId,
      attemptId: outcome.session.attemptId,
      sourceLeaseId: outcome.session.sourceLeaseId,
      sourceFencingToken: outcome.session.sourceFencingToken,
      sourceReviewRevisionHash:
        outcome.session.sourceRevision.reviewRevisionHash,
      checkoutTreeOid: outcome.session.sourceRevision.checkoutTreeOid,
      gatewayPolicyVersion: outcome.session.gatewayPolicyVersion,
      gatewayBinaryHash: outcome.session.gatewayBinaryHash,
      confinementEvidenceHash: outcome.session.confinementProofHash,
      expiresAt: new Date(outcome.session.expiresAtMs),
    },
    now,
  );
  return {
    statusCode:
      outcome.status === OpenContextGatewaySessionStatus.Opened
        ? (201 as const)
        : (200 as const),
    result: {
      status: mapOpenStatus(outcome.status),
      sessionId: outcome.session.sessionId,
      eventChainSeedHash: outcome.session.eventChainSeedHash,
      gatewaySessionSecret: sessionSecret.toString("base64url"),
      sealCapability,
      expiresAt: new Date(outcome.session.expiresAtMs).toISOString(),
    },
  };
}

async function sealGateway(
  request:
    | ReviewContextGatewaySealRequest
    | ReviewInvestigationContextGatewaySealRequest,
  authorityKind: ContextLeaseAuthorityKind,
  operationId:
    | ReviewActionV2OperationId.ReviewContextGatewaySeal
    | ReviewActionV2OperationId.ReviewInvestigationContextGatewaySeal,
  d: ReviewActionV2ContextAttestationHandlerDependencies,
) {
  await assertBodyHash(operationId, request, d.digest);
  const now = d.now();
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  if (
    authorityKind === ContextLeaseAuthorityKind.InvestigationShadow &&
    !hasAuthorizedReviewInvestigationExtension(authorization)
  ) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
      "review_investigation_extension_not_authorized",
    );
  }
  const bound = await resolveBoundContextGatewayLease({
    authorityKind,
    leaseCapability: request.leaseCapability,
    authorization,
    leaseId: request.sourceLeaseId,
    workSlotId: null,
    attemptId: request.attemptId,
    fencingToken: request.fencingToken,
    sourceExecutionId: null,
    requireOwnership: false,
    operation: ReviewInvestigationLeaseProtectedOperation.ContextGatewaySeal,
    now,
    dependencies: d,
  });
  await assertInvestigationShadowGatewayAllowed({
    authorization,
    bound,
    dependencies: d,
  });
  let sealAuthority;
  try {
    sealAuthority = await verifyContextGatewaySeal(
      authorityKind,
      d.capabilities,
      request.sealCapability,
      now,
    );
  } catch {
    throw failure(
      401,
      ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      "context_seal_capability_invalid",
    );
  }
  const session = await d.store.findSession(request.sessionId);
  if (!session) {
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "context_gateway_session_missing",
    );
  }
  await assertSealAuthority({
    request,
    authorization,
    leaseAuthority: bound.lease,
    sealAuthority,
    session,
    dependencies: d,
  });
  const transcript = parseContextManifest(
    request.transcriptCanonicalJson,
    "context_transcript_invalid",
  );
  await requireHash(
    request.transcriptCanonicalJson,
    request.transcriptHash,
    "context_transcript_hash_mismatch",
    d.digest,
  );
  const sessionSecret = deriveGatewaySessionSecret(
    d.sessionSecretKey,
    gatewaySecretIdentity(session),
  );
  const replayMaterial = parseReplayMaterial(
    request.replayMaterialCanonicalJson,
    transcript,
    session,
    sessionSecret,
  );
  await requireHash(
    request.replayMaterialCanonicalJson,
    request.replayMaterialHash,
    "context_replay_material_hash_mismatch",
    d.digest,
  );
  verifyGatewayTranscript(session, transcript, sessionSecret);
  requireEqual(
    transcript.gatewayPolicyVersion,
    session.gatewayPolicyVersion,
    "context_gateway_policy_mismatch",
  );
  requireEqual(
    transcript.gatewayBinaryHash,
    session.gatewayBinaryHash,
    "context_gateway_binary_mismatch",
  );
  requireEqual(
    transcript.checkoutTreeOid,
    session.sourceRevision.checkoutTreeOid,
    "context_checkout_tree_mismatch",
  );
  const associatedDataCanonicalJson = replayMaterialAssociatedData(session);
  const encrypted = await d.cipher.encrypt({
    sessionId: session.sessionId,
    plaintextCanonicalJson: replayMaterial.canonicalJson,
    associatedDataCanonicalJson,
    expiresAtMs: now.getTime() + d.config.reuseTtlMs,
  });
  const accept = new AcceptSealedContextAttestation({
    transcripts: {
      loadSealedTranscript: async (command) =>
        command.sessionId === session.sessionId &&
        command.sealCapabilityId === sealAuthority.capabilityId
          ? {
              sessionId: session.sessionId,
              confinementProofHash: session.confinementProofHash,
              manifest: transcript,
              actualModel: request.actualModel,
              terminalOutcomeHash: request.terminalOutcomeHash,
              providerSucceeded: request.providerSucceeded,
              schemaValidated: request.schemaValidated,
              fullyConsumed: request.fullyConsumed,
              replayMaterial: encrypted,
            }
          : null,
    },
    store: d.store,
    identities: contextIdentities(d),
    digest: d.digest,
    clock: { nowMs: () => now.getTime() },
    reuseTtlMs: d.config.reuseTtlMs,
  });
  const outcome = await accept.execute({
    sessionId: request.sessionId,
    sealCapabilityId: requiredString(
      sealAuthority.capabilityId,
      "context_seal_capability_id_missing",
    ),
  });
  return {
    statusCode:
      outcome.status === AcceptSealedContextAttestationStatus.Accepted
        ? (201 as const)
        : (200 as const),
    result: {
      status: mapSealStatus(outcome.status),
      attestationId: outcome.attestation?.attestationId ?? null,
      attestationHash: outcome.attestation?.attestationHash ?? null,
    },
  };
}

async function abandonGateway(
  request:
    | ReviewContextGatewayAbandonRequest
    | ReviewInvestigationContextGatewayAbandonRequest,
  authorityKind: ContextLeaseAuthorityKind,
  operationId:
    | ReviewActionV2OperationId.ReviewContextGatewayAbandon
    | ReviewActionV2OperationId.ReviewInvestigationContextGatewayAbandon,
  d: ReviewActionV2ContextAttestationHandlerDependencies,
) {
  await assertBodyHash(operationId, request, d.digest);
  const now = d.now();
  let authority:
    | ReviewActionV2ContextGatewaySealAuthority
    | ReviewActionV2InvestigationContextGatewaySealAuthority;
  try {
    authority = await verifyContextGatewaySeal(
      authorityKind,
      d.capabilities,
      request.leaseCapability,
      now,
    );
  } catch {
    throw failure(
      401,
      ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      "context_abandon_capability_invalid",
    );
  }
  assertAbandonAuthorityKind(authorityKind, authority);
  requireEqual(
    request.sessionId,
    authority.sessionId,
    "context_abandon_session_mismatch",
  );
  requireEqual(
    request.attemptId,
    authority.attemptId,
    "context_abandon_attempt_mismatch",
  );
  requireEqual(
    request.sourceLeaseId,
    authority.sourceLeaseId,
    "context_abandon_lease_mismatch",
  );
  requireEqual(
    request.fencingToken,
    authority.sourceFencingToken,
    "context_abandon_fencing_mismatch",
  );
  const capabilityId = requiredString(
    authority.capabilityId,
    "context_abandon_capability_id_missing",
  );
  const abandon = new AbandonContextGatewaySession({
    abandonFacts: {
      resolveAbandonFacts: async (command) =>
        command.sessionId === authority.sessionId &&
        command.capabilityId === capabilityId
          ? {
              sessionId: authority.sessionId,
              attemptId: authority.attemptId,
              sourceLeaseAuthorityKind: authorityKind,
              sourceLeaseId: authority.sourceLeaseId,
              sourceFencingToken: authority.sourceFencingToken,
            }
          : null,
    },
    store: d.store,
    clock: { nowMs: () => now.getTime() },
  });
  const outcome = await abandon.execute({
    sessionId: request.sessionId,
    capabilityId,
  });
  return {
    statusCode: 200 as const,
    result: { status: mapAbandonStatus(outcome.status) },
  };
}

async function commitReplay(
  request: ReviewContextReplayCommitRequest,
  d: ReviewActionV2ContextAttestationHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewContextReplayCommit,
    request,
    d.digest,
  );
  const now = d.now();
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  const snapshot = await requireExecution(
    request.executionId,
    authorization,
    d.executionQueries,
  );
  let replayAuthority: ReviewActionV2ContextReplayAuthority;
  try {
    replayAuthority = await d.capabilities.verifyContextReplay(
      request.replayCapability,
      now,
    );
  } catch {
    throw failure(
      401,
      ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      "context_replay_capability_invalid",
    );
  }
  assertReplayRequestAuthority(request, authorization, replayAuthority);
  const targetTree =
    await d.checkoutTrees.resolveCheckoutTreeOid(authorization);
  requireEqual(
    targetTree,
    request.targetCheckoutTreeOid,
    "context_target_tree_stale",
  );
  const replayedManifest = parseContextManifest(
    request.replayResultCanonicalJson,
    "context_replay_result_invalid",
  );
  if (!isLegacyContextDependencyManifest(replayedManifest)) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
      "context_gateway_v4_replay_disabled",
    );
  }
  await requireHash(
    request.replayResultCanonicalJson,
    request.replayResultHash,
    "context_replay_result_hash_mismatch",
    d.digest,
  );
  requireEqual(
    replayedManifest.checkoutTreeOid,
    request.targetCheckoutTreeOid,
    "context_replay_result_tree_mismatch",
  );
  requireEqual(
    replayedManifest.gatewayPolicyVersion,
    replayAuthority.gatewayPolicyVersion,
    "context_replay_policy_mismatch",
  );
  requireEqual(
    replayedManifest.gatewayBinaryHash,
    replayAuthority.gatewayBinaryHash,
    "context_replay_binary_mismatch",
  );
  verifySyntheticReplayChain(
    replayedManifest,
    replayAuthority.contextReplayPlanHash,
    replayAuthority.attestationId,
    request.targetReviewRevisionHash,
    request.targetCheckoutTreeOid,
  );
  if (
    !(await verifyReplayAuthorityCurrent({
      authorization,
      snapshot,
      replayAuthority,
      dependencies: d,
    }))
  ) {
    return replayDenied();
  }
  const replay = new ReplayContextAttestation({
    store: d.store,
    targetFacts: {
      resolveTargetReplayFacts: async (command) =>
        command.targetExecutionId === request.executionId &&
        command.targetWorkSlotId === request.workSlotId &&
        command.replayCapabilityId === replayAuthority.capabilityId
          ? {
              targetExecutionId: request.executionId,
              targetWorkSlotId: request.workSlotId,
              targetRevision: {
                baseSha: authorization.baseSha,
                mergeBaseSha: authorization.mergeBaseSha,
                headSha: authorization.headSha,
                reviewRevisionHash: authorization.reviewRevisionHash,
                checkoutTreeOid: request.targetCheckoutTreeOid,
              },
              replayBinaryHash: replayAuthority.gatewayBinaryHash,
              replayPolicyVersion: replayAuthority.gatewayPolicyVersion,
              reusePolicyVectorHash: replayAuthority.reusePolicyVectorHash,
              sourceOperationReceiptIds: [],
              sourceOperationReceiptIdsHash: null,
              proofLifetimeMs: d.config.replayProofLifetimeMs,
            }
          : null,
    },
    identities: contextIdentities(d),
    clock: { nowMs: () => d.now().getTime() },
  });
  const outcome = await replay.execute({
    sourceAttestationId: request.attestationId,
    sourceAttestationHash: request.attestationHash,
    targetExecutionId: request.executionId,
    targetWorkSlotId: request.workSlotId,
    replayCapabilityId: requiredString(
      replayAuthority.capabilityId,
      "context_replay_capability_id_missing",
    ),
    replayedManifest,
  });
  if (!outcome.proof) {
    return {
      statusCode: 200 as const,
      result: {
        status: mapReplayStatus(outcome.status),
        replayProofId: null,
        replayProofHash: null,
        attachmentCapability: null,
      },
    };
  }
  const replayProofHash = await hashReplayProof(outcome.proof, d.digest);
  const attachmentCapability = await d.capabilities.issueReusableAttachment(
    {
      ...replayAuthority.attachment,
      attachmentKind:
        ReviewObservationAttachmentKind.ContextGatewayCrossRevisionReuse,
      reuseSafetyDecisionHash: replayAuthority.reusePolicyVectorHash,
      contextReplayProofId: outcome.proof.replayProofId,
      contextReplayProofHash: replayProofHash,
      contextAttestationId: replayAuthority.attestationId,
      contextAttestationHash: replayAuthority.attestationHash,
      targetCheckoutTreeOid: replayAuthority.targetCheckoutTreeOid,
      replayBinaryHash: replayAuthority.gatewayBinaryHash,
      replayPolicyVersion: replayAuthority.gatewayPolicyVersion,
      expiresAt: minDate(
        replayAuthority.attachment.expiresAt,
        new Date(outcome.proof.expiresAtMs),
      ),
    },
    new Date(outcome.proof.createdAtMs),
  );
  return {
    statusCode:
      outcome.status === ReplayContextAttestationStatus.Accepted
        ? (201 as const)
        : (200 as const),
    result: {
      status: mapReplayStatus(outcome.status),
      replayProofId: outcome.proof.replayProofId,
      replayProofHash,
      attachmentCapability,
    },
  };
}

async function commitReceiptReplay(
  request: ReviewContextReceiptReplayCommitRequest,
  d: ReviewActionV2ContextAttestationHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewContextReceiptReplayCommit,
    request,
    d.digest,
  );
  const now = d.now();
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  await requireExecution(
    request.executionId,
    authorization,
    d.executionQueries,
  );
  let authority: ReviewActionV2InvestigationReceiptReplayAuthority;
  try {
    authority = await d.capabilities.verifyInvestigationReceiptReplay(
      request.replayCapability,
      now,
    );
  } catch {
    throw failure(
      401,
      ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      "investigation_receipt_replay_capability_invalid",
    );
  }
  assertReceiptReplayRequestAuthority(request, authority);
  const targetTree =
    await d.checkoutTrees.resolveCheckoutTreeOid(authorization);
  requireEqual(
    targetTree,
    request.targetCheckoutTreeOid,
    "investigation_receipt_replay_target_tree_stale",
  );
  const replayedManifest = parseContextManifest(
    request.replayResultCanonicalJson,
    "investigation_receipt_replay_result_invalid",
  );
  if (isLegacyContextDependencyManifest(replayedManifest)) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "investigation_receipt_replay_manifest_invalid",
    );
  }
  await requireHash(
    request.replayResultCanonicalJson,
    request.replayResultHash,
    "investigation_receipt_replay_result_hash_mismatch",
    d.digest,
  );
  requireEqual(
    replayedManifest.checkoutTreeOid,
    request.targetCheckoutTreeOid,
    "investigation_receipt_replay_tree_mismatch",
  );
  requireEqual(
    replayedManifest.gatewayPolicyVersion,
    authority.gatewayPolicyVersion,
    "investigation_receipt_replay_policy_mismatch",
  );
  requireEqual(
    replayedManifest.gatewayBinaryHash,
    authority.gatewayBinaryHash,
    "investigation_receipt_replay_binary_mismatch",
  );
  verifySyntheticGatewayV4ReplayChain(
    replayedManifest,
    authority.contextReplayPlanHash,
    authority.attestationId,
    request.targetReviewRevisionHash,
    request.targetCheckoutTreeOid,
  );
  if (
    !(await verifyInvestigationReceiptReplayPlanBinding({
      authority,
      replayedManifest,
      dependencies: d,
    }))
  ) {
    return receiptReplayDenied();
  }
  if (
    !(await verifyInvestigationReceiptReplayAuthorityCurrent({
      authorization,
      authority,
      dependencies: d,
    }))
  ) {
    return receiptReplayDenied();
  }
  const replay = new ReplayContextAttestation({
    store: d.store,
    targetFacts: {
      resolveTargetReplayFacts: async (command) =>
        command.targetExecutionId === request.executionId &&
        command.targetWorkSlotId === request.workSlotId &&
        command.replayCapabilityId === authority.capabilityId
          ? {
              targetExecutionId: request.executionId,
              targetWorkSlotId: request.workSlotId,
              targetRevision: {
                baseSha: authorization.baseSha,
                mergeBaseSha: authorization.mergeBaseSha,
                headSha: authorization.headSha,
                reviewRevisionHash: authorization.reviewRevisionHash,
                checkoutTreeOid: request.targetCheckoutTreeOid,
              },
              replayBinaryHash: authority.gatewayBinaryHash,
              replayPolicyVersion: authority.gatewayPolicyVersion,
              reusePolicyVectorHash: authority.reusePolicyVectorHash,
              sourceOperationReceiptIds: authority.sourceOperationReceiptIds,
              sourceOperationReceiptIdsHash:
                authority.sourceOperationReceiptIdsHash,
              proofLifetimeMs: d.config.replayProofLifetimeMs,
            }
          : null,
    },
    identities: contextIdentities(d),
    clock: { nowMs: () => d.now().getTime() },
  });
  const outcome = await replay.execute({
    sourceAttestationId: request.attestationId,
    sourceAttestationHash: request.attestationHash,
    targetExecutionId: request.executionId,
    targetWorkSlotId: request.workSlotId,
    replayCapabilityId: requiredString(
      authority.capabilityId,
      "investigation_receipt_replay_capability_id_missing",
    ),
    replayedManifest,
  });
  const proofHash = outcome.proof
    ? await hashReplayProof(outcome.proof, d.digest)
    : null;
  return {
    statusCode:
      outcome.status === ReplayContextAttestationStatus.Accepted
        ? (201 as const)
        : (200 as const),
    result: {
      status: mapReceiptReplayStatus(outcome.status),
      replayProofId: outcome.proof?.replayProofId ?? null,
      replayProofHash: proofHash,
    },
  };
}

function assertReceiptReplayRequestAuthority(
  request: ReviewContextReceiptReplayCommitRequest,
  authority: ReviewActionV2InvestigationReceiptReplayAuthority,
): void {
  requireEqual(
    authority.attestationId,
    request.attestationId,
    "investigation_receipt_replay_attestation_id_mismatch",
  );
  requireEqual(
    authority.attestationHash,
    request.attestationHash,
    "investigation_receipt_replay_attestation_hash_mismatch",
  );
  requireEqual(
    authority.targetExecutionId,
    request.executionId,
    "investigation_receipt_replay_execution_mismatch",
  );
  requireEqual(
    authority.targetWorkSlotId,
    request.workSlotId,
    "investigation_receipt_replay_slot_mismatch",
  );
  requireEqual(
    authority.targetReviewRevisionHash,
    request.targetReviewRevisionHash,
    "investigation_receipt_replay_revision_mismatch",
  );
  requireEqual(
    authority.targetCheckoutTreeOid,
    request.targetCheckoutTreeOid,
    "investigation_receipt_replay_tree_mismatch",
  );
}

async function verifyInvestigationReceiptReplayAuthorityCurrent(input: {
  readonly authorization: ReviewRunAuthorization;
  readonly authority: ReviewActionV2InvestigationReceiptReplayAuthority;
  readonly dependencies: ReviewActionV2ContextAttestationHandlerDependencies;
}): Promise<boolean> {
  const { authorization, authority, dependencies: d } = input;
  const attestation = await d.store.findAcceptedAttestation(
    authority.attestationId,
  );
  const session = attestation
    ? await d.store.findSession(attestation.sessionId)
    : null;
  const release = await d.producerReleases.resolve({
    producerReleaseId: authority.producerReleaseId,
  });
  const scopeHash = await authorizationScopeHash(authorization, d.digest);
  const policy = await d.reusePolicy.resolveReviewReusePolicy({
    scope: {
      workspaceId: authorization.workspaceId,
      repositoryConnectionId: authorization.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      pullRequestNumber: authorization.pullRequestNumber,
      authorizationScopeHash: scopeHash,
    },
    revision: {
      baseSha: authorization.baseSha,
      mergeBaseSha: authorization.mergeBaseSha,
      headSha: authorization.headSha,
      reviewRevisionHash: authorization.reviewRevisionHash,
    },
    providerKind: authority.providerKind,
    taskKindSet: authority.taskKindSet,
    trustDomain: authorization.trustDomain as unknown as ReviewTrustDomain,
    producerReleaseId: authority.producerReleaseId,
  });
  if (
    !attestation ||
    !session ||
    !release ||
    !policy ||
    attestation.attestationHash !== authority.attestationHash ||
    attestation.reuseExpiresAtMs <= d.now().getTime() ||
    attestation.actualModel !== authority.requestedModel ||
    policy.safetyDecision.contextGatewayReuseMode !==
      ReviewReuseEffectMode.Enabled ||
    release.capabilityProfile !== session.trustedCapabilityProfile ||
    release.contextGatewayPolicyVersion !== authority.gatewayPolicyVersion ||
    release.contextGatewayEntrypointDigest !== authority.gatewayBinaryHash
  ) {
    return false;
  }
  const currentVector = await d.digest.digestUtf8(
    canonicalizeReviewContextReusePolicyVector({
      safetyDecision: policy.safetyDecision,
      compatibility: policy.compatibility,
      eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
      gatewayPolicyVersion: session.gatewayPolicyVersion,
      gatewayBinaryHash: session.gatewayBinaryHash,
      trustedCapabilityProfile: session.trustedCapabilityProfile,
      producerReleaseId: authority.producerReleaseId,
      providerKind: authority.providerKind,
      requestedModel: authority.requestedModel,
      actualModel: attestation.actualModel,
    }),
  );
  return currentVector === authority.reusePolicyVectorHash;
}

async function verifyInvestigationReceiptReplayPlanBinding(input: {
  readonly authority: ReviewActionV2InvestigationReceiptReplayAuthority;
  readonly replayedManifest: ContextGatewayV4Manifest;
  readonly dependencies: ReviewActionV2ContextAttestationHandlerDependencies;
}): Promise<boolean> {
  const { authority, replayedManifest, dependencies: d } = input;
  try {
    const [attestation, material] = await Promise.all([
      d.store.findAcceptedAttestation(authority.attestationId),
      d.store.findReplayMaterialByAttestationId(authority.attestationId),
    ]);
    if (
      !attestation ||
      !material ||
      attestation.attestationHash !== authority.attestationHash ||
      attestation.manifest.manifestVersion !== 3
    ) {
      return false;
    }
    const session = await d.store.findSession(attestation.sessionId);
    if (!session) return false;
    const plaintext = await d.cipher.decrypt({
      material,
      associatedDataCanonicalJson: replayMaterialAssociatedData(session),
    });
    const replayMaterial = parseReplayMaterial(
      plaintext,
      attestation.manifest,
      session,
      deriveGatewaySessionSecret(
        d.sessionSecretKey,
        gatewaySecretIdentity(session),
      ),
    );
    if (!("entries" in replayMaterial)) return false;
    const sourceOperationReceiptIds = [
      ...new Set(authority.sourceOperationReceiptIds),
    ].sort();
    if (
      sourceOperationReceiptIds.length !==
        authority.sourceOperationReceiptIds.length ||
      sourceOperationReceiptIds.some(
        (value, index) => value !== authority.sourceOperationReceiptIds[index],
      )
    ) {
      return false;
    }
    const sourceOperationReceiptIdsHash = await d.digest.digestUtf8(
      canonicalJson({ operationReceiptIds: sourceOperationReceiptIds }),
    );
    if (
      sourceOperationReceiptIdsHash !== authority.sourceOperationReceiptIdsHash
    ) {
      return false;
    }
    const operations = selectGatewayV4ReplayOperations(
      attestation.manifest,
      replayMaterial,
      sourceOperationReceiptIds,
    );
    if (!operations || operations.length === 0) return false;
    const plan = Object.freeze({
      planVersion: 2 as const,
      attestationId: authority.attestationId,
      attestationHash: authority.attestationHash,
      gatewayPolicyVersion: authority.gatewayPolicyVersion,
      gatewayBinaryHash: authority.gatewayBinaryHash,
      sourceOperationReceiptIds,
      sourceOperationReceiptIdsHash,
      operations,
    });
    if (
      (await d.digest.digestUtf8(stableJson(plan as never))) !==
      authority.contextReplayPlanHash
    ) {
      return false;
    }
    return targetManifestMatchesGatewayV4Plan(replayedManifest, operations);
  } catch {
    return false;
  }
}

function targetManifestMatchesGatewayV4Plan(
  manifest: ContextGatewayV4Manifest,
  operations: readonly Readonly<{
    operationKind: ContextGatewayV4OperationKind;
    replayInput: Readonly<Record<string, unknown>>;
  }>[],
): boolean {
  const successful = manifest.events.filter(
    (event) => event.outcome === ContextGatewayV4OutcomeKind.Succeeded,
  );
  const targetOperations: Array<
    Readonly<{
      operationKind: ContextGatewayV4OperationKind;
      operationKey: string;
    }>
  > = [];
  const seenPageGroups = new Set<string>();
  for (const event of successful) {
    if (
      event.operationKind === ContextGatewayV4OperationKind.DirectoryList ||
      event.operationKind === ContextGatewayV4OperationKind.TextSearch ||
      event.operationKind === ContextGatewayV4OperationKind.CanonicalInventory
    ) {
      const group = gatewayV4ReplayGroupKey(event);
      if (seenPageGroups.has(group)) continue;
      seenPageGroups.add(group);
      if (event.result?.pageOrdinal !== 0) return false;
    }
    targetOperations.push(
      Object.freeze({
        operationKind: event.operationKind,
        operationKey: event.operationKey,
      }),
    );
  }
  if (targetOperations.length !== operations.length) return false;
  return operations.every((operation, index) => {
    const target = targetOperations[index];
    return (
      target?.operationKind === operation.operationKind &&
      target.operationKey ===
        gatewayV4OperationKey(operation.operationKind, operation.replayInput)
    );
  });
}

async function verifyReplayAuthorityCurrent(input: {
  readonly authorization: ReviewRunAuthorization;
  readonly snapshot: ReviewExecutionSnapshot;
  readonly replayAuthority: ReviewActionV2ContextReplayAuthority;
  readonly dependencies: ReviewActionV2ContextAttestationHandlerDependencies;
}): Promise<boolean> {
  const { replayAuthority, dependencies: d } = input;
  const observation = await d.observations.findById(
    replayAuthority.attachment.observationId,
  );
  const attestation = await d.store.findAcceptedAttestation(
    replayAuthority.attestationId,
  );
  const session = attestation
    ? await d.store.findSession(attestation.sessionId)
    : null;
  if (
    !observation ||
    !attestation ||
    !session ||
    observation.contextDependencyAttestationId !==
      replayAuthority.attestationId ||
    observation.contextDependencyAttestationHash !==
      replayAuthority.attestationHash ||
    replayAuthority.attachment.observationId !== observation.observationId ||
    replayAuthority.attachment.manifestKey !== observation.manifestKey ||
    replayAuthority.attachment.providerInvocationKey !==
      observation.providerInvocationKey ||
    replayAuthority.attachment.providerVoteIdentityHash !==
      observation.providerVoteIdentityHash
  ) {
    return false;
  }
  const current = await resolveCurrentCandidate({
    authorization: input.authorization,
    snapshot: input.snapshot,
    workSlotId: replayAuthority.attachment.targetWorkSlotId,
    manifest: replayAuthority.attachment.manifest,
    manifestKey: replayAuthority.attachment.manifestKey,
    providerInvocationKey: replayAuthority.attachment.providerInvocationKey,
    providerVoteIdentityHash:
      replayAuthority.attachment.providerVoteIdentityHash,
    trustDomain: replayAuthority.attachment.trustDomain,
    observation,
    targetCheckoutTreeOid: replayAuthority.targetCheckoutTreeOid,
    session,
    dependencies: d,
  });
  return (
    current?.reusePolicyVectorHash === replayAuthority.reusePolicyVectorHash
  );
}

async function prepareReplay(
  input: ReviewActionV2ContextReplayPrepareInput,
  d: ReviewActionV2ContextAttestationHandlerDependencies,
): Promise<ReviewActionV2ContextReplayPreparation | null> {
  const attestationId = input.observation.contextDependencyAttestationId;
  const attestationHash = input.observation.contextDependencyAttestationHash;
  if (!attestationId || !attestationHash) return null;
  const [attestation, material, targetTree] = await Promise.all([
    d.store.findAcceptedAttestation(attestationId),
    d.store.findReplayMaterialByAttestationId(attestationId),
    d.checkoutTrees.resolveCheckoutTreeOid(input.authorization),
  ]);
  if (
    !attestation ||
    !material ||
    !targetTree ||
    attestation.attestationHash !== attestationHash ||
    attestation.reuseExpiresAtMs <= d.now().getTime()
  ) {
    return null;
  }
  const session = await d.store.findSession(attestation.sessionId);
  if (!session) return null;
  const current = await resolveCurrentCandidate({
    ...input,
    targetCheckoutTreeOid: targetTree,
    session,
    dependencies: d,
  });
  if (!current) return null;
  // Gateway v4 replay is intentionally disabled until receipt replay ships.
  if (attestation.manifest.manifestVersion !== 2) return null;
  let plaintext: string;
  try {
    plaintext = await d.cipher.decrypt({
      material,
      associatedDataCanonicalJson: replayMaterialAssociatedData(session),
    });
  } catch {
    return null;
  }
  const parsed = parseReplayMaterial(
    plaintext,
    attestation.manifest,
    session,
    deriveGatewaySessionSecret(
      d.sessionSecretKey,
      gatewaySecretIdentity(session),
    ),
  );
  if (!("sourceDependencies" in parsed)) return null;
  const replayQueries = new Map(
    parsed.sourceDependencies.map((entry) => [
      entry.operationKey,
      entry.replayQuery,
    ]),
  );
  const sourceDependencies: ReplayPlanSourceDependency[] = [];
  for (const dependency of attestation.manifest.dependencies) {
    const replayQuery = replayQueries.get(dependency.operationKey);
    if (
      dependency.operation.kind === ContextDependencyKind.TextSearch &&
      typeof replayQuery !== "string"
    ) {
      return null;
    }
    sourceDependencies.push(
      Object.freeze({
        sequence: dependency.sequence,
        operationKey: dependency.operationKey,
        operation: dependency.operation,
        replayQuery:
          dependency.operation.kind === ContextDependencyKind.TextSearch
            ? replayQuery!
            : null,
      }),
    );
  }
  const plan: ReviewActionV2ContextReplayPlan = Object.freeze({
    planVersion: replayPlanVersion,
    attestationId,
    attestationHash,
    gatewayPolicyVersion: attestation.manifest.gatewayPolicyVersion,
    gatewayBinaryHash: attestation.manifest.gatewayBinaryHash,
    sourceDependencies: Object.freeze(sourceDependencies),
  });
  const contextReplayPlanCanonicalJson = stableJson(plan as never);
  const contextReplayPlanHash = await d.digest.digestUtf8(
    contextReplayPlanCanonicalJson,
  );
  const now = d.now();
  const expiresAt = minDate(
    input.authorization.expiresAt,
    new Date(input.observation.reuseExpiresAtMs),
    new Date(now.getTime() + d.config.replayCapabilityLifetimeMs),
  );
  const attachment = reusableAttachmentAuthority({
    input,
    reusePolicyVectorHash: current.reusePolicyVectorHash,
    expiresAt: minDate(
      expiresAt,
      new Date(now.getTime() + d.config.attachmentCapabilityLifetimeMs),
    ),
  });
  const contextReplayCapability = await d.capabilities.issueContextReplay(
    {
      attestationId,
      attestationHash,
      contextReplayPlanHash,
      targetCheckoutTreeOid: targetTree,
      gatewayPolicyVersion: attestation.manifest.gatewayPolicyVersion,
      gatewayBinaryHash: attestation.manifest.gatewayBinaryHash,
      reusePolicyVectorHash: current.reusePolicyVectorHash,
      attachment,
      expiresAt,
    },
    now,
  );
  return Object.freeze({
    contextDependencyAttestationId: attestationId,
    contextDependencyAttestationHash: attestationHash,
    contextReplayCapability,
    contextReplayPlanCanonicalJson,
    contextReplayPlanHash,
  });
}

async function prepareInvestigationReceiptReplay(
  input: Parameters<InvestigationReplayPreparationPort["prepare"]>[0],
  target: ReviewActionV2InvestigationReplayTarget,
  d: ReviewActionV2ContextAttestationHandlerDependencies,
): Promise<PreparedInvestigationReceiptReplay | null> {
  const attestationId = input.sourceReceipt.acceptedAttestationId;
  const attestationHash = input.sourceReceipt.acceptedAttestationHash;
  if (!attestationId || !attestationHash) return null;
  const [attestation, material, targetTree] = await Promise.all([
    d.store.findAcceptedAttestation(attestationId),
    d.store.findReplayMaterialByAttestationId(attestationId),
    d.checkoutTrees.resolveCheckoutTreeOid(target.authorization),
  ]);
  const now = d.now();
  if (
    !attestation ||
    !material ||
    !targetTree ||
    attestation.attestationHash !== attestationHash ||
    attestation.reuseExpiresAtMs <= now.getTime() ||
    Date.parse(input.sourceCheckpointExpiresAt) <= now.getTime() ||
    attestation.manifest.manifestVersion !== 3 ||
    attestation.manifest.gatewayPolicyVersion !== contextGatewayV4PolicyVersion
  ) {
    return null;
  }
  const session = await d.store.findSession(attestation.sessionId);
  if (
    !session ||
    !investigationProviderMatches(
      session.providerKind,
      target.manifest.providerKind,
    ) ||
    attestation.actualModel !== target.manifest.requestedModel
  ) {
    return null;
  }
  const release = await d.producerReleases.resolve({
    producerReleaseId: target.manifest.producerReleaseId,
  });
  const scopeHash = await authorizationScopeHash(
    target.authorization,
    d.digest,
  );
  const policy = await d.reusePolicy.resolveReviewReusePolicy({
    scope: {
      workspaceId: target.authorization.workspaceId,
      repositoryConnectionId: target.authorization.repositoryConnectionId,
      scmRepositoryIdentityId: target.authorization.scmRepositoryIdentityId,
      pullRequestNumber: target.authorization.pullRequestNumber,
      authorizationScopeHash: scopeHash,
    },
    revision: {
      baseSha: target.authorization.baseSha,
      mergeBaseSha: target.authorization.mergeBaseSha,
      headSha: target.authorization.headSha,
      reviewRevisionHash: target.authorization.reviewRevisionHash,
    },
    providerKind: target.manifest.providerKind,
    taskKindSet: target.manifest.taskKindSet,
    trustDomain: target.authorization
      .trustDomain as unknown as ReviewTrustDomain,
    producerReleaseId: target.manifest.producerReleaseId,
  });
  if (
    !release ||
    !policy ||
    policy.safetyDecision.contextGatewayReuseMode !==
      ReviewReuseEffectMode.Enabled ||
    release.capabilityProfile !== session.trustedCapabilityProfile ||
    release.contextGatewayPolicyVersion !==
      attestation.manifest.gatewayPolicyVersion ||
    release.contextGatewayEntrypointDigest !==
      attestation.manifest.gatewayBinaryHash
  ) {
    return null;
  }
  let plaintext: string;
  try {
    plaintext = await d.cipher.decrypt({
      material,
      associatedDataCanonicalJson: replayMaterialAssociatedData(session),
    });
  } catch {
    return null;
  }
  const replayMaterial = parseReplayMaterial(
    plaintext,
    attestation.manifest,
    session,
    deriveGatewaySessionSecret(
      d.sessionSecretKey,
      gatewaySecretIdentity(session),
    ),
  );
  if (!("entries" in replayMaterial)) return null;
  const sourceOperationReceiptIds = [
    ...new Set(input.sourceReceipt.operationReceiptIds),
  ].sort();
  if (
    sourceOperationReceiptIds.length !==
    input.sourceReceipt.operationReceiptIds.length
  ) {
    return null;
  }
  const operations = selectGatewayV4ReplayOperations(
    attestation.manifest,
    replayMaterial,
    sourceOperationReceiptIds,
  );
  if (!operations || operations.length === 0) return null;
  const sourceOperationReceiptIdsHash = await d.digest.digestUtf8(
    canonicalJson({ operationReceiptIds: sourceOperationReceiptIds }),
  );
  const plan = Object.freeze({
    planVersion: 2 as const,
    attestationId,
    attestationHash,
    gatewayPolicyVersion: attestation.manifest.gatewayPolicyVersion,
    gatewayBinaryHash: attestation.manifest.gatewayBinaryHash,
    sourceOperationReceiptIds,
    sourceOperationReceiptIdsHash,
    operations,
  });
  const replayPlanCanonicalJson = stableJson(plan as never);
  const replayPlanHash = await d.digest.digestUtf8(replayPlanCanonicalJson);
  const reusePolicyVectorHash = await d.digest.digestUtf8(
    canonicalizeReviewContextReusePolicyVector({
      safetyDecision: policy.safetyDecision,
      compatibility: policy.compatibility,
      eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
      gatewayPolicyVersion: session.gatewayPolicyVersion,
      gatewayBinaryHash: session.gatewayBinaryHash,
      trustedCapabilityProfile: session.trustedCapabilityProfile,
      producerReleaseId: target.manifest.producerReleaseId,
      providerKind: target.manifest.providerKind,
      requestedModel: target.manifest.requestedModel,
      actualModel: attestation.actualModel,
    }),
  );
  const expiresAt = minDate(
    target.authorization.expiresAt,
    new Date(attestation.reuseExpiresAtMs),
    new Date(input.sourceCheckpointExpiresAt),
    new Date(now.getTime() + d.config.replayCapabilityLifetimeMs),
  );
  const replayCapability = await d.capabilities.issueInvestigationReceiptReplay(
    {
      sourceCertificateId: input.sourceCheckpointId,
      sourceCertificateHash: input.sourceCheckpointHash,
      attestationId,
      attestationHash,
      sourceOperationReceiptIds,
      sourceOperationReceiptIdsHash,
      contextReplayPlanHash: replayPlanHash,
      targetExecutionId: input.targetExecutionId,
      targetWorkSlotId: input.targetWorkSlotId,
      targetReviewRevisionHash: input.targetReviewRevisionHash,
      targetCheckoutTreeOid: targetTree,
      gatewayPolicyVersion: attestation.manifest.gatewayPolicyVersion,
      gatewayBinaryHash: attestation.manifest.gatewayBinaryHash,
      reusePolicyVectorHash,
      providerKind: target.manifest.providerKind,
      taskKindSet: target.manifest.taskKindSet,
      producerReleaseId: target.manifest.producerReleaseId,
      requestedModel: target.manifest.requestedModel,
      expiresAt,
    },
    now,
  );
  return Object.freeze({
    contextAttestationId: attestationId,
    contextAttestationHash: attestationHash,
    sourceOperationReceiptIdsHash,
    replayCapability,
    replayPlanCanonicalJson,
    replayPlanHash,
  });
}

function selectGatewayV4ReplayOperations(
  manifest: ContextGatewayV4Manifest,
  material: GatewayV4ReplayMaterial,
  selectedReceiptIds: readonly string[],
):
  | readonly Readonly<{
      operationKind: ContextGatewayV4OperationKind;
      replayInput: Readonly<Record<string, unknown>>;
    }>[]
  | null {
  const successful = manifest.events.filter(
    (event) => event.outcome === ContextGatewayV4OutcomeKind.Succeeded,
  );
  const eventByReceipt = new Map(
    successful.map((event) => [event.operationReceiptId!, event]),
  );
  if (selectedReceiptIds.some((receiptId) => !eventByReceipt.has(receiptId))) {
    return null;
  }
  const selectedGroups = new Set(
    selectedReceiptIds.map((receiptId) =>
      gatewayV4ReplayGroupKey(eventByReceipt.get(receiptId)!),
    ),
  );
  const entryBySequence = new Map(
    material.entries.map((entry) => [entry.sequence, entry]),
  );
  const groups = new Map<string, typeof successful>();
  for (const event of successful) {
    const key = gatewayV4ReplayGroupKey(event);
    if (!selectedGroups.has(key)) continue;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const orderedGroups = [...groups.values()].sort(
    (left, right) => left[0]!.sequence - right[0]!.sequence,
  );
  const operations: Array<{
    operationKind: ContextGatewayV4OperationKind;
    replayInput: Readonly<Record<string, unknown>>;
  }> = [];
  for (const events of orderedGroups) {
    const kind = events[0]!.operationKind;
    if (
      kind === ContextGatewayV4OperationKind.DirectoryList ||
      kind === ContextGatewayV4OperationKind.TextSearch ||
      kind === ContextGatewayV4OperationKind.CanonicalInventory
    ) {
      const first = events.find((event) => event.result?.pageOrdinal === 0);
      const entry = first ? entryBySequence.get(first.sequence) : null;
      if (!entry) return null;
      const { cursor, ...replayInput } = entry.replayInput;
      void cursor;
      operations.push(
        Object.freeze({
          operationKind: kind,
          replayInput: Object.freeze(replayInput),
        }),
      );
      continue;
    }
    for (const event of events) {
      const entry = entryBySequence.get(event.sequence);
      if (!entry) return null;
      operations.push(
        Object.freeze({
          operationKind: kind,
          replayInput: entry.replayInput,
        }),
      );
    }
  }
  return Object.freeze(operations);
}

function gatewayV4ReplayGroupKey(
  event: ContextGatewayV4Manifest["events"][number],
): string {
  const result = event.result;
  if (!result) return `failed:${event.sequence}`;
  switch (event.operationKind) {
    case ContextGatewayV4OperationKind.FileRead:
      return stableJson({
        kind: event.operationKind,
        pathHash: result.pathHash,
        revision: result.revision,
      } as never);
    case ContextGatewayV4OperationKind.DirectoryList:
    case ContextGatewayV4OperationKind.TextSearch:
    case ContextGatewayV4OperationKind.CanonicalInventory:
      return stableJson({
        kind: event.operationKind,
        queryDigest: result.queryDigest,
      } as never);
    case ContextGatewayV4OperationKind.GitFact:
      return stableJson({
        kind: event.operationKind,
        fact: result.fact,
      } as never);
    case ContextGatewayV4OperationKind.UnsupportedTool:
      return `unsupported:${event.sequence}`;
  }
}

function investigationProviderMatches(
  source: ContextProviderKind,
  target: ReviewProviderKind,
): boolean {
  switch (source) {
    case ContextProviderKind.Codex:
      return target === ReviewProviderKind.Codex;
    case ContextProviderKind.ClaudeCode:
      return target === ReviewProviderKind.ClaudeCode;
    case ContextProviderKind.OpenRouter:
      return false;
  }
}

async function verifyContextAttachment(
  input: {
    readonly authorization: ReviewRunAuthorization;
    readonly snapshot: ReviewExecutionSnapshot;
    readonly authority: ReviewActionV2ReusableAttachmentAuthority;
  },
  d: ReviewActionV2ContextAttestationHandlerDependencies,
): Promise<boolean> {
  if (
    input.authority.attachmentKind !==
      ReviewObservationAttachmentKind.ContextGatewayCrossRevisionReuse ||
    !input.authority.contextReplayProofId ||
    !input.authority.contextReplayProofHash ||
    !input.authority.contextAttestationId ||
    !input.authority.contextAttestationHash ||
    !input.authority.targetCheckoutTreeOid ||
    !input.authority.replayBinaryHash ||
    !input.authority.replayPolicyVersion
  ) {
    return false;
  }
  const observation = await d.observations.findById(
    input.authority.observationId,
  );
  if (
    !observation ||
    observation.contextDependencyAttestationId !==
      input.authority.contextAttestationId ||
    observation.contextDependencyAttestationHash !==
      input.authority.contextAttestationHash
  ) {
    return false;
  }
  const attestation = await d.store.findAcceptedAttestation(
    input.authority.contextAttestationId,
  );
  const session = attestation
    ? await d.store.findSession(attestation.sessionId)
    : null;
  const targetTree = await d.checkoutTrees.resolveCheckoutTreeOid(
    input.authorization,
  );
  if (
    !attestation ||
    !session ||
    !targetTree ||
    targetTree !== input.authority.targetCheckoutTreeOid
  ) {
    return false;
  }
  const current = await resolveCurrentCandidate({
    authorization: input.authorization,
    snapshot: input.snapshot,
    workSlotId: input.authority.targetWorkSlotId,
    manifest: input.authority.manifest,
    manifestKey: input.authority.manifestKey,
    providerInvocationKey: input.authority.providerInvocationKey,
    providerVoteIdentityHash: input.authority.providerVoteIdentityHash,
    trustDomain: input.authority.trustDomain,
    observation,
    targetCheckoutTreeOid: targetTree,
    session,
    dependencies: d,
  });
  if (
    !current ||
    current.reusePolicyVectorHash !== input.authority.reuseSafetyDecisionHash
  ) {
    return false;
  }
  const verifier = new VerifyTargetReplayProof({
    store: d.store,
    clock: { nowMs: () => d.now().getTime() },
  });
  const verified = await verifier.execute({
    replayProofId: input.authority.contextReplayProofId,
    sourceAttestationId: input.authority.contextAttestationId,
    sourceAttestationHash: input.authority.contextAttestationHash,
    targetExecutionId: input.authority.targetExecutionId,
    targetWorkSlotId: input.authority.targetWorkSlotId,
    targetReviewRevisionHash: input.authority.targetReviewRevisionHash,
    targetCheckoutTreeOid: input.authority.targetCheckoutTreeOid,
    replayBinaryHash: input.authority.replayBinaryHash,
    replayPolicyVersion: input.authority.replayPolicyVersion,
    reusePolicyVectorHash: current.reusePolicyVectorHash,
  });
  return (
    verified.status === TargetReplayProofVerificationStatus.Accepted &&
    verified.proof !== null &&
    (await hashReplayProof(verified.proof, d.digest)) ===
      input.authority.contextReplayProofHash
  );
}

async function assertCurrentContextReusePolicy(
  input: {
    readonly authorization: ReviewRunAuthorization;
    readonly snapshot: ReviewExecutionSnapshot;
  },
  d: ReviewActionV2ContextAttestationHandlerDependencies,
): Promise<void> {
  const refs = input.snapshot.observationRefs.filter(
    (ref) =>
      ref.attachmentKind ===
      ReviewObservationAttachmentKind.ContextGatewayCrossRevisionReuse,
  );
  for (const ref of refs) {
    const observation = await d.observations.findById(ref.observationId);
    if (
      !observation ||
      !observation.contextDependencyAttestationId ||
      !ref.reuseSafetyDecisionHash
    ) {
      throw stalePolicy();
    }
    const attestation = await d.store.findAcceptedAttestation(
      observation.contextDependencyAttestationId,
    );
    const session = attestation
      ? await d.store.findSession(attestation.sessionId)
      : null;
    const slot = input.snapshot.execution.workSlots.find(
      (candidate) => candidate.workSlotId === ref.workSlotId,
    );
    const lease = await findPreparedLeaseForObservation(observation, d);
    if (
      !attestation ||
      !session ||
      !slot ||
      !lease?.preparedManifestCanonicalJson
    ) {
      throw stalePolicy();
    }
    let manifest: ProviderInvocationManifest;
    try {
      manifest = normalizeProviderInvocationManifest(
        JSON.parse(lease.preparedManifestCanonicalJson),
      );
    } catch {
      throw stalePolicy();
    }
    const current = await resolveCurrentCandidate({
      authorization: input.authorization,
      snapshot: input.snapshot,
      workSlotId: ref.workSlotId,
      manifest,
      manifestKey: observation.manifestKey,
      providerInvocationKey: observation.providerInvocationKey,
      providerVoteIdentityHash: observation.providerVoteIdentityHash,
      trustDomain: observation.trustDomain,
      observation,
      targetCheckoutTreeOid:
        (await d.checkoutTrees.resolveCheckoutTreeOid(input.authorization)) ??
        "",
      session,
      dependencies: d,
    });
    if (
      !current ||
      current.reusePolicyVectorHash !== ref.reuseSafetyDecisionHash
    ) {
      throw stalePolicy();
    }
  }
}

async function resolveCurrentCandidate(
  input: ReviewActionV2ContextReplayPrepareInput & {
    readonly targetCheckoutTreeOid: string;
    readonly session: GatewaySession;
    readonly dependencies: ReviewActionV2ContextAttestationHandlerDependencies;
  },
): Promise<{ readonly reusePolicyVectorHash: string } | null> {
  const d = input.dependencies;
  const scopeHash = await authorizationScopeHash(input.authorization, d.digest);
  const policy = await d.reusePolicy.resolveReviewReusePolicy({
    scope: {
      workspaceId: input.authorization.workspaceId,
      repositoryConnectionId: input.authorization.repositoryConnectionId,
      scmRepositoryIdentityId: input.authorization.scmRepositoryIdentityId,
      pullRequestNumber: input.authorization.pullRequestNumber,
      authorizationScopeHash: scopeHash,
    },
    revision: {
      baseSha: input.authorization.baseSha,
      mergeBaseSha: input.authorization.mergeBaseSha,
      headSha: input.authorization.headSha,
      reviewRevisionHash: input.authorization.reviewRevisionHash,
    },
    providerKind: input.manifest.providerKind,
    taskKindSet: input.manifest.taskKindSet,
    trustDomain: input.trustDomain,
    producerReleaseId: input.manifest.producerReleaseId,
  });
  if (!policy) return null;
  const decision = decideReviewReuseEligibility(input.observation, {
    scope: {
      workspaceId: input.authorization.workspaceId,
      repositoryConnectionId: input.authorization.repositoryConnectionId,
      scmRepositoryIdentityId: input.authorization.scmRepositoryIdentityId,
      pullRequestNumber: input.authorization.pullRequestNumber,
      authorizationScopeHash: scopeHash,
    },
    revision: {
      baseSha: input.authorization.baseSha,
      mergeBaseSha: input.authorization.mergeBaseSha,
      headSha: input.authorization.headSha,
      reviewRevisionHash: input.authorization.reviewRevisionHash,
    },
    planHash: input.snapshot.execution.planHash,
    executionId: input.snapshot.execution.executionId,
    manifest: input.manifest,
    manifestKey: input.manifestKey,
    providerInvocationKey: input.providerInvocationKey,
    providerVoteIdentityHash: input.providerVoteIdentityHash,
    trustDomain: input.trustDomain,
    nowMs: d.now().getTime(),
    safetyDecision: policy.safetyDecision,
    compatibility: policy.compatibility,
  });
  if (
    decision.eligibility !== ReuseEligibility.CandidateOnly ||
    decision.tier !== ReviewReuseTier.T2ContextGatewayCrossRevision ||
    decision.reason !== ReviewReuseDenialReason.ContextReplayRequired ||
    policy.safetyDecision.contextGatewayReuseMode !==
      ReviewReuseEffectMode.Enabled
  ) {
    return null;
  }
  const release = await d.producerReleases.resolve({
    producerReleaseId: input.manifest.producerReleaseId,
  });
  if (
    !release ||
    release.capabilityProfile !== input.session.trustedCapabilityProfile ||
    input.session.gatewayPolicyVersion !==
      release.contextGatewayPolicyVersion ||
    input.session.gatewayBinaryHash !== release.contextGatewayEntrypointDigest
  ) {
    return null;
  }
  const reusePolicyVectorHash = await d.digest.digestUtf8(
    canonicalizeReviewContextReusePolicyVector({
      safetyDecision: policy.safetyDecision,
      compatibility: policy.compatibility,
      eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
      gatewayPolicyVersion: input.session.gatewayPolicyVersion,
      gatewayBinaryHash: input.session.gatewayBinaryHash,
      trustedCapabilityProfile: input.session.trustedCapabilityProfile,
      producerReleaseId: input.manifest.producerReleaseId,
      providerKind: input.manifest.providerKind,
      requestedModel: input.manifest.requestedModel,
      actualModel: input.observation.actualModel,
    }),
  );
  return Object.freeze({ reusePolicyVectorHash });
}

async function resolveOpeningFacts(input: {
  readonly request:
    | ReviewContextGatewayOpenRequest
    | ReviewInvestigationContextGatewayOpenRequest;
  readonly authorization: ReviewRunAuthorization;
  readonly snapshot: ReviewExecutionSnapshot;
  readonly lease: BoundContextGatewayLease;
  readonly dependencies: ReviewActionV2ContextAttestationHandlerDependencies;
}) {
  const { request, authorization, snapshot, lease, dependencies: d } = input;
  if (!lease.preparedManifestCanonicalJson) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "context_manifest_not_prepared",
    );
  }
  let manifest: ProviderInvocationManifest;
  try {
    manifest = normalizeProviderInvocationManifest(
      JSON.parse(lease.preparedManifestCanonicalJson),
    );
    if (
      serializeProviderInvocationManifestCanonicalWireJson(manifest) !==
      lease.preparedManifestCanonicalJson
    ) {
      throw new Error("context_manifest_not_canonical");
    }
  } catch {
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "context_manifest_invalid",
    );
  }
  if (
    manifest.executionProfile !== ProviderExecutionProfile.ContextGatewayV1 &&
    manifest.executionProfile !==
      ProviderExecutionProfile.InvestigationGatewayV1
  ) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "context_execution_profile_required",
    );
  }
  const slot = snapshot.execution.workSlots.find(
    (candidate) => candidate.workSlotId === request.sourceWorkSlotId,
  );
  if (
    !slot ||
    slot.providerVoteIdentityHash !== lease.providerVoteIdentityHash ||
    manifest.providerKind !== evidenceProviderKind(slot.providerKind)
  ) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "context_work_slot_authority_mismatch",
    );
  }
  const [checkoutTreeOid, release] = await Promise.all([
    d.checkoutTrees.resolveCheckoutTreeOid(authorization),
    d.producerReleases.resolve({
      producerReleaseId: authorization.producerReleaseId,
    }),
  ]);
  requireEqual(
    checkoutTreeOid,
    request.checkoutTreeOid,
    "context_checkout_tree_mismatch",
  );
  if (
    !release ||
    manifest.producerReleaseId !== authorization.producerReleaseId ||
    manifest.selectedProtocolVersion !==
      authorization.selectedProtocolVersion ||
    release.contextGatewayPolicyVersion === null ||
    release.contextGatewayEntrypointDigest === null
  ) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "context_release_authority_mismatch",
    );
  }
  requireEqual(
    request.gatewayPolicyVersion,
    release.contextGatewayPolicyVersion,
    "context_gateway_policy_mismatch",
  );
  requireEqual(
    request.gatewayBinaryHash,
    release.contextGatewayEntrypointDigest,
    "context_gateway_binary_mismatch",
  );
  const confinementProofHash = await d.digest.digestUtf8(
    (lease.authorityKind === ContextLeaseAuthorityKind.StandardExecution
      ? canonicalizeReviewContextConfinementEvidence
      : canonicalizeReviewInvestigationContextConfinementEvidence)({
      attemptId: request.attemptId,
      sourceLeaseId: request.sourceLeaseId,
      sourceFencingToken: request.fencingToken,
      sourceExecutionId: request.sourceExecutionId,
      sourceWorkSlotId: request.sourceWorkSlotId,
      sourceReviewRevisionHash: request.sourceReviewRevisionHash,
      checkoutTreeOid: request.checkoutTreeOid,
      providerKind: manifest.providerKind,
      requestedModel: manifest.requestedModel,
      executionProfile: manifest.executionProfile,
      providerInvocationKey: lease.providerInvocationKey,
      toolPolicyHash: manifest.toolPolicyHash,
      gatewayPolicyVersion: request.gatewayPolicyVersion,
      gatewayBinaryHash: request.gatewayBinaryHash,
    }),
  );
  requireEqual(
    confinementProofHash,
    request.confinementEvidenceHash,
    "context_confinement_evidence_mismatch",
  );
  const openingIntentHash = await d.digest.digestUtf8(
    openingIntentIdentity(lease.authorityKind, request.idempotencyKey),
  );
  return Object.freeze({
    scope: {
      workspaceId: authorization.workspaceId,
      repositoryConnectionId: authorization.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      pullRequestNumber: authorization.pullRequestNumber,
    },
    sourceRevision: {
      baseSha: authorization.baseSha,
      mergeBaseSha: authorization.mergeBaseSha,
      headSha: authorization.headSha,
      reviewRevisionHash: authorization.reviewRevisionHash,
      checkoutTreeOid: request.checkoutTreeOid,
    },
    sourceExecutionId: request.sourceExecutionId,
    sourceWorkSlotId: request.sourceWorkSlotId,
    attemptId: request.attemptId,
    openingIntentHash,
    sourceLeaseAuthorityKind: lease.authorityKind,
    sourceLeaseId: request.sourceLeaseId,
    sourceFencingToken: request.fencingToken,
    providerKind: contextProviderKind(manifest.providerKind),
    requestedModel: manifest.requestedModel,
    trustedCapabilityProfile: release.capabilityProfile,
    gatewayBinaryHash: request.gatewayBinaryHash,
    gatewayPolicyVersion: request.gatewayPolicyVersion,
    producerReleaseId: manifest.producerReleaseId,
    selectedProtocolVersion: manifest.selectedProtocolVersion,
    confinementProofHash,
    eventChainSeedHash: "0".repeat(64),
    sessionLifetimeMs: d.config.sessionLifetimeMs,
  });
}

async function requireBoundLease(input: {
  readonly authority: VerifiedReviewActionV2LeaseCapability;
  readonly authorization: ReviewRunAuthorization;
  readonly snapshot: ReviewExecutionSnapshot;
  readonly leaseId: string;
  readonly workSlotId: string;
  readonly attemptId: string;
  readonly fencingToken: string;
  readonly requireOwnership: boolean;
  readonly now: Date;
  readonly dependencies: ReviewActionV2ContextAttestationHandlerDependencies;
}): Promise<ReviewInvocationLease> {
  const { authority, authorization, snapshot, dependencies: d } = input;
  requireEqual(
    authority.authorizationId,
    authorization.authorizationId,
    "context_lease_authorization_mismatch",
  );
  requireEqual(
    authority.scopeHash,
    await authorizationScopeHash(authorization, d.digest),
    "context_lease_scope_mismatch",
  );
  requireEqual(
    authority.mutationEpoch,
    authorization.mutationEpoch,
    "context_lease_mutation_epoch_mismatch",
  );
  requireEqual(
    authority.reviewRevisionHash,
    authorization.reviewRevisionHash,
    "context_lease_revision_mismatch",
  );
  requireEqual(authority.leaseId, input.leaseId, "context_lease_id_mismatch");
  requireEqual(
    authority.executionId,
    snapshot.execution.executionId,
    "context_lease_execution_mismatch",
  );
  requireEqual(
    authority.workSlotId,
    input.workSlotId,
    "context_lease_work_slot_mismatch",
  );
  requireEqual(
    authority.attemptId,
    input.attemptId,
    "context_lease_attempt_mismatch",
  );
  if (
    authority.purpose !== ReviewInvocationLeasePurpose.ProviderExecution ||
    (input.requireOwnership && authority.ownershipExpiresAt <= input.now) ||
    (!input.requireOwnership && authority.resultReportUntil <= input.now)
  ) {
    throw failure(
      410,
      ReviewActionV2ProtocolErrorCode.ResourceGone,
      "context_lease_expired",
    );
  }
  const lease = await d.executionQueries.findLease(input.leaseId);
  if (
    !lease ||
    lease.leaseCapabilityId !== authority.capabilityId ||
    lease.executionId !== authority.executionId ||
    lease.workSlotId !== authority.workSlotId ||
    lease.attemptId !== authority.attemptId ||
    lease.providerInvocationKey !== authority.providerInvocationKey ||
    lease.fencingToken.toString(10) !== input.fencingToken ||
    lease.purpose !== ReviewInvocationLeasePurpose.ProviderExecution ||
    (input.requireOwnership &&
      (lease.state !== ReviewInvocationLeaseState.Active ||
        lease.expiresAt <= input.now))
  ) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "context_lease_fence_mismatch",
    );
  }
  return lease;
}

async function resolveBoundContextGatewayLease(input: {
  readonly authorityKind: ContextLeaseAuthorityKind;
  readonly leaseCapability: string;
  readonly authorization: ReviewRunAuthorization;
  readonly leaseId: string;
  readonly workSlotId: string | null;
  readonly attemptId: string;
  readonly fencingToken: string;
  readonly sourceExecutionId: string | null;
  readonly requireOwnership: boolean;
  readonly operation: ReviewInvestigationLeaseProtectedOperation;
  readonly now: Date;
  readonly dependencies: ReviewActionV2ContextAttestationHandlerDependencies;
}): Promise<
  Readonly<{
    snapshot: ReviewExecutionSnapshot;
    lease: BoundContextGatewayLease;
  }>
> {
  const { authorization, dependencies: d } = input;
  switch (input.authorityKind) {
    case ContextLeaseAuthorityKind.StandardExecution: {
      const authority = await verifyLeaseCapability(
        input.leaseCapability,
        input.now,
        d,
      );
      const snapshot = await requireExecution(
        authority.executionId,
        authorization,
        d.executionQueries,
      );
      if (
        (input.sourceExecutionId !== null &&
          input.sourceExecutionId !== authority.executionId) ||
        (input.workSlotId !== null && input.workSlotId !== authority.workSlotId)
      ) {
        throw failure(
          412,
          ReviewActionV2ProtocolErrorCode.StalePrecondition,
          "context_lease_request_binding_mismatch",
        );
      }
      const lease = await requireBoundLease({
        authority,
        authorization,
        snapshot,
        leaseId: input.leaseId,
        workSlotId: authority.workSlotId,
        attemptId: input.attemptId,
        fencingToken: input.fencingToken,
        requireOwnership: input.requireOwnership,
        now: input.now,
        dependencies: d,
      });
      if (!lease.preparedManifestCanonicalJson) {
        throw failure(
          412,
          ReviewActionV2ProtocolErrorCode.StalePrecondition,
          "context_manifest_not_prepared",
        );
      }
      return Object.freeze({
        snapshot,
        lease: Object.freeze({
          authorityKind: ContextLeaseAuthorityKind.StandardExecution,
          capabilityId: authority.capabilityId,
          authorizationId: authority.authorizationId,
          mutationEpoch: authority.mutationEpoch,
          scopeHash: authority.scopeHash,
          executionId: authority.executionId,
          workSlotId: authority.workSlotId,
          leaseId: authority.leaseId,
          attemptId: input.attemptId,
          providerInvocationKey: lease.providerInvocationKey,
          providerVoteIdentityHash: lease.providerVoteIdentityHash,
          preparedManifestCanonicalJson: lease.preparedManifestCanonicalJson,
          investigationRolloutCapability: null,
        }),
      });
    }
    case ContextLeaseAuthorityKind.InvestigationShadow:
      return resolveBoundInvestigationContextGatewayLease(input);
  }
}

async function resolveBoundInvestigationContextGatewayLease(input: {
  readonly leaseCapability: string;
  readonly authorization: ReviewRunAuthorization;
  readonly leaseId: string;
  readonly workSlotId: string | null;
  readonly attemptId: string;
  readonly fencingToken: string;
  readonly sourceExecutionId: string | null;
  readonly requireOwnership: boolean;
  readonly operation: ReviewInvestigationLeaseProtectedOperation;
  readonly now: Date;
  readonly dependencies: ReviewActionV2ContextAttestationHandlerDependencies;
}): Promise<
  Readonly<{
    snapshot: ReviewExecutionSnapshot;
    lease: BoundContextGatewayLease;
  }>
> {
  const d = input.dependencies;
  let authority: VerifiedReviewActionV2InvestigationLeaseCapability;
  try {
    authority = await d.investigationLeaseCapabilities.verify(
      input.leaseCapability,
      input.now,
    );
  } catch {
    throw failure(
      401,
      ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      "context_investigation_lease_capability_invalid",
    );
  }
  const snapshot = await requireExecution(
    authority.executionId,
    input.authorization,
    d.executionQueries,
  );
  const lease = await d.investigationLeaseQueries.findLease(input.leaseId);
  const aggregate = lease
    ? await d.investigationQueries.findById(lease.investigationId)
    : null;
  if (
    !lease ||
    !aggregate ||
    authority.authorizationId !== input.authorization.authorizationId ||
    authority.scopeHash !==
      (await authorizationScopeHash(input.authorization, d.digest)) ||
    authority.mutationEpoch !== input.authorization.mutationEpoch ||
    authority.reviewRevisionHash !== input.authorization.reviewRevisionHash ||
    authority.capabilityId !== lease.leaseCapabilityId ||
    authority.authorizationId !== lease.authorizationId ||
    authority.mutationEpoch !== lease.mutationEpoch ||
    authority.executionId !== lease.executionId ||
    authority.workSlotId !== lease.workSlotId ||
    authority.leaseId !== lease.leaseId ||
    authority.attemptId !== lease.attemptId ||
    authority.fencingToken !== lease.fencingToken ||
    authority.investigationId !== lease.investigationId ||
    authority.investigationVersion !== lease.investigationVersion ||
    authority.turnId !== lease.turnId ||
    authority.turnPurpose !== lease.turnPurpose ||
    authority.providerVoteLaneId !== lease.providerVoteLaneId ||
    authority.providerStrategyId !== lease.providerStrategyId ||
    authority.investigationManifestHash !== lease.investigationManifestHash ||
    authority.ownerIdHash !== lease.ownerIdHash ||
    lease.leaseId !== input.leaseId ||
    lease.attemptId !== input.attemptId ||
    lease.fencingToken.toString(10) !== input.fencingToken ||
    (input.sourceExecutionId !== null &&
      lease.executionId !== input.sourceExecutionId) ||
    (input.workSlotId !== null && lease.workSlotId !== input.workSlotId) ||
    lease.state !== ReviewInvestigationLeaseState.Active ||
    (input.requireOwnership
      ? new Date(lease.expiresAt) <= input.now ||
        authority.ownershipExpiresAt <= input.now
      : new Date(lease.resultReportUntil) <= input.now ||
        authority.resultReportUntil <= input.now) ||
    !reviewInvestigationLeaseBindingIsCurrent(lease, aggregate)
  ) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "context_investigation_lease_stale",
    );
  }
  try {
    assertReviewInvestigationLeaseAllows(lease, input.operation);
  } catch {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "context_investigation_lease_operation_forbidden",
    );
  }
  return Object.freeze({
    snapshot,
    lease: investigationContextGatewayLease(authority, lease),
  });
}

function investigationContextGatewayLease(
  authority: VerifiedReviewActionV2InvestigationLeaseCapability,
  lease: ReviewInvestigationLease,
): BoundContextGatewayLease {
  return Object.freeze({
    authorityKind: ContextLeaseAuthorityKind.InvestigationShadow,
    capabilityId: authority.capabilityId,
    authorizationId: authority.authorizationId,
    mutationEpoch: authority.mutationEpoch,
    scopeHash: authority.scopeHash,
    executionId: authority.executionId,
    workSlotId: authority.workSlotId,
    leaseId: authority.leaseId,
    attemptId: authority.attemptId,
    providerInvocationKey: lease.providerStrategyId,
    providerVoteIdentityHash: lease.providerVoteLaneId,
    preparedManifestCanonicalJson: lease.investigationManifestCanonicalJson,
    investigationRolloutCapability:
      lease.turnPurpose === ReviewInvestigationTurnPurpose.Critic
        ? InvestigationRolloutCapability.ContextCritic
        : InvestigationRolloutCapability.Recording,
  });
}

async function assertInvestigationShadowGatewayAllowed(input: {
  readonly authorization: ReviewRunAuthorization;
  readonly bound: Readonly<{
    snapshot: ReviewExecutionSnapshot;
    lease: BoundContextGatewayLease;
  }>;
  readonly dependencies: ReviewActionV2ContextAttestationHandlerDependencies;
}): Promise<void> {
  const { authorization, bound, dependencies: d } = input;
  if (
    bound.lease.authorityKind !== ContextLeaseAuthorityKind.InvestigationShadow
  ) {
    return;
  }
  const capability = bound.lease.investigationRolloutCapability;
  const slot = bound.snapshot.execution.workSlots.find(
    (candidate) => candidate.workSlotId === bound.lease.workSlotId,
  );
  const providerKind = slot ? extensionProvider(slot.providerKind) : null;
  if (
    capability === null ||
    providerKind === null ||
    !slot ||
    slot.providerVoteIdentityHash !== bound.lease.providerVoteIdentityHash ||
    !hasAuthorizedReviewInvestigationExtension(authorization, {
      providerKind,
      capability,
    })
  ) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
      "review_investigation_extension_not_authorized",
    );
  }
  await d.investigationRollout.assertAllowed({
    capability,
    target: {
      workspaceId: authorization.workspaceId,
      repositoryConnectionId: authorization.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      provider: rolloutProvider(slot.providerKind),
      trustDomain: authorization.trustDomain,
      producerReleaseId: authorization.producerReleaseId,
    },
  });
}

function extensionProvider(
  provider: ReviewExecutionProviderKind,
): ReviewInvestigationAuthorizedProviderKind | null {
  switch (provider) {
    case ReviewExecutionProviderKind.Codex:
      return "codex";
    case ReviewExecutionProviderKind.ClaudeCode:
      return "claude_code";
    case ReviewExecutionProviderKind.OpenRouter:
      return null;
  }
}

function rolloutProvider(
  provider: ReviewExecutionProviderKind,
): InvestigationRolloutProvider {
  switch (provider) {
    case ReviewExecutionProviderKind.Codex:
      return InvestigationRolloutProvider.Codex;
    case ReviewExecutionProviderKind.ClaudeCode:
      return InvestigationRolloutProvider.Claude;
    case ReviewExecutionProviderKind.OpenRouter:
      return InvestigationRolloutProvider.Unknown;
  }
}

async function assertSealAuthority(input: {
  readonly request:
    | ReviewContextGatewaySealRequest
    | ReviewInvestigationContextGatewaySealRequest;
  readonly authorization: ReviewRunAuthorization;
  readonly leaseAuthority: BoundContextGatewayLease;
  readonly sealAuthority:
    | ReviewActionV2ContextGatewaySealAuthority
    | ReviewActionV2InvestigationContextGatewaySealAuthority;
  readonly session: GatewaySession;
  readonly dependencies: ReviewActionV2ContextAttestationHandlerDependencies;
}) {
  const { request, authorization, leaseAuthority, sealAuthority, session } =
    input;
  const expected = {
    authorizationId: authorization.authorizationId,
    mutationEpoch: authorization.mutationEpoch,
    scopeHash: await authorizationScopeHash(
      authorization,
      input.dependencies.digest,
    ),
    sessionId: request.sessionId,
    sourceExecutionId: session.sourceExecutionId,
    sourceWorkSlotId: session.sourceWorkSlotId,
    attemptId: request.attemptId,
    sourceLeaseId: request.sourceLeaseId,
    sourceFencingToken: request.fencingToken,
    sourceReviewRevisionHash: authorization.reviewRevisionHash,
    checkoutTreeOid: session.sourceRevision.checkoutTreeOid,
    gatewayPolicyVersion: session.gatewayPolicyVersion,
    gatewayBinaryHash: session.gatewayBinaryHash,
    confinementEvidenceHash: session.confinementProofHash,
  };
  for (const key of Object.keys(
    expected,
  ) as readonly (keyof typeof expected)[]) {
    requireEqual(
      sealAuthority[key],
      expected[key],
      `context_seal_${key}_mismatch`,
    );
  }
  if (
    session.sourceLeaseAuthorityKind ===
    ContextLeaseAuthorityKind.InvestigationShadow
  ) {
    requireEqual(
      "sourceLeaseAuthorityKind" in sealAuthority
        ? sealAuthority.sourceLeaseAuthorityKind
        : null,
      "investigation_shadow",
      "context_seal_authority_kind_mismatch",
    );
  } else if ("sourceLeaseAuthorityKind" in sealAuthority) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "context_seal_authority_kind_mismatch",
    );
  }
  requireEqual(
    leaseAuthority.authorityKind,
    session.sourceLeaseAuthorityKind,
    "context_seal_lease_authority_kind_mismatch",
  );
  requireEqual(
    leaseAuthority.executionId,
    session.sourceExecutionId,
    "context_seal_execution_mismatch",
  );
  requireEqual(
    leaseAuthority.workSlotId,
    session.sourceWorkSlotId,
    "context_seal_slot_mismatch",
  );
}

function parseContextManifest(value: string, issue: string) {
  let manifest: ContextAttestationManifest;
  try {
    manifest = createContextAttestationManifest(JSON.parse(value));
  } catch (error) {
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      compactIssues([issue, safeContextManifestIssue(error)]),
    );
  }
  if (canonicalContextAttestationManifest(manifest) !== value) {
    throw failure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      `${issue}_not_canonical`,
    );
  }
  return manifest;
}

type LegacyReplayMaterial = Readonly<{
  materialVersion: typeof replayMaterialVersion;
  sourceDependencies: readonly Readonly<{
    sequence: number;
    operationKey: string;
    replayQuery: string | null;
  }>[];
}>;

type GatewayV4ReplayMaterial = Readonly<{
  replayMaterialVersion: 2;
  sessionId: string;
  entries: readonly Readonly<{
    sequence: number;
    operationReceiptId: string;
    operationKey: string;
    operationKind: ContextGatewayV4OperationKind;
    replayInput: Readonly<Record<string, unknown>>;
  }>[];
}>;

type ReplayMaterial = LegacyReplayMaterial | GatewayV4ReplayMaterial;

function parseReplayMaterial(
  value: string,
  manifest: ContextAttestationManifest,
  session: GatewaySession,
  sessionSecret: Buffer,
): ReplayMaterial & { readonly canonicalJson: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidReplayMaterial();
  }
  if (!isLegacyContextDependencyManifest(manifest)) {
    return parseGatewayV4ReplayMaterial(value, parsed, manifest, session);
  }
  const root = exactRecord(
    parsed,
    ["materialVersion", "sourceDependencies"],
    "context_replay_material_invalid",
  );
  if (
    root.materialVersion !== replayMaterialVersion ||
    !Array.isArray(root.sourceDependencies) ||
    root.sourceDependencies.length !== manifest.dependencies.length
  ) {
    throw invalidReplayMaterial();
  }
  const sourceDependencies = root.sourceDependencies.map((candidate, index) => {
    const row = exactRecord(
      candidate,
      ["sequence", "operationKey", "replayQuery"],
      "context_replay_material_invalid",
    );
    const source = manifest.dependencies[index];
    if (
      !source ||
      row.sequence !== source.sequence ||
      row.operationKey !== source.operationKey
    ) {
      throw invalidReplayMaterial();
    }
    const replayQuery = row.replayQuery;
    if (source.operation.kind === ContextDependencyKind.TextSearch) {
      if (
        typeof replayQuery !== "string" ||
        replayQuery.length === 0 ||
        Buffer.byteLength(replayQuery, "utf8") > 64 * 1024 ||
        hmacHex(
          sessionSecret,
          canonicalizeReviewContextSearchQuery(replayQuery),
        ) !== source.operation.queryDigest ||
        sha256Utf8(
          hmacHex(
            sessionSecret,
            canonicalizeReviewContextReplayHandle({
              sessionId: session.sessionId,
              sequence: source.sequence,
              query: replayQuery,
            }),
          ),
        ) !== source.operation.replayHandleHash
      ) {
        throw invalidReplayMaterial();
      }
    } else if (replayQuery !== null) {
      throw invalidReplayMaterial();
    }
    return Object.freeze({
      sequence: source.sequence,
      operationKey: source.operationKey,
      replayQuery: replayQuery as string | null,
    });
  });
  const normalized: ReplayMaterial = Object.freeze({
    materialVersion: replayMaterialVersion,
    sourceDependencies: Object.freeze(sourceDependencies),
  });
  const canonical = stableJson(normalized as never);
  if (canonical !== value) throw invalidReplayMaterial();
  return Object.freeze({ ...normalized, canonicalJson: canonical });
}

function parseGatewayV4ReplayMaterial(
  value: string,
  parsed: unknown,
  manifest: ContextGatewayV4Manifest,
  session: GatewaySession,
): ReplayMaterial & { readonly canonicalJson: string } {
  if (isRecordWithKeys(parsed, ["materialVersion", "sourceDependencies"])) {
    const legacy = parsed as Record<string, unknown>;
    if (
      legacy.materialVersion !== replayMaterialVersion ||
      !Array.isArray(legacy.sourceDependencies) ||
      legacy.sourceDependencies.length !== 0 ||
      stableJson(legacy as never) !== value
    ) {
      throw invalidReplayMaterial();
    }
    return Object.freeze({
      materialVersion: replayMaterialVersion,
      sourceDependencies: Object.freeze([]),
      canonicalJson: value,
    });
  }
  const root = exactRecord(
    parsed,
    ["entries", "replayMaterialVersion", "sessionId"],
    "context_replay_material_invalid",
  );
  const successful = manifest.events.filter(
    (event) => event.outcome === ContextGatewayV4OutcomeKind.Succeeded,
  );
  if (
    root.replayMaterialVersion !== 2 ||
    root.sessionId !== session.sessionId ||
    !Array.isArray(root.entries) ||
    root.entries.length !== successful.length
  ) {
    throw invalidReplayMaterial();
  }
  const entries = root.entries.map((candidate, index) => {
    const row = exactRecord(
      candidate,
      [
        "operationKey",
        "operationKind",
        "operationReceiptId",
        "replayInput",
        "sequence",
      ],
      "context_replay_material_invalid",
    );
    const event = successful[index];
    if (
      !event ||
      row.sequence !== event.sequence ||
      row.operationReceiptId !== event.operationReceiptId ||
      row.operationKey !== event.operationKey ||
      row.operationKind !== event.operationKind ||
      !Object.values(ContextGatewayV4OperationKind).includes(
        row.operationKind as ContextGatewayV4OperationKind,
      )
    ) {
      throw invalidReplayMaterial();
    }
    const operationKind = row.operationKind as ContextGatewayV4OperationKind;
    const replayInput = normalizeGatewayV4ReplayInput(
      operationKind,
      row.replayInput,
    );
    if (
      gatewayV4OperationKey(operationKind, replayInput) !== event.operationKey
    ) {
      throw invalidReplayMaterial();
    }
    return Object.freeze({
      sequence: event.sequence,
      operationReceiptId: event.operationReceiptId!,
      operationKey: event.operationKey,
      operationKind,
      replayInput,
    });
  });
  const normalized = Object.freeze({
    replayMaterialVersion: 2 as const,
    sessionId: session.sessionId,
    entries: Object.freeze(entries),
  });
  const canonicalJson = stableJson(normalized as never);
  if (canonicalJson !== value) throw invalidReplayMaterial();
  return Object.freeze({ ...normalized, canonicalJson });
}

function normalizeGatewayV4ReplayInput(
  kind: ContextGatewayV4OperationKind,
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidReplayMaterial();
  }
  const input = value as Record<string, unknown>;
  const allowed = gatewayV4ReplayInputKeys(kind);
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw invalidReplayMaterial();
  }
  switch (kind) {
    case ContextGatewayV4OperationKind.FileRead:
    case ContextGatewayV4OperationKind.DirectoryList:
      requireReplayString(input.path);
      break;
    case ContextGatewayV4OperationKind.TextSearch:
      requireReplayString(input.query);
      if (
        input.paths !== undefined &&
        !isCanonicalUndefined(input.paths) &&
        (!Array.isArray(input.paths) ||
          input.paths.some((path) => typeof path !== "string"))
      ) {
        throw invalidReplayMaterial();
      }
      break;
    case ContextGatewayV4OperationKind.GitFact:
      if (
        !["merge_base", "changed_paths", "diff_stat"].includes(
          String(input.fact),
        )
      ) {
        throw invalidReplayMaterial();
      }
      break;
    case ContextGatewayV4OperationKind.CanonicalInventory:
      break;
    case ContextGatewayV4OperationKind.UnsupportedTool:
      throw invalidReplayMaterial();
  }
  if (
    input.cursor !== undefined &&
    input.cursor !== null &&
    !isCanonicalUndefined(input.cursor) &&
    typeof input.cursor !== "string"
  ) {
    throw invalidReplayMaterial();
  }
  return Object.freeze({ ...input });
}

function gatewayV4ReplayInputKeys(
  kind: ContextGatewayV4OperationKind,
): readonly string[] {
  switch (kind) {
    case ContextGatewayV4OperationKind.FileRead:
      return ["maxBytes", "path", "revision", "startByte"];
    case ContextGatewayV4OperationKind.DirectoryList:
      return [
        "cursor",
        "includeHidden",
        "maxDepth",
        "pageSize",
        "path",
        "revision",
      ];
    case ContextGatewayV4OperationKind.TextSearch:
      return [
        "caseSensitive",
        "cursor",
        "pageSize",
        "paths",
        "query",
        "revision",
      ];
    case ContextGatewayV4OperationKind.CanonicalInventory:
      return ["cursor", "pageSize"];
    case ContextGatewayV4OperationKind.GitFact:
      return ["fact"];
    case ContextGatewayV4OperationKind.UnsupportedTool:
      return [];
  }
}

function gatewayV4OperationKey(
  kind: ContextGatewayV4OperationKind,
  replayInput: Readonly<Record<string, unknown>>,
): string {
  switch (kind) {
    case ContextGatewayV4OperationKind.FileRead:
      return sha256Utf8(
        stableJson({
          kind,
          inputHash: sha256Utf8(stableJson(replayInput as never)),
        } as never),
      );
    case ContextGatewayV4OperationKind.DirectoryList:
    case ContextGatewayV4OperationKind.CanonicalInventory:
      return gatewayV4HashedInputOperationKey(kind, replayInput, false);
    case ContextGatewayV4OperationKind.TextSearch:
      return gatewayV4HashedInputOperationKey(kind, replayInput, true);
    case ContextGatewayV4OperationKind.GitFact:
      return sha256Utf8(stableJson({ kind, fact: replayInput.fact } as never));
    case ContextGatewayV4OperationKind.UnsupportedTool:
      throw invalidReplayMaterial();
  }
}

function gatewayV4HashedInputOperationKey(
  kind: ContextGatewayV4OperationKind,
  replayInput: Readonly<Record<string, unknown>>,
  redactQuery: boolean,
): string {
  const normalized = {
    ...replayInput,
    ...(redactQuery ? { query: sha256Utf8(String(replayInput.query)) } : {}),
    cursor:
      typeof replayInput.cursor === "string"
        ? sha256Utf8(replayInput.cursor)
        : null,
  };
  return sha256Utf8(
    stableJson({
      kind,
      inputHash: sha256Utf8(stableJson(normalized as never)),
    } as never),
  );
}

function requireReplayString(value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidReplayMaterial();
  }
}

function isCanonicalUndefined(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (value as Record<string, unknown>).$undefined === true
  );
}

function isRecordWithKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>)
      .sort()
      .join("\0") === [...keys].sort().join("\0")
  );
}

function verifyGatewayTranscript(
  session: GatewaySession,
  manifest: ContextAttestationManifest,
  sessionSecret: Buffer,
): void {
  if (!isLegacyContextDependencyManifest(manifest)) {
    verifyGatewayV4Transcript(session, manifest, sessionSecret);
    return;
  }
  let previous = session.eventChainSeedHash;
  for (const dependency of manifest.dependencies) {
    if (dependency.previousEventHash !== previous) {
      throw transcriptChainInvalid();
    }
    const expected = hmacHex(
      sessionSecret,
      canonicalizeReviewContextGatewayEvent({
        sessionId: session.sessionId,
        sequence: dependency.sequence,
        previousEventHash: dependency.previousEventHash,
        operationKey: dependency.operationKey,
        operation: JSON.parse(
          canonicalContextDependencyOperation(dependency.operation),
        ),
        result: JSON.parse(canonicalContextDependencyResult(dependency.result)),
      }),
    );
    if (!sameHex(expected, dependency.eventHash)) {
      throw transcriptChainInvalid();
    }
    previous = dependency.eventHash;
  }
  if (manifest.authenticatedChainHash !== previous) {
    throw transcriptChainInvalid();
  }
}

function verifyGatewayV4Transcript(
  session: GatewaySession,
  manifest: ContextGatewayV4Manifest,
  sessionSecret: Buffer,
): void {
  let previous = session.eventChainSeedHash;
  for (const event of manifest.events) {
    if (event.previousEventHash !== previous) {
      throw transcriptChainInvalid();
    }
    const expected = hmacHex(
      sessionSecret,
      stableJson({
        sessionId: session.sessionId,
        sequence: event.sequence,
        previousEventHash: event.previousEventHash,
        operationKey: event.operationKey,
        outcome: event.outcome,
        failureClass: event.failureClass,
        operation: event.operation,
        result: event.result,
        operationReceiptId: event.operationReceiptId,
        sanitizedReason: event.sanitizedReason,
      } as never),
    );
    if (!sameHex(expected, event.eventHash)) {
      throw transcriptChainInvalid();
    }
    previous = event.eventHash;
  }
  if (manifest.authenticatedChainHash !== previous) {
    throw transcriptChainInvalid();
  }
}

function verifySyntheticReplayChain(
  manifest: ContextDependencyManifest,
  planHash: string,
  attestationId: string,
  targetReviewRevisionHash: string,
  targetCheckoutTreeOid: string,
): void {
  let previous = sha256Utf8(
    canonicalizeReviewContextReplayChainSeed({
      planHash,
      attestationId,
      targetReviewRevisionHash,
      targetCheckoutTreeOid,
    }),
  );
  for (const dependency of manifest.dependencies) {
    if (dependency.previousEventHash !== previous) {
      throw replayChainInvalid();
    }
    const expected = sha256Utf8(
      canonicalizeReviewContextReplayEvent({
        sequence: dependency.sequence,
        previousEventHash: dependency.previousEventHash,
        operationKey: dependency.operationKey,
        operation: JSON.parse(
          canonicalContextDependencyOperation(dependency.operation),
        ),
        result: JSON.parse(canonicalContextDependencyResult(dependency.result)),
      }),
    );
    if (!sameHex(expected, dependency.eventHash)) {
      throw replayChainInvalid();
    }
    previous = dependency.eventHash;
  }
  if (manifest.authenticatedChainHash !== previous) {
    throw replayChainInvalid();
  }
}

function verifySyntheticGatewayV4ReplayChain(
  manifest: ContextGatewayV4Manifest,
  planHash: string,
  attestationId: string,
  targetReviewRevisionHash: string,
  targetCheckoutTreeOid: string,
): void {
  let previous = sha256Utf8(
    canonicalizeReviewContextReplayChainSeed({
      planHash,
      attestationId,
      targetReviewRevisionHash,
      targetCheckoutTreeOid,
    }),
  );
  if (manifest.eventChainSeedHash !== previous) throw replayChainInvalid();
  for (const event of manifest.events) {
    if (
      event.outcome !== ContextGatewayV4OutcomeKind.Succeeded ||
      event.previousEventHash !== previous
    ) {
      throw replayChainInvalid();
    }
    const expected = sha256Utf8(
      canonicalizeReviewContextReplayEvent({
        sequence: event.sequence,
        previousEventHash: event.previousEventHash,
        operationKey: event.operationKey,
        operation: event.operation,
        result: event.result,
      }),
    );
    if (!sameHex(expected, event.eventHash)) throw replayChainInvalid();
    previous = event.eventHash;
  }
  if (manifest.authenticatedChainHash !== previous) {
    throw replayChainInvalid();
  }
}

function reusableAttachmentAuthority(input: {
  readonly input: ReviewActionV2ContextReplayPrepareInput;
  readonly reusePolicyVectorHash: string;
  readonly expiresAt: Date;
}): ReviewActionV2ReusableAttachmentAuthority {
  return Object.freeze({
    authorizationId: input.input.authorization.authorizationId,
    mutationEpoch: input.input.authorization.mutationEpoch,
    scopeHash: input.input.manifest.scopeHash,
    targetExecutionId: input.input.snapshot.execution.executionId,
    targetWorkSlotId: input.input.workSlotId,
    targetReviewRevisionHash:
      input.input.snapshot.execution.revision.reviewRevisionHash,
    targetPlanHash: input.input.snapshot.execution.planHash,
    observationId: input.input.observation.observationId,
    sourceExecutionId: input.input.observation.sourceExecutionId,
    manifest: input.input.manifest,
    manifestKey: input.input.manifestKey,
    providerInvocationKey: input.input.providerInvocationKey,
    providerVoteIdentityHash: input.input.providerVoteIdentityHash,
    payloadHash: input.input.observation.payloadHash,
    byteCount: input.input.observation.byteCount,
    findingCount: input.input.observation.findingCount,
    attachmentKind:
      ReviewObservationAttachmentKind.ContextGatewayCrossRevisionReuse,
    reuseSafetyDecisionHash: input.reusePolicyVectorHash,
    eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
    trustDomain: input.input.trustDomain,
    expiresAt: input.expiresAt,
  });
}

function assertReplayRequestAuthority(
  request: ReviewContextReplayCommitRequest,
  authorization: ReviewRunAuthorization,
  authority: ReviewActionV2ContextReplayAuthority,
): void {
  requireEqual(
    authority.attestationId,
    request.attestationId,
    "context_replay_attestation_id_mismatch",
  );
  requireEqual(
    authority.attestationHash,
    request.attestationHash,
    "context_replay_attestation_hash_mismatch",
  );
  requireEqual(
    authority.attachment.authorizationId,
    authorization.authorizationId,
    "context_replay_authorization_mismatch",
  );
  requireEqual(
    authority.attachment.mutationEpoch,
    authorization.mutationEpoch,
    "context_replay_mutation_epoch_mismatch",
  );
  requireEqual(
    authority.attachment.targetExecutionId,
    request.executionId,
    "context_replay_execution_mismatch",
  );
  requireEqual(
    authority.attachment.targetWorkSlotId,
    request.workSlotId,
    "context_replay_work_slot_mismatch",
  );
  requireEqual(
    authority.attachment.targetReviewRevisionHash,
    request.targetReviewRevisionHash,
    "context_replay_revision_mismatch",
  );
  requireEqual(
    authority.targetCheckoutTreeOid,
    request.targetCheckoutTreeOid,
    "context_replay_tree_mismatch",
  );
}

function gatewaySecretIdentity(
  facts: Pick<
    GatewaySession,
    | "attemptId"
    | "openingIntentHash"
    | "sourceLeaseAuthorityKind"
    | "sourceLeaseId"
    | "sourceFencingToken"
    | "sourceExecutionId"
    | "sourceWorkSlotId"
    | "sourceRevision"
    | "gatewayPolicyVersion"
    | "gatewayBinaryHash"
    | "confinementProofHash"
  >,
) {
  if (
    facts.sourceLeaseAuthorityKind ===
    ContextLeaseAuthorityKind.StandardExecution
  ) {
    return canonicalJson({
      attemptId: facts.attemptId,
      openingIntentHash: facts.openingIntentHash,
      sourceLeaseId: facts.sourceLeaseId,
      sourceFencingToken: facts.sourceFencingToken,
      sourceExecutionId: facts.sourceExecutionId,
      sourceWorkSlotId: facts.sourceWorkSlotId,
      sourceReviewRevisionHash: facts.sourceRevision.reviewRevisionHash,
      checkoutTreeOid: facts.sourceRevision.checkoutTreeOid,
      gatewayPolicyVersion: facts.gatewayPolicyVersion,
      gatewayBinaryHash: facts.gatewayBinaryHash,
      confinementProofHash: facts.confinementProofHash,
    });
  }
  return canonicalJson({
    identityVersion: 2,
    attemptId: facts.attemptId,
    openingIntentHash: facts.openingIntentHash,
    sourceLeaseAuthorityKind: facts.sourceLeaseAuthorityKind,
    sourceLeaseId: facts.sourceLeaseId,
    sourceFencingToken: facts.sourceFencingToken,
    sourceExecutionId: facts.sourceExecutionId,
    sourceWorkSlotId: facts.sourceWorkSlotId,
    sourceReviewRevisionHash: facts.sourceRevision.reviewRevisionHash,
    checkoutTreeOid: facts.sourceRevision.checkoutTreeOid,
    gatewayPolicyVersion: facts.gatewayPolicyVersion,
    gatewayBinaryHash: facts.gatewayBinaryHash,
    confinementProofHash: facts.confinementProofHash,
  });
}

function gatewaySeedIdentity(
  facts: Pick<
    GatewaySession,
    | "attemptId"
    | "openingIntentHash"
    | "sourceLeaseAuthorityKind"
    | "sourceLeaseId"
    | "sourceFencingToken"
  >,
): string {
  if (
    facts.sourceLeaseAuthorityKind ===
    ContextLeaseAuthorityKind.StandardExecution
  ) {
    return canonicalJson({
      domain: gatewaySeedDomain,
      attemptId: facts.attemptId,
      openingIntentHash: facts.openingIntentHash,
      sourceLeaseId: facts.sourceLeaseId,
      sourceFencingToken: facts.sourceFencingToken,
    });
  }
  return canonicalJson({
    domain: "rr.investigation-context-gateway-seed.v1",
    sourceLeaseAuthorityKind: facts.sourceLeaseAuthorityKind,
    attemptId: facts.attemptId,
    openingIntentHash: facts.openingIntentHash,
    sourceLeaseId: facts.sourceLeaseId,
    sourceFencingToken: facts.sourceFencingToken,
  });
}

function openingIntentIdentity(
  authorityKind: ContextLeaseAuthorityKind,
  idempotencyKey: string,
): string {
  if (authorityKind === ContextLeaseAuthorityKind.StandardExecution) {
    return canonicalJson({
      domain: "rr.context-gateway-opening-intent.v1",
      idempotencyKey,
    });
  }
  return canonicalJson({
    domain: "rr.investigation-context-gateway-opening-intent.v1",
    sourceLeaseAuthorityKind: authorityKind,
    idempotencyKey,
  });
}

function deriveGatewaySessionSecret(
  masterKey: Uint8Array,
  identity: string,
): Buffer {
  return createHmac("sha256", masterKey)
    .update(gatewaySecretDomain)
    .update("\0")
    .update(identity)
    .digest();
}

function replayMaterialAssociatedData(session: GatewaySession): string {
  if (
    session.sourceLeaseAuthorityKind ===
    ContextLeaseAuthorityKind.StandardExecution
  ) {
    return canonicalJson({
      associatedDataVersion: 1,
      sessionId: session.sessionId,
      sourceExecutionId: session.sourceExecutionId,
      sourceWorkSlotId: session.sourceWorkSlotId,
      sourceReviewRevisionHash: session.sourceRevision.reviewRevisionHash,
      checkoutTreeOid: session.sourceRevision.checkoutTreeOid,
      gatewayPolicyVersion: session.gatewayPolicyVersion,
      gatewayBinaryHash: session.gatewayBinaryHash,
      confinementProofHash: session.confinementProofHash,
    });
  }
  return canonicalJson({
    associatedDataVersion: 2,
    sessionId: session.sessionId,
    sourceExecutionId: session.sourceExecutionId,
    sourceLeaseAuthorityKind: session.sourceLeaseAuthorityKind,
    sourceWorkSlotId: session.sourceWorkSlotId,
    sourceReviewRevisionHash: session.sourceRevision.reviewRevisionHash,
    checkoutTreeOid: session.sourceRevision.checkoutTreeOid,
    gatewayPolicyVersion: session.gatewayPolicyVersion,
    gatewayBinaryHash: session.gatewayBinaryHash,
    confinementProofHash: session.confinementProofHash,
  });
}

async function requireAuthorization(
  token: string,
  d: ReviewActionV2ContextAttestationHandlerDependencies,
): Promise<ReviewRunAuthorization> {
  let result: ReviewRunAuthorizationTokenResolution;
  try {
    result = await d.authorizations.resolveReviewRunAuthorizationToken({
      token,
    });
  } catch {
    throw failure(
      401,
      ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      "authorization_token_invalid",
    );
  }
  if (result.status !== ReviewRunAuthorizationTokenResolutionStatus.Valid) {
    throw failure(
      result.status === ReviewRunAuthorizationTokenResolutionStatus.Expired ||
        result.status === ReviewRunAuthorizationTokenResolutionStatus.Revoked
        ? 410
        : 401,
      result.status === ReviewRunAuthorizationTokenResolutionStatus.Expired ||
        result.status === ReviewRunAuthorizationTokenResolutionStatus.Revoked
        ? ReviewActionV2ProtocolErrorCode.ResourceGone
        : ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      `authorization_${result.status}`,
    );
  }
  if (
    result.authorization.state !== ReviewRunAuthorizationState.Active ||
    result.authorization.expiresAt <= d.now()
  ) {
    throw failure(
      410,
      ReviewActionV2ProtocolErrorCode.ResourceGone,
      "authorization_inactive",
    );
  }
  return result.authorization;
}

async function requireExecution(
  executionId: string,
  authorization: ReviewRunAuthorization,
  queries: ReviewExecutionQueryPort,
): Promise<ReviewExecutionSnapshot> {
  const snapshot = await queries.findExecution(executionId);
  if (!snapshot) {
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "execution_missing",
    );
  }
  const execution = snapshot.execution;
  if (
    execution.authorizationId !== authorization.authorizationId ||
    execution.workspaceId !== authorization.workspaceId ||
    execution.repositoryConnectionId !== authorization.repositoryConnectionId ||
    execution.scmRepositoryIdentityId !==
      authorization.scmRepositoryIdentityId ||
    execution.pullRequestNumber !== authorization.pullRequestNumber ||
    execution.revision.reviewRevisionHash !== authorization.reviewRevisionHash
  ) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "execution_authorization_mismatch",
    );
  }
  return snapshot;
}

async function verifyLeaseCapability(
  token: string,
  now: Date,
  d: ReviewActionV2ContextAttestationHandlerDependencies,
) {
  try {
    return await d.capabilities.verifyLease(token, now);
  } catch {
    throw failure(
      401,
      ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      "lease_capability_invalid",
    );
  }
}

async function assertBodyHash<O extends ReviewActionV2OperationId>(
  operation: O,
  request: ReviewActionV2RequestMap[O],
  digest: ReviewActionV2ContextDigestPort,
) {
  if (
    (await digest.digestUtf8(
      canonicalizeReviewActionV2Request(operation, request),
    )) !== (request as { requestBodyHash?: string }).requestBodyHash
  ) {
    throw failure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      "request_body_hash_mismatch",
    );
  }
}

async function authorizationScopeHash(
  authorization: ReviewRunAuthorization,
  digest: ReviewActionV2ContextDigestPort,
) {
  return digest.digestUtf8(
    canonicalJson({
      workspaceId: authorization.workspaceId,
      repositoryConnectionId: authorization.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      pullRequestNumber: authorization.pullRequestNumber,
    }),
  );
}

async function hashReplayProof(
  proof: TargetReplayProof,
  digest: ReviewActionV2ContextDigestPort,
) {
  return digest.digestUtf8(
    canonicalJson({
      replayProofId: proof.replayProofId,
      sourceAttestationId: proof.sourceAttestationId,
      sourceAttestationHash: proof.sourceAttestationHash,
      sourceOperationReceiptIdsHash: proof.sourceOperationReceiptIdsHash,
      targetExecutionId: proof.targetExecutionId,
      targetWorkSlotId: proof.targetWorkSlotId,
      targetReviewRevisionHash: proof.targetReviewRevisionHash,
      targetCheckoutTreeOid: proof.targetCheckoutTreeOid,
      replayBinaryHash: proof.replayBinaryHash,
      replayPolicyVersion: proof.replayPolicyVersion,
      reusePolicyVectorHash: proof.reusePolicyVectorHash,
      createdAtMs: proof.createdAtMs,
      expiresAtMs: proof.expiresAtMs,
    }),
  );
}

function contextIdentities(
  d: ReviewActionV2ContextAttestationHandlerDependencies,
) {
  return {
    nextGatewaySessionId: () => d.nextId("gateway_session"),
    nextAttestationId: () => d.nextId("attestation"),
    nextReplayProofId: () => d.nextId("replay_proof"),
  };
}

function mapOpenStatus(status: OpenContextGatewaySessionStatus) {
  switch (status) {
    case OpenContextGatewaySessionStatus.Opened:
      return ReviewContextGatewayOpenResultStatus.Opened;
    case OpenContextGatewaySessionStatus.Idempotent:
      return ReviewContextGatewayOpenResultStatus.Idempotent;
    case OpenContextGatewaySessionStatus.Denied:
      return ReviewContextGatewayOpenResultStatus.Denied;
    case OpenContextGatewaySessionStatus.Conflict:
      return ReviewContextGatewayOpenResultStatus.Conflict;
  }
}

function mapSealStatus(status: AcceptSealedContextAttestationStatus) {
  switch (status) {
    case AcceptSealedContextAttestationStatus.Accepted:
      return ReviewContextGatewaySealResultStatus.Accepted;
    case AcceptSealedContextAttestationStatus.Idempotent:
      return ReviewContextGatewaySealResultStatus.Idempotent;
    case AcceptSealedContextAttestationStatus.Denied:
      return ReviewContextGatewaySealResultStatus.Denied;
    case AcceptSealedContextAttestationStatus.Conflict:
      return ReviewContextGatewaySealResultStatus.Conflict;
  }
}

function mapAbandonStatus(status: AbandonContextGatewaySessionStatus) {
  switch (status) {
    case AbandonContextGatewaySessionStatus.Abandoned:
      return ReviewContextGatewayAbandonResultStatus.Abandoned;
    case AbandonContextGatewaySessionStatus.Idempotent:
      return ReviewContextGatewayAbandonResultStatus.Idempotent;
    case AbandonContextGatewaySessionStatus.AlreadyTerminal:
      return ReviewContextGatewayAbandonResultStatus.AlreadyTerminal;
    case AbandonContextGatewaySessionStatus.Expired:
      return ReviewContextGatewayAbandonResultStatus.Expired;
    case AbandonContextGatewaySessionStatus.Denied:
      return ReviewContextGatewayAbandonResultStatus.Denied;
    case AbandonContextGatewaySessionStatus.Conflict:
      return ReviewContextGatewayAbandonResultStatus.Conflict;
  }
}

function mapReplayStatus(status: ReplayContextAttestationStatus) {
  switch (status) {
    case ReplayContextAttestationStatus.Accepted:
      return ReviewContextReplayCommitResultStatus.Accepted;
    case ReplayContextAttestationStatus.Idempotent:
      return ReviewContextReplayCommitResultStatus.Idempotent;
    case ReplayContextAttestationStatus.Denied:
      return ReviewContextReplayCommitResultStatus.Denied;
    case ReplayContextAttestationStatus.Conflict:
      return ReviewContextReplayCommitResultStatus.Conflict;
  }
}

function replayDenied() {
  return {
    statusCode: 200 as const,
    result: {
      status: ReviewContextReplayCommitResultStatus.Denied,
      replayProofId: null,
      replayProofHash: null,
      attachmentCapability: null,
    },
  };
}

function mapReceiptReplayStatus(status: ReplayContextAttestationStatus) {
  switch (status) {
    case ReplayContextAttestationStatus.Accepted:
      return ReviewContextReceiptReplayCommitResultStatus.Accepted;
    case ReplayContextAttestationStatus.Idempotent:
      return ReviewContextReceiptReplayCommitResultStatus.Idempotent;
    case ReplayContextAttestationStatus.Denied:
      return ReviewContextReceiptReplayCommitResultStatus.Denied;
    case ReplayContextAttestationStatus.Conflict:
      return ReviewContextReceiptReplayCommitResultStatus.Conflict;
  }
}

function receiptReplayDenied() {
  return {
    statusCode: 200 as const,
    result: {
      status: ReviewContextReceiptReplayCommitResultStatus.Denied,
      replayProofId: null,
      replayProofHash: null,
    },
  };
}

function validateConfig(
  d: ReviewActionV2ContextAttestationHandlerDependencies,
): void {
  if (
    d.sessionSecretKey.byteLength !== 32 ||
    [
      d.config.sessionLifetimeMs,
      d.config.reuseTtlMs,
      d.config.replayProofLifetimeMs,
      d.config.replayCapabilityLifetimeMs,
      d.config.attachmentCapabilityLifetimeMs,
    ].some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new Error("review_context_attestation_config_invalid");
  }
}

function evidenceProviderKind(value: string): ReviewProviderKind {
  if (value === ReviewProviderKind.Codex) return ReviewProviderKind.Codex;
  if (value === ReviewProviderKind.ClaudeCode)
    return ReviewProviderKind.ClaudeCode;
  if (value === ReviewProviderKind.OpenRouter)
    return ReviewProviderKind.OpenRouter;
  throw failure(
    422,
    ReviewActionV2ProtocolErrorCode.InvariantViolation,
    "context_provider_unknown",
  );
}

function contextProviderKind(value: ReviewProviderKind): ContextProviderKind {
  switch (value) {
    case ReviewProviderKind.Codex:
      return ContextProviderKind.Codex;
    case ReviewProviderKind.ClaudeCode:
      return ContextProviderKind.ClaudeCode;
    case ReviewProviderKind.OpenRouter:
      return ContextProviderKind.OpenRouter;
    default:
      throw failure(
        422,
        ReviewActionV2ProtocolErrorCode.InvariantViolation,
        "context_provider_unknown",
      );
  }
}

async function findPreparedLeaseForObservation(
  observation: ReviewObservation,
  d: ReviewActionV2ContextAttestationHandlerDependencies,
) {
  return d.executionQueries.findLease(observation.sourceLeaseId);
}

async function requireHash(
  canonicalValue: string,
  expected: string,
  issue: string,
  digest: ReviewActionV2ContextDigestPort,
) {
  requireEqual(await digest.digestUtf8(canonicalValue), expected, issue);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  issue: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure(400, ReviewActionV2ProtocolErrorCode.InvalidRequest, issue);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw failure(400, ReviewActionV2ProtocolErrorCode.InvalidRequest, issue);
  }
  return value as Record<string, unknown>;
}

function invalidReplayMaterial() {
  return failure(
    422,
    ReviewActionV2ProtocolErrorCode.InvariantViolation,
    "context_replay_material_invalid",
  );
}

function transcriptChainInvalid() {
  return failure(
    422,
    ReviewActionV2ProtocolErrorCode.InvariantViolation,
    "context_transcript_hmac_chain_invalid",
  );
}

function replayChainInvalid() {
  return failure(
    422,
    ReviewActionV2ProtocolErrorCode.InvariantViolation,
    "context_replay_sha256_chain_invalid",
  );
}

function stalePolicy() {
  return failure(
    412,
    ReviewActionV2ProtocolErrorCode.StalePrecondition,
    "context_reuse_policy_vector_stale",
  );
}

function requireEqual(actual: unknown, expected: unknown, issue: string): void {
  if (actual !== expected) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      issue,
    );
  }
}

function requiredString(value: string | undefined, issue: string): string {
  if (!value) {
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      issue,
    );
  }
  return value;
}

function failure(
  statusCode: 400 | 401 | 403 | 404 | 410 | 412 | 422,
  code: ReviewActionV2ProtocolErrorCode,
  issue: string | readonly string[],
) {
  return new ReviewActionV2RouteFailure(
    statusCode,
    code,
    typeof issue === "string" ? [issue] : [...issue],
  );
}

function compactIssues(
  issues: readonly (string | null | undefined)[],
): readonly string[] {
  return issues.filter((issue): issue is string => Boolean(issue));
}

function safeContextManifestIssue(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const message = error.message;
  if (isContextGatewayV4ValidationIssue(message)) return message;
  if (
    /^(?:context_dependency|context_git|text_search|file_read|directory|git_fact|gateway|checkout_tree|authenticated_event_chain|previous_event|event)_[a-z0-9_]+$/.test(
      message,
    )
  ) {
    return message;
  }
  return null;
}

function hmacHex(key: Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameHex(left: string, right: string): boolean {
  return (
    /^[a-f0-9]{64}$/.test(left) &&
    /^[a-f0-9]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function minDate(...dates: readonly Date[]): Date {
  return new Date(Math.min(...dates.map((date) => date.getTime())));
}

function requiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (!value) throw new Error(`review_context_config_missing:${name}`);
  return value;
}

function readBase64Key(value: string, issue: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(issue);
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength !== 32 ||
    decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")
  ) {
    throw new Error(issue);
  }
  return new Uint8Array(decoded);
}

function exactConfigRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("review_context_replay_keys_invalid");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("review_context_replay_keys_invalid");
  }
  return value as Record<string, unknown>;
}
