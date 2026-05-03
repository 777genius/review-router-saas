import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  actionHealthReportMaxBytes,
  defaultActionOidcAudience,
  type ActionRuntimeConfigResponse,
} from "../../domain/action-control-plane.js";
import {
  exchangeGitHubOidcToken,
  type ExchangeGitHubOidcTokenDependencies,
} from "../../application/use-cases/exchange-github-oidc-token.js";
import {
  getActionRuntimeConfig,
  type GetActionRuntimeConfigDependencies,
} from "../../application/use-cases/get-action-runtime-config.js";
import {
  recordActionHealthReport,
  type RecordActionHealthReportDependencies,
} from "../../application/use-cases/record-action-health-report.js";

export type RegisterActionControlPlaneRoutesDependencies =
  ExchangeGitHubOidcTokenDependencies &
    GetActionRuntimeConfigDependencies &
    RecordActionHealthReportDependencies & {
      readonly oidcAudience?: string;
      readonly controlPlaneEnabled?: boolean;
    };

const exchangeBodySchema = z.object({
  oidcToken: z.string().min(1),
  audience: z.string().min(1).optional(),
});

export async function registerActionControlPlaneRoutes(
  app: FastifyInstance,
  dependencies: RegisterActionControlPlaneRoutesDependencies,
): Promise<void> {
  const exchangeHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> => {
    if (dependencies.controlPlaneEnabled === false) {
      return reply.code(503).send({ error: "action_control_plane_disabled" });
    }
    try {
      const body = exchangeBodySchema.parse(request.body);
      const result = await exchangeGitHubOidcToken(
        {
          oidcToken: body.oidcToken,
          audience:
            body.audience ??
            dependencies.oidcAudience ??
            defaultActionOidcAudience,
        },
        dependencies,
      );
      return reply.send(result);
    } catch (error) {
      return sendActionError(reply, error);
    }
  };

  const configHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> => {
    if (dependencies.controlPlaneEnabled === false) {
      return reply.code(503).send({ error: "action_control_plane_disabled" });
    }
    try {
      const result: ActionRuntimeConfigResponse = await getActionRuntimeConfig(
        { sessionToken: readBearerToken(request) },
        dependencies,
      );
      return reply.send(result);
    } catch (error) {
      return sendActionError(reply, error);
    }
  };

  const healthReportHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> => {
    if (dependencies.controlPlaneEnabled === false) {
      return reply.code(503).send({ error: "action_control_plane_disabled" });
    }
    try {
      const result = await recordActionHealthReport(
        { sessionToken: readBearerToken(request), report: request.body },
        dependencies,
      );
      return reply.send(result);
    } catch (error) {
      return sendActionError(reply, error);
    }
  };

  app.post("/api/action/exchange-token", exchangeHandler);
  app.post("/api/action/v1/session/exchange", exchangeHandler);
  app.get("/api/action/config", configHandler);
  app.get("/api/action/v1/config", configHandler);
  app.post(
    "/api/action/health-report",
    { bodyLimit: actionHealthReportMaxBytes },
    healthReportHandler,
  );
  app.post(
    "/api/action/v1/health-report",
    { bodyLimit: actionHealthReportMaxBytes },
    healthReportHandler,
  );
}

function readBearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    throw new Error("missing_action_session_token");
  }
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    throw new Error("invalid_action_session_token");
  }
  return match[1];
}

function sendActionError(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  error: unknown,
): unknown {
  const message = error instanceof Error ? error.message : "unknown_error";
  const statusCode = statusCodeForActionError(message);
  return reply.code(statusCode).send({ error: safeActionErrorCode(message) });
}

function statusCodeForActionError(message: string): number {
  if (
    message.startsWith("oidc_jti_required") ||
    message.startsWith("oidc_replay_detected") ||
    message.includes("signature") ||
    message.includes("JWT") ||
    message.includes("token") ||
    message.includes("audience") ||
    message.includes("issuer") ||
    message.startsWith("missing_action_session") ||
    message.startsWith("invalid_action_session")
  ) {
    return 401;
  }
  if (
    message.includes("repository_not_registered") ||
    message.includes("repository_not_selected") ||
    message.includes("installation_not_active") ||
    message.includes("workflow_ref_not_allowed") ||
    message.includes("entitlement_denied") ||
    message.includes("mismatch")
  ) {
    return 403;
  }
  if (message.startsWith("rate_limit_exceeded:")) {
    return 429;
  }
  return 400;
}

function safeActionErrorCode(message: string): string {
  if (message.includes("repository_not_registered")) {
    return "repository_not_registered";
  }
  if (message.includes("repository_not_selected")) {
    return "repository_not_selected";
  }
  if (message.includes("installation_not_active")) {
    return "installation_not_active";
  }
  if (message.includes("workflow_ref_not_allowed")) {
    return "workflow_ref_not_allowed";
  }
  if (message.includes("entitlement_denied")) {
    return "action_control_plane_entitlement_denied";
  }
  if (message.includes("mismatch")) {
    return "action_repository_mismatch";
  }
  if (
    message.startsWith("missing_action_session") ||
    message.startsWith("invalid_action_session")
  ) {
    return message;
  }
  if (
    message.startsWith("oidc_jti_required") ||
    message.startsWith("oidc_replay_detected") ||
    message.includes("signature") ||
    message.includes("JWT") ||
    message.includes("token") ||
    message.includes("audience") ||
    message.includes("issuer")
  ) {
    return "invalid_action_token";
  }
  if (message.startsWith("health_report_")) {
    return message;
  }
  if (message.startsWith("rate_limit_exceeded:")) {
    return "rate_limited";
  }
  return "invalid_action_request";
}
