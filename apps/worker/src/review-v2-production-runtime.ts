import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  PrismaActionControlPlaneRepository,
  managedCodexWorkflowPath,
} from "@reviewrouter/features-action-control-plane";
import {
  ReviewCoverageState,
  DispatchDueReviewRequestedIntents,
  RecoverReviewRequestedDispatches,
  ReviewObservationAttachmentKind,
  ReviewRequestedIntentService,
  type ReviewExecutionQueryPort,
} from "@reviewrouter/features-review-executions";
import {
  ProviderExecutionProfile,
  ReviewProviderKind as EvidenceProviderKind,
  ReviewTaskKind as EvidenceTaskKind,
} from "@reviewrouter/features-review-evidence";
import { PrismaReviewObservationStore } from "@reviewrouter/features-review-evidence/composition";
import { PrismaInvestigationStore } from "@reviewrouter/features-review-investigations/composition";
import { ResolveInvestigationRollout } from "@reviewrouter/features-review-investigation-operations";
import {
  EnvironmentInvestigationRolloutPolicyQuery,
  RunControlInvestigationEmergencyStopQuery,
} from "@reviewrouter/features-review-investigation-operations/composition";
import type { OutboxHandler } from "@reviewrouter/features-outbox";
import {
  PrismaReviewExecutionStore,
  PrismaReviewRequestedIntentStore,
} from "@reviewrouter/features-review-executions/composition";
import {
  ReviewCompletionSchedulerMode,
  PrismaReviewCompletionProcessRepository,
  PrismaReviewCompletionRecoveryFeed,
  composeReviewCompletionProcesses,
} from "@reviewrouter/features-review-processes/composition";
import {
  CurrentMutationAuthorityStatus,
  CurrentPublicationLifecycleStatus,
  CurrentPublicationPermitStatus,
  CurrentReviewRevisionStatus,
  CurrentReviewSafetyDecisionStatus,
  ReviewPublicationAdjudicationEvidenceStatus,
  ReviewPublicationCapability,
  ReviewPublicationEffectStrategy,
  ReviewPublicationOperationPlanningService,
  ReviewPublicationLifecycleExpectationStatus,
  ReviewPublicationRunControlStatus,
  ReviewPublicationTerminalOutcome,
  ResolveCurrentPublicationLifecycle,
  effectiveReviewPublicationOutcome,
  reviewPublicationLifecycleExpectationFromProjection,
  type LiveReviewPublicationLifecyclePort,
  type ReviewPublicationAttemptQueryPort,
  type ReviewPublicationAdjudicationEvidencePort,
  type ReviewPublicationDecisionPorts,
  type ReviewPublicationPermitIdentity,
  type ReviewPublicationReleaseLimitsQueryPort,
  type ReviewPublicationScope,
} from "@reviewrouter/features-review-publishing/v2";
import {
  GitHubReviewPublicationLifecycleAdapter,
  OctokitGitHubInstallationGraphqlClientFactory,
  PrismaReviewPublicationRepository,
  createReviewPublicationV2Application,
  type GitHubReviewLifecycleRepositoryQueryPort,
} from "@reviewrouter/features-review-publishing/v2/composition";
import {
  ProducerReleaseState,
  ResolveReviewSafetyPolicy,
  ReviewMutationLaneKind,
  ReviewMutationMode,
  ReviewRunAuthorizationState,
  ReviewSafetyDecisionKind,
  ReviewSafetyPolicyScope,
} from "@reviewrouter/features-review-run-control";
import {
  PrismaProducerReleaseRepository,
  PrismaReviewMutationAuthorityRepository,
  PrismaReviewRunAuthorizationRepository,
  PrismaReviewSafetyControlRepository,
  PrismaScmRepositoryIdentityRepository,
  composeProductionReviewRunAuthorizationPrerequisites,
} from "@reviewrouter/features-review-run-control/composition";
import {
  SnapshotEffectivePublicationOutcome,
  SnapshotSourceCoverageState,
  type ReviewSnapshotCommitEligibilityPort,
} from "@reviewrouter/features-review-snapshots/v2";
import {
  PrismaReviewSnapshotV2Repository,
  createReviewSnapshotV2Application,
} from "@reviewrouter/features-review-snapshots/v2/composition";
import type { createPrismaClient } from "@reviewrouter/platform-db";
import {
  ConfiguredCapabilityKeyRing,
  JoseRotatingCapabilityCodec,
  type ConfiguredCapabilityVerificationKey,
} from "@reviewrouter/platform-signed-capabilities";
import type { SystemClock } from "@reviewrouter/shared";
import {
  DeterministicReviewPublicationRequestFactory,
  ReviewCompletionExecutionContextAdapter,
  ReviewCompletionPublicationContextAdapter,
  ReviewCompletionSnapshotContextAdapter,
  reviewPublicationReceiptSetHash,
  type FinalizedArtifactIdentityQueryPort,
} from "./review-v2-context-adapters";
import {
  GitHubAppReviewV2CredentialProvider,
  ProviderNeutralReviewV2ScmCredentialRouter,
  RotatingReviewV2OperationCapabilityIssuer,
  SignedReviewV2OperationCapabilityVerifier,
  type ReviewV2GitHubRepositoryQueryPort,
} from "./review-v2-publication-gateways";
import { ExecuteReviewV2PublicationOperation } from "./review-v2-publication-executor";
import {
  ReviewV2PublicationCompensationDecision,
  ReviewV2PublicationExecutionStatus,
  ReviewV2PublicationFreshnessReadStatus,
  ReviewV2ScmProvider,
  type ReviewV2PublicationCompensationPolicyPort,
  type ReviewV2PublicationFreshnessPort,
  type ReviewV2ScmLiveRevisionPort,
} from "./review-v2-publication-ports";
import { createProductionReviewInvestigationPublicationEffectGate } from "./review-v2-production-publication-effect-gate";
import {
  CanonicalReviewV2ProjectionAdapter,
  type ReviewV2FinalizedArtifactQueryPort,
} from "./review-v2-publication-payloads";
import {
  createReviewV2WorkerOwnerId,
  type ReviewV2CompletionRuntime,
  type ReviewV2PublicationMaintenanceRuntime,
} from "./review-v2-worker-runtime";
import { GitHubActionsReviewRequestedDispatchGateway } from "./review-v2-intent-dispatcher";
import { GitHubReviewRequestEligibilityGateway } from "./review-v2-request-eligibility-gateway";
import { createGitHubReviewRequestIngressHandler } from "./review-v2-github-request-ingress-handler";
import {
  ReviewRequestIngressApplicationService,
  createReviewRequestIngressHandler,
} from "./review-v2-request-ingress-handler";
import {
  VerifyCurrentContextReusePublicationPolicy,
  type ContextReusePublicationBinding,
  type ContextReusePublicationBindingQueryPort,
  type ContextReuseProducerReleaseQueryPort,
  type ReviewV2ContextReusePublicationGuardPort,
} from "./review-v2-context-reuse-publication-guard";

type PrismaClient = ReturnType<typeof createPrismaClient>;

export const reviewV2CapabilityActiveKeyIdEnv =
  "REVIEW_ROUTER_REVIEW_V2_CAPABILITY_ACTIVE_KEY_ID";
export const reviewV2CapabilityKeysEnv =
  "REVIEW_ROUTER_REVIEW_V2_CAPABILITY_KEYS_JSON";

export type ProductionReviewV2WorkerRuntime = {
  readonly runtime: ReviewV2CompletionRuntime;
  readonly wakeups: ReviewCompletionExecutionContextAdapter;
  readonly ownerIdHash: string;
  readonly dueLimit: number;
  readonly intents: {
    runMaintenance(): Promise<{
      readonly scanned: number;
      readonly dispatched: number;
      readonly recovered: number;
      readonly failed: number;
    }>;
  };
  readonly publication: ReviewV2PublicationMaintenanceRuntime;
  readonly ingressHandlers: readonly OutboxHandler[];
};

export function createProductionReviewV2WorkerRuntime(input: {
  readonly prisma: PrismaClient;
  readonly clock: SystemClock;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly githubAppId: string;
  readonly githubPrivateKey: string;
}): ProductionReviewV2WorkerRuntime {
  const capabilityKeyRing = readCapabilityKeyRing(input.env);
  const executions = new PrismaReviewExecutionStore(input.prisma);
  const observations = new PrismaReviewObservationStore(input.prisma);
  const investigations = new PrismaInvestigationStore(input.prisma);
  const attempts = new PrismaReviewPublicationRepository(input.prisma);
  const releases = new PrismaProducerReleaseRepository(input.prisma);
  const authorizations = new PrismaReviewRunAuthorizationRepository(
    input.prisma,
  );
  const authorities = new PrismaReviewMutationAuthorityRepository(input.prisma);
  const safetyControls = new PrismaReviewSafetyControlRepository(input.prisma);
  const safetyResolver = new ResolveReviewSafetyPolicy({
    clock: input.clock,
    digest: { digestUtf8: async (value) => sha256(value) },
    policyQueries: safetyControls,
    emergencyQueries: safetyControls,
  });
  const githubRepositories = new PrismaReviewV2GitHubRepositoryQuery(
    input.prisma,
  );
  const decisions = createProductionPublicationDecisions({
    executions,
    releases,
    authorizations,
    authorities,
    safetyResolver,
    liveLifecycle: new GitHubReviewPublicationLifecycleAdapter(
      githubRepositories,
      new OctokitGitHubInstallationGraphqlClientFactory({
        appId: input.githubAppId,
        privateKey: input.githubPrivateKey,
      }),
    ),
  });
  const contextReusePublicationPolicy =
    new VerifyCurrentContextReusePublicationPolicy({
      bindings: new PrismaContextReusePublicationBindingQuery(
        input.prisma,
        executions,
      ),
      releases: new ProductionContextReuseProducerReleaseQuery(releases),
      safety: safetyResolver,
      clock: input.clock,
    });
  const publicationApplication = createReviewPublicationV2Application({
    clock: input.clock,
    decisions,
    attempts,
    idempotency: attempts,
    adjudicationEvidence: productionReviewV2AdjudicationEvidence,
    commands: {
      requests: attempts,
      claims: attempts,
      claimRenewals: attempts,
      operationBegins: attempts,
      effects: attempts,
      completions: attempts,
      terminalizations: attempts,
      adjudications: attempts,
    },
    enabledCapabilities: productionReviewV2PublicationCapabilities(),
  });
  const artifacts = new PrismaReviewV2ArtifactQuery(
    input.prisma,
    executions,
    releases,
  );
  const projections = new CanonicalReviewV2ProjectionAdapter(artifacts);
  const publicationPlanner = new ReviewPublicationOperationPlanningService(
    new RunControlPublicationLimitsQuery(releases),
  );
  const executionContext = new ReviewCompletionExecutionContextAdapter(
    executions,
  );
  const publicationContext = new ReviewCompletionPublicationContextAdapter(
    executions,
    attempts,
    publicationApplication,
    new DeterministicReviewPublicationRequestFactory(
      projections,
      publicationPlanner,
      attempts,
    ),
  );
  const snapshots = new PrismaReviewSnapshotV2Repository(input.prisma);
  const artifactIdentities = new PrismaFinalizedArtifactIdentityQuery(
    input.prisma,
  );
  const snapshotApplication = createReviewSnapshotV2Application({
    commands: snapshots,
    queries: snapshots,
    eligibility: new PrismaReviewSnapshotEligibility(
      executions,
      attempts,
      artifactIdentities,
    ),
  });
  const snapshotContext = new ReviewCompletionSnapshotContextAdapter(
    executions,
    artifactIdentities,
    attempts,
    snapshots,
    snapshotApplication,
    projections,
    snapshots,
  );
  const claimDurationMs = positiveInteger(
    input.env.REVIEW_ROUTER_REVIEW_V2_COMPLETION_CLAIM_MS,
    60_000,
    "review_v2_completion_claim_ms_invalid",
  );
  const completion = composeReviewCompletionProcesses({
    processes: new PrismaReviewCompletionProcessRepository(input.prisma),
    executions: executionContext,
    publications: publicationContext,
    snapshots: snapshotContext,
    clock: input.clock,
    ids: { nextClaimId: () => `review-v2-completion-${randomUUID()}` },
    claimDurationMs,
    retryDelayMs: boundedRetryDelay,
    schedulerMode: ReviewCompletionSchedulerMode.Enabled,
    recoveryFeed: new PrismaReviewCompletionRecoveryFeed(input.prisma),
    recoveryPageSize: positiveInteger(
      input.env.REVIEW_ROUTER_REVIEW_V2_RECOVERY_PAGE_SIZE,
      100,
      "review_v2_recovery_page_size_invalid",
    ),
  });
  if (completion.schedulers.mode !== ReviewCompletionSchedulerMode.Enabled) {
    throw new Error("review_v2_completion_scheduler_not_enabled");
  }
  const githubProvider = new GitHubAppReviewV2CredentialProvider(
    {
      appId: input.githubAppId,
      privateKey: input.githubPrivateKey,
    },
    githubRepositories,
    projections,
  );
  const operationCapabilityIssuer =
    new RotatingReviewV2OperationCapabilityIssuer(
      capabilityKeyRing,
      input.clock,
    );
  const capabilityCodec = new JoseRotatingCapabilityCodec(capabilityKeyRing);
  const credentials = new ProviderNeutralReviewV2ScmCredentialRouter(
    [githubProvider],
    new SignedReviewV2OperationCapabilityVerifier(
      { verify: (request) => capabilityCodec.verify(request) },
      input.clock,
    ),
  );
  const freshness = new ProductionReviewV2Freshness(
    decisions,
    [githubProvider],
    contextReusePublicationPolicy,
  );
  const ownerIdHash = createReviewV2WorkerOwnerId(
    `${hostname()}:${process.pid}:${randomUUID()}`,
  );
  const requestedIntents = new PrismaReviewRequestedIntentStore(input.prisma);
  const intentService = new ReviewRequestedIntentService(
    requestedIntents,
    requestedIntents,
  );
  const intentPrerequisites =
    composeProductionReviewRunAuthorizationPrerequisites({
      githubAppId: input.githubAppId,
      githubAppPrivateKey: input.githubPrivateKey,
      env: input.env,
      releases,
      digest: { digestUtf8: async (value) => sha256(value) },
    });
  const draftRepositories = new Set(
    (input.env.REVIEW_ROUTER_REVIEW_V2_DRAFT_REPOSITORIES ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const ingressApplicationDependencies = {
    intents: intentService,
    revisions: intentPrerequisites.revisionResolver,
    eligibility: new GitHubReviewRequestEligibilityGateway({
      appId: input.githubAppId,
      privateKey: input.githubPrivateKey,
    }),
    digest: { digestUtf8: async (value: string) => sha256(value) },
    clock: input.clock,
    reviewDrafts: (repositoryFullName: string) =>
      draftRepositories.has(repositoryFullName.toLowerCase()),
  } as const;
  const ingressApplication = new ReviewRequestIngressApplicationService(
    ingressApplicationDependencies,
  );
  const ingressHandlers = [
    createGitHubReviewRequestIngressHandler({
      repositories: new PrismaActionControlPlaneRepository(input.prisma),
      identities: new PrismaScmRepositoryIdentityRepository(input.prisma),
      application: ingressApplication,
      readyQuietPeriodMs: positiveInteger(
        input.env.REVIEW_ROUTER_REVIEW_V2_READY_QUIET_PERIOD_MS,
        15_000,
        "review_v2_ready_quiet_period_invalid",
      ),
      draftQuietPeriodMs: positiveInteger(
        input.env.REVIEW_ROUTER_REVIEW_V2_DRAFT_QUIET_PERIOD_MS,
        45_000,
        "review_v2_draft_quiet_period_invalid",
      ),
      retentionMs: positiveInteger(
        input.env.REVIEW_ROUTER_REVIEW_V2_INTENT_RETENTION_MS,
        2_592_000_000,
        "review_v2_intent_retention_invalid",
      ),
    }),
    createReviewRequestIngressHandler(ingressApplicationDependencies),
  ] as const;
  const intentGateway = new GitHubActionsReviewRequestedDispatchGateway(
    input.prisma,
    { appId: input.githubAppId, privateKey: input.githubPrivateKey },
    input.env.REVIEW_ROUTER_REVIEW_V2_WORKFLOW_PATH?.trim() ||
      managedCodexWorkflowPath,
  );
  const intentClaimDurationMs = positiveInteger(
    input.env.REVIEW_ROUTER_REVIEW_V2_INTENT_CLAIM_MS,
    60_000,
    "review_v2_intent_claim_ms_invalid",
  );
  const intentDispatchResolutionTimeoutMs = positiveInteger(
    input.env.REVIEW_ROUTER_REVIEW_V2_INTENT_DISPATCH_RESOLUTION_TIMEOUT_MS,
    300_000,
    "review_v2_intent_dispatch_resolution_timeout_ms_invalid",
  );
  const intentAuthorizationResolutionTimeoutMs = positiveInteger(
    input.env.REVIEW_ROUTER_REVIEW_V2_INTENT_AUTHORIZATION_TIMEOUT_MS,
    1_800_000,
    "review_v2_intent_authorization_timeout_ms_invalid",
  );
  const intentRetryMs = positiveInteger(
    input.env.REVIEW_ROUTER_REVIEW_V2_INTENT_RETRY_MS,
    30_000,
    "review_v2_intent_retry_ms_invalid",
  );
  const intentRetentionMs = positiveInteger(
    input.env.REVIEW_ROUTER_REVIEW_V2_INTENT_RETENTION_MS,
    2_592_000_000,
    "review_v2_intent_retention_ms_invalid",
  );
  const intentMaxDispatchAttempts = positiveInteger(
    input.env.REVIEW_ROUTER_REVIEW_V2_INTENT_MAX_DISPATCH_ATTEMPTS,
    3,
    "review_v2_intent_max_dispatch_attempts_invalid",
  );
  const intentIds = {
    nextClaimId: () => `review-request-dispatch-${randomUUID()}`,
    nextRequestId: () => `review-request-${randomUUID()}`,
  };
  const intentDigest = { digestUtf8: async (value: string) => sha256(value) };
  const intentDispatchPolicy = {
    claimDurationMs: intentClaimDurationMs,
    dispatchResolutionDelayMs: intentRetryMs,
    dispatchResolutionTimeoutMs: intentDispatchResolutionTimeoutMs,
    authorizationResolutionDelayMs: intentRetryMs,
    authorizationResolutionTimeoutMs: intentAuthorizationResolutionTimeoutMs,
    retryDelayMs: intentRetryMs,
    retentionMs: intentRetentionMs,
    maxDispatchAttempts: intentMaxDispatchAttempts,
  };
  const intentDispatcher = new DispatchDueReviewRequestedIntents(
    requestedIntents,
    requestedIntents,
    intentGateway,
    input.clock,
    intentIds,
    intentDigest,
    intentDispatchPolicy,
  );
  const intentRecovery = new RecoverReviewRequestedDispatches(
    requestedIntents,
    requestedIntents,
    intentGateway,
    input.clock,
    { ids: intentIds, digest: intentDigest },
    intentDispatchPolicy,
  );
  const publicationExecutor = new ExecuteReviewV2PublicationOperation(
    {
      attempts,
      application: publicationApplication,
      freshness,
      compensation: conservativeCompensationPolicy,
      operationCapabilities: operationCapabilityIssuer,
      credentials,
      capabilityIdentity: {
        activeSigningKeyId: async () =>
          (await capabilityKeyRing.activeSigningKey()).keyId,
      },
      effectGate: createProductionReviewInvestigationPublicationEffectGate({
        executions,
        observations,
        investigations,
        authorizations,
        rollout: new ResolveInvestigationRollout(
          new EnvironmentInvestigationRolloutPolicyQuery(input.env),
          new RunControlInvestigationEmergencyStopQuery({
            findApplicable: async (target) =>
              (
                await safetyControls.findApplicableReviewSafetyEmergencyControls(
                  {
                    workspaceId: target.workspaceId,
                    repositoryConnectionId: target.repositoryConnectionId,
                    scmRepositoryIdentityId: target.scmRepositoryIdentityId,
                  },
                )
              ).map((control) => ({
                global: control.scope.scope === ReviewSafetyPolicyScope.Global,
                stopped: control.stopped,
              })),
          }),
        ),
      }),
      clock: input.clock,
    },
    {
      claimDurationMs: positiveInteger(
        input.env.REVIEW_ROUTER_REVIEW_V2_PUBLICATION_CLAIM_MS,
        60_000,
        "review_v2_publication_claim_ms_invalid",
      ),
      minimumMutationLeaseMs: positiveInteger(
        input.env.REVIEW_ROUTER_REVIEW_V2_MIN_MUTATION_LEASE_MS,
        30_000,
        "review_v2_min_mutation_lease_ms_invalid",
      ),
      maxMarkerPages: positiveInteger(
        input.env.REVIEW_ROUTER_REVIEW_V2_MAX_MARKER_PAGES,
        100,
        "review_v2_max_marker_pages_invalid",
      ),
    },
  );
  const publication = new ReviewV2PublicationMaintenance(
    new PrismaReviewV2PublicationWorkFeed(input.prisma),
    publicationExecutor,
    input.clock,
    ownerIdHash,
    {
      limit: positiveInteger(
        input.env.REVIEW_ROUTER_REVIEW_V2_PUBLICATION_BATCH_SIZE,
        10,
        "review_v2_publication_batch_size_invalid",
      ),
      minimumRetryMs: positiveInteger(
        input.env.REVIEW_ROUTER_REVIEW_V2_PUBLICATION_RETRY_MS,
        5_000,
        "review_v2_publication_retry_ms_invalid",
      ),
    },
  );
  const runtime: ReviewV2CompletionRuntime = {
    wake: completion.wake,
    advance: completion.advance,
    schedulers: {
      mode: ReviewCompletionSchedulerMode.Enabled,
      due: completion.schedulers.due,
      recovery: completion.schedulers.recovery,
    },
  };
  return {
    runtime,
    wakeups: executionContext,
    ownerIdHash,
    dueLimit: positiveInteger(
      input.env.REVIEW_ROUTER_REVIEW_V2_DUE_LIMIT,
      25,
      "review_v2_due_limit_invalid",
    ),
    intents: {
      runMaintenance: async () => {
        const limit = positiveInteger(
          input.env.REVIEW_ROUTER_REVIEW_V2_INTENT_BATCH_SIZE,
          10,
          "review_v2_intent_batch_size_invalid",
        );
        const recovery = await intentRecovery.execute({ limit });
        const dispatch = await intentDispatcher.execute({
          ownerIdHash,
          limit,
        });
        return {
          scanned: recovery.scanned + dispatch.scanned,
          dispatched: dispatch.dispatched,
          recovered: recovery.recovered,
          failed: recovery.failed + dispatch.failed,
        };
      },
    },
    publication,
    ingressHandlers,
  };
}

export function productionReviewV2PublicationCapabilities(): ReadonlySet<ReviewPublicationCapability> {
  return new Set([
    ReviewPublicationCapability.Request,
    ReviewPublicationCapability.Claim,
    ReviewPublicationCapability.ClaimReconciliation,
    ReviewPublicationCapability.BeginOperation,
  ]);
}

export const productionReviewV2AdjudicationEvidence: ReviewPublicationAdjudicationEvidencePort =
  Object.freeze({
    async resolve() {
      return {
        status: ReviewPublicationAdjudicationEvidenceStatus.Unavailable,
        reason: "operator_adjudication_requires_live_inventory",
      } as const;
    },
  });

function createProductionPublicationDecisions(input: {
  readonly executions: PrismaReviewExecutionStore;
  readonly releases: PrismaProducerReleaseRepository;
  readonly authorizations: PrismaReviewRunAuthorizationRepository;
  readonly authorities: PrismaReviewMutationAuthorityRepository;
  readonly safetyResolver: ResolveReviewSafetyPolicy;
  readonly liveLifecycle: LiveReviewPublicationLifecyclePort;
}): ReviewPublicationDecisionPorts {
  const lifecycle = new ResolveCurrentPublicationLifecycle({
    expectations: {
      async resolve(scope) {
        try {
          const stream = await input.executions.findStream(scope);
          const snapshot = stream?.activeExecutionId
            ? await input.executions.findExecution(stream.activeExecutionId)
            : null;
          const artifact = snapshot?.artifact;
          if (!artifact) {
            return {
              status: ReviewPublicationLifecycleExpectationStatus.Missing,
            };
          }
          const authorization =
            await input.authorizations.findReviewRunAuthorizationById(
              artifact.publicationPermit.authorizationId,
            );
          if (!authorization) {
            return {
              status: ReviewPublicationLifecycleExpectationStatus.Missing,
            };
          }
          return reviewPublicationLifecycleExpectationFromProjection({
            reviewedHeadSha: artifact.reviewedHeadSha,
            lifecycleStateHash: artifact.lifecycleStateHash,
            commandLedgerWatermark: artifact.commandLedgerWatermark,
            projectionEnvelopeJson: artifact.projectionEnvelopeJson,
            authorizationCreatedAt: authorization.createdAt,
          });
        } catch {
          return {
            status: ReviewPublicationLifecycleExpectationStatus.Unavailable,
          };
        }
      },
    },
    live: input.liveLifecycle,
  });
  return {
    permits: {
      async resolve(identity) {
        try {
          const snapshot = await input.executions.findExecution(
            identity.executionId,
          );
          const artifact = snapshot?.artifact;
          if (!artifact) {
            return {
              status: CurrentPublicationPermitStatus.Missing,
              reason: "finalized_artifact_missing",
            };
          }
          const stream = await input.executions.findStream({
            workspaceId: artifact.publicationPermit.workspaceId,
            repositoryConnectionId:
              artifact.publicationPermit.repositoryConnectionId,
            scmRepositoryIdentityId:
              artifact.publicationPermit.scmRepositoryIdentityId,
            pullRequestNumber: artifact.publicationPermit.pullRequestNumber,
          });
          if (
            artifact.generation !== identity.generation ||
            artifact.projectionHash !== identity.projectionHash ||
            stream?.activeExecutionId !== identity.executionId ||
            stream.lastAllocatedGeneration !== identity.generation
          ) {
            return {
              status: CurrentPublicationPermitStatus.Stale,
              reason: "execution_permit_not_current",
            };
          }
          return {
            status: CurrentPublicationPermitStatus.Current,
            permit: artifact.publicationPermit,
          };
        } catch {
          return {
            status: CurrentPublicationPermitStatus.Unavailable,
            reason: "execution_permit_unavailable",
          };
        }
      },
    },
    runControl: {
      async resolve(identity) {
        try {
          const [authorization, release] = await Promise.all([
            input.authorizations.findReviewRunAuthorizationById(
              identity.authorizationId,
            ),
            input.releases.findProducerReleaseById(identity.producerReleaseId),
          ]);
          if (!authorization || !release) {
            return {
              status: ReviewPublicationRunControlStatus.Missing,
              ...identity,
            };
          }
          if (authorization.producerReleaseId !== identity.producerReleaseId) {
            return {
              status: ReviewPublicationRunControlStatus.Missing,
              ...identity,
            };
          }
          if (authorization.state === ReviewRunAuthorizationState.Revoked) {
            return {
              status: ReviewPublicationRunControlStatus.AuthorizationRevoked,
              ...identity,
            };
          }
          if (release.state === ProducerReleaseState.Revoked) {
            return {
              status: ReviewPublicationRunControlStatus.ProducerReleaseRevoked,
              ...identity,
            };
          }
          return {
            status: ReviewPublicationRunControlStatus.Allowed,
            ...identity,
          };
        } catch {
          return {
            status: ReviewPublicationRunControlStatus.Unavailable,
            ...identity,
          };
        }
      },
    },
    authority: {
      async resolve(scope) {
        try {
          const authority = await input.authorities.findReviewMutationAuthority(
            {
              scmRepositoryIdentityId: scope.scmRepositoryIdentityId,
              laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
            },
          );
          if (!authority) {
            return {
              status: CurrentMutationAuthorityStatus.Missing,
              mutationEpoch: null,
            };
          }
          return {
            status:
              authority.mode === ReviewMutationMode.V2Active
                ? CurrentMutationAuthorityStatus.Active
                : CurrentMutationAuthorityStatus.Inactive,
            mutationEpoch: authority.epoch,
          };
        } catch {
          return {
            status: CurrentMutationAuthorityStatus.Unavailable,
            mutationEpoch: null,
          };
        }
      },
    },
    revision: {
      async resolve(scope) {
        try {
          const stream = await input.executions.findStream(scope);
          if (!stream?.currentRevision) {
            return {
              status: CurrentReviewRevisionStatus.Missing,
              reviewedHeadSha: null,
              reviewRevisionHash: null,
            };
          }
          return {
            status: CurrentReviewRevisionStatus.Current,
            reviewedHeadSha: stream.currentRevision.headSha,
            reviewRevisionHash: stream.currentRevision.reviewRevisionHash,
          };
        } catch {
          return {
            status: CurrentReviewRevisionStatus.Unavailable,
            reviewedHeadSha: null,
            reviewRevisionHash: null,
          };
        }
      },
    },
    lifecycle: {
      resolve: (scope) => lifecycle.resolve(scope),
    },
    safety: {
      async resolve(request) {
        try {
          const decision = await input.safetyResolver.resolveReviewSafetyPolicy(
            {
              decisionKind: ReviewSafetyDecisionKind.PublicationMutation,
              target: request.scope,
            },
          );
          return {
            status: decision.effectAllowed
              ? CurrentReviewSafetyDecisionStatus.Allowed
              : CurrentReviewSafetyDecisionStatus.Disabled,
            decisionHash: decision.safetyDecisionHash,
          };
        } catch {
          return {
            status: CurrentReviewSafetyDecisionStatus.Unavailable,
            decisionHash: null,
          };
        }
      },
    },
  };
}

class PrismaContextReusePublicationBindingQuery implements ContextReusePublicationBindingQueryPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly executions: ReviewExecutionQueryPort,
  ) {}

  async findContextReuseBindings(executionId: string) {
    const snapshot = await this.executions.findExecution(executionId);
    if (!snapshot) return null;
    const refs = snapshot.observationRefs.filter(
      (ref) =>
        ref.attachmentKind ===
        ReviewObservationAttachmentKind.ContextGatewayCrossRevisionReuse,
    );
    if (refs.length === 0) return [];
    const observations = await this.prisma.reviewEvidenceObservation.findMany({
      where: { observationId: { in: refs.map((ref) => ref.observationId) } },
      include: {
        contextDependencyAttestation: {
          include: { session: true },
        },
      },
    });
    const byId = new Map(
      observations.map((observation) => [
        observation.observationId,
        observation,
      ]),
    );
    const bindings: ContextReusePublicationBinding[] = [];
    for (const ref of refs) {
      const observation = byId.get(ref.observationId);
      if (!observation) return null;
      const attestation = observation.contextDependencyAttestation;
      const session = attestation?.session ?? null;
      bindings.push({
        targetExecutionId: executionId,
        targetWorkSlotId: ref.workSlotId,
        reusePolicyVectorHash: ref.reuseSafetyDecisionHash,
        observation: {
          observationId: observation.observationId,
          workspaceId: observation.workspaceId,
          repositoryConnectionId: observation.repositoryConnectionId,
          scmRepositoryIdentityId: observation.scmRepositoryIdentityId,
          pullRequestNumber: observation.pullRequestNumber,
          providerKind: evidenceProviderKind(observation.providerKind),
          taskKindSet: observation.taskKindSet.map(evidenceTaskKind),
          requestedModel: observation.requestedModel,
          actualModel: observation.actualModel,
          providerRuntimeVersion: observation.providerRuntimeVersion,
          producerReleaseId: observation.producerReleaseId,
          selectedProtocolVersion: observation.selectedProtocolVersion,
          trustedCapabilityProfile: observation.trustedCapabilityProfile,
          executionProfile: evidenceExecutionProfile(
            observation.executionProfile,
          ),
          sourceExecutionId: observation.sourceExecutionId,
          sourceWorkSlotId: observation.sourceWorkSlotId,
          sourceReviewRevisionHash: observation.sourceReviewRevisionHash,
          attemptId: observation.attemptId,
          sourceLeaseId: observation.sourceLeaseId,
          sourceFencingToken: observation.sourceFencingToken.toString(),
          contextAttestationId: observation.contextDependencyAttestationId,
          contextAttestationHash: observation.contextDependencyAttestationHash,
          reuseExpiresAtMs: observation.reuseExpiresAt.getTime(),
        },
        attestation: attestation
          ? {
              attestationId: attestation.attestationId,
              attestationHash: attestation.attestationHash,
              sessionId: attestation.sessionId,
              sourceExecutionId: session!.sourceExecutionId,
              sourceWorkSlotId: session!.sourceWorkSlotId,
              sourceReviewRevisionHash: session!.sourceReviewRevisionHash,
              attemptId: session!.attemptId,
              sourceLeaseId: session!.sourceLeaseId,
              sourceFencingToken: session!.sourceFencingToken.toString(),
              actualModel: attestation.actualModel,
              reuseExpiresAtMs: attestation.reuseExpiresAt.getTime(),
            }
          : null,
        session: session
          ? {
              sessionId: session.sessionId,
              workspaceId: session.workspaceId,
              repositoryConnectionId: session.repositoryConnectionId,
              scmRepositoryIdentityId: session.scmRepositoryIdentityId,
              pullRequestNumber: session.pullRequestNumber,
              sourceExecutionId: session.sourceExecutionId,
              sourceWorkSlotId: session.sourceWorkSlotId,
              sourceReviewRevisionHash: session.sourceReviewRevisionHash,
              attemptId: session.attemptId,
              sourceLeaseId: session.sourceLeaseId,
              sourceFencingToken: session.sourceFencingToken.toString(),
              requestedModel: session.requestedModel,
              trustedCapabilityProfile: session.trustedCapabilityProfile,
              gatewayPolicyVersion: session.gatewayPolicyVersion,
              gatewayBinaryHash: session.gatewayBinaryHash,
              producerReleaseId: session.producerReleaseId,
              selectedProtocolVersion: session.selectedProtocolVersion,
              state: session.state,
              expiresAtMs: session.expiresAt.getTime(),
            }
          : null,
      });
    }
    return bindings;
  }
}

class ProductionContextReuseProducerReleaseQuery implements ContextReuseProducerReleaseQueryPort {
  constructor(private readonly releases: PrismaProducerReleaseRepository) {}

  async findContextReuseProducerRelease(producerReleaseId: string) {
    const release =
      await this.releases.findProducerReleaseById(producerReleaseId);
    return release
      ? {
          producerReleaseId: release.producerReleaseId,
          registered: release.state === ProducerReleaseState.Registered,
          capabilityProfile: release.capabilityProfile,
          runtimeCommitSha: release.runtimeCommitSha,
          contextGatewayPolicyVersion: release.contextGatewayPolicyVersion,
          contextGatewayEntrypointDigest:
            release.contextGatewayEntrypointDigest,
        }
      : null;
  }
}

class ProductionReviewV2Freshness implements ReviewV2PublicationFreshnessPort {
  constructor(
    private readonly decisions: ReviewPublicationDecisionPorts,
    sources: readonly ReviewV2ScmLiveRevisionPort[],
    private readonly contextReusePolicy: ReviewV2ContextReusePublicationGuardPort,
  ) {
    this.sources = new Map(sources.map((source) => [source.provider, source]));
  }

  private readonly sources: ReadonlyMap<
    ReviewV2ScmProvider,
    ReviewV2ScmLiveRevisionPort
  >;

  async read(
    provider: ReviewV2ScmProvider,
    permit: ReviewPublicationPermitIdentity,
  ) {
    const scope = {
      workspaceId: permit.workspaceId,
      repositoryConnectionId: permit.repositoryConnectionId,
      scmRepositoryIdentityId: permit.scmRepositoryIdentityId,
      pullRequestNumber: permit.pullRequestNumber,
    };
    const source = this.sources.get(provider);
    if (!source) {
      return {
        status: ReviewV2PublicationFreshnessReadStatus.Unavailable,
        safeReason: "publication_live_scm_provider_unavailable",
      } as const;
    }
    const [
      liveRevision,
      currentPermit,
      runControl,
      authority,
      lifecycle,
      safety,
      contextReuseCurrent,
    ] = await Promise.all([
      source.readLiveRevision(permit),
      this.decisions.permits.resolve({
        executionId: permit.executionId,
        generation: permit.generation,
        projectionHash: permit.projectionHash,
      }),
      this.decisions.runControl.resolve({
        authorizationId: permit.authorizationId,
        producerReleaseId: permit.producerReleaseId,
      }),
      this.decisions.authority.resolve(scope),
      this.decisions.lifecycle.resolve(scope),
      this.decisions.safety.resolve({
        scope,
        capability: ReviewPublicationCapability.BeginOperation,
      }),
      this.contextReusePolicy.isCurrent(permit),
    ]);
    if (
      liveRevision === null ||
      currentPermit.status !== CurrentPublicationPermitStatus.Current ||
      runControl.status !== ReviewPublicationRunControlStatus.Allowed ||
      authority.status !== CurrentMutationAuthorityStatus.Active ||
      lifecycle.status !== CurrentPublicationLifecycleStatus.Current ||
      safety.status !== CurrentReviewSafetyDecisionStatus.Allowed ||
      !contextReuseCurrent ||
      authority.mutationEpoch === null ||
      safety.decisionHash === null ||
      lifecycle.lifecycleStateHash === null ||
      lifecycle.commandLedgerWatermark === null
    ) {
      return {
        status: ReviewV2PublicationFreshnessReadStatus.Missing,
        safeReason: "publication_live_tuple_not_current",
      } as const;
    }
    return {
      status: ReviewV2PublicationFreshnessReadStatus.Available,
      snapshot: {
        baseSha: liveRevision.baseSha,
        mergeBaseSha: liveRevision.mergeBaseSha,
        reviewedHeadSha: liveRevision.headSha,
        reviewRevisionHash: liveRevision.reviewRevisionHash,
        lifecycleStateHash: lifecycle.lifecycleStateHash,
        commandLedgerWatermark: lifecycle.commandLedgerWatermark,
        authorizationId: currentPermit.permit.authorizationId,
        producerReleaseId: currentPermit.permit.producerReleaseId,
        permitEpoch: authority.mutationEpoch,
        publicationSafetyDecisionHash: safety.decisionHash,
        publicationNotAfter: currentPermit.permit.publicationNotAfter,
      },
    } as const;
  }
}

const conservativeCompensationPolicy: ReviewV2PublicationCompensationPolicyPort =
  {
    async decide(input) {
      return input.operation.effectStrategy ===
        ReviewPublicationEffectStrategy.MutableSingleton
        ? ReviewV2PublicationCompensationDecision.Allowed
        : ReviewV2PublicationCompensationDecision.ManualOnly;
    },
  };

class PrismaReviewV2ArtifactQuery implements ReviewV2FinalizedArtifactQueryPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly executions: ReviewExecutionQueryPort,
    private readonly releases: PrismaProducerReleaseRepository,
  ) {}

  async findArtifact(executionId: string) {
    const snapshot = await this.executions.findExecution(executionId);
    if (!snapshot?.artifact) return null;
    const release = await this.releases.findProducerReleaseById(
      snapshot.artifact.publicationPermit.producerReleaseId,
    );
    if (
      !release ||
      release.protocolLimitsProfileId !==
        snapshot.execution.protocolLimitsProfileId
    ) {
      return null;
    }
    const limits = await this.prisma.reviewProtocolLimitsV2.findUnique({
      where: {
        protocolLimitsProfileId: release.protocolLimitsProfileId,
      },
      select: { limitsDigest: true },
    });
    return limits
      ? {
          artifact: snapshot.artifact,
          protocolLimitsProfileId: release.protocolLimitsProfileId,
          limitsDigest: limits.limitsDigest,
        }
      : null;
  }
}

class RunControlPublicationLimitsQuery implements ReviewPublicationReleaseLimitsQueryPort {
  constructor(private readonly releases: PrismaProducerReleaseRepository) {}

  async findReleaseBoundLimits(identity: {
    readonly producerReleaseId: string;
    readonly protocolLimitsProfileId: string;
    readonly limitsDigest: string;
  }) {
    const [release, limits] = await Promise.all([
      this.releases.findProducerReleaseById(identity.producerReleaseId),
      this.releases.findProtocolLimitsProfileById(
        identity.protocolLimitsProfileId,
      ),
    ]);
    if (
      !release ||
      !limits ||
      release.state !== ProducerReleaseState.Registered ||
      release.protocolLimitsProfileId !== identity.protocolLimitsProfileId ||
      limits.limitsDigest !== identity.limitsDigest
    ) {
      return null;
    }
    return {
      producerReleaseId: identity.producerReleaseId,
      protocolLimitsProfileId: limits.protocolLimitsProfileId,
      limitsDigest: limits.limitsDigest,
      maxPublicationOperations: limits.maxPublicationOperations,
      maxPublicationChunks: limits.maxPublicationChunks,
      maxPublicationBodyBytes: limits.maxPublicationBodyBytes,
      maxReconciliationDurationMs: limits.maxReconciliationDurationMs,
    };
  }
}

class PrismaFinalizedArtifactIdentityQuery implements FinalizedArtifactIdentityQueryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findIdentity(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
  }) {
    const artifact =
      await this.prisma.finalizedReviewProjectionArtifactV2.findFirst({
        where: {
          executionId: input.executionId,
          artifactId: input.finalizedArtifactId,
        },
        select: { artifactId: true, executionId: true, artifactHash: true },
      });
    return artifact
      ? {
          executionId: artifact.executionId,
          finalizedArtifactId: artifact.artifactId,
          artifactHash: artifact.artifactHash,
        }
      : null;
  }
}

class PrismaReviewSnapshotEligibility implements ReviewSnapshotCommitEligibilityPort {
  constructor(
    private readonly executions: ReviewExecutionQueryPort,
    private readonly attempts: ReviewPublicationAttemptQueryPort,
    private readonly artifactIdentities: FinalizedArtifactIdentityQueryPort,
  ) {}

  async resolve(input: {
    readonly sourceExecutionId: string;
    readonly sourceArtifactHash: string;
  }) {
    const snapshot = await this.executions.findExecution(
      input.sourceExecutionId,
    );
    if (!snapshot?.artifact) return null;
    const identity = await this.artifactIdentities.findIdentity({
      executionId: input.sourceExecutionId,
      finalizedArtifactId: snapshot.artifact.artifactId,
    });
    if (identity?.artifactHash !== input.sourceArtifactHash) return null;
    const publication = await this.attempts.findByPermitIdentity(
      snapshot.artifact.publicationPermit,
    );
    if (!publication) return null;
    const outcome = effectiveReviewPublicationOutcome(publication);
    return {
      sourceExecutionId: input.sourceExecutionId,
      sourceArtifactHash: input.sourceArtifactHash,
      sourceReviewRevisionHash: snapshot.artifact.reviewRevisionHash,
      sourceBaseSha: snapshot.execution.revision.baseSha,
      sourceReviewedHeadSha: snapshot.execution.revision.headSha,
      sourceCompatibilityKey: snapshot.execution.compatibilityKey,
      sourceRunId: snapshot.execution.sourceRunId,
      sourceRunAttempt: snapshot.execution.sourceRunAttempt,
      coverageState:
        snapshot.artifact.coverageState === ReviewCoverageState.Completed
          ? SnapshotSourceCoverageState.Completed
          : SnapshotSourceCoverageState.Partial,
      effectivePublicationOutcome: mapSnapshotPublicationOutcome(outcome),
      publicationReceiptSetHash: reviewPublicationReceiptSetHash(publication),
    };
  }
}

class PrismaReviewV2GitHubRepositoryQuery
  implements
    ReviewV2GitHubRepositoryQueryPort,
    GitHubReviewLifecycleRepositoryQueryPort
{
  constructor(private readonly prisma: PrismaClient) {}

  async resolve(permit: ReviewPublicationScope) {
    const repository = await this.prisma.repositoryConnection.findFirst({
      where: {
        id: permit.repositoryConnectionId,
        workspaceId: permit.workspaceId,
        scmRepositoryIdentityId: permit.scmRepositoryIdentityId,
        provider: "github",
        selected: true,
        archived: false,
      },
      include: { installation: true },
    });
    if (
      !repository?.installation ||
      repository.installation.status !== "active"
    ) {
      return null;
    }
    return {
      githubInstallationId:
        repository.installation.githubInstallationId.toString(),
      owner: repository.owner,
      repo: repository.name,
    };
  }
}

type PublicationWork = {
  readonly executionId: string;
  readonly publicationAttemptId: string;
  readonly publicationOperationId: string;
  readonly provider: ReviewV2ScmProvider;
  readonly retryCount: number;
};

interface ReviewV2PublicationWorkFeed {
  scan(input: {
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly PublicationWork[]>;
  defer(input: {
    readonly work: PublicationWork;
    readonly nextEligibleAt: Date;
    readonly lastErrorCode: string;
  }): Promise<void>;
}

class PrismaReviewV2PublicationWorkFeed implements ReviewV2PublicationWorkFeed {
  constructor(private readonly prisma: PrismaClient) {}

  async scan(input: { readonly now: Date; readonly limit: number }) {
    const operations = await this.prisma.reviewPublicationOperationV2.findMany({
      where: {
        state: {
          in: ["planned", "in_flight", "effect_observed", "reconciling"],
        },
        nextEligibleAt: { lte: input.now },
      },
      orderBy: [
        { nextEligibleAt: "asc" },
        { reconcileUntil: "asc" },
        { publicationOperationId: "asc" },
      ],
      take: Math.min(input.limit * 4, 1_000),
      select: {
        publicationAttemptId: true,
        publicationOperationId: true,
        retryCount: true,
      },
    });
    if (operations.length === 0) return [];
    const attemptIds = [
      ...new Set(operations.map((row) => row.publicationAttemptId)),
    ];
    const attempts = await this.prisma.reviewPublicationAttemptV2.findMany({
      where: {
        publicationAttemptId: { in: attemptIds },
        state: { in: ["pending", "publishing", "reconciling"] },
        retainUntil: { gt: input.now },
      },
      select: {
        publicationAttemptId: true,
        repositoryConnectionId: true,
        executionId: true,
      },
    });
    const repositoryIds = [
      ...new Set(attempts.map((row) => row.repositoryConnectionId)),
    ];
    const repositories = await this.prisma.repositoryConnection.findMany({
      where: { id: { in: repositoryIds } },
      select: { id: true, provider: true },
    });
    const attemptById = new Map(
      attempts.map((row) => [row.publicationAttemptId, row]),
    );
    const providerByRepository = new Map(
      repositories.map((row) => [row.id, row.provider]),
    );
    return operations
      .flatMap((operation) => {
        const attempt = attemptById.get(operation.publicationAttemptId);
        if (!attempt) return [];
        const provider = providerByRepository.get(
          attempt.repositoryConnectionId,
        );
        const mapped = mapProvider(provider);
        return mapped
          ? [
              {
                ...operation,
                executionId: attempt.executionId,
                provider: mapped,
              },
            ]
          : [];
      })
      .slice(0, input.limit);
  }

  async defer(input: {
    readonly work: PublicationWork;
    readonly nextEligibleAt: Date;
    readonly lastErrorCode: string;
  }): Promise<void> {
    const updated = await this.prisma.reviewPublicationOperationV2.updateMany({
      where: {
        publicationOperationId: input.work.publicationOperationId,
        publicationAttemptId: input.work.publicationAttemptId,
        retryCount: input.work.retryCount,
        state: {
          in: ["planned", "in_flight", "effect_observed", "reconciling"],
        },
      },
      data: {
        retryCount: { increment: 1 },
        nextEligibleAt: input.nextEligibleAt,
        lastErrorCode: input.lastErrorCode,
      },
    });
    if (updated.count > 1) {
      throw new Error("review_v2_publication_retry_cas_invalid");
    }
  }
}

class ReviewV2PublicationMaintenance implements ReviewV2PublicationMaintenanceRuntime {
  constructor(
    private readonly feed: ReviewV2PublicationWorkFeed,
    private readonly executor: ExecuteReviewV2PublicationOperation,
    private readonly clock: SystemClock,
    private readonly ownerIdHash: string,
    private readonly policy: {
      readonly limit: number;
      readonly minimumRetryMs: number;
    },
  ) {}

  async runMaintenance() {
    const now = this.clock.now();
    const work = await this.feed.scan({ now, limit: this.policy.limit });
    let processed = 0;
    let manualRequired = 0;
    let terminalUnknown = 0;
    const settledExecutionIds = new Set<string>();
    for (const item of work) {
      const result = await this.executor.execute({
        publicationAttemptId: item.publicationAttemptId,
        publicationOperationId: item.publicationOperationId,
        provider: item.provider,
        ownerIdHash: this.ownerIdHash,
      });
      processed += 1;
      if (result.status === ReviewV2PublicationExecutionStatus.ManualRequired) {
        manualRequired += 1;
      }
      if (
        result.status === ReviewV2PublicationExecutionStatus.TerminalUnknown
      ) {
        terminalUnknown += 1;
      }
      if (
        result.status === ReviewV2PublicationExecutionStatus.Completed ||
        result.status === ReviewV2PublicationExecutionStatus.AlreadyCompleted ||
        result.status === ReviewV2PublicationExecutionStatus.TerminalUnknown ||
        result.status === ReviewV2PublicationExecutionStatus.Terminalized
      ) {
        settledExecutionIds.add(item.executionId);
        continue;
      }
      const retryDelayMs = Math.max(
        this.policy.minimumRetryMs,
        boundedRetryDelay(item.retryCount + 1),
      );
      await this.feed.defer({
        work: item,
        nextEligibleAt: new Date(now.getTime() + retryDelayMs),
        lastErrorCode: result.safeReason,
      });
    }
    return {
      processed,
      manualRequired,
      terminalUnknown,
      settledExecutionIds: [...settledExecutionIds].sort(),
    };
  }
}

function mapSnapshotPublicationOutcome(
  outcome: ReviewPublicationTerminalOutcome | null,
): SnapshotEffectivePublicationOutcome {
  switch (outcome) {
    case ReviewPublicationTerminalOutcome.Succeeded:
      return SnapshotEffectivePublicationOutcome.Succeeded;
    case ReviewPublicationTerminalOutcome.SupersededNoEffect:
      return SnapshotEffectivePublicationOutcome.SupersededNoEffect;
    case ReviewPublicationTerminalOutcome.FailedNoEffect:
      return SnapshotEffectivePublicationOutcome.FailedNoEffect;
    case ReviewPublicationTerminalOutcome.StaleCompensated:
      return SnapshotEffectivePublicationOutcome.StaleCompensated;
    case ReviewPublicationTerminalOutcome.StaleVisible:
      return SnapshotEffectivePublicationOutcome.StaleVisible;
    case ReviewPublicationTerminalOutcome.TerminalUnknown:
    case null:
      return SnapshotEffectivePublicationOutcome.TerminalUnknown;
  }
}

function mapProvider(provider: string | undefined): ReviewV2ScmProvider | null {
  switch (provider) {
    case "github":
      return ReviewV2ScmProvider.GitHub;
    case "gitlab":
      return ReviewV2ScmProvider.GitLab;
    default:
      return null;
  }
}

function boundedRetryDelay(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 8));
  return Math.min(5_000 * 2 ** exponent, 5 * 60_000);
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  code: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}

function requiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`review_v2_worker_config_missing:${name}`);
  return value;
}

function readCapabilityKeyRing(
  env: Readonly<Record<string, string | undefined>>,
): ConfiguredCapabilityKeyRing {
  const activeKeyId = requiredEnv(env, reviewV2CapabilityActiveKeyIdEnv);
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredEnv(env, reviewV2CapabilityKeysEnv));
  } catch {
    throw new Error("review_v2_capability_keys_invalid");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 10) {
    throw new Error("review_v2_capability_keys_invalid");
  }
  return new ConfiguredCapabilityKeyRing({
    activeKeyId,
    keys: parsed.map(parseCapabilityKey),
  });
}

function parseCapabilityKey(
  value: unknown,
): ConfiguredCapabilityVerificationKey {
  if (!isExactRecord(value, ["keyId", "secretBase64", "verifyUntil"])) {
    throw new Error("review_v2_capability_key_invalid");
  }
  if (
    typeof value.keyId !== "string" ||
    typeof value.secretBase64 !== "string" ||
    (value.verifyUntil !== null && typeof value.verifyUntil !== "string")
  ) {
    throw new Error("review_v2_capability_key_invalid");
  }
  const secret = Buffer.from(value.secretBase64, "base64");
  if (
    secret.byteLength < 32 ||
    secret.toString("base64") !== value.secretBase64
  ) {
    throw new Error("review_v2_capability_key_invalid");
  }
  const verifyUntil =
    value.verifyUntil === null ? null : new Date(value.verifyUntil);
  if (
    verifyUntil !== null &&
    (!Number.isFinite(verifyUntil.getTime()) ||
      verifyUntil.toISOString() !== value.verifyUntil)
  ) {
    throw new Error("review_v2_capability_key_invalid");
  }
  return {
    keyId: value.keyId,
    secret: new Uint8Array(secret),
    verifyUntil,
  };
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function evidenceProviderKind(value: string): EvidenceProviderKind {
  switch (value) {
    case EvidenceProviderKind.Codex:
      return EvidenceProviderKind.Codex;
    case EvidenceProviderKind.ClaudeCode:
      return EvidenceProviderKind.ClaudeCode;
    case EvidenceProviderKind.OpenRouter:
      return EvidenceProviderKind.OpenRouter;
    default:
      throw new Error("context_reuse_provider_kind_invalid");
  }
}

function evidenceTaskKind(value: string): EvidenceTaskKind {
  switch (value) {
    case EvidenceTaskKind.FindingDiscovery:
      return EvidenceTaskKind.FindingDiscovery;
    case EvidenceTaskKind.LifecycleRevalidation:
      return EvidenceTaskKind.LifecycleRevalidation;
    default:
      throw new Error("context_reuse_task_kind_invalid");
  }
}

function evidenceExecutionProfile(value: string): ProviderExecutionProfile {
  switch (value) {
    case ProviderExecutionProfile.PromptOnlyEnvelopeV1:
      return ProviderExecutionProfile.PromptOnlyEnvelopeV1;
    case ProviderExecutionProfile.AgenticUnboundedV1:
      return ProviderExecutionProfile.AgenticUnboundedV1;
    case ProviderExecutionProfile.ContextGatewayV1:
      return ProviderExecutionProfile.ContextGatewayV1;
    default:
      throw new Error("context_reuse_execution_profile_invalid");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
