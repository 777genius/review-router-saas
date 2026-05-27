import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  actionConflictReviewDispatchPayloadSchema,
  conflictReviewPostingSessionPath,
  conflictReviewPostingStatusPath,
  conflictReviewPostingSummaryPath,
  conflictReviewSummaryMaxBytes,
  actionHealthReportMaxBytes,
  actionReviewThreadLifecycleResolveRequestSchema,
  defaultActionOidcAudience,
  type ActionRuntimeConfigResponse,
} from "../../domain/action-control-plane.js";
import {
  exchangeGitHubOidcToken,
  type ExchangeGitHubOidcTokenDependencies,
} from "../../application/use-cases/exchange-github-oidc-token.js";
import {
  preleaseCodexRotatingOAuth,
  type PreleaseCodexRotatingOAuthDependencies,
} from "../../application/use-cases/prelease-codex-rotating-oauth.js";
import {
  finalizeCodexRotatingOAuthLease,
  type FinalizeCodexRotatingOAuthLeaseDependencies,
} from "../../application/use-cases/finalize-codex-rotating-oauth-lease.js";
import {
  preflightCodexRotatingOAuthWriteback,
  type PreflightCodexRotatingOAuthWritebackDependencies,
} from "../../application/use-cases/preflight-codex-rotating-oauth-writeback.js";
import {
  writebackCodexRotatingOAuth,
  type WritebackCodexRotatingOAuthDependencies,
} from "../../application/use-cases/writeback-codex-rotating-oauth.js";
import {
  issueCodexRotatingOAuthCheckoutToken,
  type IssueCodexRotatingOAuthCheckoutTokenDependencies,
} from "../../application/use-cases/issue-codex-rotating-oauth-checkout-token.js";
import {
  issueCodexRotatingOAuthCommentToken,
  type IssueCodexRotatingOAuthCommentTokenDependencies,
} from "../../application/use-cases/issue-codex-rotating-oauth-comment-token.js";
import {
  getActionRuntimeConfig,
  type GetActionRuntimeConfigDependencies,
} from "../../application/use-cases/get-action-runtime-config.js";
import {
  issueActionCommentToken,
  type IssueActionCommentTokenDependencies,
} from "../../application/use-cases/issue-action-comment-token.js";
import {
  resolveActionReviewThreadLifecycle,
  type ResolveActionReviewThreadLifecycleDependencies,
} from "../../application/use-cases/resolve-action-review-thread-lifecycle.js";
import {
  postConflictReviewStatus,
  type PostConflictReviewStatusDependencies,
} from "../../application/use-cases/post-conflict-review-status.js";
import {
  postConflictReviewSummary,
  type PostConflictReviewSummaryDependencies,
} from "../../application/use-cases/post-conflict-review-summary.js";
import {
  recordActionHealthReport,
  type RecordActionHealthReportDependencies,
} from "../../application/use-cases/record-action-health-report.js";
import {
  requestConflictReviewPostingSession,
  type RequestConflictReviewPostingSessionDependencies,
} from "../../application/use-cases/request-conflict-review-posting-session.js";
import type { GitHubAppCommentTokenIssuerPort } from "../../application/ports/github-app-comment-token-issuer-port.js";
import type { GitHubReviewThreadLifecycleResolverPort } from "../../application/ports/github-review-thread-lifecycle-resolver-port.js";

export type RegisterActionControlPlaneRoutesDependencies =
  ExchangeGitHubOidcTokenDependencies &
    Partial<PreleaseCodexRotatingOAuthDependencies> &
    Partial<FinalizeCodexRotatingOAuthLeaseDependencies> &
    Partial<PreflightCodexRotatingOAuthWritebackDependencies> &
    Partial<WritebackCodexRotatingOAuthDependencies> &
    Partial<IssueCodexRotatingOAuthCheckoutTokenDependencies> &
    Partial<IssueCodexRotatingOAuthCommentTokenDependencies> &
    GetActionRuntimeConfigDependencies &
    RequestConflictReviewPostingSessionDependencies &
    PostConflictReviewSummaryDependencies &
    PostConflictReviewStatusDependencies &
    RecordActionHealthReportDependencies & {
      readonly commentTokens?: GitHubAppCommentTokenIssuerPort;
      readonly reviewThreadLifecycleResolver?: GitHubReviewThreadLifecycleResolverPort;
      readonly oidcAudience?: string;
      readonly controlPlaneEnabled?: boolean;
    };

const exchangeBodySchema = z
  .object({
    oidcToken: z.string().min(1),
    audience: z.string().min(1).optional(),
    conflictDispatch: actionConflictReviewDispatchPayloadSchema.optional(),
  })
  .strict();

const codexRotatingPreleaseBodySchema = z
  .object({
    oidcToken: z.string().min(1),
    audience: z.string().min(1).optional(),
    providerInstanceId: z.string().min(8).max(160),
    workflowSchemaVersion: z.number().int().positive(),
  })
  .strict();

const codexRotatingFinalizeBodySchema = z
  .object({
    leaseId: z.string().min(8).max(160),
    providerInstanceId: z.string().min(8).max(160),
    restoredGenerationHash: z.string().min(32).max(128),
  })
  .strict();

const codexRotatingWritebackPreflightBodySchema = z
  .object({
    leaseId: z.string().min(8).max(160),
    providerInstanceId: z.string().min(8).max(160),
    githubKeyId: z.string().min(1).max(256),
  })
  .strict();

const codexRotatingLeaseBodySchema = z
  .object({
    leaseId: z.string().min(8).max(160),
    providerInstanceId: z.string().min(8).max(160),
  })
  .strict();

const codexRotatingCommentTokenBodySchema = codexRotatingLeaseBodySchema
  .extend({
    authCleared: z.literal(true),
  })
  .strict();

const conflictPostingSessionBodySchema = z
  .object({
    protocolVersion: z.literal(1),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict();

const conflictPostingSummaryBodySchema = z
  .object({
    protocolVersion: z.literal(1),
    summaryMarkdown: z.string().min(1).max(conflictReviewSummaryMaxBytes),
  })
  .strict();

const conflictPostingStatusBodySchema = z
  .object({
    protocolVersion: z.literal(1),
    state: z.enum(["success", "failure", "error"]),
    description: z.string().min(1).max(140).optional(),
  })
  .strict();

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
            ...(body.conflictDispatch
              ? { conflictDispatchPayload: body.conflictDispatch }
              : {}),
          },
          dependencies,
        );
        return reply.send(result);
      } catch (error) {
        return sendActionError(reply, error, errorFormat);
      }
    };

  const createCodexRotatingPreleaseHandler =
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
      if (!dependencies.codexRotatingOAuth) {
        return sendActionErrorCode(
          reply,
          "codex_rotating_oauth_unavailable",
          503,
          errorFormat,
        );
      }
      if (
        !dependencies.codexRotatingWorkflowSourceVerifier ||
        !dependencies.replayNonces
      ) {
        return sendActionErrorCode(
          reply,
          "codex_rotating_oauth_unavailable",
          503,
          errorFormat,
        );
      }
      try {
        const body = codexRotatingPreleaseBodySchema.parse(request.body);
        const result = await preleaseCodexRotatingOAuth(
          {
            oidcToken: body.oidcToken,
            audience:
              body.audience ??
              dependencies.oidcAudience ??
              defaultActionOidcAudience,
            providerInstanceId: body.providerInstanceId,
            workflowSchemaVersion: body.workflowSchemaVersion,
          },
          dependencies as PreleaseCodexRotatingOAuthDependencies,
        );
        return reply.send(result);
      } catch (error) {
        return sendActionError(reply, error, errorFormat);
      }
    };

  const createCodexRotatingFinalizeHandler =
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
      if (!dependencies.codexRotatingOAuth) {
        return sendActionErrorCode(
          reply,
          "codex_rotating_oauth_unavailable",
          503,
          errorFormat,
        );
      }
      if (!dependencies.codexRotatingSecretsReadTokens) {
        return sendActionErrorCode(
          reply,
          "codex_rotating_oauth_unavailable",
          503,
          errorFormat,
        );
      }
      try {
        const body = codexRotatingFinalizeBodySchema.parse(request.body);
        const result = await finalizeCodexRotatingOAuthLease(
          {
            leaseId: body.leaseId,
            providerInstanceId: body.providerInstanceId,
            restoredGenerationHash: body.restoredGenerationHash,
          },
          dependencies as FinalizeCodexRotatingOAuthLeaseDependencies,
        );
        return reply.send(result);
      } catch (error) {
        return sendActionError(reply, error, errorFormat);
      }
    };

  const createCodexRotatingWritebackPreflightHandler =
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
      if (
        !dependencies.codexRotatingOAuth ||
        !dependencies.codexRotatingSecretWriter
      ) {
        return sendActionErrorCode(
          reply,
          "codex_rotating_oauth_unavailable",
          503,
          errorFormat,
        );
      }
      try {
        const body = codexRotatingWritebackPreflightBodySchema.parse(
          request.body,
        );
        const result = await preflightCodexRotatingOAuthWriteback(
          {
            leaseId: body.leaseId,
            providerInstanceId: body.providerInstanceId,
            githubKeyId: body.githubKeyId,
          },
          dependencies as PreflightCodexRotatingOAuthWritebackDependencies,
        );
        return reply.send(result);
      } catch (error) {
        return sendActionError(reply, error, errorFormat);
      }
    };

  const createCodexRotatingWritebackHandler =
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
      if (
        !dependencies.codexRotatingOAuth ||
        !dependencies.codexRotatingSecretWriter ||
        !dependencies.codexRotatingWritebackHmacKey
      ) {
        return sendActionErrorCode(
          reply,
          "codex_rotating_oauth_unavailable",
          503,
          errorFormat,
        );
      }
      try {
        const result = await writebackCodexRotatingOAuth(
          { body: request.body },
          dependencies as WritebackCodexRotatingOAuthDependencies,
        );
        return reply.send(result);
      } catch (error) {
        return sendActionError(reply, error, errorFormat);
      }
    };

  const createCodexRotatingCheckoutTokenHandler =
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
      if (
        !dependencies.codexRotatingOAuth ||
        !dependencies.codexRotatingCheckoutTokens
      ) {
        return sendActionErrorCode(
          reply,
          "codex_rotating_oauth_unavailable",
          503,
          errorFormat,
        );
      }
      try {
        const body = codexRotatingLeaseBodySchema.parse(request.body);
        const result = await issueCodexRotatingOAuthCheckoutToken(
          {
            leaseId: body.leaseId,
            providerInstanceId: body.providerInstanceId,
          },
          dependencies as IssueCodexRotatingOAuthCheckoutTokenDependencies,
        );
        return reply.send(result);
      } catch (error) {
        return sendActionError(reply, error, errorFormat);
      }
    };

  const createCodexRotatingCommentTokenHandler =
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
      if (!dependencies.codexRotatingOAuth || !dependencies.commentTokens) {
        return sendActionErrorCode(
          reply,
          "codex_rotating_oauth_unavailable",
          503,
          errorFormat,
        );
      }
      try {
        const body = codexRotatingCommentTokenBodySchema.parse(request.body);
        const result = await issueCodexRotatingOAuthCommentToken(
          {
            leaseId: body.leaseId,
            providerInstanceId: body.providerInstanceId,
            authCleared: body.authCleared,
          },
          dependencies as IssueCodexRotatingOAuthCommentTokenDependencies,
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
        const actionVersion = readActionVersion(request);
        const result: ActionRuntimeConfigResponse =
          await getActionRuntimeConfig(
            {
              sessionToken: readBearerToken(request),
              ...(actionVersion ? { actionVersion } : {}),
            },
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

  const createCommentTokenHandler =
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
      if (!dependencies.commentTokens) {
        return sendActionErrorCode(
          reply,
          "comment_token_unavailable",
          503,
          errorFormat,
        );
      }
      try {
        const result = await issueActionCommentToken(
          { sessionToken: readBearerToken(request) },
          dependencies as IssueActionCommentTokenDependencies,
        );
        return reply.send(result);
      } catch (error) {
        return sendActionError(reply, error, errorFormat);
      }
    };

  const createReviewThreadLifecycleResolveHandler =
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
      if (!dependencies.reviewThreadLifecycleResolver) {
        return sendActionErrorCode(
          reply,
          "review_thread_lifecycle_resolver_unavailable",
          503,
          errorFormat,
        );
      }
      try {
        const body = actionReviewThreadLifecycleResolveRequestSchema.parse(
          request.body,
        );
        const result = await resolveActionReviewThreadLifecycle(
          { sessionToken: readBearerToken(request), request: body },
          dependencies as ResolveActionReviewThreadLifecycleDependencies,
        );
        return reply.send(result);
      } catch (error) {
        return sendActionError(reply, error, errorFormat);
      }
    };

  const createConflictPostingSessionHandler =
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
        const body = conflictPostingSessionBodySchema.parse(request.body);
        const result = await requestConflictReviewPostingSession(
          {
            sessionToken: readBearerToken(request),
            protocolVersion: body.protocolVersion,
            manifestHash: body.manifestHash,
          },
          dependencies,
        );
        return reply.send(result);
      } catch (error) {
        return sendActionError(reply, error, errorFormat);
      }
    };

  const createConflictPostingSummaryHandler =
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
        const body = conflictPostingSummaryBodySchema.parse(request.body);
        const result = await postConflictReviewSummary(
          {
            postingSessionToken: readBearerToken(request),
            protocolVersion: body.protocolVersion,
            summaryMarkdown: body.summaryMarkdown,
          },
          dependencies,
        );
        return reply.send(result);
      } catch (error) {
        return sendActionError(reply, error, errorFormat);
      }
    };

  const createConflictPostingStatusHandler =
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
        const body = conflictPostingStatusBodySchema.parse(request.body);
        const result = await postConflictReviewStatus(
          {
            postingSessionToken: readBearerToken(request),
            protocolVersion: body.protocolVersion,
            state: body.state,
            ...(body.description ? { description: body.description } : {}),
          },
          dependencies,
        );
        return reply.send(result);
      } catch (error) {
        return sendActionError(reply, error, errorFormat);
      }
    };

  app.post("/api/action/exchange-token", createExchangeHandler("legacy"));
  app.post("/api/action/v1/session/exchange", createExchangeHandler("v1"));
  app.post(
    "/api/action/v1/codex-oauth/prelease",
    { bodyLimit: 16_384 },
    createCodexRotatingPreleaseHandler("v1"),
  );
  app.post(
    "/api/action/v1/codex-oauth/finalize",
    { bodyLimit: 4_096 },
    createCodexRotatingFinalizeHandler("v1"),
  );
  app.post(
    "/api/action/v1/codex-oauth/writeback-preflight",
    { bodyLimit: 4_096 },
    createCodexRotatingWritebackPreflightHandler("v1"),
  );
  app.post(
    "/api/action/v1/codex-oauth/writeback",
    { bodyLimit: 128 * 1024 },
    createCodexRotatingWritebackHandler("v1"),
  );
  app.post(
    "/api/action/v1/codex-oauth/checkout-token",
    { bodyLimit: 4_096 },
    createCodexRotatingCheckoutTokenHandler("v1"),
  );
  app.post(
    "/api/action/v1/codex-oauth/comment-token",
    { bodyLimit: 4_096 },
    createCodexRotatingCommentTokenHandler("v1"),
  );
  app.get("/api/action/config", createConfigHandler("legacy"));
  app.get("/api/action/v1/config", createConfigHandler("v1"));
  app.post("/api/action/comment-token", createCommentTokenHandler("legacy"));
  app.post("/api/action/v1/comment-token", createCommentTokenHandler("v1"));
  app.post(
    "/api/action/v1/review-thread-lifecycle/resolve",
    createReviewThreadLifecycleResolveHandler("v1"),
  );
  app.post(
    conflictReviewPostingSessionPath,
    { bodyLimit: 2_048 },
    createConflictPostingSessionHandler("v1"),
  );
  app.post(
    conflictReviewPostingSummaryPath,
    { bodyLimit: conflictReviewSummaryMaxBytes + 8_192 },
    createConflictPostingSummaryHandler("v1"),
  );
  app.post(
    conflictReviewPostingStatusPath,
    { bodyLimit: 4_096 },
    createConflictPostingStatusHandler("v1"),
  );
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

function readActionVersion(request: FastifyRequest): string | undefined {
  const header = request.headers["x-reviewrouter-action-version"];
  if (typeof header === "string") {
    return z.string().trim().min(1).max(80).parse(header);
  }
  return undefined;
}

function sendActionError(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  error: unknown,
  format: ActionErrorFormat,
): unknown {
  const message = error instanceof Error ? error.message : "unknown_error";
  const statusCode = statusCodeForActionError(message);
  const code = safeActionErrorCode(message);
  if (process.env.REVIEW_ROUTER_DEBUG_ACTION_ERRORS === "1") {
    console.error(
      JSON.stringify({
        scope: "reviewrouter_action_error",
        code,
        statusCode,
        message: redactDebugActionErrorMessage(message),
      }),
    );
  }
  return sendActionErrorCode(reply, code, statusCode, format);
}

function redactDebugActionErrorMessage(message: string): string {
  return message.replace(/[A-Za-z0-9_-]{80,}/g, "[redacted]").slice(0, 1_000);
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
    message.includes("conflict_review_runtime_disabled") ||
    message.includes("conflict_review_posting_session_unavailable") ||
    message.includes("conflict_review_posting_token_unavailable") ||
    message.includes("codex_rotating_oauth_unavailable")
  ) {
    return 503;
  }
  if (
    message.includes("codex_rotating_lease_not_active") ||
    message.includes("codex_rotating_lease_conflict")
  ) {
    return 409;
  }
  if (
    message.includes("codex_rotating_provider_unknown_auth_state") ||
    message.includes("codex_rotating_provider_needs_reconnect") ||
    message.includes("codex_rotating_provider_permission_required")
  ) {
    return 409;
  }
  if (message.includes("conflict_runtime_provider_unsupported")) {
    return 409;
  }
  if (
    message.includes("conflict_runtime_version_required") ||
    message.includes("conflict_runtime_version_unsupported")
  ) {
    return 426;
  }
  if (message.includes("conflict_review_posting_manifest_invalid")) {
    return 400;
  }
  if (message.includes("conflict_posting_")) {
    return 403;
  }
  if (message.includes("conflict_review_posting_intent_pending")) {
    return 409;
  }
  if (
    message.includes("conflict_review_summary_") ||
    message.includes("conflict_review_status_")
  ) {
    return 400;
  }
  if (message.includes("conflict_review_")) {
    return 403;
  }
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
    message.includes("codex_rotating_not_enabled") ||
    message.includes("codex_legacy_auth_requires_reconnect") ||
    message.includes("codex_provider_requires_rotating_workflow") ||
    message.includes("entitlement_denied") ||
    message.includes("mismatch")
  ) {
    return 403;
  }
  if (message.startsWith("rate_limit_exceeded:")) {
    return 429;
  }
  if (message.startsWith("action_version_blocked:")) {
    return 426;
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
  if (message.includes("conflict_review_runtime_disabled")) {
    return "conflict_review_runtime_disabled";
  }
  if (message.includes("conflict_review_posting_session_unavailable")) {
    return "conflict_review_posting_unavailable";
  }
  if (message.includes("conflict_review_posting_token_unavailable")) {
    return "conflict_review_posting_unavailable";
  }
  if (message.includes("conflict_review_posting_manifest_invalid")) {
    return "invalid_action_request";
  }
  if (message.includes("conflict_runtime_provider_unsupported")) {
    return "conflict_runtime_provider_unsupported";
  }
  if (
    message.includes("conflict_runtime_version_required") ||
    message.includes("conflict_runtime_version_unsupported")
  ) {
    return "conflict_runtime_version_unsupported";
  }
  if (message.includes("conflict_posting_")) {
    return "conflict_review_exchange_denied";
  }
  if (message.includes("conflict_review_posting_intent_pending")) {
    return "conflict_review_posting_pending";
  }
  if (
    message.includes("conflict_review_summary_") ||
    message.includes("conflict_review_status_")
  ) {
    return "invalid_action_request";
  }
  if (message.includes("conflict_review_")) {
    return "conflict_review_exchange_denied";
  }
  if (message.includes("entitlement_denied")) {
    return "action_control_plane_entitlement_denied";
  }
  if (message.includes("codex_rotating_oauth_unavailable")) {
    return "codex_rotating_oauth_unavailable";
  }
  if (message.includes("codex_rotating_lease_not_active")) {
    return "codex_rotating_lease_not_active";
  }
  if (message.includes("codex_rotating_lease_conflict")) {
    return "codex_rotating_lease_conflict";
  }
  if (message.includes("codex_rotating_not_enabled")) {
    return "codex_rotating_not_enabled";
  }
  if (message.includes("codex_legacy_auth_requires_reconnect")) {
    return "codex_legacy_auth_requires_reconnect";
  }
  if (message.includes("codex_provider_requires_rotating_workflow")) {
    return "codex_provider_requires_rotating_workflow";
  }
  if (message.includes("codex_rotating_provider_unknown_auth_state")) {
    return "unknown_auth_state";
  }
  if (message.includes("codex_rotating_provider_needs_reconnect")) {
    return "needs_reconnect";
  }
  if (message.includes("codex_rotating_provider_permission_required")) {
    return "permission_required";
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
  if (message.startsWith("action_version_blocked:")) {
    return "action_version_blocked";
  }
  return "invalid_action_request";
}

function safeActionErrorMessage(code: string): string {
  switch (code) {
    case "action_control_plane_disabled":
      return "ReviewRouter action control plane is temporarily disabled.";
    case "comment_token_unavailable":
      return "ReviewRouter App comment identity is temporarily unavailable.";
    case "codex_rotating_oauth_unavailable":
      return "Codex OAuth rotating writeback is temporarily unavailable.";
    case "codex_rotating_lease_not_active":
      return "Codex OAuth rotating lease is not active for this request.";
    case "codex_rotating_lease_conflict":
      return "Another Codex OAuth run is still active for this repository.";
    case "codex_rotating_not_enabled":
      return "Codex OAuth rotating is not enabled for this repository.";
    case "codex_legacy_auth_requires_reconnect":
      return "Legacy Codex OAuth is disabled. Reconnect Codex from the ReviewRouter dashboard.";
    case "codex_provider_requires_rotating_workflow":
      return "Codex now requires the rotating ReviewRouter Codex workflow. Reconnect Codex from the dashboard.";
    case "unknown_auth_state":
      return "Codex OAuth refreshed but ReviewRouter could not confirm the encrypted writeback. Reconnect the provider.";
    case "needs_reconnect":
      return "Codex OAuth needs to be reconnected for this repository.";
    case "permission_required":
      return "GitHub App permissions must be updated before Codex OAuth can run.";
    case "review_thread_lifecycle_resolver_unavailable":
      return "ReviewRouter review thread resolver is temporarily unavailable.";
    case "repository_not_registered":
      return "Repository is not registered in ReviewRouter.";
    case "repository_not_selected":
      return "Repository is not selected in ReviewRouter.";
    case "installation_not_active":
      return "GitHub App installation is not active for this repository.";
    case "workflow_ref_not_allowed":
      return "Workflow file is not allowed to fetch ReviewRouter runtime config.";
    case "conflict_review_runtime_disabled":
      return "Conflict review runtime is temporarily disabled.";
    case "conflict_review_posting_unavailable":
      return "Conflict review posting is not available for this runtime.";
    case "conflict_review_posting_pending":
      return "Conflict review posting is already in progress for this operation.";
    case "conflict_review_exchange_denied":
      return "Conflict review runtime config exchange was not allowed for this run.";
    case "conflict_runtime_provider_unsupported":
      return "Conflict review runtime currently supports Codex-backed providers only.";
    case "conflict_runtime_version_unsupported":
      return "Conflict review runtime ref is not supported for this run.";
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
    case "action_version_blocked":
      return "Installed ReviewRouter Action version is blocked and must be updated.";
    default:
      if (code.startsWith("health_report_")) {
        return "Action health report was rejected by ReviewRouter safety checks.";
      }
      return "Action control plane request is invalid.";
  }
}

function isRetryableActionError(code: string): boolean {
  return (
    code === "rate_limited" ||
    code === "action_control_plane_disabled" ||
    code === "comment_token_unavailable" ||
    code === "codex_rotating_oauth_unavailable" ||
    code === "codex_rotating_lease_conflict" ||
    code === "conflict_review_runtime_disabled"
  );
}
