import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  validateActionSessionAgainstRepository,
  type ActionControlPlaneRepositoryPort,
  type ActionEntitlementPolicyPort,
  type ActionSessionTokenServicePort,
} from "@reviewrouter/features-action-control-plane";
import {
  buildActionMemoryBundle,
  type MemoryItemRepositoryPort,
} from "@reviewrouter/features-memory";
import type { Clock } from "@reviewrouter/shared";

export type RegisterActionMemoryRoutesDependencies = {
  readonly repositories: ActionControlPlaneRepositoryPort;
  readonly sessions: ActionSessionTokenServicePort;
  readonly memoryItems: MemoryItemRepositoryPort;
  readonly entitlements?: ActionEntitlementPolicyPort;
  readonly clock: Clock;
  readonly controlPlaneEnabled?: boolean;
};

export async function registerActionMemoryRoutes(
  app: FastifyInstance,
  dependencies: RegisterActionMemoryRoutesDependencies,
): Promise<void> {
  const handler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> => {
    if (dependencies.controlPlaneEnabled === false) {
      return sendMemoryError(reply, "action_control_plane_disabled", 503);
    }

    try {
      const session = await dependencies.sessions.verify({
        token: readBearerToken(request),
        now: dependencies.clock.now(),
      });
      const repository =
        await dependencies.repositories.findSelectedRepositoryByGithubId(
          session.githubRepositoryId,
        );
      if (!repository) {
        throw new Error("repository_not_registered");
      }
      validateActionSessionAgainstRepository({ session, repository });
      await dependencies.entitlements?.assertActionControlPlaneAllowed({
        workspaceId: session.workspaceId,
        repositoryId: session.repositoryId,
        repositoryFullName: session.repository,
      });

      const bundle = await buildActionMemoryBundle(
        {
          workspaceId: session.workspaceId,
          repositoryId: session.repositoryId,
          userId: null,
          policy: { includeUserPrefs: false },
        },
        { memoryItems: dependencies.memoryItems },
      );
      return reply.send(bundle);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      return sendMemoryError(
        reply,
        safeActionMemoryErrorCode(message),
        statusCodeForActionMemoryError(message),
      );
    }
  };

  app.get("/api/action/v1/memory", handler);
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

function statusCodeForActionMemoryError(message: string): number {
  if (
    message.startsWith("missing_action_session") ||
    message.startsWith("invalid_action_session") ||
    message.includes("signature") ||
    message.includes("JWT") ||
    message.includes("token")
  ) {
    return 401;
  }
  if (
    message.includes("repository_not_registered") ||
    message.includes("repository_not_selected") ||
    message.includes("installation_not_active") ||
    message.includes("mismatch") ||
    message.includes("entitlement_denied")
  ) {
    return 403;
  }
  return 400;
}

function safeActionMemoryErrorCode(message: string): string {
  if (message.includes("repository_not_registered")) {
    return "repository_not_registered";
  }
  if (message.includes("repository_not_selected")) {
    return "repository_not_selected";
  }
  if (message.includes("installation_not_active")) {
    return "installation_not_active";
  }
  if (message.includes("mismatch")) {
    return "action_repository_mismatch";
  }
  if (message.includes("entitlement_denied")) {
    return "action_control_plane_entitlement_denied";
  }
  if (
    message.startsWith("missing_action_session") ||
    message.startsWith("invalid_action_session")
  ) {
    return message;
  }
  if (
    message.includes("signature") ||
    message.includes("JWT") ||
    message.includes("token")
  ) {
    return "invalid_action_token";
  }
  return "invalid_action_request";
}

function sendMemoryError(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  code: string,
  statusCode: number,
): unknown {
  return reply.code(statusCode).send({
    error: {
      code,
      message: safeActionMemoryErrorMessage(code),
      retryable: code === "action_control_plane_disabled",
    },
  });
}

function safeActionMemoryErrorMessage(code: string): string {
  switch (code) {
    case "action_control_plane_disabled":
      return "ReviewRouter action control plane is temporarily disabled.";
    case "repository_not_registered":
      return "Repository is not registered in ReviewRouter.";
    case "repository_not_selected":
      return "Repository is not selected in ReviewRouter.";
    case "installation_not_active":
      return "GitHub App installation is not active for this repository.";
    case "action_repository_mismatch":
      return "GitHub OIDC repository claims do not match the selected repository.";
    case "action_control_plane_entitlement_denied":
      return "Action control plane is not enabled for this workspace.";
    case "missing_action_session_token":
      return "Action session token is missing.";
    case "invalid_action_session_token":
      return "Action session token is invalid or expired.";
    case "invalid_action_token":
      return "GitHub Actions OIDC token is invalid, expired, or already used.";
    default:
      return "Action memory request is invalid.";
  }
}
