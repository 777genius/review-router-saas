import {
  collectPayloadStrings,
  looksLikeCodeOrDiff,
  looksLikeSecretValue,
} from "@reviewrouter/shared";
import { z } from "zod";

export const defaultActionOidcAudience = "reviewrouter";
export const githubActionsOidcIssuer =
  "https://token.actions.githubusercontent.com";
export const actionSessionAudience = "reviewrouter-action-api";
export const actionSessionTtlSeconds = 15 * 60;
export const actionOidcReplayNonceFallbackTtlSeconds = actionSessionTtlSeconds;
export const allowedWorkflowPaths = [
  ".github/workflows/reviewrouter.yml",
] as const;

export const allowedActionEvents = [
  "pull_request",
  "workflow_dispatch",
] as const;

export const githubActionsOidcClaimsSchema = z.object({
  iss: z.literal(githubActionsOidcIssuer),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1),
  repository: z.string().min(1),
  repository_id: z.string().min(1),
  repository_owner: z.string().min(1),
  repository_owner_id: z.string().optional(),
  event_name: z.enum(allowedActionEvents),
  run_id: z.string().min(1),
  run_attempt: z.string().min(1),
  workflow_ref: z.string().min(1),
  job_workflow_ref: z.string().optional(),
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
  readonly githubRunId: string;
  readonly githubRunAttempt: string;
  readonly eventName: (typeof allowedActionEvents)[number];
  readonly protocolVersion: 1;
};

export const actionRuntimeConfigResponseSchema = z.object({
  protocolVersion: z.literal(1),
  configVersion: z.number().int().min(1),
  provider: z.object({
    kind: z.enum(["codex", "openrouter"]),
    authMode: z.enum([
      "codex_subscription_oauth",
      "codex_openai_api_key",
      "openrouter_api_key",
    ]),
    model: z.string().min(1),
    reasoningEffort: z.enum(["low", "medium", "high"]),
    agenticContext: z.boolean(),
    secretBackedProviderEnabled: z.boolean(),
  }),
  blockingPolicy: z.object({
    failOnSeverity: z.enum(["off", "critical", "major"]),
  }),
  limits: z.object({
    inlineMaxComments: z.number().int().min(0).max(50),
    targetTokensPerBatch: z.number().int().min(4000).max(200000),
  }),
  runtimeEnv: z.record(z.string(), z.string()),
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
    pullRequests: z.literal("write"),
    issues: z.literal("write"),
  }),
});

export type ActionCommentTokenResponse = z.infer<
  typeof actionCommentTokenResponseSchema
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
    isAllowedWorkflowRef({
      workflowRef: input.claims.workflow_ref,
      repository: repository.fullName,
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
}): boolean {
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
