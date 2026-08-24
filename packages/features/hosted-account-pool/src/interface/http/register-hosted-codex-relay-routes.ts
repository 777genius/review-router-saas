import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

export const hostedCodexGrantPath = "/api/action/v1/hosted-relay/grant";
export const hostedCodexResponsesPath = "/api/action/v1/hosted-codex/responses";
export const hostedCodexCommentTokenPath =
  "/api/action/v1/hosted-relay/comment-token";

const grantRequestSchema = z
  .object({
    oidcToken: z.string().min(32).max(16_384),
    providerInstanceId: z.string().trim().min(1).max(160),
    workflowSchemaVersion: z.number().int().positive(),
    bindingId: z.string().trim().min(1).max(160),
    bindingVersion: z.number().int().positive(),
  })
  .strict();

export type HostedCodexGrantRequest = z.infer<typeof grantRequestSchema>;

export type HostedCodexGrantResponse = {
  readonly protocolVersion: 1;
  readonly grant: string;
  readonly relayUrl: string;
  readonly invocationLeaseId: string;
  readonly runtimeConfigVersion: number;
  readonly runtimeEnv: Readonly<Record<string, string>>;
  readonly repository: string;
  readonly commentToken: string;
  readonly commentTokenRefreshCapability: string;
  readonly grantExpiresAt: string;
  readonly commentTokenExpiresAt?: string;
  readonly policy: {
    readonly maxRequests: number;
    readonly maxRequestBodyBytes?: number;
  };
};

export interface HostedCodexGrantIssuerPort {
  /** Verifies fresh GitHub OIDC and the exact current private-repo binding. */
  issue(input: HostedCodexGrantRequest): Promise<HostedCodexGrantResponse>;
}

export interface HostedCodexCommentTokenIssuerPort {
  issue(input: {
    readonly opaqueRefreshCapability: string;
    readonly invocationLeaseId: string;
    readonly bindingId: string;
    readonly bindingVersion: number;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly token: string;
    readonly repository: string;
    readonly expiresAt?: string;
  }>;
}

export type AuthorizedHostedCodexRelay = {
  readonly grantId: string;
  readonly requestId: string;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly poolId: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly model: string;
  readonly accountUsable: boolean;
  readonly grantExpiresAtMs: number;
  readonly declaredRequestBytes: number;
  readonly maxRequestBodyBytes: number;
  readonly faultPlanScope?: Readonly<{
    readonly workspaceId: string;
    readonly githubRepositoryId: bigint;
    readonly actionRef: string;
    readonly repositoryBindingId: string;
    readonly bindingRevision: bigint;
    readonly requestOrdinal: number;
  }>;
};

export interface HostedCodexRelayAuthorizationPort {
  /** Revalidates tenant, repository, binding, pool and authz epoch on every call. */
  authorize(input: {
    readonly opaqueGrant: string;
    readonly idempotencyKey: string;
    readonly requestOrdinal: number;
    readonly requestBytes: number;
  }): Promise<AuthorizedHostedCodexRelay>;
}

export type HostedCodexUpstreamResponse = {
  readonly statusCode: number;
  readonly headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
  readonly body: Readable;
};

export interface HostedCodexStreamingRelayPort {
  /** Owns upstream URL/model/store=false and never returns provider credentials. */
  open(input: {
    readonly authorization: AuthorizedHostedCodexRelay;
    readonly body: Readable;
    readonly contentType: string | undefined;
    readonly accept: string | undefined;
    readonly abortSignal: AbortSignal;
  }): Promise<HostedCodexUpstreamResponse>;
}

export type RegisterHostedCodexRelayRoutesDependencies = {
  readonly enabled: boolean;
  readonly grants: HostedCodexGrantIssuerPort;
  readonly commentTokens: HostedCodexCommentTokenIssuerPort;
  readonly authorization: HostedCodexRelayAuthorizationPort;
  readonly relay: HostedCodexStreamingRelayPort;
};

export async function registerHostedCodexRelayRoutes(
  app: FastifyInstance,
  dependencies: RegisterHostedCodexRelayRoutesDependencies,
): Promise<void> {
  if (!dependencies.enabled) return;

  app.post(hostedCodexGrantPath, async (request, reply) => {
    try {
      const response = await dependencies.grants.issue(
        grantRequestSchema.parse(request.body),
      );
      return reply.header("cache-control", "no-store").send(response);
    } catch (error) {
      return sendSafeError(reply, error, "grant");
    }
  });

  app.post(hostedCodexCommentTokenPath, async (request, reply) => {
    try {
      const body = z
        .object({
          invocationLeaseId: z.string().trim().min(1).max(256),
          bindingId: z.string().trim().min(1).max(160),
          bindingVersion: z.number().int().positive(),
        })
        .strict()
        .parse(request.body);
      return reply.header("cache-control", "no-store").send(
        await dependencies.commentTokens.issue({
          ...body,
          opaqueRefreshCapability: readBearerToken(request),
          idempotencyKey: readRequiredHeader(request, "idempotency-key"),
        }),
      );
    } catch (error) {
      return sendSafeError(reply, error, "grant");
    }
  });

  await app.register(async (scope) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", (request, payload, done) =>
      done(null, payload),
    );

    scope.post(hostedCodexResponsesPath, async (request, reply) => {
      const controller = new AbortController();
      const abort = () =>
        controller.abort(new Error("relay_client_disconnected"));
      const abortPrematureClose = () => {
        if (!reply.raw.writableEnded || request.raw.aborted) abort();
      };
      request.raw.once("aborted", abort);
      reply.raw.once("close", abortPrematureClose);
      try {
        const requestBytes = readContentLength(request);
        const authorization = await dependencies.authorization.authorize({
          opaqueGrant: readBearerToken(request),
          idempotencyKey: readRequiredHeader(request, "idempotency-key"),
          requestOrdinal: readPositiveIntegerHeader(
            request,
            "x-reviewrouter-request-ordinal",
          ),
          requestBytes,
        });
        if (requestBytes > authorization.maxRequestBodyBytes) {
          return reply
            .code(413)
            .send({ error: "relay_request_body_too_large" });
        }
        const upstream = await dependencies.relay.open({
          authorization,
          body: request.body as Readable,
          contentType: readOptionalHeader(request, "content-type"),
          accept: readOptionalHeader(request, "accept"),
          abortSignal: controller.signal,
        });

        reply.hijack();
        reply.raw.statusCode = upstream.statusCode;
        copySafeUpstreamHeaders(reply, upstream.headers);
        await pipeline(upstream.body, reply.raw, { signal: controller.signal });
        return reply;
      } catch (error) {
        if (reply.sent || reply.raw.headersSent) {
          reply.raw.destroy();
          return reply;
        }
        return sendSafeError(reply, error, "relay");
      } finally {
        request.raw.off("aborted", abort);
        reply.raw.off("close", abortPrematureClose);
      }
    });
  });
}

function readBearerToken(request: FastifyRequest): string {
  const value = readRequiredHeader(request, "authorization");
  const match = /^Bearer ([^\s]+)$/i.exec(value);
  if (!match?.[1]) throw new Error("hosted_grant_missing");
  return match[1];
}

function readRequiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`hosted_header_missing:${name}`);
  }
  if (value.length > 512) throw new Error(`hosted_header_too_long:${name}`);
  return value;
}

function readOptionalHeader(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" && value.length <= 512 ? value : undefined;
}

function readPositiveIntegerHeader(
  request: FastifyRequest,
  name: string,
): number {
  const parsed = Number(readRequiredHeader(request, name));
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`hosted_header_invalid:${name}`);
  }
  return parsed;
}

function readContentLength(request: FastifyRequest): number {
  const value = request.headers["content-length"];
  if (value === undefined) throw new Error("hosted_content_length_missing");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("hosted_content_length_invalid");
  }
  return parsed;
}

function copySafeUpstreamHeaders(
  reply: FastifyReply,
  headers: HostedCodexUpstreamResponse["headers"],
): void {
  for (const name of [
    "content-type",
    "cache-control",
    "retry-after",
    "x-request-id",
  ] as const) {
    const value = headers[name];
    if (value !== undefined) reply.raw.setHeader(name, value);
  }
  reply.raw.setHeader("x-content-type-options", "nosniff");
  reply.raw.setHeader("cache-control", "no-store");
}

function sendSafeError(
  reply: FastifyReply,
  error: unknown,
  phase: "grant" | "relay",
): FastifyReply {
  const message = error instanceof Error ? error.message : "unknown";
  const status = message.includes("disabled")
    ? 404
    : message.includes("budget") || message.includes("concurrency")
      ? 429
      : message.includes("not_configured") || message.includes("unavailable")
        ? 503
        : message.includes("invalid") || message.includes("missing")
          ? 401
          : message.includes("not_bound") || message.includes("mismatch")
            ? 403
            : 502;
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .send({ error: `hosted_codex_${phase}_rejected` });
}
