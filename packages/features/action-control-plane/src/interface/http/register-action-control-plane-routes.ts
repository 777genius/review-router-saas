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

type ActionErrorFormat = "legacy" | "v1";

export async function registerActionControlPlaneRoutes(
  app: FastifyInstance,
  dependencies: RegisterActionControlPlaneRoutesDependencies,
): Promise<void> {
  const createExchangeHandler =
    (errorFormat: ActionErrorFormat) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      if (dependencies.controlPlaneEnabled === false) {
        return sendActionErrorCode(
          reply,
          "action_control_plane_disabled",
          503,
          errorFormat,
        );
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
        return sendActionError(reply, error, errorFormat);
      }
    };

  const createConfigHandler =
    (errorFormat: ActionErrorFormat) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      if (dependencies.controlPlaneEnabled === false) {
        return sendActionErrorCode(
          reply,
          "action_control_plane_disabled",
          503,
          errorFormat,
        );
      }
      try {
        const result: ActionRuntimeConfigResponse =
          await getActionRuntimeConfig(
            { sessionToken: readBearerToken(request) },
            dependencies,
          );
        return reply.send(result);
      } catch (error) {
        return sendActionError(reply, error, errorFormat);
      }
    };

  const createHealthReportHandler =
    (errorFormat: ActionErrorFormat) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      if (dependencies.controlPlaneEnabled === false) {
        return sendActionErrorCode(
          reply,
          "action_control_plane_disabled",
          503,
          errorFormat,
        );
      }
      try {
        const result = await recordActionHealthReport(
          { sessionToken: readBearerToken(request), report: request.body },
          dependencies,
        );
        return reply.send(result);
      } catch (error) {
        return sendActionError(reply, error, errorFormat);
      }
    };

  app.post("/api/action/exchange-token", createExchangeHandler("legacy"));
  app.post("/api/action/v1/session/exchange", createExchangeHandler("v1"));
  app.get("/api/action/config", createConfigHandler("legacy"));
  app.get("/api/action/v1/config", createConfigHandler("v1"));
  app.post(
    "/api/action/health-report",
    { bodyLimit: actionHealthReportMaxBytes },
    createHealthReportHandler("legacy"),
  );
  app.post(
    "/api/action/v1/health-report",
    { bodyLimit: actionHealthReportMaxBytes },
    createHealthReportHandler("v1"),
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
  format: ActionErrorFormat,
): unknown {
  const message = error instanceof Error ? error.message : "unknown_error";
  const statusCode = statusCodeForActionError(message);
  return sendActionErrorCode(
    reply,
    safeActionErrorCode(message),
    statusCode,
    format,
  );
}

function sendActionErrorCode(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  code: string,
  statusCode: number,
  format: ActionErrorFormat,
): unknown {
  if (format === "legacy") {
    return reply.code(statusCode).send({ error: code });
  }

  return reply.code(statusCode).send({
    error: {
      code,
      message: safeActionErrorMessage(code),
      retryable: isRetryableActionError(code),
    },
  });
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

function safeActionErrorMessage(code: string): string {
  switch (code) {
    case "action_control_plane_disabled":
      return "ReviewRouter action control plane is temporarily disabled.";
    case "repository_not_registered":
      return "Repository is not registered in ReviewRouter.";
    case "repository_not_selected":
      return "Repository is not selected in ReviewRouter.";
    case "installation_not_active":
      return "GitHub App installation is not active for this repository.";
    case "workflow_ref_not_allowed":
      return "Workflow file is not allowed to fetch ReviewRouter runtime config.";
    case "action_control_plane_entitlement_denied":
      return "Action control plane is not enabled for this workspace.";
    case "action_repository_mismatch":
      return "GitHub OIDC repository claims do not match the selected repository.";
    case "missing_action_session_token":
      return "Action session token is missing.";
    case "invalid_action_session_token":
      return "Action session token is invalid or expired.";
    case "invalid_action_token":
      return "GitHub Actions OIDC token is invalid, expired, or already used.";
    case "rate_limited":
      return "Action control plane request was rate limited; retry later.";
    default:
      if (code.startsWith("health_report_")) {
        return "Action health report was rejected by ReviewRouter safety checks.";
      }
      return "Action control plane request is invalid.";
  }
}

function isRetryableActionError(code: string): boolean {
  return code === "rate_limited" || code === "action_control_plane_disabled";
}
