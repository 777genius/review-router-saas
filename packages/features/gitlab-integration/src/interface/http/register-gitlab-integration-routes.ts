import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Clock } from "@reviewrouter/shared";
import { z } from "zod";
import type { GitLabInstallationPort } from "../../application/ports/gitlab-installation-port";
import {
  exchangeGitLabCiIdToken,
  type ExchangeGitLabCiIdTokenDependencies,
} from "../../application/use-cases/exchange-gitlab-ci-id-token";
import { provisionGitLabReviewRouterProject } from "../../application/use-cases/provision-gitlab-reviewrouter-project";
import { provisionGitLabReviewRouterProjects } from "../../application/use-cases/provision-gitlab-reviewrouter-projects";
import {
  defaultReviewRouterControlProjectConfigPath,
  renderGitLabReviewRouterControlCiConfig,
} from "../../domain/gitlab-installation";
import { defaultGitLabAudience } from "../../domain/gitlab-ci-identity";

type GitLabExchangeRouteDependencies = Omit<
  ExchangeGitLabCiIdTokenDependencies,
  "clock"
>;

export type RegisterGitLabIntegrationRoutesDependencies = {
  readonly clock: Clock;
  readonly exchange?: GitLabExchangeRouteDependencies | undefined;
  readonly installation?: GitLabInstallationPort | undefined;
  readonly defaultAudience?: string | undefined;
  readonly defaultRuntimeImage?: string | undefined;
  readonly installerAdminToken?: string | undefined;
  readonly controlPlaneEnabled?: boolean | undefined;
};

const exchangeBodySchema = z
  .object({
    idToken: z.string().min(1),
    audience: z.string().min(1).optional(),
    mergeRequestIid: z.string().regex(/^[1-9][0-9]*$/),
    headSha: z.string().regex(/^[a-fA-F0-9]{40}$/),
  })
  .strict();

const provisionParamsSchema = z
  .object({
    projectId: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();

const provisionBodySchema = z
  .object({
    controlProjectPath: z.string().min(1),
    controlProjectConfigPath: z.string().min(1).optional(),
    controlProjectRef: z.string().min(1).optional(),
    reviewRouterApiBaseUrl: z.string().url(),
    idTokenAudience: z.string().min(1).optional(),
    variableTarget: z
      .object({
        kind: z.enum(["group", "project"]),
        id: z.string().regex(/^[1-9][0-9]*$/),
      })
      .strict()
      .optional(),
    reviewToken: z.string().min(1).optional(),
  })
  .strict();

const bulkProvisionBodySchema = provisionBodySchema.extend({
  projectIds: z
    .array(z.string().regex(/^[1-9][0-9]*$/))
    .min(1)
    .max(100),
});

const controlCiConfigQuerySchema = z
  .object({
    runtimeImage: z.string().min(1).optional(),
  })
  .strict();

export async function registerGitLabIntegrationRoutes(
  app: FastifyInstance,
  dependencies: RegisterGitLabIntegrationRoutesDependencies,
): Promise<void> {
  app.post(
    "/api/gitlab/action/v1/session/exchange",
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      if (dependencies.controlPlaneEnabled === false) {
        return sendGitLabErrorCode(reply, "gitlab_control_plane_disabled", 503);
      }
      if (!dependencies.exchange) {
        return sendGitLabErrorCode(reply, "gitlab_exchange_unavailable", 503);
      }
      try {
        const body = exchangeBodySchema.parse(request.body);
        const result = await exchangeGitLabCiIdToken(
          {
            idToken: body.idToken,
            audience:
              body.audience ??
              dependencies.defaultAudience ??
              defaultGitLabAudience,
            mergeRequestIid: body.mergeRequestIid,
            headSha: body.headSha,
          },
          { ...dependencies.exchange, clock: dependencies.clock },
        );
        return reply.send(result);
      } catch (error) {
        return sendGitLabError(reply, error);
      }
    },
  );

  app.post(
    "/api/gitlab/install/v1/bulk-provision",
    { bodyLimit: 128 * 1024 },
    async (request, reply) => {
      if (dependencies.controlPlaneEnabled === false) {
        return sendGitLabErrorCode(reply, "gitlab_control_plane_disabled", 503);
      }
      if (!dependencies.installation || !dependencies.installerAdminToken) {
        return sendGitLabErrorCode(
          reply,
          "gitlab_installation_unavailable",
          503,
        );
      }
      if (readBearerToken(request) !== dependencies.installerAdminToken) {
        return sendGitLabErrorCode(
          reply,
          "gitlab_installation_unauthorized",
          401,
        );
      }
      try {
        const body = bulkProvisionBodySchema.parse(request.body);
        const result = await provisionGitLabReviewRouterProjects(
          {
            projectIds: body.projectIds,
            controlProjectPath: body.controlProjectPath,
            ...(body.controlProjectConfigPath
              ? { controlProjectConfigPath: body.controlProjectConfigPath }
              : {}),
            ...(body.controlProjectRef
              ? { controlProjectRef: body.controlProjectRef }
              : {}),
            reviewRouterApiBaseUrl: body.reviewRouterApiBaseUrl,
            idTokenAudience:
              body.idTokenAudience ??
              dependencies.defaultAudience ??
              defaultGitLabAudience,
            ...(body.variableTarget
              ? { variableTarget: body.variableTarget }
              : {}),
            ...(body.reviewToken ? { reviewToken: body.reviewToken } : {}),
          },
          {
            installation: dependencies.installation,
            clock: dependencies.clock,
          },
        );
        return reply.send(result);
      } catch (error) {
        return sendGitLabError(reply, error);
      }
    },
  );

  app.post(
    "/api/gitlab/install/v1/projects/:projectId/provision",
    { bodyLimit: 32 * 1024 },
    async (request, reply) => {
      if (dependencies.controlPlaneEnabled === false) {
        return sendGitLabErrorCode(reply, "gitlab_control_plane_disabled", 503);
      }
      if (!dependencies.installation || !dependencies.installerAdminToken) {
        return sendGitLabErrorCode(
          reply,
          "gitlab_installation_unavailable",
          503,
        );
      }
      if (readBearerToken(request) !== dependencies.installerAdminToken) {
        return sendGitLabErrorCode(
          reply,
          "gitlab_installation_unauthorized",
          401,
        );
      }
      try {
        const params = provisionParamsSchema.parse(request.params);
        const body = provisionBodySchema.parse(request.body);
        const result = await provisionGitLabReviewRouterProject(
          {
            projectId: params.projectId,
            controlProjectPath: body.controlProjectPath,
            ...(body.controlProjectConfigPath
              ? { controlProjectConfigPath: body.controlProjectConfigPath }
              : {}),
            ...(body.controlProjectRef
              ? { controlProjectRef: body.controlProjectRef }
              : {}),
            reviewRouterApiBaseUrl: body.reviewRouterApiBaseUrl,
            idTokenAudience:
              body.idTokenAudience ??
              dependencies.defaultAudience ??
              defaultGitLabAudience,
            ...(body.variableTarget
              ? { variableTarget: body.variableTarget }
              : {}),
            ...(body.reviewToken ? { reviewToken: body.reviewToken } : {}),
          },
          {
            installation: dependencies.installation,
            clock: dependencies.clock,
          },
        );
        return reply.send(result);
      } catch (error) {
        return sendGitLabError(reply, error);
      }
    },
  );

  app.get(
    "/api/gitlab/install/v1/control-ci-config",
    async (request, reply) => {
      if (dependencies.controlPlaneEnabled === false) {
        return sendGitLabErrorCode(reply, "gitlab_control_plane_disabled", 503);
      }
      if (!dependencies.installerAdminToken) {
        return sendGitLabErrorCode(
          reply,
          "gitlab_installation_unavailable",
          503,
        );
      }
      if (readBearerToken(request) !== dependencies.installerAdminToken) {
        return sendGitLabErrorCode(
          reply,
          "gitlab_installation_unauthorized",
          401,
        );
      }
      try {
        const query = controlCiConfigQuerySchema.parse(request.query);
        return reply.send({
          protocolVersion: 1,
          path: defaultReviewRouterControlProjectConfigPath,
          content: renderGitLabReviewRouterControlCiConfig({
            ...((query.runtimeImage ?? dependencies.defaultRuntimeImage)
              ? {
                  runtimeImage:
                    query.runtimeImage ?? dependencies.defaultRuntimeImage,
                }
              : {}),
          }),
        });
      } catch (error) {
        return sendGitLabError(reply, error);
      }
    },
  );
}

function readBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    return null;
  }
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function sendGitLabError(reply: FastifyReply, error: unknown): unknown {
  const message = error instanceof Error ? error.message : "unknown_error";
  return sendGitLabErrorCode(
    reply,
    safeGitLabErrorCode(message),
    statusCodeForGitLabError(message),
  );
}

function sendGitLabErrorCode(
  reply: FastifyReply,
  code: string,
  statusCode: number,
): unknown {
  return reply.code(statusCode).send({
    error: {
      code,
      message: safeGitLabErrorMessage(code),
      retryable: isRetryableGitLabError(code),
    },
  });
}

function statusCodeForGitLabError(message: string): number {
  if (
    message.includes("unauthorized") ||
    message.includes("invalid_gitlab_action_session") ||
    message.includes("gitlab_action_session_secret")
  ) {
    return 401;
  }
  if (
    message.includes("not_registered") ||
    message.includes("not_selected") ||
    message.includes("not_active") ||
    message.includes("mismatch") ||
    message.includes("unsupported") ||
    message.includes("invalid")
  ) {
    return 403;
  }
  if (message.includes("unavailable") || message.includes("failed:5")) {
    return 503;
  }
  return 400;
}

function safeGitLabErrorCode(message: string): string {
  const code = message.split(":")[0] ?? "unknown_error";
  return /^[a-z0-9_]{1,96}$/.test(code) ? code : "unknown_error";
}

function safeGitLabErrorMessage(code: string): string {
  return code.replaceAll("_", " ");
}

function isRetryableGitLabError(code: string): boolean {
  return code.endsWith("_unavailable") || code.includes("_timeout");
}
