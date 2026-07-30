import { createHash, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { registerApiDemoRoutes } from "@reviewrouter/features-api-demo";
import { PrismaAuditLogRepository } from "@reviewrouter/features-audit-log";
import {
  JoseActionSessionTokenService,
  JoseActionConflictReviewPostingSessionTokenService,
  JoseGitHubActionsOidcTokenVerifier,
  HmacActionLedgerKey,
  PrismaActionControlPlaneRepository,
  PrismaActionOidcReplayNonceStore,
  PrismaCodexRotatingOAuthRepository,
  registerActionControlPlaneRoutes,
  StaticActionRuntimeCompatibilityPolicy,
  type RegisterActionControlPlaneRoutesDependencies,
} from "@reviewrouter/features-action-control-plane";
import {
  registerReviewContextAttestationV2Routes,
  registerReviewEvidenceV2Routes,
  registerReviewExecutionV2Routes,
  registerReviewPublicationRequestV2Routes,
  registerReviewRunControlV2Routes,
  registerReviewSnapshotReadV2Routes,
  type RegisterReviewContextAttestationV2RoutesDependencies,
  type RegisterReviewEvidenceV2RoutesDependencies,
  type RegisterReviewExecutionV2RoutesDependencies,
  type RegisterReviewPublicationRequestV2RoutesDependencies,
  type RegisterReviewRunControlV2RoutesDependencies,
  type RegisterReviewSnapshotReadV2RoutesDependencies,
} from "@reviewrouter/features-action-control-plane/v2";
import {
  ConflictReviewPullRequestWebhookHandler,
  ConflictReviewPushWebhookHandler,
  PrismaConflictReviewRepository,
} from "@reviewrouter/features-conflict-review";
import {
  OutboxInstallationSyncRequester,
  PrismaGitHubInstallationRepository,
  PrismaInstallationWorkspaceOwnerGrant,
  PrismaWebhookDeliveryRepository,
  registerGitHubWebhookRoutes,
  type RegisterGitHubWebhookRoutesDependencies,
} from "@reviewrouter/features-github-installations";
import {
  GitLabInstallationGateway,
  GitLabMergeRequestGateway,
  JoseGitLabActionSessionTokenService,
  JoseGitLabCiIdTokenVerifier,
  registerGitLabIntegrationRoutes,
  StaticGitLabRepositoryRegistry,
  type GitLabRepositoryContext,
  type RegisterGitLabIntegrationRoutesDependencies,
} from "@reviewrouter/features-gitlab-integration";
import { PrismaOutboxEventRepository } from "@reviewrouter/features-outbox";
import {
  registerSystemHealthRoutes,
  type HealthDependencyPort,
} from "@reviewrouter/features-system-health";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import {
  CryptoMemoryIdGenerator,
  EntitlementMemoryPolicyConfig,
  EntitlementMemoryQuotaPolicy,
  PrismaMemoryItemRepository,
  PrismaMemoryPermission,
  PrismaMemorySearchIndex,
  PrismaMemorySuggestionRepository,
  PrismaMemoryTransaction,
  PrismaMemoryUsageEventRepository,
  readMemoryServiceEnabled,
} from "@reviewrouter/features-memory";
import { PrismaEntitlementRepository } from "@reviewrouter/features-entitlements";
import {
  isConflictReviewFallbackAllowedForRepository,
  isConflictReviewFallbackEnabled,
  isCodexRotatingOAuthAllowedForRepository,
  readGitHubAppPrivateKey,
  resolveReviewRouterActionRef,
  resolveReviewRouterPublicApiUrl,
  resolveReviewRouterTrustedActionRefs,
} from "@reviewrouter/platform-config";
import { PrismaRateLimitStore } from "@reviewrouter/features-rate-limits";
import {
  HashedReviewConfigurationOperatorAuthorization,
  PrismaReviewConfigurationOperatorRepository,
  PrismaReviewConfigurationRepository,
  type OperatorReviewConfigurationDependencies,
} from "@reviewrouter/features-review-config";
import { PrismaReviewSnapshotRepository } from "@reviewrouter/features-review-snapshots";
import { PrismaReviewExecutionCheckpointRepository } from "@reviewrouter/features-review-execution-checkpoints";
import { PrismaReviewRequestedIntentStore } from "@reviewrouter/features-review-executions/composition";
import { ConsoleLogger } from "@reviewrouter/platform-logger";
import { SystemClock } from "@reviewrouter/shared";
import { AdmitLegacyReviewMutation } from "@reviewrouter/features-review-run-control";
import { createPrismaReviewRunControlRepositories } from "@reviewrouter/features-review-run-control/composition";
import { PrismaActionEntitlementPolicy } from "./action-entitlement-policy.js";
import { ActionRateLimitPolicy } from "./action-rate-limit-policy.js";
import { ReviewRunControlLegacyMutationAdmission } from "./review-action-v1-mutation-admission.js";
import {
  CompositePullRequestWebhookHandler,
  CompositePushWebhookHandler,
} from "./github/composite-github-webhook-handlers.js";
import { OctokitConflictReviewPostingGateway } from "./github/octokit-conflict-review-posting-gateway.js";
import { OctokitCodexRotatingGitHubSecretGateway } from "./github/octokit-codex-rotating-github-secret-gateway.js";
import { OctokitGitHubAppCommentTokenIssuer } from "./github/octokit-github-app-comment-token-issuer.js";
import { PrismaGitHubUserReviewThreadResolver } from "./github/prisma-github-user-review-thread-resolver.js";
import { PrismaGitHubAppAuthorizationWebhookHandler } from "./github/prisma-github-app-authorization-webhook-handler.js";
import { PrismaRepositoryWebhookHandler } from "./github/prisma-repository-webhook-handler.js";
import { PrismaSetupPullRequestMergeHandler } from "./github/prisma-setup-pull-request-merge-handler.js";
import { ReviewV2PullRequestWebhookHandler } from "./github/review-v2-pull-request-webhook-handler.js";
import { ReviewV2GitHubRequestIngressOutbox } from "./review-v2-github-request-ingress-outbox.js";
import { ReviewV2RequestIngressOutbox } from "./review-v2-request-ingress-outbox.js";
import { FallbackGitLabRepositoryRegistry } from "./gitlab/fallback-gitlab-repository-registry.js";
import { PrismaGitLabRepositoryRegistry } from "./gitlab/prisma-gitlab-repository-registry.js";
import { PrismaHealthDependency } from "./prisma-health-dependency.js";
import {
  registerActionMemoryRoutes,
  type RegisterActionMemoryRoutesDependencies,
} from "./action-memory-routes.js";
import { registerReviewV2RequestCommandRoutes } from "./review-v2-request-command-routes.js";
import { registerOperatorReviewConfigRoutes } from "./operator-review-config-routes.js";
import { ReviewConfigurationOperatorAudit } from "./review-configuration-operator-audit.js";
import { ReviewConfigurationOperatorRateLimit } from "./review-configuration-operator-rate-limit.js";
import {
  composeReviewActionV2RunControlRoutes,
  type ReviewActionV2RunControlHandlerDependencies,
} from "./review-action-v2-run-control-composition.js";
import {
  assertReviewIntentRolloutConfiguration,
  composeReviewActionV2ProductionRoutes,
} from "./review-action-v2-production-composition.js";
import { appRouter } from "./trpc.js";
import { ProductionHostedReviewPreleaseGate } from "./hosted-review-prelease-gate.js";

export type CreateApiAppOptions = {
  readonly githubWebhookSecret?: string;
  readonly githubWebhookDependencies?: RegisterGitHubWebhookRoutesDependencies;
  readonly gitLabIntegrationDependencies?: RegisterGitLabIntegrationRoutesDependencies;
  readonly actionControlPlaneDependencies?: RegisterActionControlPlaneRoutesDependencies;
  readonly reviewRunControlV2Dependencies?: RegisterReviewRunControlV2RoutesDependencies;
  readonly reviewRunControlV2HandlerDependencies?: ReviewActionV2RunControlHandlerDependencies;
  readonly reviewRunControlV2Enabled?: boolean;
  readonly reviewActionV2Env?: Readonly<Record<string, string | undefined>>;
  readonly reviewExecutionV2Dependencies?: RegisterReviewExecutionV2RoutesDependencies;
  readonly reviewContextAttestationV2Dependencies?: RegisterReviewContextAttestationV2RoutesDependencies;
  readonly reviewEvidenceV2Dependencies?: RegisterReviewEvidenceV2RoutesDependencies;
  readonly reviewSnapshotReadV2Dependencies?: RegisterReviewSnapshotReadV2RoutesDependencies;
  readonly reviewPublicationRequestV2Dependencies?: RegisterReviewPublicationRequestV2RoutesDependencies;
  readonly actionMemoryDependencies?: RegisterActionMemoryRoutesDependencies;
  readonly operatorReviewConfigDependencies?: OperatorReviewConfigurationDependencies;
  readonly actionSessionSecret?: string;
  readonly actionOidcAudience?: string;
  readonly actionControlPlaneEnabled?: boolean;
  readonly memoryServiceEnabled?: boolean;
  readonly healthDependencies?: readonly HealthDependencyPort[];
  readonly prisma?: PrismaClient;
};

export async function createApiApp(
  options: CreateApiAppOptions = {},
): Promise<FastifyInstance> {
  const logger = new ConsoleLogger();
  const app = Fastify({ logger: false });
  const reviewActionV2Env = options.reviewActionV2Env ?? process.env;
  const operatorCredentialSha256 =
    readOperatorCredentialSha256(reviewActionV2Env);
  const reviewRunControlV2Enabled =
    options.reviewRunControlV2Enabled ??
    reviewActionV2Env.REVIEW_ROUTER_REVIEW_V2_RUN_CONTROL_ENABLED === "1";
  const prisma =
    options.prisma ??
    (options.githubWebhookSecret ||
    options.actionSessionSecret ||
    reviewRunControlV2Enabled ||
    operatorCredentialSha256
      ? createPrismaClient()
      : undefined);
  const clock = new SystemClock();

  app.addHook("onSend", async (request, reply, payload) => {
    if (isPublicDemoPath(request.url)) {
      reply
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .header("X-ReviewRouter-Demo", "true");
    }
    return payload;
  });

  registerApiDemoRoutes(app, {
    clock,
    ...definedOption("webUrl", process.env.REVIEW_ROUTER_WEB_URL),
    ...definedOption(
      "apiUrl",
      process.env.REVIEW_ROUTER_PUBLIC_API_URL ??
        process.env.REVIEW_ROUTER_API_URL,
    ),
    ...definedOption(
      "actionVersion",
      process.env.REVIEW_ROUTER_ACTION_REF ??
        process.env.REVIEW_ROUTER_ACTION_VERSION,
    ),
    ...definedOption("model", process.env.REVIEW_ROUTER_DEFAULT_MODEL),
    ...definedOption("effort", process.env.REVIEW_ROUTER_DEFAULT_EFFORT),
  });

  registerSystemHealthRoutes(
    app,
    clock,
    options.healthDependencies ??
      (prisma ? [new PrismaHealthDependency(prisma)] : []),
  );

  const operatorReviewConfigDependencies =
    options.operatorReviewConfigDependencies ??
    (prisma && operatorCredentialSha256
      ? {
          authorization: new HashedReviewConfigurationOperatorAuthorization(
            "reviewrouter-operator",
            operatorCredentialSha256,
          ),
          repositories: new PrismaReviewConfigurationOperatorRepository(prisma),
          configurations: new PrismaReviewConfigurationRepository(prisma),
          rateLimits: new ReviewConfigurationOperatorRateLimit(
            new PrismaRateLimitStore(prisma),
            clock,
          ),
          audit: new ReviewConfigurationOperatorAudit(
            new PrismaAuditLogRepository(prisma),
          ),
        }
      : undefined);
  if (operatorReviewConfigDependencies) {
    await registerOperatorReviewConfigRoutes(
      app,
      operatorReviewConfigDependencies,
    );
  }

  const githubWebhookDependencies =
    options.githubWebhookDependencies ??
    (options.githubWebhookSecret && prisma
      ? createDefaultGitHubWebhookDependencies({
          webhookSecret: options.githubWebhookSecret,
          prisma,
          env: reviewActionV2Env,
        })
      : undefined);

  if (githubWebhookDependencies) {
    await registerGitHubWebhookRoutes(app, githubWebhookDependencies);
  }

  const gitLabIntegrationDependencies =
    options.gitLabIntegrationDependencies ??
    createDefaultGitLabIntegrationDependencies({
      actionSessionSecret: options.actionSessionSecret,
      clock,
      env: process.env,
      prisma,
    });

  if (gitLabIntegrationDependencies) {
    await registerGitLabIntegrationRoutes(app, gitLabIntegrationDependencies);
  }

  const actionControlPlaneDependencies =
    options.actionControlPlaneDependencies ??
    (options.actionSessionSecret && prisma
      ? (() => {
          const clock = new SystemClock();
          const githubAppPrivateKey = readGitHubAppPrivateKey();
          const conflictReviewFallbackEnabled =
            isConflictReviewFallbackEnabled();
          const conflictPostingGatewayEnabled = Boolean(
            conflictReviewFallbackEnabled &&
            process.env.GITHUB_APP_ID &&
            githubAppPrivateKey &&
            process.env.GITHUB_APP_SLUG,
          );
          const conflictPostingGateway = conflictPostingGatewayEnabled
            ? new OctokitConflictReviewPostingGateway({
                appId: process.env.GITHUB_APP_ID,
                privateKey: githubAppPrivateKey ?? undefined,
                appSlug: process.env.GITHUB_APP_SLUG,
              })
            : undefined;
          const codexRotatingGitHubSecretGateway =
            process.env.GITHUB_APP_ID && githubAppPrivateKey
              ? new OctokitCodexRotatingGitHubSecretGateway({
                  appId: process.env.GITHUB_APP_ID,
                  privateKey: githubAppPrivateKey,
                  expectedApiUrl: resolveReviewRouterPublicApiUrl(),
                  trustedActionRefs: resolveReviewRouterTrustedActionRefs(),
                })
              : undefined;
          const codexRotatingOAuth = new PrismaCodexRotatingOAuthRepository(
            prisma,
            {
              actionRef: resolveReviewRouterActionRef(),
              allowedActionRefs: resolveReviewRouterTrustedActionRefs(),
              actionOwnerRepo: resolveActionOwnerRepo(
                process.env.REVIEW_ROUTER_ACTION_REF,
              ),
            },
          );
          const requestedIntentStore = new PrismaReviewRequestedIntentStore(
            prisma,
          );
          const ledgerSecret =
            process.env.REVIEW_ROUTER_LEDGER_HMAC_KEY ??
            options.actionSessionSecret;
          const reviewRunControlRepositories =
            createPrismaReviewRunControlRepositories(prisma);
          return {
            repositories: new PrismaActionControlPlaneRepository(prisma),
            defaultProvider: {
              model:
                process.env.REVIEW_ROUTER_DEFAULT_MODEL?.trim() || "gpt-5.5",
              reasoningEffort: readDefaultReasoningEffort(
                process.env.REVIEW_ROUTER_DEFAULT_EFFORT,
              ),
            },
            ...(conflictReviewFallbackEnabled
              ? {
                  conflictReviews: new PrismaConflictReviewRepository(prisma),
                }
              : {}),
            ...(conflictPostingGatewayEnabled
              ? {
                  conflictPostingSessions: new PrismaConflictReviewRepository(
                    prisma,
                  ),
                }
              : {}),
            conflictReviewRuntimeGate: {
              async assertConflictReviewRuntimeEnabled(input: {
                readonly repositoryFullName: string;
              }) {
                if (
                  !isConflictReviewFallbackAllowedForRepository(
                    input.repositoryFullName,
                  )
                ) {
                  throw new Error("conflict_review_runtime_disabled");
                }
              },
            },
            ...(conflictPostingGatewayEnabled
              ? { conflictReviewPostingAvailable: true }
              : {}),
            entitlements: new PrismaActionEntitlementPolicy(prisma),
            rateLimits: new ActionRateLimitPolicy(
              new PrismaRateLimitStore(prisma),
              clock,
            ),
            replayNonces: new PrismaActionOidcReplayNonceStore(prisma),
            legacyMutationAdmission:
              new ReviewRunControlLegacyMutationAdmission({
                repositoryIdentities:
                  reviewRunControlRepositories.repositoryIdentities,
                legacyAuthorityAdmission: new AdmitLegacyReviewMutation({
                  clock,
                  queries: reviewRunControlRepositories.mutationAuthorities,
                  commands: reviewRunControlRepositories.mutationAuthorities,
                }),
                ...(codexRotatingGitHubSecretGateway
                  ? {
                      workflowSourceVerifier: codexRotatingGitHubSecretGateway,
                    }
                  : {}),
              }),
            codexRotatingOAuth,
            codexRotatingReviewSnapshotAccess: codexRotatingOAuth,
            reviewSnapshots: new PrismaReviewSnapshotRepository(prisma),
            codexRotatingReviewExecutionCheckpointAccess: codexRotatingOAuth,
            reviewExecutionCheckpoints:
              new PrismaReviewExecutionCheckpointRepository(prisma),
            codexRotatingRuntimeGate: {
              assertCodexRotatingOAuthEnabled(input: {
                readonly repositoryFullName: string;
              }) {
                if (
                  !isCodexRotatingOAuthAllowedForRepository(
                    input.repositoryFullName,
                  )
                ) {
                  throw new Error("codex_rotating_not_enabled");
                }
              },
            },
            ...(codexRotatingGitHubSecretGateway
              ? {
                  codexRotatingSecretsReadTokens:
                    codexRotatingGitHubSecretGateway,
                  codexRotatingSecretWriter: codexRotatingGitHubSecretGateway,
                  codexRotatingCheckoutTokens: codexRotatingGitHubSecretGateway,
                  codexRotatingWorkflowSourceVerifier:
                    codexRotatingGitHubSecretGateway,
                  reviewIntentAdmissionRequired:
                    process.env
                      .REVIEW_ROUTER_REVIEW_V2_INTENT_ADMISSION_REQUIRED !==
                    "0",
                  hostedReviewPreleaseGate:
                    new ProductionHostedReviewPreleaseGate({
                      requestedIntentQueries: requestedIntentStore,
                      requestedIntentCommands: requestedIntentStore,
                      pullRequests: codexRotatingGitHubSecretGateway,
                      clock,
                      maxChangedLines: readPositiveInteger(
                        process.env.REVIEW_ROUTER_HOSTED_MAX_CHANGED_LINES,
                        250_000,
                        "hosted_review_max_changed_lines_invalid",
                      ),
                    }),
                }
              : {}),
            compatibility: new StaticActionRuntimeCompatibilityPolicy({
              blockedActionVersions: parseCommaSeparatedEnv(
                process.env.REVIEW_ROUTER_BLOCKED_ACTION_VERSIONS,
              ),
            }),
            sessions: new JoseActionSessionTokenService(
              options.actionSessionSecret,
            ),
            ...(conflictPostingGatewayEnabled
              ? {
                  postingSessions:
                    new JoseActionConflictReviewPostingSessionTokenService(
                      options.actionSessionSecret,
                    ),
                }
              : {}),
            ledgerKeys: new HmacActionLedgerKey(ledgerSecret),
            codexRotatingWritebackHmacKey: ledgerSecret,
            reviewThreadLifecycleResolver:
              new PrismaGitHubUserReviewThreadResolver(prisma),
            ...(process.env.GITHUB_APP_ID && githubAppPrivateKey
              ? {
                  commentTokens: new OctokitGitHubAppCommentTokenIssuer({
                    appId: process.env.GITHUB_APP_ID,
                    privateKey: githubAppPrivateKey,
                  }),
                  ...(conflictPostingGateway
                    ? {
                        conflictPostingGateway,
                        conflictPrePostValidator: conflictPostingGateway,
                      }
                    : {}),
                }
              : {}),
            oidcVerifier: new JoseGitHubActionsOidcTokenVerifier(),
            clock,
            ...(options.actionOidcAudience
              ? { oidcAudience: options.actionOidcAudience }
              : {}),
            ...(options.actionControlPlaneEnabled === false
              ? { controlPlaneEnabled: false }
              : {}),
          };
        })()
      : undefined);

  if (actionControlPlaneDependencies) {
    await registerActionControlPlaneRoutes(app, actionControlPlaneDependencies);
  }

  const disabledReviewActionV2RuntimeDependencies = prisma
    ? {
        readServerTime: () => readDatabaseServerTime(prisma),
        createRequestId: randomUUID,
        recordProtocolRejection: (diagnostic: {
          readonly operationId: string;
          readonly protocolErrorCode: string;
          readonly protocolIssues: readonly string[];
          readonly requestId: string;
          readonly statusCode: number;
        }) => logger.warn("Review Action v2 request rejected", diagnostic),
      }
    : undefined;
  if (
    reviewRunControlV2Enabled &&
    !options.reviewRunControlV2Dependencies &&
    !disabledReviewActionV2RuntimeDependencies
  ) {
    throw new Error("review_action_v2_run_control_dependencies_unavailable");
  }
  const productionReviewActionV2Dependencies =
    reviewRunControlV2Enabled &&
    !options.reviewRunControlV2Dependencies &&
    !options.reviewRunControlV2HandlerDependencies &&
    !options.reviewExecutionV2Dependencies &&
    !options.reviewContextAttestationV2Dependencies &&
    !options.reviewEvidenceV2Dependencies &&
    !options.reviewSnapshotReadV2Dependencies &&
    !options.reviewPublicationRequestV2Dependencies &&
    disabledReviewActionV2RuntimeDependencies
      ? composeReviewActionV2ProductionRoutes({
          enabled: true,
          env: reviewActionV2Env,
          runtime: disabledReviewActionV2RuntimeDependencies,
          ...(prisma ? { prisma } : {}),
          ...(options.actionOidcAudience
            ? { oidcAudience: options.actionOidcAudience }
            : {}),
        })
      : undefined;
  const reviewRunControlV2Dependencies =
    options.reviewRunControlV2Dependencies ??
    productionReviewActionV2Dependencies?.runControl ??
    (disabledReviewActionV2RuntimeDependencies
      ? composeReviewActionV2RunControlRoutes({
          enabled: reviewRunControlV2Enabled,
          runtime: disabledReviewActionV2RuntimeDependencies,
          ...(options.reviewRunControlV2HandlerDependencies
            ? { handlers: options.reviewRunControlV2HandlerDependencies }
            : {}),
        })
      : undefined);

  if (reviewRunControlV2Dependencies) {
    await registerReviewRunControlV2Routes(app, reviewRunControlV2Dependencies);
  }
  const reviewExecutionV2Dependencies =
    options.reviewExecutionV2Dependencies ??
    productionReviewActionV2Dependencies?.execution ??
    disabledReviewActionV2RuntimeDependencies;
  if (reviewExecutionV2Dependencies) {
    await registerReviewExecutionV2Routes(app, reviewExecutionV2Dependencies);
  }
  const reviewContextAttestationV2Dependencies =
    options.reviewContextAttestationV2Dependencies ??
    productionReviewActionV2Dependencies?.contextAttestation ??
    disabledReviewActionV2RuntimeDependencies;
  if (reviewContextAttestationV2Dependencies) {
    await registerReviewContextAttestationV2Routes(
      app,
      reviewContextAttestationV2Dependencies,
    );
  }
  const reviewEvidenceV2Dependencies =
    options.reviewEvidenceV2Dependencies ??
    productionReviewActionV2Dependencies?.evidence ??
    disabledReviewActionV2RuntimeDependencies;
  if (reviewEvidenceV2Dependencies) {
    await registerReviewEvidenceV2Routes(app, reviewEvidenceV2Dependencies);
  }
  const reviewSnapshotReadV2Dependencies =
    options.reviewSnapshotReadV2Dependencies ??
    productionReviewActionV2Dependencies?.snapshot ??
    disabledReviewActionV2RuntimeDependencies;
  if (reviewSnapshotReadV2Dependencies) {
    await registerReviewSnapshotReadV2Routes(
      app,
      reviewSnapshotReadV2Dependencies,
    );
  }
  const reviewPublicationRequestV2Dependencies =
    options.reviewPublicationRequestV2Dependencies ??
    productionReviewActionV2Dependencies?.publication ??
    disabledReviewActionV2RuntimeDependencies;
  if (reviewPublicationRequestV2Dependencies) {
    await registerReviewPublicationRequestV2Routes(
      app,
      reviewPublicationRequestV2Dependencies,
    );
  }

  const actionMemoryDependencies =
    options.actionMemoryDependencies ??
    (actionControlPlaneDependencies && prisma
      ? {
          repositories: actionControlPlaneDependencies.repositories,
          sessions: actionControlPlaneDependencies.sessions,
          memory: {
            memoryItems: new PrismaMemoryItemRepository(prisma),
            memorySuggestions: new PrismaMemorySuggestionRepository(prisma),
            memoryPermissions: new PrismaMemoryPermission(prisma, {
              localAdminGithubLogins: parseCommaSeparatedEnv(
                process.env.REVIEW_ROUTER_LOCAL_ADMIN_GITHUB_LOGINS,
              ),
            }),
            memoryPolicyConfig: new EntitlementMemoryPolicyConfig(
              new PrismaEntitlementRepository(prisma),
              {
                serviceEnabled:
                  options.memoryServiceEnabled ??
                  readMemoryServiceEnabled(process.env),
              },
            ),
            memoryUsageEvents: new PrismaMemoryUsageEventRepository(prisma),
            memoryQuotaPolicy: new EntitlementMemoryQuotaPolicy(
              new PrismaEntitlementRepository(prisma),
            ),
            memoryIds: new CryptoMemoryIdGenerator(),
            memoryTransaction: new PrismaMemoryTransaction(prisma),
            clock: actionControlPlaneDependencies.clock,
          },
          memorySearchIndex: new PrismaMemorySearchIndex(prisma),
          ...(actionControlPlaneDependencies.entitlements
            ? { entitlements: actionControlPlaneDependencies.entitlements }
            : {}),
          clock: actionControlPlaneDependencies.clock,
          ...(options.actionControlPlaneEnabled === false
            ? { controlPlaneEnabled: false }
            : {}),
        }
      : undefined);

  if (actionMemoryDependencies) {
    await registerActionMemoryRoutes(app, actionMemoryDependencies);
  }

  if (actionControlPlaneDependencies && prisma) {
    const ingressEnabled =
      reviewActionV2Env.REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED === "1";
    const repositories = createPrismaReviewRunControlRepositories(prisma);
    await registerReviewV2RequestCommandRoutes(app, {
      repositories: actionControlPlaneDependencies.repositories,
      repositoryIdentities: repositories.repositoryIdentities,
      sessions: actionControlPlaneDependencies.sessions,
      ingress: new ReviewV2RequestIngressOutbox(
        new PrismaOutboxEventRepository(prisma),
        {
          async digestUtf8(value) {
            return createHash("sha256").update(value, "utf8").digest("hex");
          },
        },
      ),
      ...(actionControlPlaneDependencies.entitlements
        ? { entitlements: actionControlPlaneDependencies.entitlements }
        : {}),
      clock: actionControlPlaneDependencies.clock,
      retentionMs: readPositiveInteger(
        reviewActionV2Env.REVIEW_ROUTER_REVIEW_V2_INTENT_RETENTION_MS,
        30 * 24 * 60 * 60 * 1_000,
        "review_v2_intent_retention_invalid",
      ),
      enabled: ingressEnabled,
    });
  }

  app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: { router: appRouter },
  });

  app.addHook("onError", async (_request, _reply, error) => {
    logger.error("API request failed", { message: error.message });
  });

  if (prisma && options.prisma === undefined) {
    app.addHook("onClose", async () => {
      await prisma.$disconnect();
    });
  }

  return app;
}

function createDefaultGitHubWebhookDependencies(input: {
  readonly webhookSecret: string;
  readonly prisma: PrismaClient;
  readonly env: Readonly<Record<string, string | undefined>>;
}): RegisterGitHubWebhookRoutesDependencies {
  const conflictReviewFallbackEnabled = isConflictReviewFallbackEnabled();
  const conflictReviewRolloutPolicy = {
    isConflictReviewFallbackAllowed(input: {
      readonly repositoryFullName: string;
    }) {
      return isConflictReviewFallbackAllowedForRepository(
        input.repositoryFullName,
      );
    },
  };
  const outbox = new PrismaOutboxEventRepository(input.prisma);
  const reviewV2IntentHandler = createReviewV2IntentWebhookHandler(input);
  return {
    webhookSecret: input.webhookSecret,
    installations: new PrismaGitHubInstallationRepository(input.prisma),
    ownerGrants: new PrismaInstallationWorkspaceOwnerGrant(input.prisma),
    deliveries: new PrismaWebhookDeliveryRepository(input.prisma),
    syncRequests: new OutboxInstallationSyncRequester(outbox),
    appAuthorizations: new PrismaGitHubAppAuthorizationWebhookHandler(
      input.prisma,
    ),
    ...(reviewV2IntentHandler
      ? { preAdmissionPullRequests: reviewV2IntentHandler }
      : {}),
    pullRequests: new CompositePullRequestWebhookHandler([
      new PrismaSetupPullRequestMergeHandler(input.prisma),
      ...(conflictReviewFallbackEnabled
        ? [
            new ConflictReviewPullRequestWebhookHandler({
              outbox,
              rolloutPolicy: conflictReviewRolloutPolicy,
              clock: new SystemClock(),
            }),
          ]
        : []),
    ]),
    ...(conflictReviewFallbackEnabled
      ? {
          pushes: new CompositePushWebhookHandler([
            new ConflictReviewPushWebhookHandler({
              outbox,
              rolloutPolicy: conflictReviewRolloutPolicy,
              clock: new SystemClock(),
            }),
          ]),
        }
      : {}),
    repositories: new PrismaRepositoryWebhookHandler(input.prisma),
    clock: new SystemClock(),
  };
}

function createReviewV2IntentWebhookHandler(input: {
  readonly prisma: PrismaClient;
  readonly env: Readonly<Record<string, string | undefined>>;
}): ReviewV2PullRequestWebhookHandler | null {
  if (input.env.REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED !== "1") {
    return null;
  }
  assertReviewIntentRolloutConfiguration(input.env);
  const ingress = new ReviewV2GitHubRequestIngressOutbox(
    new PrismaOutboxEventRepository(input.prisma),
    {
      async digestUtf8(value) {
        return createHash("sha256").update(value, "utf8").digest("hex");
      },
    },
  );
  const draftRepositories = new Set(
    parseCommaSeparatedEnv(
      input.env.REVIEW_ROUTER_REVIEW_V2_DRAFT_REPOSITORIES,
    ).map((value) => value.toLowerCase()),
  );
  return new ReviewV2PullRequestWebhookHandler({
    ingress,
    clock: new SystemClock(),
    policy: {
      reviewDrafts: (repositoryFullName) =>
        draftRepositories.has(repositoryFullName.toLowerCase()),
    },
  });
}

function definedOption<const Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | Record<string, never> {
  return value
    ? ({ [key]: value } as { readonly [Property in Key]: string })
    : {};
}

function readOperatorCredentialSha256(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value =
    env.REVIEW_ROUTER_REVIEW_CONFIG_OPERATOR_CREDENTIAL_SHA256?.trim();
  if (!value) return undefined;
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("review_router_operator_credential_hash_invalid");
  }
  return value;
}

function readDefaultReasoningEffort(
  value: string | undefined,
): "low" | "medium" | "high" | "xhigh" {
  const normalized = value?.trim() || "xhigh";
  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  throw new Error("review_router_default_effort_invalid");
}

async function readDatabaseServerTime(prisma: PrismaClient): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ serverTime: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "serverTime"
  `;
  const serverTime = rows[0]?.serverTime;
  if (!(serverTime instanceof Date) || !Number.isFinite(serverTime.getTime())) {
    throw new Error("review_action_v2_database_time_unavailable");
  }
  return serverTime;
}

function isPublicDemoPath(url: string): boolean {
  const path = url.split("?", 1)[0];
  return (
    path === "/" ||
    path === "/health" ||
    path === "/ready" ||
    path === "/demo" ||
    path === "/demo.md" ||
    path === "/docs" ||
    path === "/openapi.json"
  );
}

function parseCommaSeparatedEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  errorCode: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(errorCode);
  }
  return parsed;
}

function createDefaultGitLabIntegrationDependencies(input: {
  readonly actionSessionSecret?: string | undefined;
  readonly clock: SystemClock;
  readonly env: NodeJS.ProcessEnv;
  readonly prisma?: PrismaClient | undefined;
}): RegisterGitLabIntegrationRoutesDependencies | undefined {
  const repositories = readGitLabStaticRepositories(
    input.env.REVIEW_ROUTER_GITLAB_STATIC_REPOSITORIES_JSON,
  );
  const apiToken = input.env.REVIEW_ROUTER_GITLAB_API_TOKEN;
  const apiBaseUrl = input.env.REVIEW_ROUTER_GITLAB_API_BASE_URL;
  const installerToken = input.env.REVIEW_ROUTER_GITLAB_INSTALLER_TOKEN;
  const installerAdminToken =
    input.env.REVIEW_ROUTER_GITLAB_INSTALLER_ADMIN_TOKEN;
  const environmentStatus = {
    actionSessionSecretConfigured: Boolean(input.actionSessionSecret),
    installerAdminTokenConfigured: Boolean(installerAdminToken),
    installerTokenConfigured: Boolean(installerToken),
    apiTokenConfigured: Boolean(apiToken),
    staticRepositoriesConfigured:
      repositories.length > 0 || Boolean(input.prisma),
    registeredRepositoryCount: input.prisma ? null : repositories.length,
    oidcAudienceConfigured: Boolean(
      input.env.REVIEW_ROUTER_GITLAB_OIDC_AUDIENCE,
    ),
    runtimeImageConfigured: Boolean(
      input.env.REVIEW_ROUTER_GITLAB_RUNTIME_IMAGE,
    ),
  };
  const staticRepositoryRegistry =
    repositories.length > 0
      ? new StaticGitLabRepositoryRegistry(repositories)
      : undefined;
  const prismaRepositoryRegistry = input.prisma
    ? new PrismaGitLabRepositoryRegistry(input.prisma)
    : undefined;
  const repositoryRegistry =
    prismaRepositoryRegistry && staticRepositoryRegistry
      ? new FallbackGitLabRepositoryRegistry([
          prismaRepositoryRegistry,
          staticRepositoryRegistry,
        ])
      : (prismaRepositoryRegistry ?? staticRepositoryRegistry);
  const exchange =
    input.actionSessionSecret && apiToken && repositoryRegistry
      ? {
          verifier: new JoseGitLabCiIdTokenVerifier({
            ...(input.env.REVIEW_ROUTER_GITLAB_OIDC_ISSUER
              ? { issuer: input.env.REVIEW_ROUTER_GITLAB_OIDC_ISSUER }
              : {}),
            ...(input.env.REVIEW_ROUTER_GITLAB_OIDC_JWKS_URL
              ? { jwksUrl: input.env.REVIEW_ROUTER_GITLAB_OIDC_JWKS_URL }
              : {}),
          }),
          repositories: repositoryRegistry,
          mergeRequests: new GitLabMergeRequestGateway({
            token: apiToken,
            ...(apiBaseUrl ? { apiBaseUrl } : {}),
          }),
          sessions: new JoseGitLabActionSessionTokenService(
            input.actionSessionSecret,
          ),
        }
      : undefined;
  const installation =
    installerToken && installerAdminToken
      ? new GitLabInstallationGateway({
          token: installerToken,
          ...(apiBaseUrl ? { apiBaseUrl } : {}),
        })
      : undefined;
  if (!exchange && !installation && !installerAdminToken) {
    return undefined;
  }

  return {
    clock: input.clock,
    environmentStatus,
    ...(exchange ? { exchange } : {}),
    ...(input.env.REVIEW_ROUTER_GITLAB_OIDC_AUDIENCE
      ? { defaultAudience: input.env.REVIEW_ROUTER_GITLAB_OIDC_AUDIENCE }
      : {}),
    ...(input.env.REVIEW_ROUTER_GITLAB_RUNTIME_IMAGE
      ? { defaultRuntimeImage: input.env.REVIEW_ROUTER_GITLAB_RUNTIME_IMAGE }
      : {}),
    ...(installation ? { installation } : {}),
    ...(installerAdminToken ? { installerAdminToken } : {}),
  };
}

function readGitLabStaticRepositories(
  raw: string | undefined,
): readonly GitLabRepositoryContext[] {
  if (!raw?.trim()) {
    return [];
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("gitlab_static_repositories_invalid");
  }
  return parsed.map((repository) => {
    if (!isRecord(repository)) {
      throw new Error("gitlab_static_repository_invalid");
    }
    return {
      workspaceId: readString(repository.workspaceId, "workspaceId"),
      repositoryId: readString(repository.repositoryId, "repositoryId"),
      gitlabProjectId: readNumericString(
        repository.gitlabProjectId,
        "gitlabProjectId",
      ),
      fullName: readString(repository.fullName, "fullName"),
      owner: readString(repository.owner, "owner"),
      selected: repository.selected !== false,
      installationStatus:
        typeof repository.installationStatus === "string"
          ? repository.installationStatus
          : "active",
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`gitlab_static_repository_${field}_invalid`);
  }
  return value.trim();
}

function readNumericString(value: unknown, field: string): string {
  const normalized = typeof value === "number" ? String(value) : value;
  const stringValue = readString(normalized, field);
  if (!/^[1-9][0-9]*$/.test(stringValue)) {
    throw new Error(`gitlab_static_repository_${field}_invalid`);
  }
  return stringValue;
}

function resolveActionOwnerRepo(actionRef: string | undefined): string {
  const normalized = actionRef?.trim() || "777genius/review-router";
  const ownerRepo = normalized.split("@", 1)[0] ?? normalized;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ownerRepo)) {
    return "777genius/review-router";
  }
  return ownerRepo;
}
