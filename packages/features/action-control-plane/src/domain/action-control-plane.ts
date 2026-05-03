import { z } from "zod";

export const defaultActionOidcAudience = "reviewrouter";
export const githubActionsOidcIssuer =
  "https://token.actions.githubusercontent.com";
export const actionSessionAudience = "reviewrouter-action-api";
export const actionSessionTtlSeconds = 15 * 60;
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
  jti: z.string().optional(),
});

export type GitHubActionsOidcClaims = z.infer<
  typeof githubActionsOidcClaimsSchema
>;

export type ActionRepositoryContext = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly githubRepositoryId: string;
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

export const actionHealthReportSchema = z.object({
  actionVersion: z.string().min(1).max(80),
  configVersion: z.number().int().min(1),
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
  safeErrorSummary: z.string().max(500).optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
});

export type ActionHealthReport = z.infer<typeof actionHealthReportSchema>;

export function assertSafeActionHealthReport(
  payload: unknown,
): ActionHealthReport {
  const report = actionHealthReportSchema.parse(payload);
  const serialized = JSON.stringify(report);
  if (Buffer.byteLength(serialized, "utf8") > 4096) {
    throw new Error("health_report_too_large");
  }

  for (const value of collectStrings(report)) {
    if (looksLikeCodeOrDiff(value)) {
      throw new Error("health_report_contains_code_or_diff");
    }
    if (looksLikeSecretValue(value)) {
      throw new Error("health_report_contains_secret_value");
    }
  }

  return report;
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStrings);
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

function looksLikeCodeOrDiff(value: string): boolean {
  return /```|diff --git|@@\s+-\d+|^\+\+\+\s|^---\s/m.test(value);
}

function looksLikeSecretValue(value: string): boolean {
  return (
    /BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY/.test(value) ||
    /\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|AUTH_JSON)[A-Z0-9_]*\s*[:=]\s*\S+/i.test(
      value,
    ) ||
    /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/.test(value)
  );
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
