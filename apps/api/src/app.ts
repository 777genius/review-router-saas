import Fastify, { type FastifyInstance } from "fastify";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { registerApiDemoRoutes } from "@reviewrouter/features-api-demo";
import {
  JoseActionSessionTokenService,
  JoseGitHubActionsOidcTokenVerifier,
  HmacActionLedgerKey,
  PrismaActionControlPlaneRepository,
  PrismaActionOidcReplayNonceStore,
  registerActionControlPlaneRoutes,
  StaticActionRuntimeCompatibilityPolicy,
  type RegisterActionControlPlaneRoutesDependencies,
} from "@reviewrouter/features-action-control-plane";
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
  EntitlementMemoryQuotaPolicy,
  PrismaMemoryItemRepository,
  PrismaMemoryPermission,
  StaticMemoryPolicyConfig,
  PrismaMemorySuggestionRepository,
  PrismaMemoryTransaction,
  PrismaMemoryUsageEventRepository,
} from "@reviewrouter/features-memory";
import { PrismaEntitlementRepository } from "@reviewrouter/features-entitlements";
import { readGitHubAppPrivateKey } from "@reviewrouter/platform-config";
import { PrismaRateLimitStore } from "@reviewrouter/features-rate-limits";
import { ConsoleLogger } from "@reviewrouter/platform-logger";
import { SystemClock } from "@reviewrouter/shared";
import { PrismaActionEntitlementPolicy } from "./action-entitlement-policy.js";
import { ActionRateLimitPolicy } from "./action-rate-limit-policy.js";
import { OctokitGitHubAppCommentTokenIssuer } from "./github/octokit-github-app-comment-token-issuer.js";
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
    ...definedOption("actionVersion", process.env.REVIEW_ROUTER_ACTION_VERSION),
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
      ? {
          webhookSecret: options.githubWebhookSecret,
          installations: new PrismaGitHubInstallationRepository(prisma),
          ownerGrants: new PrismaInstallationWorkspaceOwnerGrant(prisma),
          deliveries: new PrismaWebhookDeliveryRepository(prisma),
          syncRequests: new OutboxInstallationSyncRequester(
            new PrismaOutboxEventRepository(prisma),
          ),
          pullRequests: new PrismaSetupPullRequestMergeHandler(prisma),
          repositories: new PrismaRepositoryWebhookHandler(prisma),
          clock: new SystemClock(),
        }
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
          const ledgerSecret =
            process.env.REVIEW_ROUTER_LEDGER_HMAC_KEY ??
            options.actionSessionSecret;
          return {
            repositories: new PrismaActionControlPlaneRepository(prisma),
            entitlements: new PrismaActionEntitlementPolicy(prisma),
            rateLimits: new ActionRateLimitPolicy(
              new PrismaRateLimitStore(prisma),
              clock,
            ),
            replayNonces: new PrismaActionOidcReplayNonceStore(prisma),
            compatibility: new StaticActionRuntimeCompatibilityPolicy({
              blockedActionVersions: parseCommaSeparatedEnv(
                process.env.REVIEW_ROUTER_BLOCKED_ACTION_VERSIONS,
              ),
            }),
            sessions: new JoseActionSessionTokenService(
              options.actionSessionSecret,
            ),
            ledgerKeys: new HmacActionLedgerKey(ledgerSecret),
            ...(process.env.GITHUB_APP_ID && githubAppPrivateKey
              ? {
                  commentTokens: new OctokitGitHubAppCommentTokenIssuer({
                    appId: process.env.GITHUB_APP_ID,
                    privateKey: githubAppPrivateKey,
                  }),
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
            memoryPolicyConfig: new StaticMemoryPolicyConfig(),
            memoryUsageEvents: new PrismaMemoryUsageEventRepository(prisma),
            memoryQuotaPolicy: new EntitlementMemoryQuotaPolicy(
              new PrismaEntitlementRepository(prisma),
            ),
            memoryIds: new CryptoMemoryIdGenerator(),
            memoryTransaction: new PrismaMemoryTransaction(prisma),
            clock: actionControlPlaneDependencies.clock,
          },
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
