import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { App } from "@octokit/app";
import {
  JoseGitHubActionsOidcTokenVerifier,
  PrismaActionControlPlaneRepository,
} from "@reviewrouter/features-action-control-plane";
import type {
  RegisterReviewContextAttestationV2RoutesDependencies,
  RegisterReviewEvidenceV2RoutesDependencies,
  RegisterReviewExecutionV2RoutesDependencies,
  RegisterReviewPublicationRequestV2RoutesDependencies,
  RegisterReviewRunControlV2RoutesDependencies,
  RegisterReviewSnapshotReadV2RoutesDependencies,
} from "@reviewrouter/features-action-control-plane/v2";
import { ReviewActionV2RouteFailure } from "@reviewrouter/features-action-control-plane/v2";
import {
  ActualModelCompatibilityMode,
  ReviewProviderKind as EvidenceProviderKind,
  ReviewExecutionAttemptReportState,
  ReviewReuseEffectMode,
  ReviewTaskKind as EvidenceTaskKind,
  ReviewTrustDomain as EvidenceTrustDomain,
  buildProviderInvocationIdentity,
  normalizeProviderInvocationManifest,
  serializeProviderInvocationManifestCanonicalWireJson,
  type CurrentEvidenceWriteSafetyDecisionPort,
  type CurrentReviewReusePolicyPort,
  type ReviewExecutionAttemptFactsPort,
} from "@reviewrouter/features-review-evidence";
import { VerifyAcceptedContextAttestation } from "@reviewrouter/features-review-context-attestation";
import { PrismaContextAttestationStore } from "@reviewrouter/features-review-context-attestation/composition";
import {
  PrismaReviewObservationStore,
  createReviewEvidenceUseCases,
} from "@reviewrouter/features-review-evidence/composition";
import {
  CurrentReviewRevisionStatus,
  ReviewExecutionState,
  ReviewExecutionProviderKind,
  ReviewInvocationLeasePurpose,
  ReviewTaskKind as ExecutionTaskKind,
  reviewExecutionAbsoluteMaxAttemptBudget,
  reviewExecutionAbsoluteMaxFindingCount,
  reviewExecutionAbsoluteMaxProjectionBytes,
  reviewExecutionAbsoluteMaxWorkSlots,
  type CurrentReviewRevisionPort,
  type ReviewExecution,
  type ReviewExecutionAuthorizationFactsPort,
  type ReviewExecutionLimits,
  type ReviewExecutionScope,
} from "@reviewrouter/features-review-executions";
import {
  PrismaReviewExecutionStore,
  PrismaReviewRequestedIntentStore,
  createReviewExecutionsUseCases,
} from "@reviewrouter/features-review-executions/composition";
import {
  GitHubReviewPublicationLifecycleAdapter,
  OctokitGitHubInstallationGraphqlClientFactory,
} from "@reviewrouter/features-review-publishing/v2/composition";
import {
  CanonicalReviewRevisionResolutionStatus,
  ProducerReleaseState,
  ReviewProviderKind,
  ReviewRunAuthorizationState as RunAuthorizationState,
  ReviewSafetyDecisionKind,
  ResolveReviewSafetyPolicy,
  ReviewTaskKind,
  canonicalJson,
  type CanonicalReviewRevisionResolverPort,
  type ReviewProtocolLimits,
  type ReviewProtocolLimitsProfileQueryPort,
  type ProducerReleaseQueryPort,
  type ReviewRunAuthorization,
  type ReviewRunAuthorizationQueryPort,
  type ReviewSafetyDecisionResolverPort,
  type ScmRepositoryIdentityQueryPort,
} from "@reviewrouter/features-review-run-control";
import {
  composeProductionReviewRunAuthorizationPrerequisites,
  composeReviewRunControl,
  createPrismaReviewRunControlRepositories,
} from "@reviewrouter/features-review-run-control/composition";
import {
  readGitHubAppPrivateKey,
  resolveReviewRouterPublicApiUrl,
} from "@reviewrouter/platform-config";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  ConfiguredCapabilityKeyRing,
  JoseRotatingCapabilityCodec,
  type ConfiguredCapabilityVerificationKey,
} from "@reviewrouter/platform-signed-capabilities";
import { ReviewActionV2ProtocolErrorCode } from "@reviewrouter/protocol-review-action-v2";
import { SystemClock } from "@reviewrouter/shared";
import { ReviewActionV2ExecutionEvidenceCapabilityAdapter } from "./review-action-v2-execution-evidence-capabilities.js";
import { reviewActionV2ProjectionPolicyVersion } from "./review-action-v2-projection-policy.js";
import { ReviewContextAttestationEvidenceAdapter } from "./review-context-attestation-evidence-adapter.js";
import {
  composeReviewActionV2ContextAttestationRoutes,
  createReviewActionV2ContextReplayCoordinator,
  readReviewActionV2ContextCrypto,
} from "./review-action-v2-context-attestation-composition.js";
import {
  composeReviewActionV2EvidenceRoutes,
  composeReviewActionV2ExecutionRoutes,
  type ReviewActionV2ExecutionTimingPolicy,
  type ReviewActionV2FinalizationFactsPort,
  type ReviewActionV2LeaseSafetyPort,
} from "./review-action-v2-execution-evidence-composition.js";
import {
  composeReviewActionV2RunControlRoutes,
  createServerOwnedReviewActionV2AdmissionFacts,
  type ReviewActionV2RevisionHashPort,
} from "./review-action-v2-run-control-composition.js";
import { composeReviewActionV2SnapshotPublicationRoutes } from "./review-action-v2-production-composition-snapshot-publication.js";
import { OctokitCodexRotatingGitHubSecretGateway } from "./github/octokit-codex-rotating-github-secret-gateway.js";
import { ProductionReviewMutationAuthorityProofFacts } from "./review-action-v2-mutation-proof-facts.js";
import { OctokitReviewV2DispatchCapabilityInspector } from "./github/octokit-review-v2-dispatch-capability-inspector.js";

export const reviewActionV2CapabilityActiveKeyIdEnv =
  "REVIEW_ROUTER_REVIEW_V2_CAPABILITY_ACTIVE_KEY_ID";
export const reviewActionV2CapabilityKeysEnv =
  "REVIEW_ROUTER_REVIEW_V2_CAPABILITY_KEYS_JSON";
export const reviewActionV2ProviderVoteLanesEnv =
  "REVIEW_ROUTER_REVIEW_V2_PROVIDER_VOTE_LANES_JSON";
export const reviewActionV2ProjectionPolicyVersionEnv =
  "REVIEW_ROUTER_REVIEW_V2_PROJECTION_POLICY_VERSION";
export const reviewActionV2IntentAdmissionRequiredEnv =
  "REVIEW_ROUTER_REVIEW_V2_INTENT_ADMISSION_REQUIRED";
export const reviewActionV2IntentIngressEnabledEnv =
  "REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED";
export const reviewActionV2WorkflowDispatchReadyEnv =
  "REVIEW_ROUTER_REVIEW_V2_WORKFLOW_DISPATCH_READY";

type ReviewActionV2RouteRuntime = Pick<
  RegisterReviewRunControlV2RoutesDependencies,
  "readServerTime" | "createRequestId"
>;

export type ReviewActionV2ProductionRoutes = Readonly<{
  runControl: RegisterReviewRunControlV2RoutesDependencies;
  execution: RegisterReviewExecutionV2RoutesDependencies;
  contextAttestation: RegisterReviewContextAttestationV2RoutesDependencies;
  evidence: RegisterReviewEvidenceV2RoutesDependencies;
  snapshot: RegisterReviewSnapshotReadV2RoutesDependencies;
  publication: RegisterReviewPublicationRequestV2RoutesDependencies;
}>;

export function composeReviewActionV2ProductionRunControl(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly prisma: PrismaClient;
  readonly oidcAudience?: string | undefined;
}) {
  const githubAppId = requiredEnv(input.env, "GITHUB_APP_ID");
  const githubAppPrivateKey = readGitHubAppPrivateKey(input.env);
  if (!githubAppPrivateKey) {
    throw new Error("review_action_v2_github_app_private_key_missing");
  }
  const oidcAudience =
    input.oidcAudience ??
    requiredEnv(input.env, "REVIEW_ROUTER_ACTION_OIDC_AUDIENCE");
  const providerVoteLanes = readProviderVoteLanes(input.env);
  const configuredProjectionPolicyVersion = requiredEnv(
    input.env,
    reviewActionV2ProjectionPolicyVersionEnv,
  );
  if (
    configuredProjectionPolicyVersion !== reviewActionV2ProjectionPolicyVersion
  ) {
    throw new Error("review_action_v2_projection_policy_version_unsupported");
  }
  const projectionPolicyVersion = reviewActionV2ProjectionPolicyVersion;
  const clock = new SystemClock();
  const digest = new ProductionReviewActionV2Digest();
  const repositories = createPrismaReviewRunControlRepositories(input.prisma);
  const actionRepositories = new PrismaActionControlPlaneRepository(
    input.prisma,
  );
  const prerequisites = composeProductionReviewRunAuthorizationPrerequisites({
    githubAppId,
    githubAppPrivateKey,
    env: input.env,
    releases: repositories.producerReleases,
    digest,
  });
  const mutationSafetyResolver = new ResolveReviewSafetyPolicy({
    clock,
    digest,
    policyQueries: repositories.safetyControls,
    emergencyQueries: repositories.safetyControls,
  });
  const workflowInventory = new OctokitCodexRotatingGitHubSecretGateway({
    appId: githubAppId,
    privateKey: githubAppPrivateKey,
    expectedApiUrl: resolveReviewRouterPublicApiUrl(input.env),
  });
  const dispatchCapability = new OctokitReviewV2DispatchCapabilityInspector({
    appId: githubAppId,
    privateKey: githubAppPrivateKey,
  });
  const mutationAuthorityProofFacts =
    new ProductionReviewMutationAuthorityProofFacts({
      prisma: input.prisma,
      identities: repositories.repositoryIdentities,
      authorities: repositories.mutationAuthorities,
      actionRepositories,
      safety: mutationSafetyResolver,
      workflowInventory,
      dispatchCapability,
      completionWorkerConfigured:
        input.env.REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED === "1",
      now: () => clock.now(),
    });
  const runControl = composeReviewRunControl({
    clock,
    identifiers: { nextId: (prefix) => `${prefix}-${randomUUID()}` },
    digest,
    tokens: prerequisites.tokens,
    protocolLimitsQueries: repositories.producerReleases,
    protocolLimitsCommands: repositories.producerReleases,
    operationalSloQueries: repositories.producerReleases,
    operationalSloCommands: repositories.producerReleases,
    releaseQueries: repositories.producerReleases,
    releaseCommands: repositories.producerReleases,
    identityQueries: repositories.repositoryIdentities,
    identityCommands: repositories.repositoryIdentities,
    authorityQueries: repositories.mutationAuthorities,
    authorityCommands: repositories.mutationAuthorities,
    mutationAuthorityProofFacts,
    policyQueries: repositories.safetyControls,
    policyCommands: repositories.safetyControls,
    emergencyQueries: repositories.safetyControls,
    emergencyCommands: repositories.safetyControls,
    safetyInspections: repositories.safetyControls,
    authorizationQueries: repositories.authorizations,
    authorizationCommands: repositories.authorizations,
    absoluteProtocolMaxima,
  });
  return Object.freeze({
    clock,
    digest,
    repositories,
    actionRepositories,
    prerequisites,
    runControl,
    oidcAudience,
    providerVoteLanes,
    projectionPolicyVersion,
    workflowInventory,
  });
}

export function composeReviewActionV2ProductionRoutes(input: {
  readonly enabled: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runtime: ReviewActionV2RouteRuntime;
  readonly prisma?: PrismaClient | undefined;
  readonly oidcAudience?: string | undefined;
}): ReviewActionV2ProductionRoutes {
  if (!input.enabled) {
    return Object.freeze({
      runControl: input.runtime,
      execution: input.runtime,
      contextAttestation: input.runtime,
      evidence: input.runtime,
      snapshot: input.runtime,
      publication: input.runtime,
    });
  }
  if (!input.prisma) {
    throw new Error("review_action_v2_prisma_unavailable");
  }
  const prisma = input.prisma;
  const githubAppId = requiredEnv(input.env, "GITHUB_APP_ID");
  const githubAppPrivateKey = readGitHubAppPrivateKey(input.env);
  if (!githubAppPrivateKey) {
    throw new Error("review_action_v2_github_app_private_key_missing");
  }
  assertReviewIntentRolloutConfiguration(input.env);

  const {
    clock,
    digest,
    repositories,
    actionRepositories,
    prerequisites,
    runControl,
    oidcAudience,
    providerVoteLanes,
    projectionPolicyVersion,
  } = composeReviewActionV2ProductionRunControl({
    env: input.env,
    prisma: input.prisma,
    ...(input.oidcAudience === undefined
      ? {}
      : { oidcAudience: input.oidcAudience }),
  });

  const requestedIntentStore = new PrismaReviewRequestedIntentStore(
    input.prisma,
  );
  const admissionFacts = createServerOwnedReviewActionV2AdmissionFacts({
    revisionResolver: prerequisites.revisionResolver,
    releaseAttestations: prerequisites.releaseAttestations,
    providerVoteLanes,
    requestedIntents: requestedIntentStore,
    requestedIntentRequired:
      input.env[reviewActionV2IntentAdmissionRequiredEnv] === "1",
  });
  const revisionHashes: ReviewActionV2RevisionHashPort = {
    digest: (revision) => digest.digestUtf8(canonicalJson(revision)),
  };
  const runControlHandlers = {
    oidcVerifier: new JoseGitHubActionsOidcTokenVerifier(),
    oidcAudience,
    actionRepositories,
    repositoryIdentities: repositories.repositoryIdentities,
    producerReleases: repositories.producerReleases,
    admissionFacts,
    revisionHashes,
    authorizations: runControl.authorizations,
    digest,
    absoluteProtocolMaxima,
    authorizationTtlMs: productionTiming.authorizationTtlMs,
    maxAuthorizationLifetimeMs: productionTiming.maxAuthorizationLifetimeMs,
  } as const;

  const executionStore = new PrismaReviewExecutionStore(input.prisma);
  const currentRevision = new ProductionCurrentReviewRevisionAdapter({
    prisma: input.prisma,
    identities: repositories.repositoryIdentities,
    actionRepositories,
    revisionResolver: prerequisites.revisionResolver,
  });
  const executionAuthorizations =
    new ProductionReviewExecutionAuthorizationFactsAdapter(
      repositories.authorizations,
      repositories.producerReleases,
      clock,
    );
  const executions = createReviewExecutionsUseCases({
    authorizationFacts: executionAuthorizations,
    currentRevision,
    executionQueries: executionStore,
    executionCommands: executionStore,
    invocationFlightQueries: executionStore,
    requestedIntentQueries: requestedIntentStore,
    requestedIntentCommands: requestedIntentStore,
    digest,
    clock,
    requestedIntentAdmissionRequired:
      input.env[reviewActionV2IntentAdmissionRequiredEnv] === "1",
  });

  const observationStore = new PrismaReviewObservationStore(input.prisma);
  const contextAttestationStore = new PrismaContextAttestationStore(
    input.prisma,
  );
  const contextAttestationVerifier = new VerifyAcceptedContextAttestation({
    store: contextAttestationStore,
    clock: { nowMs: () => clock.now().getTime() },
  });
  const safety = new ProductionReviewActionV2SafetyAdapter(
    runControl.safetyResolver,
  );
  const reusePolicy = new ProductionReviewReusePolicyAdapter({
    safety: runControl.safetyResolver,
    releases: repositories.producerReleases,
    digest,
  });
  const evidence = createReviewEvidenceUseCases({
    attempts: new ProductionReviewExecutionAttemptFactsAdapter({
      executions: executionStore,
      authorizations: repositories.authorizations,
      releases: repositories.producerReleases,
      digest,
      clock,
    }),
    writeSafety: safety,
    reusePolicy,
    observationCommands: observationStore,
    observationQueries: observationStore,
    pruner: observationStore,
    identities: { nextObservationId: () => `observation-${randomUUID()}` },
    contextAttestations: new ReviewContextAttestationEvidenceAdapter(
      contextAttestationVerifier,
    ),
    digest,
    clock: { nowMs: () => clock.now().getTime() },
    reuseTtlMs: productionTiming.evidenceReuseTtlMs,
    retainTtlMs: productionTiming.retentionDurationMs,
  });

  const capabilityKeyRing = readCapabilityKeyRing(input.env);
  const capabilities = new ReviewActionV2ExecutionEvidenceCapabilityAdapter(
    new JoseRotatingCapabilityCodec(capabilityKeyRing),
    capabilityKeyRing,
    "reviewrouter-review-action-v2",
    randomUUID,
  );
  const contextCrypto = readReviewActionV2ContextCrypto(input.env);
  const contextAttestationHandlers = {
    authorizations: runControl.authorizations,
    executionQueries: executionStore,
    observations: observationStore,
    reusePolicy,
    store: contextAttestationStore,
    cipher: contextCrypto.cipher,
    capabilities,
    digest,
    checkoutTrees: new ProductionReviewActionV2CheckoutTreeResolver({
      prisma,
      githubAppId,
      githubAppPrivateKey,
    }),
    producerReleases: {
      async resolve({ producerReleaseId }: { producerReleaseId: string }) {
        const release =
          await repositories.producerReleases.findProducerReleaseById(
            producerReleaseId,
          );
        return release?.state === ProducerReleaseState.Registered
          ? {
              capabilityProfile: release.capabilityProfile,
              runtimeCommitSha: release.runtimeCommitSha,
              contextGatewayPolicyVersion: release.contextGatewayPolicyVersion,
              contextGatewayEntrypointDigest:
                release.contextGatewayEntrypointDigest,
            }
          : null;
      },
    },
    now: () => clock.now(),
    nextId: (kind: "gateway_session" | "attestation" | "replay_proof") =>
      `${kind}-${randomUUID()}`,
    sessionSecretKey: contextCrypto.sessionSecretKey,
    config: {
      sessionLifetimeMs: 20 * 60 * 1_000,
      reuseTtlMs: productionTiming.evidenceReuseTtlMs,
      replayProofLifetimeMs: 10 * 60 * 1_000,
      replayCapabilityLifetimeMs: 10 * 60 * 1_000,
      attachmentCapabilityLifetimeMs:
        executionTiming.attachmentCapabilityDurationMs,
    },
  } as const;
  const contextReplay = createReviewActionV2ContextReplayCoordinator(
    contextAttestationHandlers,
  );
  const contextAttestation = composeReviewActionV2ContextAttestationRoutes({
    enabled: true,
    runtime: input.runtime,
    handlers: contextAttestationHandlers,
  });
  const common = {
    authorizations: runControl.authorizations,
    executionQueries: executionStore,
    protocolLimits: repositories.producerReleases,
    digest,
    capabilities,
    now: () => clock.now(),
    nextId: (kind: "lease" | "attempt" | "observation_ref") =>
      `${kind}-${randomUUID()}`,
    timing: executionTiming,
  } as const;
  const snapshotPublication = composeReviewActionV2SnapshotPublicationRoutes({
    runtime: input.runtime,
    prisma: input.prisma,
    authorizations: runControl.authorizations,
    authorizationQueries: repositories.authorizations,
    releases: repositories.producerReleases,
    authorities: repositories.mutationAuthorities,
    safety: runControl.safetyResolver,
    executions: executionStore,
    capabilities,
    digest,
    liveLifecycle: new GitHubReviewPublicationLifecycleAdapter(
      {
        async resolve(scope) {
          const repository = await prisma.repositoryConnection.findFirst({
            where: {
              id: scope.repositoryConnectionId,
              workspaceId: scope.workspaceId,
              scmRepositoryIdentityId: scope.scmRepositoryIdentityId,
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
        },
      },
      new OctokitGitHubInstallationGraphqlClientFactory({
        appId: githubAppId,
        privateKey: githubAppPrivateKey,
      }),
    ),
    contextPolicy: contextReplay,
    now: () => clock.now(),
  });

  return Object.freeze({
    runControl: composeReviewActionV2RunControlRoutes({
      enabled: true,
      runtime: input.runtime,
      handlers: runControlHandlers,
    }),
    execution: composeReviewActionV2ExecutionRoutes({
      enabled: true,
      runtime: input.runtime,
      handlers: {
        ...common,
        executions,
        evidence,
        observations: observationStore,
        leaseSafety: safety,
        contextReplay,
        finalizationFacts: new ProductionFinalizationFactsAdapter({
          projectionPolicyVersion,
          safety: runControl.safetyResolver,
          releases: repositories.producerReleases,
          digest,
        }),
      },
    }),
    contextAttestation,
    evidence: composeReviewActionV2EvidenceRoutes({
      enabled: true,
      runtime: input.runtime,
      handlers: {
        ...common,
        evidence,
        observations: observationStore,
        contextReplay,
      },
    }),
    snapshot: snapshotPublication.snapshot,
    publication: snapshotPublication.publication,
  });
}

export function assertReviewIntentRolloutConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): void {
  const ingressEnabled = env[reviewActionV2IntentIngressEnabledEnv] === "1";
  const admissionRequired =
    env[reviewActionV2IntentAdmissionRequiredEnv] === "1";
  const dispatchReady = env[reviewActionV2WorkflowDispatchReadyEnv] === "1";
  const workerEnabled = env.REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED === "1";
  const outboxTakeoverEnabled =
    env.REVIEW_ROUTER_OUTBOX_FENCED_TAKEOVER_ENABLED === "1";
  if (
    ingressEnabled &&
    (!dispatchReady || !workerEnabled || !outboxTakeoverEnabled)
  ) {
    throw new Error("review_action_v2_intent_ingress_dependencies_unavailable");
  }
  if (admissionRequired && !ingressEnabled) {
    throw new Error("review_action_v2_intent_admission_without_ingress");
  }
}

class ProductionReviewActionV2Digest {
  async digestUtf8(value: string): Promise<string> {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }

  async digest(value: Uint8Array): Promise<string> {
    return createHash("sha256").update(value).digest("hex");
  }
}

class ProductionReviewActionV2CheckoutTreeResolver {
  private readonly app: App;

  constructor(
    private readonly dependencies: Readonly<{
      prisma: PrismaClient;
      githubAppId: string;
      githubAppPrivateKey: string;
    }>,
  ) {
    this.app = new App({
      appId: dependencies.githubAppId,
      privateKey: dependencies.githubAppPrivateKey,
    });
  }

  async resolveCheckoutTreeOid(
    authorization: ReviewRunAuthorization,
  ): Promise<string | null> {
    const repository =
      await this.dependencies.prisma.repositoryConnection.findFirst({
        where: {
          id: authorization.repositoryConnectionId,
          workspaceId: authorization.workspaceId,
          scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
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
    const octokit = await this.app.getInstallationOctokit(
      Number(repository.installation.githubInstallationId),
    );
    try {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
        {
          owner: repository.owner,
          repo: repository.name,
          commit_sha: authorization.headSha,
        },
      );
      const data = response.data as {
        readonly sha?: unknown;
        readonly tree?: { readonly sha?: unknown };
      };
      return data.sha === authorization.headSha &&
        typeof data.tree?.sha === "string" &&
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(data.tree.sha)
        ? data.tree.sha
        : null;
    } catch {
      return null;
    }
  }
}

class ProductionReviewExecutionAuthorizationFactsAdapter implements ReviewExecutionAuthorizationFactsPort {
  constructor(
    private readonly authorizations: ReviewRunAuthorizationQueryPort,
    private readonly protocolLimits: ReviewProtocolLimitsProfileQueryPort,
    private readonly clock: SystemClock,
  ) {}

  async find(authorizationId: string) {
    const authorization =
      await this.authorizations.findReviewRunAuthorizationById(authorizationId);
    if (!authorization) return null;
    const limits = await this.protocolLimits.findProtocolLimitsProfileById(
      authorization.protocolLimitsProfileId,
    );
    if (!limits) return null;
    return {
      authorizationId: authorization.authorizationId,
      scope: authorizationScope(authorization),
      revision: authorizationRevision(authorization),
      producerReleaseId: authorization.producerReleaseId,
      mutationEpoch: authorization.mutationEpoch,
      admissionSafetyDecisionHash:
        authorization.authorizationSafetyDecisionHash,
      limits: executionLimits(limits),
      expiresAt: new Date(authorization.expiresAt),
      active:
        authorization.state === RunAuthorizationState.Active &&
        authorization.expiresAt > this.clock.now(),
    };
  }
}

class ProductionCurrentReviewRevisionAdapter implements CurrentReviewRevisionPort {
  constructor(
    private readonly dependencies: Readonly<{
      prisma: PrismaClient;
      identities: ScmRepositoryIdentityQueryPort;
      actionRepositories: PrismaActionControlPlaneRepository;
      revisionResolver: CanonicalReviewRevisionResolverPort;
    }>,
  ) {}

  async resolve(scope: ReviewExecutionScope) {
    const identity =
      await this.dependencies.identities.findScmRepositoryIdentityById(
        scope.scmRepositoryIdentityId,
      );
    if (
      !identity ||
      identity.currentWorkspaceId !== scope.workspaceId ||
      identity.currentRepositoryConnectionId !== scope.repositoryConnectionId
    ) {
      return { status: CurrentReviewRevisionStatus.Unavailable } as const;
    }
    const repository =
      await this.dependencies.actionRepositories.findSelectedRepositoryByGithubId(
        identity.externalRepositoryId,
      );
    if (
      !repository ||
      repository.repositoryId !== scope.repositoryConnectionId
    ) {
      return { status: CurrentReviewRevisionStatus.Unavailable } as const;
    }
    const source =
      await this.dependencies.prisma.reviewRunAuthorization.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          repositoryConnectionId: scope.repositoryConnectionId,
          scmRepositoryIdentityId: scope.scmRepositoryIdentityId,
          pullRequestNumber: scope.pullRequestNumber,
        },
        orderBy: [{ createdAt: "desc" }, { authorizationId: "asc" }],
        select: { sourceRunId: true },
      });
    if (!source) {
      return { status: CurrentReviewRevisionStatus.Unavailable } as const;
    }
    const repositoryName = splitRepositoryName(repository.fullName);
    const resolved = await this.dependencies.revisionResolver.resolve({
      workspaceId: scope.workspaceId,
      repositoryConnectionId: scope.repositoryConnectionId,
      scmRepositoryIdentityId: scope.scmRepositoryIdentityId,
      githubInstallationId: repository.githubInstallationId,
      owner: repositoryName.owner,
      repo: repositoryName.repo,
      sourceRunId: null,
      pullRequestNumberHint: scope.pullRequestNumber,
    });
    if (resolved.status !== CanonicalReviewRevisionResolutionStatus.Resolved) {
      return { status: CurrentReviewRevisionStatus.Unavailable } as const;
    }
    return {
      status: CurrentReviewRevisionStatus.Found,
      revision: {
        baseSha: resolved.baseSha,
        mergeBaseSha: resolved.mergeBaseSha,
        headSha: resolved.headSha,
        reviewRevisionHash: resolved.reviewRevisionHash,
      },
    } as const;
  }
}

class ProductionReviewActionV2SafetyAdapter
  implements
    ReviewActionV2LeaseSafetyPort,
    CurrentEvidenceWriteSafetyDecisionPort
{
  constructor(private readonly safety: ReviewSafetyDecisionResolverPort) {}

  async resolve(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly execution: ReviewExecution;
    readonly workSlotId: string;
  }) {
    const slot = input.execution.workSlots.find(
      (candidate) => candidate.workSlotId === input.workSlotId,
    );
    if (!slot) return { allowed: false, decisionHash: zeroHash };
    const decision = await this.safety.resolveReviewSafetyPolicy({
      decisionKind: ReviewSafetyDecisionKind.InvocationLeaseAdmission,
      target: safetyTarget(input.authorization, [
        executionProviderTask(slot.providerKind, slot.taskKind),
      ]),
    });
    return {
      allowed: decision.effectAllowed,
      decisionHash: decision.safetyDecisionHash,
    };
  }

  async resolveEvidenceWriteDecision(
    input: Parameters<
      CurrentEvidenceWriteSafetyDecisionPort["resolveEvidenceWriteDecision"]
    >[0],
  ) {
    const decision = await this.safety.resolveReviewSafetyPolicy({
      decisionKind: ReviewSafetyDecisionKind.ObservationAcceptance,
      target: {
        workspaceId: input.scope.workspaceId,
        repositoryConnectionId: input.scope.repositoryConnectionId,
        scmRepositoryIdentityId: input.scope.scmRepositoryIdentityId,
        providerTasks: input.taskKindSet.map((taskKind) => ({
          providerKind: evidenceProvider(input.providerKind),
          taskKind: evidenceTask(taskKind),
        })),
      },
    });
    return {
      effectAllowed: decision.effectAllowed,
      safetyDecisionHash: decision.safetyDecisionHash,
    };
  }
}

class ProductionReviewReusePolicyAdapter implements CurrentReviewReusePolicyPort {
  constructor(
    private readonly dependencies: Readonly<{
      safety: ReviewSafetyDecisionResolverPort;
      releases: ProducerReleaseQueryPort;
      digest: ProductionReviewActionV2Digest;
    }>,
  ) {}

  async resolveReviewReusePolicy(
    input: Parameters<
      CurrentReviewReusePolicyPort["resolveReviewReusePolicy"]
    >[0],
  ) {
    const release = await this.dependencies.releases.findProducerReleaseById(
      input.producerReleaseId,
    );
    if (!release || release.state !== ProducerReleaseState.Registered) {
      return null;
    }
    const providerTasks = input.taskKindSet.map((taskKind) => ({
      providerKind: evidenceProvider(input.providerKind),
      taskKind: evidenceTask(taskKind),
    }));
    const target = {
      workspaceId: input.scope.workspaceId,
      repositoryConnectionId: input.scope.repositoryConnectionId,
      scmRepositoryIdentityId: input.scope.scmRepositoryIdentityId,
      providerTasks,
    };
    const [exact, prompt, context] = await Promise.all([
      this.dependencies.safety.resolveReviewSafetyPolicy({
        decisionKind: ReviewSafetyDecisionKind.ExactRevisionCrossExecutionReuse,
        target,
      }),
      this.dependencies.safety.resolveReviewSafetyPolicy({
        decisionKind: ReviewSafetyDecisionKind.PromptOnlyCrossRevisionReuse,
        target,
      }),
      this.dependencies.safety.resolveReviewSafetyPolicy({
        decisionKind: ReviewSafetyDecisionKind.ContextGatewayCrossRevisionReuse,
        target,
      }),
    ]);
    return Object.freeze({
      safetyDecision: {
        evidenceReuseMode: reuseEffectMode(exact),
        promptOnlyReuseMode: reuseEffectMode(prompt),
        contextGatewayReuseMode: reuseEffectMode(context),
        safetyDecisionHash: await this.dependencies.digest.digestUtf8(
          canonicalJson({
            exact: exact.safetyDecisionHash,
            prompt: prompt.safetyDecisionHash,
            context: context.safetyDecisionHash,
          }),
        ),
      },
      compatibility: {
        registeredProducerReleaseIds: [release.producerReleaseId],
        trustedCapabilityProfiles: [release.capabilityProfile],
        compatibleProviderRuntimeVersions: [release.runtimeCommitSha],
        actualModelMode: ActualModelCompatibilityMode.Exact,
        compatibleActualModels: [],
      },
    });
  }
}

class ProductionReviewExecutionAttemptFactsAdapter implements ReviewExecutionAttemptFactsPort {
  constructor(
    private readonly dependencies: Readonly<{
      executions: PrismaReviewExecutionStore;
      authorizations: ReviewRunAuthorizationQueryPort;
      releases: ProducerReleaseQueryPort;
      digest: ProductionReviewActionV2Digest;
      clock: SystemClock;
    }>,
  ) {}

  async findAttemptFacts(input: {
    readonly attemptId: string;
    readonly leaseCapabilityId: string;
  }) {
    const lease =
      await this.dependencies.executions.findProviderExecutionLeaseByAttemptId(
        input.attemptId,
      );
    if (!lease) return null;
    const snapshot = await this.dependencies.executions.findExecution(
      lease.executionId,
    );
    const authorization =
      await this.dependencies.authorizations.findReviewRunAuthorizationById(
        lease.authorizationId,
      );
    const release = await this.dependencies.releases.findProducerReleaseById(
      lease.producerReleaseId,
    );
    if (!snapshot || !authorization || !release) return null;
    if (
      lease.preparedManifestCanonicalJson === null ||
      lease.preparedManifestKey === null ||
      lease.attemptId !== input.attemptId ||
      lease.leaseCapabilityId !== input.leaseCapabilityId ||
      lease.purpose !== ReviewInvocationLeasePurpose.ProviderExecution
    ) {
      throw new Error("review_attempt_persisted_identity_incomplete");
    }
    const manifest = parsePersistedManifest(
      lease.preparedManifestCanonicalJson,
    );
    const identity = await buildProviderInvocationIdentity(
      this.dependencies.digest,
      {
        manifest,
        providerVoteIdentityHash: lease.providerVoteIdentityHash,
      },
    );
    if (
      identity.manifestKey !== lease.preparedManifestKey ||
      identity.providerInvocationKey !== lease.providerInvocationKey
    ) {
      throw new Error("review_attempt_persisted_manifest_identity_corrupted");
    }
    const execution = snapshot.execution;
    const slot = execution.workSlots.find(
      (candidate) => candidate.workSlotId === lease.workSlotId,
    );
    if (
      !slot ||
      lease.executionGeneration !== execution.generation ||
      lease.authorizationId !== execution.authorizationId ||
      lease.producerReleaseId !== execution.producerReleaseId ||
      lease.reviewRevisionHash !== execution.revision.reviewRevisionHash ||
      lease.providerVoteIdentityHash !== slot.providerVoteIdentityHash ||
      manifest.scopeHash !==
        (await authorizationEvidenceScopeHash(
          authorization,
          this.dependencies.digest,
        )) ||
      manifest.providerKind !== executionEvidenceProvider(slot.providerKind) ||
      !manifest.taskKindSet.includes(executionEvidenceTask(slot.taskKind)) ||
      manifest.producerReleaseId !== authorization.producerReleaseId ||
      manifest.selectedProtocolVersion !==
        authorization.selectedProtocolVersion ||
      !sameExecutionAuthority(execution, authorization) ||
      authorization.reviewRevisionHash !== lease.reviewRevisionHash ||
      !authorization.providerVoteLanes.some(
        (lane) =>
          lane.providerKind ===
            executionProviderTask(slot.providerKind, slot.taskKind)
              .providerKind &&
          lane.providerVoteIdentityHash === lease.providerVoteIdentityHash,
      )
    ) {
      throw new Error("review_attempt_persisted_authority_mismatch");
    }
    const reportState = attemptReportState({
      authorization,
      releaseState: release.state,
      executionState: execution.state,
      resultReportUntil: lease.resultReportUntil,
      now: this.dependencies.clock.now(),
    });
    return Object.freeze({
      attemptId: input.attemptId,
      scope: {
        ...authorizationScope(authorization),
        authorizationScopeHash: manifest.scopeHash,
      },
      revision: authorizationRevision(authorization),
      planHash: execution.planHash,
      sourceExecutionId: execution.executionId,
      sourceWorkSlotId: slot.workSlotId,
      sourceAuthorizationId: authorization.authorizationId,
      sourceRunId: authorization.sourceRunId,
      sourceRunAttempt: authorization.sourceRunAttempt,
      manifest,
      manifestKey: identity.manifestKey,
      providerInvocationKey: identity.providerInvocationKey,
      providerVoteIdentityHash: lease.providerVoteIdentityHash,
      providerKind: manifest.providerKind,
      taskKindSet: manifest.taskKindSet,
      requestedModel: manifest.requestedModel,
      providerRuntimeVersion: release.runtimeCommitSha,
      producerReleaseId: release.producerReleaseId,
      selectedProtocolVersion: manifest.selectedProtocolVersion,
      trustedCapabilityProfile: release.capabilityProfile,
      executionProfile: manifest.executionProfile,
      trustDomain: evidenceTrustDomain(authorization.trustDomain),
      sourceLeaseId: lease.leaseId,
      leaseCapabilityId: lease.leaseCapabilityId,
      ownerIdHash: lease.ownerIdHash,
      sourceFencingToken: lease.fencingToken.toString(10),
      resultReportUntilMs: lease.resultReportUntil.getTime(),
      reportState,
    });
  }
}

class ProductionFinalizationFactsAdapter implements ReviewActionV2FinalizationFactsPort {
  constructor(
    private readonly dependencies: Readonly<{
      projectionPolicyVersion: string;
      safety: ReviewSafetyDecisionResolverPort;
      releases: ProducerReleaseQueryPort;
      digest: ProductionReviewActionV2Digest;
    }>,
  ) {}

  async resolve(
    input: Parameters<ReviewActionV2FinalizationFactsPort["resolve"]>[0],
  ) {
    if (
      canonicalJson(input.projectionEnvelope as never) !==
      input.projectionCanonicalJson
    ) {
      throw finalizationFailure("projection_not_canonical");
    }
    const envelope = finalizationRecord(
      input.projectionEnvelope,
      [
        "envelopeVersion",
        "projectionPolicyVersion",
        "scope",
        "coverage",
        "lifecycleStateHash",
        "commandLedgerWatermark",
        "occurrences",
        "mergeGate",
        "publishing",
        "snapshot",
      ],
      "projection_envelope_shape_invalid",
    );
    const scope = finalizationRecord(
      envelope.scope,
      [
        "scmRepositoryIdentityId",
        "pullRequestNumber",
        "baseSha",
        "reviewedHeadSha",
        "reviewRevisionHash",
      ],
      "projection_scope_shape_invalid",
    );
    if (
      input.projectionEnvelopeVersion !== 1 ||
      envelope.envelopeVersion !== "review_projection.v1" ||
      envelope.projectionPolicyVersion !==
        this.dependencies.projectionPolicyVersion ||
      scope.scmRepositoryIdentityId !==
        input.authorization.scmRepositoryIdentityId ||
      scope.pullRequestNumber !== input.authorization.pullRequestNumber ||
      scope.baseSha !== input.authorization.baseSha ||
      scope.reviewedHeadSha !== input.authorization.headSha ||
      scope.reviewRevisionHash !== input.authorization.reviewRevisionHash ||
      envelope.lifecycleStateHash !== input.lifecycleStateHash ||
      envelope.commandLedgerWatermark !==
        input.commandLedgerWatermark.toString(10) ||
      input.execution.revision.reviewRevisionHash !==
        input.authorization.reviewRevisionHash ||
      input.execution.revision.headSha !== input.authorization.headSha ||
      !sameExecutionAuthority(input.execution, input.authorization)
    ) {
      throw finalizationFailure("projection_authority_mismatch");
    }
    if (!Array.isArray(envelope.occurrences)) {
      throw finalizationFailure("projection_occurrences_invalid");
    }
    const byteCount = Buffer.byteLength(input.projectionCanonicalJson, "utf8");
    const findingCount = envelope.occurrences.length;
    if (
      byteCount > input.limits.maxProjectionBytes ||
      findingCount > input.limits.maxFindingCount
    ) {
      throw new ReviewActionV2RouteFailure(
        413,
        ReviewActionV2ProtocolErrorCode.LimitExceeded,
        ["projection_limit_exceeded"],
      );
    }
    const release = await this.dependencies.releases.findProducerReleaseById(
      input.authorization.producerReleaseId,
    );
    if (
      input.authorization.state !== RunAuthorizationState.Active ||
      input.authorization.expiresAt <= input.now ||
      !release ||
      release.state !== ProducerReleaseState.Registered ||
      release.producerReleaseId !== input.execution.producerReleaseId
    ) {
      throw new ReviewActionV2RouteFailure(
        403,
        ReviewActionV2ProtocolErrorCode.Forbidden,
        ["finalization_authority_inactive"],
      );
    }
    const target = safetyTarget(
      input.authorization,
      input.execution.workSlots.map((slot) =>
        executionProviderTask(slot.providerKind, slot.taskKind),
      ),
    );
    const [finalizationSafety, publicationSafety] = await Promise.all([
      this.dependencies.safety.resolveReviewSafetyPolicy({
        decisionKind: ReviewSafetyDecisionKind.ExecutionFinalizationWithPermit,
        target,
      }),
      this.dependencies.safety.resolveReviewSafetyPolicy({
        decisionKind: ReviewSafetyDecisionKind.PublicationMutation,
        target: authorizationScope(input.authorization),
      }),
    ]);
    if (!finalizationSafety.effectAllowed || !publicationSafety.effectAllowed) {
      throw new ReviewActionV2RouteFailure(
        403,
        ReviewActionV2ProtocolErrorCode.Forbidden,
        ["finalization_safety_rejected"],
      );
    }
    const operationsCanonicalJson = canonicalJson(envelope.publishing as never);
    const expectedArtifactHash = await this.dependencies.digest.digestUtf8(
      `rr.review-artifact.v1\0${canonicalJson({
        operationsCanonicalJson,
        projectionHash: input.projectionHash,
      })}`,
    );
    if (input.artifactId !== `rr:artifact:${expectedArtifactHash}`) {
      throw finalizationFailure("artifact_id_mismatch");
    }
    const publicationNotAfter = new Date(
      Math.min(
        input.authorization.expiresAt.getTime(),
        input.now.getTime() + input.maxReconciliationDurationMs,
      ),
    );
    if (publicationNotAfter <= input.now) {
      throw finalizationFailure("publication_window_exhausted");
    }
    return Object.freeze({
      expectedArtifactHash,
      byteCount,
      findingCount,
      projectionPolicyVersion: this.dependencies.projectionPolicyVersion,
      publicationSafetyDecisionHash: publicationSafety.safetyDecisionHash,
      publicationNotAfter,
      retainUntil: new Date(input.execution.retainUntil),
    });
  }
}

function readProviderVoteLanes(
  env: Readonly<Record<string, string | undefined>>,
) {
  const parsed = parseJsonArray(
    requiredEnv(env, reviewActionV2ProviderVoteLanesEnv),
    "review_action_v2_provider_vote_lanes_invalid",
  );
  if (parsed.length === 0 || parsed.length > 16) {
    throw new Error("review_action_v2_provider_vote_lanes_invalid");
  }
  const providers = new Set<ReviewProviderKind>();
  return Object.freeze(
    parsed.map((value) => {
      const row = exactRecord(value, [
        "providerKind",
        "providerVoteIdentityHash",
      ]);
      if (
        !Object.values(ReviewProviderKind).includes(
          row.providerKind as ReviewProviderKind,
        )
      ) {
        throw new Error("review_action_v2_provider_vote_lane_invalid");
      }
      const providerKind = row.providerKind as ReviewProviderKind;
      if (
        providers.has(providerKind) ||
        !isSha256(row.providerVoteIdentityHash)
      ) {
        throw new Error("review_action_v2_provider_vote_lane_invalid");
      }
      providers.add(providerKind);
      return {
        providerKind,
        providerVoteIdentityHash: row.providerVoteIdentityHash,
      };
    }),
  );
}

function readCapabilityKeyRing(
  env: Readonly<Record<string, string | undefined>>,
): ConfiguredCapabilityKeyRing {
  const activeKeyId = requiredEnv(env, reviewActionV2CapabilityActiveKeyIdEnv);
  const values = parseJsonArray(
    requiredEnv(env, reviewActionV2CapabilityKeysEnv),
    "review_action_v2_capability_keys_invalid",
  );
  if (values.length === 0 || values.length > 10) {
    throw new Error("review_action_v2_capability_keys_invalid");
  }
  return new ConfiguredCapabilityKeyRing({
    activeKeyId,
    keys: values.map(parseCapabilityKey),
  });
}

function parseCapabilityKey(
  value: unknown,
): ConfiguredCapabilityVerificationKey {
  const row = exactRecord(value, ["keyId", "secretBase64", "verifyUntil"]);
  if (
    typeof row.keyId !== "string" ||
    typeof row.secretBase64 !== "string" ||
    (row.verifyUntil !== null && typeof row.verifyUntil !== "string")
  ) {
    throw new Error("review_action_v2_capability_key_invalid");
  }
  const secret = Buffer.from(row.secretBase64, "base64");
  if (
    secret.byteLength < 32 ||
    secret.toString("base64") !== row.secretBase64
  ) {
    throw new Error("review_action_v2_capability_key_invalid");
  }
  const verifyUntil =
    row.verifyUntil === null ? null : new Date(row.verifyUntil);
  if (
    verifyUntil !== null &&
    (!Number.isFinite(verifyUntil.getTime()) ||
      verifyUntil.toISOString() !== row.verifyUntil)
  ) {
    throw new Error("review_action_v2_capability_key_invalid");
  }
  return {
    keyId: row.keyId,
    secret: new Uint8Array(secret),
    verifyUntil,
  };
}

function authorizationScope(authorization: ReviewRunAuthorization) {
  return {
    workspaceId: authorization.workspaceId,
    repositoryConnectionId: authorization.repositoryConnectionId,
    scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
    pullRequestNumber: authorization.pullRequestNumber,
  };
}

function authorizationRevision(authorization: ReviewRunAuthorization) {
  return {
    baseSha: authorization.baseSha,
    mergeBaseSha: authorization.mergeBaseSha,
    headSha: authorization.headSha,
    reviewRevisionHash: authorization.reviewRevisionHash,
  };
}

function executionLimits(
  limits: Awaited<
    ReturnType<
      ReviewProtocolLimitsProfileQueryPort["findProtocolLimitsProfileById"]
    >
  > & {},
): ReviewExecutionLimits {
  return {
    profileId: limits.protocolLimitsProfileId,
    maxWorkSlots: limits.maxWorkSlots,
    maxAttemptBudget: limits.maxAttemptsPerSlot,
    maxProjectionBytes: limits.maxProjectionBytes,
    maxFindingCount: limits.maxProjectionFindings,
    maxLeaseDurationMs: limits.maxLeaseDurationMs,
    maxResultReportDurationMs: limits.maxResultReportDurationMs,
  };
}

function safetyTarget(
  authorization: ReviewRunAuthorization,
  providerTasks: readonly {
    readonly providerKind: ReviewProviderKind;
    readonly taskKind: ReviewTaskKind;
  }[],
) {
  return {
    workspaceId: authorization.workspaceId,
    repositoryConnectionId: authorization.repositoryConnectionId,
    scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
    providerTasks,
  };
}

function executionProviderTask(
  provider: ReviewExecutionProviderKind,
  task: ExecutionTaskKind,
) {
  return {
    providerKind: provider as unknown as ReviewProviderKind,
    taskKind:
      task === ExecutionTaskKind.FindingDiscovery
        ? ReviewTaskKind.CodeReview
        : ReviewTaskKind.FindingRevalidation,
  };
}

function evidenceProvider(provider: EvidenceProviderKind): ReviewProviderKind {
  switch (provider) {
    case EvidenceProviderKind.Codex:
      return ReviewProviderKind.Codex;
    case EvidenceProviderKind.ClaudeCode:
      return ReviewProviderKind.ClaudeCode;
    case EvidenceProviderKind.OpenRouter:
      return ReviewProviderKind.OpenRouter;
    case EvidenceProviderKind.Unknown:
      throw new Error("review_action_v2_evidence_provider_unknown");
  }
}

function evidenceTask(task: EvidenceTaskKind): ReviewTaskKind {
  switch (task) {
    case EvidenceTaskKind.FindingDiscovery:
      return ReviewTaskKind.CodeReview;
    case EvidenceTaskKind.LifecycleRevalidation:
      return ReviewTaskKind.FindingRevalidation;
    case EvidenceTaskKind.Unknown:
      throw new Error("review_action_v2_evidence_task_unknown");
  }
}

function executionEvidenceProvider(
  provider: ReviewExecutionProviderKind,
): EvidenceProviderKind {
  switch (provider) {
    case ReviewExecutionProviderKind.Codex:
      return EvidenceProviderKind.Codex;
    case ReviewExecutionProviderKind.ClaudeCode:
      return EvidenceProviderKind.ClaudeCode;
    case ReviewExecutionProviderKind.OpenRouter:
      return EvidenceProviderKind.OpenRouter;
  }
}

function executionEvidenceTask(task: ExecutionTaskKind): EvidenceTaskKind {
  switch (task) {
    case ExecutionTaskKind.FindingDiscovery:
      return EvidenceTaskKind.FindingDiscovery;
    case ExecutionTaskKind.LifecycleRevalidation:
      return EvidenceTaskKind.LifecycleRevalidation;
  }
}

function evidenceTrustDomain(
  trustDomain: ReviewRunAuthorization["trustDomain"],
): EvidenceTrustDomain {
  switch (trustDomain) {
    case "trusted_managed":
      return EvidenceTrustDomain.TrustedManaged;
    case "trusted_local":
      return EvidenceTrustDomain.TrustedLocal;
    case "untrusted_contribution":
      return EvidenceTrustDomain.UntrustedContribution;
    default:
      throw new Error("review_attempt_trust_domain_unknown");
  }
}

function parsePersistedManifest(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("review_attempt_persisted_manifest_json_corrupted");
  }
  const manifest = normalizeProviderInvocationManifest(parsed);
  if (
    serializeProviderInvocationManifestCanonicalWireJson(manifest) !== value
  ) {
    throw new Error("review_attempt_persisted_manifest_not_canonical");
  }
  return manifest;
}

async function authorizationEvidenceScopeHash(
  authorization: ReviewRunAuthorization,
  digest: ProductionReviewActionV2Digest,
) {
  return digest.digestUtf8(canonicalJson(authorizationScope(authorization)));
}

function sameExecutionAuthority(
  execution: ReviewExecution,
  authorization: ReviewRunAuthorization,
) {
  return (
    execution.authorizationId === authorization.authorizationId &&
    execution.workspaceId === authorization.workspaceId &&
    execution.repositoryConnectionId === authorization.repositoryConnectionId &&
    execution.scmRepositoryIdentityId ===
      authorization.scmRepositoryIdentityId &&
    execution.pullRequestNumber === authorization.pullRequestNumber &&
    execution.revision.baseSha === authorization.baseSha &&
    execution.revision.mergeBaseSha === authorization.mergeBaseSha &&
    execution.revision.headSha === authorization.headSha &&
    execution.revision.reviewRevisionHash === authorization.reviewRevisionHash
  );
}

function attemptReportState(input: {
  readonly authorization: ReviewRunAuthorization;
  readonly releaseState: ProducerReleaseState;
  readonly executionState: ReviewExecutionState;
  readonly resultReportUntil: Date;
  readonly now: Date;
}): ReviewExecutionAttemptReportState {
  if (
    input.authorization.state !== RunAuthorizationState.Active ||
    input.authorization.expiresAt <= input.now
  ) {
    return ReviewExecutionAttemptReportState.AuthorizationRevoked;
  }
  if (input.releaseState !== ProducerReleaseState.Registered) {
    return ReviewExecutionAttemptReportState.ProducerReleaseRevoked;
  }
  if (input.resultReportUntil <= input.now) {
    return ReviewExecutionAttemptReportState.ReportWindowExpired;
  }
  if (input.executionState === ReviewExecutionState.Superseded) {
    return ReviewExecutionAttemptReportState.SupersededHistoricalOnly;
  }
  return ReviewExecutionAttemptReportState.Reportable;
}

function reuseEffectMode(input: {
  readonly effectAllowed: boolean;
  readonly shadow: boolean;
}): ReviewReuseEffectMode {
  if (!input.effectAllowed) return ReviewReuseEffectMode.Disabled;
  return input.shadow
    ? ReviewReuseEffectMode.Shadow
    : ReviewReuseEffectMode.Enabled;
}

function splitRepositoryName(fullName: string) {
  const segments = fullName.split("/");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new Error("review_action_v2_repository_name_invalid");
  }
  return { owner: segments[0], repo: segments[1] };
}

function requiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`review_action_v2_env_missing:${name}`);
  return value;
}

function parseJsonArray(value: string, errorCode: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Normalized below without leaking the configured value.
  }
  throw new Error(errorCode);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("review_action_v2_config_record_invalid");
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error("review_action_v2_config_record_invalid");
  }
  return row;
}

function finalizationRecord(
  value: unknown,
  keys: readonly string[],
  issue: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw finalizationFailure(issue);
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== [...keys].sort().join(",")) {
    throw finalizationFailure(issue);
  }
  return row;
}

function finalizationFailure(issue: string): ReviewActionV2RouteFailure {
  return new ReviewActionV2RouteFailure(
    422,
    ReviewActionV2ProtocolErrorCode.InvariantViolation,
    [issue],
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

const absoluteProtocolMaxima: ReviewProtocolLimits = Object.freeze({
  maxWorkSlots: reviewExecutionAbsoluteMaxWorkSlots,
  maxAttemptsPerSlot: reviewExecutionAbsoluteMaxAttemptBudget,
  maxObservationBytes: 2 * 1024 * 1024,
  maxObservationFindings: 2_000,
  maxProjectionBytes: reviewExecutionAbsoluteMaxProjectionBytes,
  maxProjectionFindings: reviewExecutionAbsoluteMaxFindingCount,
  maxPublicationOperations: 1_000,
  maxPublicationChunks: 1_000,
  maxPublicationBodyBytes: 2 * 1024 * 1024,
  maxRequestBatchSize: 100,
  maxLeaseDurationMs: 60 * 60 * 1_000,
  maxResultReportDurationMs: 6 * 60 * 60 * 1_000,
  maxReconciliationDurationMs: 24 * 60 * 60 * 1_000,
});

const executionTiming: ReviewActionV2ExecutionTimingPolicy = Object.freeze({
  admissionDurationMs: 30_000,
  executionDurationMs: 6 * 60 * 60 * 1_000,
  initialLeaseDurationMs: 10 * 60 * 1_000,
  retentionDurationMs: 30 * 24 * 60 * 60 * 1_000,
  attachmentCapabilityDurationMs: 10 * 60 * 1_000,
});

const productionTiming = Object.freeze({
  authorizationTtlMs: 60 * 60 * 1_000,
  maxAuthorizationLifetimeMs: 6 * 60 * 60 * 1_000,
  evidenceReuseTtlMs: 7 * 24 * 60 * 60 * 1_000,
  retentionDurationMs: executionTiming.retentionDurationMs,
});

const zeroHash = "0".repeat(64);
