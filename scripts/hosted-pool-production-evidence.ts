import type { PrismaClient } from "@prisma/client";
import type {
  CanaryRunEvidence,
  HostedPoolPublicationEvidence,
} from "./hosted-pool-production-ports";

/** Reads the exact repository-binding-revision -> grant -> request -> effect graph. */
export async function readExactHostedPoolRunEvidence(input: {
  prisma: PrismaClient;
  runId: number;
  runAttempt: 2;
  repositoryBindingId: string;
  bindingRevision: bigint;
  publication: HostedPoolPublicationEvidence;
}): Promise<CanaryRunEvidence> {
  const grants = await input.prisma.hostedCodexInvocationGrant.findMany({
    where: {
      runId: String(input.runId),
      runAttempt: input.runAttempt,
      repositoryBindingId: input.repositoryBindingId,
      bindingRevision: input.bindingRevision,
    },
    include: {
      binding: {
        select: {
          workflowActionRef: true,
          attestedGithubRepositoryId: true,
        },
      },
      commentRefreshCapability: { select: { revokedAt: true } },
      relayRequests: {
        include: {
          upstreamAttempts: { orderBy: { attemptOrdinal: "asc" } },
        },
        orderBy: { ordinal: "asc" },
      },
    },
  });
  if (grants.length !== 1)
    throw new Error(`hosted_pool_canary_grant_cardinality:${input.runId}`);
  const grant = grants[0]!;
  if (
    grant.repositoryBindingId !== input.repositoryBindingId ||
    grant.bindingRevision !== input.bindingRevision ||
    !grant.binding.workflowActionRef ||
    !grant.binding.attestedGithubRepositoryId ||
    grant.relayRequests.length !== 1 ||
    grant.relayRequests[0]!.ordinal !== 1 ||
    grant.relayRequests[0]!.upstreamAttempts.some(
      (attempt, index) =>
        attempt.attemptOrdinal !== index + 1 ||
        attempt.grantId !== grant.id ||
        attempt.relayRequestId !== grant.relayRequests[0]!.id,
    )
  )
    throw new Error(`hosted_pool_canary_evidence_graph_invalid:${input.runId}`);
  const relayRequest = grant.relayRequests[0]!;
  assertExactGraphTimestamps(grant.issuedAt, relayRequest);
  const faultEvents = await input.prisma.auditEvent.findMany({
    where: {
      workspaceId: grant.workspaceId,
      action: "hosted_codex_canary_fault_plan_consumed",
      metadata: { path: ["runId"], equals: String(input.runId) },
    },
    orderBy: { createdAt: "asc" },
    select: { targetId: true, metadata: true, createdAt: true },
  });
  const faultPlanConsumptions = faultEvents.map((event) =>
    readFaultConsumption(event, {
      runId: input.runId,
      runAttempt: input.runAttempt,
      githubRepositoryId: grant.binding.attestedGithubRepositoryId!,
      actionRef: grant.binding.workflowActionRef!,
      bindingId: grant.repositoryBindingId,
      bindingRevision: grant.bindingRevision,
      requestOrdinal: relayRequest.ordinal,
      attemptOrdinal: relayRequest.upstreamAttempts[0]?.attemptOrdinal ?? 1,
    }),
  );
  assertFaultConsumptionTimestamps(faultPlanConsumptions, relayRequest);
  return {
    runId: input.runId,
    grantId: grant.id,
    invocationId: grant.invocationId,
    workspaceId: grant.workspaceId,
    githubRepositoryId: grant.binding.attestedGithubRepositoryId.toString(),
    actionRef: grant.binding.workflowActionRef,
    activeAccountId: grant.activeAccountId,
    primaryAccountId: grant.primaryAccountId,
    backupAccountId: grant.backupAccountId,
    failoverCount: grant.failoverCount,
    grantStatus: grant.status,
    grantRevokedAt: grant.revokedAt?.toISOString() ?? null,
    commentRefreshRevokedAt:
      grant.commentRefreshCapability?.revokedAt?.toISOString() ?? null,
    repositoryBindingId: grant.repositoryBindingId,
    bindingRevision: grant.bindingRevision.toString(),
    issuedAt: grant.issuedAt.toISOString(),
    completedAt: relayRequest.completedAt?.toISOString() ?? null,
    requestId: relayRequest.id,
    requestOrdinal: relayRequest.ordinal,
    requestErrorCode: relayRequest.errorCode,
    requestReceivedAt: relayRequest.receivedAt.toISOString(),
    requestStartedAt: relayRequest.startedAt?.toISOString() ?? null,
    successfulResponseStartedAt:
      relayRequest.successfulResponseStartedAt?.toISOString() ?? null,
    ...input.publication,
    faultPlanConsumptionCount: faultPlanConsumptions.length,
    faultPlanConsumptions,
    requestStatuses: grant.relayRequests.map((request) => request.status),
    attempts: relayRequest.upstreamAttempts.map((attempt) => ({
      attemptId: attempt.id,
      relayRequestId: attempt.relayRequestId,
      grantId: attempt.grantId,
      ordinal: attempt.attemptOrdinal,
      state: attempt.state,
      errorCode: attempt.errorCode,
      accountId: attempt.accountId,
      dispatchStartedAt: attempt.dispatchStartedAt?.toISOString() ?? null,
      responseStartedAt: attempt.responseStartedAt?.toISOString() ?? null,
      completedAt: attempt.completedAt?.toISOString() ?? null,
      createdAt: attempt.createdAt.toISOString(),
    })),
  };
}

function assertFaultConsumptionTimestamps(
  consumptions: CanaryRunEvidence["faultPlanConsumptions"],
  request: {
    receivedAt: Date;
    startedAt: Date | null;
    successfulResponseStartedAt: Date | null;
    completedAt: Date | null;
    upstreamAttempts: readonly {
      createdAt: Date;
      responseStartedAt: Date | null;
      completedAt: Date | null;
    }[];
  },
) {
  const requestStartedAt = request.startedAt ?? request.receivedAt;
  const attempt = request.upstreamAttempts[0];
  for (const consumption of consumptions) {
    const consumedAt = new Date(consumption.consumedAt);
    if (!Number.isFinite(consumedAt.getTime()) || !attempt)
      throw new Error("hosted_pool_canary_fault_evidence_timestamps_invalid");
    if (consumption.injectionPoint === "before_provider_fetch") {
      if (consumedAt < requestStartedAt || consumedAt > attempt.createdAt)
        throw new Error("hosted_pool_canary_fault_evidence_timestamps_invalid");
      continue;
    }
    if (
      !attempt.responseStartedAt ||
      !attempt.completedAt ||
      !request.completedAt ||
      consumedAt < attempt.responseStartedAt ||
      consumedAt > attempt.completedAt ||
      consumedAt > request.completedAt
    )
      throw new Error("hosted_pool_canary_fault_evidence_timestamps_invalid");
  }
}

function readFaultConsumption(
  event: { targetId: string; metadata: unknown; createdAt: Date },
  expected: {
    runId: number;
    runAttempt: number;
    githubRepositoryId: bigint;
    actionRef: string;
    bindingId: string;
    bindingRevision: bigint;
    requestOrdinal: number;
    attemptOrdinal: number;
  },
): CanaryRunEvidence["faultPlanConsumptions"][number] {
  const metadata = event.metadata as Record<string, unknown> | null;
  const phase = metadata?.phase;
  const injectionPoint = metadata?.injectionPoint;
  const validPhase =
    phase === "synthetic_unauthorized" ||
    phase === "synthetic_rate_limited" ||
    phase === "drop_after_response_started";
  const expectedInjectionPoint =
    phase === "drop_after_response_started"
      ? "after_response_started"
      : "before_provider_fetch";
  if (
    !/^[a-f0-9]{64}$/u.test(event.targetId) ||
    metadata?.planIdHash !== event.targetId ||
    metadata?.repositoryId !== expected.githubRepositoryId.toString() ||
    metadata?.runId !== String(expected.runId) ||
    metadata?.runAttempt !== expected.runAttempt ||
    metadata?.actionRef !== expected.actionRef ||
    metadata?.bindingId !== expected.bindingId ||
    metadata?.bindingRevision !== expected.bindingRevision.toString() ||
    metadata?.requestOrdinal !== expected.requestOrdinal ||
    metadata?.attemptOrdinal !== expected.attemptOrdinal ||
    !validPhase ||
    injectionPoint !== expectedInjectionPoint
  )
    throw new Error(
      `hosted_pool_canary_fault_evidence_graph_invalid:${expected.runId}`,
    );
  return {
    planIdHash: event.targetId,
    phase,
    repositoryId: String(metadata.repositoryId),
    runAttempt: Number(metadata.runAttempt),
    actionRef: String(metadata.actionRef),
    bindingId: String(metadata.bindingId),
    bindingRevision: String(metadata.bindingRevision),
    requestOrdinal: Number(metadata.requestOrdinal),
    attemptOrdinal: Number(metadata.attemptOrdinal),
    injectionPoint: expectedInjectionPoint,
    consumedAt: event.createdAt.toISOString(),
  };
}

function assertExactGraphTimestamps(
  issuedAt: Date,
  request: {
    receivedAt: Date;
    startedAt: Date | null;
    successfulResponseStartedAt: Date | null;
    completedAt: Date | null;
    upstreamAttempts: readonly {
      createdAt: Date;
      dispatchStartedAt: Date | null;
      responseStartedAt: Date | null;
      completedAt: Date | null;
    }[];
  },
) {
  const invalid = () => {
    throw new Error("hosted_pool_canary_evidence_timestamps_invalid");
  };
  if (request.receivedAt < issuedAt) invalid();
  if (request.startedAt && request.startedAt < request.receivedAt) invalid();
  if (
    request.successfulResponseStartedAt &&
    (!request.startedAt ||
      request.successfulResponseStartedAt < request.startedAt ||
      (request.completedAt &&
        request.successfulResponseStartedAt > request.completedAt))
  )
    invalid();
  if (
    request.completedAt &&
    request.completedAt < (request.startedAt ?? request.receivedAt)
  )
    invalid();
  for (const attempt of request.upstreamAttempts) {
    if (attempt.createdAt < request.receivedAt) invalid();
    if (
      attempt.dispatchStartedAt &&
      attempt.dispatchStartedAt < attempt.createdAt
    )
      invalid();
    if (
      attempt.responseStartedAt &&
      (!attempt.dispatchStartedAt ||
        attempt.responseStartedAt < attempt.dispatchStartedAt)
    )
      invalid();
    if (
      attempt.completedAt &&
      attempt.completedAt <
        (attempt.responseStartedAt ??
          attempt.dispatchStartedAt ??
          attempt.createdAt)
    )
      invalid();
    if (
      request.completedAt &&
      attempt.completedAt &&
      attempt.completedAt > request.completedAt
    )
      invalid();
  }
  if (
    request.successfulResponseStartedAt &&
    !request.upstreamAttempts.some(
      (attempt) =>
        attempt.responseStartedAt?.getTime() ===
        request.successfulResponseStartedAt?.getTime(),
    )
  )
    invalid();
  if (
    request.completedAt &&
    request.upstreamAttempts.length > 0 &&
    !request.upstreamAttempts.some(
      (attempt) =>
        attempt.completedAt?.getTime() === request.completedAt?.getTime(),
    )
  )
    invalid();
}
