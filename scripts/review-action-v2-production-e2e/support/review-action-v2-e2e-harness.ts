import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  OutboxHandlerError,
  PrismaOutboxEventRepository,
  processOutboxBatch,
  retryDeadLetterOutboxEvent,
  type OutboxHandler,
} from "../../../packages/features/outbox/src/index.js";
import {
  ProviderExecutionProfile,
  ProviderResultCompletionStatus,
  ReviewProviderKind,
  ReviewTaskKind as EvidenceTaskKind,
  buildProviderInvocationIdentity,
  prepareReviewObservationPayload,
  reviewEvidencePayloadVersion,
  reviewReuseEligibilityPolicyVersion,
  serializeProviderInvocationManifestCanonicalWireJson,
  type ProviderInvocationManifest,
  type ReviewObservationPayload,
} from "../../../packages/features/review-evidence/src/index.js";
import {
  ReviewExecutionProviderKind,
  ReviewInvocationLeasePurpose,
  ReviewTaskKind as ExecutionTaskKind,
} from "../../../packages/features/review-executions/src/index.js";
import { ClaimReviewPublicationStatus } from "../../../packages/features/review-publishing/src/v2/index.js";
import { PrismaReviewPublicationRepository } from "../../../packages/features/review-publishing/src/v2/composition/index.js";
import {
  canonicalJson,
  canonicalReviewOperationalSloProfile,
  canonicalReviewProtocolLimits,
  type ReviewOperationalSloThresholds,
  type ReviewProtocolLimits,
} from "../../../packages/features/review-run-control/src/index.js";
import {
  createPrismaClient,
  type PrismaClient,
} from "../../../packages/platform/db/src/index.js";
import { SystemClock } from "../../../packages/shared/src/index.js";
import {
  ReviewActionV2OperationId,
  ReviewEvidenceCommitResultStatus,
  ReviewExecutionMutationResultStatus,
  ReviewExecutionStartResultStatus,
  ReviewInvocationLeaseResultStatus,
  canonicalizeReviewActionV2Request,
  reviewActionV2CanonicalizerDigest,
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
  type ReviewActionV2RequestMap,
  type ReviewEvidenceCommitRequest,
  type ReviewExecutionFinalizeRequest,
  type ReviewExecutionObservationAdoptRequest,
  type ReviewExecutionObservationAttachRequest,
  type ReviewExecutionStartRequest,
  type ReviewInvocationLeaseAcquireRequest,
  type ReviewInvocationLeaseReleaseRequest,
  type ReviewRunAuthorizeRequest,
} from "../../../packages/protocol-review-action-v2/src/index.js";
import { exportJWK, SignJWT } from "jose";
import {
  composeReviewActionV2ProductionRoutes,
  reviewActionV2CapabilityActiveKeyIdEnv,
  reviewActionV2CapabilityKeysEnv,
  reviewActionV2ProjectionPolicyVersionEnv,
  reviewActionV2ProviderVoteLanesEnv,
} from "../../../apps/api/src/review-action-v2-production-composition.js";
import { createProductionReviewV2WorkerRuntime } from "../../../apps/worker/src/review-v2-production-runtime.js";
import {
  createReviewV2WorkerFeature,
  reviewExecutionFinalizedEventType,
  reviewExecutionFinalizedEventVersion,
  reviewV2WorkerEnabledEnv,
} from "../../../apps/worker/src/review-v2-worker-runtime.js";
import { FakeGitHubTransport, type FakeGitHubRevision } from "./fake-github.js";

const owner = "reviewrouter-e2e";
const repo = "disposable-review-v2";
const pullRequestNumber = 42;
const githubRepositoryId = "987654321";
const githubInstallationId = "123456";
const sourceRunId = "700001";
const actionCommitSha = "a".repeat(40);
const runtimeCommitSha = "b".repeat(40);
const baseSha = "c".repeat(40);
const mergeBaseSha = "d".repeat(40);
const headSha = "e".repeat(40);
const providerVoteIdentityHash = sha256("provider-vote");
const projectionPolicyVersion = "review-projection-v1";
const capabilityKeyId = "review-v2-e2e-key";

export type ReviewActionV2E2EFlow = Readonly<{
  authorizationId: string;
  authorizationToken: string;
  executionId: string;
  workSlotId: string;
  ownerIdHash: string;
  planHash: string;
  reviewRevisionHash: string;
  manifest: ProviderInvocationManifest;
  manifestCanonicalJson: string;
  manifestKey: string;
  providerInvocationKey: string;
  leaseId: string;
  attemptId: string;
  leaseCapability: string;
  fencingToken: string;
  observationId: string;
  payloadHash: string;
  byteCount: number;
  findingCount: number;
  streamVersion: string;
  executionVersion: string;
}>;

export class ReviewActionV2E2EHarness {
  readonly prisma: PrismaClient;
  readonly fakeGitHub: FakeGitHubTransport;
  readonly prefix: string;
  readonly workspaceId: string;
  readonly repositoryConnectionId: string;
  readonly scmRepositoryIdentityId: string;
  readonly producerReleaseId: string;
  readonly protocolLimitsProfileId: string;
  readonly operationalSloProfileId: string;
  readonly env: Readonly<Record<string, string>>;
  private readonly routes: ReturnType<
    typeof composeReviewActionV2ProductionRoutes
  >;
  private readonly worker: ReturnType<typeof createReviewV2WorkerFeature>;
  private readonly originalFetch: typeof globalThis.fetch;
  private oidcOrdinal = 0;

  private constructor(input: {
    readonly prisma: PrismaClient;
    readonly fakeGitHub: FakeGitHubTransport;
    readonly prefix: string;
    readonly workspaceId: string;
    readonly repositoryConnectionId: string;
    readonly scmRepositoryIdentityId: string;
    readonly producerReleaseId: string;
    readonly protocolLimitsProfileId: string;
    readonly operationalSloProfileId: string;
    readonly env: Readonly<Record<string, string>>;
    readonly routes: ReturnType<typeof composeReviewActionV2ProductionRoutes>;
    readonly worker: ReturnType<typeof createReviewV2WorkerFeature>;
    readonly originalFetch: typeof globalThis.fetch;
  }) {
    this.prisma = input.prisma;
    this.fakeGitHub = input.fakeGitHub;
    this.prefix = input.prefix;
    this.workspaceId = input.workspaceId;
    this.repositoryConnectionId = input.repositoryConnectionId;
    this.scmRepositoryIdentityId = input.scmRepositoryIdentityId;
    this.producerReleaseId = input.producerReleaseId;
    this.protocolLimitsProfileId = input.protocolLimitsProfileId;
    this.operationalSloProfileId = input.operationalSloProfileId;
    this.env = input.env;
    this.routes = input.routes;
    this.worker = input.worker;
    this.originalFetch = input.originalFetch;
  }

  static async create(databaseUrl: string): Promise<ReviewActionV2E2EHarness> {
    assertDisposableDatabaseUrl(databaseUrl);
    const prisma = createPrismaClient({ databaseUrl, poolMax: 12 });
    const prefix = `review-v2-e2e-${randomUUID()}`;
    const workspaceId = `${prefix}-workspace`;
    const repositoryConnectionId = `${prefix}-repository`;
    const scmRepositoryIdentityId = `${prefix}-scm`;
    const producerReleaseId = `${prefix}-release`;
    const protocolLimitsProfileId = `${prefix}-limits`;
    const operationalSloProfileId = `${prefix}-slo`;
    const appKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const oidcKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const oidcJwk = await exportJWK(oidcKeys.publicKey);
    const oidcKeyId = `${prefix}-oidc`;
    oidcJwk.alg = "RS256";
    oidcJwk.kid = oidcKeyId;
    oidcJwk.use = "sig";
    oidcSigningKeys.set(oidcKeyId, oidcKeys);
    const fakeGitHub = new FakeGitHubTransport({
      owner,
      repo,
      pullRequestNumber,
      sourceRunId,
      installationId: githubInstallationId,
      appSlug: "reviewrouter-e2e",
      oidcKeyId,
      oidcJwk,
      revision: { baseSha, mergeBaseSha, headSha },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeGitHub.fetch;
    const env = productionEnv({
      appPrivateKey: appKeys.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      producerReleaseId,
      protocolLimitsProfileId,
      operationalSloProfileId,
    });

    try {
      await seedProductionControlPlane(prisma, {
        prefix,
        workspaceId,
        repositoryConnectionId,
        scmRepositoryIdentityId,
        producerReleaseId,
        protocolLimitsProfileId,
        operationalSloProfileId,
      });
      const routes = composeReviewActionV2ProductionRoutes({
        enabled: true,
        env,
        runtime: {
          readServerTime: async () => new Date(),
          createRequestId: () => `${prefix}-request-${randomUUID()}`,
        },
        prisma,
      });
      const productionWorker = createProductionReviewV2WorkerRuntime({
        prisma,
        clock: new SystemClock(),
        env,
        githubAppId: requiredString(env.GITHUB_APP_ID),
        githubPrivateKey: requiredString(env.GITHUB_APP_PRIVATE_KEY),
      });
      const worker = createReviewV2WorkerFeature({
        env,
        createEnabledRuntime: () => productionWorker,
      });
      return new ReviewActionV2E2EHarness({
        prisma,
        fakeGitHub,
        prefix,
        workspaceId,
        repositoryConnectionId,
        scmRepositoryIdentityId,
        producerReleaseId,
        protocolLimitsProfileId,
        operationalSloProfileId,
        env,
        routes,
        worker,
        originalFetch,
      });
    } catch (error) {
      globalThis.fetch = originalFetch;
      await prisma.$disconnect();
      throw error;
    }
  }

  async close(): Promise<void> {
    globalThis.fetch = this.originalFetch;
    await this.prisma.$disconnect();
  }

  async authorize(): Promise<{
    readonly authorizationId: string;
    readonly authorizationToken: string;
    readonly reviewRevisionHash: string;
    readonly selectedProtocolVersion: string;
  }> {
    const oidcToken = await this.signOidcToken();
    const request: ReviewRunAuthorizeRequest = {
      ...envelope(`${this.prefix}-authorize`),
      oidcToken,
      supportedProtocols: [
        {
          protocolVersion: reviewActionV2PublishedProtocolVersion,
          schemaDigest: reviewActionV2PublishedSchemaDigest,
        },
      ],
    };
    const response = await requiredHandler(
      this.routes.runControl.authorize,
      "authorize",
    ).execute(request);
    const authorizationId = requiredString(response.result.authorizationId);
    const authorizationToken = requiredString(
      response.result.authorizationToken,
    );
    const facts = record(
      JSON.parse(
        requiredString(response.result.authorizationFactsCanonicalJson),
      ),
    );
    return {
      authorizationId,
      authorizationToken,
      reviewRevisionHash: requiredString(facts.reviewRevisionHash),
      selectedProtocolVersion: requiredString(facts.selectedProtocolVersion),
    };
  }

  async createCommittedFlow(
    input: {
      readonly slotCount?: number;
      readonly attachSlotCount?: number;
    } = {},
  ): Promise<ReviewActionV2E2EFlow> {
    const authorized = await this.authorize();
    const executionId = `${this.prefix}-execution-${randomUUID()}`;
    const workSlotId = `${executionId}-slot-0`;
    const ownerIdHash = sha256(`${executionId}-owner`);
    const planHash = sha256(`${executionId}-plan`);
    const slotCount = input.slotCount ?? 1;
    const attachSlotCount = input.attachSlotCount ?? 1;
    const workSlots = Array.from({ length: slotCount }, (_, index) => ({
      attemptBudget: 2,
      providerKind: ReviewExecutionProviderKind.Codex,
      providerVoteIdentityHash,
      required: true,
      retryPolicyVersion: "retry-v1",
      shardKey: `shard-${index}`,
      taskKind: ExecutionTaskKind.FindingDiscovery,
      workSlotId: `${executionId}-slot-${index}`,
    }));
    const startRequest = await withBodyHash(
      ReviewActionV2OperationId.ReviewExecutionStart,
      {
        ...envelope(`${executionId}-start`),
        authorizationToken: authorized.authorizationToken,
        idempotencyKey: `${executionId}-start-idempotency`,
        requestBodyHash: zeroHash,
        authorizationId: authorized.authorizationId,
        executionId,
        reviewRevisionHash: authorized.reviewRevisionHash,
        compatibilityKey: sha256(`${executionId}-compatibility`),
        planHash,
        workSlotsCanonicalJson: canonicalJson(workSlots),
        sourceRunId,
        sourceRunAttempt: "1",
      },
    );
    const started = await requiredHandler(
      this.routes.execution.start,
      "execution_start",
    ).execute(startRequest as ReviewExecutionStartRequest);
    if (
      started.result.status !== ReviewExecutionStartResultStatus.Admitted &&
      started.result.status !== ReviewExecutionStartResultStatus.Restored
    ) {
      throw new Error(`review_v2_e2e_start_failed:${started.result.status}`);
    }

    const scopeHash = sha256(
      canonicalJson({
        pullRequestNumber,
        repositoryConnectionId: this.repositoryConnectionId,
        scmRepositoryIdentityId: this.scmRepositoryIdentityId,
        workspaceId: this.workspaceId,
      }),
    );
    const manifest = providerManifest({
      executionId,
      producerReleaseId: this.producerReleaseId,
      scopeHash,
      selectedProtocolVersion: authorized.selectedProtocolVersion,
    });
    const identity = await buildProviderInvocationIdentity(digestPort, {
      manifest,
      providerVoteIdentityHash,
    });
    const manifestCanonicalJson =
      serializeProviderInvocationManifestCanonicalWireJson(manifest);
    const leaseRequest = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvocationLeaseAcquire,
      {
        ...envelope(`${executionId}-lease`),
        authorizationToken: authorized.authorizationToken,
        idempotencyKey: `${executionId}-lease-idempotency`,
        requestBodyHash: zeroHash,
        executionId,
        workSlotId,
        purpose: ReviewInvocationLeasePurpose.ProviderExecution,
        manifestCanonicalJson,
        manifestKey: identity.manifestKey,
        providerVoteIdentityHash,
        providerInvocationKey: identity.providerInvocationKey,
        acquireRequestId: `${executionId}-acquire`,
        ownerIdHash,
      },
    );
    const leased = await requiredHandler(
      this.routes.execution.acquireLease,
      "lease_acquire",
    ).execute(leaseRequest as ReviewInvocationLeaseAcquireRequest);
    if (leased.result.status !== ReviewInvocationLeaseResultStatus.Acquired) {
      throw new Error(`review_v2_e2e_lease_failed:${leased.result.status}`);
    }
    const leaseId = requiredString(leased.result.leaseId);
    const attemptId = requiredString(leased.result.attemptId);
    const leaseCapability = requiredString(leased.result.leaseCapability);
    const fencingToken = requiredString(leased.result.fencingToken);
    const payload: ReviewObservationPayload = {
      payloadVersion: reviewEvidencePayloadVersion,
      normalizedFindings: [],
      normalizedLifecycleRevalidations: [],
      safeUsage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
    };
    const preparedPayload = prepareReviewObservationPayload(payload);
    const payloadCanonicalJson = canonicalJson(preparedPayload.payload);
    const payloadHash = await digestPort.digest(preparedPayload.canonicalBytes);
    const commitRequest = await withBodyHash(
      ReviewActionV2OperationId.ReviewEvidenceCommit,
      {
        ...envelope(`${executionId}-commit`),
        authorizationToken: authorized.authorizationToken,
        leaseCapability,
        idempotencyKey: `${executionId}-commit-idempotency`,
        requestBodyHash: zeroHash,
        attemptId,
        sourceLeaseId: leaseId,
        ownerIdHash,
        fencingToken,
        completionStatus: ProviderResultCompletionStatus.Success,
        schemaValidated: true,
        fullyConsumed: true,
        actualModel: "gpt-5-codex",
        payloadCanonicalJson,
        payloadHash,
        qualityFlags: [],
        transportAttemptCount: 1,
      },
    );
    const committed = await requiredHandler(
      this.routes.evidence.commit,
      "evidence_commit",
    ).execute(commitRequest as ReviewEvidenceCommitRequest);
    if (committed.result.status !== ReviewEvidenceCommitResultStatus.Accepted) {
      throw new Error(`review_v2_e2e_commit_failed:${committed.result.status}`);
    }
    const observationId = requiredString(committed.result.observationId);

    let streamVersion = requiredString(started.result.streamVersion);
    let executionVersion = requiredString(started.result.executionVersion);
    if (attachSlotCount > 0) {
      const attachRequest = await withBodyHash(
        ReviewActionV2OperationId.ReviewExecutionObservationAttach,
        {
          ...envelope(`${executionId}-attach`),
          authorizationToken: authorized.authorizationToken,
          leaseCapability,
          idempotencyKey: `${executionId}-attach-idempotency`,
          requestBodyHash: zeroHash,
          executionId,
          workSlotId,
          observationId,
          providerInvocationKey: identity.providerInvocationKey,
          providerVoteIdentityHash,
          payloadHash,
          byteCount: preparedPayload.byteCount,
          findingCount: preparedPayload.findingCount,
          eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
        },
      );
      const attached = await requiredHandler(
        this.routes.execution.attachObservation,
        "observation_attach",
      ).execute(attachRequest as ReviewExecutionObservationAttachRequest);
      if (
        attached.result.status !== ReviewExecutionMutationResultStatus.Applied
      ) {
        throw new Error(
          `review_v2_e2e_attach_failed:${attached.result.status}`,
        );
      }
      streamVersion = requiredString(attached.result.streamVersion);
      const persisted = await this.prisma.reviewExecutionV2.findUniqueOrThrow({
        where: { executionId },
        select: { version: true },
      });
      executionVersion = persisted.version.toString(10);
    }
    return {
      ...authorized,
      executionId,
      workSlotId,
      ownerIdHash,
      planHash,
      manifest,
      manifestCanonicalJson,
      manifestKey: identity.manifestKey,
      providerInvocationKey: identity.providerInvocationKey,
      leaseId,
      attemptId,
      leaseCapability,
      fencingToken,
      observationId,
      payloadHash,
      byteCount: preparedPayload.byteCount,
      findingCount: preparedPayload.findingCount,
      streamVersion,
      executionVersion,
    };
  }

  async lookup(flow: ReviewActionV2E2EFlow) {
    return requiredHandler(
      this.routes.evidence.lookup,
      "evidence_lookup",
    ).execute({
      ...envelope(`${flow.executionId}-lookup-${randomUUID()}`),
      authorizationToken: flow.authorizationToken,
      executionId: flow.executionId,
      workSlotId: flow.workSlotId,
      planHash: flow.planHash,
      manifestCanonicalJson: flow.manifestCanonicalJson,
      manifestKey: flow.manifestKey,
      providerInvocationKey: flow.providerInvocationKey,
      providerVoteIdentityHash,
    });
  }

  async attachCommittedObservation(flow: ReviewActionV2E2EFlow) {
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewExecutionObservationAttach,
      {
        ...envelope(`${flow.executionId}-attach`),
        authorizationToken: flow.authorizationToken,
        leaseCapability: flow.leaseCapability,
        idempotencyKey: `${flow.executionId}-attach-idempotency`,
        requestBodyHash: zeroHash,
        executionId: flow.executionId,
        workSlotId: flow.workSlotId,
        observationId: flow.observationId,
        providerInvocationKey: flow.providerInvocationKey,
        providerVoteIdentityHash,
        payloadHash: flow.payloadHash,
        byteCount: flow.byteCount,
        findingCount: flow.findingCount,
        eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
      },
    );
    return requiredHandler(
      this.routes.execution.attachObservation,
      "observation_attach",
    ).execute(request as ReviewExecutionObservationAttachRequest);
  }

  async releaseProviderLease(flow: ReviewActionV2E2EFlow) {
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvocationLeaseRelease,
      {
        ...envelope(`${flow.executionId}-release-after-commit`),
        leaseCapability: flow.leaseCapability,
        idempotencyKey: `${flow.executionId}-release-after-commit-idempotency`,
        requestBodyHash: zeroHash,
        leaseId: flow.leaseId,
        ownerIdHash: flow.ownerIdHash,
        fencingToken: flow.fencingToken,
        releaseRequestId: `${flow.executionId}-release-after-commit`,
      },
    );
    return requiredHandler(
      this.routes.execution.releaseLease,
      "lease_release",
    ).execute(request as ReviewInvocationLeaseReleaseRequest);
  }

  async adoptCommittedObservation(flow: ReviewActionV2E2EFlow) {
    const execution = await this.prisma.reviewExecutionV2.findUniqueOrThrow({
      where: { executionId: flow.executionId },
      select: { generation: true, version: true },
    });
    const stream = await this.prisma.reviewExecutionStreamV2.findUniqueOrThrow({
      where: {
        workspaceId_repositoryConnectionId_scmRepositoryIdentityId_pullRequestNumber:
          {
            workspaceId: this.workspaceId,
            repositoryConnectionId: this.repositoryConnectionId,
            scmRepositoryIdentityId: this.scmRepositoryIdentityId,
            pullRequestNumber,
          },
      },
      select: { version: true },
    });
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewExecutionObservationAdopt,
      {
        ...envelope(`${flow.executionId}-adopt-after-restart`),
        authorizationToken: flow.authorizationToken,
        idempotencyKey: `${flow.executionId}-adopt-after-restart-idempotency`,
        requestBodyHash: zeroHash,
        executionId: flow.executionId,
        executionGeneration: execution.generation.toString(10),
        expectedStreamVersion: stream.version.toString(10),
        expectedExecutionVersion: execution.version.toString(10),
        workSlotId: flow.workSlotId,
        observationId: flow.observationId,
        providerInvocationKey: flow.providerInvocationKey,
        providerVoteIdentityHash,
        payloadHash: flow.payloadHash,
        byteCount: flow.byteCount,
        findingCount: flow.findingCount,
        sourceLeaseId: flow.leaseId,
        sourceFencingToken: flow.fencingToken,
        manifestCanonicalJson: flow.manifestCanonicalJson,
        manifestKey: flow.manifestKey,
        planHash: flow.planHash,
        reviewRevisionHash: flow.reviewRevisionHash,
        ownerIdHash: flow.ownerIdHash,
        eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
      },
    );
    const response = await this.executeObservationAdoption(
      request as ReviewExecutionObservationAdoptRequest,
    );
    return { request, response } as const;
  }

  async replayObservationAdoption(
    request: ReviewExecutionObservationAdoptRequest,
  ) {
    return this.executeObservationAdoption(request);
  }

  async replayCommit(flow: ReviewActionV2E2EFlow) {
    const observation =
      await this.prisma.reviewEvidenceObservation.findUniqueOrThrow({
        where: { observationId: flow.observationId },
      });
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewEvidenceCommit,
      {
        ...envelope(`${flow.executionId}-commit`),
        authorizationToken: flow.authorizationToken,
        leaseCapability: flow.leaseCapability,
        idempotencyKey: `${flow.executionId}-commit-idempotency`,
        requestBodyHash: zeroHash,
        attemptId: flow.attemptId,
        sourceLeaseId: flow.leaseId,
        ownerIdHash: flow.ownerIdHash,
        fencingToken: flow.fencingToken,
        completionStatus: ProviderResultCompletionStatus.Success,
        schemaValidated: true,
        fullyConsumed: true,
        actualModel: observation.actualModel,
        payloadCanonicalJson: canonicalJson(observation.payloadJson),
        payloadHash: observation.payloadHash,
        qualityFlags: [],
        transportAttemptCount: observation.transportAttemptCount,
      },
    );
    return requiredHandler(
      this.routes.evidence.commit,
      "evidence_commit",
    ).execute(request as ReviewEvidenceCommitRequest);
  }

  async finalize(
    flow: ReviewActionV2E2EFlow,
    options: { readonly allowPartial?: boolean } = {},
  ) {
    const allowPartial = options.allowPartial ?? false;
    const lifecycleStateHash = sha256(`${flow.executionId}-lifecycle`);
    const commandLedgerWatermark = "0";
    const projection = {
      commandLedgerWatermark,
      coverage: { state: allowPartial ? "partial" : "complete" },
      envelopeVersion: "review_projection.v1",
      lifecycleStateHash,
      mergeGate: { conclusion: allowPartial ? "neutral" : "success" },
      occurrences: [],
      projectionPolicyVersion,
      publishing: {
        check: {
          conclusion: "success",
          marker: `<!-- ${flow.executionId}:check -->`,
          name: "ReviewRouter",
          summary: "Review complete",
          title: "Review complete",
        },
        inlineReviewChunks: [],
        lifecycle: [],
        summary: {
          allClear: true,
          body: allowPartial ? "Partial review" : "Review complete",
          marker: `<!-- ${flow.executionId}:summary -->`,
        },
      },
      scope: {
        baseSha,
        pullRequestNumber,
        reviewRevisionHash: flow.reviewRevisionHash,
        reviewedHeadSha: headSha,
        scmRepositoryIdentityId: this.scmRepositoryIdentityId,
      },
      snapshot: { lineageHints: [] },
    };
    const projectionEnvelopeCanonicalJson = canonicalJson(projection);
    const projectionHash = sha256(projectionEnvelopeCanonicalJson);
    const operationsCanonicalJson = canonicalJson(projection.publishing);
    const artifactHash = sha256(
      `rr.review-artifact.v1\0${canonicalJson({ operationsCanonicalJson, projectionHash })}`,
    );
    const artifactId = `rr:artifact:${artifactHash}`;
    const versions = await this.prisma.reviewExecutionV2.findUniqueOrThrow({
      where: { executionId: flow.executionId },
      select: { version: true },
    });
    const stream = await this.prisma.reviewExecutionStreamV2.findUniqueOrThrow({
      where: {
        workspaceId_repositoryConnectionId_scmRepositoryIdentityId_pullRequestNumber:
          {
            workspaceId: this.workspaceId,
            repositoryConnectionId: this.repositoryConnectionId,
            scmRepositoryIdentityId: this.scmRepositoryIdentityId,
            pullRequestNumber,
          },
      },
      select: { version: true },
    });
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewExecutionFinalize,
      {
        ...envelope(`${flow.executionId}-finalize`),
        authorizationToken: flow.authorizationToken,
        idempotencyKey: `${flow.executionId}-finalize-idempotency`,
        requestBodyHash: zeroHash,
        executionId: flow.executionId,
        expectedStreamVersion: stream.version.toString(10),
        expectedExecutionVersion: versions.version.toString(10),
        artifactId,
        artifactHash,
        projectionEnvelopeVersion: 1,
        projectionEnvelopeCanonicalJson,
        projectionHash,
        lifecycleStateHash,
        commandLedgerWatermark,
        allowPartial,
      },
    );
    return requiredHandler(
      this.routes.execution.finalize,
      "execution_finalize",
    ).execute(request as ReviewExecutionFinalizeRequest);
  }

  async processFinalizedOutbox(
    input: {
      readonly handlers?: readonly OutboxHandler[];
      readonly takeoverEnabled?: boolean;
    } = {},
  ) {
    return processOutboxBatch(
      {
        limit: 20,
        handlers: input.handlers ?? this.worker.handlers,
        knownHandlers: this.worker.handlers,
        claimOwnerHash: sha256(`${this.prefix}-outbox-owner`),
        processingLeaseMs: 100,
        heartbeatIntervalMs: 50,
        takeoverEnabled: input.takeoverEnabled ?? true,
      },
      {
        outbox: new PrismaOutboxEventRepository(this.prisma),
        clock: new SystemClock(),
      },
    );
  }

  async runWorkerUntilSettled(maxPasses = 12): Promise<void> {
    for (let pass = 0; pass < maxPasses; pass += 1) {
      await this.worker.runMaintenance();
      const active = await this.prisma.reviewCompletionProcess.count({
        where: {
          state: {
            in: [
              "pending_publication",
              "awaiting_publication",
              "pending_snapshot",
            ],
          },
        },
      });
      if (active === 0) return;
    }
    throw new Error("review_v2_e2e_worker_did_not_settle");
  }

  async deadLetterAndRecoverFinalizedEvent(): Promise<void> {
    const permanentFailure: OutboxHandler = {
      type: reviewExecutionFinalizedEventType,
      version: reviewExecutionFinalizedEventVersion,
      async handle() {
        throw new OutboxHandlerError(
          "Injected permanent failure",
          "e2e_injected_permanent_failure",
          false,
        );
      },
    };
    const result = await this.processFinalizedOutbox({
      handlers: [permanentFailure],
    });
    if (result.deadLettered !== 1) {
      throw new Error("review_v2_e2e_dead_letter_not_created");
    }
    const event = await this.prisma.outboxEvent.findFirstOrThrow({
      where: {
        workspaceId: this.workspaceId,
        type: reviewExecutionFinalizedEventType,
        status: "dead_letter",
      },
      orderBy: { occurredAt: "desc" },
    });
    const recovered = await retryDeadLetterOutboxEvent(
      {
        workspaceId: this.workspaceId,
        eventId: event.id,
      },
      {
        outbox: new PrismaOutboxEventRepository(this.prisma),
        clock: new SystemClock(),
      },
    );
    if (recovered.status !== "queued") {
      throw new Error(`review_v2_e2e_dead_letter_recovery:${recovered.status}`);
    }
    const processed = await this.processFinalizedOutbox();
    if (processed.processed !== 1) {
      throw new Error("review_v2_e2e_recovered_event_not_processed");
    }
  }

  async forceStaleOutboxClaim(): Promise<void> {
    const outbox = new PrismaOutboxEventRepository(this.prisma);
    const claimed = await outbox.claimDue({
      limit: 1,
      now: new Date(),
      claimOwnerHash: sha256(`${this.prefix}-abandoned-owner`),
      claimForMs: 1,
      availableHandlers: this.worker.handlers,
      knownHandlers: this.worker.handlers,
    });
    if (claimed.length !== 1) {
      throw new Error("review_v2_e2e_stale_claim_not_acquired");
    }
    await this.prisma.outboxEvent.update({
      where: { id: claimed[0]!.id },
      data: { claimUntil: new Date(Date.now() - 1_000) },
    });
  }

  async forceStalePublicationClaim(): Promise<{
    readonly publicationAttemptId: string;
    readonly claimId: string;
    readonly fencingToken: bigint;
  }> {
    const attempt =
      await this.prisma.reviewPublicationAttemptV2.findFirstOrThrow({
        where: { workspaceId: this.workspaceId },
        orderBy: { createdAt: "desc" },
      });
    const now = new Date();
    const claimId = `${this.prefix}-abandoned-publication-claim`;
    const requestIdentity = sha256(`${claimId}-request`);
    const repository = new PrismaReviewPublicationRepository(this.prisma);
    const claimed = await repository.claim({
      publicationAttemptId: attempt.publicationAttemptId,
      expectedAttemptVersion: attempt.version,
      claimId,
      ownerIdHash: sha256(`${claimId}-owner`),
      acquireRequestIdHash: requestIdentity,
      requestHash: sha256(`${claimId}-body`),
      claimCapabilityId: `${claimId}-capability`,
      capabilitySigningKeyId: capabilityKeyId,
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + 1_000),
      reportUntil: new Date(now.getTime() + 2_000),
      retainUntil: attempt.retainUntil,
    });
    if (claimed.status !== ClaimReviewPublicationStatus.Acquired) {
      throw new Error(
        `review_v2_e2e_publication_claim_not_acquired:${claimed.status}`,
      );
    }
    await this.prisma.reviewPublicationClaimTermV2.update({
      where: { claimId },
      data: {
        acquiredAt: new Date(Date.now() - 2_000),
        renewedAt: new Date(Date.now() - 2_000),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    return {
      publicationAttemptId: attempt.publicationAttemptId,
      claimId,
      fencingToken: claimed.claim.fencingToken,
    };
  }

  setRevision(revision: FakeGitHubRevision): void {
    this.fakeGitHub.revision = revision;
  }

  async readPersistedCurrentRevision(): Promise<
    FakeGitHubRevision & { readonly reviewRevisionHash: string }
  > {
    const stream = await this.prisma.reviewExecutionStreamV2.findUniqueOrThrow({
      where: {
        workspaceId_repositoryConnectionId_scmRepositoryIdentityId_pullRequestNumber:
          {
            workspaceId: this.workspaceId,
            repositoryConnectionId: this.repositoryConnectionId,
            scmRepositoryIdentityId: this.scmRepositoryIdentityId,
            pullRequestNumber,
          },
      },
      select: {
        currentBaseSha: true,
        currentMergeBaseSha: true,
        currentHeadSha: true,
        currentReviewRevisionHash: true,
      },
    });
    return {
      baseSha: requiredString(stream.currentBaseSha),
      mergeBaseSha: requiredString(stream.currentMergeBaseSha),
      headSha: requiredString(stream.currentHeadSha),
      reviewRevisionHash: requiredString(stream.currentReviewRevisionHash),
    };
  }

  async movePersistedCurrentRevision(input: {
    readonly headSha: string;
    readonly reviewRevisionHash: string;
  }): Promise<void> {
    await this.prisma.reviewExecutionStreamV2.update({
      where: {
        workspaceId_repositoryConnectionId_scmRepositoryIdentityId_pullRequestNumber:
          {
            workspaceId: this.workspaceId,
            repositoryConnectionId: this.repositoryConnectionId,
            scmRepositoryIdentityId: this.scmRepositoryIdentityId,
            pullRequestNumber,
          },
      },
      data: {
        currentHeadSha: input.headSha,
        currentReviewRevisionHash: input.reviewRevisionHash,
        updatedAt: new Date(),
      },
    });
  }

  private async signOidcToken(): Promise<string> {
    this.oidcOrdinal += 1;
    const keyPair = oidcSigningKeys.get(this.fakeGitHub.options.oidcKeyId);
    if (!keyPair) throw new Error("review_v2_e2e_oidc_signing_key_missing");
    return new SignJWT({
      sub: `repo:${owner}/${repo}:pull_request`,
      repository: `${owner}/${repo}`,
      repository_id: githubRepositoryId,
      repository_owner: owner,
      event_name: "pull_request",
      ref: `refs/pull/${pullRequestNumber}/merge`,
      run_id: sourceRunId,
      run_attempt: "1",
      workflow_ref: `${owner}/${repo}/.github/workflows/reviewrouter.yml@refs/pull/${pullRequestNumber}/merge`,
      workflow_sha: this.fakeGitHub.revision.headSha,
      job_workflow_ref: `777genius/review-router/.github/workflows/reviewrouter-execution-reusable.yml@${actionCommitSha}`,
      job_workflow_sha: actionCommitSha,
      actor: "reviewrouter-e2e",
      jti: `${this.prefix}-oidc-${this.oidcOrdinal}`,
    })
      .setProtectedHeader({
        alg: "RS256",
        kid: this.fakeGitHub.options.oidcKeyId,
      })
      .setIssuer("https://token.actions.githubusercontent.com")
      .setAudience(requiredString(this.env.REVIEW_ROUTER_ACTION_OIDC_AUDIENCE))
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(keyPair.privateKey);
  }

  private async executeObservationAdoption(
    request: ReviewExecutionObservationAdoptRequest,
  ) {
    return requiredHandler(
      this.routes.execution.adoptObservation,
      "observation_adopt",
    ).execute(request);
  }
}

const oidcSigningKeys = new Map<
  string,
  ReturnType<typeof generateKeyPairSync>
>();

export async function createReviewActionV2E2EHarness(
  databaseUrl: string,
): Promise<ReviewActionV2E2EHarness> {
  return ReviewActionV2E2EHarness.create(databaseUrl);
}

export async function resetReviewActionV2E2EDatabase(
  databaseUrl: string,
): Promise<void> {
  assertDisposableDatabaseUrl(databaseUrl);
  const prisma = createPrismaClient({ databaseUrl, poolMax: 2 });
  try {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        "OutboxEvent",
        "ReviewCompletionProcess",
        "ReviewPublicationOutcomeCorrectionV2",
        "ReviewPublicationAuditTombstoneV2",
        "ReviewPublicationReceiptV2",
        "ReviewPublicationExternalEffectV2",
        "ReviewPublicationOperationAttemptV2",
        "ReviewPublicationOperationV2",
        "ReviewPublicationClaimTermV2",
        "ReviewPublicationRequestReceiptV2",
        "ReviewPublicationAttemptV2",
        "ReviewSnapshotCommitReceiptV2",
        "FinalizedReviewProjectionArtifactV2",
        "ReviewExecutionObservationRefV2",
        "ReviewInvocationLeaseTombstoneV2",
        "ReviewInvocationLeaseV2",
        "ReviewExecutionWorkSlotV2",
        "ReviewExecutionV2",
        "ReviewExecutionStreamV2",
        "ReviewRequestedIntent",
        "ReviewEvidenceObservation",
        "ReviewRunAuthorizationRenewalReceipt",
        "ReviewRunAuthorization",
        "ReviewSafetyPolicySelector",
        "ReviewSafetyPolicy",
        "ReviewSafetyEmergencyControl",
        "ReviewMutationAuthority",
        "ScmRepositoryIdentity",
        "ProducerRelease",
        "ReviewOperationalSloProfileV2",
        "ReviewProtocolLimitsV2",
        "ReviewSnapshot",
        "RepositoryConnection",
        "GitHubInstallation",
        "Workspace"
      RESTART IDENTITY CASCADE
    `);
    await prisma.reviewSafetyEmergencyControl.create({
      data: {
        emergencyControlId: "global-review-v2",
        policyScope: "global",
        workspaceId: null,
        repositoryConnectionId: null,
        scmRepositoryIdentityId: null,
        version: 1,
        stopped: true,
        reason: "review_v2_not_promoted",
        updatedBy: "migration:000029",
        updatedAt: new Date(),
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

export function permanentOutboxFailureHandler(): OutboxHandler {
  return {
    type: reviewExecutionFinalizedEventType,
    version: reviewExecutionFinalizedEventVersion,
    async handle() {
      throw new OutboxHandlerError(
        "Injected permanent failure",
        "e2e_injected_permanent_failure",
        false,
      );
    },
  };
}

async function seedProductionControlPlane(
  prisma: PrismaClient,
  ids: Readonly<{
    prefix: string;
    workspaceId: string;
    repositoryConnectionId: string;
    scmRepositoryIdentityId: string;
    producerReleaseId: string;
    protocolLimitsProfileId: string;
    operationalSloProfileId: string;
  }>,
): Promise<void> {
  const now = new Date();
  const limits: ReviewProtocolLimits = {
    maxWorkSlots: 20,
    maxAttemptsPerSlot: 4,
    maxObservationBytes: 1_000_000,
    maxObservationFindings: 1_000,
    maxProjectionBytes: 1_000_000,
    maxProjectionFindings: 1_000,
    maxPublicationOperations: 100,
    maxPublicationChunks: 100,
    maxPublicationBodyBytes: 1_000_000,
    maxRequestBatchSize: 100,
    maxLeaseDurationMs: 300_000,
    maxResultReportDurationMs: 600_000,
    maxReconciliationDurationMs: 600_000,
  };
  const slos: ReviewOperationalSloThresholds = {
    integrationEventDeliveryMs: 1_000,
    outboxClaimAgeMs: 1_000,
    missingCompletionProcessMs: 1_000,
    dueCompletionProcessMs: 1_000,
    publicationReconciliationMs: 1_000,
    v1DrainMs: 1_000,
    admissionMs: 1_000,
    pruningBacklogAgeMs: 1_000,
  };
  const ownerRefs = ["reviewrouter-e2e"];
  const runbookRefs = ["reviewrouter-e2e-runbook"];
  await prisma.reviewProtocolLimitsV2.create({
    data: {
      protocolLimitsProfileId: ids.protocolLimitsProfileId,
      limitsDigest: sha256(canonicalReviewProtocolLimits(limits)),
      ...limits,
      registeredAt: now,
    },
  });
  await prisma.reviewOperationalSloProfileV2.create({
    data: {
      operationalSloProfileId: ids.operationalSloProfileId,
      sloDigest: sha256(
        canonicalReviewOperationalSloProfile({
          thresholds: slos,
          ownerRefs,
          runbookRefs,
        }),
      ),
      ...slos,
      ownerRefs,
      runbookRefs,
      registeredAt: now,
    },
  });
  await prisma.producerRelease.create({
    data: {
      producerReleaseId: ids.producerReleaseId,
      distributionKind: "public_reusable",
      actionCommitSha,
      runtimeCommitSha,
      wrapperEntrypointDigest: null,
      runtimeEntrypointDigest: sha256("runtime-entrypoint"),
      schemaDigest: reviewActionV2PublishedSchemaDigest,
      capabilityProfile: "exact_revision_v2",
      protocolLimitsProfileId: ids.protocolLimitsProfileId,
      operationalSloProfileId: ids.operationalSloProfileId,
      registeredAt: now,
    },
  });
  const installationId = `${ids.prefix}-installation`;
  await prisma.workspace.create({
    data: {
      id: ids.workspaceId,
      slug: `${ids.prefix}-workspace`,
      name: "Disposable Review Action v2 E2E",
    },
  });
  await prisma.gitHubInstallation.create({
    data: {
      id: installationId,
      workspaceId: ids.workspaceId,
      githubInstallationId: BigInt(githubInstallationId),
      accountLogin: owner,
      accountType: "Organization",
      repositorySelection: "selected",
      status: "active",
    },
  });
  await prisma.scmRepositoryIdentity.create({
    data: {
      scmRepositoryIdentityId: ids.scmRepositoryIdentityId,
      provider: "github",
      normalizedSourceBaseUrl: "https://github.com",
      externalRepositoryId: githubRepositoryId,
      createdAt: now,
    },
  });
  await prisma.repositoryConnection.create({
    data: {
      id: ids.repositoryConnectionId,
      workspaceId: ids.workspaceId,
      provider: "github",
      sourceBaseUrl: "https://github.com",
      externalRepositoryId: githubRepositoryId,
      scmRepositoryIdentityId: ids.scmRepositoryIdentityId,
      installationId,
      githubRepositoryId: BigInt(githubRepositoryId),
      owner,
      name: repo,
      fullName: `${owner}/${repo}`,
      defaultBranch: "main",
      visibility: "private",
      selected: true,
    },
  });
  await prisma.scmRepositoryIdentity.update({
    where: { scmRepositoryIdentityId: ids.scmRepositoryIdentityId },
    data: {
      currentWorkspaceId: ids.workspaceId,
      currentRepositoryConnectionId: ids.repositoryConnectionId,
      boundAt: now,
    },
  });
  await prisma.reviewMutationAuthority.create({
    data: {
      scmRepositoryIdentityId: ids.scmRepositoryIdentityId,
      laneKind: "hosted_reviewrouter_app",
      version: 1,
      epoch: 1n,
      mode: "v2_active",
      managedWorkflowInventoryHash: sha256(`${ids.prefix}-inventory`),
      activationSafetyDecisionHash: sha256(`${ids.prefix}-activation`),
      initializedAt: now,
      activatedAt: now,
    },
  });
  await prisma.reviewSafetyEmergencyControl.update({
    where: { emergencyControlId: "global-review-v2" },
    data: {
      version: 2,
      stopped: false,
      reason: "e2e_enabled",
      updatedBy: "reviewrouter-e2e",
      updatedAt: now,
    },
  });
  for (const capability of [
    "run_authorization_v2",
    "evidence_writes_v2",
    "evidence_reuse_v2",
    "prompt_only_reuse",
    "context_gateway_reuse",
    "publication_operations_v2",
    "mutation_epoch_v2",
  ] as const) {
    await prisma.reviewSafetyPolicy.create({
      data: {
        policyId: `${ids.prefix}-policy-${capability}`,
        policyScope: "global",
        capability,
        workspaceId: null,
        repositoryConnectionId: null,
        scmRepositoryIdentityId: null,
        version: 1,
        rolloutMode: "enabled",
        updatedBy: "reviewrouter-e2e",
        updatedAt: now,
      },
    });
  }
}

function productionEnv(input: {
  readonly appPrivateKey: string;
  readonly producerReleaseId: string;
  readonly protocolLimitsProfileId: string;
  readonly operationalSloProfileId: string;
}): Readonly<Record<string, string>> {
  const signingKeys = JSON.stringify([
    {
      keyId: capabilityKeyId,
      secretBase64: Buffer.from(
        "review-v2-e2e-signing-secret-key-32b",
      ).toString("base64"),
      verifyUntil: null,
    },
  ]);
  return {
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: input.appPrivateKey,
    REVIEW_ROUTER_ACTION_OIDC_AUDIENCE: "reviewrouter-e2e",
    REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_ACTIVE_KEY_ID: capabilityKeyId,
    REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON: signingKeys,
    REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON: JSON.stringify([
      {
        producerReleaseId: input.producerReleaseId,
        distributionKind: "public_reusable",
        actionCommitSha,
        runtimeCommitSha,
        wrapperEntrypointDigest: null,
        runtimeEntrypointDigest: sha256("runtime-entrypoint"),
        schemaDigest: reviewActionV2PublishedSchemaDigest,
        canonicalizerDigest: reviewActionV2CanonicalizerDigest,
        capabilityProfile: "exact_revision_v2",
        protocolLimitsProfileId: input.protocolLimitsProfileId,
        operationalSloProfileId: input.operationalSloProfileId,
      },
    ]),
    [reviewActionV2ProviderVoteLanesEnv]: JSON.stringify([
      { providerKind: "codex", providerVoteIdentityHash },
    ]),
    [reviewActionV2ProjectionPolicyVersionEnv]: projectionPolicyVersion,
    [reviewActionV2CapabilityActiveKeyIdEnv]: capabilityKeyId,
    [reviewActionV2CapabilityKeysEnv]: signingKeys,
    [reviewV2WorkerEnabledEnv]: "1",
    REVIEW_ROUTER_REVIEW_V2_COMPLETION_CLAIM_MS: "1000",
    REVIEW_ROUTER_REVIEW_V2_PUBLICATION_CLAIM_MS: "1000",
    REVIEW_ROUTER_REVIEW_V2_MIN_MUTATION_LEASE_MS: "500",
    REVIEW_ROUTER_REVIEW_V2_PUBLICATION_BATCH_SIZE: "20",
    REVIEW_ROUTER_REVIEW_V2_RECOVERY_PAGE_SIZE: "2",
    REVIEW_ROUTER_REVIEW_V2_DUE_LIMIT: "20",
    REVIEW_ROUTER_REVIEW_V2_MAX_MARKER_PAGES: "4",
  };
}

function providerManifest(input: {
  readonly executionId: string;
  readonly producerReleaseId: string;
  readonly scopeHash: string;
  readonly selectedProtocolVersion: string;
}): ProviderInvocationManifest {
  return {
    manifestVersion: 1,
    scopeHash: input.scopeHash,
    taskKindSet: [EvidenceTaskKind.FindingDiscovery],
    providerKind: ReviewProviderKind.Codex,
    providerCapabilityHash: sha256(`${input.executionId}-provider-capability`),
    requestedModel: "gpt-5-codex",
    providerPolicyVersion: "provider-policy-v1",
    producerReleaseId: input.producerReleaseId,
    selectedProtocolVersion: input.selectedProtocolVersion,
    providerRequestEnvelopeHash: sha256(`${input.executionId}-request`),
    outputSchemaHash: sha256(`${input.executionId}-output-schema`),
    reviewConfigHash: sha256(`${input.executionId}-config`),
    runtimeCompatibilityKey: sha256(`${input.executionId}-runtime`),
    filePatchManifestHash: sha256(`${input.executionId}-patch`),
    contextManifestHash: sha256(`${input.executionId}-context`),
    memoryBundleHash: null,
    codeGraphProjectionHash: null,
    lifecycleTargetSetHash: null,
    liveLifecycleStateHash: null,
    toolPolicyHash: sha256(`${input.executionId}-tools`),
    executionProfile: ProviderExecutionProfile.PromptOnlyEnvelopeV1,
    baseTreeHash: sha256(`${input.executionId}-base-tree`),
    environmentContractHash: sha256(`${input.executionId}-environment`),
  };
}

const digestPort = {
  async digest(value: Uint8Array): Promise<string> {
    return createHash("sha256").update(value).digest("hex");
  },
  async digestUtf8(value: string): Promise<string> {
    return sha256(value);
  },
};

async function withBodyHash<Operation extends ReviewActionV2OperationId>(
  operation: Operation,
  request: ReviewActionV2RequestMap[Operation],
): Promise<ReviewActionV2RequestMap[Operation]> {
  return {
    ...request,
    requestBodyHash: sha256(
      canonicalizeReviewActionV2Request(operation, request),
    ),
  };
}

function envelope(requestId: string) {
  return {
    protocolVersion: reviewActionV2PublishedProtocolVersion,
    schemaDigest: reviewActionV2PublishedSchemaDigest,
    requestId,
  } as const;
}

function requiredHandler<T>(
  value: T | undefined,
  name: string,
): NonNullable<T> {
  if (!value) throw new Error(`review_v2_e2e_handler_missing:${name}`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("review_v2_e2e_record_expected");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("review_v2_e2e_string_expected");
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertDisposableDatabaseUrl(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const database = parsed.pathname.replace(/^\//u, "").toLowerCase();
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (!local || (!database.includes("test") && !database.includes("ci"))) {
    throw new Error("review_v2_e2e_requires_disposable_database");
  }
}

const zeroHash = "0".repeat(64);
