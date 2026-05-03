import Fastify, { type FastifyInstance } from "fastify";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import {
  JoseActionSessionTokenService,
  JoseGitHubActionsOidcTokenVerifier,
  PrismaActionControlPlaneRepository,
  registerActionControlPlaneRoutes,
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
import { PrismaRateLimitStore } from "@reviewrouter/features-rate-limits";
import { ConsoleLogger } from "@reviewrouter/platform-logger";
import { SystemClock } from "@reviewrouter/shared";
import { PrismaActionEntitlementPolicy } from "./action-entitlement-policy.js";
import { ActionRateLimitPolicy } from "./action-rate-limit-policy.js";
import { PrismaHealthDependency } from "./prisma-health-dependency.js";
import { appRouter } from "./trpc.js";

export type CreateApiAppOptions = {
  readonly githubWebhookSecret?: string;
  readonly githubWebhookDependencies?: RegisterGitHubWebhookRoutesDependencies;
  readonly actionControlPlaneDependencies?: RegisterActionControlPlaneRoutesDependencies;
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

  registerSystemHealthRoutes(
    app,
    new SystemClock(),
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
          return {
            repositories: new PrismaActionControlPlaneRepository(prisma),
            entitlements: new PrismaActionEntitlementPolicy(prisma),
            rateLimits: new ActionRateLimitPolicy(
              new PrismaRateLimitStore(prisma),
              clock,
            ),
            sessions: new JoseActionSessionTokenService(
              options.actionSessionSecret,
            ),
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
