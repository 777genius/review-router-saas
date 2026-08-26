import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type {
  CanaryRunEvidence,
  HostedPoolDeploymentEvidencePort,
  HostedPoolGitHubRequestPort,
  HostedPoolPublicationEvidence,
} from "./hosted-pool-production-ports";
import { fetchBoundedJson } from "./lib/bounded-json-response.js";

/** Reads the exact repository-binding-revision -> grant -> request -> effect graph. */
export async function readExactHostedPoolRunEvidence(input: {
  prisma: PrismaClient;
  runId: number;
  runAttempt: 2;
  repositoryBindingId: string;
  bindingRevision: bigint;
  sourceHeadSha: string;
  publication: HostedPoolPublicationEvidence;
}): Promise<CanaryRunEvidence> {
  if (
    input.publication.appBotPublicationCount +
      input.publication.nonAppBotPublicationCount !==
      input.publication.publicationObjects.length ||
    new Set(
      input.publication.publicationObjects.map(
        (publication) => publication.externalObjectId,
      ),
    ).size !== input.publication.publicationObjects.length
  )
    throw new Error(
      `hosted_pool_canary_publication_cardinality_invalid:${input.runId}`,
    );
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
        attempt.relayRequestId !== grant.relayRequests[0]!.id ||
        attempt.credentialGeneration === null ||
        attempt.credentialGeneration < 1n,
    )
  )
    throw new Error(`hosted_pool_canary_evidence_graph_invalid:${input.runId}`);
  const relayRequest = grant.relayRequests[0]!;
  const successfulAttempt = relayRequest.upstreamAttempts.find(
    (attempt) => attempt.state === "succeeded",
  );
  if (
    successfulAttempt &&
    !/^[a-f0-9]{64}$/u.test(successfulAttempt.providerResponseIdHash ?? "")
  )
    throw new Error(
      `hosted_pool_canary_provider_response_id_missing:${input.runId}`,
    );
  const source = await readExactSourceAndPublicationGraph(input.prisma, {
    runId: input.runId,
    grant,
    sourceHeadSha: input.sourceHeadSha,
    publication: input.publication,
    requirePublication: Boolean(successfulAttempt),
  });
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
    sourceRunAttempt: 2,
    sourceHeadSha: input.sourceHeadSha,
    sourceExecutionId: source.executionId,
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
    providerInvocationKey: grant.providerInvocationKey,
    providerResponseIdHash: successfulAttempt?.providerResponseIdHash ?? null,
    publicationAttemptId: source.publicationAttemptId,
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
      credentialGeneration: attempt.credentialGeneration!.toString(),
      dispatchStartedAt: attempt.dispatchStartedAt?.toISOString() ?? null,
      responseStartedAt: attempt.responseStartedAt?.toISOString() ?? null,
      providerResponseIdHash: attempt.providerResponseIdHash,
      completedAt: attempt.completedAt?.toISOString() ?? null,
      createdAt: attempt.createdAt.toISOString(),
    })),
  };
}

async function readExactSourceAndPublicationGraph(
  prisma: PrismaClient,
  input: {
    runId: number;
    grant: {
      reviewRequestId: string;
      providerInvocationKey: string;
    };
    sourceHeadSha: string;
    publication: HostedPoolPublicationEvidence;
    requirePublication: boolean;
  },
) {
  const intent = await prisma.reviewRequestedIntent.findUnique({
    where: { requestId: input.grant.reviewRequestId },
    select: {
      executionId: true,
      headSha: true,
      sourceRunId: true,
      sourceRunAttempt: true,
    },
  });
  if (
    !intent?.executionId ||
    intent.headSha.toLowerCase() !== input.sourceHeadSha ||
    intent.sourceRunId !== String(input.runId) ||
    intent.sourceRunAttempt !== "2"
  )
    throw new Error(
      `hosted_pool_canary_source_execution_mismatch:${input.runId}`,
    );
  const attempts = await prisma.reviewPublicationAttemptV2.findMany({
    where: {
      executionId: intent.executionId,
      reviewedHeadSha: input.sourceHeadSha,
      state: "terminal",
      terminalOutcome: "succeeded",
    },
    select: { publicationAttemptId: true },
  });
  if (!input.requirePublication) {
    if (
      attempts.length !== 0 ||
      input.publication.publicationObjects.length !== 0 ||
      input.publication.appBotPublicationCount !== 0 ||
      input.publication.nonAppBotPublicationCount !== 0
    )
      throw new Error(
        `hosted_pool_canary_unexpected_publication:${input.runId}`,
      );
    return { executionId: intent.executionId, publicationAttemptId: null };
  }
  const observations = await prisma.reviewEvidenceObservation.findMany({
    where: {
      sourceExecutionId: intent.executionId,
      providerInvocationKey: input.grant.providerInvocationKey,
      sourceHeadSha: input.sourceHeadSha,
      sourceRunId: String(input.runId),
      sourceRunAttempt: "2",
    },
    select: { observationId: true },
  });
  if (observations.length !== 1)
    throw new Error(
      `hosted_pool_canary_provider_observation_mismatch:${input.runId}`,
    );
  const references = await prisma.reviewExecutionObservationRefV2.findMany({
    where: {
      executionId: intent.executionId,
      observationId: observations[0]!.observationId,
      providerInvocationKey: input.grant.providerInvocationKey,
    },
    select: { observationRefId: true },
  });
  if (references.length !== 1)
    throw new Error(
      `hosted_pool_canary_provider_observation_mismatch:${input.runId}`,
    );
  if (attempts.length !== 1 || input.publication.publicationObjects.length < 1)
    throw new Error(
      `hosted_pool_canary_publication_graph_invalid:${input.runId}`,
    );
  const publicationAttemptId = attempts[0]!.publicationAttemptId;
  const [operations, receipts, effects] = await Promise.all([
    prisma.reviewPublicationOperationV2.findMany({
      where: { publicationAttemptId },
      select: { publicationOperationId: true, bodyHash: true, state: true },
    }),
    prisma.reviewPublicationReceiptV2.findMany({
      where: { publicationAttemptId },
      select: {
        publicationOperationId: true,
        canonicalEffectId: true,
        canonicalExternalObjectId: true,
      },
    }),
    prisma.reviewPublicationExternalEffectV2.findMany({
      where: { publicationAttemptId },
      select: {
        effectId: true,
        publicationOperationId: true,
        externalObjectId: true,
      },
    }),
  ]);
  const operationById = new Map(
    operations.map((operation) => [
      operation.publicationOperationId,
      operation,
    ]),
  );
  const effectById = new Map(
    effects.map((effect) => [effect.effectId, effect]),
  );
  const receiptByObject = new Map(
    receipts.map((receipt) => [receipt.canonicalExternalObjectId, receipt]),
  );
  const objectsValid = input.publication.publicationObjects.every((object) => {
    const receipt = receiptByObject.get(object.externalObjectId);
    const operation = receipt
      ? operationById.get(receipt.publicationOperationId)
      : undefined;
    const effect = receipt
      ? effectById.get(receipt.canonicalEffectId)
      : undefined;
    return (
      operation?.state === "completed" &&
      operation.bodyHash === object.bodyHash &&
      effect?.publicationOperationId === receipt?.publicationOperationId &&
      effect?.externalObjectId === object.externalObjectId
    );
  });
  if (!objectsValid)
    throw new Error(
      `hosted_pool_canary_publication_graph_invalid:${input.runId}`,
    );
  return { executionId: intent.executionId, publicationAttemptId };
}

/** Captures immutable publication object identities for later DB-ledger joining. */
export async function collectExactHostedPoolPublicationEvidence(
  github: HostedPoolGitHubRequestPort,
  input: {
    repository: string;
    pullRequestNumber: number;
    expectedAppBot: string;
    startedAt: Date;
    finishedAt: Date;
  },
): Promise<HostedPoolPublicationEvidence> {
  const endpoints = [
    [
      "issue_comment",
      `/repos/${input.repository}/issues/${input.pullRequestNumber}/comments?per_page=100`,
    ],
    [
      "review_comment",
      `/repos/${input.repository}/pulls/${input.pullRequestNumber}/comments?per_page=100`,
    ],
    [
      "review",
      `/repos/${input.repository}/pulls/${input.pullRequestNumber}/reviews?per_page=100`,
    ],
  ] as const;
  const pages = await Promise.all(
    endpoints.map(async ([kind, path]) => {
      const items = await github.request("GET", path);
      if (!Array.isArray(items) || items.length >= 100)
        throw new Error(
          "hosted_pool_canary_publication_pagination_unsupported",
        );
      return items.map((item) => ({ kind, item: item as any }));
    }),
  );
  const publicationObjects = pages.flat().flatMap(({ kind, item }) => {
    const body = String(item?.body ?? "");
    const publishedAt = initialPublicationTimestamp(item);
    const id = item?.id;
    if (
      !publishedAt ||
      publishedAt < input.startedAt ||
      publishedAt > input.finishedAt ||
      !/(?:reviewrouter(?::|-)|review-router-finding:)/iu.test(body)
    )
      return [];
    if ((typeof id !== "number" && typeof id !== "string") || String(id) === "")
      throw new Error("hosted_pool_canary_publication_identity_invalid");
    return [
      {
        kind,
        externalObjectId: String(id),
        bodyHash: createHash("sha256").update(body, "utf8").digest("hex"),
        authorLogin: String(item?.user?.login ?? "").toLowerCase(),
        publishedAt: publishedAt.toISOString(),
      },
    ];
  });
  const appBotPublicationCount = publicationObjects.filter(
    (item) => item.authorLogin === input.expectedAppBot.toLowerCase(),
  ).length;
  return {
    appBotPublicationCount,
    nonAppBotPublicationCount:
      publicationObjects.length - appBotPublicationCount,
    publicationObjects,
  };
}

function initialPublicationTimestamp(item: any): Date | null {
  for (const value of [
    item?.created_at,
    item?.submitted_at,
    item?.updated_at,
  ]) {
    const timestamp = new Date(String(value ?? ""));
    if (Number.isFinite(timestamp.getTime())) return timestamp;
  }
  return null;
}

/** Reads the two immutable live Render deploys without deployment authority. */
export function createRenderHostedPoolDeploymentEvidencePort(input: {
  apiKey: string;
  serviceIds: readonly [string, string];
  now?: () => Date;
  fetchImpl?: typeof fetch;
  renderTimeoutMs?: number;
  renderMaxResponseBytes?: number;
}): HostedPoolDeploymentEvidencePort {
  const renderTimeoutMs = input.renderTimeoutMs ?? 10_000;
  const renderMaxResponseBytes = input.renderMaxResponseBytes ?? 64 * 1024;
  return {
    async readExactRevision(expectedCommitSha) {
      if (!/^[a-f0-9]{40}$/u.test(expectedCommitSha))
        throw new Error("hosted_pool_render_expected_revision_invalid");
      return Promise.all(
        input.serviceIds.map(async (serviceId, index) => {
          const value: any = await fetchBoundedJson({
            fetchImpl: input.fetchImpl ?? fetch,
            url: `https://api.render.com/v1/services/${serviceId}/deploys?limit=1`,
            init: {
              headers: {
                Accept: "application/json",
                Authorization: `Bearer ${input.apiKey}`,
              },
              redirect: "error",
            },
            timeoutMs: renderTimeoutMs,
            maxResponseBytes: renderMaxResponseBytes,
            errors: {
              timeout: "hosted_pool_render_evidence_timeout",
              requestFailed: "hosted_pool_render_evidence_request_failed",
              responseRejected: (status) => `hosted_pool_render_${status}`,
              contentLengthInvalid:
                "hosted_pool_render_evidence_content_length_invalid",
              responseTooLarge:
                "hosted_pool_render_evidence_response_too_large",
              responseInvalid: "hosted_pool_render_evidence_response_invalid",
            },
          });
          const item = Array.isArray(value) ? value[0] : value?.deploys?.[0];
          const deploy = item?.deploy ?? item;
          const commitSha = String(deploy?.commit?.id ?? "").toLowerCase();
          if (
            !deploy?.id ||
            deploy.status !== "live" ||
            commitSha !== expectedCommitSha
          )
            throw new Error(
              `hosted_pool_render_revision_mismatch:${serviceId}`,
            );
          return {
            serviceId,
            serviceName:
              index === 0
                ? ("reviewrouter-api" as const)
                : ("reviewrouter-web" as const),
            deployId: String(deploy.id),
            commitSha,
            status: "live" as const,
            observedAt: (input.now ?? (() => new Date()))().toISOString(),
          };
        }),
      );
    },
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
      dispatchStartedAt: Date | null;
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
      const reservationBoundary = attempt.createdAt;
      const dispatchBoundary = attempt.dispatchStartedAt ?? attempt.completedAt;
      if (
        !dispatchBoundary ||
        consumedAt < requestStartedAt ||
        consumedAt < reservationBoundary ||
        consumedAt > dispatchBoundary
      )
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
