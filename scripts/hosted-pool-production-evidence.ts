import { createHash } from "node:crypto";
import { GITHUB_RUN_CLOCK_TOLERANCE_MS } from "./hosted-pool-production-github-dispatch";
import { canonicalReviewPublicationJson as canonicalJson } from "../packages/features/review-publishing/src/v2/domain/canonical-review-publication-json";
import {
  renderCanonicalReviewPublication,
  resolveReviewPublicationRenderPolicyVersion,
  type ReviewPublicationRenderingSource,
  type ReviewPublicationOccurrenceState,
} from "../packages/features/review-publishing/src/v2/domain/canonical-review-publication-renderer";
import { ReviewPublicationProjectionCoverage } from "../packages/features/review-publishing/src/v2/domain/review-publication-operation-planning";
const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
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
    !Number.isSafeInteger(input.publication.appBotPublicationCount) ||
    input.publication.appBotPublicationCount < 0 ||
    !Number.isSafeInteger(input.publication.nonAppBotPublicationCount) ||
    input.publication.nonAppBotPublicationCount < 0 ||
    input.publication.publicationObjects.some(
      (object) =>
        !publicationKinds.includes(object.kind) ||
        !validObjectId(object.externalObjectId) ||
        !/^[a-f0-9]{64}$/u.test(object.bodyHash),
    ) ||
    input.publication.appBotPublicationCount +
      input.publication.nonAppBotPublicationCount !==
      input.publication.publicationObjects.length ||
    new Set(
      input.publication.publicationObjects.map((publication) =>
        artifactKey(publication),
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
    },
    select: {
      publicationAttemptId: true,
      executionId: true,
      reviewedHeadSha: true,
      state: true,
      terminalOutcome: true,
      generation: true,
      projectionHash: true,
      reviewRevisionHash: true,
    },
  });
  if (!input.requirePublication) {
    if (
      (input.publication.lifecycleThreads ?? []).some(
        (thread) => thread.changed,
      ) ||
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
    },
    select: {
      observationId: true,
      sourceExecutionId: true,
      providerInvocationKey: true,
      sourceHeadSha: true,
      sourceRunId: true,
      sourceRunAttempt: true,
    },
  });
  if (
    observations.length !== 1 ||
    observations[0]?.sourceExecutionId !== intent.executionId ||
    observations[0]?.providerInvocationKey !==
      input.grant.providerInvocationKey ||
    observations[0]?.sourceHeadSha !== input.sourceHeadSha ||
    observations[0]?.sourceRunId !== String(input.runId) ||
    observations[0]?.sourceRunAttempt !== "2"
  )
    throw new Error(
      `hosted_pool_canary_provider_observation_mismatch:${input.runId}`,
    );
  const references = await prisma.reviewExecutionObservationRefV2.findMany({
    where: {
      executionId: intent.executionId,
    },
    select: {
      observationRefId: true,
      executionId: true,
      observationId: true,
      providerInvocationKey: true,
    },
  });
  if (
    references.length !== 1 ||
    references[0]?.executionId !== intent.executionId ||
    references[0]?.observationId !== observations[0]!.observationId ||
    references[0]?.providerInvocationKey !== input.grant.providerInvocationKey
  )
    throw new Error(
      `hosted_pool_canary_provider_observation_mismatch:${input.runId}`,
    );
  if (
    attempts.length !== 1 ||
    input.publication.publicationObjects.length < 1 ||
    attempts[0]?.executionId !== intent.executionId ||
    attempts[0]?.reviewedHeadSha !== input.sourceHeadSha ||
    attempts[0]?.state !== "terminal" ||
    attempts[0]?.terminalOutcome !== "succeeded"
  )
    throw new Error(
      `hosted_pool_canary_publication_graph_invalid:${input.runId}`,
    );
  const publicationAttemptId = attempts[0]!.publicationAttemptId;
  const invalid = () => {
    throw new Error(
      `hosted_pool_canary_publication_graph_invalid:${input.runId}`,
    );
  };
  const operations = await prisma.reviewPublicationOperationV2.findMany({
    where: { publicationAttemptId },
    select: {
      publicationOperationId: true,
      publicationAttemptId: true,
      publicationKind: true,
      targetCommitId: true,
      bodyHash: true,
      state: true,
      required: true,
      chunkIndex: true,
      markerHash: true,
      renderPolicyVersion: true,
      dependsOnOperationId: true,
    },
  });
  const operationIds = operations.map(
    (operation) => operation.publicationOperationId,
  );
  // OR exposes cross-attempt links instead of hiding them behind an attempt filter.
  const linkedScope = {
    OR: [
      { publicationAttemptId },
      { publicationOperationId: { in: operationIds } },
    ],
  };
  const [receipts, effects] = await Promise.all([
    prisma.reviewPublicationReceiptV2.findMany({
      where: linkedScope,
      select: {
        receiptId: true,
        publicationAttemptId: true,
        publicationOperationId: true,
        canonicalEffectId: true,
        canonicalExternalObjectId: true,
        status: true,
      },
    }),
    prisma.reviewPublicationExternalEffectV2.findMany({
      where: linkedScope,
      select: {
        effectId: true,
        publicationAttemptId: true,
        publicationOperationId: true,
        externalObjectId: true,
        effectKind: true,
      },
    }),
  ]);
  const unique = (ids: readonly string[]) =>
    ids.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(ids).size === ids.length;
  const successful = operations.filter(
    (operation) => operation.state === "completed",
  );
  const objects = input.publication.publicationObjects;
  if (
    !unique(operationIds) ||
    !unique(effects.map((effect) => effect.effectId)) ||
    !unique(receipts.map((receipt) => receipt.receiptId)) ||
    !unique(receipts.map((receipt) => receipt.publicationOperationId)) ||
    !unique(receipts.map((receipt) => receipt.canonicalEffectId)) ||
    receipts.length !== successful.length ||
    operations.some(
      (operation) =>
        operation.publicationAttemptId !== publicationAttemptId ||
        operation.targetCommitId !== input.sourceHeadSha ||
        (operation.state !== "completed" &&
          !(
            !operation.required &&
            (operation.state === "superseded_no_effect" ||
              operation.state === "failed_no_effect")
          )),
    )
  )
    invalid();
  // Multiple reports may be legitimate, but require correction/canonical-selection proofs
  // beyond this bounded reader. Never collapse or discard the additional reports.
  if (
    effects.length !== receipts.length ||
    !unique(effects.map((effect) => effect.publicationOperationId))
  )
    throw new Error(
      `hosted_pool_canary_publication_effect_history_unsupported:${input.runId}`,
    );
  const operationById = new Map(
    operations.map((operation) => [
      operation.publicationOperationId,
      operation,
    ]),
  );
  const effectById = new Map(
    effects.map((effect) => [effect.effectId, effect]),
  );
  const receiptByOperation = new Map(
    receipts.map((receipt) => [receipt.publicationOperationId, receipt]),
  );
  const objectByKey = new Map(
    objects.map((object) => [artifactKey(object), object]),
  );
  const joined = new Set<string>();
  const reviewOwners = new Map<string, number>();
  const threads = input.publication.lifecycleThreads ?? [];
  if (
    !unique(threads.map((thread) => thread.threadId)) ||
    threads.some(
      (thread) =>
        typeof thread.resolve !== "boolean" ||
        typeof thread.changed !== "boolean",
    )
  )
    invalid();
  const joinedThreads = new Set<string>();

  // The final submitted review cannot reveal its overwritten create body. Read the
  // persisted finalized projection, bind it to this attempt and use the SAME renderer.
  const artifact = await prisma.finalizedReviewProjectionArtifactV2.findUnique({
    where: { executionId: intent.executionId },
  });
  const publicationAttempt = attempts[0]!;
  if (
    !artifact ||
    artifact.executionId !== intent.executionId ||
    artifact.reviewedHeadSha !== input.sourceHeadSha ||
    artifact.generation !== publicationAttempt.generation ||
    artifact.reviewRevisionHash !== publicationAttempt.reviewRevisionHash ||
    artifact.projectionHash !== publicationAttempt.projectionHash ||
    digest(artifact.projectionEnvelopeCanonicalJson) !== artifact.projectionHash
  )
    throw new Error(
      `hosted_pool_canary_publication_rendering_facts_missing:${input.runId}`,
    );
  const projection = JSON.parse(artifact!.projectionEnvelopeCanonicalJson) as {
    envelopeVersion: string;
    publishing: ReviewPublicationRenderingSource;
    occurrences: { state: ReviewPublicationOccurrenceState }[];
  };
  if (
    canonicalJson(projection) !== artifact!.projectionEnvelopeCanonicalJson ||
    projection.envelopeVersion !== "review_projection.v1" ||
    !["completed", "partial"].includes(artifact!.coverageState)
  )
    invalid();
  const policy = resolveReviewPublicationRenderPolicyVersion(
    artifact!.projectionPolicyVersion,
  );
  const rendered = renderCanonicalReviewPublication(
    {
      coverage:
        artifact!.coverageState === "partial"
          ? ReviewPublicationProjectionCoverage.Partial
          : ReviewPublicationProjectionCoverage.Completed,
      renderPolicyVersion: policy,
      targetCommitId: input.sourceHeadSha,
      occurrenceStates: projection.occurrences.map((entry) => entry.state),
      source: projection.publishing,
    },
    {
      digestUtf8: digest,
      utf8ByteLength: (value) => Buffer.byteLength(value, "utf8"),
    },
  );
  const expected = new Map<string, { markerHash: string; bodyHash: string }>([
    ["summary:0", rendered.summary],
    ...(rendered.managedCheck
      ? [["managed_check:0", rendered.managedCheck] as const]
      : []),
    ...rendered.inlineReviews.flatMap((chunk) => [
      [`pending_review_create:${chunk.chunkIndex}`, chunk.create] as const,
      [`pending_review_submit:${chunk.chunkIndex}`, chunk.submit] as const,
    ]),
    ...rendered.lifecycle.map(
      (entry) => [`thread_lifecycle:${entry.chunkIndex}`, entry] as const,
    ),
  ]);
  if (
    operations.length !== expected.size ||
    !unique(operations.map((op) => `${op.publicationKind}:${op.chunkIndex}`))
  )
    invalid();
  for (const operation of operations) {
    if (
      ![
        "summary",
        "managed_check",
        "pending_review_create",
        "pending_review_submit",
        "thread_lifecycle",
      ].includes(operation.publicationKind)
    )
      throw new Error(
        `hosted_pool_canary_publication_kind_unsupported:${operation.publicationKind}:${input.runId}`,
      );
    const facts = expected.get(
      `${operation.publicationKind}:${operation.chunkIndex}`,
    );
    if (
      // Every operation generated by the canonical planner for this projection is
      // required. Stored optional flags cannot downgrade these rendering facts.
      !facts ||
      operation.required !== true ||
      operation.markerHash !== facts.markerHash ||
      operation.bodyHash !== facts.bodyHash ||
      operation.renderPolicyVersion !== policy
    )
      invalid();
  }
  for (const receipt of receipts) {
    const operation = operationById.get(receipt.publicationOperationId);
    const effect = effectById.get(receipt.canonicalEffectId);
    if (
      !operation ||
      operation.state !== "completed" ||
      receipt.status !== "succeeded" ||
      receipt.publicationAttemptId !== publicationAttemptId ||
      effect?.publicationAttemptId !== publicationAttemptId ||
      effect.publicationOperationId !== receipt.publicationOperationId ||
      effect.externalObjectId !== receipt.canonicalExternalObjectId ||
      (effect.effectKind !== "mutation_acknowledged" &&
        effect.effectKind !== "marker_reconciled")
    )
      invalid();
    const op = operation!;
    if (op.publicationKind === "thread_lifecycle") {
      const lifecycle = rendered.lifecycle.find(
        (entry) => entry.chunkIndex === op.chunkIndex,
      );
      const thread = threads.find(
        (entry) =>
          `thread:${entry.threadId}` === receipt.canonicalExternalObjectId,
      );
      if (
        !thread ||
        !lifecycle ||
        thread.threadId !== lifecycle.threadId ||
        thread.resolve !== lifecycle.resolve ||
        joinedThreads.has(thread.threadId)
      )
        invalid();
      joinedThreads.add(thread!.threadId);
      continue;
    }
    const kind =
      op.publicationKind === "summary"
        ? "issue_comment"
        : op.publicationKind === "managed_check"
          ? "check_run"
          : "review";
    const namespace =
      kind === "issue_comment"
        ? "issue-comment"
        : kind === "check_run"
          ? "check-run"
          : "review";
    const prefix = `${namespace}:`;
    const canonicalId = receipt.canonicalExternalObjectId;
    if (
      !canonicalId.startsWith(prefix) ||
      !validObjectId(canonicalId.slice(prefix.length))
    )
      invalid();
    const key = `${kind}:${canonicalId.slice(prefix.length)}`;
    const object = objectByKey.get(key);
    if (!object) invalid();
    if (kind !== "review") {
      if (
        joined.has(key) ||
        object!.bodyHash !== op.bodyHash ||
        (kind === "check_run" &&
          (object!.headSha !== input.sourceHeadSha ||
            object!.state !== "completed"))
      )
        invalid();
    } else {
      if (
        object!.headSha !== input.sourceHeadSha ||
        object!.state !== "COMMENTED"
      )
        invalid();
      if (reviewOwners.has(key) && reviewOwners.get(key) !== op.chunkIndex)
        invalid();
      reviewOwners.set(key, op.chunkIndex);
      const chunk = rendered.inlineReviews.find(
        (entry) => entry.chunkIndex === op.chunkIndex,
      );
      if (!chunk) invalid();
      const create = operations.find(
        (entry) =>
          entry.publicationKind === "pending_review_create" &&
          entry.chunkIndex === op.chunkIndex,
      );
      const submit = operations.find(
        (entry) =>
          entry.publicationKind === "pending_review_submit" &&
          entry.chunkIndex === op.chunkIndex,
      );
      if (
        !create ||
        !submit ||
        create.dependsOnOperationId !== null ||
        submit.dependsOnOperationId !== create.publicationOperationId ||
        receiptByOperation.get(create.publicationOperationId)
          ?.canonicalExternalObjectId !== canonicalId ||
        receiptByOperation.get(submit.publicationOperationId)
          ?.canonicalExternalObjectId !== canonicalId ||
        object!.submitHash !== chunk!.submit.bodyHash ||
        object!.bodyHash !== digest(chunk!.submit.reviewBody)
      )
        invalid();
      // Child identity, membership, head and full placement are independently observed.
      const children = objects.filter(
        (entry) =>
          entry.kind === "review_comment" &&
          entry.parentReviewId === object!.externalObjectId,
      );
      const expectedComments = chunk!.create.comments
        .map(
          (comment) =>
            `${digest(canonicalJson(comment))}:${digest(comment.body)}`,
        )
        .sort();
      if (
        children.length !== expectedComments.length ||
        children.some(
          (child) =>
            child.headSha !== input.sourceHeadSha ||
            child.authorLogin !== object!.authorLogin,
        ) ||
        canonicalJson(
          children
            .map((child) => `${child.placementHash}:${child.bodyHash}`)
            .sort(),
        ) !== canonicalJson(expectedComments)
      )
        invalid();
      for (const child of children) joined.add(artifactKey(child));
    }
    joined.add(key);
  }
  if (
    joined.size !== objects.length ||
    threads.some(
      (thread) => thread.changed && !joinedThreads.has(thread.threadId),
    )
  )
    invalid();
  return { executionId: intent.executionId, publicationAttemptId };
}

type PublicationKind =
  HostedPoolPublicationEvidence["publicationObjects"][number]["kind"];
type SnapshotArtifact =
  HostedPoolPublicationEvidence["publicationObjects"][number] &
    Readonly<{ hasMarker: boolean; checkConclusion?: string | null }>;

/** Bounded PR inventory; bodies are hashed and never retained. */
export type HostedPoolPublicationSnapshot = Readonly<{
  repository: string;
  pullRequestNumber: number;
  sourceHeadSha: string;
  capturedAt: string;
  captureCompletedAt: string;
  lifecycleThreads: readonly { threadId: string; resolve: boolean }[];
  artifacts: readonly SnapshotArtifact[];
}>;

const publicationKinds = [
  "issue_comment",
  "review_comment",
  "review",
  "check_run",
] as const;
const artifactKey = (item: { kind: string; externalObjectId: string }) =>
  `${item.kind}:${item.externalObjectId}`;
const validObjectId = (value: unknown): boolean =>
  (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) ||
  (typeof value === "number" && Number.isSafeInteger(value) && value > 0);

function assertSnapshot(snapshot: HostedPoolPublicationSnapshot): void {
  if (
    !snapshot ||
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/iu.test(snapshot.repository) ||
    !Number.isSafeInteger(snapshot.pullRequestNumber) ||
    snapshot.pullRequestNumber < 1 ||
    !/^[a-f0-9]{40}$/u.test(snapshot.sourceHeadSha) ||
    !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
    !Number.isFinite(Date.parse(snapshot.captureCompletedAt)) ||
    Date.parse(snapshot.capturedAt) > Date.parse(snapshot.captureCompletedAt) ||
    !Array.isArray(snapshot.lifecycleThreads) ||
    snapshot.lifecycleThreads.some(
      (thread) =>
        !thread ||
        typeof thread.threadId !== "string" ||
        !thread.threadId ||
        typeof thread.resolve !== "boolean",
    ) ||
    new Set(snapshot.lifecycleThreads.map((thread) => thread.threadId)).size !==
      snapshot.lifecycleThreads.length ||
    !Array.isArray(snapshot.artifacts)
  )
    throw new Error("hosted_pool_canary_publication_scope_invalid");
  const seen = new Set<string>();
  for (const item of snapshot.artifacts) {
    if (
      !item ||
      !publicationKinds.includes(item.kind) ||
      !validObjectId(item.externalObjectId) ||
      typeof item.externalObjectId !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.bodyHash) ||
      typeof item.authorLogin !== "string" ||
      !item.authorLogin.trim() ||
      typeof item.hasMarker !== "boolean" ||
      !Number.isFinite(Date.parse(item.publishedAt)) ||
      seen.has(artifactKey(item))
    )
      throw new Error("hosted_pool_canary_publication_identity_invalid");
    seen.add(artifactKey(item));
  }
  if (
    publicationKinds.some(
      (kind) =>
        snapshot.artifacts.filter((item) => item.kind === kind).length >= 100,
    )
  )
    throw new Error("hosted_pool_canary_publication_pagination_unsupported");
}

export async function captureHostedPoolPublicationSnapshot(
  github: HostedPoolGitHubRequestPort,
  input: {
    repository: string;
    pullRequestNumber: number;
    sourceHeadSha: string;
    now?: (() => Date) | undefined;
  },
): Promise<HostedPoolPublicationSnapshot> {
  const capturedAt = (input.now ?? (() => new Date()))().toISOString();
  assertSnapshot({
    ...input,
    capturedAt,
    captureCompletedAt: capturedAt,
    lifecycleThreads: [],
    artifacts: [],
  });
  const repository = input.repository.toLowerCase();
  const endpoints = [
    `/repos/${repository}/issues/${input.pullRequestNumber}/comments?per_page=100`,
    `/repos/${repository}/pulls/${input.pullRequestNumber}/comments?per_page=100`,
    `/repos/${repository}/pulls/${input.pullRequestNumber}/reviews?per_page=100`,
    `/repos/${repository}/commits/${input.sourceHeadSha}/check-runs?per_page=100&filter=all`,
  ];
  const pages = await Promise.all(
    endpoints.map(async (path, index) => {
      const response: any = await github.request("GET", path);
      const items = index === 3 ? response?.check_runs : response;
      if (!Array.isArray(items) || items.length >= 100)
        throw new Error(
          "hosted_pool_canary_publication_pagination_unsupported",
        );
      return items.map((item: any): SnapshotArtifact => {
        const check = index === 3;
        const markerText = check
          ? [
              item?.name,
              item?.output?.title,
              item?.output?.summary,
              item?.output?.text,
            ]
              .filter((value) => typeof value === "string")
              .join("\n")
          : item?.body;
        const hasMarker =
          /(?:reviewrouter(?::|-)|review-router-finding:)/iu.test(
            markerText ?? "",
          );
        // Null output is normal for Actions jobs, but never relax RR payloads.
        // This normalization alone does NOT authorize exclusion from publications.
        const ordinaryActionsCheck =
          check && item?.app?.slug === "github-actions" && !hasMarker;
        const title =
          ordinaryActionsCheck && item?.output?.title === null
            ? ""
            : item?.output?.title;
        const summary =
          ordinaryActionsCheck && item?.output?.summary === null
            ? ""
            : item?.output?.summary;
        const body = check
          ? canonicalJson({
              conclusion: item?.conclusion,
              name: item?.name,
              summary,
              title,
            })
          : item?.body;
        const author = check
          ? item?.app?.slug && `${item.app.slug}[bot]`
          : item?.user?.login;
        if (
          !item ||
          !validObjectId(item.id) ||
          typeof body !== "string" ||
          typeof author !== "string" ||
          !author.trim() ||
          (check &&
            [
              ordinaryActionsCheck && item.conclusion === null
                ? ""
                : item.conclusion,
              item.name,
              summary,
              title,
              item.head_sha,
              item.status,
            ].some((value) => typeof value !== "string"))
        )
          throw new Error("hosted_pool_canary_publication_identity_invalid");
        if (
          index === 1 &&
          (!validObjectId(item.pull_request_review_id) ||
            typeof item.path !== "string" ||
            !Number.isSafeInteger(item.line ?? item.original_line) ||
            (item.line ?? item.original_line) < 1 ||
            item.side !== "RIGHT" ||
            (item.start_side != null && item.start_side !== "RIGHT") ||
            (item.start_line != null &&
              (!Number.isSafeInteger(item.start_line) || item.start_line < 1)))
        )
          throw new Error("hosted_pool_canary_publication_placement_invalid");
        if (
          (index === 1 || index === 2 || check) &&
          !/^[a-f0-9]{40}$/u.test(check ? item.head_sha : item.commit_id)
        )
          throw new Error("hosted_pool_canary_publication_head_invalid");
        // An edit's timestamp is evidence, even when the original creation predates dispatch.
        const timestamps = [
          item.created_at,
          item.submitted_at,
          item.updated_at,
          item.started_at,
          item.completed_at,
        ].filter((value) => value !== undefined && value !== null);
        if (
          !timestamps.length ||
          timestamps.some(
            (value) =>
              typeof value !== "string" || !Number.isFinite(Date.parse(value)),
          )
        )
          throw new Error("hosted_pool_canary_publication_timestamp_invalid");
        return {
          kind: publicationKinds[index]!,
          externalObjectId: String(item.id),
          bodyHash: digest(body),
          authorLogin: author.toLowerCase(),
          ...(index === 2
            ? {
                headSha: item.commit_id,
                state: item.state,
                submitHash: digest(canonicalJson({ body, event: "COMMENT" })),
              }
            : {}),
          ...(check
            ? {
                headSha: item.head_sha,
                state: item.status,
                checkConclusion: item.conclusion,
              }
            : {}),
          ...(index === 1
            ? {
                headSha: item.commit_id,
                parentReviewId: String(item.pull_request_review_id),
                placementHash: digest(
                  canonicalJson({
                    body,
                    path: item.path,
                    line: item.line ?? item.original_line,
                    startLine:
                      item.start_line ?? item.original_start_line ?? null,
                  }),
                ),
              }
            : {}),
          hasMarker,
          publishedAt: new Date(
            Math.max(...timestamps.map((value) => Date.parse(value))),
          ).toISOString(),
        };
      });
    }),
  );
  // Read-only GraphQL query; REST review comments do not expose thread resolution.
  const [owner, name] = repository.split("/");
  const response: any = await github.request("POST", "/graphql", {
    query:
      "query CanaryPublicationThreads($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved} pageInfo{hasNextPage}}}}}",
    variables: { owner, name, number: input.pullRequestNumber },
  });
  const threadPage = response?.data?.repository?.pullRequest?.reviewThreads;
  if (
    response?.errors ||
    !Array.isArray(threadPage?.nodes) ||
    threadPage.pageInfo?.hasNextPage !== false ||
    threadPage.nodes.length >= 100 ||
    threadPage.nodes.some(
      (node: any) =>
        typeof node?.id !== "string" ||
        !node.id ||
        typeof node.isResolved !== "boolean",
    ) ||
    new Set(threadPage.nodes.map((node: any) => node.id)).size !==
      threadPage.nodes.length
  )
    throw new Error(
      "hosted_pool_canary_publication_lifecycle_observation_missing",
    );
  const snapshot = {
    repository,
    sourceHeadSha: input.sourceHeadSha,
    capturedAt,
    captureCompletedAt: (input.now ?? (() => new Date()))().toISOString(),
    lifecycleThreads: threadPage.nodes.map((node: any) => ({
      threadId: node.id as string,
      resolve: node.isResolved as boolean,
    })),
    pullRequestNumber: input.pullRequestNumber,
    artifacts: pages.flat(),
  };
  assertSnapshot(snapshot);
  return snapshot;
}

/** Compare every identity against pre-dispatch evidence, through the observation cutoff. */
export async function collectExactHostedPoolPublicationEvidence(
  github: HostedPoolGitHubRequestPort,
  input: {
    repository: string;
    pullRequestNumber: number;
    expectedAppBot: string;
    exactRunId: number;
    startedAt: Date;
    finishedAt: Date;
    baseline: HostedPoolPublicationSnapshot;
    sourceHeadSha: string;
    dispatchedAt: Date;
    now?: (() => Date) | undefined;
  },
): Promise<HostedPoolPublicationEvidence> {
  assertSnapshot(input.baseline);
  if (
    input.baseline.repository.toLowerCase() !==
      input.repository.toLowerCase() ||
    input.baseline.pullRequestNumber !== input.pullRequestNumber ||
    input.baseline.sourceHeadSha !== input.sourceHeadSha ||
    !Number.isFinite(input.dispatchedAt.getTime()) ||
    Date.parse(input.baseline.captureCompletedAt) >
      input.dispatchedAt.getTime() ||
    input.startedAt.getTime() <
      input.dispatchedAt.getTime() - GITHUB_RUN_CLOCK_TOLERANCE_MS ||
    !Number.isSafeInteger(input.exactRunId) ||
    input.exactRunId < 1 ||
    !input.expectedAppBot.trim() ||
    !Number.isFinite(input.startedAt.getTime()) ||
    !Number.isFinite(input.finishedAt.getTime()) ||
    input.finishedAt < input.startedAt
  )
    throw new Error("hosted_pool_canary_publication_scope_invalid");
  // The attempt-specific jobs endpoint is the supported check/run relation.
  // Bounded, read-only and fail closed on ambiguous or malformed attribution.
  const repository = input.repository.toLowerCase();
  const jobsPage: any = await github.request(
    "GET",
    `/repos/${repository}/actions/runs/${input.exactRunId}/attempts/2/jobs?per_page=100`,
  );
  if (
    !Array.isArray(jobsPage?.jobs) ||
    jobsPage.jobs.length >= 100 ||
    jobsPage.total_count !== jobsPage.jobs.length
  )
    throw new Error("hosted_pool_canary_publication_jobs_invalid");
  const jobsByCheck = new Map<
    string,
    { status: string; conclusion: string | null }
  >();
  const jobIds = new Set<string>();
  const prefix = `https://api.github.com/repos/${repository}/check-runs/`;
  for (const job of jobsPage.jobs) {
    const checkId =
      typeof job?.check_run_url === "string" &&
      job.check_run_url.startsWith(prefix)
        ? job.check_run_url.slice(prefix.length)
        : "";
    if (
      !validObjectId(job?.id) ||
      jobIds.has(String(job.id)) ||
      job.run_id !== input.exactRunId ||
      job.run_attempt !== 2 ||
      job.head_sha !== input.sourceHeadSha ||
      !validObjectId(checkId) ||
      jobsByCheck.has(checkId) ||
      job.status !== "completed" ||
      typeof job.conclusion !== "string" ||
      !job.conclusion
    )
      throw new Error("hosted_pool_canary_publication_jobs_invalid");
    jobIds.add(String(job.id));
    jobsByCheck.set(checkId, job);
  }
  const current = await captureHostedPoolPublicationSnapshot(github, input);
  const confirmed = await captureHostedPoolPublicationSnapshot(github, input);
  if (
    Date.parse(current.capturedAt) < input.finishedAt.getTime() ||
    Date.parse(confirmed.capturedAt) < Date.parse(current.captureCompletedAt) ||
    canonicalJson(current.artifacts) !== canonicalJson(confirmed.artifacts) ||
    canonicalJson(current.lifecycleThreads) !==
      canonicalJson(confirmed.lifecycleThreads)
  )
    throw new Error("hosted_pool_canary_publication_observation_incomplete");
  const before = new Map(
    input.baseline.artifacts.map((item) => [artifactKey(item), item]),
  );
  const after = new Map(
    current.artifacts.map((item) => [artifactKey(item), item]),
  );
  // Even an unmarked deletion cannot be attributed safely from this bounded inventory.
  if (input.baseline.artifacts.some((item) => !after.has(artifactKey(item))))
    throw new Error("hosted_pool_canary_publication_deleted");
  const publicationObjects = current.artifacts.flatMap((item) => {
    const previous = before.get(artifactKey(item));
    if (previous && canonicalJson(previous) === canonicalJson(item)) return [];
    if (previous?.hasMarker && !item.hasMarker)
      throw new Error("hosted_pool_canary_publication_marker_removed");
    const job =
      item.kind === "check_run"
        ? jobsByCheck.get(item.externalObjectId)
        : undefined;
    if (
      job &&
      item.authorLogin === "github-actions[bot]" &&
      item.authorLogin !== input.expectedAppBot.toLowerCase() &&
      !item.hasMarker &&
      !previous?.hasMarker &&
      item.headSha === input.sourceHeadSha &&
      item.state === job.status &&
      item.checkConclusion === job.conclusion
    )
      return [];
    const relevant =
      item.hasMarker ||
      previous?.hasMarker ||
      item.authorLogin === input.expectedAppBot.toLowerCase() ||
      /\[bot\]$/iu.test(item.authorLogin) ||
      /\[bot\]$/iu.test(previous?.authorLogin ?? "");
    if (!relevant) return [];
    // Never silently discard a changed bot artifact because its timestamp is outside the window.
    if (new Date(item.publishedAt) > new Date(current.captureCompletedAt))
      throw new Error("hosted_pool_canary_publication_observation_incomplete");
    const {
      hasMarker: _hasMarker,
      checkConclusion: _checkConclusion,
      ...object
    } = item;
    return [object];
  });
  const appBotPublicationCount = publicationObjects.filter(
    (item) => item.authorLogin === input.expectedAppBot.toLowerCase(),
  ).length;
  const beforeThreads = new Map(
    input.baseline.lifecycleThreads.map((thread) => [
      thread.threadId,
      thread.resolve,
    ]),
  );
  if (
    input.baseline.lifecycleThreads.some(
      (thread) =>
        !current.lifecycleThreads.some(
          (entry) => entry.threadId === thread.threadId,
        ),
    )
  )
    throw new Error("hosted_pool_canary_publication_deleted");
  return {
    lifecycleThreads: current.lifecycleThreads.map((thread) => ({
      ...thread,
      changed:
        beforeThreads.has(thread.threadId) &&
        beforeThreads.get(thread.threadId) !== thread.resolve,
    })),
    appBotPublicationCount,
    nonAppBotPublicationCount:
      publicationObjects.length - appBotPublicationCount,
    publicationObjects,
  };
}

/** Reads the two immutable live Render deploys without deployment authority. */
export function createRenderHostedPoolDeploymentEvidencePort(input: {
  apiKey: string;
  serviceIds: readonly [string, string];
  now?: (() => Date) | undefined;
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
