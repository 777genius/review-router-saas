import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
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
    };

const exchangeBodySchema = z.object({
  oidcToken: z.string().min(1),
  audience: z.string().min(1).optional(),
});

export async function registerActionControlPlaneRoutes(
  app: FastifyInstance,
  dependencies: RegisterActionControlPlaneRoutesDependencies,
): Promise<void> {
  app.post("/api/action/exchange-token", async (request, reply) => {
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
  });

  app.get("/api/action/config", async (request, reply) => {
    try {
      const result: ActionRuntimeConfigResponse = await getActionRuntimeConfig(
        { sessionToken: readBearerToken(request) },
        dependencies,
      );
      return reply.send(result);
    } catch (error) {
      return sendActionError(reply, error);
    }
  });

  app.post("/api/action/health-report", async (request, reply) => {
    try {
      const result = await recordActionHealthReport(
        { sessionToken: readBearerToken(request), report: request.body },
        dependencies,
      );
      return reply.send(result);
    } catch (error) {
      return sendActionError(reply, error);
    }
  });
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
  return reply.code(statusCode).send({ error: message });
}

function statusCodeForActionError(message: string): number {
  if (
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
    message.includes("mismatch")
  ) {
    return 403;
  }
  return 400;
}
