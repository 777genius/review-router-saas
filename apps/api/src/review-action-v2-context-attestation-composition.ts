import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  AcceptSealedContextAttestation,
  AcceptSealedContextAttestationStatus,
  ContextDependencyKind,
  ContextProviderKind,
  OpenContextGatewaySession,
  OpenContextGatewaySessionStatus,
  ReplayContextAttestation,
  ReplayContextAttestationStatus,
  TargetReplayProofVerificationStatus,
  VerifyTargetReplayProof,
  canonicalContextDependencyManifest,
  canonicalContextDependencyOperation,
  canonicalContextDependencyResult,
  createContextDependencyManifest,
  type ContextAttestationStorePort,
  type ContextDependencyManifest,
  type ContextReplayMaterialCipherPort,
  type GatewaySession,
  type TargetReplayProof,
} from "@reviewrouter/features-review-context-attestation";
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
  stableJson,
  type CurrentReviewReusePolicyPort,
  type ProviderInvocationManifest,
  type ReviewObservation,
  type ReviewObservationQueryPort,
  type ReviewTrustDomain,
} from "@reviewrouter/features-review-evidence";
import {
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
  ReviewContextGatewayOpenResultStatus,
  ReviewContextGatewaySealResultStatus,
  ReviewContextReplayCommitResultStatus,
  canonicalizeReviewContextConfinementEvidence,
  canonicalizeReviewContextGatewayEvent,
  canonicalizeReviewContextReplayChainSeed,
  canonicalizeReviewContextReplayEvent,
  canonicalizeReviewContextReplayHandle,
  canonicalizeReviewContextSearchQuery,
  canonicalizeReviewActionV2Request,
  type ReviewActionV2RequestMap,
  type ReviewContextGatewayOpenRequest,
  type ReviewContextGatewaySealRequest,
  type ReviewContextReplayCommitRequest,
} from "@reviewrouter/protocol-review-action-v2";
import {
  type ReviewActionV2ContextReplayAuthority,
  type ReviewActionV2ExecutionEvidenceCapabilityAdapter,
  type ReviewActionV2ReusableAttachmentAuthority,
  type VerifiedReviewActionV2LeaseCapability,
} from "./review-action-v2-execution-evidence-capabilities.js";

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

export type ReviewActionV2ContextAttestationHandlerDependencies = Readonly<{
  authorizations: ReviewActionV2ContextAuthorizationResolverPort;
  executionQueries: ReviewExecutionQueryPort;
  observations: ReviewObservationQueryPort;
  reusePolicy: CurrentReviewReusePolicyPort;
  store: ContextAttestationStorePort;
  cipher: ContextReplayMaterialCipherPort;
  capabilities: ReviewActionV2ExecutionEvidenceCapabilityAdapter;
  digest: ReviewActionV2ContextDigestPort;
  checkoutTrees: ReviewActionV2CheckoutTreeResolverPort;
  producerReleases: ReviewActionV2ProducerReleaseProfilePort;
  now: () => Date;
  nextId: (kind: "gateway_session" | "attestation" | "replay_proof") => string;
  sessionSecretKey: Uint8Array;
  config: ReviewActionV2ContextAttestationConfig;
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
      openGateway(request, handlers),
    ),
    sealGateway: enabled((request: ReviewContextGatewaySealRequest) =>
      sealGateway(request, handlers),
    ),
    commitReplay: enabled((request: ReviewContextReplayCommitRequest) =>
      commitReplay(request, handlers),
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

function enabled<Request, Result>(
  execute: (request: Request) => Promise<Result>,
) {
  return { capabilityEnabled: true as const, execute };
}

async function openGateway(
  request: ReviewContextGatewayOpenRequest,
  d: ReviewActionV2ContextAttestationHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewContextGatewayOpen,
    request,
    d.digest,
  );
  const now = d.now();
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  const snapshot = await requireExecution(
    request.sourceExecutionId,
    authorization,
    d.executionQueries,
  );
  const authority = await verifyLeaseCapability(
    request.leaseCapability,
    now,
    d,
  );
  const lease = await requireBoundLease({
    authority,
    authorization,
    snapshot,
    leaseId: request.sourceLeaseId,
    workSlotId: request.sourceWorkSlotId,
    attemptId: request.attemptId,
    fencingToken: request.fencingToken,
    requireOwnership: true,
    now,
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
    snapshot,
    lease,
    dependencies: d,
  });
  const sessionSecret = deriveGatewaySessionSecret(
    d.sessionSecretKey,
    gatewaySecretIdentity(facts),
  );
  const eventChainSeedHash = hmacHex(
    sessionSecret,
    canonicalJson({
      domain: gatewaySeedDomain,
      attemptId: facts.attemptId,
      sourceLeaseId: facts.sourceLeaseId,
      sourceFencingToken: facts.sourceFencingToken,
    }),
  );
  const open = new OpenContextGatewaySession({
    openingFacts: {
      resolveOpeningFacts: async (command) =>
        command.attemptId === facts.attemptId &&
        command.leaseCapabilityId === authority.capabilityId &&
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
    leaseCapabilityId: authority.capabilityId,
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
  const sealCapability = await d.capabilities.issueContextGatewaySeal(
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
  request: ReviewContextGatewaySealRequest,
  d: ReviewActionV2ContextAttestationHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewContextGatewaySeal,
    request,
    d.digest,
  );
  const now = d.now();
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  const leaseAuthority = await verifyLeaseCapability(
    request.leaseCapability,
    now,
    d,
  );
  const snapshot = await requireExecution(
    leaseAuthority.executionId,
    authorization,
    d.executionQueries,
  );
  await requireBoundLease({
    authority: leaseAuthority,
    authorization,
    snapshot,
    leaseId: request.sourceLeaseId,
    workSlotId: leaseAuthority.workSlotId,
    attemptId: request.attemptId,
    fencingToken: request.fencingToken,
    requireOwnership: false,
    now,
    dependencies: d,
  });
  let sealAuthority;
  try {
    sealAuthority = await d.capabilities.verifyContextGatewaySeal(
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
    leaseAuthority,
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
  requireEqual(
    request.actualModel,
    session.requestedModel,
    "context_actual_model_mismatch",
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
  readonly request: ReviewContextGatewayOpenRequest;
  readonly authorization: ReviewRunAuthorization;
  readonly snapshot: ReviewExecutionSnapshot;
  readonly lease: ReviewInvocationLease;
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
  } catch {
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "context_manifest_invalid",
    );
  }
  if (manifest.executionProfile !== ProviderExecutionProfile.ContextGatewayV1) {
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
    canonicalizeReviewContextConfinementEvidence({
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

async function assertSealAuthority(input: {
  readonly request: ReviewContextGatewaySealRequest;
  readonly authorization: ReviewRunAuthorization;
  readonly leaseAuthority: VerifiedReviewActionV2LeaseCapability;
  readonly sealAuthority: Awaited<
    ReturnType<
      ReviewActionV2ExecutionEvidenceCapabilityAdapter["verifyContextGatewaySeal"]
    >
  >;
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
  let manifest: ContextDependencyManifest;
  try {
    manifest = createContextDependencyManifest(JSON.parse(value));
  } catch {
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      issue,
    );
  }
  if (canonicalContextDependencyManifest(manifest) !== value) {
    throw failure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      `${issue}_not_canonical`,
    );
  }
  return manifest;
}

type ReplayMaterial = Readonly<{
  materialVersion: typeof replayMaterialVersion;
  sourceDependencies: readonly Readonly<{
    sequence: number;
    operationKey: string;
    replayQuery: string | null;
  }>[];
}>;

function parseReplayMaterial(
  value: string,
  manifest: ContextDependencyManifest,
  session: GatewaySession,
  sessionSecret: Buffer,
): ReplayMaterial & { readonly canonicalJson: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidReplayMaterial();
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

function verifyGatewayTranscript(
  session: GatewaySession,
  manifest: ContextDependencyManifest,
  sessionSecret: Buffer,
): void {
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
  return canonicalJson({
    attemptId: facts.attemptId,
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
  issue: string,
) {
  return new ReviewActionV2RouteFailure(statusCode, code, [issue]);
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
