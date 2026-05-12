import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type ActionSessionClaims,
  validateActionSessionAgainstRepository,
  type ActionControlPlaneRepositoryPort,
  type ActionEntitlementPolicyPort,
  type ActionSessionTokenServicePort,
} from "@reviewrouter/features-action-control-plane";
import {
  buildActionMemoryBundle,
  confirmMemorySuggestion,
  createMemoryBodyHash,
  deleteMemoryItem,
  disableMemoryItem,
  memoryBodyMaxCharacters,
  memoryRedactedExcerptMaxCharacters,
  normalizeMemoryBody,
  proposeMemoryFromInteraction,
  rejectMemorySuggestion,
  type MemoryActor,
  type MemoryMutationResult,
  type MemorySource,
  type MemoryUseCaseDependencies,
} from "@reviewrouter/features-memory";
import type { Clock } from "@reviewrouter/shared";

export type RegisterActionMemoryRoutesDependencies = {
  readonly repositories: ActionControlPlaneRepositoryPort;
  readonly sessions: ActionSessionTokenServicePort;
  readonly memory: MemoryUseCaseDependencies;
  readonly entitlements?: ActionEntitlementPolicyPort;
  readonly clock: Clock;
  readonly controlPlaneEnabled?: boolean;
};

const actionMemoryCandidateMaxBytes = 32 * 1024;
const actionMemoryCommandMaxBytes = 16 * 1024;
const memoryCandidateScopeSchema = z.enum(["repository", "workspace"]);
const memoryCandidateBodySchema = z
  .object({
    protocolVersion: z.literal(1).default(1),
    intent: z.enum([
      "explicit_command",
      "explicit_natural_language",
      "model_suggested_candidate",
      "ambiguous_discussion",
      "no_memory_intent",
    ]),
    requestedScope: memoryCandidateScopeSchema.nullable().optional(),
    candidateBody: z.string().max(memoryBodyMaxCharacters),
    sourceTextHash: z.string().min(1).max(256).nullable().optional(),
    extractionMethod: z.enum([
      "explicit_command",
      "explicit_natural_language",
      "model_suggested_candidate",
    ]),
    extractionVersion: z.number().int().min(1).max(100).default(1),
    source: z
      .object({
        sourceId: z.string().min(1).max(200),
        githubCommentId: z.string().min(1).max(80).nullable().optional(),
        githubPullRequestNumber: z
          .number()
          .int()
          .min(1)
          .max(1_000_000)
          .nullable()
          .optional(),
        url: z.string().url().max(2_000).nullable().optional(),
        redactedExcerpt: z
          .string()
          .max(memoryRedactedExcerptMaxCharacters)
          .nullable()
          .optional(),
        sourceHash: z.string().min(1).max(256).nullable().optional(),
        sourceVisibility: z
          .enum(["private", "internal", "public"])
          .default("internal"),
      })
      .strict(),
  })
  .strict();

type MemoryCandidateBody = z.infer<typeof memoryCandidateBodySchema>;

const memoryCommandIdSchema = z.string().min(1).max(120);
const memoryActionCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("confirm_suggestion"),
      suggestionId: memoryCommandIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reject_suggestion"),
      suggestionId: memoryCommandIdSchema,
      reason: z.string().max(500).nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("disable_memory"),
      memoryItemId: memoryCommandIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("forget_memory"),
      memoryItemId: memoryCommandIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("list_memory"),
      view: z.enum(["active", "pending"]).default("active"),
    })
    .strict(),
]);
const memoryCommandsBodySchema = z
  .object({
    protocolVersion: z.literal(1).default(1),
    commands: z.array(memoryActionCommandSchema).min(1).max(5),
  })
  .strict();

type MemoryActionCommandBody = z.infer<
  typeof memoryCommandsBodySchema
>["commands"][number];

export async function registerActionMemoryRoutes(
  app: FastifyInstance,
  dependencies: RegisterActionMemoryRoutesDependencies,
): Promise<void> {
  const getMemoryHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> => {
    if (dependencies.controlPlaneEnabled === false) {
      return sendMemoryError(reply, "action_control_plane_disabled", 503);
    }

    try {
      const session = await resolveActionMemorySession(request, dependencies);

      const bundle = await buildActionMemoryBundle(
        {
          workspaceId: session.workspaceId,
          repositoryId: session.repositoryId,
          userId: null,
          policy: { includeUserPrefs: false },
        },
        { memoryItems: dependencies.memory.memoryItems },
      );
      return reply.send(bundle);
    } catch (error) {
      return sendCaughtMemoryError(reply, error);
    }
  };

  const submitCandidateHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> => {
    if (dependencies.controlPlaneEnabled === false) {
      return sendMemoryError(reply, "action_control_plane_disabled", 503);
    }

    try {
      const session = await resolveActionMemorySession(request, dependencies);
      assertMemoryInteractionEvent(session.eventName);
      const body = memoryCandidateBodySchema.parse(request.body);
      const result = await proposeMemoryFromInteraction(
        {
          envelope: {
            workspaceId: session.workspaceId,
            repositoryId: session.repositoryId,
            userId: null,
            source: memorySourceFromCandidate(session, body),
            actor: memoryActorFromSession(session),
            intent: body.intent,
            requestedScope: body.requestedScope ?? "repository",
            candidateBody: normalizeMemoryBody(body.candidateBody),
            candidateBodyHash: createMemoryBodyHash(body.candidateBody),
            redactedSourceExcerpt: body.source.redactedExcerpt ?? null,
            sourceTextHash:
              body.sourceTextHash ?? body.source.sourceHash ?? null,
            extractionMethod: body.extractionMethod,
            extractionVersion: body.extractionVersion,
          },
        },
        dependencies.memory,
      );
      return reply.send(memoryMutationResponse(result));
    } catch (error) {
      return sendCaughtMemoryError(reply, error);
    }
  };

  const submitCommandHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> => {
    if (dependencies.controlPlaneEnabled === false) {
      return sendMemoryError(reply, "action_control_plane_disabled", 503);
    }

    try {
      const session = await resolveActionMemorySession(request, dependencies);
      assertMemoryInteractionEvent(session.eventName);
      const body = memoryCommandsBodySchema.parse(request.body);
      const actor = memoryActorFromSession(session);
      const results = [];
      for (const command of body.commands) {
        results.push(
          await executeMemoryActionCommand(
            command,
            session,
            actor,
            dependencies,
          ),
        );
      }
      return reply.send({ protocolVersion: 1, results });
    } catch (error) {
      return sendCaughtMemoryError(
        reply,
        error,
        "invalid_action_memory_command",
      );
    }
  };

  app.get("/api/action/v1/memory", getMemoryHandler);
  app.post(
    "/api/action/v1/memory-candidates",
    { bodyLimit: actionMemoryCandidateMaxBytes },
    submitCandidateHandler,
  );
  app.post(
    "/api/action/v1/memory-commands",
    { bodyLimit: actionMemoryCommandMaxBytes },
    submitCommandHandler,
  );
}

async function resolveActionMemorySession(
  request: FastifyRequest,
  dependencies: RegisterActionMemoryRoutesDependencies,
): Promise<ActionSessionClaims> {
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
  return session;
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

function assertMemoryInteractionEvent(
  eventName: ActionSessionClaims["eventName"],
): void {
  if (
    eventName !== "pull_request_review_comment" &&
    eventName !== "issue_comment"
  ) {
    throw new Error("memory_interaction_event_required");
  }
}

async function executeMemoryActionCommand(
  command: MemoryActionCommandBody,
  session: ActionSessionClaims,
  actor: MemoryActor,
  dependencies: RegisterActionMemoryRoutesDependencies,
): Promise<Record<string, unknown>> {
  if (command.kind === "confirm_suggestion") {
    return memoryCommandResponse(
      command.kind,
      await confirmMemorySuggestion(
        {
          workspaceId: session.workspaceId,
          suggestionId: command.suggestionId,
          actor,
        },
        dependencies.memory,
      ),
    );
  }

  if (command.kind === "reject_suggestion") {
    return memoryCommandResponse(
      command.kind,
      await rejectMemorySuggestion(
        {
          workspaceId: session.workspaceId,
          suggestionId: command.suggestionId,
          actor,
          ...(command.reason ? { reason: command.reason } : {}),
        },
        dependencies.memory,
      ),
    );
  }

  if (command.kind === "disable_memory") {
    return memoryCommandResponse(
      command.kind,
      await disableMemoryItem(
        {
          workspaceId: session.workspaceId,
          itemId: command.memoryItemId,
          actor,
        },
        dependencies.memory,
      ),
    );
  }

  if (command.kind === "forget_memory") {
    return memoryCommandResponse(
      command.kind,
      await deleteMemoryItem(
        {
          workspaceId: session.workspaceId,
          itemId: command.memoryItemId,
          actor,
        },
        dependencies.memory,
      ),
    );
  }

  return {
    kind: command.kind,
    status: "noop",
    reason: "list_memory_not_available_in_action_api",
  };
}

function memoryCommandResponse(
  kind: MemoryActionCommandBody["kind"],
  result: MemoryMutationResult,
): Record<string, unknown> {
  const mutation = { ...memoryMutationResponse(result) };
  delete mutation.protocolVersion;
  return {
    ...mutation,
    kind,
  };
}

function memoryActorFromSession(session: ActionSessionClaims): MemoryActor {
  const login = session.githubActorLogin?.trim();
  if (!login) {
    throw new Error("memory_actor_unavailable");
  }
  return {
    kind: "github_user",
    id: `github-login:${login.toLowerCase()}`,
    githubUserId: null,
    login,
  };
}

function memorySourceFromCandidate(
  session: ActionSessionClaims,
  body: MemoryCandidateBody,
): MemorySource {
  return {
    type:
      session.eventName === "pull_request_review_comment"
        ? "review_comment"
        : "pr_comment",
    sourceId: body.source.sourceId,
    githubCommentId: body.source.githubCommentId ?? null,
    githubPullRequestNumber: body.source.githubPullRequestNumber ?? null,
    githubRepositoryId: session.githubRepositoryId,
    url: body.source.url ?? null,
    actorLogin: session.githubActorLogin,
    redactedExcerpt: body.source.redactedExcerpt ?? null,
    sourceHash: body.source.sourceHash ?? body.sourceTextHash ?? null,
    sourceVisibility: body.source.sourceVisibility,
  };
}

function memoryMutationResponse(
  result: MemoryMutationResult,
): Record<string, unknown> {
  if (result.status === "created" || result.status === "updated") {
    return {
      protocolVersion: 1,
      status: result.status,
      id: result.id,
      version: result.version,
    };
  }
  if (result.status === "noop") {
    return {
      protocolVersion: 1,
      status: result.status,
      reason: result.reason,
      ...(result.id ? { id: result.id } : {}),
    };
  }
  return {
    protocolVersion: 1,
    status: result.status,
    reason: result.reason,
    retryable: result.retryable ?? false,
  };
}

function sendCaughtMemoryError(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  error: unknown,
  invalidPayloadCode = "invalid_action_memory_candidate",
): unknown {
  const message = error instanceof Error ? error.message : "unknown_error";
  return sendMemoryError(
    reply,
    error instanceof z.ZodError
      ? invalidPayloadCode
      : safeActionMemoryErrorCode(message),
    statusCodeForActionMemoryError(message),
  );
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
    message.includes("entitlement_denied") ||
    message.includes("memory_interaction_event_required") ||
    message.includes("memory_actor_unavailable")
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
  if (message.includes("memory_interaction_event_required")) {
    return "memory_interaction_event_required";
  }
  if (message.includes("memory_actor_unavailable")) {
    return "memory_actor_unavailable";
  }
  if (message.includes("ZodError") || message.includes("invalid_type")) {
    return "invalid_action_memory_candidate";
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
    case "memory_interaction_event_required":
      return "Memory updates can only be submitted from interaction workflows.";
    case "memory_actor_unavailable":
      return "GitHub actor identity is unavailable for this action session.";
    case "invalid_action_memory_candidate":
      return "Action memory candidate payload is invalid.";
    case "invalid_action_memory_command":
      return "Action memory command payload is invalid.";
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
