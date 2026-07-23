import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  validateActionSessionAgainstRepository,
  type ActionControlPlaneRepositoryPort,
  type ActionEntitlementPolicyPort,
  type ActionSessionClaims,
  type ActionSessionTokenServicePort,
} from "@reviewrouter/features-action-control-plane";
import {
  ReviewRequestIngressCommandKind,
  ReviewRequestedTriggerKind,
  type ReviewRequestIngressPort,
} from "@reviewrouter/features-review-executions";
import {
  ScmProvider,
  normalizeScmSourceBaseUrl,
  type ScmRepositoryIdentityQueryPort,
} from "@reviewrouter/features-review-run-control";
import type { Clock } from "@reviewrouter/shared";

export const reviewV2ManualRequestPath =
  "/api/action/v1/review-requests/manual";

export type RegisterReviewV2RequestCommandRoutesDependencies = {
  readonly repositories: ActionControlPlaneRepositoryPort;
  readonly repositoryIdentities: ScmRepositoryIdentityQueryPort;
  readonly sessions: ActionSessionTokenServicePort;
  readonly ingress: ReviewRequestIngressPort;
  readonly entitlements?: ActionEntitlementPolicyPort;
  readonly clock: Clock;
  readonly retentionMs: number;
  readonly enabled?: boolean;
};

const bodySchema = z
  .object({
    protocolVersion: z.literal(1),
    pullRequestNumber: z.number().int().min(1).max(1_000_000),
    expectedHeadSha: z.string().regex(/^[a-f0-9]{40}$/i),
    sourceId: z.string().min(1).max(200),
    commandKind: z.enum(["skip", "unskip", "review"]),
  })
  .strict();

export async function registerReviewV2RequestCommandRoutes(
  app: FastifyInstance,
  dependencies: RegisterReviewV2RequestCommandRoutesDependencies,
): Promise<void> {
  app.post(
    reviewV2ManualRequestPath,
    { bodyLimit: 8 * 1024 },
    async (request, reply) => {
      if (dependencies.enabled === false) {
        return sendError(reply, 404, "review_request_intent_disabled");
      }
      try {
        const body = bodySchema.parse(request.body);
        const session = await resolveSession(request, dependencies);
        assertInteractionSession(session);
        const repository =
          await dependencies.repositories.findSelectedRepositoryByGithubId(
            session.githubRepositoryId,
          );
        if (!repository) throw new Error("repository_not_registered");
        validateActionSessionAgainstRepository({ session, repository });
        await dependencies.entitlements?.assertActionControlPlaneAllowed({
          workspaceId: repository.workspaceId,
          repositoryId: repository.repositoryId,
          repositoryFullName: repository.fullName,
        });
        const identity =
          await dependencies.repositoryIdentities.findScmRepositoryIdentityByExternalIdentity(
            {
              provider: ScmProvider.GitHub,
              normalizedSourceBaseUrl:
                normalizeScmSourceBaseUrl("https://github.com"),
              externalRepositoryId: repository.githubRepositoryId,
            },
          );
        if (
          !identity ||
          identity.currentWorkspaceId !== repository.workspaceId ||
          identity.currentRepositoryConnectionId !== repository.repositoryId
        ) {
          throw new Error("repository_binding_mismatch");
        }
        const result = await dependencies.ingress.enqueue({
          commandKind: ReviewRequestIngressCommandKind.Request,
          workspaceId: repository.workspaceId,
          repositoryConnectionId: repository.repositoryId,
          scmRepositoryIdentityId: identity.scmRepositoryIdentityId,
          pullRequestNumber: body.pullRequestNumber,
          githubInstallationId: repository.githubInstallationId,
          repositoryFullName: repository.fullName,
          sourceIdentity: `action-interaction:${body.sourceId}:${body.commandKind}`,
          occurredAt: dependencies.clock.now(),
          triggerKind: ReviewRequestedTriggerKind.ManualCommand,
          expectedBaseSha: null,
          expectedHeadSha: body.expectedHeadSha.toLowerCase(),
          quietPeriodMs: 0,
          retentionMs: dependencies.retentionMs,
        });
        return reply.send({
          protocolVersion: 1,
          status: result.created ? "queued" : "restored",
          requestId: result.requestId,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown_error";
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, "review_request_command_invalid");
        }
        if (
          message.includes("session") ||
          message.includes("JWT") ||
          message.includes("signature")
        ) {
          return sendError(reply, 401, "review_request_session_invalid");
        }
        if (
          message.includes("mismatch") ||
          message.includes("interaction_event_required") ||
          message.includes("entitlement_denied")
        ) {
          return sendError(reply, 403, "review_request_forbidden");
        }
        if (message.includes("not_registered")) {
          return sendError(reply, 404, "repository_not_registered");
        }
        throw error;
      }
    },
  );
}

async function resolveSession(
  request: FastifyRequest,
  dependencies: RegisterReviewV2RequestCommandRoutesDependencies,
): Promise<ActionSessionClaims> {
  return dependencies.sessions.verify({
    token: readBearerToken(request),
    now: dependencies.clock.now(),
  });
}

function assertInteractionSession(session: ActionSessionClaims): void {
  if (
    session.eventName !== "pull_request_review_comment" &&
    session.eventName !== "issue_comment"
  ) {
    throw new Error("review_request_interaction_event_required");
  }
}

function readBearerToken(request: FastifyRequest): string {
  const value = request.headers.authorization;
  const match =
    typeof value === "string" ? /^Bearer\s+(.+)$/i.exec(value) : null;
  if (!match?.[1]) throw new Error("missing_action_session_token");
  return match[1];
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
): unknown {
  return reply.code(statusCode).send({ error: { code } });
}
