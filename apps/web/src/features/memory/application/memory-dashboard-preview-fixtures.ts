import type {
  MemoryDashboardItemDto,
  MemoryDashboardSuggestionDto,
  MemoryPolicySimulationDecision,
} from "@reviewrouter/features-memory";
import type { MemoryDashboardRepositoryOption } from "./memory-dashboard-view-model";

export type MemoryDashboardPreviewScenario =
  | "normal"
  | "empty"
  | "readonly"
  | "writes_disabled"
  | "over_quota"
  | "stale_edit"
  | "indexing_degraded";

export type MemoryDashboardPreviewData = {
  readonly workspace: {
    readonly id: string;
  };
  readonly repositories: readonly MemoryDashboardRepositoryOption[];
  readonly memoryItems: readonly MemoryDashboardItemDto[];
  readonly memorySuggestions: readonly MemoryDashboardSuggestionDto[];
  readonly mutationsEnabled: boolean;
  readonly memoryWritesEnabled: boolean;
  readonly policySimulation: readonly MemoryPolicySimulationDecision[];
};

export function buildMemoryDashboardPreviewData(input: {
  readonly scenario: MemoryDashboardPreviewScenario;
}): MemoryDashboardPreviewData {
  const workspace = { id: "workspace_preview" };
  const repositories = buildPreviewRepositories();

  if (input.scenario === "empty") {
    return {
      workspace,
      repositories,
      memoryItems: [],
      memorySuggestions: [],
      mutationsEnabled: true,
      memoryWritesEnabled: true,
      policySimulation: buildPreviewPolicySimulation(),
    };
  }

  const degradedIndex = input.scenario === "indexing_degraded";

  return {
    workspace,
    repositories,
    memoryItems: buildPreviewMemoryItems({ degradedIndex }),
    memorySuggestions: buildPreviewMemorySuggestions(),
    mutationsEnabled: input.scenario !== "readonly",
    memoryWritesEnabled: input.scenario !== "writes_disabled",
    policySimulation: buildPreviewPolicySimulation({
      memoryEnabled: input.scenario !== "writes_disabled",
    }),
  };
}

function buildPreviewPolicySimulation(
  input: { readonly memoryEnabled?: boolean } = {},
): readonly MemoryPolicySimulationDecision[] {
  const memoryEnabled = input.memoryEnabled ?? true;
  return [
    policyDecision({
      action: "direct_save",
      scope: "workspace",
      allowed: memoryEnabled,
      reason: memoryEnabled ? "allowed" : "memory_disabled",
    }),
    policyDecision({
      action: "direct_save",
      scope: "repository",
      repositoryId: "repo_api_gateway",
      allowed: memoryEnabled,
      reason: memoryEnabled ? "allowed" : "memory_disabled",
    }),
    policyDecision({
      action: "propose_suggestion",
      scope: "repository",
      repositoryId: "repo_api_gateway",
      allowed: false,
      reason: memoryEnabled ? "contains_prompt_injection" : "memory_disabled",
      safetyFlags: memoryEnabled ? ["contains_prompt_injection"] : [],
    }),
  ];
}

function buildPreviewRepositories(): readonly MemoryDashboardRepositoryOption[] {
  return [
    repository({ id: "repo_api_gateway", name: "api-gateway" }),
    repository({ id: "repo_payments", name: "payments-api" }),
    repository({ id: "repo_orders", name: "orders-api" }),
    repository({ id: "repo_web", name: "web-app" }),
    repository({ id: "repo_proto", name: "proto-lib" }),
    repository({ id: "repo_shared", name: "shared-utils" }),
    repository({ id: "repo_infra", name: "infra" }),
    repository({ id: "repo_mobile", name: "mobile-app" }),
  ];
}

function policyDecision(input: {
  readonly action: MemoryPolicySimulationDecision["action"];
  readonly scope: MemoryPolicySimulationDecision["scope"];
  readonly repositoryId?: string | null;
  readonly allowed: boolean;
  readonly reason: string;
  readonly safetyFlags?: MemoryPolicySimulationDecision["safety"]["flags"];
}): MemoryPolicySimulationDecision {
  return {
    allowed: input.allowed,
    reason: input.reason,
    retryable: false,
    action: input.action,
    scope: input.scope,
    repositoryId: input.repositoryId ?? null,
    requiredAuthority:
      input.action === "propose_suggestion"
        ? "safe_candidate_source"
        : input.scope === "workspace"
          ? "workspace_admin"
          : "repository_maintainer_or_workspace_admin",
    blockedBy: input.allowed
      ? null
      : input.reason === "memory_disabled"
        ? "policy"
        : "safety",
    policyVersion: 1,
    policyHash: "fnv1a:preview",
    matchedPolicies: [
      "service_memory_flag",
      "workspace_entitlement",
      "memory_policy_config",
    ],
    precedence:
      input.action === "propose_suggestion"
        ? ["scope", "policy", "safety", "pending_quota"]
        : ["scope", "policy", "permission", "safety", "active_quota"],
    invalidates: input.allowed
      ? []
      : input.reason === "memory_disabled"
        ? ["runtime_bundle", "pending_suggestions", "confirmed_memory"]
        : ["pending_suggestions"],
    safety: {
      fixture:
        input.reason === "contains_prompt_injection"
          ? "prompt_injection"
          : "safe_project_rule",
      severity: input.safetyFlags?.length ? "blocked" : "safe",
      riskLevel: input.safetyFlags?.length ? "critical" : "low",
      flags: input.safetyFlags ?? [],
      mayEmbed: !input.safetyFlags?.length,
      mayUseInRuntimeBundle: !input.safetyFlags?.length,
    },
  };
}

function buildPreviewMemoryItems(input: {
  readonly degradedIndex: boolean;
}): readonly MemoryDashboardItemDto[] {
  return [
    memoryItem({
      id: "mem_guard_clauses",
      repositoryId: null,
      scope: "workspace",
      body: "Prefer guard clauses and early returns in service layer methods.",
      confidence: 0.92,
      lastUsedAt: "2026-05-12T09:20:00.000Z",
      source: source({ githubPullRequestNumber: 1287 }),
    }),
    memoryItem({
      id: "mem_parameterized_queries",
      repositoryId: null,
      scope: "workspace",
      body: "Use parameterized queries for all database access.",
      confidence: 0.9,
      source: source({ githubPullRequestNumber: 1231 }),
    }),
    memoryItem({
      id: "mem_secret_storage",
      repositoryId: null,
      scope: "workspace",
      body: "Do not store secrets in env files. Use the secrets manager.",
      confidence: 0.91,
      riskLevel: "medium",
      source: source({ githubPullRequestNumber: 864, type: "pr_comment" }),
    }),
    memoryItem({
      id: "mem_migration_protos",
      repositoryId: "repo_proto",
      scope: "repository",
      body: "Run make generate after changing protobuf definitions.",
      confidence: 0.85,
      source: source({ githubPullRequestNumber: 1102 }),
      updatedAt: "2026-05-11T08:00:00.000Z",
    }),
    memoryItem({
      id: "mem_pnpm",
      repositoryId: "repo_web",
      scope: "repository",
      body: "Front-end packages use pnpm. Do not add package-lock.json.",
      confidence: 0.82,
      indexState: input.degradedIndex ? "index_failed" : "indexed",
      source: source({ githubPullRequestNumber: 1176 }),
      updatedAt: "2026-05-10T10:00:00.000Z",
    }),
    memoryItem({
      id: "mem_json_logging",
      repositoryId: "repo_orders",
      scope: "repository",
      body: "Log structured JSON in services.",
      confidence: 0.78,
      status: "disabled",
      indexState: "index_deleted",
      source: source({ githubPullRequestNumber: 777 }),
      updatedAt: "2026-05-05T10:00:00.000Z",
    }),
    memoryItem({
      id: "mem_function_size",
      repositoryId: null,
      userId: "user_preview",
      scope: "user_prefs",
      body: "Keep functions under 50 lines when possible.",
      confidence: 0.7,
      visibility: "user_preference_runtime",
      source: source({ type: "dashboard", githubPullRequestNumber: null }),
      updatedAt: "2026-05-07T10:00:00.000Z",
    }),
    memoryItem({
      id: "mem_utc",
      repositoryId: null,
      scope: "workspace",
      body: "Prefer UTC timestamps in database records.",
      confidence: 0.6,
      status: "expired",
      source: source({ githubPullRequestNumber: 512 }),
      updatedAt: "2026-04-28T10:00:00.000Z",
      expiresAt: "2026-05-01T00:00:00.000Z",
    }),
  ];
}

function buildPreviewMemorySuggestions(): readonly MemoryDashboardSuggestionDto[] {
  return [
    memorySuggestion({
      id: "suggestion_return_types",
      suggestedScope: "workspace",
      suggestedBody: "Use explicit return types on all public functions.",
      reason: "detected in 3 similar contexts",
      safety: safety({ riskLevel: "low" }),
      source: source({ githubPullRequestNumber: 1287 }),
    }),
    memorySuggestion({
      id: "suggestion_star_imports",
      repositoryId: "repo_web",
      suggestedScope: "repository",
      suggestedBody: "Avoid star imports in TypeScript.",
      reason: "detected in 5 similar contexts",
      safety: safety({ riskLevel: "medium" }),
      source: source({ githubPullRequestNumber: 1285 }),
    }),
    memorySuggestion({
      id: "suggestion_ci_migration",
      suggestedScope: "workspace",
      suggestedBody: "Run database migrations in CI against a clean database.",
      reason: "detected in 2 similar contexts",
      safety: safety({ riskLevel: "medium" }),
      source: source({ githubPullRequestNumber: 1283 }),
    }),
    memorySuggestion({
      id: "suggestion_env_keys",
      repositoryId: "repo_payments",
      suggestedScope: "repository",
      suggestedBody: "Store API keys in .env files for local development.",
      reason: "conflicts with 1 existing memory",
      safety: safety({
        riskLevel: "high",
        severity: "needs_review",
        flags: ["contains_secret_like_text"],
        blockedReason: "Potential secret handling guidance requires review.",
      }),
      source: source({ githubPullRequestNumber: 1279 }),
    }),
    memorySuggestion({
      id: "suggestion_indexes",
      repositoryId: "repo_orders",
      suggestedScope: "repository",
      suggestedBody: "Add indexes for columns used in WHERE clauses.",
      reason: "detected in repeated review comments",
      safety: safety({ riskLevel: "medium" }),
      source: source({ type: "pr_comment", githubPullRequestNumber: null }),
    }),
  ];
}

function repository(input: {
  readonly id: string;
  readonly name: string;
}): MemoryDashboardRepositoryOption {
  return {
    id: input.id,
    name: input.name,
    fullName: `777genius/${input.name}`,
    selected: true,
    archived: false,
  };
}

function memoryItem(
  overrides: Partial<MemoryDashboardItemDto> = {},
): MemoryDashboardItemDto {
  return {
    id: overrides.id ?? "mem_preview",
    workspaceId: overrides.workspaceId ?? "workspace_preview",
    repositoryId:
      overrides.repositoryId === undefined
        ? "repo_api_gateway"
        : overrides.repositoryId,
    userId: overrides.userId ?? null,
    scope: overrides.scope ?? "repository",
    status: overrides.status ?? "active",
    body: overrides.body ?? "Prefer guard clauses.",
    tags: overrides.tags ?? [],
    riskLevel: overrides.riskLevel ?? "low",
    confidence: overrides.confidence ?? 0.9,
    source: overrides.source ?? source({}),
    createdBy: overrides.createdBy ?? "github_user:user_preview",
    confirmedBy: overrides.confirmedBy ?? "github_user:maintainer_preview",
    createdAt: overrides.createdAt ?? "2026-05-01T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-12T10:00:00.000Z",
    lastUsedAt: overrides.lastUsedAt ?? null,
    expiresAt: overrides.expiresAt ?? null,
    version: overrides.version ?? 1,
    visibility: overrides.visibility ?? "repository_runtime",
    originSuggestionId: overrides.originSuggestionId ?? null,
    indexState: overrides.indexState ?? "indexed",
    indexVersion: overrides.indexVersion ?? 3,
  };
}

function memorySuggestion(
  overrides: Partial<MemoryDashboardSuggestionDto> = {},
): MemoryDashboardSuggestionDto {
  return {
    id: overrides.id ?? "suggestion_preview",
    workspaceId: overrides.workspaceId ?? "workspace_preview",
    repositoryId:
      overrides.repositoryId === undefined
        ? "repo_api_gateway"
        : overrides.repositoryId,
    userId: overrides.userId ?? null,
    suggestedScope: overrides.suggestedScope ?? "repository",
    suggestedBody: overrides.suggestedBody ?? "Prefer small PRs.",
    reason: overrides.reason ?? "explicit_natural_language",
    source: overrides.source ?? source({ githubPullRequestNumber: 1287 }),
    safety: overrides.safety ?? safety({}),
    status: overrides.status ?? "pending",
    createdByActor: overrides.createdByActor ?? "github_user:user_preview",
    expiresAt: overrides.expiresAt ?? "2026-05-17T12:00:00.000Z",
    isExpired: overrides.isExpired ?? false,
    relatedMemoryItemId: overrides.relatedMemoryItemId ?? null,
    createdAt: overrides.createdAt ?? "2026-05-12T09:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-12T09:00:00.000Z",
    resolvedAt: overrides.resolvedAt ?? null,
    resolvedBy: overrides.resolvedBy ?? null,
    resolutionReason: overrides.resolutionReason ?? null,
    version: overrides.version ?? 1,
  };
}

function source(
  overrides: Partial<MemoryDashboardItemDto["source"]> = {},
): MemoryDashboardItemDto["source"] {
  return {
    type: overrides.type ?? "pr_comment",
    url: overrides.url ?? null,
    actorLogin: overrides.actorLogin ?? "coder-bot",
    redactedExcerpt: overrides.redactedExcerpt ?? null,
    githubPullRequestNumber:
      overrides.githubPullRequestNumber === undefined
        ? 1287
        : overrides.githubPullRequestNumber,
    sourceVisibility: overrides.sourceVisibility ?? "private",
  };
}

function safety(
  overrides: Partial<MemoryDashboardSuggestionDto["safety"]> = {},
): MemoryDashboardSuggestionDto["safety"] {
  return {
    severity: overrides.severity ?? "safe",
    riskLevel: overrides.riskLevel ?? "low",
    blockedReason: overrides.blockedReason ?? null,
    flags: overrides.flags ?? [],
    mayEmbed: overrides.mayEmbed ?? true,
    mayUseInRuntimeBundle: overrides.mayUseInRuntimeBundle ?? false,
  };
}
