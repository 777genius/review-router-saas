import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { expect } from "vitest";
import type { CanaryPhaseScope } from "./hosted-pool-canary-phase-recovery";
import type { CanaryRunEvidence } from "./hosted-pool-production-ports";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Read persisted relay evidence. This fixture never runs publication; the
 * production read adapter requires publication for successful relay attempts,
 * so it cannot represent this deliberately incomplete production canary.
 */
export async function readCanaryPgObservation(
  prisma: PrismaClient,
  grantId: string,
  scope: CanaryPhaseScope,
) {
  const stored = await prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
    where: { id: grantId },
    include: {
      binding: {
        select: { workflowActionRef: true, attestedGithubRepositoryId: true },
      },
      commentRefreshCapability: { select: { revokedAt: true } },
      relayRequests: {
        include: { upstreamAttempts: { orderBy: { attemptOrdinal: "asc" } } },
        orderBy: { ordinal: "asc" },
      },
    },
  });
  const source = await prisma.reviewRequestedIntent.findUniqueOrThrow({
    where: { requestId: stored.reviewRequestId },
    select: {
      headSha: true,
      sourceRunId: true,
      sourceRunAttempt: true,
      executionId: true,
    },
  });
  expect(source.sourceRunId).toBe(String(scope.runId));
  expect(source.sourceRunAttempt).toBe("2");
  if (
    !source.executionId ||
    !stored.binding.workflowActionRef ||
    !stored.binding.attestedGithubRepositoryId
  )
    throw new Error("canary_pg_source_or_binding_missing");
  expect(
    await prisma.reviewPublicationAttemptV2.count({
      where: { executionId: source.executionId },
    }),
  ).toBe(0);
  expect(stored.relayRequests).toHaveLength(1);
  const request = stored.relayRequests[0]!;
  const events = await prisma.auditEvent.findMany({
    where: {
      workspaceId: stored.workspaceId,
      action: "hosted_codex_canary_fault_plan_consumed",
      metadata: { path: ["runId"], equals: String(scope.runId) },
    },
    select: { targetId: true, metadata: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  expect(events).toHaveLength(1);
  const faultPlanConsumptions = events.map((event) => {
    const exactMetadata = {
      planIdHash: scope.planIdHash,
      phase: (
        {
          unauthorized: "synthetic_unauthorized",
          rate_limited: "synthetic_rate_limited",
          dropped_response: "drop_after_response_started",
        } as const
      )[scope.phase],
      repositoryId: String(scope.repositoryId),
      runAttempt: 2,
      actionRef: `777genius/review-router@${scope.actionSha}`,
      bindingId: scope.repositoryBindingId,
      bindingRevision: scope.bindingRevision,
      requestOrdinal: 1,
      attemptOrdinal: 1,
      injectionPoint:
        scope.phase === "dropped_response"
          ? ("after_response_started" as const)
          : ("before_provider_fetch" as const),
    };
    expect(event.targetId).toBe(scope.planIdHash);
    expect(event.metadata).toMatchObject({
      ...exactMetadata,
      runId: String(scope.runId),
    });
    return { ...exactMetadata, consumedAt: event.createdAt.toISOString() };
  });
  const observed: CanaryRunEvidence = {
    runId: Number(source.sourceRunId),
    sourceRunAttempt: 2,
    sourceHeadSha: source.headSha,
    sourceExecutionId: source.executionId,
    grantId: stored.id,
    invocationId: stored.invocationId,
    workspaceId: stored.workspaceId,
    githubRepositoryId: stored.binding.attestedGithubRepositoryId.toString(),
    actionRef: stored.binding.workflowActionRef,
    activeAccountId: stored.activeAccountId,
    primaryAccountId: stored.primaryAccountId,
    backupAccountId: stored.backupAccountId,
    failoverCount: stored.failoverCount,
    grantStatus: stored.status,
    grantRevokedAt: stored.revokedAt?.toISOString() ?? null,
    commentRefreshRevokedAt:
      stored.commentRefreshCapability?.revokedAt?.toISOString() ?? null,
    repositoryBindingId: stored.repositoryBindingId,
    bindingRevision: stored.bindingRevision.toString(),
    issuedAt: stored.issuedAt.toISOString(),
    completedAt: request.completedAt?.toISOString() ?? null,
    requestId: request.id,
    requestOrdinal: request.ordinal,
    requestErrorCode: request.errorCode,
    requestReceivedAt: request.receivedAt.toISOString(),
    requestStartedAt: request.startedAt?.toISOString() ?? null,
    successfulResponseStartedAt:
      request.successfulResponseStartedAt?.toISOString() ?? null,
    providerInvocationKey: stored.providerInvocationKey,
    providerResponseIdHash:
      request.upstreamAttempts.find((attempt) => attempt.state === "succeeded")
        ?.providerResponseIdHash ?? null,
    publicationAttemptId: null,
    appBotPublicationCount: 0,
    nonAppBotPublicationCount: 0,
    publicationObjects: [],
    faultPlanConsumptionCount: faultPlanConsumptions.length,
    faultPlanConsumptions,
    requestStatuses: stored.relayRequests.map((relay) => relay.status),
    attempts: request.upstreamAttempts.map((attempt) => {
      if (attempt.credentialGeneration === null)
        throw new Error("canary_pg_effect_generation_missing");
      return {
        attemptId: attempt.id,
        relayRequestId: attempt.relayRequestId,
        grantId: attempt.grantId,
        ordinal: attempt.attemptOrdinal,
        state: attempt.state,
        errorCode: attempt.errorCode,
        accountId: attempt.accountId,
        credentialGeneration: attempt.credentialGeneration.toString(),
        dispatchStartedAt: attempt.dispatchStartedAt?.toISOString() ?? null,
        responseStartedAt: attempt.responseStartedAt?.toISOString() ?? null,
        providerResponseIdHash: attempt.providerResponseIdHash,
        completedAt: attempt.completedAt?.toISOString() ?? null,
        createdAt: attempt.createdAt.toISOString(),
      };
    }),
  };
  return { stored, observed };
}

/** Minimal, real FK graph for the canary's source execution, no publication. */
export async function seedCanaryPgSourceCatalog(prisma: PrismaClient) {
  const now = new Date();
  await prisma.scmRepositoryIdentity.create({
    data: {
      scmRepositoryIdentityId: "phase-scm",
      provider: "github",
      normalizedSourceBaseUrl: "https://github.com",
      externalRepositoryId: "123456789",
      createdAt: now,
    },
  });
  await prisma.repositoryConnection.update({
    where: { id: "phase-repository" },
    data: { scmRepositoryIdentityId: "phase-scm" },
  });
  await prisma.reviewProtocolLimitsV2.create({
    data: {
      protocolLimitsProfileId: "phase-limits",
      limitsDigest: sha("limits"),
      maxWorkSlots: 1,
      maxAttemptsPerSlot: 1,
      maxObservationBytes: 4096,
      maxObservationFindings: 10,
      maxProjectionBytes: 4096,
      maxProjectionFindings: 10,
      maxPublicationOperations: 10,
      maxPublicationChunks: 10,
      maxPublicationBodyBytes: 4096,
      maxRequestBatchSize: 1,
      maxLeaseDurationMs: 60000,
      maxResultReportDurationMs: 60000,
      maxReconciliationDurationMs: 60000,
      registeredAt: now,
    },
  });
  await prisma.reviewOperationalSloProfileV2.create({
    data: {
      operationalSloProfileId: "phase-slo",
      sloDigest: sha("slo"),
      integrationEventDeliveryMs: 1000,
      outboxClaimAgeMs: 1000,
      missingCompletionProcessMs: 1000,
      dueCompletionProcessMs: 1000,
      publicationReconciliationMs: 1000,
      v1DrainMs: 1000,
      admissionMs: 1000,
      pruningBacklogAgeMs: 1000,
      ownerRefs: ["fixture"],
      runbookRefs: ["fixture"],
      registeredAt: now,
    },
  });
  await prisma.producerRelease.create({
    data: {
      producerReleaseId: "phase-release",
      distributionKind: "public_reusable",
      actionCommitSha: "a".repeat(40),
      runtimeCommitSha: "a".repeat(40),
      runtimeEntrypointDigest: sha("entrypoint"),
      schemaDigest: sha("schema"),
      capabilityProfile: "fixture",
      protocolLimitsProfileId: "phase-limits",
      operationalSloProfileId: "phase-slo",
      registeredAt: now,
    },
  });
}

export async function seedCanaryPgSourceExecution(
  prisma: PrismaClient,
  runId: number,
  issued: Date,
  expires: Date,
) {
  const scope = {
    workspaceId: "phase-workspace",
    repositoryConnectionId: "phase-repository",
    scmRepositoryIdentityId: "phase-scm",
    pullRequestNumber: runId,
  };
  const revision = {
    baseSha: "c".repeat(40),
    mergeBaseSha: "c".repeat(40),
    headSha: "c".repeat(40),
    reviewRevisionHash: sha(String(runId)),
  };
  const source = { sourceRunId: String(runId), sourceRunAttempt: "2" };
  await prisma.reviewRunAuthorization.create({
    data: {
      ...scope,
      ...revision,
      ...source,
      authorizationId: `phase-authorization-${runId}`,
      workflowIdentityHash: sha("workflow"),
      trustDomain: "trusted_managed",
      producerReleaseId: "phase-release",
      selectedProtocolVersion: "2",
      schemaDigest: sha("schema"),
      protocolLimitsProfileId: "phase-limits",
      operationalSloProfileId: "phase-slo",
      mutationEpoch: 1n,
      providerVoteLanes: [],
      authorizationSafetyDecisionHash: sha("safety"),
      protocolOfferHash: sha("offer"),
      oidcReplayKeyHash: sha(`oidc-${runId}`),
      tokenSigningKeyId: "fixture",
      tokenIssuer: "fixture",
      tokenAudience: "fixture",
      expiresAt: expires,
      maxExpiresAt: expires,
      createdAt: issued,
    },
  });
  await prisma.reviewExecutionV2.create({
    data: {
      ...scope,
      ...revision,
      ...source,
      executionId: `execution-${runId}`,
      generation: 1n,
      compatibilityKey: sha("compatibility"),
      planHash: sha("plan"),
      startIdentityHash: sha(`start-${runId}`),
      canonicalStartHash: sha(`canonical-${runId}`),
      authorizationId: `phase-authorization-${runId}`,
      producerReleaseId: "phase-release",
      mutationEpoch: 1n,
      admissionSafetyDecisionHash: sha("safety"),
      protocolLimitsProfileId: "phase-limits",
      createdAt: issued,
      updatedAt: issued,
      admissionDeadlineAt: expires,
      executionDeadlineAt: expires,
      retainUntil: expires,
    },
  });
  await prisma.reviewRequestedIntent.create({
    data: {
      ...scope,
      ...revision,
      ...source,
      requestId: `phase-review-${runId}`,
      triggerKind: "pull_request_synchronized",
      deliveryIdentityHash: sha(`delivery-${runId}`),
      canonicalRequestHash: sha(`request-${runId}`),
      notBefore: issued,
      executionId: `execution-${runId}`,
      createdAt: issued,
      updatedAt: issued,
      retainUntil: expires,
    },
  });
}
