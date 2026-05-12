import { describe, expect, it } from "vitest";
import type {
  ActionControlPlaneRepositoryPort,
  ActionEntitlementPolicyPort,
  ActionHealthReport,
  ActionOidcReplayNonceStorePort,
  ActionRateLimitPolicyPort,
  ActionRepositoryContext,
  GitHubAppCommentTokenIssuerPort,
  GitHubActionsOidcClaims,
  GitHubActionsOidcTokenVerifierPort,
  IssueGitHubAppCommentTokenInput,
} from "@reviewrouter/features-action-control-plane";
import {
  actionHealthReportMaxBytes,
  defaultActionOidcAudience,
  githubActionsOidcIssuer,
  JoseActionSessionTokenService,
  StaticActionRuntimeCompatibilityPolicy,
} from "@reviewrouter/features-action-control-plane";
import type {
  MarkActiveMemoryItemsUsedInput,
  MarkActiveMemoryItemsUsedResult,
  MemoryActor,
  MemoryAuditEvent,
  MemoryAuditPort,
  MemoryIdGeneratorPort,
  MemoryItem,
  MemoryItemRepositoryPort,
  MemoryItemSnapshot,
  MemoryOutboxEvent,
  MemoryOutboxPort,
  MemoryPermissionDecision,
  MemoryPermissionPort,
  MemorySuggestionRepositoryPort,
  MemorySuggestionSnapshot,
  MemoryTransactionPort,
  MemoryTransactionalPorts,
  MemoryUsageEventInput,
  MemoryUsageEventPort,
  MemoryUseCaseDependencies,
} from "@reviewrouter/features-memory";
import {
  createDashboardMemorySource,
  createMemoryBodyHash,
  deletedMemoryBodyPlaceholder,
  evaluateMemorySafety,
  memoryActorRef,
  MemorySuggestion,
} from "@reviewrouter/features-memory";
import type {
  GitHubInstallationRepositoryPort,
  GitHubInstallationSnapshot,
  GitHubPullRequestWebhookEnvelope,
  GitHubPullRequestWebhookHandlerPort,
  GitHubRepositoryWebhookEnvelope,
  GitHubRepositoryWebhookHandlerPort,
  InstallationWorkspaceOwnerGrant,
  InstallationWorkspaceOwnerGrantPort,
  WebhookDeliveryRecord,
  WebhookDeliveryRepositoryPort,
} from "@reviewrouter/features-github-installations";
import { signGitHubWebhookPayload } from "@reviewrouter/features-github-installations";
import type { Clock } from "@reviewrouter/shared";
import { createApiApp } from "./app.js";

class InMemoryInstallations implements GitHubInstallationRepositoryPort {
  public readonly snapshots = new Map<string, GitHubInstallationSnapshot>();

  async upsertInstallation(
    snapshot: GitHubInstallationSnapshot,
  ): Promise<void> {
    this.snapshots.set(snapshot.githubInstallationId, snapshot);
  }

  async markInstallationRemoved(githubInstallationId: string): Promise<void> {
    const existing = this.snapshots.get(githubInstallationId);
    if (existing) {
      this.snapshots.set(githubInstallationId, {
        ...existing,
        status: "removed",
      });
    }
  }
}

class InMemoryDeliveries implements WebhookDeliveryRepositoryPort {
  public readonly deliveries = new Map<
    string,
    WebhookDeliveryRecord & {
      readonly status: "processing" | "processed" | "failed";
    }
  >();

  async tryStartProcessing(delivery: WebhookDeliveryRecord): Promise<boolean> {
    if (this.deliveries.has(delivery.deliveryId)) {
      return false;
    }
    this.deliveries.set(delivery.deliveryId, {
      ...delivery,
      status: "processing",
    });
    return true;
  }

  async markProcessed(deliveryId: string): Promise<void> {
    const existing = this.deliveries.get(deliveryId);
    if (existing) {
      this.deliveries.set(deliveryId, { ...existing, status: "processed" });
    }
  }

  async markFailed(input: {
    readonly deliveryId: string;
    readonly errorSummary: string;
  }): Promise<void> {
    const existing = this.deliveries.get(input.deliveryId);
    if (existing) {
      this.deliveries.set(input.deliveryId, { ...existing, status: "failed" });
    }
  }
}

class InMemoryOwnerGrants implements InstallationWorkspaceOwnerGrantPort {
  public readonly grants: InstallationWorkspaceOwnerGrant[] = [];

  async grantInstallationActorOwner(
    grant: InstallationWorkspaceOwnerGrant,
  ): Promise<void> {
    this.grants.push(grant);
  }
}

class CapturingPullRequestWebhookHandler implements GitHubPullRequestWebhookHandlerPort {
  public envelopes: GitHubPullRequestWebhookEnvelope[] = [];

  async handleGitHubPullRequestWebhook(
    envelope: GitHubPullRequestWebhookEnvelope,
  ): Promise<Record<string, unknown>> {
    this.envelopes.push(envelope);
    return { processed: true, status: "configured" };
  }
}

class CapturingRepositoryWebhookHandler implements GitHubRepositoryWebhookHandlerPort {
  public envelopes: GitHubRepositoryWebhookEnvelope[] = [];

  async handleGitHubRepositoryWebhook(
    envelope: GitHubRepositoryWebhookEnvelope,
  ): Promise<Record<string, unknown>> {
    this.envelopes.push(envelope);
    return { processed: true, status: "synced" };
  }
}

class InMemoryActionRepositories implements ActionControlPlaneRepositoryPort {
  public readonly healthReports: ActionHealthReport[] = [];

  async findSelectedRepositoryByGithubId(
    githubRepositoryId: string,
  ): Promise<ActionRepositoryContext | null> {
    if (githubRepositoryId !== "123456") {
      return null;
    }
    return {
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
      githubRepositoryId: "123456",
      githubInstallationId: "129500385",
      fullName: "777genius/example",
      owner: "777genius",
      selected: true,
      installationStatus: "active",
    };
  }

  async findRuntimeReviewConfiguration() {
    return null;
  }

  async recordHealthReport(input: {
    readonly report: ActionHealthReport;
  }): Promise<void> {
    this.healthReports.push(input.report);
  }
}

class InMemoryActionMemoryItems implements MemoryItemRepositoryPort {
  public readonly snapshots = new Map<string, MemoryItemSnapshot>();

  constructor(snapshots: readonly MemoryItemSnapshot[] = []) {
    for (const snapshot of snapshots) {
      this.snapshots.set(snapshot.id, snapshot);
    }
  }

  async save(item: MemoryItem): Promise<void> {
    const snapshot = item.snapshot();
    this.snapshots.set(snapshot.id, snapshot);
  }

  async findById(input: {
    readonly workspaceId: string;
    readonly itemId: string;
  }): Promise<MemoryItemSnapshot | null> {
    const snapshot = this.snapshots.get(input.itemId);
    return snapshot?.workspaceId === input.workspaceId ? snapshot : null;
  }

  async findActiveByBodyHash(input: {
    readonly workspaceId: string;
    readonly scope: MemoryItemSnapshot["scope"];
    readonly repositoryId: string | null;
    readonly userId: string | null;
    readonly bodyHash: string;
  }): Promise<MemoryItemSnapshot | null> {
    return (
      this.values().find(
        (item) =>
          item.workspaceId === input.workspaceId &&
          item.status === "active" &&
          item.scope === input.scope &&
          item.repositoryId === input.repositoryId &&
          item.userId === input.userId &&
          item.bodyHash === input.bodyHash,
      ) ?? null
    );
  }

  async countActiveForWorkspace(input: {
    readonly workspaceId: string;
  }): Promise<number> {
    return this.values().filter(
      (item) =>
        item.workspaceId === input.workspaceId && item.status === "active",
    ).length;
  }

  async listActiveForBundle(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly userId: string | null;
    readonly limit: number;
  }): Promise<readonly MemoryItemSnapshot[]> {
    return this.values()
      .filter((item) => item.workspaceId === input.workspaceId)
      .filter((item) => item.status === "active")
      .filter(
        (item) =>
          item.scope === "workspace" ||
          (item.scope === "repository" &&
            item.repositoryId === input.repositoryId) ||
          (item.scope === "user_prefs" && item.userId === input.userId),
      )
      .slice(0, input.limit);
  }

  async listActiveByIdsForBundle(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly userId: string | null;
    readonly itemIds: readonly string[];
    readonly limit: number;
  }): Promise<readonly MemoryItemSnapshot[]> {
    const itemIds = new Set(input.itemIds);
    return this.values()
      .filter((item) => itemIds.has(item.id))
      .filter((item) => item.workspaceId === input.workspaceId)
      .filter((item) => item.status === "active")
      .filter(
        (item) =>
          item.scope === "workspace" ||
          (item.scope === "repository" &&
            item.repositoryId === input.repositoryId) ||
          (item.scope === "user_prefs" && item.userId === input.userId),
      )
      .sort(
        (left, right) =>
          input.itemIds.indexOf(left.id) - input.itemIds.indexOf(right.id),
      )
      .slice(0, input.limit);
  }

  async listForDashboard(input: {
    readonly workspaceId: string;
    readonly repositoryId?: string | null;
    readonly scope?: MemoryItemSnapshot["scope"];
    readonly statuses: readonly MemoryItemSnapshot["status"][];
    readonly limit: number;
  }): Promise<readonly MemoryItemSnapshot[]> {
    return this.values()
      .filter((item) => item.workspaceId === input.workspaceId)
      .filter((item) => input.statuses.includes(item.status))
      .filter((item) =>
        input.repositoryId === undefined
          ? true
          : item.repositoryId === input.repositoryId,
      )
      .filter((item) => (input.scope ? item.scope === input.scope : true))
      .slice(0, input.limit);
  }

  async markActiveItemsUsed(
    input: MarkActiveMemoryItemsUsedInput,
  ): Promise<MarkActiveMemoryItemsUsedResult> {
    const itemIds = new Set(input.itemIds);
    let updatedCount = 0;
    for (const [id, item] of this.snapshots.entries()) {
      if (
        item.workspaceId !== input.workspaceId ||
        item.status !== "active" ||
        !itemIds.has(id)
      ) {
        continue;
      }
      this.snapshots.set(id, { ...item, lastUsedAt: input.usedAt });
      updatedCount += 1;
    }
    return { updatedCount };
  }

  values(): MemoryItemSnapshot[] {
    return Array.from(this.snapshots.values());
  }
}

class InMemoryMemorySuggestions implements MemorySuggestionRepositoryPort {
  public readonly snapshots = new Map<string, MemorySuggestionSnapshot>();

  async save(suggestion: MemorySuggestion): Promise<void> {
    const snapshot = suggestion.snapshot();
    this.snapshots.set(snapshot.id, snapshot);
  }

  async findById(input: {
    readonly workspaceId: string;
    readonly suggestionId: string;
  }): Promise<MemorySuggestionSnapshot | null> {
    const snapshot = this.snapshots.get(input.suggestionId);
    return snapshot?.workspaceId === input.workspaceId ? snapshot : null;
  }

  async findPendingByDedupeKey(input: {
    readonly workspaceId: string;
    readonly dedupeKey: string;
  }): Promise<MemorySuggestionSnapshot | null> {
    return (
      this.values().find(
        (suggestion) =>
          suggestion.workspaceId === input.workspaceId &&
          suggestion.status === "pending" &&
          suggestion.dedupeKey === input.dedupeKey,
      ) ?? null
    );
  }

  async countPendingForWorkspace(input: {
    readonly workspaceId: string;
    readonly notExpiredAt?: Date;
  }): Promise<number> {
    return this.values().filter(
      (suggestion) =>
        suggestion.workspaceId === input.workspaceId &&
        suggestion.status === "pending" &&
        (!input.notExpiredAt || suggestion.expiresAt > input.notExpiredAt),
    ).length;
  }

  async supersedePendingBySource(input: {
    readonly workspaceId: string;
    readonly repositoryId: string | null;
    readonly userId: string | null;
    readonly scope: MemorySuggestionSnapshot["suggestedScope"];
    readonly sourceType: MemorySuggestionSnapshot["source"]["type"];
    readonly sourceId: string;
    readonly createdByActor: MemoryActor;
    readonly replacementSuggestionId: string;
    readonly excludeSuggestionId: string;
    readonly supersededAt: Date;
    readonly limit: number;
  }): Promise<readonly MemorySuggestionSnapshot[]> {
    const superseded: MemorySuggestionSnapshot[] = [];
    for (const suggestion of this.values()
      .filter(
        (candidate) =>
          candidate.workspaceId === input.workspaceId &&
          candidate.repositoryId === input.repositoryId &&
          candidate.userId === input.userId &&
          candidate.suggestedScope === input.scope &&
          candidate.source.type === input.sourceType &&
          candidate.source.sourceId === input.sourceId &&
          candidate.createdByActor === memoryActorRef(input.createdByActor) &&
          candidate.status === "pending" &&
          candidate.id !== input.excludeSuggestionId,
      )
      .slice(0, input.limit)) {
      const next = MemorySuggestion.fromSnapshot(suggestion)
        .supersede({
          actor: input.createdByActor,
          replacementSuggestionId: input.replacementSuggestionId,
          now: input.supersededAt,
        })
        .snapshot();
      this.snapshots.set(next.id, next);
      superseded.push(next);
    }
    return superseded;
  }

  async listForDashboard(input: {
    readonly workspaceId: string;
    readonly repositoryId?: string | null;
    readonly scope?: MemorySuggestionSnapshot["suggestedScope"];
    readonly statuses: readonly MemorySuggestionSnapshot["status"][];
    readonly limit: number;
    readonly notExpiredAt?: Date;
  }): Promise<readonly MemorySuggestionSnapshot[]> {
    return this.values()
      .filter((suggestion) => suggestion.workspaceId === input.workspaceId)
      .filter((suggestion) => input.statuses.includes(suggestion.status))
      .filter((suggestion) =>
        input.repositoryId === undefined
          ? true
          : suggestion.repositoryId === input.repositoryId,
      )
      .filter((suggestion) =>
        input.scope ? suggestion.suggestedScope === input.scope : true,
      )
      .filter((suggestion) =>
        input.notExpiredAt ? suggestion.expiresAt > input.notExpiredAt : true,
      )
      .slice(0, input.limit);
  }

  async listExpiredPending(input: {
    readonly workspaceId: string;
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<readonly MemorySuggestionSnapshot[]> {
    return this.values()
      .filter((suggestion) => suggestion.workspaceId === input.workspaceId)
      .filter((suggestion) => suggestion.status === "pending")
      .filter((suggestion) => suggestion.expiresAt <= input.expiredAtOrBefore)
      .sort((left, right) => {
        const expiresAtDelta =
          left.expiresAt.getTime() - right.expiresAt.getTime();
        if (expiresAtDelta !== 0) return expiresAtDelta;
        return left.id.localeCompare(right.id);
      })
      .slice(0, input.limit);
  }

  async listWorkspaceIdsWithExpiredPending(input: {
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<readonly string[]> {
    const workspaceIds = new Set<string>();
    for (const suggestion of this.values().sort((left, right) =>
      left.workspaceId.localeCompare(right.workspaceId),
    )) {
      if (
        suggestion.status === "pending" &&
        suggestion.expiresAt <= input.expiredAtOrBefore
      ) {
        workspaceIds.add(suggestion.workspaceId);
      }
      if (workspaceIds.size >= input.limit) break;
    }
    return [...workspaceIds];
  }

  values(): MemorySuggestionSnapshot[] {
    return Array.from(this.snapshots.values());
  }
}

class AllowingMemoryPermissions implements MemoryPermissionPort {
  public readonly calls: Array<{
    readonly workspaceId: string;
    readonly repositoryId: string | null;
    readonly userId: string | null;
    readonly scope: MemoryItemSnapshot["scope"];
    readonly actor: MemoryActor;
  }> = [];

  async canConfirmMemory(
    input: Parameters<MemoryPermissionPort["canConfirmMemory"]>[0],
  ): Promise<MemoryPermissionDecision> {
    this.calls.push(input);
    return { allowed: true };
  }
}

class IncrementingMemoryIds implements MemoryIdGeneratorPort {
  private next = 1;

  newId(prefix: "mem" | "mem_suggestion" | "mem_usage"): string {
    return `${prefix}_test_${this.next++}`;
  }
}

class CapturingMemoryAudit implements MemoryAuditPort {
  public readonly events: MemoryAuditEvent[] = [];

  async record(event: MemoryAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class CapturingMemoryOutbox implements MemoryOutboxPort {
  public readonly events: MemoryOutboxEvent[] = [];

  async enqueue(
    event: MemoryOutboxEvent,
  ): Promise<{ readonly created: boolean }> {
    this.events.push(event);
    return { created: true };
  }
}

class CapturingMemoryUsageEvents implements MemoryUsageEventPort {
  public readonly events: MemoryUsageEventInput[] = [];
  private readonly dedupeKeys = new Set<string>();

  async recordMany(
    events: readonly MemoryUsageEventInput[],
  ): ReturnType<MemoryUsageEventPort["recordMany"]> {
    let recordedCount = 0;
    let duplicateCount = 0;
    for (const event of events) {
      if (event.dedupeKey && this.dedupeKeys.has(event.dedupeKey)) {
        duplicateCount += 1;
        continue;
      }
      if (event.dedupeKey) {
        this.dedupeKeys.add(event.dedupeKey);
      }
      this.events.push(event);
      recordedCount += 1;
    }
    return { recordedCount, duplicateCount };
  }
}

class SameObjectMemoryTransaction implements MemoryTransactionPort {
  constructor(private readonly ports: MemoryTransactionalPorts) {}

  async run<T>(
    work: (ports: MemoryTransactionalPorts) => Promise<T>,
  ): Promise<T> {
    return work(this.ports);
  }
}

class StaticActionOidcVerifier implements GitHubActionsOidcTokenVerifierPort {
  constructor(
    private readonly overrides: Partial<GitHubActionsOidcClaims> = {},
  ) {}

  async verify(): Promise<GitHubActionsOidcClaims> {
    return {
      iss: githubActionsOidcIssuer,
      aud: defaultActionOidcAudience,
      sub: "repo:777genius/example:pull_request",
      repository: "777genius/example",
      repository_id: "123456",
      repository_owner: "777genius",
      event_name: "pull_request",
      run_id: "1001",
      run_attempt: "1",
      workflow_ref:
        "777genius/example/.github/workflows/reviewrouter.yml@refs/pull/1/merge",
      actor: "777genius",
      ...this.overrides,
    };
  }
}

class InMemoryActionReplayNonces implements ActionOidcReplayNonceStorePort {
  private readonly keys = new Set<string>();

  async tryConsumeNonce(input: { readonly key: string }): Promise<boolean> {
    if (this.keys.has(input.key)) {
      return false;
    }
    this.keys.add(input.key);
    return true;
  }
}

class InMemoryCommentTokenIssuer implements GitHubAppCommentTokenIssuerPort {
  public readonly calls: IssueGitHubAppCommentTokenInput[] = [];

  async issueCommentToken(input: IssueGitHubAppCommentTokenInput) {
    this.calls.push(input);
    return {
      token: "ghs_reviewrouter_app_token",
      expiresAt: new Date("2026-05-03T13:00:00.000Z"),
      repository: input.repositoryFullName,
      permissions: {
        pullRequests: "write" as const,
        issues: "write" as const,
      },
    };
  }
}

class DenyingActionEntitlements implements ActionEntitlementPolicyPort {
  async assertActionControlPlaneAllowed(): Promise<void> {
    throw new Error(
      "entitlement_denied:action_control_plane:feature_not_enabled_for_plan",
    );
  }
}

class DenyingActionRateLimits implements ActionRateLimitPolicyPort {
  async assertOidcExchangeAllowed(): Promise<void> {
    throw new Error("rate_limit_exceeded:action:oidc_exchange:repo_1");
  }

  async assertHealthReportAllowed(): Promise<void> {
    throw new Error("rate_limit_exceeded:action:health_report:repo_1");
  }
}

const fixedClock: Clock = {
  now: () => new Date("2026-05-03T12:00:00.000Z"),
};

function createActionMemoryDependencies(
  input: {
    readonly memoryItems?: InMemoryActionMemoryItems;
    readonly memorySuggestions?: InMemoryMemorySuggestions;
    readonly permissions?: MemoryPermissionPort;
  } = {},
): {
  readonly memory: MemoryUseCaseDependencies;
  readonly memoryItems: InMemoryActionMemoryItems;
  readonly memorySuggestions: InMemoryMemorySuggestions;
  readonly permissions: MemoryPermissionPort;
  readonly audit: CapturingMemoryAudit;
  readonly outbox: CapturingMemoryOutbox;
  readonly usageEvents: CapturingMemoryUsageEvents;
} {
  const memoryItems = input.memoryItems ?? new InMemoryActionMemoryItems();
  const memorySuggestions =
    input.memorySuggestions ?? new InMemoryMemorySuggestions();
  const permissions = input.permissions ?? new AllowingMemoryPermissions();
  const audit = new CapturingMemoryAudit();
  const outbox = new CapturingMemoryOutbox();
  const usageEvents = new CapturingMemoryUsageEvents();
  return {
    memory: {
      memoryItems,
      memorySuggestions,
      memoryPermissions: permissions,
      memoryUsageEvents: usageEvents,
      memoryIds: new IncrementingMemoryIds(),
      memoryTransaction: new SameObjectMemoryTransaction({
        memoryItems,
        memorySuggestions,
        memoryAudit: audit,
        memoryOutbox: outbox,
      }),
      clock: fixedClock,
    },
    memoryItems,
    memorySuggestions,
    permissions,
    audit,
    outbox,
    usageEvents,
  };
}

function actionMemorySnapshot(
  overrides: Partial<MemoryItemSnapshot>,
): MemoryItemSnapshot {
  const body = overrides.body ?? "Prefer guard clauses in service methods.";
  const now = fixedClock.now();
  return {
    id: overrides.id ?? "mem_1",
    schemaVersion: 1,
    workspaceId: overrides.workspaceId ?? "workspace_1",
    repositoryId: overrides.repositoryId ?? "repo_1",
    userId: overrides.userId ?? null,
    scope: overrides.scope ?? "repository",
    status: overrides.status ?? "active",
    body,
    bodyVersion: overrides.bodyVersion ?? 1,
    bodyHash: overrides.bodyHash ?? createMemoryBodyHash(body),
    tags: overrides.tags ?? [],
    riskLevel: overrides.riskLevel ?? "low",
    confidence: overrides.confidence ?? 0.92,
    source:
      overrides.source ??
      createDashboardMemorySource({ actorLogin: "maintainer" }),
    policyVersion: overrides.policyVersion ?? 1,
    safetyPolicyVersion: overrides.safetyPolicyVersion ?? 1,
    createdBy: overrides.createdBy ?? "github_user:user_1",
    confirmedBy: overrides.confirmedBy ?? "github_user:user_1",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    lastUsedAt: overrides.lastUsedAt ?? null,
    expiresAt: overrides.expiresAt ?? null,
    version: overrides.version ?? 1,
    visibility: overrides.visibility ?? "repository_runtime",
    originSuggestionId: overrides.originSuggestionId ?? null,
    indexState: overrides.indexState ?? "indexed",
    indexVersion: overrides.indexVersion ?? 1,
  };
}

function actionMemorySuggestionSnapshot(
  overrides: Partial<MemorySuggestionSnapshot>,
): MemorySuggestionSnapshot {
  const suggestedBody =
    overrides.suggestedBody ?? "Prefer small cohesive pull requests.";
  const suggestedScope = overrides.suggestedScope ?? "repository";
  const now = fixedClock.now();
  const suggestedBodyHash =
    overrides.suggestedBodyHash ?? createMemoryBodyHash(suggestedBody);
  return {
    id: overrides.id ?? "mem_suggestion_1",
    schemaVersion: 1,
    workspaceId: overrides.workspaceId ?? "workspace_1",
    repositoryId:
      overrides.repositoryId ??
      (suggestedScope === "repository" ? "repo_1" : null),
    userId: overrides.userId ?? null,
    suggestedScope,
    suggestedBody,
    suggestedBodyVersion: overrides.suggestedBodyVersion ?? 1,
    suggestedBodyHash,
    reason: overrides.reason ?? "explicit_natural_language",
    source:
      overrides.source ??
      createDashboardMemorySource({ actorLogin: "777genius" }),
    safetyReport:
      overrides.safetyReport ??
      evaluateMemorySafety({
        body: suggestedBody,
        scope: suggestedScope,
        redactedSourceExcerpt: null,
      }),
    policyVersion: overrides.policyVersion ?? 1,
    safetyPolicyVersion: overrides.safetyPolicyVersion ?? 1,
    status: overrides.status ?? "pending",
    createdByActor:
      overrides.createdByActor ?? "github_user:github-login:777genius",
    expiresAt:
      overrides.expiresAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    dedupeKey:
      overrides.dedupeKey ??
      `memory:${overrides.workspaceId ?? "workspace_1"}:${suggestedScope}:${suggestedBodyHash}`,
    relatedMemoryItemId: overrides.relatedMemoryItemId ?? null,
    relatedSuggestionId: overrides.relatedSuggestionId ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    resolvedAt: overrides.resolvedAt ?? null,
    resolvedBy: overrides.resolvedBy ?? null,
    resolutionReason: overrides.resolutionReason ?? null,
    version: overrides.version ?? 1,
  };
}

const expectedApiUrl = (
  process.env.REVIEW_ROUTER_PUBLIC_API_URL ??
  process.env.REVIEW_ROUTER_API_URL ??
  "https://api.reviewrouter.site"
).replace(/\/+$/, "");

describe("API app", () => {
  it("serves a public API index for demos", async () => {
    const app = await createApiApp();
    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-reviewrouter-demo"]).toBe("true");
    expect(response.json()).toMatchObject({
      service: "review-router-api",
      product: "ReviewRouter",
      status: "ok",
      links: {
        health: `${expectedApiUrl}/health`,
        demo: `${expectedApiUrl}/demo`,
        demoMarkdown: `${expectedApiUrl}/demo.md`,
        openapi: `${expectedApiUrl}/openapi.json`,
        apiDocs: `${expectedApiUrl}/docs`,
      },
    });
  });

  it("serves HTML from the API index for browser requests", async () => {
    const app = await createApiApp();
    const response = await app.inject({
      method: "GET",
      url: "/",
      headers: { accept: "text/html" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("<title>ReviewRouter API Demo</title>");
    expect(response.body).toContain(`${expectedApiUrl}/demo.md`);
  });

  it("serves public demo preflight responses for browser smoke checks", async () => {
    const app = await createApiApp();
    const response = await app.inject({ method: "OPTIONS", url: "/demo" });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers["access-control-allow-methods"]).toContain("GET");
    expect(response.headers["access-control-allow-headers"]).toContain(
      "content-type",
    );
  });

  it("serves a browser-friendly API demo page", async () => {
    const app = await createApiApp();
    const response = await app.inject({ method: "GET", url: "/docs" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.body).toContain("<title>ReviewRouter API Demo</title>");
    expect(response.body).toContain("Quick start");
    expect(response.body).toContain("Security boundaries");
    expect(response.body).toContain(`${expectedApiUrl}/demo`);
  });

  it("serves a terminal-friendly Markdown API demo page", async () => {
    const app = await createApiApp();
    const response = await app.inject({ method: "GET", url: "/demo.md" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/markdown");
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.body).toContain("# ReviewRouter API Demo");
    expect(response.body).toContain("## Security boundaries");
    expect(response.body).toContain(`${expectedApiUrl}/docs`);
  });

  it("serves a small readiness response for API demos", async () => {
    const app = await createApiApp();
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: "review-router-api",
      status: "ready",
    });
  });

  it("serves public API demo capabilities without code or secret claims", async () => {
    const app = await createApiApp();
    const response = await app.inject({ method: "GET", url: "/demo" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: "review-router-api",
      product: "ReviewRouter",
      contractVersion: "2026-05-04",
      status: "demo_ready",
      executionModel: {
        reviewRunsIn: "customer_github_actions",
      },
      defaultReviewRuntime: {
        provider: "codex_oauth",
      },
    });
    expect(response.body).toContain("/api/action/v1/session/exchange");
    expect(response.body).toContain("Choose provider credentials");
    expect(response.body).toContain("Runtime access");
    expect(response.body).toContain("repository source code");
    expect(response.body).toContain("Codex OAuth auth.json");
    expect(response.body).not.toContain("CODEX_AUTH_JSON=");
    expect(response.body).not.toContain("OPENAI_API_KEY=");
  });

  it("serves an OpenAPI document for public API demos", async () => {
    const app = await createApiApp();
    const response = await app.inject({
      method: "GET",
      url: "/openapi.json",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      openapi: "3.1.0",
      info: {
        title: "ReviewRouter API",
        version: "2026-05-04",
      },
      components: {
        schemas: {
          ApiDemo: {},
          ApiIndex: {},
          ReadyResponse: {},
          ActionMemoryBundle: {},
          ActionMemoryCandidateRequest: {},
          ActionMemoryCommandRequest: {},
          ActionMemoryCommandResponse: {},
          ActionMemoryMutationResponse: {},
        },
      },
      paths: {
        "/demo": {},
        "/demo.md": {},
        "/docs": {},
        "/api/action/v1/session/exchange": {},
        "/api/action/v1/memory": {},
        "/api/action/v1/memory-candidates": {},
        "/api/action/v1/memory-commands": {},
      },
    });
  });

  it("serves health status", async () => {
    const app = await createApiApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.json()).toMatchObject({
      service: "review-router-api",
      status: "ok",
    });
  });

  it("marks health degraded when a dependency is degraded", async () => {
    const app = await createApiApp({
      healthDependencies: [
        {
          check: async () => ({ name: "database", status: "degraded" }),
        },
      ],
    });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: "review-router-api",
      status: "degraded",
      dependencies: [{ name: "database", status: "degraded" }],
    });
  });

  it("handles signed GitHub installation webhooks", async () => {
    const installations = new InMemoryInstallations();
    const deliveries = new InMemoryDeliveries();
    const ownerGrants = new InMemoryOwnerGrants();
    const secret = "webhook-secret";
    const app = await createApiApp({
      githubWebhookDependencies: {
        webhookSecret: secret,
        installations,
        ownerGrants,
        deliveries,
        clock: fixedClock,
      },
    });
    const payload = JSON.stringify({
      action: "created",
      installation: {
        id: 129154876,
        account: { login: "777genius", type: "User" },
        repository_selection: "all",
      },
      sender: { id: 777, login: "777genius" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-api-test",
        "x-github-event": "installation",
        "x-hub-signature-256": signGitHubWebhookPayload(payload, secret),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ processed: true, status: "active" });
    expect(installations.snapshots.get("129154876")).toMatchObject({
      accountLogin: "777genius",
      repositorySelection: "all",
    });
    expect(ownerGrants.grants).toEqual([
      {
        githubInstallationId: "129154876",
        githubUserId: "777",
        githubLogin: "777genius",
        avatarUrl: null,
      },
    ]);
  });

  it("handles signed GitHub setup pull request merge webhooks", async () => {
    const pullRequests = new CapturingPullRequestWebhookHandler();
    const secret = "webhook-secret";
    const app = await createApiApp({
      githubWebhookDependencies: {
        webhookSecret: secret,
        installations: new InMemoryInstallations(),
        deliveries: new InMemoryDeliveries(),
        pullRequests,
        clock: fixedClock,
      },
    });
    const payload = JSON.stringify({
      action: "closed",
      installation: {
        id: 129154876,
        account: { login: "777genius", type: "User" },
        repository_selection: "all",
      },
      repository: {
        id: 123456,
        name: "example",
        full_name: "777genius/example",
      },
      pull_request: {
        number: 7,
        html_url: "https://github.com/777genius/example/pull/7",
        state: "closed",
        merged: true,
        base: { ref: "main" },
        head: { ref: "reviewrouter/setup" },
      },
      sender: { id: 777, login: "777genius" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-api-pr-merge-test",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signGitHubWebhookPayload(payload, secret),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      processed: true,
      status: "configured",
    });
    expect(pullRequests.envelopes).toEqual([
      expect.objectContaining({
        deliveryId: "delivery-api-pr-merge-test",
        eventName: "pull_request",
        payload: expect.objectContaining({
          action: "closed",
          repository: expect.objectContaining({
            full_name: "777genius/example",
          }),
          pull_request: expect.objectContaining({
            number: 7,
            merged: true,
          }),
        }),
      }),
    ]);
  });

  it("handles signed GitHub repository metadata webhooks", async () => {
    const repositories = new CapturingRepositoryWebhookHandler();
    const secret = "webhook-secret";
    const app = await createApiApp({
      githubWebhookDependencies: {
        webhookSecret: secret,
        installations: new InMemoryInstallations(),
        deliveries: new InMemoryDeliveries(),
        repositories,
        clock: fixedClock,
      },
    });
    const payload = JSON.stringify({
      action: "edited",
      installation: {
        id: 129154876,
        account: { login: "777genius", type: "User" },
        repository_selection: "all",
      },
      repository: {
        id: 123456,
        name: "renamed-example",
        full_name: "777genius/renamed-example",
        owner: { login: "777genius" },
        default_branch: "main",
        visibility: "private",
        private: true,
        archived: false,
        stargazers_count: 7,
      },
      sender: { id: 777, login: "777genius" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-api-repository-test",
        "x-github-event": "repository",
        "x-hub-signature-256": signGitHubWebhookPayload(payload, secret),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      processed: true,
      status: "synced",
    });
    expect(repositories.envelopes).toEqual([
      expect.objectContaining({
        deliveryId: "delivery-api-repository-test",
        eventName: "repository",
        payload: expect.objectContaining({
          action: "edited",
          repository: expect.objectContaining({
            full_name: "777genius/renamed-example",
            archived: false,
          }),
        }),
      }),
    ]);
  });

  it("rejects signed GitHub webhooks with invalid payload shape safely", async () => {
    const secret = "webhook-secret";
    const app = await createApiApp({
      githubWebhookDependencies: {
        webhookSecret: secret,
        installations: new InMemoryInstallations(),
        deliveries: new InMemoryDeliveries(),
        clock: fixedClock,
      },
    });
    const payload = JSON.stringify({ action: "created" });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-invalid-payload",
        "x-github-event": "installation",
        "x-hub-signature-256": signGitHubWebhookPayload(payload, secret),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_webhook_payload" });
  });

  it("ignores signed unsupported GitHub webhook events without parsing payloads", async () => {
    const secret = "webhook-secret";
    const deliveries = new InMemoryDeliveries();
    const app = await createApiApp({
      githubWebhookDependencies: {
        webhookSecret: secret,
        installations: new InMemoryInstallations(),
        deliveries,
        clock: fixedClock,
      },
    });
    const payload = JSON.stringify({ zen: "Non-legacy is the best legacy." });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-ping",
        "x-github-event": "ping",
        "x-hub-signature-256": signGitHubWebhookPayload(payload, secret),
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      processed: false,
      ignored: true,
      eventName: "ping",
    });
    expect(deliveries.deliveries.size).toBe(0);
  });

  it("rejects unsupported GitHub webhook events before ignore when signature is invalid", async () => {
    const app = await createApiApp({
      githubWebhookDependencies: {
        webhookSecret: "webhook-secret",
        installations: new InMemoryInstallations(),
        deliveries: new InMemoryDeliveries(),
        clock: fixedClock,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: JSON.stringify({ zen: "unsafe" }),
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-unsigned-ping",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=invalid",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_signature" });
  });

  it("serves action OIDC exchange, config fetch, and safe health report", async () => {
    const repositories = new InMemoryActionRepositories();
    const commentTokens = new InMemoryCommentTokenIssuer();
    const sessions = new JoseActionSessionTokenService(
      "0123456789abcdef0123456789abcdef",
    );
    const memoryItems = new InMemoryActionMemoryItems([
      actionMemorySnapshot({
        id: "mem_repo",
        body: "Prefer guard clauses in service methods.",
        scope: "repository",
        repositoryId: "repo_1",
      }),
      actionMemorySnapshot({
        id: "mem_workspace",
        body: "Use Prisma migrations for schema changes.",
        scope: "workspace",
        repositoryId: null,
        visibility: "workspace_runtime",
      }),
      actionMemorySnapshot({
        id: "mem_other_repo",
        body: "Other repository memory.",
        scope: "repository",
        repositoryId: "repo_other",
      }),
    ]);
    const actionMemory = createActionMemoryDependencies({ memoryItems });
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories,
        commentTokens,
        oidcVerifier: new StaticActionOidcVerifier(),
        sessions,
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
      actionMemoryDependencies: {
        repositories,
        sessions,
        memory: actionMemory.memory,
        clock: fixedClock,
      },
    });

    const exchange = await app.inject({
      method: "POST",
      url: "/api/action/v1/session/exchange",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });
    expect(exchange.statusCode).toBe(200);
    const session = exchange.json<{ sessionToken: string }>();
    expect(exchange.json()).toMatchObject({
      protocolVersion: 1,
      repository: "777genius/example",
    });

    const config = await app.inject({
      method: "GET",
      url: "/api/action/v1/config",
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({
      protocolVersion: 1,
      provider: { model: "gpt-5.5" },
      runtimeEnv: { REVIEW_AUTH_MODE: "codex-oauth" },
    });

    const memory = await app.inject({
      method: "GET",
      url: "/api/action/v1/memory",
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(memory.statusCode).toBe(200);
    expect(memory.json()).toMatchObject({
      protocolVersion: 1,
      memoryVersion: 1,
      items: [
        {
          id: "mem_repo",
          scope: "repository",
          body: "Prefer guard clauses in service methods.",
        },
        {
          id: "mem_workspace",
          scope: "workspace",
          body: "Use Prisma migrations for schema changes.",
        },
      ],
    });
    expect(actionMemory.usageEvents.events).toHaveLength(2);
    expect(actionMemory.usageEvents.events).toEqual([
      expect.objectContaining({
        id: "mem_usage_test_1",
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        memoryItemId: "mem_repo",
        eventType: "action_bundle_exposed",
        bundleVersion: 1,
        metadata: {
          scope: "repository",
          bundleItemCount: 2,
          githubRunId: "1001",
          githubRunAttempt: "1",
          eventName: "pull_request",
        },
      }),
      expect.objectContaining({
        id: "mem_usage_test_2",
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        memoryItemId: "mem_workspace",
        eventType: "action_bundle_exposed",
        bundleVersion: 1,
        metadata: {
          scope: "workspace",
          bundleItemCount: 2,
          githubRunId: "1001",
          githubRunAttempt: "1",
          eventName: "pull_request",
        },
      }),
    ]);
    expect(
      actionMemory.usageEvents.events.map((event) => event.dedupeKey),
    ).toEqual([
      expect.stringMatching(/^mem_usage:[a-f0-9]{64}$/),
      expect.stringMatching(/^mem_usage:[a-f0-9]{64}$/),
    ]);
    expect(JSON.stringify(actionMemory.usageEvents.events)).not.toContain(
      "guard clauses",
    );
    expect(memoryItems.snapshots.get("mem_repo")?.lastUsedAt).toEqual(
      fixedClock.now(),
    );
    expect(memoryItems.snapshots.get("mem_workspace")?.lastUsedAt).toEqual(
      fixedClock.now(),
    );
    expect(memoryItems.snapshots.get("mem_other_repo")?.lastUsedAt).toBeNull();

    const repeatedMemory = await app.inject({
      method: "GET",
      url: "/api/action/v1/memory",
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(repeatedMemory.statusCode).toBe(200);
    expect(actionMemory.usageEvents.events).toHaveLength(2);

    const commentToken = await app.inject({
      method: "POST",
      url: "/api/action/v1/comment-token",
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(commentToken.statusCode).toBe(200);
    expect(commentToken.json()).toEqual({
      protocolVersion: 1,
      token: "ghs_reviewrouter_app_token",
      expiresAt: "2026-05-03T13:00:00.000Z",
      repository: "777genius/example",
      permissions: {
        pullRequests: "write",
        issues: "write",
      },
    });
    expect(commentTokens.calls).toEqual([
      {
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
      },
    ]);

    const health = await app.inject({
      method: "POST",
      url: "/api/action/v1/health-report",
      headers: { authorization: `Bearer ${session.sessionToken}` },
      payload: {
        actionVersion: "v1",
        configVersion: 1,
        providerSetupState: "configured",
        providerHealth: "ok",
        safeErrorCategory: "none",
      },
    });

    expect(health.statusCode).toBe(200);
    expect(repositories.healthReports).toHaveLength(1);
  });

  it("accepts natural-language memory candidates from interaction workflows as suggestions", async () => {
    const repositories = new InMemoryActionRepositories();
    const sessions = new JoseActionSessionTokenService(
      "0123456789abcdef0123456789abcdef",
    );
    const actionMemory = createActionMemoryDependencies();
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories,
        oidcVerifier: new StaticActionOidcVerifier({
          sub: "repo:777genius/example:issue_comment",
          event_name: "issue_comment",
          workflow_ref:
            "777genius/example/.github/workflows/reviewrouter-interaction.yml@refs/heads/main",
        }),
        sessions,
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
      actionMemoryDependencies: {
        repositories,
        sessions,
        memory: actionMemory.memory,
        clock: fixedClock,
      },
    });

    const exchange = await app.inject({
      method: "POST",
      url: "/api/action/v1/session/exchange",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });
    expect(exchange.statusCode).toBe(200);
    const session = exchange.json<{ sessionToken: string }>();
    const response = await app.inject({
      method: "POST",
      url: "/api/action/v1/memory-candidates",
      headers: { authorization: `Bearer ${session.sessionToken}` },
      payload: {
        protocolVersion: 1,
        intent: "explicit_natural_language",
        requestedScope: "repository",
        candidateBody: "Prefer small cohesive pull requests.",
        sourceTextHash:
          "d5ebe75097ed1ac4cdd7ed02a75ed252b07b729f1639adc519c88418a1f08d71",
        extractionMethod: "explicit_natural_language",
        extractionVersion: 1,
        source: {
          sourceId: "issue_comment:12345",
          githubCommentId: "12345",
          githubPullRequestNumber: 17,
          url: "https://github.com/777genius/example/pull/17#issuecomment-12345",
          redactedExcerpt: "/reviewrouter remember: prefer small PRs",
          sourceHash:
            "d5ebe75097ed1ac4cdd7ed02a75ed252b07b729f1639adc519c88418a1f08d71",
          sourceVisibility: "private",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      protocolVersion: 1,
      status: "created",
      id: "mem_suggestion_test_1",
      version: 1,
    });
    expect(actionMemory.memorySuggestions.values()).toEqual([
      expect.objectContaining({
        id: "mem_suggestion_test_1",
        suggestedScope: "repository",
        suggestedBody: "Prefer small cohesive pull requests.",
        status: "pending",
        createdByActor: "github_user:github-login:777genius",
        source: expect.objectContaining({
          type: "pr_comment",
          sourceId: "issue_comment:12345",
          githubCommentId: "12345",
          githubPullRequestNumber: 17,
          actorLogin: "777genius",
        }),
      }),
    ]);
    expect(actionMemory.audit.events).toEqual([
      expect.objectContaining({
        action: "memory.suggestion.created",
        targetId: "mem_suggestion_test_1",
      }),
    ]);
    expect(actionMemory.outbox.events).toHaveLength(1);
  });

  it("stores explicit memory commands from interaction workflows when the actor is allowed", async () => {
    const repositories = new InMemoryActionRepositories();
    const sessions = new JoseActionSessionTokenService(
      "0123456789abcdef0123456789abcdef",
    );
    const actionMemory = createActionMemoryDependencies();
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories,
        oidcVerifier: new StaticActionOidcVerifier({
          sub: "repo:777genius/example:pull_request_review_comment",
          event_name: "pull_request_review_comment",
          workflow_ref:
            "777genius/example/.github/workflows/reviewrouter-interaction.yml@refs/heads/main",
        }),
        sessions,
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
      actionMemoryDependencies: {
        repositories,
        sessions,
        memory: actionMemory.memory,
        clock: fixedClock,
      },
    });

    const exchange = await app.inject({
      method: "POST",
      url: "/api/action/v1/session/exchange",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });
    expect(exchange.statusCode).toBe(200);
    const session = exchange.json<{ sessionToken: string }>();
    const response = await app.inject({
      method: "POST",
      url: "/api/action/v1/memory-candidates",
      headers: { authorization: `Bearer ${session.sessionToken}` },
      payload: {
        protocolVersion: 1,
        intent: "explicit_command",
        requestedScope: "repository",
        candidateBody: "Prefer guard clauses before nested conditionals.",
        extractionMethod: "explicit_command",
        extractionVersion: 1,
        source: {
          sourceId: "review_comment:98765",
          githubCommentId: "98765",
          githubPullRequestNumber: 18,
          redactedExcerpt: "/reviewrouter save memory: prefer guard clauses",
          sourceVisibility: "private",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      protocolVersion: 1,
      status: "created",
      id: "mem_test_1",
      version: 1,
    });
    expect(actionMemory.memoryItems.values()).toEqual([
      expect.objectContaining({
        id: "mem_test_1",
        scope: "repository",
        body: "Prefer guard clauses before nested conditionals.",
        createdBy: "github_user:github-login:777genius",
        confirmedBy: "github_user:github-login:777genius",
        source: expect.objectContaining({
          type: "review_comment",
          sourceId: "review_comment:98765",
          actorLogin: "777genius",
        }),
      }),
    ]);
    expect(actionMemory.permissions).toBeInstanceOf(AllowingMemoryPermissions);
    expect(
      (actionMemory.permissions as AllowingMemoryPermissions).calls,
    ).toEqual([
      expect.objectContaining({
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        scope: "repository",
        actor: expect.objectContaining({ login: "777genius" }),
      }),
    ]);
  });

  it("rejects raw memory payload fields before persistence", async () => {
    const repositories = new InMemoryActionRepositories();
    const sessions = new JoseActionSessionTokenService(
      "0123456789abcdef0123456789abcdef",
    );
    const actionMemory = createActionMemoryDependencies();
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories,
        oidcVerifier: new StaticActionOidcVerifier({
          sub: "repo:777genius/example:issue_comment",
          event_name: "issue_comment",
          workflow_ref:
            "777genius/example/.github/workflows/reviewrouter-interaction.yml@refs/heads/main",
        }),
        sessions,
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
      actionMemoryDependencies: {
        repositories,
        sessions,
        memory: actionMemory.memory,
        clock: fixedClock,
      },
    });

    const exchange = await app.inject({
      method: "POST",
      url: "/api/action/v1/session/exchange",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });
    expect(exchange.statusCode).toBe(200);
    const session = exchange.json<{ sessionToken: string }>();
    const candidateResponse = await app.inject({
      method: "POST",
      url: "/api/action/v1/memory-candidates",
      headers: { authorization: `Bearer ${session.sessionToken}` },
      payload: {
        protocolVersion: 1,
        intent: "explicit_natural_language",
        requestedScope: "repository",
        candidateBody: "Prefer small cohesive pull requests.",
        extractionMethod: "explicit_natural_language",
        extractionVersion: 1,
        rawCommentBody:
          "/rr remember repo Prefer small cohesive pull requests.",
        source: {
          sourceId: "issue_comment:12345",
          sourceVisibility: "private",
        },
      },
    });
    const commandResponse = await app.inject({
      method: "POST",
      url: "/api/action/v1/memory-commands",
      headers: { authorization: `Bearer ${session.sessionToken}` },
      payload: {
        protocolVersion: 1,
        commands: [
          {
            kind: "confirm_suggestion",
            suggestionId: "mem_suggestion_1",
            rawCommand: "/rr remember mem_suggestion_1",
          },
        ],
      },
    });

    for (const response of [candidateResponse, commandResponse]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "forbidden_action_memory_raw_field",
          message:
            "Action memory payload must not include raw conversation, code, diff, prompt, or model response fields.",
          retryable: false,
        },
      });
    }
    expect(actionMemory.memorySuggestions.values()).toEqual([]);
    expect(actionMemory.memoryItems.values()).toEqual([]);
  });

  it("executes normalized memory management commands from interaction workflows", async () => {
    const repositories = new InMemoryActionRepositories();
    const sessions = new JoseActionSessionTokenService(
      "0123456789abcdef0123456789abcdef",
    );
    const memoryItems = new InMemoryActionMemoryItems([
      actionMemorySnapshot({
        id: "mem_disable",
        body: "Disable this temporary review convention.",
      }),
      actionMemorySnapshot({
        id: "mem_forget",
        body: "Forget this stale review convention.",
      }),
    ]);
    const memorySuggestions = new InMemoryMemorySuggestions();
    memorySuggestions.snapshots.set(
      "mem_suggestion_confirm",
      actionMemorySuggestionSnapshot({
        id: "mem_suggestion_confirm",
        suggestedBody: "Prefer adapters over direct SDK imports in use cases.",
      }),
    );
    memorySuggestions.snapshots.set(
      "mem_suggestion_reject",
      actionMemorySuggestionSnapshot({
        id: "mem_suggestion_reject",
        suggestedBody: "Always use one huge service class.",
      }),
    );
    const actionMemory = createActionMemoryDependencies({
      memoryItems,
      memorySuggestions,
    });
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories,
        oidcVerifier: new StaticActionOidcVerifier({
          sub: "repo:777genius/example:issue_comment",
          event_name: "issue_comment",
          workflow_ref:
            "777genius/example/.github/workflows/reviewrouter-interaction.yml@refs/heads/main",
        }),
        sessions,
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
      actionMemoryDependencies: {
        repositories,
        sessions,
        memory: actionMemory.memory,
        clock: fixedClock,
      },
    });

    const exchange = await app.inject({
      method: "POST",
      url: "/api/action/v1/session/exchange",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });
    expect(exchange.statusCode).toBe(200);
    const response = await app.inject({
      method: "POST",
      url: "/api/action/v1/memory-commands",
      headers: {
        authorization: `Bearer ${exchange.json<{ sessionToken: string }>().sessionToken}`,
      },
      payload: {
        protocolVersion: 1,
        commands: [
          {
            kind: "confirm_suggestion",
            suggestionId: "mem_suggestion_confirm",
          },
          {
            kind: "reject_suggestion",
            suggestionId: "mem_suggestion_reject",
            reason: "bad_architecture",
          },
          { kind: "disable_memory", memoryItemId: "mem_disable" },
          { kind: "forget_memory", memoryItemId: "mem_forget" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      protocolVersion: 1,
      results: [
        {
          kind: "confirm_suggestion",
          status: "created",
          id: "mem_test_1",
          version: 1,
        },
        {
          kind: "reject_suggestion",
          status: "updated",
          id: "mem_suggestion_reject",
          version: 2,
        },
        {
          kind: "disable_memory",
          status: "updated",
          id: "mem_disable",
          version: 2,
        },
        {
          kind: "forget_memory",
          status: "updated",
          id: "mem_forget",
          version: 2,
        },
      ],
    });
    expect(actionMemory.memoryItems.snapshots.get("mem_test_1")).toMatchObject({
      scope: "repository",
      body: "Prefer adapters over direct SDK imports in use cases.",
      originSuggestionId: "mem_suggestion_confirm",
    });
    expect(
      actionMemory.memorySuggestions.snapshots.get("mem_suggestion_confirm"),
    ).toMatchObject({ status: "confirmed", relatedMemoryItemId: "mem_test_1" });
    expect(
      actionMemory.memorySuggestions.snapshots.get("mem_suggestion_reject"),
    ).toMatchObject({
      status: "rejected",
      resolutionReason: "bad_architecture",
    });
    expect(actionMemory.memoryItems.snapshots.get("mem_disable")).toMatchObject(
      {
        status: "disabled",
      },
    );
    expect(actionMemory.memoryItems.snapshots.get("mem_forget")).toMatchObject({
      status: "deleted",
      body: deletedMemoryBodyPlaceholder,
      source: { type: "system_migration", sourceId: "deleted" },
    });
    expect(actionMemory.audit.events.map((event) => event.action)).toEqual([
      "memory.suggestion.confirmed",
      "memory.suggestion.rejected",
      "memory.item.disabled",
      "memory.item.deleted",
    ]);
  });

  it("rejects memory candidate submission outside interaction workflows", async () => {
    const repositories = new InMemoryActionRepositories();
    const sessions = new JoseActionSessionTokenService(
      "0123456789abcdef0123456789abcdef",
    );
    const actionMemory = createActionMemoryDependencies();
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories,
        oidcVerifier: new StaticActionOidcVerifier(),
        sessions,
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
      actionMemoryDependencies: {
        repositories,
        sessions,
        memory: actionMemory.memory,
        clock: fixedClock,
      },
    });

    const exchange = await app.inject({
      method: "POST",
      url: "/api/action/v1/session/exchange",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });
    expect(exchange.statusCode).toBe(200);
    const response = await app.inject({
      method: "POST",
      url: "/api/action/v1/memory-candidates",
      headers: {
        authorization: `Bearer ${exchange.json<{ sessionToken: string }>().sessionToken}`,
      },
      payload: {
        protocolVersion: 1,
        intent: "explicit_natural_language",
        requestedScope: "repository",
        candidateBody: "Prefer small cohesive pull requests.",
        extractionMethod: "explicit_natural_language",
        extractionVersion: 1,
        source: {
          sourceId: "pull_request:17",
          sourceVisibility: "private",
        },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: "memory_interaction_event_required",
        message:
          "Memory updates can only be submitted from interaction workflows.",
        retryable: false,
      },
    });
    const commandResponse = await app.inject({
      method: "POST",
      url: "/api/action/v1/memory-commands",
      headers: {
        authorization: `Bearer ${exchange.json<{ sessionToken: string }>().sessionToken}`,
      },
      payload: {
        protocolVersion: 1,
        commands: [
          {
            kind: "confirm_suggestion",
            suggestionId: "mem_suggestion_1",
          },
        ],
      },
    });
    expect(commandResponse.statusCode).toBe(403);
    expect(commandResponse.json()).toEqual({
      error: {
        code: "memory_interaction_event_required",
        message:
          "Memory updates can only be submitted from interaction workflows.",
        retryable: false,
      },
    });
    expect(actionMemory.memorySuggestions.values()).toEqual([]);
    expect(actionMemory.memoryItems.values()).toEqual([]);
  });

  it("returns a safe error when App comment identity is unavailable", async () => {
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories: new InMemoryActionRepositories(),
        oidcVerifier: new StaticActionOidcVerifier(),
        sessions: new JoseActionSessionTokenService(
          "0123456789abcdef0123456789abcdef",
        ),
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
    });

    const exchange = await app.inject({
      method: "POST",
      url: "/api/action/v1/session/exchange",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/action/v1/comment-token",
      headers: {
        authorization: `Bearer ${exchange.json<{ sessionToken: string }>().sessionToken}`,
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: "comment_token_unavailable",
        message:
          "ReviewRouter App comment identity is temporarily unavailable.",
        retryable: true,
      },
    });
  });

  it("keeps legacy action endpoints available for current action compatibility", async () => {
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories: new InMemoryActionRepositories(),
        oidcVerifier: new StaticActionOidcVerifier(),
        sessions: new JoseActionSessionTokenService(
          "0123456789abcdef0123456789abcdef",
        ),
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
    });

    const exchange = await app.inject({
      method: "POST",
      url: "/api/action/exchange-token",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });
    expect(exchange.statusCode).toBe(200);

    const config = await app.inject({
      method: "GET",
      url: "/api/action/config",
      headers: {
        authorization: `Bearer ${exchange.json<{ sessionToken: string }>().sessionToken}`,
      },
    });
    expect(config.statusCode).toBe(200);
  });

  it("maps replayed action OIDC tokens to a safe auth error", async () => {
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories: new InMemoryActionRepositories(),
        replayNonces: new InMemoryActionReplayNonces(),
        oidcVerifier: new StaticActionOidcVerifier({ jti: "replayed-jti" }),
        sessions: new JoseActionSessionTokenService(
          "0123456789abcdef0123456789abcdef",
        ),
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
    });

    const first = await app.inject({
      method: "POST",
      url: "/api/action/exchange-token",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/action/exchange-token",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(401);
    expect(second.json()).toEqual({ error: "invalid_action_token" });
  });

  it("returns structured safe errors from versioned action endpoints", async () => {
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories: new InMemoryActionRepositories(),
        oidcVerifier: new StaticActionOidcVerifier(),
        sessions: new JoseActionSessionTokenService(
          "0123456789abcdef0123456789abcdef",
        ),
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/action/v1/config",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "missing_action_session_token",
        message: "Action session token is missing.",
        retryable: false,
      },
    });
  });

  it("returns structured update-required errors for blocked action versions", async () => {
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories: new InMemoryActionRepositories(),
        oidcVerifier: new StaticActionOidcVerifier(),
        sessions: new JoseActionSessionTokenService(
          "0123456789abcdef0123456789abcdef",
        ),
        compatibility: new StaticActionRuntimeCompatibilityPolicy({
          blockedActionVersions: ["v0.9.0"],
        }),
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
    });

    const exchange = await app.inject({
      method: "POST",
      url: "/api/action/v1/session/exchange",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });
    const session = exchange.json<{ sessionToken: string }>();
    const response = await app.inject({
      method: "GET",
      url: "/api/action/v1/config",
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        "x-reviewrouter-action-version": "v0.9.0",
      },
    });

    expect(response.statusCode).toBe(426);
    expect(response.json()).toEqual({
      error: {
        code: "action_version_blocked",
        message:
          "Installed ReviewRouter Action version is blocked and must be updated.",
        retryable: false,
      },
    });
  });

  it("rejects unsafe or oversized action health reports without leaking payload values", async () => {
    const repositories = new InMemoryActionRepositories();
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories,
        oidcVerifier: new StaticActionOidcVerifier(),
        sessions: new JoseActionSessionTokenService(
          "0123456789abcdef0123456789abcdef",
        ),
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
    });
    const exchange = await app.inject({
      method: "POST",
      url: "/api/action/exchange-token",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });
    const session = exchange.json<{ sessionToken: string }>();
    const openAiToken = "s" + "k-" + "z".repeat(24);

    const unsafe = await app.inject({
      method: "POST",
      url: "/api/action/health-report",
      headers: { authorization: `Bearer ${session.sessionToken}` },
      payload: {
        actionVersion: "v1",
        configVersion: 1,
        providerSetupState: "configured",
        providerHealth: "failed",
        safeErrorCategory: "runtime_error",
        rawProviderOutput: `OPENAI_API_KEY=${openAiToken}`,
      },
    });
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json()).toEqual({
      error: "health_report_contains_secret_value",
    });
    expect(unsafe.body).not.toContain(openAiToken);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/action/health-report",
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        actionVersion: "v1",
        configVersion: 1,
        providerSetupState: "configured",
        providerHealth: "failed",
        safeErrorCategory: "runtime_error",
        safeErrorSummary: "x".repeat(actionHealthReportMaxBytes),
      }),
    });
    expect(oversized.statusCode).toBe(413);
    expect(repositories.healthReports).toHaveLength(0);
  });

  it("can disable action control plane with a kill switch", async () => {
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories: new InMemoryActionRepositories(),
        oidcVerifier: new StaticActionOidcVerifier(),
        sessions: new JoseActionSessionTokenService(
          "0123456789abcdef0123456789abcdef",
        ),
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
        controlPlaneEnabled: false,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/action/exchange-token",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "action_control_plane_disabled" });
  });

  it("maps action control plane entitlement denial to a safe error", async () => {
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories: new InMemoryActionRepositories(),
        entitlements: new DenyingActionEntitlements(),
        oidcVerifier: new StaticActionOidcVerifier(),
        sessions: new JoseActionSessionTokenService(
          "0123456789abcdef0123456789abcdef",
        ),
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/action/exchange-token",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "action_control_plane_entitlement_denied",
    });
  });

  it("maps action rate limit denial to a safe retryable error", async () => {
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories: new InMemoryActionRepositories(),
        rateLimits: new DenyingActionRateLimits(),
        oidcVerifier: new StaticActionOidcVerifier(),
        sessions: new JoseActionSessionTokenService(
          "0123456789abcdef0123456789abcdef",
        ),
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/action/exchange-token",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: "rate_limited" });
  });
});
