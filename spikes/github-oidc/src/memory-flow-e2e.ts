import {
  defaultActionOidcAudience,
  githubActionsOidcIssuer,
  JoseActionSessionTokenService,
  PrismaActionControlPlaneRepository,
  PrismaActionOidcReplayNonceStore,
  type GitHubActionsOidcClaims,
  type GitHubActionsOidcTokenVerifierPort,
} from "../../../packages/features/action-control-plane/src/index.ts";
import {
  buildActionMemoryBundle,
  createMemoryBodyHash,
  deletedMemoryBodyPlaceholder,
  exportMemoryItems,
  PrismaMemoryItemRepository,
  PrismaMemoryPermission,
  PrismaMemorySearchIndex,
  PrismaMemorySuggestionRepository,
  PrismaMemoryTransaction,
  StaticMemoryPolicyConfig,
} from "../../../packages/features/memory/src/index.ts";
import {
  freeBetaEntitlement,
  PrismaEntitlementRepository,
} from "../../../packages/features/entitlements/src/index.ts";
import { createMemoryOutboxHandlers } from "../../../packages/features/memory/src/infrastructure/outbox/memory-index-outbox-handlers.ts";
import {
  PrismaOutboxEventRepository,
  processOutboxBatch,
} from "../../../packages/features/outbox/src/index.ts";
import { createPrismaClient } from "../../../packages/platform/db/src/index.ts";
import { PostgresLeaseLock } from "../../../packages/platform/locks/src/index.ts";
import { SystemClock } from "../../../packages/shared/src/index.ts";
import { createApiApp } from "../../../apps/api/src/app.js";
import {
  createMemoryItemExpiryMaintenance,
  createMemorySuggestionExpiryMaintenance,
  createMemoryTerminalItemPruneMaintenance,
} from "../../../apps/worker/src/memory-maintenance.ts";
import { loadEnvFiles } from "./config.js";

loadEnvFiles();

type RepositoryFixture = {
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly repositoryId: string;
  readonly owner: string;
  readonly fullName: string;
  readonly githubRepositoryId: bigint;
};

type ActionSessionResponse = {
  readonly protocolVersion: 1;
  readonly sessionToken: string;
  readonly repository: string;
};

type MemoryMutationResponse = {
  readonly protocolVersion: 1;
  readonly status: string;
  readonly id?: string;
  readonly version?: number;
  readonly reason?: string;
};

type MemoryCommandResponse = {
  readonly protocolVersion: 1;
  readonly results: readonly (MemoryMutationResponse & {
    readonly kind: string;
  })[];
};

type ActionMemoryBundle = {
  readonly protocolVersion: 1;
  readonly memoryVersion: number;
  readonly degraded: boolean;
  readonly reason: string | null;
  readonly items: readonly {
    readonly id: string;
    readonly scope: string;
    readonly body: string;
  }[];
};

class TokenMapOidcVerifier implements GitHubActionsOidcTokenVerifierPort {
  constructor(
    private readonly tokenClaims: ReadonlyMap<string, GitHubActionsOidcClaims>,
  ) {}

  async verify(input: {
    readonly token: string;
    readonly audience: string;
  }): Promise<GitHubActionsOidcClaims> {
    if (input.audience !== defaultActionOidcAudience) {
      throw new Error("unexpected_oidc_audience");
    }
    const claims = this.tokenClaims.get(input.token);
    if (!claims) {
      throw new Error("unexpected_oidc_token");
    }
    return claims;
  }
}

const marker = Date.now().toString();
const suffix = marker.slice(-10);
const adminLogin = `rr-memory-admin-${suffix}`;
const memberLogin = `rr-memory-member-${suffix}`;
const otherAdminLogin = `rr-memory-other-admin-${suffix}`;
const quotaAdminLogin = `rr-memory-quota-admin-${suffix}`;
const disabledAdminLogin = `rr-memory-disabled-admin-${suffix}`;
const actionSessionSecret =
  process.env.REVIEW_ROUTER_ACTION_SESSION_SECRET ??
  process.env.AUTH_SECRET ??
  "0123456789abcdef0123456789abcdef";
const noopWorkerLogger = {
  info(): void {
    return undefined;
  },
  warn(): void {
    return undefined;
  },
};

const prisma = createPrismaClient();
let app: Awaited<ReturnType<typeof createApiApp>> | null = null;
const workspaceSlugs: string[] = [];

try {
  const primary = await createRepositoryFixture({
    workspaceSlug: `rr-memory-e2e-${suffix}`,
    workspaceName: `Memory E2E ${suffix}`,
    installationGithubId: BigInt(`93${suffix}`),
    repositoryGithubId: BigInt(`94${suffix}`),
    owner: "review-router-memory-e2e",
    name: `repo-${suffix}`,
    adminLogin,
    memberLogin,
  });
  workspaceSlugs.push(primary.workspaceSlug);

  const other = await createRepositoryFixture({
    workspaceSlug: `rr-memory-e2e-other-${suffix}`,
    workspaceName: `Memory E2E Other ${suffix}`,
    installationGithubId: BigInt(`95${suffix}`),
    repositoryGithubId: BigInt(`96${suffix}`),
    owner: "review-router-memory-e2e-other",
    name: `repo-${suffix}`,
    adminLogin: otherAdminLogin,
  });
  workspaceSlugs.push(other.workspaceSlug);

  const quota = await createRepositoryFixture({
    workspaceSlug: `rr-memory-e2e-quota-${suffix}`,
    workspaceName: `Memory E2E Quota ${suffix}`,
    installationGithubId: BigInt(`97${suffix}`),
    repositoryGithubId: BigInt(`98${suffix}`),
    owner: "review-router-memory-e2e-quota",
    name: `repo-${suffix}`,
    adminLogin: quotaAdminLogin,
  });
  workspaceSlugs.push(quota.workspaceSlug);

  const disabled = await createRepositoryFixture({
    workspaceSlug: `rr-memory-e2e-disabled-${suffix}`,
    workspaceName: `Memory E2E Disabled ${suffix}`,
    installationGithubId: BigInt(`99${suffix}`),
    repositoryGithubId: BigInt(`90${suffix}`),
    owner: "review-router-memory-e2e-disabled",
    name: `repo-${suffix}`,
    adminLogin: disabledAdminLogin,
  });
  workspaceSlugs.push(disabled.workspaceSlug);

  const disabledEntitlement = freeBetaEntitlement(disabled.workspaceId);
  await new PrismaEntitlementRepository(prisma).upsertWorkspaceEntitlement({
    ...disabledEntitlement,
    flags: { ...disabledEntitlement.flags, balanced_memory: false },
  });

  const quotaEntitlement = freeBetaEntitlement(quota.workspaceId);
  await new PrismaEntitlementRepository(prisma).upsertWorkspaceEntitlement({
    ...quotaEntitlement,
    limits: {
      ...quotaEntitlement.limits,
      maxActiveMemoryItemsPerWorkspace: 1,
      maxPendingMemorySuggestionsPerWorkspace: 1,
    },
  });

  const tokenClaims = new Map<string, GitHubActionsOidcClaims>([
    [
      "admin-interaction",
      claims({
        token: "admin-interaction",
        repository: primary,
        actor: adminLogin,
        eventName: "issue_comment",
        runSuffix: "admin-interaction",
        workflowPath: ".github/workflows/reviewrouter-interaction.yml",
      }),
    ],
    [
      "member-interaction",
      claims({
        token: "member-interaction",
        repository: primary,
        actor: memberLogin,
        eventName: "issue_comment",
        runSuffix: "member-interaction",
        workflowPath: ".github/workflows/reviewrouter-interaction.yml",
      }),
    ],
    [
      "other-admin-interaction",
      claims({
        token: "other-admin-interaction",
        repository: other,
        actor: otherAdminLogin,
        eventName: "issue_comment",
        runSuffix: "other-admin-interaction",
        workflowPath: ".github/workflows/reviewrouter-interaction.yml",
      }),
    ],
    [
      "quota-admin-interaction",
      claims({
        token: "quota-admin-interaction",
        repository: quota,
        actor: quotaAdminLogin,
        eventName: "issue_comment",
        runSuffix: "quota-admin-interaction",
        workflowPath: ".github/workflows/reviewrouter-interaction.yml",
      }),
    ],
    [
      "disabled-admin-interaction",
      claims({
        token: "disabled-admin-interaction",
        repository: disabled,
        actor: disabledAdminLogin,
        eventName: "issue_comment",
        runSuffix: "disabled-admin-interaction",
        workflowPath: ".github/workflows/reviewrouter-interaction.yml",
      }),
    ],
    [
      "disabled-review",
      claims({
        token: "disabled-review",
        repository: disabled,
        actor: disabledAdminLogin,
        eventName: "pull_request",
        runSuffix: "disabled-review",
        workflowPath: ".github/workflows/reviewrouter.yml",
      }),
    ],
    [
      "primary-review-before-disable",
      claims({
        token: "primary-review-before-disable",
        repository: primary,
        actor: adminLogin,
        eventName: "pull_request",
        runSuffix: "review-before-disable",
        workflowPath: ".github/workflows/reviewrouter.yml",
      }),
    ],
    [
      "primary-review-after-disable",
      claims({
        token: "primary-review-after-disable",
        repository: primary,
        actor: adminLogin,
        eventName: "pull_request",
        runSuffix: "review-after-disable",
        workflowPath: ".github/workflows/reviewrouter.yml",
      }),
    ],
  ]);

  app = await createApiApp({
    prisma,
    actionControlPlaneDependencies: {
      repositories: new PrismaActionControlPlaneRepository(prisma),
      replayNonces: new PrismaActionOidcReplayNonceStore(prisma),
      oidcVerifier: new TokenMapOidcVerifier(tokenClaims),
      sessions: new JoseActionSessionTokenService(actionSessionSecret),
      clock: new SystemClock(),
      oidcAudience: defaultActionOidcAudience,
    },
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  const adminSession = await exchange(baseUrl, "admin-interaction");
  const memberSession = await exchange(baseUrl, "member-interaction");
  const otherAdminSession = await exchange(baseUrl, "other-admin-interaction");
  const quotaAdminSession = await exchange(baseUrl, "quota-admin-interaction");
  const disabledAdminSession = await exchange(
    baseUrl,
    "disabled-admin-interaction",
  );
  const disabledReviewSession = await exchange(baseUrl, "disabled-review");

  const disabledBundle = await getJson<ActionMemoryBundle>(
    baseUrl,
    "/api/action/v1/memory",
    disabledReviewSession.sessionToken,
  );
  assertEqual(
    disabledBundle.degraded,
    true,
    "disabled workspace bundle degraded",
  );
  assertEqual(
    disabledBundle.reason,
    "memory_disabled",
    "disabled workspace bundle reason",
  );
  assertEqual(
    disabledBundle.items.length,
    0,
    "disabled workspace bundle items",
  );
  const disabledCandidate = await postCandidate(baseUrl, disabledAdminSession, {
    sourceId: `memory-e2e-disabled-candidate-${suffix}`,
    body: "Disabled workspace must not save memory.",
    intent: "explicit_command",
    extractionMethod: "explicit_command",
    requestedScope: "repository",
  });
  assertEqual(
    disabledCandidate.status,
    "rejected",
    "disabled workspace candidate status",
  );
  assertEqual(
    disabledCandidate.reason,
    "memory_disabled",
    "disabled workspace candidate reason",
  );

  const quotaFirstItem = await postCandidate(baseUrl, quotaAdminSession, {
    sourceId: `memory-e2e-quota-first-${suffix}`,
    body: "Quota workspace keeps exactly one active memory item.",
    intent: "explicit_command",
    extractionMethod: "explicit_command",
    requestedScope: "repository",
  });
  assertEqual(quotaFirstItem.status, "created", "quota first memory status");
  assertPresent(quotaFirstItem.id, "quota first memory id");

  const quotaRejectedItem = await postCandidate(baseUrl, quotaAdminSession, {
    sourceId: `memory-e2e-quota-second-${suffix}`,
    body: "Quota workspace must reject the second active memory item.",
    intent: "explicit_command",
    extractionMethod: "explicit_command",
    requestedScope: "repository",
  });
  assertEqual(quotaRejectedItem.status, "rejected", "quota active item status");
  assertEqual(
    quotaRejectedItem.reason,
    "memory_active_item_quota_exceeded",
    "quota active item reason",
  );

  const quotaSuggestion = await postCandidate(baseUrl, quotaAdminSession, {
    sourceId: `memory-e2e-quota-suggestion-${suffix}`,
    body: "Quota workspace keeps exactly one pending memory suggestion.",
    intent: "model_suggested_candidate",
    extractionMethod: "model_suggested_candidate",
    requestedScope: "repository",
  });
  assertEqual(quotaSuggestion.status, "created", "quota first suggestion");
  assertPresent(quotaSuggestion.id, "quota suggestion id");

  const quotaRejectedSuggestion = await postCandidate(
    baseUrl,
    quotaAdminSession,
    {
      sourceId: `memory-e2e-quota-suggestion-overflow-${suffix}`,
      body: "Quota workspace must reject the second pending suggestion.",
      intent: "model_suggested_candidate",
      extractionMethod: "model_suggested_candidate",
      requestedScope: "repository",
    },
  );
  assertEqual(
    quotaRejectedSuggestion.status,
    "rejected",
    "quota pending suggestion status",
  );
  assertEqual(
    quotaRejectedSuggestion.reason,
    "memory_pending_suggestion_quota_exceeded",
    "quota pending suggestion reason",
  );

  const quotaConfirm = await postCommands(baseUrl, quotaAdminSession, [
    { kind: "confirm_suggestion", suggestionId: quotaSuggestion.id },
  ]);
  assertEqual(
    quotaConfirm.results[0]?.status,
    "rejected",
    "quota confirm status",
  );
  assertEqual(
    quotaConfirm.results[0]?.reason,
    "memory_active_item_quota_exceeded",
    "quota confirm reason",
  );
  const quotaCounts = await Promise.all([
    prisma.memoryItem.count({
      where: { workspaceId: quota.workspaceId, status: "active" },
    }),
    prisma.memorySuggestion.count({
      where: { workspaceId: quota.workspaceId, status: "pending" },
    }),
  ]);
  assertEqual(quotaCounts[0], 1, "quota active item count");
  assertEqual(quotaCounts[1], 1, "quota pending suggestion count");

  const memberDenied = await postCandidate(baseUrl, memberSession, {
    sourceId: `memory-e2e-member-denied-${suffix}`,
    body: "Member role must not be able to save repository memory.",
    intent: "explicit_command",
    extractionMethod: "explicit_command",
    requestedScope: "repository",
  });
  assertEqual(memberDenied.status, "rejected", "member memory write status");
  assertEqual(
    memberDenied.reason,
    "not_repository_maintainer",
    "member memory write reason",
  );

  const rawPayload = await postJson<{
    readonly error: { readonly code: string };
  }>(
    baseUrl,
    "/api/action/v1/memory-candidates",
    adminSession.sessionToken,
    {
      protocolVersion: 1,
      intent: "explicit_command",
      requestedScope: "repository",
      candidateBody: "This request includes a forbidden raw prompt field.",
      extractionMethod: "explicit_command",
      rawPrompt: "do not accept raw prompt",
      source: memorySource({
        repositoryFullName: primary.fullName,
        sourceId: `memory-e2e-forbidden-${suffix}`,
        body: "redacted",
      }),
    },
    400,
  );
  assertEqual(
    rawPayload.error.code,
    "forbidden_action_memory_raw_field",
    "forbidden raw payload code",
  );

  const repoItem = await postCandidate(baseUrl, adminSession, {
    sourceId: `memory-e2e-repo-${suffix}`,
    body: "Prefer guard clauses in service methods.",
    intent: "explicit_command",
    extractionMethod: "explicit_command",
    requestedScope: "repository",
  });
  assertEqual(repoItem.status, "created", "repository direct memory status");
  const repoMemoryItemId = repoItem.id;
  assertPresent(repoMemoryItemId, "repository memory id");

  const workspaceItem = await postCandidate(baseUrl, adminSession, {
    sourceId: `memory-e2e-workspace-${suffix}`,
    body: "Use Prisma migrations for schema changes.",
    intent: "explicit_command",
    extractionMethod: "explicit_command",
    requestedScope: "workspace",
  });
  assertEqual(
    workspaceItem.status,
    "created",
    "workspace direct memory status",
  );
  const workspaceMemoryItemId = workspaceItem.id;
  assertPresent(workspaceMemoryItemId, "workspace memory id");

  const suggestion = await postCandidate(baseUrl, adminSession, {
    sourceId: `memory-e2e-suggestion-${suffix}`,
    body: "Run dashboard memory changes through browser layout checks.",
    intent: "model_suggested_candidate",
    extractionMethod: "model_suggested_candidate",
    requestedScope: "repository",
  });
  assertEqual(suggestion.status, "created", "suggestion status");
  assertPresent(suggestion.id, "suggestion id");

  const editedSourceId = `memory-e2e-edited-suggestion-${suffix}`;
  const staleEditedSuggestion = await postCandidate(baseUrl, adminSession, {
    sourceId: editedSourceId,
    body: "Stale edited comment memory should be superseded.",
    intent: "model_suggested_candidate",
    extractionMethod: "model_suggested_candidate",
    requestedScope: "repository",
  });
  assertEqual(
    staleEditedSuggestion.status,
    "created",
    "stale edited suggestion status",
  );
  assertPresent(staleEditedSuggestion.id, "stale edited suggestion id");
  const currentEditedSuggestion = await postCandidate(baseUrl, adminSession, {
    sourceId: editedSourceId,
    body: "Current edited comment memory stays pending.",
    intent: "model_suggested_candidate",
    extractionMethod: "model_suggested_candidate",
    requestedScope: "repository",
  });
  assertEqual(
    currentEditedSuggestion.status,
    "created",
    "current edited suggestion status",
  );
  assertPresent(currentEditedSuggestion.id, "current edited suggestion id");
  const staleEditedRecord = await prisma.memorySuggestion.findUnique({
    where: { id: staleEditedSuggestion.id },
    select: {
      status: true,
      relatedSuggestionId: true,
      resolvedBy: true,
      resolutionReason: true,
    },
  });
  assertEqual(
    staleEditedRecord?.status,
    "superseded",
    "edited source stale suggestion status",
  );
  assertEqual(
    staleEditedRecord?.relatedSuggestionId,
    currentEditedSuggestion.id,
    "edited source replacement suggestion id",
  );
  assertEqual(
    staleEditedRecord?.resolutionReason,
    "superseded",
    "edited source stale suggestion reason",
  );
  const staleEditedConfirm = await postCommands(baseUrl, adminSession, [
    { kind: "confirm_suggestion", suggestionId: staleEditedSuggestion.id },
  ]);
  assertEqual(
    staleEditedConfirm.results[0]?.status,
    "noop",
    "superseded suggestion confirm status",
  );
  assertEqual(
    staleEditedConfirm.results[0]?.reason,
    "superseded",
    "superseded suggestion confirm reason",
  );
  const supersededAudit = await prisma.auditEvent.findMany({
    where: {
      workspaceId: primary.workspaceId,
      action: "memory.suggestion.superseded",
      targetId: staleEditedSuggestion.id,
    },
    select: { metadata: true },
  });
  assertEqual(supersededAudit.length, 1, "superseded suggestion audit count");
  assertStringDoesNotContain(
    JSON.stringify(supersededAudit),
    "Stale edited comment memory should be superseded.",
    "superseded audit must not contain stale suggestion body",
  );

  const confirm = await postCommands(baseUrl, adminSession, [
    { kind: "confirm_suggestion", suggestionId: suggestion.id },
  ]);
  assertEqual(confirm.results[0]?.status, "created", "confirm suggestion");
  const confirmedMemoryItemId = confirm.results[0]?.id;
  assertPresent(confirmedMemoryItemId, "confirmed memory item id");

  const otherRepoItem = await postCandidate(baseUrl, otherAdminSession, {
    sourceId: `memory-e2e-other-repo-${suffix}`,
    body: "Other workspace browser layout memory must never leak.",
    intent: "explicit_command",
    extractionMethod: "explicit_command",
    requestedScope: "repository",
  });
  assertPresent(otherRepoItem.id, "other workspace memory id");

  const otherSuggestion = await postCandidate(baseUrl, otherAdminSession, {
    sourceId: `memory-e2e-other-suggestion-${suffix}`,
    body: "Other workspace suggestion must never be confirmable.",
    intent: "model_suggested_candidate",
    extractionMethod: "model_suggested_candidate",
    requestedScope: "repository",
  });
  assertPresent(otherSuggestion.id, "other workspace suggestion id");

  const staleConfirmSuggestion = await postCandidate(baseUrl, adminSession, {
    sourceId: `memory-e2e-stale-confirm-suggestion-${suffix}`,
    body: "TTL expired suggestion must not confirm before maintenance.",
    intent: "model_suggested_candidate",
    extractionMethod: "model_suggested_candidate",
    requestedScope: "repository",
  });
  assertEqual(
    staleConfirmSuggestion.status,
    "created",
    "stale confirm suggestion",
  );
  assertPresent(staleConfirmSuggestion.id, "stale confirm suggestion id");
  await prisma.memorySuggestion.update({
    where: { id: staleConfirmSuggestion.id },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  const staleConfirm = await postCommands(baseUrl, adminSession, [
    { kind: "confirm_suggestion", suggestionId: staleConfirmSuggestion.id },
  ]);
  assertEqual(
    staleConfirm.results[0]?.status,
    "noop",
    "stale expired suggestion confirm status",
  );
  assertEqual(
    staleConfirm.results[0]?.reason,
    "expired",
    "stale expired suggestion confirm reason",
  );
  assertStringDoesNotContain(
    JSON.stringify(
      await prisma.auditEvent.findMany({
        where: {
          workspaceId: primary.workspaceId,
          targetId: staleConfirmSuggestion.id,
          action: "memory.suggestion.expired",
        },
        select: { metadata: true },
      }),
    ),
    "TTL expired suggestion must not confirm before maintenance.",
    "stale expiry audit must not contain suggestion body",
  );

  const expiringSuggestion = await postCandidate(baseUrl, adminSession, {
    sourceId: `memory-e2e-expiring-suggestion-${suffix}`,
    body: "Expired suggestion must not become project memory.",
    intent: "model_suggested_candidate",
    extractionMethod: "model_suggested_candidate",
    requestedScope: "repository",
  });
  assertEqual(expiringSuggestion.status, "created", "expiring suggestion");
  assertPresent(expiringSuggestion.id, "expiring suggestion id");
  await prisma.memorySuggestion.update({
    where: { id: expiringSuggestion.id },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  const expirePendingSuggestions = createMemorySuggestionExpiryMaintenance(
    {
      intervalMs: 1,
      workspaceLimit: 10,
      perWorkspaceLimit: 10,
      lockTtlMs: 60_000,
    },
    {
      clock: new SystemClock(),
      memorySuggestions: new PrismaMemorySuggestionRepository(prisma),
      memoryTransaction: new PrismaMemoryTransaction(prisma),
      lock: new PostgresLeaseLock(prisma),
      logger: noopWorkerLogger,
    },
  );
  await expirePendingSuggestions();
  const expiredConfirm = await postCommands(baseUrl, adminSession, [
    { kind: "confirm_suggestion", suggestionId: expiringSuggestion.id },
  ]);
  assertEqual(
    expiredConfirm.results[0]?.status,
    "noop",
    "expired suggestion confirm status",
  );
  assertEqual(
    expiredConfirm.results[0]?.reason,
    "expired",
    "expired suggestion confirm reason",
  );
  const expiryAudit = await prisma.auditEvent.findMany({
    where: {
      workspaceId: primary.workspaceId,
      action: "memory.suggestion.expired",
      targetId: expiringSuggestion.id,
    },
    select: { metadata: true },
  });
  assertEqual(expiryAudit.length, 1, "expired suggestion audit count");
  assertStringDoesNotContain(
    JSON.stringify(expiryAudit),
    "Expired suggestion must not become project memory.",
    "expiry audit must not contain suggestion body",
  );

  const crossTenantDisable = await postCommands(baseUrl, adminSession, [
    { kind: "disable_memory", memoryItemId: otherRepoItem.id },
  ]);
  assertEqual(
    crossTenantDisable.results[0]?.status,
    "noop",
    "cross-tenant disable status",
  );
  assertEqual(
    crossTenantDisable.results[0]?.reason,
    "memory_not_found",
    "cross-tenant disable reason",
  );

  const crossTenantForget = await postCommands(baseUrl, adminSession, [
    { kind: "forget_memory", memoryItemId: otherRepoItem.id },
  ]);
  assertEqual(
    crossTenantForget.results[0]?.status,
    "noop",
    "cross-tenant forget status",
  );
  assertEqual(
    crossTenantForget.results[0]?.reason,
    "memory_not_found",
    "cross-tenant forget reason",
  );

  const crossTenantConfirm = await postCommands(baseUrl, adminSession, [
    { kind: "confirm_suggestion", suggestionId: otherSuggestion.id },
  ]);
  assertEqual(
    crossTenantConfirm.results[0]?.status,
    "rejected",
    "cross-tenant confirm status",
  );
  assertEqual(
    crossTenantConfirm.results[0]?.reason,
    "memory_not_found",
    "cross-tenant confirm reason",
  );

  const reviewSession = await exchange(
    baseUrl,
    "primary-review-before-disable",
  );
  const reviewMutation = await postJson<{
    readonly error: { readonly code: string };
  }>(
    baseUrl,
    "/api/action/v1/memory-candidates",
    reviewSession.sessionToken,
    {
      protocolVersion: 1,
      intent: "explicit_command",
      requestedScope: "repository",
      candidateBody: "Review event must not save memory.",
      extractionMethod: "explicit_command",
      source: memorySource({
        repositoryFullName: primary.fullName,
        sourceId: `memory-e2e-review-denied-${suffix}`,
        body: "Review event must not save memory.",
      }),
    },
    403,
  );
  assertEqual(
    reviewMutation.error.code,
    "memory_interaction_event_required",
    "review event memory mutation code",
  );

  const searchedBundle = await buildActionMemoryBundle(
    {
      workspaceId: primary.workspaceId,
      repositoryId: primary.repositoryId,
      userId: null,
      safeRetrievalQuery: "browser layout",
      policy: { includeUserPrefs: false },
    },
    {
      memoryItems: new PrismaMemoryItemRepository(prisma),
      memoryPolicyConfig: new StaticMemoryPolicyConfig(),
      memorySearchIndex: new PrismaMemorySearchIndex(prisma),
    },
  );
  assertBundleContains(searchedBundle, [
    "Run dashboard memory changes through browser layout checks.",
  ]);
  assertBundleExcludes(searchedBundle, [
    "Other workspace browser layout memory must never leak.",
  ]);

  const indexingOutboxBeforeDisable = await prisma.outboxEvent.findMany({
    where: {
      workspaceId: primary.workspaceId,
      type: "memory.embedding.reindex.requested",
    },
    select: { aggregateId: true, payload: true, type: true },
    orderBy: { aggregateId: "asc" },
  });
  assertEqual(
    indexingOutboxBeforeDisable.length,
    3,
    "reindex outbox events before disable",
  );
  assertStringDoesNotContain(
    JSON.stringify(indexingOutboxBeforeDisable),
    "guard clauses",
    "indexing outbox must not contain direct memory body",
  );
  assertStringDoesNotContain(
    JSON.stringify(indexingOutboxBeforeDisable),
    "browser layout checks",
    "indexing outbox must not contain confirmed suggestion body",
  );
  const pendingMemoryOutboxBeforeProcess = await prisma.outboxEvent.count({
    where: { type: { startsWith: "memory." }, status: "pending" },
  });
  const outboxResult = await processOutboxBatch(
    {
      limit: 100,
      claimOwnerHash: "memory-flow-e2e-worker",
      handlers: createMemoryOutboxHandlers({
        memoryItems: new PrismaMemoryItemRepository(prisma),
        searchIndex: new PrismaMemorySearchIndex(prisma),
      }),
    },
    {
      outbox: new PrismaOutboxEventRepository(prisma),
      clock: new SystemClock(),
    },
  );
  assertEqual(
    outboxResult.processed,
    pendingMemoryOutboxBeforeProcess,
    "memory outbox processed count",
  );
  assertEqual(outboxResult.deadLettered, 0, "memory outbox dead letters");
  const indexedPrimaryItems = await prisma.memoryItem.findMany({
    where: {
      workspaceId: primary.workspaceId,
      id: {
        in: [repoMemoryItemId, workspaceMemoryItemId, confirmedMemoryItemId],
      },
    },
    select: { id: true, indexState: true, indexVersion: true },
  });
  assertEqual(indexedPrimaryItems.length, 3, "indexed primary item count");
  for (const item of indexedPrimaryItems) {
    assertEqual(item.indexState, "indexed", `indexed state for ${item.id}`);
    assertEqual(item.indexVersion, 1, `indexed version for ${item.id}`);
  }

  const bundle = await getJson<ActionMemoryBundle>(
    baseUrl,
    "/api/action/v1/memory",
    reviewSession.sessionToken,
  );
  assertBundleContains(bundle, [
    "Prefer guard clauses in service methods.",
    "Use Prisma migrations for schema changes.",
    "Run dashboard memory changes through browser layout checks.",
  ]);
  assertBundleExcludes(bundle, [
    "Member role must not be able to save repository memory.",
    "Other workspace browser layout memory must never leak.",
    "Other workspace suggestion must never be confirmable.",
    "Review event must not save memory.",
  ]);

  const repeatedBundle = await getJson<ActionMemoryBundle>(
    baseUrl,
    "/api/action/v1/memory",
    reviewSession.sessionToken,
  );
  assertEqual(
    repeatedBundle.items.length,
    bundle.items.length,
    "repeated bundle size",
  );

  const usageAfterRepeatedFetch = await prisma.memoryUsageEvent.findMany({
    where: {
      workspaceId: primary.workspaceId,
      repositoryId: primary.repositoryId,
    },
    select: { dedupeKey: true, metadata: true },
  });
  assertEqual(
    usageAfterRepeatedFetch.length,
    bundle.items.length,
    "deduped usage event count",
  );
  assertEqual(
    new Set(usageAfterRepeatedFetch.map((event) => event.dedupeKey)).size,
    usageAfterRepeatedFetch.length,
    "usage event dedupe keys are unique",
  );
  assertStringDoesNotContain(
    JSON.stringify(usageAfterRepeatedFetch),
    "guard clauses",
    "usage events must not contain memory body",
  );

  const disable = await postCommands(baseUrl, adminSession, [
    { kind: "disable_memory", memoryItemId: repoMemoryItemId },
  ]);
  assertEqual(disable.results[0]?.status, "updated", "disable memory status");
  const indexDeleteOutboxAfterDisable = await prisma.outboxEvent.count({
    where: {
      workspaceId: primary.workspaceId,
      aggregateId: repoMemoryItemId,
      type: "memory.embedding.delete.requested",
    },
  });
  assertEqual(
    indexDeleteOutboxAfterDisable,
    1,
    "index delete outbox after disable",
  );
  const disabledIndexState = await prisma.memoryItem.findUnique({
    where: { id: repoMemoryItemId },
    select: { indexState: true, indexVersion: true },
  });
  assertEqual(
    disabledIndexState?.indexState,
    "index_deleted",
    "disabled item index state",
  );
  assertEqual(
    disabledIndexState?.indexVersion,
    null,
    "disabled item index version",
  );

  const afterDisableSession = await exchange(
    baseUrl,
    "primary-review-after-disable",
  );
  const bundleAfterDisable = await getJson<ActionMemoryBundle>(
    baseUrl,
    "/api/action/v1/memory",
    afterDisableSession.sessionToken,
  );
  assertBundleExcludes(bundleAfterDisable, [
    "Prefer guard clauses in service methods.",
    "Other workspace browser layout memory must never leak.",
  ]);
  assertBundleContains(bundleAfterDisable, [
    "Use Prisma migrations for schema changes.",
    "Run dashboard memory changes through browser layout checks.",
  ]);

  const primaryItems = await prisma.memoryItem.findMany({
    where: { workspaceId: primary.workspaceId },
    select: { body: true, status: true, lastUsedAt: true },
    orderBy: { body: "asc" },
  });
  assertEqual(
    primaryItems.filter((item) => item.status === "active").length,
    2,
    "active primary item count after disable",
  );
  assertEqual(
    primaryItems.filter((item) => item.status === "disabled").length,
    1,
    "disabled primary item count after disable",
  );
  if (primaryItems.some((item) => item.lastUsedAt === null)) {
    throw new Error("bundle exposure did not update lastUsedAt for all items");
  }

  const primaryUsageCount = await prisma.memoryUsageEvent.count({
    where: {
      workspaceId: primary.workspaceId,
      repositoryId: primary.repositoryId,
    },
  });
  assertEqual(
    primaryUsageCount,
    bundle.items.length + bundleAfterDisable.items.length,
    "usage events after disable fetch",
  );

  const ttlItem = await postCandidate(baseUrl, adminSession, {
    sourceId: `memory-e2e-ttl-item-${suffix}`,
    body: "TTL expired memory item must leave runtime bundles.",
    intent: "explicit_command",
    extractionMethod: "explicit_command",
    requestedScope: "repository",
  });
  assertEqual(ttlItem.status, "created", "ttl memory item status");
  const ttlMemoryItemId = ttlItem.id;
  assertPresent(ttlMemoryItemId, "ttl memory item id");
  await prisma.memoryItem.update({
    where: { id: ttlMemoryItemId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  const expireActiveMemoryItems = createMemoryItemExpiryMaintenance(
    {
      intervalMs: 1,
      workspaceLimit: 10,
      perWorkspaceLimit: 10,
      lockTtlMs: 60_000,
    },
    {
      clock: new SystemClock(),
      memoryItems: new PrismaMemoryItemRepository(prisma),
      memoryTransaction: new PrismaMemoryTransaction(prisma),
      lock: new PostgresLeaseLock(prisma),
      logger: noopWorkerLogger,
    },
  );
  await expireActiveMemoryItems();
  const expiredTtlItem = await prisma.memoryItem.findUnique({
    where: { id: ttlMemoryItemId },
    select: { status: true, body: true, indexState: true, indexVersion: true },
  });
  assertEqual(expiredTtlItem?.status, "expired", "ttl memory item status");
  assertEqual(
    expiredTtlItem?.body,
    "TTL expired memory item must leave runtime bundles.",
    "ttl memory item keeps body until delete retention",
  );
  assertEqual(
    expiredTtlItem?.indexState,
    "index_deleted",
    "ttl memory item index state",
  );
  assertEqual(
    expiredTtlItem?.indexVersion,
    null,
    "ttl memory item index version",
  );
  const bundleAfterTtlExpiry = await getJson<ActionMemoryBundle>(
    baseUrl,
    "/api/action/v1/memory",
    afterDisableSession.sessionToken,
  );
  assertBundleExcludes(bundleAfterTtlExpiry, [
    "TTL expired memory item must leave runtime bundles.",
  ]);
  const ttlExpiryAudit = await prisma.auditEvent.findMany({
    where: {
      workspaceId: primary.workspaceId,
      action: "memory.item.expired",
      targetId: ttlMemoryItemId,
    },
    select: { metadata: true },
  });
  assertEqual(ttlExpiryAudit.length, 1, "ttl memory expiry audit count");
  assertStringDoesNotContain(
    JSON.stringify(ttlExpiryAudit),
    "TTL expired memory item must leave runtime bundles.",
    "ttl expiry audit must not contain body",
  );
  const ttlExpiryOutbox = await prisma.outboxEvent.findMany({
    where: {
      workspaceId: primary.workspaceId,
      aggregateId: ttlMemoryItemId,
      type: {
        in: ["memory.item.expired", "memory.embedding.delete.requested"],
      },
    },
    select: { type: true, payload: true },
    orderBy: { type: "asc" },
  });
  assertEqual(ttlExpiryOutbox.length, 2, "ttl expiry outbox count");
  assertStringDoesNotContain(
    JSON.stringify(ttlExpiryOutbox),
    "TTL expired memory item must leave runtime bundles.",
    "ttl expiry outbox must not contain body",
  );

  const deleteConfirmed = await postCommands(baseUrl, adminSession, [
    { kind: "forget_memory", memoryItemId: confirmedMemoryItemId },
  ]);
  assertEqual(
    deleteConfirmed.results[0]?.status,
    "updated",
    "delete confirmed suggestion memory status",
  );
  const redactedDeletedItem = await prisma.memoryItem.findUnique({
    where: { id: confirmedMemoryItemId },
    select: {
      body: true,
      status: true,
      source: true,
      indexState: true,
      indexVersion: true,
    },
  });
  assertEqual(
    redactedDeletedItem?.status,
    "deleted",
    "redacted deleted memory status",
  );
  assertEqual(
    redactedDeletedItem?.body,
    deletedMemoryBodyPlaceholder,
    "redacted deleted memory body",
  );
  assertEqual(
    redactedDeletedItem?.indexState,
    "index_deleted",
    "redacted deleted memory index state",
  );
  assertEqual(
    redactedDeletedItem?.indexVersion,
    null,
    "redacted deleted memory index version",
  );
  assertStringDoesNotContain(
    JSON.stringify(redactedDeletedItem),
    "Run dashboard memory changes through browser layout checks.",
    "deleted memory item must not retain body/source",
  );
  const redactedOriginSuggestion = await prisma.memorySuggestion.findUnique({
    where: { id: suggestion.id },
    select: { suggestedBody: true, source: true, safetyReport: true },
  });
  assertEqual(
    redactedOriginSuggestion?.suggestedBody,
    deletedMemoryBodyPlaceholder,
    "redacted origin suggestion body",
  );
  assertStringDoesNotContain(
    JSON.stringify(redactedOriginSuggestion),
    "Run dashboard memory changes through browser layout checks.",
    "deleted origin suggestion must not retain body/source",
  );

  const exportedMemory = await exportMemoryItems(
    {
      workspaceId: primary.workspaceId,
      actor: {
        kind: "github_user",
        id: `memory-e2e-admin-${suffix}`,
        githubUserId: null,
        login: adminLogin,
      },
    },
    {
      clock: new SystemClock(),
      memoryItems: new PrismaMemoryItemRepository(prisma),
      memoryPermissions: new PrismaMemoryPermission(prisma),
      memoryPolicyConfig: new StaticMemoryPolicyConfig(),
      memoryTransaction: new PrismaMemoryTransaction(prisma),
    },
  );
  assertEqual(exportedMemory.status, "exported", "memory export status");
  if (exportedMemory.status !== "exported") {
    throw new Error("memory export was not created");
  }
  assertBundleContains(
    {
      protocolVersion: 1,
      memoryVersion: 1,
      degraded: false,
      reason: null,
      items: exportedMemory.export.items.map((item) => ({
        id: item.id,
        scope: item.scope,
        body: item.body,
      })),
    },
    [
      "Use Prisma migrations for schema changes.",
      "Prefer guard clauses in service methods.",
      "TTL expired memory item must leave runtime bundles.",
    ],
  );
  assertStringDoesNotContain(
    JSON.stringify(exportedMemory.export),
    "Run dashboard memory changes through browser layout checks.",
    "memory export must not include deleted memory body",
  );
  assertStringDoesNotContain(
    JSON.stringify(exportedMemory.export),
    "redactedExcerpt",
    "memory export must not include source excerpt field",
  );
  const exportAudit = await prisma.auditEvent.findFirst({
    where: {
      workspaceId: primary.workspaceId,
      action: "memory.export.created",
      targetId: exportedMemory.export.manifest.exportId,
    },
    select: { metadata: true },
  });
  if (!exportAudit) {
    throw new Error("memory export access was not audited");
  }
  assertStringDoesNotContain(
    JSON.stringify(exportAudit),
    "Use Prisma migrations for schema changes.",
    "memory export audit must not contain body",
  );

  const oldTerminalUpdatedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  await prisma.memoryItem.updateMany({
    where: { id: { in: [ttlMemoryItemId, confirmedMemoryItemId] } },
    data: { updatedAt: oldTerminalUpdatedAt },
  });
  const pruneTerminalMemoryItems = createMemoryTerminalItemPruneMaintenance(
    {
      intervalMs: 1,
      retentionDays: 30,
      workspaceLimit: 10,
      perWorkspaceLimit: 10,
      lockTtlMs: 60_000,
    },
    {
      clock: new SystemClock(),
      memoryItems: new PrismaMemoryItemRepository(prisma),
      memoryTransaction: new PrismaMemoryTransaction(prisma),
      lock: new PostgresLeaseLock(prisma),
      logger: noopWorkerLogger,
    },
  );
  await pruneTerminalMemoryItems();
  const prunedTerminalItems = await prisma.memoryItem.findMany({
    where: { id: { in: [ttlMemoryItemId, confirmedMemoryItemId] } },
    select: { id: true },
  });
  assertEqual(prunedTerminalItems.length, 0, "terminal memory prune count");
  const pruneAudit = await prisma.auditEvent.findMany({
    where: {
      workspaceId: primary.workspaceId,
      action: "memory.item.pruned",
      targetType: "memory_retention",
    },
    select: { metadata: true },
  });
  assertEqual(pruneAudit.length, 1, "terminal memory prune audit count");
  const pruneAuditJson = JSON.stringify(pruneAudit);
  assertStringDoesNotContain(
    pruneAuditJson,
    "TTL expired memory item must leave runtime bundles.",
    "terminal prune audit must not contain ttl body",
  );
  assertStringDoesNotContain(
    pruneAuditJson,
    "Run dashboard memory changes through browser layout checks.",
    "terminal prune audit must not contain deleted body",
  );
  const bundleAfterTerminalPrune = await getJson<ActionMemoryBundle>(
    baseUrl,
    "/api/action/v1/memory",
    afterDisableSession.sessionToken,
  );
  assertBundleExcludes(bundleAfterTerminalPrune, [
    "TTL expired memory item must leave runtime bundles.",
    "Run dashboard memory changes through browser layout checks.",
  ]);
  assertBundleContains(bundleAfterTerminalPrune, [
    "Use Prisma migrations for schema changes.",
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        marker,
        baseUrl,
        primaryRepository: primary.fullName,
        memory: {
          initialBundleItems: bundle.items.length,
          searchedBundleItems: searchedBundle.items.length,
          afterDisableBundleItems: bundleAfterDisable.items.length,
          afterTerminalPruneBundleItems: bundleAfterTerminalPrune.items.length,
          usageEvents: primaryUsageCount,
        },
      },
      null,
      2,
    ),
  );
} finally {
  if (app) {
    await app.close();
  }
  await cleanup();
  await prisma.$disconnect();
}

async function createRepositoryFixture(input: {
  readonly workspaceSlug: string;
  readonly workspaceName: string;
  readonly installationGithubId: bigint;
  readonly repositoryGithubId: bigint;
  readonly owner: string;
  readonly name: string;
  readonly adminLogin: string;
  readonly memberLogin?: string;
}): Promise<RepositoryFixture> {
  const workspace = await prisma.workspace.create({
    data: { slug: input.workspaceSlug, name: input.workspaceName },
    select: { id: true, slug: true },
  });
  await prisma.workspaceMember.create({
    data: {
      workspaceId: workspace.id,
      githubLogin: input.adminLogin,
      role: "admin",
    },
  });
  if (input.memberLogin) {
    await prisma.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        githubLogin: input.memberLogin,
        role: "member",
      },
    });
  }
  const installation = await prisma.gitHubInstallation.create({
    data: {
      workspaceId: workspace.id,
      githubInstallationId: input.installationGithubId,
      accountLogin: input.owner,
      accountType: "User",
      repositorySelection: "selected",
      status: "active",
    },
    select: { id: true },
  });
  const repository = await prisma.repositoryConnection.create({
    data: {
      workspaceId: workspace.id,
      provider: "github",
      externalRepositoryId: input.repositoryGithubId.toString(),
      installationId: installation.id,
      githubRepositoryId: input.repositoryGithubId,
      owner: input.owner,
      name: input.name,
      fullName: `${input.owner}/${input.name}`,
      defaultBranch: "main",
      visibility: "private",
      selected: true,
      archived: false,
      setupStatus: "configured",
      lastSyncedAt: new Date(),
    },
    select: {
      id: true,
      owner: true,
      fullName: true,
      githubRepositoryId: true,
    },
  });

  return {
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    repositoryId: repository.id,
    owner: repository.owner,
    fullName: repository.fullName,
    githubRepositoryId: input.repositoryGithubId,
  };
}

function claims(input: {
  readonly token: string;
  readonly repository: RepositoryFixture;
  readonly actor: string;
  readonly eventName: GitHubActionsOidcClaims["event_name"];
  readonly runSuffix: string;
  readonly workflowPath:
    | ".github/workflows/reviewrouter.yml"
    | ".github/workflows/reviewrouter-interaction.yml";
}): GitHubActionsOidcClaims {
  return {
    iss: githubActionsOidcIssuer,
    aud: defaultActionOidcAudience,
    sub: `repo:${input.repository.fullName}:${input.eventName}`,
    repository: input.repository.fullName,
    repository_id: input.repository.githubRepositoryId.toString(),
    repository_owner: input.repository.owner,
    event_name: input.eventName,
    run_id: `memory-e2e-${marker}-${input.runSuffix}`,
    run_attempt: "1",
    workflow_ref: `${input.repository.fullName}/${input.workflowPath}@refs/pull/1/merge`,
    actor: input.actor,
    exp: Math.floor(Date.now() / 1000) + 900,
    jti: `memory-e2e-jti-${marker}-${input.token}`,
  };
}

async function exchange(
  baseUrl: string,
  token: string,
): Promise<ActionSessionResponse> {
  return postJson<ActionSessionResponse>(
    baseUrl,
    "/api/action/v1/session/exchange",
    null,
    { oidcToken: token },
  );
}

async function postCandidate(
  baseUrl: string,
  session: ActionSessionResponse,
  input: {
    readonly sourceId: string;
    readonly body: string;
    readonly intent:
      | "explicit_command"
      | "explicit_natural_language"
      | "model_suggested_candidate";
    readonly extractionMethod:
      | "explicit_command"
      | "explicit_natural_language"
      | "model_suggested_candidate";
    readonly requestedScope: "repository" | "workspace";
  },
): Promise<MemoryMutationResponse> {
  return postJson<MemoryMutationResponse>(
    baseUrl,
    "/api/action/v1/memory-candidates",
    session.sessionToken,
    {
      protocolVersion: 1,
      intent: input.intent,
      requestedScope: input.requestedScope,
      candidateBody: input.body,
      sourceTextHash: createMemoryBodyHash(input.body),
      extractionMethod: input.extractionMethod,
      extractionVersion: 1,
      source: memorySource({
        repositoryFullName: session.repository,
        sourceId: input.sourceId,
        body: input.body,
      }),
    },
  );
}

function memorySource(input: {
  readonly repositoryFullName: string;
  readonly sourceId: string;
  readonly body: string;
}) {
  const hash = createMemoryBodyHash(input.body);
  return {
    sourceId: input.sourceId,
    githubCommentId: input.sourceId.replace(/\D/g, "").slice(-8) || "10000001",
    githubPullRequestNumber: 1,
    url: `https://github.com/${input.repositoryFullName}/pull/1#issuecomment-${input.sourceId}`,
    redactedExcerpt: input.body,
    sourceHash: hash,
    sourceVisibility: "internal",
  };
}

async function postCommands(
  baseUrl: string,
  session: ActionSessionResponse,
  commands: readonly Record<string, unknown>[],
): Promise<MemoryCommandResponse> {
  return postJson<MemoryCommandResponse>(
    baseUrl,
    "/api/action/v1/memory-commands",
    session.sessionToken,
    { protocolVersion: 1, commands },
  );
}

async function getJson<T>(
  baseUrl: string,
  path: string,
  sessionToken: string,
): Promise<T> {
  return requestJson<T>(baseUrl, path, {
    method: "GET",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
}

async function postJson<T>(
  baseUrl: string,
  path: string,
  sessionToken: string | null,
  payload: unknown,
  expectedStatus = 200,
): Promise<T> {
  return requestJson<T>(baseUrl, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    },
    body: JSON.stringify(payload),
    expectedStatus,
  });
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  init: RequestInit & { readonly expectedStatus?: number },
): Promise<T> {
  const { expectedStatus = 200, ...fetchInit } = init;
  const response = await fetch(new URL(path, baseUrl), fetchInit);
  const text = await response.text();
  const json = text ? (JSON.parse(text) as T) : ({} as T);
  if (response.status !== expectedStatus) {
    throw new Error(
      `${fetchInit.method ?? "GET"} ${path} expected ${expectedStatus}, got ${response.status}: ${text}`,
    );
  }
  return json;
}

function assertBundleContains(
  bundle: ActionMemoryBundle,
  expectedBodies: readonly string[],
): void {
  const bodies = bundle.items.map((item) => item.body);
  for (const body of expectedBodies) {
    if (!bodies.includes(body)) {
      throw new Error(`memory bundle is missing body: ${body}`);
    }
  }
}

function assertBundleExcludes(
  bundle: ActionMemoryBundle,
  forbiddenBodies: readonly string[],
): void {
  const serialized = JSON.stringify(bundle);
  for (const body of forbiddenBodies) {
    assertStringDoesNotContain(serialized, body, "memory bundle body leak");
  }
}

function assertPresent<T>(
  value: T | null | undefined,
  label: string,
): asserts value is T {
  if (value === null || value === undefined || value === "") {
    throw new Error(`${label} is missing`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

function assertStringDoesNotContain(
  actual: string,
  forbidden: string,
  label: string,
): void {
  if (actual.includes(forbidden)) {
    throw new Error(`${label}: unexpected content "${forbidden}"`);
  }
}

async function cleanup(): Promise<void> {
  await prisma.actionOidcReplayNonce.deleteMany({
    where: { key: { startsWith: `memory-e2e-jti-${marker}` } },
  });
  if (workspaceSlugs.length > 0) {
    await prisma.workspace.deleteMany({
      where: { slug: { in: workspaceSlugs } },
    });
  }
}
