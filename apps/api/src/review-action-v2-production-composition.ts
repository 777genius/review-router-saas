import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { App } from "@octokit/app";
import {
  HmacActionLedgerKey,
  JoseGitHubActionsOidcTokenVerifier,
  PrismaActionControlPlaneRepository,
} from "@reviewrouter/features-action-control-plane";
import type {
  RegisterReviewContextAttestationV2RoutesDependencies,
  RegisterReviewEvidenceV2RoutesDependencies,
  RegisterReviewExecutionV2RoutesDependencies,
  RegisterReviewInvestigationV2RoutesDependencies,
  RegisterReviewPublicationRequestV2RoutesDependencies,
  RegisterReviewRunControlV2RoutesDependencies,
  RegisterReviewSnapshotReadV2RoutesDependencies,
} from "@reviewrouter/features-action-control-plane/v2";
import { InvestigationTurnProviderKind } from "@reviewrouter/features-review-investigations";
import {
  investigationPrivateMaterialActiveKeyIdEnvironmentVariable,
  investigationPrivateMaterialKeysEnvironmentVariable,
  investigationPrivateMaterialTtlEnvironmentVariable,
  investigationRetentionMaintenanceEnabledEnvironmentVariable,
  loadConfiguredInvestigationPrivateMaterial,
  NodeSha256InvestigationDigest,
  PrismaInvestigationStore,
} from "@reviewrouter/features-review-investigations/composition";
import {
  InvestigationRolloutCapability,
  InvestigationRolloutProvider,
  InvestigationTelemetrySource,
  ResolveInvestigationRollout,
  type InvestigationRolloutPolicy,
} from "@reviewrouter/features-review-investigation-operations";
import {
  EnvironmentInvestigationRolloutPolicyQuery,
  RunControlInvestigationEmergencyStopQuery,
  investigationContextCriticEnabledEnv,
  investigationCrossRevisionReplayEnabledEnv,
  investigationEmergencyDisabledEnv,
  investigationProductionEffectsEnabledEnv,
  investigationRecordingEnabledEnv,
  investigationRolloutSelectorsEnv,
  investigationShadowEnabledEnv,
  investigationVerifiedCleanEnabledEnv,
  readEnvironmentInvestigationRolloutPolicy,
} from "@reviewrouter/features-review-investigation-operations/composition";
import { ReviewActionV2RouteFailure } from "@reviewrouter/features-action-control-plane/v2";
import {
  ActualModelCompatibilityMode,
  ReviewProviderKind as EvidenceProviderKind,
  ReviewExecutionAttemptReportState,
  ReviewReuseEffectMode,
  canonicalizeReviewContextReusePolicyVector,
  reviewReuseEligibilityPolicyVersion,
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
  PrismaInvestigationShadowEvidenceStore,
  PrismaReviewObservationStore,
  createInvestigationShadowEvidenceUseCases,
  createReviewEvidenceUseCases,
} from "@reviewrouter/features-review-evidence/composition";
import {
  CurrentReviewRevisionStatus,
  ReviewExecutionState,
  ReviewExecutionProviderKind,
  ReviewInvocationLeasePurpose,
  ReviewTaskKind as ExecutionTaskKind,
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
import { createPrismaReviewProgressCapture } from "@reviewrouter/features-review-progress/composition";
import {
  GitHubReviewPublicationLifecycleAdapter,
  HmacReviewCommandLedgerVerifier,
  OctokitGitHubInstallationGraphqlClientFactory,
  resolveReviewCommandLedgerHmacSecret,
  trustedReviewCommandLedgerAuthorsFromEnv,
} from "@reviewrouter/features-review-publishing/v2/composition";
import {
  CanonicalReviewRevisionResolutionStatus,
  ImmutableRegistryWriteStatus,
  ProducerReleaseState,
  ReviewProviderKind,
  ReviewRunAuthorizationState as RunAuthorizationState,
  ReviewSafetyDecisionKind,
  ReviewSafetyPolicyScope,
  ResolveReviewSafetyPolicy,
  ReviewTaskKind,
  canonicalJson,
  canonicalReviewOperationalSloProfile,
  canonicalReviewProtocolLimits,
  producerReleaseImmutableKey,
  reviewInvestigationCapabilityV1,
  type CanonicalReviewRevisionResolverPort,
  type ProducerRelease,
  type ReviewProtocolLimits,
  type ReviewOperationalSloThresholds,
  type ReviewOperationalSloProfileQueryPort,
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
import { reviewActionV2AbsoluteProtocolMaxima } from "./review-action-v2-protocol-policy.js";
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
import {
  ReviewActionV2ProtocolErrorCode,
  reviewInvestigationExtensionV1,
} from "@reviewrouter/protocol-review-action-v2";
import { SystemClock } from "@reviewrouter/shared";
import { ReviewActionV2ExecutionEvidenceCapabilityAdapter } from "./review-action-v2-execution-evidence-capabilities.js";
import {
  DisabledReviewActionV2InvestigationLeaseCapabilityAdapter,
  ReviewActionV2InvestigationLeaseCapabilityAdapter,
} from "./review-action-v2-investigation-lease-capabilities.js";
import { resolveReviewActionV2ProjectionPolicyVersion } from "./review-action-v2-projection-policy.js";
import { ReviewContextAttestationEvidenceAdapter } from "./review-context-attestation-evidence-adapter.js";
import { ContextAttestationInvestigationReceiptReplayAdapter } from "./review-investigation-receipt-replay-adapter.js";
import {
  composeReviewActionV2ContextAttestationRoutes,
  createInvestigationReceiptReplayPreparationPort,
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
  type ReviewInvestigationAuthorizationCapabilityPort,
  type TrustedProducerReleaseMaterializerPort,
} from "./review-action-v2-run-control-composition.js";
import { composeReviewActionV2SnapshotPublicationRoutes } from "./review-action-v2-production-composition-snapshot-publication.js";
import {
  ProductionInvestigationExecutionAuthority,
  ProductionInvestigationTurnEvidence,
  ReviewEvidenceInvestigationTerminalProjection,
  composeReviewActionV2InvestigationRoutes,
  composeReviewInvestigationUseCases,
} from "./review-action-v2-investigation-composition.js";
import { OctokitCodexRotatingGitHubSecretGateway } from "./github/octokit-codex-rotating-github-secret-gateway.js";
import { ProductionReviewMutationAuthorityProofFacts } from "./review-action-v2-mutation-proof-facts.js";
import { OctokitReviewV2DispatchCapabilityInspector } from "./github/octokit-review-v2-dispatch-capability-inspector.js";
import { ReviewInvestigationCertificateVerificationAdapter } from "./review-investigation-certificate-verification-adapter.js";
import {
  ProductionReviewInvestigationFinalizationRolloutGuard,
  type ReviewInvestigationFinalizationRolloutGuardPort,
} from "./review-investigation-finalization-rollout-guard.js";
import {
  ReviewInvestigationRolloutGuard,
  type ReviewInvestigationRolloutCapabilityResolutionPort,
} from "./review-investigation-rollout-guard.js";
import {
  composePrismaReviewInvestigationTerminalTelemetry,
  ReviewInvestigationOperationsDiagnosticCode,
  type ReviewInvestigationOperationsDiagnosticPort,
  type ReviewInvestigationTerminalTelemetrySourcePort,
  type ReviewInvestigationTerminalTelemetrySamplePort,
} from "./review-investigation-operations-composition.js";

export const reviewActionV2CapabilityActiveKeyIdEnv =
  "REVIEW_ROUTER_REVIEW_V2_CAPABILITY_ACTIVE_KEY_ID";
export const reviewActionV2CapabilityKeysEnv =
  "REVIEW_ROUTER_REVIEW_V2_CAPABILITY_KEYS_JSON";
export const reviewInvestigationLeaseCapabilityActiveKeyIdEnv =
  "REVIEW_ROUTER_REVIEW_INVESTIGATION_LEASE_CAPABILITY_ACTIVE_KEY_ID";
export const reviewInvestigationLeaseCapabilityKeysEnv =
  "REVIEW_ROUTER_REVIEW_INVESTIGATION_LEASE_CAPABILITY_KEYS_JSON";
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
export const reviewInvestigationRecordingEnabledEnv =
  investigationRecordingEnabledEnv;
export const reviewInvestigationShadowEnabledEnv =
  investigationShadowEnabledEnv;
export const reviewInvestigationCrossRevisionReplayEnabledEnv =
  investigationCrossRevisionReplayEnabledEnv;
export const reviewInvestigationContextCriticEnabledEnv =
  investigationContextCriticEnabledEnv;
export const reviewInvestigationVerifiedCleanEnabledEnv =
  investigationVerifiedCleanEnabledEnv;
export const reviewInvestigationProductionEffectsEnabledEnv =
  investigationProductionEffectsEnabledEnv;
export const reviewInvestigationEmergencyDisabledEnv =
  investigationEmergencyDisabledEnv;
export const reviewInvestigationRolloutSelectorsEnv =
  investigationRolloutSelectorsEnv;
export const reviewInvestigationPrivateMaterialActiveKeyIdEnv =
  investigationPrivateMaterialActiveKeyIdEnvironmentVariable;
export const reviewInvestigationPrivateMaterialKeysEnv =
  investigationPrivateMaterialKeysEnvironmentVariable;
export const reviewInvestigationPrivateMaterialTtlEnv =
  investigationPrivateMaterialTtlEnvironmentVariable;
export const reviewInvestigationMaintenanceEnabledEnv =
  investigationRetentionMaintenanceEnabledEnvironmentVariable;

type ReviewActionV2RouteRuntime = Pick<
  RegisterReviewRunControlV2RoutesDependencies,
  "readServerTime" | "createRequestId"
>;

export type ReviewActionV2ProductionRoutes = Readonly<{
  runControl: RegisterReviewRunControlV2RoutesDependencies;
  execution: RegisterReviewExecutionV2RoutesDependencies;
  investigation: RegisterReviewInvestigationV2RoutesDependencies;
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
  const projectionPolicyVersion = resolveReviewActionV2ProjectionPolicyVersion(
    configuredProjectionPolicyVersion,
  );
  if (projectionPolicyVersion === null) {
    throw new Error("review_action_v2_projection_policy_version_unsupported");
  }
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
      releaseAttestations: prerequisites.releaseAttestations,
      producerReleases: repositories.producerReleases,
      safety: mutationSafetyResolver,
      workflowInventory,
      dispatchCapability,
      completionWorkerConfigured:
        input.env.REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED === "1",
      directV2InitializationEnabled:
        input.env.REVIEW_ROUTER_REVIEW_V2_DIRECT_INITIALIZATION_ENABLED === "1",
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
    absoluteProtocolMaxima: reviewActionV2AbsoluteProtocolMaxima,
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
  readonly ledgerHmacSecret?: string | undefined;
  readonly investigationTelemetrySamples?:
    | ReviewInvestigationTerminalTelemetrySamplePort
    | undefined;
  readonly recordInvestigationOperationsDiagnostic?:
    | ((
        code: ReviewInvestigationOperationsDiagnosticCode,
      ) => Promise<void> | void)
    | undefined;
}): ReviewActionV2ProductionRoutes {
  if (!input.enabled) {
    return Object.freeze({
      runControl: input.runtime,
      execution: input.runtime,
      investigation: input.runtime,
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
  const ledgerHmacSecret = resolveReviewCommandLedgerHmacSecret(
    input.env,
    input.ledgerHmacSecret,
  );
  const commandLedgers = new HmacReviewCommandLedgerVerifier(
    ledgerHmacSecret ? new HmacActionLedgerKey(ledgerHmacSecret) : null,
  );
  assertReviewIntentRolloutConfiguration(input.env);
  const investigationRollout = readInvestigationRolloutPolicy(input.env);
  const investigationRecordingEnabled = investigationCapabilityEnabled(
    investigationRollout,
    InvestigationRolloutCapability.Recording,
  );
  const investigationPrivateMaterial = investigationRecordingEnabled
    ? loadConfiguredInvestigationPrivateMaterial(input.env)
    : null;
  if (investigationRecordingEnabled && !investigationPrivateMaterial) {
    throw new Error("investigation_private_material_configuration_required");
  }
  if (
    investigationRecordingEnabled &&
    input.env[investigationRetentionMaintenanceEnabledEnvironmentVariable] !==
      "1"
  ) {
    throw new Error("investigation_retention_maintenance_required");
  }
  const {
    clock,
    digest,
    repositories,
    actionRepositories,
    prerequisites,
    runControl,
    oidcAudience,
    providerVoteLanes,
  } = composeReviewActionV2ProductionRunControl({
    env: input.env,
    prisma: input.prisma,
    ...(input.oidcAudience === undefined
      ? {}
      : { oidcAudience: input.oidcAudience }),
  });
  const investigationRolloutGuard = new ReviewInvestigationRolloutGuard(
    new ResolveInvestigationRollout(
      new EnvironmentInvestigationRolloutPolicyQuery(input.env),
      new RunControlInvestigationEmergencyStopQuery({
        findApplicable: async (target) =>
          (
            await repositories.safetyControls.findApplicableReviewSafetyEmergencyControls(
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
  );

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
  const investigationOperationsDiagnostics: ReviewInvestigationOperationsDiagnosticPort =
    {
      record: (code) => input.recordInvestigationOperationsDiagnostic?.(code),
    };
  const runControlHandlers = {
    oidcVerifier: new JoseGitHubActionsOidcTokenVerifier(),
    oidcAudience,
    actionRepositories,
    repositoryIdentities: repositories.repositoryIdentities,
    producerReleases: repositories.producerReleases,
    trustedProducerReleaseMaterializer:
      createTrustedProducerReleaseMaterializer({
        digest,
        producerReleases: runControl.producerReleases,
        releaseQueries: repositories.producerReleases,
        protocolLimitsQueries: repositories.producerReleases,
        operationalSloQueries: repositories.producerReleases,
      }),
    admissionFacts,
    revisionHashes,
    authorizations: runControl.authorizations,
    digest,
    absoluteProtocolMaxima: reviewActionV2AbsoluteProtocolMaxima,
    authorizationTtlMs: productionTiming.authorizationTtlMs,
    maxAuthorizationLifetimeMs: productionTiming.maxAuthorizationLifetimeMs,
    reviewInvestigationCapability:
      new ProductionReviewInvestigationAuthorizationCapability(
        investigationRolloutGuard,
        investigationOperationsDiagnostics,
      ),
  } as const;

  const executionStore = new PrismaReviewExecutionStore(
    input.prisma,
    input.env.REVIEW_ROUTER_PROGRESS_PROJECTION_CAPTURE === "1"
      ? {
          progressCapture: createPrismaReviewProgressCapture({
            fileCoverageEnabled:
              input.env.REVIEW_ROUTER_PROGRESS_FILE_COVERAGE === "1",
          }),
        }
      : {},
  );
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
  const investigationShadowEvidenceStore =
    new PrismaInvestigationShadowEvidenceStore(input.prisma);
  const investigationShadowEvidence = createInvestigationShadowEvidenceUseCases(
    {
      commands: investigationShadowEvidenceStore,
      queries: investigationShadowEvidenceStore,
      pruner: investigationShadowEvidenceStore,
      digest,
      clock: { nowMs: () => clock.now().getTime() },
    },
  );
  const contextAttestationStore = new PrismaContextAttestationStore(
    input.prisma,
  );
  const investigationStore = new PrismaInvestigationStore(input.prisma, {
    operationalRetentionMs: productionTiming.retentionDurationMs,
  });
  const investigationTerminalTelemetry =
    composePrismaReviewInvestigationTerminalTelemetry({
      prisma: input.prisma,
      investigations: investigationStore,
      sources: new RolloutReviewInvestigationTerminalTelemetrySource(
        investigationRolloutGuard,
      ),
      ...(input.investigationTelemetrySamples
        ? { samples: input.investigationTelemetrySamples }
        : {}),
      diagnostics: investigationOperationsDiagnostics,
    });
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
    investigationCertificates:
      new ReviewInvestigationCertificateVerificationAdapter(
        investigationStore,
        new NodeSha256InvestigationDigest(),
        investigationRolloutGuard,
      ),
    investigationCertificateAcceptanceEnabled:
      input.env[reviewInvestigationShadowEnabledEnv] === "1",
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
  const investigationLeaseCapabilities = investigationRecordingEnabled
    ? createInvestigationLeaseCapabilityAdapter(input.env)
    : new DisabledReviewActionV2InvestigationLeaseCapabilityAdapter();
  const contextCrypto = readReviewActionV2ContextCrypto(input.env);
  const contextAttestationHandlers = {
    authorizations: runControl.authorizations,
    executionQueries: executionStore,
    observations: observationStore,
    reusePolicy,
    store: contextAttestationStore,
    cipher: contextCrypto.cipher,
    capabilities,
    investigationLeaseQueries: investigationStore,
    investigationQueries: investigationStore,
    investigationLeaseCapabilities,
    investigationRollout: investigationRolloutGuard,
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
            githubRepositoryId: requiredGithubRepositoryId(repository),
            repositoryFullName: repository.fullName,
            owner: repository.owner,
            repo: repository.name,
          };
        },
      },
      new OctokitGitHubInstallationGraphqlClientFactory({
        appId: githubAppId,
        privateKey: githubAppPrivateKey,
      }),
      commandLedgers,
      trustedReviewCommandLedgerAuthorsFromEnv(input.env),
    ),
    contextPolicy: contextReplay,
    now: () => clock.now(),
  });
  const investigation = composeReviewActionV2InvestigationRoutes({
    enabled: investigationRecordingEnabled,
    runtime: input.runtime,
    handlers: {
      authorizations: runControl.authorizations,
      authorizationQueries: repositories.authorizations,
      executionQueries: executionStore,
      producerReleases: repositories.producerReleases,
      investigations: composeReviewInvestigationUseCases({
        store: investigationStore,
        leases: investigationStore,
        authority: new ProductionInvestigationExecutionAuthority(
          executionStore,
          repositories.authorizations,
        ),
        evidence: new ProductionInvestigationTurnEvidence(
          contextAttestationStore,
          () => clock.now(),
        ),
        clock,
        terminalProjection: new ReviewEvidenceInvestigationTerminalProjection(
          digest,
        ),
        receiptReplay: new ContextAttestationInvestigationReceiptReplayAdapter(
          contextAttestationStore,
          { nowMs: () => clock.now().getTime() },
          new NodeSha256InvestigationDigest(),
          {
            async resolve(current) {
              const snapshot = await executionStore.findExecution(
                current.targetExecutionId,
              );
              const slot = snapshot?.execution.workSlots.find(
                (candidate) =>
                  candidate.workSlotId === current.targetWorkSlotId,
              );
              const authorization = snapshot
                ? await repositories.authorizations.findReviewRunAuthorizationById(
                    snapshot.execution.authorizationId,
                  )
                : null;
              if (
                !snapshot ||
                !slot ||
                !authorization ||
                !current.sourceSession ||
                slot.providerVoteIdentityHash !==
                  current.targetProviderVoteLaneId ||
                snapshot.execution.revision.reviewRevisionHash !==
                  current.targetRevision.reviewRevisionHash ||
                authorization.reviewRevisionHash !==
                  current.targetRevision.reviewRevisionHash ||
                authorization.producerReleaseId !== current.producerReleaseId
              ) {
                return null;
              }
              const [targetCheckoutTreeOid, release, policy] =
                await Promise.all([
                  contextAttestationHandlers.checkoutTrees.resolveCheckoutTreeOid(
                    authorization,
                  ),
                  contextAttestationHandlers.producerReleases.resolve({
                    producerReleaseId: current.producerReleaseId,
                  }),
                  reusePolicy.resolveReviewReusePolicy({
                    scope: {
                      workspaceId: authorization.workspaceId,
                      repositoryConnectionId:
                        authorization.repositoryConnectionId,
                      scmRepositoryIdentityId:
                        authorization.scmRepositoryIdentityId,
                      pullRequestNumber: authorization.pullRequestNumber,
                      authorizationScopeHash: await digest.digestUtf8(
                        canonicalJson({
                          workspaceId: authorization.workspaceId,
                          repositoryConnectionId:
                            authorization.repositoryConnectionId,
                          scmRepositoryIdentityId:
                            authorization.scmRepositoryIdentityId,
                          pullRequestNumber: authorization.pullRequestNumber,
                        }),
                      ),
                    },
                    revision: { ...current.targetRevision },
                    providerKind: executionEvidenceProvider(slot.providerKind),
                    taskKindSet: [executionEvidenceTask(slot.taskKind)],
                    trustDomain: evidenceTrustDomain(authorization.trustDomain),
                    producerReleaseId: current.producerReleaseId,
                  }),
                ]);
              if (
                !targetCheckoutTreeOid ||
                !release ||
                !policy ||
                !release.contextGatewayPolicyVersion ||
                !release.contextGatewayEntrypointDigest ||
                release.contextGatewayPolicyVersion !==
                  current.gatewayPolicyVersion ||
                policy.safetyDecision.contextGatewayReuseMode !==
                  ReviewReuseEffectMode.Enabled
              ) {
                return null;
              }
              const providerKind = executionEvidenceProvider(slot.providerKind);
              return Object.freeze({
                targetCheckoutTreeOid,
                replayBinaryHash: release.contextGatewayEntrypointDigest,
                replayPolicyVersion: release.contextGatewayPolicyVersion,
                reusePolicyVectorHash: await digest.digestUtf8(
                  canonicalizeReviewContextReusePolicyVector({
                    safetyDecision: policy.safetyDecision,
                    compatibility: policy.compatibility,
                    eligibilityPolicyVersion:
                      reviewReuseEligibilityPolicyVersion,
                    gatewayPolicyVersion: release.contextGatewayPolicyVersion,
                    gatewayBinaryHash: release.contextGatewayEntrypointDigest,
                    trustedCapabilityProfile: release.capabilityProfile,
                    producerReleaseId: current.producerReleaseId,
                    providerKind,
                    requestedModel: current.sourceAttestation.actualModel,
                    actualModel: current.sourceAttestation.actualModel,
                  }),
                ),
              });
            },
          },
        ),
        ...(investigationPrivateMaterial
          ? {
              privateMaterial: {
                store: investigationStore,
                cipher: investigationPrivateMaterial.cipher,
                ttlMs: investigationPrivateMaterial.ttlMs,
              },
            }
          : {}),
      }),
      investigationLeaseQueries: investigationStore,
      capabilities,
      investigationLeaseCapabilities,
      digest,
      now: () => clock.now(),
      rollout: investigationRolloutGuard,
      terminalShadowEvidence:
        investigationShadowEvidence.projectInvestigationShadowEvidence,
      terminalTelemetry: investigationTerminalTelemetry,
      crossRevisionReplayEnabled: investigationCapabilityEnabled(
        investigationRollout,
        InvestigationRolloutCapability.CrossRevisionReplay,
      ),
      nextInvestigationLeaseId: () => `investigation-lease-${randomUUID()}`,
      nextInvestigationAttemptId: () => `investigation-attempt-${randomUUID()}`,
      investigationLeaseTiming: {
        initialLeaseDurationMs: executionTiming.initialLeaseDurationMs,
        renewLeaseDurationMs: executionTiming.initialLeaseDurationMs,
        retentionDurationMs: productionTiming.retentionDurationMs,
      },
      replayPreparation: (target) =>
        createInvestigationReceiptReplayPreparationPort(
          target,
          contextAttestationHandlers,
        ),
    },
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
          safety: runControl.safetyResolver,
          releases: repositories.producerReleases,
          digest,
          investigationRollout:
            new ProductionReviewInvestigationFinalizationRolloutGuard({
              observations: observationStore,
              investigations: investigationStore,
              rollout: investigationRolloutGuard,
            }),
        }),
      },
    }),
    investigation,
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

function requiredGithubRepositoryId(repository: {
  readonly githubRepositoryId: bigint | null;
}): string {
  if (repository.githubRepositoryId === null) {
    throw new Error("review_lifecycle_github_repository_id_missing");
  }
  return repository.githubRepositoryId.toString();
}

export class ProductionReviewInvestigationAuthorizationCapability implements ReviewInvestigationAuthorizationCapabilityPort {
  constructor(
    private readonly rollout: Pick<
      ReviewInvestigationRolloutCapabilityResolutionPort,
      "resolveAllowedCapabilitiesForTargets"
    >,
    private readonly diagnostics: ReviewInvestigationOperationsDiagnosticPort = {
      record: () => undefined,
    },
  ) {}

  async resolve(
    input: Parameters<
      ReviewInvestigationAuthorizationCapabilityPort["resolve"]
    >[0],
  ) {
    const profile = input.producerRelease.reviewInvestigationProfile;
    if (
      profile === null ||
      profile.capability !== reviewInvestigationCapabilityV1
    ) {
      await this.recordDiagnostic(
        ReviewInvestigationOperationsDiagnosticCode.AuthorizationReleaseProfileMissing,
      );
      return null;
    }
    const providerCapabilities: {
      providerKind: "codex" | "claude_code";
      capabilities: readonly InvestigationRolloutCapability[];
    }[] = [];
    const providerKinds = [
      ...new Set(
        input.target.providerVoteLanes.map((lane) => lane.providerKind),
      ),
    ].sort();
    const providers = providerKinds
      .map(investigationAuthorizationProvider)
      .filter((provider) => provider !== null);
    if (providers.length === 0) {
      await this.recordDiagnostic(
        ReviewInvestigationOperationsDiagnosticCode.AuthorizationProviderUnsupported,
      );
      return null;
    }
    const targets = providers.map((provider) => ({
      workspaceId: input.target.workspaceId,
      repositoryConnectionId: input.target.repositoryConnectionId,
      scmRepositoryIdentityId: input.target.scmRepositoryIdentityId,
      provider: provider.rollout,
      trustDomain: input.target.trustDomain,
      producerReleaseId: input.target.producerReleaseId,
    }));
    let resolvedCapabilities: readonly (readonly InvestigationRolloutCapability[])[];
    try {
      resolvedCapabilities =
        await this.rollout.resolveAllowedCapabilitiesForTargets({ targets });
    } catch {
      await this.recordDiagnostic(
        ReviewInvestigationOperationsDiagnosticCode.AuthorizationRolloutUnavailable,
      );
      return null;
    }
    for (const [index, provider] of providers.entries()) {
      const capabilities = resolvedCapabilities[index];
      if (
        capabilities === undefined ||
        !capabilities.includes(InvestigationRolloutCapability.Recording)
      ) {
        continue;
      }
      providerCapabilities.push(
        Object.freeze({
          providerKind: provider.authorization,
          capabilities: Object.freeze([...capabilities]),
        }),
      );
    }
    if (providerCapabilities.length === 0) {
      await this.recordDiagnostic(
        ReviewInvestigationOperationsDiagnosticCode.AuthorizationRecordingNotGranted,
      );
      return null;
    }
    return Object.freeze({
      authorizationDescriptorVersion: 3,
      capability: reviewInvestigationCapabilityV1,
      coverageProfileHash: profile.coverageProfileHash,
      extensionCanonicalizerDigest:
        reviewInvestigationExtensionV1.canonicalizerDigest,
      extensionId: reviewInvestigationExtensionV1.extensionId,
      extensionSchemaDigest: reviewInvestigationExtensionV1.schemaDigest,
      policyHash: profile.policyHash,
      providerCapabilities: Object.freeze(providerCapabilities),
    });
  }

  private async recordDiagnostic(
    code: ReviewInvestigationOperationsDiagnosticCode,
  ): Promise<void> {
    try {
      await this.diagnostics.record(code);
    } catch {
      // Diagnostics must not change the fail-closed authorization result.
    }
  }
}

class RolloutReviewInvestigationTerminalTelemetrySource implements ReviewInvestigationTerminalTelemetrySourcePort {
  constructor(private readonly rollout: ReviewInvestigationRolloutGuard) {}

  async resolveSource(
    investigation: Parameters<
      ReviewInvestigationTerminalTelemetrySourcePort["resolveSource"]
    >[0],
  ): Promise<InvestigationTelemetrySource> {
    const provider = terminalTelemetryRolloutProvider(
      investigation.certificate?.terminalProviderKind ?? null,
    );
    if (provider === null) return InvestigationTelemetrySource.Shadow;
    try {
      await this.rollout.assertAllowed({
        capability: InvestigationRolloutCapability.ProductionEffects,
        target: {
          workspaceId: investigation.scope.workspaceId,
          repositoryConnectionId: investigation.scope.repositoryConnectionId,
          scmRepositoryIdentityId: investigation.scope.scmRepositoryIdentityId,
          provider,
          trustDomain: investigation.scope.trustDomain,
          producerReleaseId: investigation.contract.producerReleaseId,
        },
      });
      return InvestigationTelemetrySource.Allowlisted;
    } catch {
      return InvestigationTelemetrySource.Shadow;
    }
  }
}

function terminalTelemetryRolloutProvider(
  provider: InvestigationTurnProviderKind | null,
): InvestigationRolloutProvider | null {
  switch (provider) {
    case InvestigationTurnProviderKind.Codex:
      return InvestigationRolloutProvider.Codex;
    case InvestigationTurnProviderKind.ClaudeCode:
      return InvestigationRolloutProvider.Claude;
    case null:
      return null;
  }
}

function investigationAuthorizationProvider(
  provider: ReviewProviderKind,
): Readonly<{
  rollout: InvestigationRolloutProvider;
  authorization: "codex" | "claude_code";
}> | null {
  switch (provider) {
    case ReviewProviderKind.Codex:
      return {
        rollout: InvestigationRolloutProvider.Codex,
        authorization: "codex",
      };
    case ReviewProviderKind.ClaudeCode:
      return {
        rollout: InvestigationRolloutProvider.Claude,
        authorization: "claude_code",
      };
    case ReviewProviderKind.OpenRouter:
      return null;
  }
}

export function readInvestigationRolloutPolicy(
  env: Readonly<Record<string, string | undefined>>,
): InvestigationRolloutPolicy {
  return readEnvironmentInvestigationRolloutPolicy(env);
}

function investigationCapabilityEnabled(
  policy: InvestigationRolloutPolicy,
  capability: InvestigationRolloutCapability,
): boolean {
  return (
    !policy.emergencyDisabled && policy.enabledCapabilities.has(capability)
  );
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

type ProducerReleaseManagement = ReturnType<
  typeof composeReviewRunControl
>["producerReleases"];

export function createTrustedProducerReleaseMaterializer(input: {
  readonly digest: ProductionReviewActionV2Digest;
  readonly producerReleases: ProducerReleaseManagement;
  readonly releaseQueries: ProducerReleaseQueryPort;
  readonly protocolLimitsQueries: ReviewProtocolLimitsProfileQueryPort;
  readonly operationalSloQueries: ReviewOperationalSloProfileQueryPort;
}): TrustedProducerReleaseMaterializerPort {
  return {
    async ensureRegistered(release: ProducerRelease): Promise<void> {
      const existing = await input.releaseQueries.findProducerReleaseById(
        release.producerReleaseId,
      );
      if (
        existing?.state === ProducerReleaseState.Registered &&
        producerReleaseImmutableKey(existing) ===
          producerReleaseImmutableKey(release)
      ) {
        return;
      }
      const sloProfile = {
        thresholds: trustedProducerReleaseMaterializationThresholds,
        ownerRefs: trustedProducerReleaseMaterializationOwnerRefs,
        runbookRefs: trustedProducerReleaseMaterializationRunbookRefs,
      } as const;
      const [existingLimits, existingSlo] = await Promise.all([
        input.protocolLimitsQueries.findProtocolLimitsProfileById(
          release.protocolLimitsProfileId,
        ),
        input.operationalSloQueries.findOperationalSloProfileById(
          release.operationalSloProfileId,
        ),
      ]);
      const limitsDigest =
        existingLimits?.limitsDigest ??
        (await input.digest.digestUtf8(
          canonicalReviewProtocolLimits(
            trustedProducerReleaseMaterializationLimits,
          ),
        ));
      const sloDigest =
        existingSlo?.sloDigest ??
        (await input.digest.digestUtf8(
          canonicalReviewOperationalSloProfile(sloProfile),
        ));
      if (!existingLimits) {
        assertTrustedMaterializationResult(
          await input.producerReleases.registerProtocolLimitsProfile({
            protocolLimitsProfileId: release.protocolLimitsProfileId,
            limitsDigest,
            limits: trustedProducerReleaseMaterializationLimits,
          }),
          "trusted_producer_release_limits_conflict",
        );
      }
      if (!existingSlo) {
        assertTrustedMaterializationResult(
          await input.producerReleases.registerOperationalSloProfile({
            operationalSloProfileId: release.operationalSloProfileId,
            sloDigest,
            ...sloProfile,
          }),
          "trusted_producer_release_slo_conflict",
        );
      }
      assertTrustedMaterializationResult(
        await input.producerReleases.registerProducerRelease({
          candidate: {
            producerReleaseId: release.producerReleaseId,
            distributionKind: release.distributionKind,
            actionCommitSha: release.actionCommitSha,
            runtimeCommitSha: release.runtimeCommitSha,
            wrapperEntrypointDigest: release.wrapperEntrypointDigest,
            runtimeEntrypointDigest: release.runtimeEntrypointDigest,
            contextGatewayPolicyVersion: release.contextGatewayPolicyVersion,
            contextGatewayEntrypointDigest:
              release.contextGatewayEntrypointDigest,
            schemaDigest: release.schemaDigest,
            capabilityProfile: release.capabilityProfile,
            protocolLimitsProfileId: release.protocolLimitsProfileId,
            operationalSloProfileId: release.operationalSloProfileId,
            reviewInvestigationProfile: release.reviewInvestigationProfile,
          },
          expectedProtocolLimitsDigest: limitsDigest,
          expectedOperationalSloDigest: sloDigest,
        }),
        "trusted_producer_release_conflict",
      );
    },
  };
}

function assertTrustedMaterializationResult(
  result: { readonly status: ImmutableRegistryWriteStatus },
  issue: string,
): void {
  if (result.status === ImmutableRegistryWriteStatus.Conflict) {
    throw new Error(issue);
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
      safety: ReviewSafetyDecisionResolverPort;
      releases: ProducerReleaseQueryPort;
      digest: ProductionReviewActionV2Digest;
      investigationRollout: ReviewInvestigationFinalizationRolloutGuardPort;
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
      ["authoritativeObservationIds"],
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
    const projectionPolicyVersion =
      resolveReviewActionV2ProjectionPolicyVersion(
        envelope.projectionPolicyVersion,
      );
    if (
      input.projectionEnvelopeVersion !== 1 ||
      envelope.envelopeVersion !== "review_projection.v1" ||
      projectionPolicyVersion === null ||
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
    await this.dependencies.investigationRollout.assertAllowed({
      authorization: input.authorization,
      observationRefs: input.observationRefs,
      projectionEnvelope: input.projectionEnvelope,
    });
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
      projectionPolicyVersion,
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
  return readCapabilityKeyRingFromEnv(
    env,
    reviewActionV2CapabilityActiveKeyIdEnv,
    reviewActionV2CapabilityKeysEnv,
    "review_action_v2_capability",
  );
}

function createInvestigationLeaseCapabilityAdapter(
  env: Readonly<Record<string, string | undefined>>,
): ReviewActionV2InvestigationLeaseCapabilityAdapter {
  const keyRing = readCapabilityKeyRingFromEnv(
    env,
    reviewInvestigationLeaseCapabilityActiveKeyIdEnv,
    reviewInvestigationLeaseCapabilityKeysEnv,
    "review_investigation_lease_capability",
  );
  return new ReviewActionV2InvestigationLeaseCapabilityAdapter(
    new JoseRotatingCapabilityCodec(keyRing),
    keyRing,
    "reviewrouter-review-investigation-shadow-lease-v1",
    randomUUID,
  );
}

function readCapabilityKeyRingFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  activeKeyIdEnv: string,
  keysEnv: string,
  errorPrefix: string,
): ConfiguredCapabilityKeyRing {
  const activeKeyId = requiredEnv(env, activeKeyIdEnv);
  const values = parseJsonArray(
    requiredEnv(env, keysEnv),
    `${errorPrefix}_keys_invalid`,
  );
  if (values.length === 0 || values.length > 10) {
    throw new Error(`${errorPrefix}_keys_invalid`);
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
  requiredKeys: readonly string[],
  issue: string,
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw finalizationFailure(issue);
  }
  const row = value as Record<string, unknown>;
  const actualKeys = Object.keys(row);
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.hasOwn(row, key)) ||
    actualKeys.some((key) => !allowedKeys.has(key))
  ) {
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

const trustedProducerReleaseMaterializationLimits: ReviewProtocolLimits =
  Object.freeze({
    maxWorkSlots: 200,
    maxAttemptsPerSlot: 4,
    maxObservationBytes: 1_000_000,
    maxObservationFindings: 1_000,
    maxProjectionBytes: 2_000_000,
    maxProjectionFindings: 2_000,
    maxPublicationOperations: 500,
    maxPublicationChunks: 500,
    maxPublicationBodyBytes: 2_000_000,
    maxRequestBatchSize: 100,
    maxLeaseDurationMs: 600_000,
    maxResultReportDurationMs: 1_200_000,
    maxReconciliationDurationMs: 3_600_000,
  });

const trustedProducerReleaseMaterializationThresholds: ReviewOperationalSloThresholds =
  Object.freeze({
    integrationEventDeliveryMs: 60_000,
    outboxClaimAgeMs: 120_000,
    missingCompletionProcessMs: 300_000,
    dueCompletionProcessMs: 300_000,
    publicationReconciliationMs: 600_000,
    v1DrainMs: 3_600_000,
    admissionMs: 30_000,
    pruningBacklogAgeMs: 86_400_000,
  });

const trustedProducerReleaseMaterializationOwnerRefs = [
  "team-reviewrouter",
] as const;
const trustedProducerReleaseMaterializationRunbookRefs = [
  "docs/operations/review-action-v2-cutover.md",
] as const;

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
