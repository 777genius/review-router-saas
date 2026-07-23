import {
  providerAuthModeSchema,
  providerKindSchema,
  providerAuthModeBelongsToKind,
} from "@reviewrouter/features-review-providers";
import {
  collectPayloadStrings,
  looksLikeCodeOrDiff,
  looksLikeSecretValue,
  safeConflictReviewDispatchId,
  safeGitHubBranchName,
} from "@reviewrouter/shared";
import {
  managedCodexWorkflowPath,
  managedInteractionWorkflowPath,
  managedReviewRouterWorkflowPaths,
} from "@reviewrouter/protocol-review-workflow";
import { z } from "zod";

export {
  legacyReviewRouterWorkflowPath,
  managedCodexWorkflowPath,
  managedInteractionWorkflowPath,
} from "@reviewrouter/protocol-review-workflow";

export const defaultActionOidcAudience = "reviewrouter";
export const actionConflictReviewDispatchEventType =
  "reviewrouter_conflict_review";
export const githubActionsOidcIssuer =
  "https://token.actions.githubusercontent.com";
export const actionSessionAudience = "reviewrouter-action-api";
export const actionConflictReviewPostingSessionAudience =
  "reviewrouter-conflict-posting-api";
export const actionSessionTtlSeconds = 15 * 60;
export const actionConflictReviewPostingSessionTtlSeconds = 5 * 60;
export const actionOidcReplayNonceFallbackTtlSeconds = actionSessionTtlSeconds;
export const allowedWorkflowPaths = managedReviewRouterWorkflowPaths;

export function isManagedV2SessionBootstrapSource(input: {
  readonly eventName: GitHubActionsOidcClaims["event_name"];
  readonly workflowPath: string;
}): boolean {
  if (
    input.workflowPath === managedCodexWorkflowPath &&
    input.eventName === "workflow_dispatch"
  ) {
    return true;
  }
  return (
    input.workflowPath === managedInteractionWorkflowPath &&
    (input.eventName === "issue_comment" ||
      input.eventName === "pull_request_review_comment" ||
      input.eventName === "workflow_dispatch")
  );
}
export const trustedReviewRouterReusableWorkflowRefPattern =
  /^777genius\/review-router\/\.github\/workflows\/(?:reviewrouter(?:-interaction)?-reusable\.ya?ml@(refs\/tags\/v1(?:\.[0-9]+\.[0-9]+)?|refs\/heads\/main|[a-fA-F0-9]{40})|reviewrouter-execution-reusable\.ya?ml@[a-fA-F0-9]{40})$/i;

export const allowedActionEvents = [
  "pull_request",
  "pull_request_target",
  "pull_request_review_comment",
  "issue_comment",
  "workflow_dispatch",
  "schedule",
  "merge_group",
  "repository_dispatch",
] as const;

export const githubActionsOidcClaimsSchema = z.object({
  iss: z.literal(githubActionsOidcIssuer),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1),
  repository: z.string().min(1),
  repository_id: z.string().min(1),
  repository_owner: z.string().min(1),
  repository_owner_id: z.string().optional(),
  repository_visibility: z.string().optional(),
  event_name: z.enum(allowedActionEvents),
  ref: z.string().min(1).optional(),
  run_id: z.string().min(1),
  run_attempt: z.string().min(1),
  workflow_ref: z.string().min(1),
  workflow_sha: z
    .string()
    .regex(/^[a-fA-F0-9]{40}$/)
    .optional(),
  job_workflow_ref: z.string().optional(),
  job_workflow_sha: z
    .string()
    .regex(/^[a-fA-F0-9]{40}$/)
    .optional(),
  runner_environment: z.string().optional(),
  actor: z.string().min(1),
  iat: z.number().optional(),
  nbf: z.number().optional(),
  exp: z.number().optional(),
  jti: z.string().min(1).optional(),
});

export type GitHubActionsOidcClaims = z.infer<
  typeof githubActionsOidcClaimsSchema
>;

export type ActionRepositoryContext = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly githubRepositoryId: string;
  readonly githubInstallationId: string;
  readonly fullName: string;
  readonly owner: string;
  readonly selected: boolean;
  readonly trustedWorkflowRefs?: readonly string[];
  readonly installationStatus:
    | "active"
    | "pending"
    | "suspended"
    | "removed"
    | "permission_error"
    | "sync_error"
    | string;
};

export type ActionSessionClaims = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly githubRepositoryId: string;
  readonly repository: string;
  readonly githubActorLogin: string | null;
  readonly githubRunId: string;
  readonly githubRunAttempt: string;
  readonly eventName: (typeof allowedActionEvents)[number];
  readonly workflowPath?: string;
  readonly reviewKind?: "normal" | "conflict-head";
  readonly conflictDispatchId?: string;
  readonly pullRequestNumber?: number;
  readonly headSha?: string;
  readonly baseRef?: string;
  readonly baseSha?: string;
  readonly configSnapshotId?: string;
  readonly protocolVersion: 1;
};

export type ActionConflictReviewPostingSessionClaims = {
  readonly purpose: "conflict-review-posting";
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly githubRepositoryId: string;
  readonly githubInstallationId: string;
  readonly repository: string;
  readonly githubRunId: string;
  readonly githubRunAttempt: string;
  readonly dispatchId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly configSnapshotId: string;
  readonly manifestHash: string;
  readonly operationScopeHash: string;
  readonly protocolVersion: 1;
};

export type ActionConflictReviewDispatchPayload = {
  readonly protocolVersion: 1;
  readonly dispatchEventType: typeof actionConflictReviewDispatchEventType;
  readonly dispatchId: string;
  readonly nonce: string;
  readonly repositoryId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly fallbackVersion: 1;
};

export const actionConflictReviewDispatchPayloadSchema = z
  .object({
    protocolVersion: z.literal(1).optional(),
    protocol_version: z.literal(1).optional(),
    dispatchEventType: z
      .literal(actionConflictReviewDispatchEventType)
      .optional(),
    dispatch_event_type: z
      .literal(actionConflictReviewDispatchEventType)
      .optional(),
    dispatchId: safeConflictReviewDispatchId.optional(),
    dispatch_id: safeConflictReviewDispatchId.optional(),
    nonce: z.string().min(32).max(160),
    repositoryId: z
      .string()
      .regex(/^[0-9]+$/)
      .optional(),
    repository_id: z
      .string()
      .regex(/^[0-9]+$/)
      .optional(),
    pullRequestNumber: z.number().int().positive().optional(),
    pr_number: z.number().int().positive().optional(),
    headSha: z
      .string()
      .regex(/^[a-fA-F0-9]{40}$/)
      .optional(),
    head_sha: z
      .string()
      .regex(/^[a-fA-F0-9]{40}$/)
      .optional(),
    baseRef: safeGitHubBranchName.optional(),
    base_ref: safeGitHubBranchName.optional(),
    baseSha: z
      .string()
      .regex(/^[a-fA-F0-9]{40}$/)
      .optional(),
    base_sha: z
      .string()
      .regex(/^[a-fA-F0-9]{40}$/)
      .optional(),
    fallbackVersion: z.literal(1).optional(),
    fallback_version: z.literal(1).optional(),
  })
  .strict()
  .transform((payload, context) => {
    const normalized = {
      protocolVersion: coalesceConflictDispatchAlias(
        payload.protocolVersion,
        payload.protocol_version,
        "protocolVersion",
        context,
      ),
      dispatchId: coalesceConflictDispatchAlias(
        payload.dispatchId,
        payload.dispatch_id,
        "dispatchId",
        context,
      ),
      dispatchEventType: coalesceConflictDispatchAlias(
        payload.dispatchEventType,
        payload.dispatch_event_type,
        "dispatchEventType",
        context,
      ),
      nonce: payload.nonce,
      repositoryId: coalesceConflictDispatchAlias(
        payload.repositoryId,
        payload.repository_id,
        "repositoryId",
        context,
      ),
      pullRequestNumber: coalesceConflictDispatchAlias(
        payload.pullRequestNumber,
        payload.pr_number,
        "pullRequestNumber",
        context,
      ),
      headSha: coalesceConflictDispatchAlias(
        payload.headSha,
        payload.head_sha,
        "headSha",
        context,
      ),
      baseRef: coalesceConflictDispatchAlias(
        payload.baseRef,
        payload.base_ref,
        "baseRef",
        context,
      ),
      baseSha: coalesceConflictDispatchAlias(
        payload.baseSha,
        payload.base_sha,
        "baseSha",
        context,
      ),
      fallbackVersion: coalesceConflictDispatchAlias(
        payload.fallbackVersion,
        payload.fallback_version,
        "fallbackVersion",
        context,
      ),
    };
    for (const [key, value] of Object.entries(normalized)) {
      if (value === undefined) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "required",
        });
      }
    }
    return normalized as ActionConflictReviewDispatchPayload;
  });

export function parseActionConflictReviewDispatchPayload(
  input: unknown,
): ActionConflictReviewDispatchPayload {
  return actionConflictReviewDispatchPayloadSchema.parse(input);
}

function coalesceConflictDispatchAlias<T>(
  primary: T | undefined,
  alias: T | undefined,
  path: string,
  context: z.RefinementCtx,
): T | undefined {
  if (primary !== undefined && alias !== undefined) {
    context.addIssue({
      code: "custom",
      path: [path],
      message: "conflicting_aliases",
    });
  }
  return primary ?? alias;
}

const actionRuntimeProviderSchema = z
  .object({
    kind: providerKindSchema,
    authMode: providerAuthModeSchema,
    model: z.string().min(1),
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]),
    agenticContext: z.boolean(),
    fastMode: z.boolean(),
    requiredHealthy: z.boolean().default(false),
    secretBackedProviderEnabled: z.boolean(),
  })
  .superRefine((provider, context) => {
    if (!providerAuthModeBelongsToKind(provider.authMode, provider.kind)) {
      context.addIssue({
        code: "custom",
        path: ["authMode"],
        message: "provider auth mode does not belong to provider kind",
      });
    }
  });

export const conflictReviewRuntimeProtocolVersion = 1;
export const conflictReviewRuntimeDiffMaxFiles = 100;
export const conflictReviewRuntimeDiffMaxBytes = 256 * 1024;
export const conflictReviewRuntimeDiffMaxPatchBytesPerFile = 48 * 1024;
export const conflictReviewAdvisoryStatusContext =
  "ReviewRouter conflict review";
export const conflictReviewPostingSessionPath =
  "/api/action/v1/conflict-posting/session";
export const conflictReviewPostingSummaryPath =
  "/api/action/v1/conflict-posting/summary";
export const conflictReviewPostingStatusPath =
  "/api/action/v1/conflict-posting/status";
export const conflictReviewSummaryMaxBytes = 60_000;

const shaSchema = z.string().regex(/^[a-fA-F0-9]{40}$/);

export const actionConflictReviewRuntimeConfigSchema = z
  .object({
    protocolVersion: z.literal(conflictReviewRuntimeProtocolVersion),
    reviewKind: z.literal("conflict-head"),
    dispatchId: safeConflictReviewDispatchId,
    pullRequestNumber: z.number().int().positive(),
    headSha: shaSchema,
    baseRef: safeGitHubBranchName,
    baseSha: shaSchema,
    checkout: z
      .object({
        mode: z.literal("exact_head_sha"),
        headSha: shaSchema,
        baseRef: safeGitHubBranchName,
        baseSha: shaSchema,
        persistCredentials: z.literal(false),
      })
      .strict(),
    diff: z
      .object({
        mode: z.literal("expected_base_to_head"),
        baseSha: shaSchema,
        headSha: shaSchema,
        maxFiles: z.number().int().positive(),
        maxBytes: z.number().int().positive(),
        maxPatchBytesPerFile: z.number().int().positive(),
      })
      .strict(),
    posting: z.discriminatedUnion("mode", [
      z
        .object({
          mode: z.literal("disabled"),
          reason: z.literal("posting_proxy_not_enabled"),
        })
        .strict(),
      z
        .object({
          mode: z.literal("proxy"),
          sessionEndpoint: z.literal(conflictReviewPostingSessionPath),
          summaryEndpoint: z.literal(conflictReviewPostingSummaryPath),
          statusEndpoint: z.literal(conflictReviewPostingStatusPath),
          allowedOperations: z.tuple([
            z.literal("summary_comment"),
            z.literal("advisory_status"),
          ]),
          summaryMaxBytes: z.literal(conflictReviewSummaryMaxBytes),
          statusContext: z.literal(conflictReviewAdvisoryStatusContext),
        })
        .strict(),
    ]),
  })
  .strict();

export type ActionConflictReviewRuntimeConfig = z.infer<
  typeof actionConflictReviewRuntimeConfigSchema
>;

export function buildActionConflictReviewRuntimeConfig(
  session: ActionSessionClaims,
  options: { readonly postingMode?: "disabled" | "proxy" } = {},
): ActionConflictReviewRuntimeConfig {
  if (session.reviewKind !== "conflict-head") {
    throw new Error("conflict_review_session_required");
  }
  return actionConflictReviewRuntimeConfigSchema.parse({
    protocolVersion: conflictReviewRuntimeProtocolVersion,
    reviewKind: "conflict-head",
    dispatchId: session.conflictDispatchId,
    pullRequestNumber: session.pullRequestNumber,
    headSha: session.headSha,
    baseRef: session.baseRef,
    baseSha: session.baseSha,
    checkout: {
      mode: "exact_head_sha",
      headSha: session.headSha,
      baseRef: session.baseRef,
      baseSha: session.baseSha,
      persistCredentials: false,
    },
    diff: {
      mode: "expected_base_to_head",
      baseSha: session.baseSha,
      headSha: session.headSha,
      maxFiles: conflictReviewRuntimeDiffMaxFiles,
      maxBytes: conflictReviewRuntimeDiffMaxBytes,
      maxPatchBytesPerFile: conflictReviewRuntimeDiffMaxPatchBytesPerFile,
    },
    posting:
      options.postingMode === "proxy"
        ? {
            mode: "proxy",
            sessionEndpoint: conflictReviewPostingSessionPath,
            summaryEndpoint: conflictReviewPostingSummaryPath,
            statusEndpoint: conflictReviewPostingStatusPath,
            allowedOperations: ["summary_comment", "advisory_status"],
            summaryMaxBytes: conflictReviewSummaryMaxBytes,
            statusContext: conflictReviewAdvisoryStatusContext,
          }
        : {
            mode: "disabled",
            reason: "posting_proxy_not_enabled",
          },
  });
}

export const actionRuntimeConfigResponseSchema = z.object({
  protocolVersion: z.literal(1),
  configVersion: z.number().int().min(1),
  provider: actionRuntimeProviderSchema,
  providers: z.array(actionRuntimeProviderSchema).min(1),
  execution: z.object({
    providerLimit: z.number().int().min(1),
    providerMaxParallel: z.number().int().min(1),
    inlineMinAgreement: z.number().int().min(1),
  }),
  blockingPolicy: z.object({
    failOnSeverity: z.enum(["off", "critical", "major"]),
  }),
  limits: z.object({
    inlineMaxComments: z.number().int().min(0).max(50),
    targetTokensPerBatch: z.number().int().min(4000).max(200000),
  }),
  runtimeEnv: z.record(z.string(), z.string()),
  conflictReview: actionConflictReviewRuntimeConfigSchema.optional(),
});

export type ActionRuntimeConfigResponse = z.infer<
  typeof actionRuntimeConfigResponseSchema
>;

export const actionCommentTokenResponseSchema = z.object({
  protocolVersion: z.literal(1),
  token: z.string().min(1),
  expiresAt: z.string().datetime(),
  repository: z.string().min(1),
  permissions: z.object({
    contents: z.literal("read"),
    pullRequests: z.literal("write"),
    issues: z.literal("write"),
  }),
});

export type ActionCommentTokenResponse = z.infer<
  typeof actionCommentTokenResponseSchema
>;

export const actionReviewThreadLifecycleReasonCodeSchema = z.enum([
  "already_resolved",
  "head_sha_changed",
  "human_reply",
  "missing_user_authorization",
  "mutation_failed",
  "mutation_permission_denied",
  "pagination_incomplete",
  "thread_changed_before_mutation",
  "thread_not_found",
  "token_decryption_failed",
  "token_encryption_misconfigured",
  "token_expired",
  "token_refresh_failed",
  "token_revoked",
  "untrusted_author",
  "viewer_cannot_resolve",
]);

export type ActionReviewThreadLifecycleReasonCode = z.infer<
  typeof actionReviewThreadLifecycleReasonCodeSchema
>;

export const actionReviewThreadLifecycleResolveRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    pullRequestNumber: z.number().int().min(1).max(1_000_000),
    reviewedHeadSha: z.string().regex(/^[a-fA-F0-9]{40}$/),
    target: z
      .object({
        targetId: z.string().min(1).max(240),
        threadId: z.string().min(1).max(240),
        fingerprint: z.string().min(8).max(128),
        parentCommentId: z.string().min(1).max(240),
        parentCommentUpdatedAt: z.string().datetime(),
        threadCommentCount: z.number().int().min(1).max(100),
      })
      .strict(),
  })
  .strict();

export type ActionReviewThreadLifecycleResolveRequest = z.infer<
  typeof actionReviewThreadLifecycleResolveRequestSchema
>;

export const actionReviewThreadLifecycleResolveResponseSchema = z
  .object({
    protocolVersion: z.literal(1),
    status: z.enum([
      "resolved",
      "already_resolved",
      "skipped",
      "manual_attention",
      "missing_user_authorization",
      "missing_resolver_permission",
      "failed",
    ]),
    reasonCodes: z
      .array(actionReviewThreadLifecycleReasonCodeSchema)
      .max(16)
      .default([]),
    resolvedBy: z.enum(["github_user", "external"]).optional(),
    errorCode: z.string().max(160).optional(),
  })
  .strict();

export type ActionReviewThreadLifecycleResolveResponse = z.infer<
  typeof actionReviewThreadLifecycleResolveResponseSchema
>;

export const actionHealthReportMaxBytes = 64 * 1024;
const actionHealthCountSchema = z.number().int().min(0).max(10_000);
const actionHealthFindingCountsSchema = z
  .object({
    critical: actionHealthCountSchema,
    major: actionHealthCountSchema,
    minor: actionHealthCountSchema,
    info: actionHealthCountSchema,
  })
  .strict();
const actionHealthCommentCountsSchema = z
  .object({
    inline: actionHealthCountSchema,
    summary: actionHealthCountSchema,
  })
  .strict();

export const actionHealthReportSchema = z
  .object({
    protocolVersion: z.literal(1).default(1),
    actionVersion: z.string().min(1).max(80),
    configVersion: z.number().int().min(1),
    configSource: z
      .enum(["runtime_oidc", "static_fallback", "workflow_static"])
      .optional(),
    providerSetupState: z.enum([
      "unknown",
      "missing",
      "configured",
      "stale_or_invalid",
      "unavailable_in_fork_pr",
    ]),
    providerHealth: z.enum(["ok", "skipped", "failed", "degraded"]),
    safeErrorCategory: z
      .enum([
        "none",
        "oidc_unavailable",
        "config_unavailable",
        "provider_auth_missing",
        "provider_auth_invalid",
        "provider_rate_limited",
        "provider_cli_missing",
        "provider_cli_failed",
        "workflow_incompatible",
        "invalid_provider_config",
        "runtime_error",
      ])
      .default("none"),
    safeErrorSummary: z.string().max(2_000).optional(),
    findingCounts: actionHealthFindingCountsSchema.optional(),
    commentCounts: actionHealthCommentCountsSchema.optional(),
    skippedReasonCategory: z
      .enum([
        "none",
        "fork_pr",
        "draft_pr",
        "bot_pr",
        "provider_auth_missing",
        "provider_unavailable",
        "runtime_config_unavailable",
      ])
      .optional(),
    startedAt: z.string().datetime().optional(),
    finishedAt: z.string().datetime().optional(),
  })
  .strict();

export type ActionHealthReport = z.infer<typeof actionHealthReportSchema>;

export function assertSafeActionHealthReport(
  payload: unknown,
): ActionHealthReport {
  const serialized = serializeHealthReportPayload(payload);
  if (Buffer.byteLength(serialized, "utf8") > actionHealthReportMaxBytes) {
    throw new Error("health_report_too_large");
  }

  for (const value of collectPayloadStrings(payload)) {
    if (looksLikeCodeOrDiff(value)) {
      throw new Error("health_report_contains_code_or_diff");
    }
    if (looksLikeSecretValue(value)) {
      throw new Error("health_report_contains_secret_value");
    }
  }

  return actionHealthReportSchema.parse(payload);
}

function serializeHealthReportPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload);
  if (typeof serialized !== "string") {
    throw new Error("health_report_invalid_payload");
  }
  return serialized;
}

export function validateOidcClaimsAgainstRepository(input: {
  readonly claims: GitHubActionsOidcClaims;
  readonly repository: ActionRepositoryContext;
}): void {
  const claimRepositoryId = input.claims.repository_id;
  const repository = input.repository;
  if (repository.selected !== true) {
    throw new Error("repository_not_selected");
  }
  if (repository.installationStatus !== "active") {
    throw new Error("installation_not_active");
  }
  if (claimRepositoryId !== repository.githubRepositoryId) {
    throw new Error("repository_id_mismatch");
  }
  if (
    input.claims.repository.toLowerCase() !== repository.fullName.toLowerCase()
  ) {
    throw new Error("repository_name_mismatch");
  }
  if (
    input.claims.repository_owner.toLowerCase() !==
    repository.owner.toLowerCase()
  ) {
    throw new Error("repository_owner_mismatch");
  }
  if (
    input.claims.event_name === "repository_dispatch" &&
    input.claims.runner_environment !== undefined &&
    input.claims.runner_environment !== "github-hosted"
  ) {
    throw new Error("workflow_ref_not_allowed");
  }
  if (
    input.claims.event_name === "repository_dispatch" &&
    isAllowedConflictReviewWorkflowIdentity({
      workflowRef: input.claims.workflow_ref,
      jobWorkflowRef: input.claims.job_workflow_ref,
      repository: repository.fullName,
    }) === false
  ) {
    throw new Error("workflow_ref_not_allowed");
  }
  if (
    input.claims.event_name !== "repository_dispatch" &&
    isAllowedOidcWorkflowIdentity({
      workflowRef: input.claims.workflow_ref,
      jobWorkflowRef: input.claims.job_workflow_ref,
      repository: repository.fullName,
      ...(repository.trustedWorkflowRefs
        ? { trustedWorkflowRefs: repository.trustedWorkflowRefs }
        : {}),
    }) === false
  ) {
    throw new Error("workflow_ref_not_allowed");
  }
}

export function validateActionSessionAgainstRepository(input: {
  readonly session: ActionSessionClaims;
  readonly repository: ActionRepositoryContext;
}): void {
  const repository = input.repository;
  if (repository.selected !== true) {
    throw new Error("repository_not_selected");
  }
  if (repository.installationStatus !== "active") {
    throw new Error("installation_not_active");
  }
  if (input.session.githubRepositoryId !== repository.githubRepositoryId) {
    throw new Error("repository_id_mismatch");
  }
  if (input.session.repositoryId !== repository.repositoryId) {
    throw new Error("repository_id_mismatch");
  }
  if (
    input.session.repository.toLowerCase() !== repository.fullName.toLowerCase()
  ) {
    throw new Error("repository_name_mismatch");
  }
}

export function buildActionOidcReplayNonceKey(
  claims: GitHubActionsOidcClaims,
): string {
  if (!claims.jti) {
    throw new Error("oidc_jti_required");
  }
  return `${claims.iss}:${claims.jti}`;
}

export function resolveActionOidcReplayNonceExpiresAt(input: {
  readonly claims: GitHubActionsOidcClaims;
  readonly now: Date;
}): Date {
  if (typeof input.claims.exp === "number" && input.claims.exp > 0) {
    return new Date(input.claims.exp * 1000);
  }

  return new Date(
    input.now.getTime() + actionOidcReplayNonceFallbackTtlSeconds * 1000,
  );
}

export function isAllowedWorkflowRef(input: {
  readonly workflowRef: string;
  readonly repository: string;
  readonly allowedPaths?: readonly string[];
  readonly trustedWorkflowRefs?: readonly string[];
}): boolean {
  if (
    input.trustedWorkflowRefs?.some(
      (workflowRef) =>
        workflowRef.toLowerCase() === input.workflowRef.toLowerCase(),
    )
  ) {
    return true;
  }

  const atIndex = input.workflowRef.indexOf("@");
  if (atIndex <= 0) {
    return false;
  }

  const workflowIdentity = input.workflowRef.slice(0, atIndex);
  const repositoryPrefix = `${input.repository}/`;
  if (
    workflowIdentity.slice(0, repositoryPrefix.length).toLowerCase() !==
    repositoryPrefix.toLowerCase()
  ) {
    return false;
  }

  const path = workflowIdentity.slice(repositoryPrefix.length);
  const allowedPaths = input.allowedPaths ?? allowedWorkflowPaths;
  return allowedPaths.includes(path);
}

export function isAllowedOidcWorkflowIdentity(input: {
  readonly workflowRef: string;
  readonly jobWorkflowRef?: string | undefined;
  readonly repository: string;
  readonly allowedPaths?: readonly string[];
  readonly trustedWorkflowRefs?: readonly string[];
}): boolean {
  const jobWorkflowRef = input.jobWorkflowRef?.trim();
  if (
    jobWorkflowRef &&
    jobWorkflowRef.toLowerCase() !== input.workflowRef.toLowerCase()
  ) {
    if (!isTrustedWorkflowRef(jobWorkflowRef, input.trustedWorkflowRefs)) {
      return false;
    }

    return isAllowedWorkflowRef({
      workflowRef: input.workflowRef,
      repository: input.repository,
      ...(input.allowedPaths ? { allowedPaths: input.allowedPaths } : {}),
      ...(input.trustedWorkflowRefs
        ? { trustedWorkflowRefs: input.trustedWorkflowRefs }
        : {}),
    });
  }

  return isAllowedWorkflowRef({
    workflowRef: input.workflowRef,
    repository: input.repository,
    ...(input.allowedPaths ? { allowedPaths: input.allowedPaths } : {}),
    ...(input.trustedWorkflowRefs
      ? { trustedWorkflowRefs: input.trustedWorkflowRefs }
      : {}),
  });
}

function isTrustedWorkflowRef(
  workflowRef: string,
  trustedWorkflowRefs: readonly string[] | undefined,
): boolean {
  if (trustedReviewRouterReusableWorkflowRefPattern.test(workflowRef)) {
    return true;
  }

  return (
    trustedWorkflowRefs?.some(
      (trustedRef) => trustedRef.toLowerCase() === workflowRef.toLowerCase(),
    ) ?? false
  );
}

function isAllowedConflictReviewWorkflowIdentity(input: {
  readonly workflowRef: string;
  readonly jobWorkflowRef?: string | undefined;
  readonly repository: string;
}): boolean {
  if (!input.jobWorkflowRef) {
    return false;
  }
  if (!isTrustedConflictReviewReusableWorkflowRef(input.jobWorkflowRef)) {
    return false;
  }
  return isAllowedWorkflowRef({
    workflowRef: input.workflowRef,
    repository: input.repository,
    allowedPaths: [".github/workflows/reviewrouter.yml"],
  });
}

function isTrustedConflictReviewReusableWorkflowRef(
  workflowRef: string,
): boolean {
  if (
    /^777genius\/review-router\/\.github\/workflows\/reviewrouter-conflict-reusable\.ya?ml@(refs\/tags\/v1(?:\.[0-9]+\.[0-9]+)?|[a-fA-F0-9]{40})$/i.test(
      workflowRef,
    )
  ) {
    return true;
  }
  return false;
}
