import {
  AbortInvestigationTurn,
  AcquireInvestigationLease,
  CommitAttestedInvestigationTurn,
  CommitInvestigationTurn,
  ConcludeReviewInvestigation,
  ContextCriticDecision,
  InvestigationExecutionAuthorityVerdict,
  InvestigationOperationKind,
  InvestigationOperationRevision,
  InvestigationFileContentKind,
  InvestigationFindingSeverity,
  InvestigationTurnProviderKind,
  HydrateInvestigationTurnObligations,
  OpenReviewInvestigation,
  PlanNextInvestigationTurn,
  PrepareInvestigationSearchQueryPrivateMaterial,
  ResolveInvestigationSearchQueryPrivateMaterial,
  PrepareReviewInvestigationReplay,
  ReplayReviewInvestigation,
  ReconcileExpiredActiveTurn,
  ReleaseInvestigationLease,
  RenewInvestigationLease,
  RestoreReviewInvestigation,
  ReviewInvestigationAbortReason,
  ReviewInvestigationConclusion,
  ReviewInvestigationNextActionKind,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationDomainError,
  ReviewInvestigationState,
  ReviewInvestigationTurnPurpose,
  InvestigationLeaseAcquireStatus,
  ReviewInvestigationLeaseProtectedOperation,
  ReviewInvestigationLeaseState,
  ReviewInvestigationLeaseTransitionStatus,
  assertReviewInvestigationLeaseAllows,
  reviewInvestigationLeaseBindingIsCurrent,
  assertSupportedReviewInvestigationCoverageProfile,
  canonicalInvestigationTurnObservation,
  maximumSemanticRiskPriority,
  parseInvestigationEvidenceRequirement,
  requiresInvestigationSearchQueryPrivateMaterial,
  parseInvestigationTurnObservation,
  type InvestigationClockPort,
  type InvestigationExecutionAuthorityPort,
  type InvestigationPrivateMaterialCipherPort,
  type InvestigationPrivateMaterialStorePort,
  type InvestigationStorePort,
  type InvestigationLeaseQueryPort,
  type InvestigationLeaseStorePort,
  type ReviewInvestigationLease,
  type InvestigationReceiptReplayPort,
  type InvestigationReplayPreparationPort,
  type InvestigationTurnEvidencePort,
  type InvestigationTerminalProjectionPort,
  type ReviewInvestigation,
  type ReviewInvestigationRevision,
  type ReviewInvestigationScope,
  type ReviewInvestigationContract,
  type ReviewInvestigationPolicy,
  type ReviewInvestigationReadModel,
  type InvestigationEvidenceReceipt,
} from "@reviewrouter/features-review-investigations";
import {
  InvestigationShadowEvidenceConclusion,
  InvestigationShadowEvidenceCriticDecision,
  ProviderExecutionProfile,
  ReviewFindingSeverity,
  ReviewProviderKind as EvidenceProviderKind,
  ReviewTaskKind as EvidenceTaskKind,
  ReviewTrustDomain as EvidenceTrustDomain,
  canonicalizeProviderInvocationManifest,
  normalizeProviderInvocationManifest,
  buildProviderInvocationIdentity,
  serializeProviderInvocationManifestCanonicalWireJson,
  reviewEvidencePayloadVersion,
  prepareReviewObservationPayload,
  type InvestigationShadowEvidenceProjectionSource,
  type ProjectInvestigationShadowEvidence,
} from "@reviewrouter/features-review-evidence";
import { NodeSha256InvestigationDigest } from "@reviewrouter/features-review-investigations/composition";
import {
  ContextGatewayV4OperationKind,
  ContextGatewayV4OutcomeKind,
  ContextLeaseAuthorityKind,
  ContextProviderKind,
  GatewaySessionState,
  contextGatewayV4PolicyVersion,
  type ContextGatewayV4Manifest,
} from "@reviewrouter/features-review-context-attestation";
import type { ContextAttestationStorePort } from "@reviewrouter/features-review-context-attestation";
import {
  ReviewExecutionProviderKind,
  ReviewExecutionState,
  ReviewInvocationLeasePurpose,
  ReviewInvocationLeaseState,
  ReviewTaskKind as ExecutionTaskKind,
  ReviewWorkSlotState,
  type ReviewExecutionQueryPort,
  type ReviewExecutionSnapshot,
} from "@reviewrouter/features-review-executions";
import {
  InvestigationRolloutCapability,
  InvestigationRolloutProvider,
} from "@reviewrouter/features-review-investigation-operations";
import {
  ReviewRunAuthorizationState,
  ReviewRunAuthorizationTokenResolutionStatus,
  canonicalJson,
  type ReviewRunAuthorization,
  type ReviewRunAuthorizationQueryPort,
  type ReviewRunAuthorizationTokenResolution,
  type ProducerReleaseQueryPort,
  ProducerReleaseState,
  reviewInvestigationCapabilityV1,
} from "@reviewrouter/features-review-run-control";
import {
  ReviewActionV2RouteFailure,
  type ReviewActionV2RouteFailureStatus,
  type RegisterReviewInvestigationV2RoutesDependencies,
} from "@reviewrouter/features-action-control-plane/v2";
import {
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
  ReviewInvestigationMutationResultStatus,
  ReviewInvestigationLeaseResultStatus,
  ReviewInvestigationNextAction,
  ReviewInvestigationOpenResultStatus,
  ReviewInvestigationReplayPrepareResultStatus,
  ReviewInvestigationPublishedRuntimeProfile,
  ReviewInvestigationPublishedConclusion,
  ReviewInvestigationPublishedState,
  ReviewInvestigationRestoreResultStatus,
  canonicalizeReviewActionV2Request,
  type ReviewActionV2RequestMap,
  type ReviewInvestigationConcludeRequest,
  type ReviewInvestigationLeaseAcquireRequest,
  type ReviewInvestigationLeaseReleaseRequest,
  type ReviewInvestigationLeaseRenewRequest,
  type ReviewInvestigationOpenRequest,
  type ReviewInvestigationOpenV2Request,
  type ReviewInvestigationRestoreRequest,
  type ReviewInvestigationReplayRequest,
  type ReviewInvestigationReplayV2Request,
  type ReviewInvestigationReplayPrepareRequest,
  type ReviewInvestigationTurnAbortRequest,
  type ReviewInvestigationTurnCommitRequest,
  type ReviewInvestigationTurnPlanRequest,
} from "@reviewrouter/protocol-review-action-v2";
import type {
  ReviewActionV2AuthorizationResolverPort,
  ReviewActionV2DigestPort,
} from "./review-action-v2-execution-evidence-composition.js";
import type {
  ReviewActionV2ExecutionEvidenceCapabilityAdapter,
  VerifiedReviewActionV2InvestigationTurnCapability,
} from "./review-action-v2-execution-evidence-capabilities.js";
import type { ReviewInvestigationRolloutGuardPort } from "./review-investigation-rollout-guard.js";
import type {
  ReviewActionV2InvestigationLeaseCapabilityPort,
  VerifiedReviewActionV2InvestigationLeaseCapability,
} from "./review-action-v2-investigation-lease-capabilities.js";
import {
  parseReviewInvestigationSeedEnvelope,
  type ReviewInvestigationSeedEnvelope,
} from "./review-investigation-seed-envelope.js";
import {
  hasAuthorizedReviewInvestigationExtension,
  type ReviewInvestigationAuthorizedProviderKind,
} from "./review-action-v2-investigation-extension-admission.js";

export type ReviewInvestigationUseCases = Readonly<{
  open: OpenReviewInvestigation;
  restore: RestoreReviewInvestigation;
  planTurn: PlanNextInvestigationTurn;
  acquireLease: AcquireInvestigationLease;
  renewLease: RenewInvestigationLease;
  releaseLease: ReleaseInvestigationLease;
  commitTurn: CommitAttestedInvestigationTurn;
  abortTurn: AbortInvestigationTurn;
  conclude: ConcludeReviewInvestigation;
  replay: ReplayReviewInvestigation;
  prepareReplay: (
    preparation: InvestigationReplayPreparationPort,
  ) => PrepareReviewInvestigationReplay;
  hydrateTurnObligations: HydrateInvestigationTurnObligations | null;
}>;

export interface ReviewInvestigationTerminalTelemetryPort {
  recordConcluded(input: { readonly investigationId: string }): Promise<void>;
}

export type ReviewActionV2InvestigationHandlerDependencies = Readonly<{
  authorizations: ReviewActionV2AuthorizationResolverPort;
  authorizationQueries: ReviewRunAuthorizationQueryPort;
  executionQueries: ReviewExecutionQueryPort;
  producerReleases?: ProducerReleaseQueryPort;
  investigations: ReviewInvestigationUseCases;
  investigationLeaseQueries: InvestigationLeaseQueryPort;
  capabilities: ReviewActionV2ExecutionEvidenceCapabilityAdapter;
  investigationLeaseCapabilities: ReviewActionV2InvestigationLeaseCapabilityPort;
  digest: ReviewActionV2DigestPort;
  now: () => Date;
  rollout: ReviewInvestigationRolloutGuardPort;
  terminalShadowEvidence: Pick<ProjectInvestigationShadowEvidence, "execute">;
  terminalTelemetry?: ReviewInvestigationTerminalTelemetryPort;
  crossRevisionReplayEnabled: boolean;
  nextInvestigationLeaseId: () => string;
  nextInvestigationAttemptId: () => string;
  investigationLeaseTiming: Readonly<{
    initialLeaseDurationMs: number;
    renewLeaseDurationMs: number;
    retentionDurationMs: number;
  }>;
  replayPreparation: (input: {
    readonly authorization: ReviewRunAuthorization;
    readonly snapshot: ReviewExecutionSnapshot;
    readonly workSlotId: string;
    readonly manifest: ReturnType<typeof normalizeProviderInvocationManifest>;
    readonly providerVoteIdentityHash: string;
  }) => InvestigationReplayPreparationPort;
}>;

async function computeProviderManifestKey(
  digest: Pick<ReviewActionV2DigestPort, "digestUtf8">,
  manifestCanonicalJson: string,
): Promise<string> {
  return digest.digestUtf8(
    Buffer.from(
      canonicalizeProviderInvocationManifest(
        normalizeProviderInvocationManifest(JSON.parse(manifestCanonicalJson)),
      ),
    ).toString("utf8"),
  );
}

export function composeReviewInvestigationUseCases(input: {
  readonly store: InvestigationStorePort;
  readonly leases: InvestigationLeaseStorePort;
  readonly authority: InvestigationExecutionAuthorityPort;
  readonly evidence: InvestigationTurnEvidencePort;
  readonly clock: InvestigationClockPort;
  readonly terminalProjection: InvestigationTerminalProjectionPort;
  readonly receiptReplay: InvestigationReceiptReplayPort;
  readonly privateMaterial?: Readonly<{
    store: InvestigationPrivateMaterialStorePort;
    cipher: InvestigationPrivateMaterialCipherPort;
    ttlMs: number;
  }>;
}): ReviewInvestigationUseCases {
  const digest = new NodeSha256InvestigationDigest();
  const manifestIdentity = Object.freeze({
    computeManifestKey: async (manifestCanonicalJson: string) =>
      computeProviderManifestKey(digest, manifestCanonicalJson),
  });
  const privateMaterialPreparer = input.privateMaterial
    ? new PrepareInvestigationSearchQueryPrivateMaterial(
        input.privateMaterial.cipher,
        digest,
        input.privateMaterial.ttlMs,
      )
    : undefined;
  const hydrateTurnObligations = input.privateMaterial
    ? new HydrateInvestigationTurnObligations(
        input.privateMaterial.store,
        input.privateMaterial.cipher,
        digest,
        input.clock,
      )
    : null;
  const resolvePrivateQuery = input.privateMaterial
    ? new ResolveInvestigationSearchQueryPrivateMaterial(
        input.privateMaterial.store,
        input.privateMaterial.cipher,
        digest,
        input.clock,
      )
    : undefined;
  const commit = new CommitInvestigationTurn(
    input.store,
    input.authority,
    digest,
    input.clock,
    privateMaterialPreparer,
  );
  const expiredTurns = new ReconcileExpiredActiveTurn(
    input.store,
    input.authority,
    digest,
    input.clock,
  );
  return Object.freeze({
    open: new OpenReviewInvestigation(
      input.store,
      input.authority,
      digest,
      manifestIdentity,
      input.clock,
      undefined,
      privateMaterialPreparer,
    ),
    restore: new RestoreReviewInvestigation(input.store, digest, expiredTurns),
    planTurn: new PlanNextInvestigationTurn(
      input.store,
      input.authority,
      digest,
      input.clock,
      expiredTurns,
    ),
    acquireLease: new AcquireInvestigationLease(
      input.store,
      input.leases,
      input.authority,
      digest,
      manifestIdentity,
      input.clock,
    ),
    renewLease: new RenewInvestigationLease(
      input.store,
      input.leases,
      input.authority,
      digest,
      input.clock,
    ),
    releaseLease: new ReleaseInvestigationLease(
      input.leases,
      digest,
      input.clock,
    ),
    commitTurn: new CommitAttestedInvestigationTurn(
      input.store,
      input.evidence,
      digest,
      commit,
      undefined,
      undefined,
      resolvePrivateQuery,
    ),
    abortTurn: new AbortInvestigationTurn(input.store, digest, input.clock),
    conclude: new ConcludeReviewInvestigation(
      input.store,
      input.authority,
      digest,
      input.clock,
      input.terminalProjection,
    ),
    replay: new ReplayReviewInvestigation(
      input.store,
      input.authority,
      input.receiptReplay,
      digest,
      manifestIdentity,
      input.clock,
      undefined,
      privateMaterialPreparer,
    ),
    prepareReplay: (preparation) =>
      new PrepareReviewInvestigationReplay(
        input.store,
        input.authority,
        preparation,
        input.clock,
      ),
    hydrateTurnObligations,
  });
}

export class ReviewEvidenceInvestigationTerminalProjection implements InvestigationTerminalProjectionPort {
  constructor(private readonly digest: ReviewActionV2DigestPort) {}

  async project(investigation: ReviewInvestigation) {
    const conclusion =
      investigation.conclusion ??
      (investigation.findings.length > 0
        ? ReviewInvestigationConclusion.Findings
        : ReviewInvestigationConclusion.VerifiedClean);
    const prepared = prepareReviewObservationPayload({
      payloadVersion: reviewEvidencePayloadVersion,
      normalizedFindings: investigation.findings.map((finding) => ({
        category: "review_investigation",
        normalizedFailureModeHash: finding.fingerprint,
        severity: findingSeverity(finding.severity),
        title: finding.title,
        message: finding.body,
        evidence: [...finding.evidenceReceiptIds],
        path: finding.path,
        startLine: finding.line,
        endLine: finding.line,
        placementConfidence: finding.line === null ? null : 1,
        suggestion: null,
      })),
      normalizedLifecycleRevalidations: [],
      safeUsage: {
        inputTokens: null,
        outputTokens: null,
        totalTokens: investigation.totalUsageTokens,
      },
    });
    const canonicalJson = new TextDecoder().decode(prepared.canonicalBytes);
    return Object.freeze({
      canonicalJson,
      terminalOutcomeHash: await this.digest.digest(prepared.canonicalBytes),
      conclusion,
    });
  }
}

function findingSeverity(
  value: InvestigationFindingSeverity,
): ReviewFindingSeverity {
  switch (value) {
    case InvestigationFindingSeverity.Critical:
      return ReviewFindingSeverity.Critical;
    case InvestigationFindingSeverity.Major:
      return ReviewFindingSeverity.Major;
    case InvestigationFindingSeverity.Minor:
      return ReviewFindingSeverity.Minor;
  }
}

export function composeReviewActionV2InvestigationRoutes(input: {
  readonly enabled: boolean;
  readonly runtime: Pick<
    RegisterReviewInvestigationV2RoutesDependencies,
    "readServerTime" | "createRequestId"
  >;
  readonly handlers?: ReviewActionV2InvestigationHandlerDependencies;
}): RegisterReviewInvestigationV2RoutesDependencies {
  if (!input.enabled) return input.runtime;
  if (!input.handlers) {
    throw new Error("review_investigation_dependencies_unavailable");
  }
  const d = input.handlers;
  return {
    ...input.runtime,
    open: enabled((request: ReviewInvestigationOpenRequest) =>
      open(request, d, ReviewActionV2OperationId.ReviewInvestigationOpen),
    ),
    openV2: enabled((request: ReviewInvestigationOpenV2Request) =>
      open(request, d, ReviewActionV2OperationId.ReviewInvestigationOpenV2),
    ),
    restore: enabled((request: ReviewInvestigationRestoreRequest) =>
      restore(request, d),
    ),
    planTurn: enabled((request: ReviewInvestigationTurnPlanRequest) =>
      planTurn(request, d),
    ),
    acquireLease: enabled((request: ReviewInvestigationLeaseAcquireRequest) =>
      acquireInvestigationLease(request, d),
    ),
    renewLease: enabled((request: ReviewInvestigationLeaseRenewRequest) =>
      renewInvestigationLease(request, d),
    ),
    releaseLease: enabled((request: ReviewInvestigationLeaseReleaseRequest) =>
      releaseInvestigationLease(request, d),
    ),
    commitTurn: enabled((request: ReviewInvestigationTurnCommitRequest) =>
      commitTurn(request, d),
    ),
    abortTurn: enabled((request: ReviewInvestigationTurnAbortRequest) =>
      abortTurn(request, d),
    ),
    replay: enabled((request: ReviewInvestigationReplayRequest) =>
      replay(request, d, ReviewActionV2OperationId.ReviewInvestigationReplay),
    ),
    replayV2: enabled((request: ReviewInvestigationReplayV2Request) =>
      replay(request, d, ReviewActionV2OperationId.ReviewInvestigationReplayV2),
    ),
    prepareReplay: enabled((request: ReviewInvestigationReplayPrepareRequest) =>
      prepareReplay(request, d),
    ),
    conclude: enabled((request: ReviewInvestigationConcludeRequest) =>
      conclude(request, d),
    ),
  };
}

export class ProductionInvestigationExecutionAuthority implements InvestigationExecutionAuthorityPort {
  constructor(
    private readonly executions: ReviewExecutionQueryPort,
    private readonly authorizations: ReviewRunAuthorizationQueryPort,
  ) {}

  async check(input: {
    readonly scope: ReviewInvestigation["scope"];
    readonly revision: ReviewInvestigation["revision"];
    readonly executionId: string;
    readonly workSlotId: string;
    readonly providerVoteLaneId: string;
  }): Promise<InvestigationExecutionAuthorityVerdict> {
    const snapshot = await this.executions.findExecution(input.executionId);
    if (!snapshot) return InvestigationExecutionAuthorityVerdict.Missing;
    const execution = snapshot.execution;
    const authorization =
      await this.authorizations.findReviewRunAuthorizationById(
        execution.authorizationId,
      );
    if (
      !authorization ||
      execution.workspaceId !== input.scope.workspaceId ||
      execution.repositoryConnectionId !== input.scope.repositoryConnectionId ||
      execution.scmRepositoryIdentityId !==
        input.scope.scmRepositoryIdentityId ||
      execution.pullRequestNumber !== input.scope.pullRequestNumber ||
      authorization.trustDomain !== input.scope.trustDomain ||
      !execution.workSlots.some(
        (slot) =>
          slot.workSlotId === input.workSlotId &&
          slot.providerVoteIdentityHash === input.providerVoteLaneId,
      )
    ) {
      return InvestigationExecutionAuthorityVerdict.Unauthorized;
    }
    if (
      execution.state !== ReviewExecutionState.Running ||
      snapshot.stream.activeExecutionId !== execution.executionId ||
      snapshot.stream.currentRevision?.reviewRevisionHash !==
        input.revision.reviewRevisionHash ||
      execution.revision.reviewRevisionHash !==
        input.revision.reviewRevisionHash ||
      execution.revision.headSha !== input.revision.headSha
    ) {
      return InvestigationExecutionAuthorityVerdict.Superseded;
    }
    return InvestigationExecutionAuthorityVerdict.Current;
  }
}

export class ProductionInvestigationTurnEvidence implements InvestigationTurnEvidencePort {
  constructor(
    private readonly store: ContextAttestationStorePort,
    private readonly now: () => Date,
  ) {}

  async verify(input: Parameters<InvestigationTurnEvidencePort["verify"]>[0]) {
    const attestation = await this.store.findAcceptedAttestation(
      input.acceptedAttestationId,
    );
    if (!attestation) return null;
    const session = await this.store.findSession(attestation.sessionId);
    const actualProviderKind = trustedInvestigationProviderKind(
      session?.providerKind ?? null,
    );
    if (
      !session ||
      session.sourceLeaseAuthorityKind !==
        ContextLeaseAuthorityKind.InvestigationShadow ||
      session.state !== GatewaySessionState.Accepted ||
      actualProviderKind === null ||
      session.sessionId !== attestation.sessionId ||
      session.sourceExecutionId !== attestation.sourceExecutionId ||
      session.sourceWorkSlotId !== attestation.sourceWorkSlotId ||
      session.sourceRevision.reviewRevisionHash !==
        attestation.sourceReviewRevisionHash ||
      session.attemptId !== attestation.attemptId ||
      session.sourceLeaseId !== attestation.sourceLeaseId ||
      session.sourceFencingToken !== attestation.sourceFencingToken ||
      attestation.attestationHash !== input.acceptedAttestationHash ||
      attestation.reuseExpiresAtMs <= this.now().getTime() ||
      attestation.sourceExecutionId !== input.sourceExecutionId ||
      attestation.sourceWorkSlotId !== input.sourceWorkSlotId ||
      attestation.sourceReviewRevisionHash !== input.sourceReviewRevisionHash ||
      attestation.attemptId !== input.attemptId ||
      attestation.sourceLeaseId !== input.sourceLeaseId ||
      attestation.sourceFencingToken !== input.sourceFencingToken ||
      attestation.actualModel !== input.actualModel ||
      attestation.terminalOutcomeHash !== input.terminalOutcomeHash ||
      attestation.manifest.gatewayPolicyVersion !==
        contextGatewayV4PolicyVersion ||
      attestation.manifest.manifestVersion !== 3
    ) {
      return null;
    }
    const manifest = attestation.manifest as ContextGatewayV4Manifest;
    const operations = manifest.events
      .filter(
        (event) =>
          event.outcome === ContextGatewayV4OutcomeKind.Succeeded &&
          event.operationReceiptId !== null,
      )
      .map(verifiedOperationEvidence);
    return Object.freeze({
      acceptedAttestationId: attestation.attestationId,
      acceptedAttestationHash: attestation.attestationHash,
      terminalOutcomeHash: attestation.terminalOutcomeHash,
      gatewayPolicyVersion: manifest.gatewayPolicyVersion,
      actualProviderKind,
      operations: Object.freeze(operations),
    });
  }
}

function trustedInvestigationProviderKind(
  providerKind: ContextProviderKind | null,
): InvestigationTurnProviderKind | null {
  switch (providerKind) {
    case ContextProviderKind.Codex:
      return InvestigationTurnProviderKind.Codex;
    case ContextProviderKind.ClaudeCode:
      return InvestigationTurnProviderKind.ClaudeCode;
    case ContextProviderKind.OpenRouter:
    case null:
      return null;
  }
}

async function open(
  request: ReviewInvestigationOpenRequest | ReviewInvestigationOpenV2Request,
  d: ReviewActionV2InvestigationHandlerDependencies,
  operationId:
    | ReviewActionV2OperationId.ReviewInvestigationOpen
    | ReviewActionV2OperationId.ReviewInvestigationOpenV2,
) {
  await assertBodyHash(operationId, request as never, d);
  const manifest =
    operationId === ReviewActionV2OperationId.ReviewInvestigationOpenV2
      ? {
          canonicalJson: (request as ReviewInvestigationOpenV2Request)
            .investigationManifestCanonicalJson,
          hash: (request as ReviewInvestigationOpenV2Request)
            .investigationManifestHash,
        }
      : null;
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  if (operationId === ReviewActionV2OperationId.ReviewInvestigationOpenV2) {
    assertInvestigationExtensionAuthorized(authorization);
  }
  requireEqual(
    authorization.authorizationId,
    request.authorizationId,
    "authorization_id_mismatch",
  );
  requireEqual(
    authorization.reviewRevisionHash,
    request.reviewRevisionHash,
    "review_revision_mismatch",
  );
  const execution = await requireExecution(
    request.executionId,
    authorization,
    d,
  );
  const slot = execution.execution.workSlots.find(
    (item) => item.workSlotId === request.workSlotId,
  );
  if (!slot)
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "work_slot_missing",
    );
  requireEqual(
    slot.shardKey,
    request.stableReviewUnitKey,
    "stable_review_unit_mismatch",
  );
  requireEqual(
    slot.providerVoteIdentityHash,
    request.providerVoteLaneId,
    "provider_vote_lane_mismatch",
  );
  if (operationId === ReviewActionV2OperationId.ReviewInvestigationOpenV2) {
    assertInvestigationExtensionAuthorized(
      authorization,
      slot.providerKind,
      InvestigationRolloutCapability.Recording,
    );
  }
  await d.rollout.assertAllowed({
    capability: InvestigationRolloutCapability.Recording,
    target: rolloutTarget(authorization, slot.providerKind),
  });
  const contract = await canonicalDocument<ReviewInvestigationContract>(
    request.coverageContractCanonicalJson,
    request.coverageContractHash,
    d,
  );
  const policy = await canonicalDocument<ReviewInvestigationPolicy>(
    request.investigationPolicyCanonicalJson,
    request.investigationPolicyHash,
    d,
  );
  await assertRegisteredInvestigationReleaseProfile({
    authorization,
    contract,
    policyHash: request.investigationPolicyHash,
    dependencies: d,
  });
  const seedEnvelope = await trustedSeedEnvelope({
    target: {
      executionId: request.executionId,
      workSlotId: request.workSlotId,
      providerVoteLaneId: request.providerVoteLaneId,
      providerStrategyId: request.providerStrategyId,
      seedObligationsCanonicalJson: request.seedObligationsCanonicalJson,
      seedObligationsHash: request.seedObligationsHash,
      ...(manifest === null
        ? {}
        : {
            investigationManifestCanonicalJson: manifest.canonicalJson,
            investigationManifestHash: manifest.hash,
          }),
    },
    authorization,
    execution,
    slot,
    policy,
    dependencies: d,
  });
  const initialReceipts = await canonicalDocument<
    readonly InvestigationEvidenceReceipt[]
  >(request.initialReceiptsCanonicalJson, request.initialReceiptsHash, d);
  const result = await d.investigations.open.execute({
    commandId: request.idempotencyKey,
    scope: {
      workspaceId: authorization.workspaceId,
      repositoryConnectionId: authorization.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      pullRequestNumber: authorization.pullRequestNumber,
      trustDomain: authorization.trustDomain,
      authorizationScopeHash: await d.digest.digestUtf8(
        canonicalJson({
          workspaceId: authorization.workspaceId,
          repositoryConnectionId: authorization.repositoryConnectionId,
          scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
          pullRequestNumber: authorization.pullRequestNumber,
        }),
      ),
    },
    revision: {
      baseSha: authorization.baseSha,
      mergeBaseSha: authorization.mergeBaseSha,
      headSha: authorization.headSha,
      reviewRevisionHash: authorization.reviewRevisionHash,
    },
    executionId: request.executionId,
    workSlotId: request.workSlotId,
    stableReviewUnitKey: request.stableReviewUnitKey,
    providerVoteLaneId: request.providerVoteLaneId,
    providerStrategyId: request.providerStrategyId,
    ...(manifest === null
      ? {}
      : {
          investigationManifestCanonicalJson: manifest.canonicalJson,
          investigationManifestHash: manifest.hash,
        }),
    runtimeProfile: runtimeProfile(request.runtimeProfile),
    contract,
    policy,
    seedObligations: seedEnvelope.obligations,
    initialReceipts,
  });
  return {
    statusCode: 201 as const,
    result: present(result, ReviewInvestigationOpenResultStatus.Opened),
  };
}

async function trustedSeedEnvelope(input: {
  readonly target: Readonly<{
    executionId: string;
    workSlotId: string;
    providerVoteLaneId: string;
    providerStrategyId: string;
    seedObligationsCanonicalJson: string;
    seedObligationsHash: string;
    investigationManifestCanonicalJson?: string;
    investigationManifestHash?: string;
  }>;
  readonly authorization: ReviewRunAuthorization;
  readonly execution: ReviewExecutionSnapshot;
  readonly slot: ReviewExecutionSnapshot["execution"]["workSlots"][number];
  readonly policy: ReviewInvestigationPolicy;
  readonly dependencies: ReviewActionV2InvestigationHandlerDependencies;
}): Promise<ReviewInvestigationSeedEnvelope> {
  const { target, authorization, execution, slot, dependencies: d } = input;
  const document = await canonicalDocument<unknown>(
    target.seedObligationsCanonicalJson,
    target.seedObligationsHash,
    d,
  );
  let envelope: ReviewInvestigationSeedEnvelope;
  try {
    envelope = parseReviewInvestigationSeedEnvelope(
      document,
      input.policy.maxObligations,
    );
  } catch {
    throw failure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      "investigation_seed_envelope_invalid",
    );
  }

  const hasManifest =
    target.investigationManifestCanonicalJson !== undefined &&
    target.investigationManifestHash !== undefined;
  if (
    hasManifest !==
    (target.investigationManifestCanonicalJson !== undefined ||
      target.investigationManifestHash !== undefined)
  ) {
    throw failure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      "investigation_manifest_pair_invalid",
    );
  }
  if (!hasManifest) {
    await assertLegacyPreparedManifest({
      target,
      authorization,
      execution,
      slot,
      envelope,
      dependencies: d,
    });
    return envelope;
  }

  if (
    execution.execution.state !== ReviewExecutionState.Running ||
    execution.stream.activeExecutionId !== execution.execution.executionId ||
    execution.stream.currentRevision?.reviewRevisionHash !==
      authorization.reviewRevisionHash ||
    slot.taskKind !== ExecutionTaskKind.FindingDiscovery ||
    slot.providerVoteIdentityHash !== target.providerVoteLaneId
  ) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "investigation_seed_execution_stale",
    );
  }

  let manifest;
  try {
    const manifestDocument = parseCanonical(
      target.investigationManifestCanonicalJson,
    );
    manifest = normalizeProviderInvocationManifest(manifestDocument);
    if (
      serializeProviderInvocationManifestCanonicalWireJson(manifest) !==
      target.investigationManifestCanonicalJson
    ) {
      throw new Error("investigation_manifest_not_canonical");
    }
  } catch {
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "investigation_seed_prepared_manifest_invalid",
    );
  }
  const expectedProvider = evidenceProviderForInvestigation(slot.providerKind);
  const expectedScopeHash = await d.digest.digestUtf8(
    canonicalJson({
      workspaceId: authorization.workspaceId,
      repositoryConnectionId: authorization.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      pullRequestNumber: authorization.pullRequestNumber,
    }),
  );
  const identity = await buildProviderInvocationIdentity(d.digest, {
    manifest,
    providerVoteIdentityHash: slot.providerVoteIdentityHash,
  });
  if (
    expectedProvider === null ||
    manifest.executionProfile !==
      ProviderExecutionProfile.InvestigationGatewayV1 ||
    manifest.scopeHash !== expectedScopeHash ||
    manifest.producerReleaseId !== authorization.producerReleaseId ||
    manifest.selectedProtocolVersion !==
      authorization.selectedProtocolVersion ||
    manifest.providerKind !== expectedProvider ||
    manifest.requestedModel !== envelope.requestedModel ||
    manifest.providerRequestEnvelopeHash !== target.seedObligationsHash ||
    identity.manifestKey !== target.investigationManifestHash ||
    identity.providerInvocationKey !== target.providerStrategyId ||
    manifest.taskKindSet.length !== 1 ||
    manifest.taskKindSet[0] !== EvidenceTaskKind.FindingDiscovery
  ) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "investigation_seed_prepared_manifest_mismatch",
    );
  }
  return envelope;
}

async function assertLegacyPreparedManifest(input: {
  readonly target: Readonly<{
    executionId: string;
    workSlotId: string;
    providerVoteLaneId: string;
    providerStrategyId: string;
    seedObligationsHash: string;
  }>;
  readonly authorization: ReviewRunAuthorization;
  readonly execution: ReviewExecutionSnapshot;
  readonly slot: ReviewExecutionSnapshot["execution"]["workSlots"][number];
  readonly envelope: ReviewInvestigationSeedEnvelope;
  readonly dependencies: ReviewActionV2InvestigationHandlerDependencies;
}): Promise<void> {
  const { target, authorization, execution, slot, dependencies: d } = input;
  const activeLeases = execution.activeLeases.filter(
    (lease) =>
      lease.executionId === target.executionId &&
      lease.workSlotId === target.workSlotId &&
      lease.purpose === ReviewInvocationLeasePurpose.ProviderExecution &&
      lease.state === ReviewInvocationLeaseState.Active,
  );
  if (activeLeases.length !== 1) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      activeLeases.length === 0
        ? "investigation_seed_active_lease_missing"
        : "investigation_seed_active_lease_ambiguous",
    );
  }
  const lease = activeLeases[0]!;
  if (
    execution.execution.state !== ReviewExecutionState.Running ||
    slot.state !== ReviewWorkSlotState.Leased ||
    slot.activeLeaseId !== lease.leaseId ||
    slot.taskKind !== ExecutionTaskKind.FindingDiscovery ||
    lease.expiresAt <= d.now() ||
    lease.attemptId === null ||
    lease.preparedManifestCanonicalJson === null ||
    lease.preparedManifestKey === null ||
    lease.authorizationId !== authorization.authorizationId ||
    lease.producerReleaseId !== authorization.producerReleaseId ||
    lease.reviewRevisionHash !== authorization.reviewRevisionHash ||
    lease.providerVoteIdentityHash !== target.providerVoteLaneId ||
    lease.providerInvocationKey !== target.providerStrategyId
  ) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "investigation_seed_active_lease_stale",
    );
  }

  let manifest;
  try {
    manifest = normalizeProviderInvocationManifest(
      JSON.parse(lease.preparedManifestCanonicalJson),
    );
    if (
      serializeProviderInvocationManifestCanonicalWireJson(manifest) !==
      lease.preparedManifestCanonicalJson
    ) {
      throw new Error("prepared_manifest_not_canonical");
    }
  } catch {
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "investigation_seed_prepared_manifest_invalid",
    );
  }
  const expectedProvider = evidenceProviderForInvestigation(slot.providerKind);
  const expectedScopeHash = await d.digest.digestUtf8(
    canonicalJson({
      workspaceId: authorization.workspaceId,
      repositoryConnectionId: authorization.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      pullRequestNumber: authorization.pullRequestNumber,
    }),
  );
  if (
    expectedProvider === null ||
    manifest.executionProfile !==
      ProviderExecutionProfile.InvestigationGatewayV1 ||
    manifest.scopeHash !== expectedScopeHash ||
    manifest.producerReleaseId !== authorization.producerReleaseId ||
    manifest.selectedProtocolVersion !==
      authorization.selectedProtocolVersion ||
    manifest.providerKind !== expectedProvider ||
    manifest.requestedModel !== input.envelope.requestedModel ||
    manifest.providerRequestEnvelopeHash !== target.seedObligationsHash ||
    manifest.taskKindSet.length !== 1 ||
    manifest.taskKindSet[0] !== EvidenceTaskKind.FindingDiscovery
  ) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "investigation_seed_prepared_manifest_mismatch",
    );
  }
}

function evidenceProviderForInvestigation(
  provider: ReviewExecutionProviderKind,
): EvidenceProviderKind | null {
  switch (provider) {
    case ReviewExecutionProviderKind.Codex:
      return EvidenceProviderKind.Codex;
    case ReviewExecutionProviderKind.ClaudeCode:
      return EvidenceProviderKind.ClaudeCode;
    case ReviewExecutionProviderKind.OpenRouter:
      return null;
  }
}

async function assertRegisteredInvestigationReleaseProfile(input: {
  readonly authorization: ReviewRunAuthorization;
  readonly contract: ReviewInvestigationContract;
  readonly policyHash: string;
  readonly dependencies: ReviewActionV2InvestigationHandlerDependencies;
}): Promise<void> {
  try {
    assertSupportedReviewInvestigationCoverageProfile(input.contract);
  } catch {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
      "investigation_coverage_profile_unsupported",
    );
  }
  let release;
  try {
    release =
      await input.dependencies.producerReleases?.findProducerReleaseById(
        input.authorization.producerReleaseId,
      );
  } catch {
    throw failure(
      503,
      ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
      "investigation_release_profile_unavailable",
    );
  }
  const profile = release?.reviewInvestigationProfile ?? null;
  if (
    !release ||
    release.state !== ProducerReleaseState.Registered ||
    profile === null ||
    profile.capability !== reviewInvestigationCapabilityV1 ||
    input.contract.producerReleaseId !==
      input.authorization.producerReleaseId ||
    input.policyHash !== profile.policyHash
  ) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
      "investigation_release_profile_mismatch",
    );
  }
  const coverageProfileHash = await input.dependencies.digest.digestUtf8(
    canonicalJson({
      coverageContractVersion: input.contract.coverageContractVersion,
      expansionRulesVersion: input.contract.expansionRulesVersion,
      criticPolicyVersion: input.contract.criticPolicyVersion,
      gatewayPolicyVersion: input.contract.gatewayPolicyVersion,
      probePolicyVersion: input.contract.probePolicyVersion,
      runtimeProfileVersion: input.contract.runtimeProfileVersion,
      searchPolicyVersion: input.contract.searchPolicyVersion,
    }),
  );
  if (
    coverageProfileHash !== profile.coverageProfileHash ||
    input.contract.gatewayPolicyVersion !== release.contextGatewayPolicyVersion
  ) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
      "investigation_release_profile_mismatch",
    );
  }
}

async function restore(
  request: ReviewInvestigationRestoreRequest,
  d: ReviewActionV2InvestigationHandlerDependencies,
) {
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  requireEqual(
    authorization.authorizationId,
    request.authorizationId,
    "authorization_id_mismatch",
  );
  requireEqual(
    authorization.reviewRevisionHash,
    request.reviewRevisionHash,
    "review_revision_mismatch",
  );
  let aggregate: ReviewInvestigation;
  try {
    aggregate = await d.investigations.restore.snapshot(
      request.investigationId,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "investigation_missing") {
      return {
        statusCode: 200 as const,
        result: { status: ReviewInvestigationRestoreResultStatus.Missing },
      };
    }
    throw error;
  }
  requireAggregateAuthorization(aggregate, authorization);
  const result = await d.investigations.restore.execute(
    request.investigationId,
  );
  return {
    statusCode: 200 as const,
    result: present(result, ReviewInvestigationRestoreResultStatus.Found),
  };
}

async function planTurn(
  request: ReviewInvestigationTurnPlanRequest,
  d: ReviewActionV2InvestigationHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewInvestigationTurnPlan,
    request,
    d,
  );
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  const aggregate = await requireAggregate(
    request.investigationId,
    authorization,
    d,
  );
  await assertAggregateRollout(
    aggregate.activeTurn?.purpose === ReviewInvestigationTurnPurpose.Critic ||
      aggregate.state === ReviewInvestigationState.AwaitingCritic
      ? InvestigationRolloutCapability.ContextCritic
      : InvestigationRolloutCapability.Recording,
    aggregate,
    authorization,
    d,
  );
  requireEqual(
    aggregate.dossierDigest,
    request.dossierDigest,
    "dossier_digest_mismatch",
  );
  const expectedVersion = decimal(request.expectedVersion, "expected_version");
  const result = aggregate.activeTurn
    ? await restoreActiveTurn(aggregate, expectedVersion, d)
    : await d.investigations.planTurn.execute({
        commandId: request.idempotencyKey,
        investigationId: request.investigationId,
        expectedVersion,
        leaseDurationMs: request.leaseDurationMs,
        maxObligationsForTurn: request.maxObligationsForTurn,
      });
  const plannedAggregate = await d.investigations.restore.snapshot(
    aggregate.investigationId,
  );
  const turnBriefCanonicalJson = await canonicalTurnBrief(
    plannedAggregate,
    result,
    d.investigations.hydrateTurnObligations,
  );
  const turnBriefHash = await d.digest.digestUtf8(turnBriefCanonicalJson);
  const turnCapability = result.turn
    ? await d.capabilities.issueInvestigationTurn(
        {
          authorizationId: authorization.authorizationId,
          executionId: aggregate.executionId,
          workSlotId: aggregate.workSlotId,
          reviewRevisionHash: aggregate.revision.reviewRevisionHash,
          investigationId: aggregate.investigationId,
          investigationVersion: result.version,
          dossierDigest: result.dossierDigest,
          turnId: result.turn.turnId,
          expiresAt: new Date(result.turn.expiresAt),
        },
        d.now(),
      )
    : null;
  return {
    statusCode:
      result.nextAction === ReviewInvestigationNextActionKind.AwaitCapacity
        ? (202 as const)
        : (201 as const),
    result: {
      ...present(result, mutationStatus(result)),
      turnId: result.turn?.turnId ?? null,
      turnCapability,
      turnExpiresAt: result.turn?.expiresAt ?? null,
      turnBriefCanonicalJson,
      turnBriefHash,
    },
  };
}

async function restoreActiveTurn(
  aggregate: ReviewInvestigation,
  expectedVersion: number,
  d: ReviewActionV2InvestigationHandlerDependencies,
): Promise<ReviewInvestigationReadModel> {
  if (aggregate.version !== expectedVersion) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "investigation_version_mismatch",
    );
  }
  return d.investigations.restore.execute(aggregate.investigationId);
}

async function acquireInvestigationLease(
  request: ReviewInvestigationLeaseAcquireRequest,
  d: ReviewActionV2InvestigationHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewInvestigationLeaseAcquire,
    request,
    d,
  );
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  assertInvestigationExtensionAuthorized(authorization);
  const aggregate = await requireAggregate(
    request.investigationId,
    authorization,
    d,
  );
  const requiredCapability =
    aggregate.activeTurn?.purpose === ReviewInvestigationTurnPurpose.Critic
      ? InvestigationRolloutCapability.ContextCritic
      : InvestigationRolloutCapability.Recording;
  const providerKind = await assertAggregateRollout(
    requiredCapability,
    aggregate,
    authorization,
    d,
  );
  assertInvestigationExtensionAuthorized(
    authorization,
    providerKind,
    requiredCapability,
  );
  const turnAuthority = await verifyTurnCapability(request.turnCapability, d);
  requireTurnAuthority(turnAuthority, request, aggregate, authorization);
  if (
    aggregate.providerStrategyId !== request.providerStrategyId ||
    aggregate.investigationManifestCanonicalJson !==
      request.investigationManifestCanonicalJson ||
    aggregate.investigationManifestHash !== request.investigationManifestHash
  ) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "investigation_lease_manifest_binding_stale",
    );
  }
  const identity = await d.investigationLeaseCapabilities.prepareIdentity();
  const acquired = await d.investigations.acquireLease.execute({
    investigationId: request.investigationId,
    expectedVersion: decimal(request.expectedVersion, "expected_version"),
    turnId: request.turnId,
    authorizationId: authorization.authorizationId,
    mutationEpoch: authorization.mutationEpoch,
    providerStrategyId: request.providerStrategyId,
    investigationManifestCanonicalJson:
      request.investigationManifestCanonicalJson,
    investigationManifestHash: request.investigationManifestHash,
    acquireRequestId: request.acquireRequestId,
    acquireRequestHash: request.requestBodyHash,
    ownerIdHash: request.ownerIdHash,
    leaseId: d.nextInvestigationLeaseId(),
    attemptId: d.nextInvestigationAttemptId(),
    leaseCapabilityId: identity.capabilityId,
    capabilitySigningKeyId: identity.signingKeyId,
    initialLeaseDurationMs: d.investigationLeaseTiming.initialLeaseDurationMs,
    retentionDurationMs: d.investigationLeaseTiming.retentionDurationMs,
  });
  const lease = acquired.lease;
  const leaseCapability = lease
    ? await d.investigationLeaseCapabilities.issue(
        lease,
        await investigationAuthorizationScopeHash(authorization, d.digest),
      )
    : null;
  return {
    statusCode:
      acquired.status === InvestigationLeaseAcquireStatus.Acquired
        ? (201 as const)
        : (200 as const),
    result: {
      status: investigationLeaseAcquireStatus(acquired.status),
      leaseId: lease?.leaseId ?? null,
      attemptId: lease?.attemptId ?? null,
      leaseCapability,
      fencingToken: lease?.fencingToken.toString(10) ?? null,
      expiresAt: lease?.expiresAt ?? null,
      resultReportUntil: lease?.resultReportUntil ?? null,
      rejectionReason:
        lease === null &&
        acquired.status !== InvestigationLeaseAcquireStatus.Busy
          ? acquired.status
          : null,
    },
  };
}

async function renewInvestigationLease(
  request: ReviewInvestigationLeaseRenewRequest,
  d: ReviewActionV2InvestigationHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewInvestigationLeaseRenew,
    request,
    d,
  );
  const authority = await verifyInvestigationLeaseCapability(
    request.leaseCapability,
    d,
  );
  await requireInvestigationLeaseCapability({
    authority,
    leaseId: request.leaseId,
    ownerIdHash: request.ownerIdHash,
    fencingToken: request.fencingToken,
    requireOwnership: true,
    dependencies: d,
  });
  const renewed = await d.investigations.renewLease.execute({
    leaseId: request.leaseId,
    ownerIdHash: request.ownerIdHash,
    leaseCapabilityId: authority.capabilityId,
    fencingToken: BigInt(request.fencingToken),
    renewRequestId: request.renewRequestId,
    renewRequestHash: request.requestBodyHash,
    leaseDurationMs: d.investigationLeaseTiming.renewLeaseDurationMs,
  });
  const lease = renewed?.lease ?? null;
  const leaseCapability =
    lease &&
    (renewed?.status === ReviewInvestigationLeaseTransitionStatus.Applied ||
      renewed?.status === ReviewInvestigationLeaseTransitionStatus.Restored)
      ? await d.investigationLeaseCapabilities.issue(lease, authority.scopeHash)
      : null;
  return {
    statusCode: 200 as const,
    result: {
      status: renewed
        ? investigationLeaseTransitionStatus(renewed.status)
        : ReviewInvestigationLeaseResultStatus.Missing,
      leaseId: lease?.leaseId ?? null,
      fencingToken: lease?.fencingToken.toString(10) ?? null,
      expiresAt: lease?.expiresAt ?? null,
      leaseCapability,
    },
  };
}

async function releaseInvestigationLease(
  request: ReviewInvestigationLeaseReleaseRequest,
  d: ReviewActionV2InvestigationHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewInvestigationLeaseRelease,
    request,
    d,
  );
  const authority = await verifyInvestigationLeaseCapability(
    request.leaseCapability,
    d,
  );
  const lease = await requireInvestigationLeaseCapability({
    authority,
    leaseId: request.leaseId,
    ownerIdHash: request.ownerIdHash,
    fencingToken: request.fencingToken,
    requireOwnership: false,
    dependencies: d,
  });
  if (!investigationLeaseOwnershipIsCurrent(lease, authority, d.now())) {
    return {
      statusCode: 200 as const,
      result: {
        status: ReviewInvestigationLeaseResultStatus.Expired,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken.toString(10),
        expiresAt: lease.expiresAt,
      },
    };
  }
  const released = await d.investigations.releaseLease.execute({
    leaseId: request.leaseId,
    ownerIdHash: request.ownerIdHash,
    leaseCapabilityId: authority.capabilityId,
    fencingToken: BigInt(request.fencingToken),
    releaseRequestId: request.releaseRequestId,
    releaseRequestHash: request.requestBodyHash,
  });
  return {
    statusCode: 200 as const,
    result: {
      status: released
        ? investigationLeaseTransitionStatus(released.status)
        : ReviewInvestigationLeaseResultStatus.Missing,
      leaseId: released?.lease.leaseId ?? null,
      fencingToken: released?.lease.fencingToken.toString(10) ?? null,
      expiresAt: released?.lease.expiresAt ?? null,
    },
  };
}

async function commitTurn(
  request: ReviewInvestigationTurnCommitRequest,
  d: ReviewActionV2InvestigationHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewInvestigationTurnCommit,
    request,
    d,
  );
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  const leaseAuthority = await verifyInvestigationLeaseCapability(
    request.leaseCapability,
    d,
  );
  await requireRestorableInvestigationLeaseCapability({
    authority: leaseAuthority,
    authorization,
    request,
    dependencies: d,
  });
  const observation = await parseCanonicalObservation(request, d);
  const command = {
    commandId: request.idempotencyKey,
    investigationId: request.investigationId,
    expectedVersion: decimal(request.expectedVersion, "expected_version"),
    turnId: request.turnId,
    sourceAttemptId: leaseAuthority.attemptId,
    sourceLeaseId: request.sourceLeaseId,
    sourceFencingToken: request.fencingToken,
    sourceLeaseCapabilityId: leaseAuthority.capabilityId,
    sourceAuthorizationId: authorization.authorizationId,
    sourceMutationEpoch: authorization.mutationEpoch.toString(10),
    acceptedAttestationId: request.acceptedAttestationId,
    acceptedAttestationHash: request.acceptedAttestationHash,
    turnObservationHash: request.turnObservationHash,
    observation,
    authorizationDeadline: authorization.expiresAt.toISOString(),
    capabilityDeadline: leaseAuthority.resultReportUntil.toISOString(),
    drainDeadline: leaseAuthority.resultReportUntil.toISOString(),
  } as const;
  const restored =
    await d.investigations.commitTurn.restoreCommittedCommand(command);
  if (restored !== null) {
    return {
      statusCode: 200 as const,
      result: present(
        restored,
        ReviewInvestigationMutationResultStatus.Applied,
      ),
    };
  }
  const aggregate = await requireAggregate(
    request.investigationId,
    authorization,
    d,
  );
  await assertAggregateRollout(
    aggregate.activeTurn?.purpose === ReviewInvestigationTurnPurpose.Critic
      ? InvestigationRolloutCapability.ContextCritic
      : InvestigationRolloutCapability.Recording,
    aggregate,
    authorization,
    d,
  );
  const lease = await requireInvestigationLeaseCapability({
    authority: leaseAuthority,
    leaseId: request.sourceLeaseId,
    ownerIdHash: leaseAuthority.ownerIdHash,
    fencingToken: request.fencingToken,
    operation: ReviewInvestigationLeaseProtectedOperation.TurnCommit,
    requireOwnership: false,
    aggregate,
    dependencies: d,
  });
  const turnAuthority = await verifyTurnCapability(request.turnCapability, d);
  requireTurnAuthority(turnAuthority, request, aggregate, authorization);
  let result: ReviewInvestigationReadModel;
  try {
    if (lease.attemptId !== leaseAuthority.attemptId) {
      throw failure(
        412,
        ReviewActionV2ProtocolErrorCode.StalePrecondition,
        "investigation_lease_attempt_stale",
      );
    }
    result = await d.investigations.commitTurn.execute(command);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "investigation_lease_fencing_stale"
    ) {
      throw failure(
        412,
        ReviewActionV2ProtocolErrorCode.StalePrecondition,
        error.message,
      );
    }
    if (error instanceof ReviewInvestigationDomainError) {
      throw failure(
        422,
        ReviewActionV2ProtocolErrorCode.InvariantViolation,
        error.code,
      );
    }
    throw error;
  }
  return {
    statusCode: 201 as const,
    result: present(result, ReviewInvestigationMutationResultStatus.Applied),
  };
}

async function abortTurn(
  request: ReviewInvestigationTurnAbortRequest,
  d: ReviewActionV2InvestigationHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewInvestigationTurnAbort,
    request,
    d,
  );
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  const aggregate = await requireAggregate(
    request.investigationId,
    authorization,
    d,
  );
  await assertAggregateRollout(
    aggregate.activeTurn?.purpose === ReviewInvestigationTurnPurpose.Critic
      ? InvestigationRolloutCapability.ContextCritic
      : InvestigationRolloutCapability.Recording,
    aggregate,
    authorization,
    d,
  );
  const leaseAuthority = await verifyInvestigationLeaseCapability(
    request.leaseCapability,
    d,
  );
  await requireInvestigationLeaseCapability({
    authority: leaseAuthority,
    leaseId: request.sourceLeaseId,
    ownerIdHash: leaseAuthority.ownerIdHash,
    fencingToken: request.fencingToken,
    operation: ReviewInvestigationLeaseProtectedOperation.TurnAbort,
    requireOwnership: true,
    aggregate,
    dependencies: d,
  });
  const turnAuthority = await verifyTurnCapability(request.turnCapability, d);
  requireTurnAuthority(turnAuthority, request, aggregate, authorization);
  const result = await d.investigations.abortTurn.execute({
    commandId: request.idempotencyKey,
    investigationId: request.investigationId,
    expectedVersion: decimal(request.expectedVersion, "expected_version"),
    turnId: request.turnId,
    reason: abortReason(request.abortReason),
    nextEligibleAt: request.nextEligibleAt,
  });
  return {
    statusCode:
      result.nextAction === ReviewInvestigationNextActionKind.AwaitCapacity
        ? (202 as const)
        : (200 as const),
    result: present(result, mutationStatus(result)),
  };
}

async function conclude(
  request: ReviewInvestigationConcludeRequest,
  d: ReviewActionV2InvestigationHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewInvestigationConclude,
    request,
    d,
  );
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  const aggregate = await requireAggregate(
    request.investigationId,
    authorization,
    d,
  );
  const expectedVersion = decimal(request.expectedVersion, "expected_version");
  if (!isTerminalShadowProjectionRetry(aggregate, request, expectedVersion)) {
    await assertAggregateRollout(
      InvestigationRolloutCapability.ContextCritic,
      aggregate,
      authorization,
      d,
    );
    requireEqual(
      aggregate.dossierDigest,
      request.dossierDigest,
      "dossier_digest_mismatch",
    );
  }
  const result = await d.investigations.conclude.execute({
    commandId: request.idempotencyKey,
    investigationId: request.investigationId,
    expectedVersion,
    certificateTtlMs: request.certificateTtlMs,
  });
  const concludedAggregate = await requireAggregate(
    request.investigationId,
    authorization,
    d,
  );
  try {
    await d.terminalShadowEvidence.execute(
      toInvestigationShadowEvidenceProjectionSource(concludedAggregate),
    );
  } catch {
    throw failure(
      503,
      ReviewActionV2ProtocolErrorCode.AmbiguousOutcome,
      "investigation_shadow_evidence_projection_pending",
    );
  }
  await d.terminalTelemetry?.recordConcluded({
    investigationId: request.investigationId,
  });
  return {
    statusCode: 201 as const,
    result: present(result, ReviewInvestigationMutationResultStatus.Applied),
  };
}

function isTerminalShadowProjectionRetry(
  aggregate: ReviewInvestigation,
  request: ReviewInvestigationConcludeRequest,
  expectedVersion: number,
): boolean {
  const certificate = aggregate.certificate;
  return (
    certificate !== null &&
    aggregate.conclusion !== null &&
    certificate.investigationId === aggregate.investigationId &&
    certificate.investigationVersion === expectedVersion &&
    certificate.investigationVersion + 1 === aggregate.version &&
    certificate.dossierDigest === request.dossierDigest
  );
}

function toInvestigationShadowEvidenceProjectionSource(
  investigation: ReviewInvestigation,
): InvestigationShadowEvidenceProjectionSource {
  const certificate = investigation.certificate;
  const conclusion = investigation.conclusion;
  if (certificate === null || conclusion === null) {
    throw new Error("investigation_shadow_terminal_certificate_missing");
  }
  return {
    investigationId: investigation.investigationId,
    investigationVersion: investigation.version,
    certifiedDossierDigest: certificate.dossierDigest,
    scope: {
      workspaceId: investigation.scope.workspaceId,
      repositoryConnectionId: investigation.scope.repositoryConnectionId,
      scmRepositoryIdentityId: investigation.scope.scmRepositoryIdentityId,
      pullRequestNumber: investigation.scope.pullRequestNumber,
      trustDomain: evidenceTrustDomain(investigation.scope.trustDomain),
      authorizationScopeHash: investigation.scope.authorizationScopeHash,
    },
    revision: { ...investigation.revision },
    executionId: investigation.executionId,
    workSlotId: investigation.workSlotId,
    stableReviewUnitKey: investigation.stableReviewUnitKey,
    providerVoteLaneId: investigation.providerVoteLaneId,
    coverageContractVersion: investigation.contract.coverageContractVersion,
    expansionRulesVersion: investigation.contract.expansionRulesVersion,
    gatewayPolicyVersion: investigation.contract.gatewayPolicyVersion,
    criticPolicyVersion: investigation.contract.criticPolicyVersion,
    runtimeProfileVersion: investigation.contract.runtimeProfileVersion,
    producerReleaseId: investigation.contract.producerReleaseId,
    conclusion: shadowConclusion(conclusion),
    certificate: {
      certificateId: certificate.certificateId,
      certificateHash: certificate.certificateHash,
      investigationId: certificate.investigationId,
      investigationVersion: certificate.investigationVersion,
      dossierDigest: certificate.dossierDigest,
      reviewRevisionHash: certificate.reviewRevisionHash,
      stableReviewUnitKey: certificate.stableReviewUnitKey,
      providerVoteLaneId: certificate.providerVoteLaneId,
      coverageContractVersion: certificate.coverageContractVersion,
      expansionRulesVersion: certificate.expansionRulesVersion,
      gatewayPolicyVersion: certificate.gatewayPolicyVersion,
      criticPolicyVersion: certificate.criticPolicyVersion,
      runtimeProfileVersion: certificate.runtimeProfileVersion,
      producerReleaseId: certificate.producerReleaseId,
      conclusion: shadowConclusion(certificate.conclusion),
      findingSetHash: certificate.findingSetHash,
      obligationSetHash: certificate.obligationSetHash,
      receiptSetHash: certificate.receiptSetHash,
      scopeHash: certificate.scopeHash,
      coverageStateHash: certificate.coverageStateHash,
      contextAttestationSetHash: certificate.contextAttestationSetHash,
      turnProvenanceHash: certificate.turnProvenanceHash,
      terminalProviderKind: shadowProvider(certificate.terminalProviderKind),
      terminalActualModel: certificate.terminalActualModel,
      terminalOutcomeHash: certificate.terminalOutcomeHash,
      terminalObservationCanonicalJson:
        certificate.terminalObservationCanonicalJson,
      criticAttestationId: certificate.criticAttestationId,
      criticAttestationHash: certificate.criticAttestationHash,
      criticDecision: shadowCriticDecision(certificate.criticDecision),
      issuedAt: certificate.issuedAt,
      expiresAt: certificate.expiresAt,
    },
  };
}

function shadowConclusion(
  conclusion: ReviewInvestigationConclusion,
): InvestigationShadowEvidenceConclusion {
  switch (conclusion) {
    case ReviewInvestigationConclusion.VerifiedClean:
      return InvestigationShadowEvidenceConclusion.VerifiedClean;
    case ReviewInvestigationConclusion.Findings:
      return InvestigationShadowEvidenceConclusion.Findings;
    case ReviewInvestigationConclusion.Inconclusive:
      return InvestigationShadowEvidenceConclusion.Inconclusive;
  }
}

function shadowProvider(
  provider: InvestigationTurnProviderKind | null,
): EvidenceProviderKind | null {
  switch (provider) {
    case InvestigationTurnProviderKind.Codex:
      return EvidenceProviderKind.Codex;
    case InvestigationTurnProviderKind.ClaudeCode:
      return EvidenceProviderKind.ClaudeCode;
    case null:
      return null;
  }
}

function shadowCriticDecision(
  decision: ContextCriticDecision | null,
): InvestigationShadowEvidenceCriticDecision | null {
  switch (decision) {
    case ContextCriticDecision.Accept:
      return InvestigationShadowEvidenceCriticDecision.Accept;
    case ContextCriticDecision.Veto:
      return InvestigationShadowEvidenceCriticDecision.Veto;
    case ContextCriticDecision.Abstain:
      return InvestigationShadowEvidenceCriticDecision.Abstain;
    case null:
      return null;
  }
}

function evidenceTrustDomain(value: string): EvidenceTrustDomain {
  switch (value) {
    case EvidenceTrustDomain.TrustedManaged:
      return EvidenceTrustDomain.TrustedManaged;
    case EvidenceTrustDomain.TrustedLocal:
      return EvidenceTrustDomain.TrustedLocal;
    case EvidenceTrustDomain.UntrustedContribution:
      return EvidenceTrustDomain.UntrustedContribution;
    default:
      throw new Error("investigation_shadow_trust_domain_unsupported");
  }
}

async function prepareReplay(
  request: ReviewInvestigationReplayPrepareRequest,
  d: ReviewActionV2InvestigationHandlerDependencies,
) {
  if (!d.crossRevisionReplayEnabled) {
    return {
      statusCode: 200 as const,
      result: {
        status: ReviewInvestigationReplayPrepareResultStatus.Rejected,
        sourceInvestigationId: null,
        sourceCertificateId: null,
        sourceCertificateHash: null,
        replayPreparationCanonicalJson: null,
        replayPreparationHash: null,
      },
    };
  }
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  requireEqual(
    authorization.authorizationId,
    request.authorizationId,
    "authorization_id_mismatch",
  );
  requireEqual(
    authorization.reviewRevisionHash,
    request.targetReviewRevisionHash,
    "target_review_revision_mismatch",
  );
  const snapshot = await requireExecution(
    request.targetExecutionId,
    authorization,
    d,
  );
  const slot = snapshot.execution.workSlots.find(
    (candidate) => candidate.workSlotId === request.targetWorkSlotId,
  );
  if (!slot) {
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "work_slot_missing",
    );
  }
  requireEqual(
    slot.shardKey,
    request.stableReviewUnitKey,
    "stable_review_unit_mismatch",
  );
  requireEqual(
    slot.providerVoteIdentityHash,
    request.providerVoteLaneId,
    "provider_vote_lane_mismatch",
  );
  await d.rollout.assertAllowed({
    capability: InvestigationRolloutCapability.CrossRevisionReplay,
    target: rolloutTarget(authorization, slot.providerKind),
  });
  const targetContract = await canonicalDocument<ReviewInvestigationContract>(
    request.coverageContractCanonicalJson,
    request.coverageContractHash,
    d,
  );
  let manifest;
  try {
    manifest = normalizeProviderInvocationManifest(
      JSON.parse(request.providerManifestCanonicalJson),
    );
  } catch {
    throw failure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      "provider_manifest_invalid",
    );
  }
  requireEqual(
    canonicalJson(manifest),
    request.providerManifestCanonicalJson,
    "provider_manifest_not_canonical",
  );
  requireEqual(
    await computeProviderManifestKey(
      d.digest,
      request.providerManifestCanonicalJson,
    ),
    request.providerManifestHash,
    "provider_manifest_hash_mismatch",
  );
  if (
    manifest.executionProfile !==
      ProviderExecutionProfile.InvestigationGatewayV1 ||
    manifest.producerReleaseId !== authorization.producerReleaseId ||
    manifest.selectedProtocolVersion !==
      authorization.selectedProtocolVersion ||
    manifest.scopeHash !==
      (await d.digest.digestUtf8(
        canonicalJson({
          workspaceId: authorization.workspaceId,
          repositoryConnectionId: authorization.repositoryConnectionId,
          scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
          pullRequestNumber: authorization.pullRequestNumber,
        }),
      ))
  ) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "investigation_replay_manifest_mismatch",
    );
  }
  const targetScope = await investigationScope(authorization, d.digest);
  const targetRevision = investigationRevision(authorization);
  const result = await d.investigations
    .prepareReplay(
      d.replayPreparation({
        authorization,
        snapshot,
        workSlotId: request.targetWorkSlotId,
        manifest,
        providerVoteIdentityHash: request.providerVoteLaneId,
      }),
    )
    .execute({
      targetScope,
      targetRevision,
      targetExecutionId: request.targetExecutionId,
      targetWorkSlotId: request.targetWorkSlotId,
      stableReviewUnitKey: request.stableReviewUnitKey,
      providerVoteLaneId: request.providerVoteLaneId,
      producerReleaseId: authorization.producerReleaseId,
      targetContract,
    });
  if (result.status === "missing") {
    return {
      statusCode: 200 as const,
      result: {
        status: ReviewInvestigationReplayPrepareResultStatus.Missing,
        sourceInvestigationId: null,
        sourceCertificateId: null,
        sourceCertificateHash: null,
        replayPreparationCanonicalJson: null,
        replayPreparationHash: null,
      },
    };
  }
  const replayPreparationCanonicalJson = canonicalJson({
    obligations: result.obligations.map((item) => ({
      obligationId: item.obligationId,
      contextAttestationId: item.replay.contextAttestationId,
      contextAttestationHash: item.replay.contextAttestationHash,
      sourceOperationReceiptIdsHash: item.replay.sourceOperationReceiptIdsHash,
      replayCapability: item.replay.replayCapability,
      replayPlanCanonicalJson: item.replay.replayPlanCanonicalJson,
      replayPlanHash: item.replay.replayPlanHash,
    })),
  });
  return {
    statusCode: 200 as const,
    result: {
      status: ReviewInvestigationReplayPrepareResultStatus.Prepared,
      sourceInvestigationId: result.sourceInvestigationId,
      sourceCertificateId: result.sourceCheckpointId,
      sourceCertificateHash: result.sourceCheckpointHash,
      replayPreparationCanonicalJson,
      replayPreparationHash: await d.digest.digestUtf8(
        replayPreparationCanonicalJson,
      ),
    },
  };
}

async function replay(
  request:
    | ReviewInvestigationReplayRequest
    | ReviewInvestigationReplayV2Request,
  d: ReviewActionV2InvestigationHandlerDependencies,
  operationId:
    | ReviewActionV2OperationId.ReviewInvestigationReplay
    | ReviewActionV2OperationId.ReviewInvestigationReplayV2,
) {
  await assertBodyHash(operationId, request as never, d);
  const manifest =
    operationId === ReviewActionV2OperationId.ReviewInvestigationReplayV2
      ? {
          canonicalJson: (request as ReviewInvestigationReplayV2Request)
            .investigationManifestCanonicalJson,
          hash: (request as ReviewInvestigationReplayV2Request)
            .investigationManifestHash,
        }
      : null;
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  if (operationId === ReviewActionV2OperationId.ReviewInvestigationReplayV2) {
    assertInvestigationExtensionAuthorized(authorization);
  }
  requireEqual(
    authorization.authorizationId,
    request.authorizationId,
    "authorization_id_mismatch",
  );
  const targetExecution = await requireExecution(
    request.targetExecutionId,
    authorization,
    d,
  );
  const targetSlot = targetExecution.execution.workSlots.find(
    (candidate) => candidate.workSlotId === request.targetWorkSlotId,
  );
  if (!targetSlot) {
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "work_slot_missing",
    );
  }
  requireEqual(
    targetSlot.shardKey,
    request.stableReviewUnitKey,
    "stable_review_unit_mismatch",
  );
  requireEqual(
    targetSlot.providerVoteIdentityHash,
    request.providerVoteLaneId,
    "provider_vote_lane_mismatch",
  );
  if (operationId === ReviewActionV2OperationId.ReviewInvestigationReplayV2) {
    assertInvestigationExtensionAuthorized(
      authorization,
      targetSlot.providerKind,
      InvestigationRolloutCapability.CrossRevisionReplay,
    );
  }
  await d.rollout.assertAllowed({
    capability: InvestigationRolloutCapability.CrossRevisionReplay,
    target: rolloutTarget(authorization, targetSlot.providerKind),
  });
  const targetScope = await canonicalDocument<ReviewInvestigationScope>(
    request.targetScopeCanonicalJson,
    request.targetScopeHash,
    d,
  );
  const targetRevision = await canonicalDocument<ReviewInvestigationRevision>(
    request.targetRevisionCanonicalJson,
    request.targetRevisionHash,
    d,
  );
  const replayProofs = await canonicalDocument<
    readonly Readonly<{ obligationId: string; replayProofId: string }>[]
  >(request.replayProofsCanonicalJson, request.replayProofsHash, d);
  const targetContract = await canonicalDocument<ReviewInvestigationContract>(
    request.coverageContractCanonicalJson,
    request.coverageContractHash,
    d,
  );
  const targetPolicy = await canonicalDocument<ReviewInvestigationPolicy>(
    request.investigationPolicyCanonicalJson,
    request.investigationPolicyHash,
    d,
  );
  await assertRegisteredInvestigationReleaseProfile({
    authorization,
    contract: targetContract,
    policyHash: request.investigationPolicyHash,
    dependencies: d,
  });
  const seedEnvelope = await trustedSeedEnvelope({
    target: {
      executionId: request.targetExecutionId,
      workSlotId: request.targetWorkSlotId,
      providerVoteLaneId: request.providerVoteLaneId,
      providerStrategyId: request.providerStrategyId,
      seedObligationsCanonicalJson: request.seedObligationsCanonicalJson,
      seedObligationsHash: request.seedObligationsHash,
      ...(manifest === null
        ? {}
        : {
            investigationManifestCanonicalJson: manifest.canonicalJson,
            investigationManifestHash: manifest.hash,
          }),
    },
    authorization,
    execution: targetExecution,
    slot: targetSlot,
    policy: targetPolicy,
    dependencies: d,
  });
  const targetInitialReceipts = await canonicalDocument<
    readonly InvestigationEvidenceReceipt[]
  >(request.initialReceiptsCanonicalJson, request.initialReceiptsHash, d);
  const expectedScope: ReviewInvestigationScope = {
    workspaceId: authorization.workspaceId,
    repositoryConnectionId: authorization.repositoryConnectionId,
    scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
    pullRequestNumber: authorization.pullRequestNumber,
    trustDomain: authorization.trustDomain,
    authorizationScopeHash: await d.digest.digestUtf8(
      canonicalJson({
        workspaceId: authorization.workspaceId,
        repositoryConnectionId: authorization.repositoryConnectionId,
        scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
        pullRequestNumber: authorization.pullRequestNumber,
      }),
    ),
  };
  const expectedRevision: ReviewInvestigationRevision = {
    baseSha: authorization.baseSha,
    mergeBaseSha: authorization.mergeBaseSha,
    headSha: authorization.headSha,
    reviewRevisionHash: authorization.reviewRevisionHash,
  };
  requireEqual(
    canonicalJson(targetScope),
    canonicalJson(expectedScope),
    "target_scope_mismatch",
  );
  requireEqual(
    canonicalJson(targetRevision),
    canonicalJson(expectedRevision),
    "target_revision_mismatch",
  );
  const source = await d.investigations.restore.snapshot(
    request.sourceInvestigationId,
  );
  if (
    source.scope.workspaceId !== expectedScope.workspaceId ||
    source.scope.repositoryConnectionId !==
      expectedScope.repositoryConnectionId ||
    source.scope.scmRepositoryIdentityId !==
      expectedScope.scmRepositoryIdentityId ||
    source.scope.pullRequestNumber !== expectedScope.pullRequestNumber ||
    source.scope.trustDomain !== expectedScope.trustDomain ||
    source.scope.authorizationScopeHash !== expectedScope.authorizationScopeHash
  ) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "investigation_replay_scope_mismatch",
    );
  }
  const result = await d.investigations.replay.execute({
    commandId: request.idempotencyKey,
    sourceInvestigationId: request.sourceInvestigationId,
    sourceCheckpointHash: request.sourceCertificateHash,
    targetScope,
    targetRevision,
    targetExecutionId: request.targetExecutionId,
    targetWorkSlotId: request.targetWorkSlotId,
    targetStableReviewUnitKey: request.stableReviewUnitKey,
    targetProviderVoteLaneId: request.providerVoteLaneId,
    targetProviderStrategyId: request.providerStrategyId,
    ...(manifest === null
      ? {}
      : {
          targetInvestigationManifestCanonicalJson: manifest.canonicalJson,
          targetInvestigationManifestHash: manifest.hash,
        }),
    targetRuntimeProfile: runtimeProfile(request.runtimeProfile),
    targetContract,
    targetPolicy,
    targetSeedObligations: seedEnvelope.obligations,
    targetInitialReceipts,
    replayProofs,
  });
  return {
    statusCode: 201 as const,
    result: present(result, ReviewInvestigationMutationResultStatus.Applied),
  };
}

function enabled<Request, Outcome>(
  execute: (request: Request) => Promise<Outcome>,
) {
  return { capabilityEnabled: true as const, execute };
}

function assertInvestigationExtensionAuthorized(
  authorization: ReviewRunAuthorization,
  provider?: ReviewExecutionProviderKind,
  capability?: InvestigationRolloutCapability,
): void {
  if (
    provider === undefined &&
    capability === undefined &&
    hasAuthorizedReviewInvestigationExtension(authorization)
  ) {
    return;
  }
  if (provider !== undefined && capability !== undefined) {
    const authorizedProvider = extensionProvider(provider);
    if (
      authorizedProvider !== null &&
      hasAuthorizedReviewInvestigationExtension(authorization, {
        providerKind: authorizedProvider,
        capability,
      })
    ) {
      return;
    }
  }
  throw failure(
    403,
    ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
    "review_investigation_extension_not_authorized",
  );
}

async function assertAggregateRollout(
  capability: InvestigationRolloutCapability,
  aggregate: ReviewInvestigation,
  authorization: ReviewRunAuthorization,
  d: ReviewActionV2InvestigationHandlerDependencies,
): Promise<ReviewExecutionProviderKind> {
  const snapshot = await requireExecution(
    aggregate.executionId,
    authorization,
    d,
  );
  const slot = snapshot.execution.workSlots.find(
    (candidate) => candidate.workSlotId === aggregate.workSlotId,
  );
  if (!slot) {
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "work_slot_missing",
    );
  }
  await d.rollout.assertAllowed({
    capability,
    target: rolloutTarget(authorization, slot.providerKind),
  });
  return slot.providerKind;
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

function rolloutTarget(
  authorization: ReviewRunAuthorization,
  provider: ReviewExecutionProviderKind,
) {
  return Object.freeze({
    workspaceId: authorization.workspaceId,
    repositoryConnectionId: authorization.repositoryConnectionId,
    scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
    provider: rolloutProvider(provider),
    trustDomain: authorization.trustDomain,
    producerReleaseId: authorization.producerReleaseId,
  });
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

function present<
  Status extends
    | ReviewInvestigationOpenResultStatus
    | ReviewInvestigationRestoreResultStatus
    | ReviewInvestigationMutationResultStatus,
>(readModel: ReviewInvestigationReadModel, status: Status) {
  return {
    status,
    investigationId: readModel.investigationId,
    investigationVersion: String(readModel.version),
    investigationState:
      readModel.state as unknown as ReviewInvestigationPublishedState,
    dossierDigest: readModel.dossierDigest,
    nextAction:
      readModel.nextAction as unknown as ReviewInvestigationNextAction,
    investigationCanonicalJson: canonicalJson(readModel),
    certificateId: readModel.certificateId,
    certificateHash: readModel.certificateHash,
    terminalProviderKind: readModel.terminalProviderKind,
    terminalActualModel: readModel.terminalActualModel,
    terminalObservationCanonicalJson:
      readModel.terminalObservationCanonicalJson,
    terminalOutcomeHash: readModel.terminalOutcomeHash,
    investigationConclusion:
      readModel.conclusion as unknown as ReviewInvestigationPublishedConclusion | null,
  };
}

function mutationStatus(
  result: ReviewInvestigationReadModel,
): ReviewInvestigationMutationResultStatus {
  return result.nextAction === ReviewInvestigationNextActionKind.AwaitCapacity
    ? ReviewInvestigationMutationResultStatus.Parked
    : ReviewInvestigationMutationResultStatus.Applied;
}

async function canonicalTurnBrief(
  aggregate: ReviewInvestigation,
  readModel: ReviewInvestigationReadModel,
  hydrator: HydrateInvestigationTurnObligations | null,
): Promise<string> {
  if (!aggregate.activeTurn || !readModel.turn) return canonicalJson(null);
  if (
    !hydrator &&
    readModel.turn.obligationIds.some((obligationId) => {
      const obligation = aggregate.obligations.find(
        (candidate) => candidate.obligationId === obligationId,
      );
      if (!obligation) throw new Error("investigation_turn_obligation_missing");
      const requirement = parseInvestigationEvidenceRequirement(
        obligation.canonicalRequirement,
      );
      return requiresInvestigationSearchQueryPrivateMaterial(requirement);
    })
  ) {
    throw new Error("investigation_private_material_unavailable");
  }
  const obligations = hydrator
    ? await hydrator.execute({
        investigation: aggregate,
        obligationIds: readModel.turn.obligationIds,
      })
    : readModel.turn.obligationIds.map((obligationId) => {
        const obligation = aggregate.obligations.find(
          (candidate) => candidate.obligationId === obligationId,
        );
        if (!obligation)
          throw new Error("investigation_turn_obligation_missing");
        return {
          obligationId: obligation.obligationId,
          kind: obligation.kind,
          canonicalSubject: obligation.canonicalSubject,
          canonicalRequirement: obligation.canonicalRequirement,
          riskPriority: obligation.riskPriority,
          origin: obligation.origin,
        };
      });
  return canonicalJson({
    briefVersion: 1,
    investigationId: readModel.investigationId,
    investigationVersion: readModel.version,
    dossierDigest: readModel.dossierDigest,
    turnId: readModel.turn.turnId,
    purpose: readModel.turn.purpose,
    maximumSemanticRiskPriority: maximumSemanticRiskPriority(
      aggregate.obligations,
    ),
    obligations,
  });
}

async function requireAuthorization(
  token: string,
  d: ReviewActionV2InvestigationHandlerDependencies,
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
      401,
      ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
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
  d: ReviewActionV2InvestigationHandlerDependencies,
) {
  const snapshot = await d.executionQueries.findExecution(executionId);
  if (!snapshot)
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "execution_missing",
    );
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

async function requireAggregate(
  investigationId: string,
  authorization: ReviewRunAuthorization,
  d: ReviewActionV2InvestigationHandlerDependencies,
): Promise<ReviewInvestigation> {
  let aggregate: ReviewInvestigation;
  try {
    aggregate = await d.investigations.restore.snapshot(investigationId);
  } catch {
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "investigation_missing",
    );
  }
  requireAggregateAuthorization(aggregate, authorization);
  return aggregate;
}

function requireAggregateAuthorization(
  aggregate: ReviewInvestigation,
  authorization: ReviewRunAuthorization,
): void {
  if (
    aggregate.scope.workspaceId !== authorization.workspaceId ||
    aggregate.scope.repositoryConnectionId !==
      authorization.repositoryConnectionId ||
    aggregate.scope.scmRepositoryIdentityId !==
      authorization.scmRepositoryIdentityId ||
    aggregate.scope.pullRequestNumber !== authorization.pullRequestNumber ||
    aggregate.scope.trustDomain !== authorization.trustDomain ||
    aggregate.revision.reviewRevisionHash !== authorization.reviewRevisionHash
  ) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "investigation_authorization_mismatch",
    );
  }
}

async function verifyInvestigationLeaseCapability(
  token: string,
  d: ReviewActionV2InvestigationHandlerDependencies,
): Promise<VerifiedReviewActionV2InvestigationLeaseCapability> {
  try {
    return await d.investigationLeaseCapabilities.verify(token, d.now());
  } catch {
    throw failure(
      401,
      ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      "investigation_lease_capability_invalid",
    );
  }
}

async function requireInvestigationLeaseCapability(input: {
  readonly authority: VerifiedReviewActionV2InvestigationLeaseCapability;
  readonly leaseId: string;
  readonly ownerIdHash: string;
  readonly fencingToken: string;
  readonly operation?: ReviewInvestigationLeaseProtectedOperation;
  readonly requireOwnership: boolean;
  readonly aggregate?: ReviewInvestigation;
  readonly dependencies: ReviewActionV2InvestigationHandlerDependencies;
}): Promise<ReviewInvestigationLease> {
  const { authority, dependencies: d } = input;
  const lease = await d.investigationLeaseQueries.findLease(input.leaseId);
  const now = d.now();
  if (
    !lease ||
    lease.leaseCapabilityId !== authority.capabilityId ||
    lease.authorizationId !== authority.authorizationId ||
    lease.mutationEpoch !== authority.mutationEpoch ||
    lease.executionId !== authority.executionId ||
    lease.workSlotId !== authority.workSlotId ||
    lease.revision.reviewRevisionHash !== authority.reviewRevisionHash ||
    lease.investigationId !== authority.investigationId ||
    lease.investigationVersion !== authority.investigationVersion ||
    lease.turnId !== authority.turnId ||
    lease.turnPurpose !== authority.turnPurpose ||
    lease.providerVoteLaneId !== authority.providerVoteLaneId ||
    lease.providerStrategyId !== authority.providerStrategyId ||
    lease.investigationManifestHash !== authority.investigationManifestHash ||
    lease.ownerIdHash !== authority.ownerIdHash ||
    lease.ownerIdHash !== input.ownerIdHash ||
    lease.leaseId !== authority.leaseId ||
    lease.leaseId !== input.leaseId ||
    lease.attemptId !== authority.attemptId ||
    lease.fencingToken !== authority.fencingToken ||
    lease.fencingToken.toString(10) !== input.fencingToken ||
    authority.scopeHash !==
      (await investigationLeaseScopeHash(lease, d.digest)) ||
    (input.aggregate !== undefined &&
      !reviewInvestigationLeaseBindingIsCurrent(lease, input.aggregate)) ||
    (input.requireOwnership
      ? !investigationLeaseOwnershipIsCurrent(lease, authority, now)
      : input.operation !== undefined &&
        (lease.state !== ReviewInvestigationLeaseState.Active ||
          new Date(lease.resultReportUntil) <= now ||
          authority.resultReportUntil <= now))
  ) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "investigation_lease_stale",
    );
  }
  if (input.operation !== undefined) {
    try {
      assertReviewInvestigationLeaseAllows(lease, input.operation);
    } catch {
      throw failure(
        403,
        ReviewActionV2ProtocolErrorCode.Forbidden,
        "investigation_lease_operation_forbidden",
      );
    }
  }
  return lease;
}

function investigationLeaseOwnershipIsCurrent(
  lease: ReviewInvestigationLease,
  authority: VerifiedReviewActionV2InvestigationLeaseCapability,
  now: Date,
): boolean {
  return (
    lease.state === ReviewInvestigationLeaseState.Active &&
    new Date(lease.expiresAt) > now &&
    authority.ownershipExpiresAt > now
  );
}

async function requireRestorableInvestigationLeaseCapability(input: {
  readonly authority: VerifiedReviewActionV2InvestigationLeaseCapability;
  readonly authorization: ReviewRunAuthorization;
  readonly request: ReviewInvestigationTurnCommitRequest;
  readonly dependencies: ReviewActionV2InvestigationHandlerDependencies;
}): Promise<void> {
  const { authority, authorization, request, dependencies: d } = input;
  if (
    authority.authorizationId !== authorization.authorizationId ||
    authority.mutationEpoch !== authorization.mutationEpoch ||
    authority.scopeHash !==
      (await investigationAuthorizationScopeHash(authorization, d.digest)) ||
    authority.reviewRevisionHash !== authorization.reviewRevisionHash ||
    authority.investigationId !== request.investigationId ||
    authority.investigationVersion !==
      decimal(request.expectedVersion, "expected_version") ||
    authority.turnId !== request.turnId ||
    authority.leaseId !== request.sourceLeaseId ||
    authority.fencingToken.toString(10) !== request.fencingToken
  ) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "investigation_lease_restore_binding_stale",
    );
  }
}

function investigationLeaseAcquireStatus(
  status: InvestigationLeaseAcquireStatus,
): ReviewInvestigationLeaseResultStatus {
  switch (status) {
    case InvestigationLeaseAcquireStatus.Acquired:
      return ReviewInvestigationLeaseResultStatus.Acquired;
    case InvestigationLeaseAcquireStatus.Restored:
      return ReviewInvestigationLeaseResultStatus.Restored;
    case InvestigationLeaseAcquireStatus.Busy:
      return ReviewInvestigationLeaseResultStatus.Busy;
    case InvestigationLeaseAcquireStatus.BindingStale:
      return ReviewInvestigationLeaseResultStatus.BindingStale;
    case InvestigationLeaseAcquireStatus.IdempotencyConflict:
      return ReviewInvestigationLeaseResultStatus.IdempotencyConflict;
  }
}

function investigationLeaseTransitionStatus(
  status: ReviewInvestigationLeaseTransitionStatus,
): ReviewInvestigationLeaseResultStatus {
  switch (status) {
    case ReviewInvestigationLeaseTransitionStatus.Applied:
      return ReviewInvestigationLeaseResultStatus.Applied;
    case ReviewInvestigationLeaseTransitionStatus.Restored:
      return ReviewInvestigationLeaseResultStatus.Restored;
    case ReviewInvestigationLeaseTransitionStatus.StaleFence:
      return ReviewInvestigationLeaseResultStatus.StaleFence;
    case ReviewInvestigationLeaseTransitionStatus.BindingStale:
      return ReviewInvestigationLeaseResultStatus.BindingStale;
    case ReviewInvestigationLeaseTransitionStatus.Expired:
      return ReviewInvestigationLeaseResultStatus.Expired;
    case ReviewInvestigationLeaseTransitionStatus.InvalidDeadline:
      return ReviewInvestigationLeaseResultStatus.InvalidDeadline;
    case ReviewInvestigationLeaseTransitionStatus.IdempotencyConflict:
      return ReviewInvestigationLeaseResultStatus.IdempotencyConflict;
  }
}

async function investigationAuthorizationScopeHash(
  authorization: ReviewRunAuthorization,
  digest: ReviewActionV2DigestPort,
): Promise<string> {
  return digest.digestUtf8(
    canonicalJson({
      workspaceId: authorization.workspaceId,
      repositoryConnectionId: authorization.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      pullRequestNumber: authorization.pullRequestNumber,
    }),
  );
}

async function investigationLeaseScopeHash(
  lease: ReviewInvestigationLease,
  digest: ReviewActionV2DigestPort,
): Promise<string> {
  return digest.digestUtf8(
    canonicalJson({
      workspaceId: lease.workspaceId,
      repositoryConnectionId: lease.repositoryConnectionId,
      scmRepositoryIdentityId: lease.scmRepositoryIdentityId,
      pullRequestNumber: lease.pullRequestNumber,
    }),
  );
}

async function verifyTurnCapability(
  token: string,
  d: ReviewActionV2InvestigationHandlerDependencies,
): Promise<VerifiedReviewActionV2InvestigationTurnCapability> {
  try {
    return await d.capabilities.verifyInvestigationTurn(token, d.now());
  } catch {
    throw failure(
      401,
      ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      "turn_capability_invalid",
    );
  }
}

function requireTurnAuthority(
  authority: VerifiedReviewActionV2InvestigationTurnCapability,
  request: Pick<
    ReviewInvestigationTurnCommitRequest,
    "investigationId" | "expectedVersion" | "turnId"
  >,
  aggregate: ReviewInvestigation,
  authorization: ReviewRunAuthorization,
): void {
  const expectedVersion = decimal(request.expectedVersion, "expected_version");
  const activeTurnAuthorized =
    authority.dossierDigest === aggregate.dossierDigest &&
    aggregate.activeTurn?.turnId === request.turnId;
  const completedTurnReplay =
    aggregate.version > expectedVersion &&
    aggregate.activeTurn?.turnId !== request.turnId &&
    aggregate.turnProvenance.some((turn) => turn.turnId === request.turnId);
  if (
    authority.authorizationId !== authorization.authorizationId ||
    authority.executionId !== aggregate.executionId ||
    authority.workSlotId !== aggregate.workSlotId ||
    authority.reviewRevisionHash !== aggregate.revision.reviewRevisionHash ||
    authority.investigationId !== request.investigationId ||
    authority.investigationVersion !== expectedVersion ||
    authority.turnId !== request.turnId ||
    (!activeTurnAuthorized && !completedTurnReplay)
  ) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "turn_capability_stale",
    );
  }
}

async function parseCanonicalObservation(
  request: ReviewInvestigationTurnCommitRequest,
  d: ReviewActionV2InvestigationHandlerDependencies,
) {
  const parsed = parseCanonical(request.turnObservationCanonicalJson);
  const observation = parseInvestigationTurnObservation(parsed);
  if (
    canonicalInvestigationTurnObservation(observation) !==
      request.turnObservationCanonicalJson ||
    (await d.digest.digestUtf8(request.turnObservationCanonicalJson)) !==
      request.turnObservationHash
  ) {
    throw failure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      "turn_observation_not_canonical",
    );
  }
  return observation;
}

async function canonicalDocument<T>(
  raw: string,
  expectedHash: string,
  d: ReviewActionV2InvestigationHandlerDependencies,
): Promise<T> {
  const parsed = parseCanonical(raw);
  if ((await d.digest.digestUtf8(raw)) !== expectedHash) {
    throw failure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      "canonical_document_hash_mismatch",
    );
  }
  return parsed as T;
}

function parseCanonical(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw failure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      "canonical_json_invalid",
    );
  }
  if (canonicalJson(parsed) !== raw) {
    throw failure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      "canonical_json_not_canonical",
    );
  }
  return parsed;
}

async function assertBodyHash<O extends ReviewActionV2OperationId>(
  operationId: O,
  request: ReviewActionV2RequestMap[O],
  d: ReviewActionV2InvestigationHandlerDependencies,
): Promise<void> {
  if (
    (await d.digest.digestUtf8(
      canonicalizeReviewActionV2Request(operationId, request),
    )) !== (request as { requestBodyHash?: string }).requestBodyHash
  ) {
    throw failure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      "request_body_hash_mismatch",
    );
  }
}

function runtimeProfile(
  value: ReviewInvestigationPublishedRuntimeProfile,
): ReviewInvestigationRuntimeProfile {
  if (
    value !== ReviewInvestigationPublishedRuntimeProfile.GatewayAttestedAgentV1
  ) {
    throw failure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      "runtime_profile_unsupported",
    );
  }
  return ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1;
}

function abortReason(value: string): ReviewInvestigationAbortReason {
  if (
    !Object.values(ReviewInvestigationAbortReason).includes(
      value as ReviewInvestigationAbortReason,
    )
  ) {
    throw failure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      "abort_reason_unsupported",
    );
  }
  return value as ReviewInvestigationAbortReason;
}

function verifiedOperationEvidence(
  event: ContextGatewayV4Manifest["events"][number],
) {
  if (
    event.outcome !== ContextGatewayV4OutcomeKind.Succeeded ||
    event.operationReceiptId === null ||
    event.result === null
  ) {
    throw new Error("unsuccessful_operation_cannot_produce_evidence");
  }
  const base = {
    operationReceiptId: event.operationReceiptId,
    operationKey: event.operationKey,
    sequence: event.sequence,
    evidenceDigest: event.eventHash,
  } as const;
  const result = event.result;
  switch (event.operationKind) {
    case ContextGatewayV4OperationKind.FileRead:
      return Object.freeze({
        ...base,
        operationKind: InvestigationOperationKind.FileRead,
        operationInputHash: manifestString(event.operation.inputHash),
        revision: operationRevision(result.revision),
        treeOid: manifestString(result.treeOid),
        pathHash: manifestString(result.pathHash),
        blobOid: manifestString(result.blobOid),
        mode: manifestString(result.mode),
        startByte: manifestNumber(result.startByte),
        byteCount: manifestNumber(result.byteCount),
        contentHash: manifestString(result.contentHash),
        contentKind: manifestFileContentKind(result.contentKind),
        lineCount:
          result.lineCount === undefined || result.lineCount === null
            ? null
            : manifestNumber(result.lineCount),
        eof: manifestBoolean(result.eof),
        complete: manifestBoolean(result.complete),
      });
    case ContextGatewayV4OperationKind.DirectoryList:
    case ContextGatewayV4OperationKind.TextSearch:
    case ContextGatewayV4OperationKind.CanonicalInventory:
      return Object.freeze({
        ...base,
        operationKind: pageOperationKind(event.operationKind),
        operationInputHash: manifestString(event.operation.inputHash),
        treeOid: manifestString(result.treeOid),
        queryDigest: manifestString(result.queryDigest),
        cursorInputHash: manifestNullableString(result.cursorInputHash),
        pageOrdinal: manifestNumber(result.pageOrdinal),
        pageItemCount: manifestNumber(result.pageItemCount),
        pageItemsHash: manifestString(result.pageItemsHash),
        pagePathHashes: manifestStringArray(result.pagePathHashes),
        aggregatePathCount: manifestNumber(result.aggregatePathCount),
        aggregatePathSetHash: manifestString(result.aggregatePathSetHash),
        aggregateItemCount: manifestNumber(result.aggregateItemCount),
        aggregateHash: manifestString(result.aggregateHash),
        complete: manifestBoolean(result.complete),
        nextCursorHash:
          result.nextCursorHash === null
            ? null
            : manifestString(result.nextCursorHash),
      });
    case ContextGatewayV4OperationKind.GitFact:
      return Object.freeze({
        ...base,
        operationKind: InvestigationOperationKind.GitFact,
        fact: manifestGitFact(result.fact),
        resultHash: manifestString(result.resultHash),
        itemCount: manifestNumber(result.itemCount),
        complete: true as const,
      });
    case ContextGatewayV4OperationKind.UnsupportedTool:
      throw new Error("unsupported_tool_cannot_produce_evidence");
  }
}

function manifestFileContentKind(
  value: unknown,
): InvestigationFileContentKind | null {
  switch (value) {
    case undefined:
      return null;
    case InvestigationFileContentKind.Text:
      return InvestigationFileContentKind.Text;
    case InvestigationFileContentKind.Binary:
      return InvestigationFileContentKind.Binary;
    default:
      throw new Error("context_gateway_v4_file_content_kind_invalid");
  }
}

function pageOperationKind(
  value:
    | ContextGatewayV4OperationKind.DirectoryList
    | ContextGatewayV4OperationKind.TextSearch
    | ContextGatewayV4OperationKind.CanonicalInventory,
) {
  switch (value) {
    case ContextGatewayV4OperationKind.DirectoryList:
      return InvestigationOperationKind.DirectoryList;
    case ContextGatewayV4OperationKind.TextSearch:
      return InvestigationOperationKind.TextSearch;
    case ContextGatewayV4OperationKind.CanonicalInventory:
      return InvestigationOperationKind.CanonicalInventory;
  }
}

function operationRevision(value: unknown): InvestigationOperationRevision {
  if (value === InvestigationOperationRevision.Head) {
    return InvestigationOperationRevision.Head;
  }
  if (value === InvestigationOperationRevision.MergeBase) {
    return InvestigationOperationRevision.MergeBase;
  }
  throw new Error("context_operation_revision_invalid");
}

function manifestGitFact(
  value: unknown,
): "merge_base" | "changed_paths" | "diff_stat" {
  if (
    value === "merge_base" ||
    value === "changed_paths" ||
    value === "diff_stat"
  ) {
    return value;
  }
  throw new Error("context_operation_git_fact_invalid");
}

function manifestString(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("context_operation_shape_invalid");
  return value;
}

function manifestNullableString(value: unknown): string | null {
  if (value === null) return null;
  return manifestString(value);
}

function manifestStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("context_operation_shape_invalid");
  }
  return Object.freeze(value.map((item) => String(item)));
}

function manifestNumber(value: unknown): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error("context_operation_shape_invalid");
  }
  return Number(value);
}

function manifestBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("context_operation_shape_invalid");
  }
  return value;
}

async function investigationScope(
  authorization: ReviewRunAuthorization,
  digest: ReviewActionV2DigestPort,
): Promise<ReviewInvestigationScope> {
  return Object.freeze({
    workspaceId: authorization.workspaceId,
    repositoryConnectionId: authorization.repositoryConnectionId,
    scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
    pullRequestNumber: authorization.pullRequestNumber,
    trustDomain: authorization.trustDomain,
    authorizationScopeHash: await digest.digestUtf8(
      canonicalJson({
        workspaceId: authorization.workspaceId,
        repositoryConnectionId: authorization.repositoryConnectionId,
        scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
        pullRequestNumber: authorization.pullRequestNumber,
      }),
    ),
  });
}

function investigationRevision(
  authorization: ReviewRunAuthorization,
): ReviewInvestigationRevision {
  return Object.freeze({
    baseSha: authorization.baseSha,
    mergeBaseSha: authorization.mergeBaseSha,
    headSha: authorization.headSha,
    reviewRevisionHash: authorization.reviewRevisionHash,
  });
}

function decimal(value: string, field: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw failure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      `${field}_invalid`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw failure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      `${field}_invalid`,
    );
  }
  return parsed;
}

function requireEqual(left: string, right: string, issue: string): void {
  if (left !== right) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      issue,
    );
  }
}

function failure(
  statusCode: ReviewActionV2RouteFailureStatus,
  errorCode: ReviewActionV2ProtocolErrorCode,
  issue: string,
): ReviewActionV2RouteFailure {
  return new ReviewActionV2RouteFailure(statusCode, errorCode, [issue]);
}
