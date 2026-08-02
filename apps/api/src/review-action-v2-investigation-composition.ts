import {
  AbortInvestigationTurn,
  CommitAttestedInvestigationTurn,
  CommitInvestigationTurn,
  ConcludeReviewInvestigation,
  InvestigationExecutionAuthorityVerdict,
  InvestigationReceiptKind,
  OpenReviewInvestigation,
  PlanNextInvestigationTurn,
  ReplayReviewInvestigation,
  RestoreReviewInvestigation,
  ReviewInvestigationAbortReason,
  ReviewInvestigationConclusion,
  ReviewInvestigationNextActionKind,
  ReviewInvestigationRuntimeProfile,
  canonicalInvestigationTurnObservation,
  parseInvestigationTurnObservation,
  type InvestigationClockPort,
  type InvestigationExecutionAuthorityPort,
  type InvestigationStorePort,
  type InvestigationReceiptReplayPort,
  type InvestigationTurnEvidencePort,
  type InvestigationTerminalProjectionPort,
  type ReviewInvestigation,
  type ReviewInvestigationRevision,
  type ReviewInvestigationScope,
  type ReviewInvestigationContract,
  type ReviewInvestigationPolicy,
  type ReviewInvestigationReadModel,
  type SeedInvestigationObligation,
  type InvestigationEvidenceReceipt,
} from "@reviewrouter/features-review-investigations";
import {
  ReviewFindingSeverity,
  reviewEvidencePayloadVersion,
  prepareReviewObservationPayload,
} from "@reviewrouter/features-review-evidence";
import { NodeSha256InvestigationDigest } from "@reviewrouter/features-review-investigations/composition";
import {
  ContextGatewayV4OperationKind,
  ContextGatewayV4OutcomeKind,
  contextGatewayV4PolicyVersion,
  type ContextGatewayV4Manifest,
} from "@reviewrouter/features-review-context-attestation";
import type { ContextAttestationStorePort } from "@reviewrouter/features-review-context-attestation";
import {
  ReviewExecutionState,
  ReviewInvocationLeaseState,
  type ReviewExecutionQueryPort,
} from "@reviewrouter/features-review-executions";
import {
  ReviewRunAuthorizationState,
  ReviewRunAuthorizationTokenResolutionStatus,
  canonicalJson,
  type ReviewRunAuthorization,
  type ReviewRunAuthorizationQueryPort,
  type ReviewRunAuthorizationTokenResolution,
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
  ReviewInvestigationNextAction,
  ReviewInvestigationOpenResultStatus,
  ReviewInvestigationPublishedRuntimeProfile,
  ReviewInvestigationPublishedConclusion,
  ReviewInvestigationPublishedState,
  ReviewInvestigationRestoreResultStatus,
  canonicalizeReviewActionV2Request,
  type ReviewActionV2RequestMap,
  type ReviewInvestigationConcludeRequest,
  type ReviewInvestigationOpenRequest,
  type ReviewInvestigationRestoreRequest,
  type ReviewInvestigationReplayRequest,
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
  VerifiedReviewActionV2LeaseCapability,
} from "./review-action-v2-execution-evidence-capabilities.js";

export type ReviewInvestigationUseCases = Readonly<{
  open: OpenReviewInvestigation;
  restore: RestoreReviewInvestigation;
  planTurn: PlanNextInvestigationTurn;
  commitTurn: CommitAttestedInvestigationTurn;
  abortTurn: AbortInvestigationTurn;
  conclude: ConcludeReviewInvestigation;
  replay: ReplayReviewInvestigation;
}>;

export type ReviewActionV2InvestigationHandlerDependencies = Readonly<{
  authorizations: ReviewActionV2AuthorizationResolverPort;
  authorizationQueries: ReviewRunAuthorizationQueryPort;
  executionQueries: ReviewExecutionQueryPort;
  investigations: ReviewInvestigationUseCases;
  capabilities: ReviewActionV2ExecutionEvidenceCapabilityAdapter;
  digest: ReviewActionV2DigestPort;
  now: () => Date;
}>;

export function composeReviewInvestigationUseCases(input: {
  readonly store: InvestigationStorePort;
  readonly authority: InvestigationExecutionAuthorityPort;
  readonly evidence: InvestigationTurnEvidencePort;
  readonly clock: InvestigationClockPort;
  readonly terminalProjection: InvestigationTerminalProjectionPort;
  readonly receiptReplay: InvestigationReceiptReplayPort;
}): ReviewInvestigationUseCases {
  const digest = new NodeSha256InvestigationDigest();
  const commit = new CommitInvestigationTurn(
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
      input.clock,
    ),
    restore: new RestoreReviewInvestigation(input.store, digest),
    planTurn: new PlanNextInvestigationTurn(
      input.store,
      input.authority,
      digest,
      input.clock,
    ),
    commitTurn: new CommitAttestedInvestigationTurn(
      input.store,
      input.evidence,
      digest,
      commit,
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
      input.clock,
    ),
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

function findingSeverity(value: string): ReviewFindingSeverity {
  switch (value) {
    case ReviewFindingSeverity.Critical:
      return ReviewFindingSeverity.Critical;
    case ReviewFindingSeverity.Major:
      return ReviewFindingSeverity.Major;
    case ReviewFindingSeverity.Minor:
      return ReviewFindingSeverity.Minor;
    default:
      throw new Error("investigation_finding_severity_unsupported");
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
      open(request, d),
    ),
    restore: enabled((request: ReviewInvestigationRestoreRequest) =>
      restore(request, d),
    ),
    planTurn: enabled((request: ReviewInvestigationTurnPlanRequest) =>
      planTurn(request, d),
    ),
    commitTurn: enabled((request: ReviewInvestigationTurnCommitRequest) =>
      commitTurn(request, d),
    ),
    abortTurn: enabled((request: ReviewInvestigationTurnAbortRequest) =>
      abortTurn(request, d),
    ),
    replay: enabled((request: ReviewInvestigationReplayRequest) =>
      replay(request, d),
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
    if (
      !attestation ||
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
      .map((event) =>
        Object.freeze({
          operationReceiptId: event.operationReceiptId!,
          operationKey: event.operationKey,
          kind: receiptKind(event.operationKind),
          evidenceDigest: event.eventHash,
        }),
      );
    return Object.freeze({
      acceptedAttestationId: attestation.attestationId,
      acceptedAttestationHash: attestation.attestationHash,
      terminalOutcomeHash: attestation.terminalOutcomeHash,
      gatewayPolicyVersion: manifest.gatewayPolicyVersion,
      operations: Object.freeze(operations),
    });
  }
}

async function open(
  request: ReviewInvestigationOpenRequest,
  d: ReviewActionV2InvestigationHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewInvestigationOpen,
    request,
    d,
  );
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
  const seedObligations = await canonicalDocument<
    readonly SeedInvestigationObligation[]
  >(request.seedObligationsCanonicalJson, request.seedObligationsHash, d);
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
    runtimeProfile: runtimeProfile(request.runtimeProfile),
    contract,
    policy,
    seedObligations,
    initialReceipts,
  });
  return {
    statusCode: 201 as const,
    result: present(result, ReviewInvestigationOpenResultStatus.Opened),
  };
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
  const plannedAggregate = await d.investigations.restore.snapshot(
    aggregate.investigationId,
  );
  const turnBriefCanonicalJson = canonicalTurnBrief(plannedAggregate, result);
  const turnBriefHash = await d.digest.digestUtf8(turnBriefCanonicalJson);
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
      409,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "investigation_version_mismatch",
    );
  }
  return d.investigations.restore.execute(aggregate.investigationId);
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
  const aggregate = await requireAggregate(
    request.investigationId,
    authorization,
    d,
  );
  const leaseAuthority = await verifyLease(request.leaseCapability, d);
  const lease = await requireLease(leaseAuthority, request, aggregate, d);
  const turnAuthority = await verifyTurnCapability(request.turnCapability, d);
  requireTurnAuthority(turnAuthority, request, aggregate, authorization);
  const observation = await parseCanonicalObservation(request, d);
  const result = await d.investigations.commitTurn.execute({
    commandId: request.idempotencyKey,
    investigationId: request.investigationId,
    expectedVersion: decimal(request.expectedVersion, "expected_version"),
    turnId: request.turnId,
    sourceAttemptId: lease.attemptId!,
    sourceLeaseId: request.sourceLeaseId,
    sourceFencingToken: request.fencingToken,
    acceptedAttestationId: request.acceptedAttestationId,
    acceptedAttestationHash: request.acceptedAttestationHash,
    turnObservationHash: request.turnObservationHash,
    observation,
  });
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
  const leaseAuthority = await verifyLease(request.leaseCapability, d);
  await requireLease(leaseAuthority, request, aggregate, d);
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
  requireEqual(
    aggregate.dossierDigest,
    request.dossierDigest,
    "dossier_digest_mismatch",
  );
  const result = await d.investigations.conclude.execute({
    commandId: request.idempotencyKey,
    investigationId: request.investigationId,
    expectedVersion: decimal(request.expectedVersion, "expected_version"),
    certificateTtlMs: request.certificateTtlMs,
  });
  return {
    statusCode: 201 as const,
    result: present(result, ReviewInvestigationMutationResultStatus.Applied),
  };
}

async function replay(
  request: ReviewInvestigationReplayRequest,
  d: ReviewActionV2InvestigationHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewInvestigationReplay,
    request,
    d,
  );
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  requireEqual(
    authorization.authorizationId,
    request.authorizationId,
    "authorization_id_mismatch",
  );
  await requireExecution(request.targetExecutionId, authorization, d);
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
    sourceCertificateHash: request.sourceCertificateHash,
    targetScope,
    targetRevision,
    targetExecutionId: request.targetExecutionId,
    targetWorkSlotId: request.targetWorkSlotId,
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

function canonicalTurnBrief(
  aggregate: ReviewInvestigation,
  readModel: ReviewInvestigationReadModel,
): string {
  if (!aggregate.activeTurn || !readModel.turn) return canonicalJson(null);
  const obligations = new Map(
    aggregate.obligations.map((obligation) => [
      obligation.obligationId,
      obligation,
    ]),
  );
  return canonicalJson({
    briefVersion: 1,
    investigationId: readModel.investigationId,
    investigationVersion: readModel.version,
    dossierDigest: readModel.dossierDigest,
    turnId: readModel.turn.turnId,
    purpose: readModel.turn.purpose,
    obligations: readModel.turn.obligationIds.map((obligationId) => {
      const obligation = obligations.get(obligationId);
      if (!obligation) throw new Error("investigation_turn_obligation_missing");
      return {
        obligationId: obligation.obligationId,
        kind: obligation.kind,
        canonicalSubject: obligation.canonicalSubject,
        canonicalRequirement: obligation.canonicalRequirement,
        riskPriority: obligation.riskPriority,
        origin: obligation.origin,
      };
    }),
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

async function verifyLease(
  token: string,
  d: ReviewActionV2InvestigationHandlerDependencies,
): Promise<VerifiedReviewActionV2LeaseCapability> {
  try {
    return await d.capabilities.verifyLease(token, d.now());
  } catch {
    throw failure(
      401,
      ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      "lease_capability_invalid",
    );
  }
}

async function requireLease(
  authority: VerifiedReviewActionV2LeaseCapability,
  request: Pick<
    ReviewInvestigationTurnCommitRequest,
    "sourceLeaseId" | "fencingToken"
  >,
  aggregate: ReviewInvestigation,
  d: ReviewActionV2InvestigationHandlerDependencies,
) {
  const lease = await d.executionQueries.findLease(request.sourceLeaseId);
  if (
    !lease ||
    lease.state !== ReviewInvocationLeaseState.Active ||
    lease.attemptId === null ||
    lease.leaseCapabilityId !== authority.capabilityId ||
    lease.authorizationId !== authority.authorizationId ||
    lease.executionId !== aggregate.executionId ||
    lease.workSlotId !== aggregate.workSlotId ||
    lease.reviewRevisionHash !== aggregate.revision.reviewRevisionHash ||
    lease.fencingToken.toString(10) !== request.fencingToken ||
    lease.resultReportUntil <= d.now()
  ) {
    throw failure(
      409,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "investigation_lease_stale",
    );
  }
  return lease;
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
  if (
    authority.authorizationId !== authorization.authorizationId ||
    authority.executionId !== aggregate.executionId ||
    authority.workSlotId !== aggregate.workSlotId ||
    authority.reviewRevisionHash !== aggregate.revision.reviewRevisionHash ||
    authority.investigationId !== request.investigationId ||
    authority.investigationVersion !==
      decimal(request.expectedVersion, "expected_version") ||
    authority.dossierDigest !== aggregate.dossierDigest ||
    authority.turnId !== request.turnId ||
    aggregate.activeTurn?.turnId !== request.turnId
  ) {
    throw failure(
      409,
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

function receiptKind(
  kind: ContextGatewayV4OperationKind,
): InvestigationReceiptKind {
  switch (kind) {
    case ContextGatewayV4OperationKind.FileRead:
      return InvestigationReceiptKind.Blob;
    case ContextGatewayV4OperationKind.DirectoryList:
    case ContextGatewayV4OperationKind.CanonicalInventory:
      return InvestigationReceiptKind.Tree;
    case ContextGatewayV4OperationKind.TextSearch:
      return InvestigationReceiptKind.Search;
    case ContextGatewayV4OperationKind.GitFact:
      return InvestigationReceiptKind.GitFact;
    case ContextGatewayV4OperationKind.UnsupportedTool:
      throw new Error("unsupported_tool_cannot_produce_evidence");
  }
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
      409,
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
