import Fastify, { type FastifyInstance } from "fastify";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { registerApiDemoRoutes } from "@reviewrouter/features-api-demo";
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
  resolveReviewRouterTrustedActionRefs,
} from "@reviewrouter/platform-config";
import { PrismaRateLimitStore } from "@reviewrouter/features-rate-limits";
import { ConsoleLogger } from "@reviewrouter/platform-logger";
import { SystemClock } from "@reviewrouter/shared";
import { PrismaActionEntitlementPolicy } from "./action-entitlement-policy.js";
import { ActionRateLimitPolicy } from "./action-rate-limit-policy.js";
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
import { PrismaHealthDependency } from "./prisma-health-dependency.js";
import {
  registerActionMemoryRoutes,
  type RegisterActionMemoryRoutesDependencies,
} from "./action-memory-routes.js";
import { appRouter } from "./trpc.js";

export type CreateApiAppOptions = {
  readonly githubWebhookSecret?: string;
  readonly githubWebhookDependencies?: RegisterGitHubWebhookRoutesDependencies;
  readonly actionControlPlaneDependencies?: RegisterActionControlPlaneRoutesDependencies;
  readonly actionMemoryDependencies?: RegisterActionMemoryRoutesDependencies;
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
  const prisma =
    options.prisma ??
    (options.githubWebhookSecret || options.actionSessionSecret
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

  const githubWebhookDependencies =
    options.githubWebhookDependencies ??
    (options.githubWebhookSecret && prisma
      ? createDefaultGitHubWebhookDependencies({
          webhookSecret: options.githubWebhookSecret,
          prisma,
        })
      : undefined);

  if (githubWebhookDependencies) {
    await registerGitHubWebhookRoutes(app, githubWebhookDependencies);
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
                })
              : undefined;
          const ledgerSecret =
            process.env.REVIEW_ROUTER_LEDGER_HMAC_KEY ??
            options.actionSessionSecret;
          return {
            repositories: new PrismaActionControlPlaneRepository(prisma),
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
            codexRotatingOAuth: new PrismaCodexRotatingOAuthRepository(prisma, {
              actionRef: resolveReviewRouterActionRef(),
              allowedActionRefs: resolveReviewRouterTrustedActionRefs(),
              actionOwnerRepo: resolveActionOwnerRepo(
                process.env.REVIEW_ROUTER_ACTION_REF,
              ),
            }),
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
  return {
    webhookSecret: input.webhookSecret,
    installations: new PrismaGitHubInstallationRepository(input.prisma),
    ownerGrants: new PrismaInstallationWorkspaceOwnerGrant(input.prisma),
    deliveries: new PrismaWebhookDeliveryRepository(input.prisma),
    syncRequests: new OutboxInstallationSyncRequester(outbox),
    appAuthorizations: new PrismaGitHubAppAuthorizationWebhookHandler(
      input.prisma,
    ),
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

function definedOption<const Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | Record<string, never> {
  return value
    ? ({ [key]: value } as { readonly [Property in Key]: string })
    : {};
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

function resolveActionOwnerRepo(actionRef: string | undefined): string {
  const normalized = actionRef?.trim() || "777genius/review-router";
  const ownerRepo = normalized.split("@", 1)[0] ?? normalized;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ownerRepo)) {
    return "777genius/review-router";
  }
  return ownerRepo;
}
