import { describe, expect, it } from "vitest";
import type {
  ActionConflictReviewDispatchPayload,
  ActionConflictReviewExchangeVerifierPort,
  ActionConflictReviewPostingGatewayPort,
  ActionConflictReviewPostingSessionRepositoryPort,
  ActionConflictReviewPostingSessionScope,
  ActionConflictReviewPrePostValidatorPort,
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
  JoseActionConflictReviewPostingSessionTokenService,
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
  MemorySearchIndexInput,
  MemorySearchIndexPort,
  MemorySearchIndexResult,
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
  StaticMemoryPolicyConfig,
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
import type { RegisterGitLabIntegrationRoutesDependencies } from "@reviewrouter/features-gitlab-integration";
import type { Clock } from "@reviewrouter/shared";
import { reviewActionV2GoldenFixtures } from "@reviewrouter/protocol-review-action-v2";
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

type RuntimeReviewConfiguration = NonNullable<
  Awaited<
    ReturnType<
      ActionControlPlaneRepositoryPort["findRuntimeReviewConfiguration"]
    >
  >
>["config"];

function openRouterRuntimeReviewConfiguration(): RuntimeReviewConfiguration {
  const provider = {
    kind: "openrouter" as const,
    authMode: "openrouter_api_key" as const,
    model: "poolside/laguna-m.1:free",
    reasoningEffort: "medium" as const,
    agenticContext: true,
    fastMode: false,
    requiredHealthy: true,
  };
  return {
    schemaVersion: 2,
    provider,
    providers: [provider],
    execution: {
      providerLimit: 1,
      providerMaxParallel: 1,
      inlineMinAgreement: 1,
    },
    blockingPolicy: { failOnSeverity: "critical" },
    limits: { inlineMaxComments: 5, targetTokensPerBatch: 50000 },
  };
}

class InMemoryActionRepositories implements ActionControlPlaneRepositoryPort {
  public readonly healthReports: ActionHealthReport[] = [];
  public runtimeConfig: RuntimeReviewConfiguration | null = null;
  public runtimeConfigVersion = 1;

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
    if (this.runtimeConfig) {
      return {
        source: "repository" as const,
        version: this.runtimeConfigVersion,
        config: this.runtimeConfig,
      };
    }
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

  async listForExport(input: {
    readonly workspaceId: string;
    readonly statuses: readonly Exclude<
      MemoryItemSnapshot["status"],
      "deleted"
    >[];
    readonly limit: number;
  }) {
    const exportable = this.values()
      .filter((item) => item.workspaceId === input.workspaceId)
      .filter((item) =>
        (input.statuses as readonly MemoryItemSnapshot["status"][]).includes(
          item.status,
        ),
      );
    return {
      items: exportable.slice(0, input.limit),
      totalMatchingCount: exportable.length,
      excludedDeletedCount: this.values().filter(
        (item) =>
          item.workspaceId === input.workspaceId && item.status === "deleted",
      ).length,
    };
  }

  async listExpiredActive(input: {
    readonly workspaceId: string;
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<readonly MemoryItemSnapshot[]> {
    return this.values()
      .filter((item) => item.workspaceId === input.workspaceId)
      .filter((item) => item.status === "active")
      .filter(
        (item) =>
          item.expiresAt !== null && item.expiresAt <= input.expiredAtOrBefore,
      )
      .slice(0, input.limit);
  }

  async listWorkspaceIdsWithExpiredActive(input: {
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<readonly string[]> {
    return [
      ...new Set(
        this.values()
          .filter((item) => item.status === "active")
          .filter(
            (item) =>
              item.expiresAt !== null &&
              item.expiresAt <= input.expiredAtOrBefore,
          )
          .map((item) => item.workspaceId),
      ),
    ].slice(0, input.limit);
  }

  async listPrunableTerminal(input: {
    readonly workspaceId: string;
    readonly updatedBefore: Date;
    readonly limit: number;
  }) {
    return this.values()
      .filter((item) => item.workspaceId === input.workspaceId)
      .filter((item) => item.status === "expired" || item.status === "deleted")
      .filter((item) => item.updatedAt < input.updatedBefore)
      .slice(0, input.limit)
      .map((item) => ({
        id: item.id,
        workspaceId: item.workspaceId,
        repositoryId: item.repositoryId,
        status: item.status as "expired" | "deleted",
        updatedAt: item.updatedAt,
      }));
  }

  async listWorkspaceIdsWithPrunableTerminal(input: {
    readonly updatedBefore: Date;
    readonly limit: number;
  }): Promise<readonly string[]> {
    return [
      ...new Set(
        this.values()
          .filter(
            (item) => item.status === "expired" || item.status === "deleted",
          )
          .filter((item) => item.updatedAt < input.updatedBefore)
          .map((item) => item.workspaceId),
      ),
    ].slice(0, input.limit);
  }

  async pruneTerminal(input: {
    readonly workspaceId: string;
    readonly itemIds: readonly string[];
    readonly updatedBefore: Date;
  }): Promise<{
    readonly deletedCount: number;
    readonly deletedIds: string[];
  }> {
    const itemIds = new Set(input.itemIds);
    const deletedIds: string[] = [];
    for (const [id, item] of this.snapshots.entries()) {
      if (
        item.workspaceId !== input.workspaceId ||
        !itemIds.has(id) ||
        (item.status !== "expired" && item.status !== "deleted") ||
        item.updatedAt >= input.updatedBefore
      ) {
        continue;
      }
      this.snapshots.delete(id);
      deletedIds.push(id);
    }
    return { deletedCount: deletedIds.length, deletedIds };
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

  async markIndexingSucceeded(input: {
    readonly workspaceId: string;
    readonly itemId: string;
    readonly bodyHash: string;
    readonly bodyVersion: number;
  }): Promise<{ readonly updatedCount: number }> {
    const item = this.snapshots.get(input.itemId);
    if (
      !item ||
      item.workspaceId !== input.workspaceId ||
      item.status !== "active" ||
      item.bodyHash !== input.bodyHash ||
      item.bodyVersion !== input.bodyVersion
    ) {
      return { updatedCount: 0 };
    }
    this.snapshots.set(input.itemId, {
      ...item,
      indexState: "indexed",
      indexVersion: input.bodyVersion,
    });
    return { updatedCount: 1 };
  }

  async markIndexingDeleted(input: {
    readonly workspaceId: string;
    readonly itemId: string;
  }): Promise<{ readonly updatedCount: number }> {
    const item = this.snapshots.get(input.itemId);
    if (
      !item ||
      item.workspaceId !== input.workspaceId ||
      item.status === "active"
    ) {
      return { updatedCount: 0 };
    }
    this.snapshots.set(input.itemId, {
      ...item,
      indexState: "index_deleted",
      indexVersion: null,
    });
    return { updatedCount: 1 };
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

class CapturingMemorySearchIndex implements MemorySearchIndexPort {
  public readonly inputs: MemorySearchIndexInput[] = [];

  constructor(private readonly results: readonly MemorySearchIndexResult[]) {}

  async supports(): ReturnType<MemorySearchIndexPort["supports"]> {
    return { capabilities: ["lexical"] };
  }

  async search(
    input: MemorySearchIndexInput,
  ): Promise<readonly MemorySearchIndexResult[]> {
    this.inputs.push(input);
    return this.results;
  }

  async upsertDocument(): Promise<void> {
    return undefined;
  }

  async deleteDocument(): Promise<void> {
    return undefined;
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
  public calls = 0;

  constructor(
    private readonly overrides: Partial<GitHubActionsOidcClaims> = {},
  ) {}

  async verify(): Promise<GitHubActionsOidcClaims> {
    this.calls += 1;
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

class InMemoryConflictReviewExchangeVerifier implements ActionConflictReviewExchangeVerifierPort {
  public readonly calls: ActionConflictReviewDispatchPayload[] = [];

  async verifyConflictReviewExchange(input: {
    readonly claims: GitHubActionsOidcClaims;
    readonly dispatchPayload: ActionConflictReviewDispatchPayload;
    readonly configSnapshotId: string;
    readonly exchangedAt: Date;
  }) {
    this.calls.push(input.dispatchPayload);
    return {
      reviewKind: "conflict-head" as const,
      dispatchId: input.dispatchPayload.dispatchId,
      pullRequestNumber: input.dispatchPayload.pullRequestNumber,
      headSha: input.dispatchPayload.headSha,
      baseRef: input.dispatchPayload.baseRef,
      baseSha: input.dispatchPayload.baseSha,
    };
  }
}

class InMemoryActionReplayNonces implements ActionOidcReplayNonceStorePort {
  private readonly keys = new Set<string>();
  public calls = 0;

  async tryConsumeNonce(input: { readonly key: string }): Promise<boolean> {
    this.calls += 1;
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
        contents: "read" as const,
        pullRequests: "write" as const,
        issues: "write" as const,
        statuses: "write" as const,
      },
    };
  }
}

class InMemoryConflictPostingSessionRepository implements ActionConflictReviewPostingSessionRepositoryPort {
  public readonly issued: ActionConflictReviewPostingSessionScope[] = [];
  public readonly intents = new Map<
    string,
    | {
        readonly status: "reserved";
        readonly intentId: string;
        readonly operationKind: "summary_comment" | "advisory_status";
      }
    | {
        readonly status: "completed";
        readonly intentId: string;
        readonly operationKind: "summary_comment" | "advisory_status";
        readonly githubExternalId: string;
        readonly githubUrl: string | null;
      }
    | {
        readonly status: "pending";
        readonly intentId: string;
        readonly operationKind: "summary_comment" | "advisory_status";
      }
  >();

  async issueConflictReviewPostingSession(input: {
    readonly session: {
      readonly workspaceId: string;
      readonly repositoryId: string;
      readonly githubRepositoryId: string;
      readonly repository: string;
      readonly githubRunId: string;
      readonly githubRunAttempt: string;
      readonly conflictDispatchId?: string;
      readonly pullRequestNumber?: number;
      readonly headSha?: string;
      readonly baseRef?: string;
      readonly baseSha?: string;
      readonly configSnapshotId?: string;
    };
    readonly manifestHash: string;
  }): Promise<ActionConflictReviewPostingSessionScope> {
    if (
      !input.session.conflictDispatchId ||
      !input.session.pullRequestNumber ||
      !input.session.headSha ||
      !input.session.baseRef ||
      !input.session.baseSha ||
      !input.session.configSnapshotId
    ) {
      throw new Error("conflict_review_session_required");
    }
    const scope: ActionConflictReviewPostingSessionScope = {
      purpose: "conflict-review-posting",
      attemptId: `attempt:${input.session.conflictDispatchId}`,
      workspaceId: input.session.workspaceId,
      repositoryId: input.session.repositoryId,
      githubRepositoryId: input.session.githubRepositoryId,
      githubInstallationId: "129500385",
      repository: input.session.repository,
      githubRunId: input.session.githubRunId,
      githubRunAttempt: input.session.githubRunAttempt,
      dispatchId: input.session.conflictDispatchId,
      pullRequestNumber: input.session.pullRequestNumber,
      headSha: input.session.headSha,
      baseRef: input.session.baseRef,
      baseSha: input.session.baseSha,
      configSnapshotId: input.session.configSnapshotId,
      manifestHash: input.manifestHash,
      operationScopeHash: "d".repeat(64),
      protocolVersion: 1,
    };
    this.issued.push(scope);
    return scope;
  }

  async reserveConflictReviewPostingIntent(input: {
    readonly operationKind: "summary_comment" | "advisory_status";
    readonly operationFingerprint: string;
  }) {
    const existing = this.intents.get(input.operationFingerprint);
    if (existing) {
      return existing;
    }
    const intent = {
      status: "reserved" as const,
      intentId: `intent_${this.intents.size + 1}`,
      operationKind: input.operationKind,
    };
    this.intents.set(input.operationFingerprint, intent);
    return intent;
  }

  async commitConflictReviewPostingIntent(input: {
    readonly intentId: string;
    readonly operationKind: "summary_comment" | "advisory_status";
    readonly githubExternalId: string;
    readonly githubUrl?: string | undefined;
  }): Promise<void> {
    const entry = [...this.intents.entries()].find(
      ([, intent]) => intent.intentId === input.intentId,
    );
    if (!entry) {
      throw new Error("conflict_review_posting_intent_missing");
    }
    this.intents.set(entry[0], {
      status: "completed",
      intentId: input.intentId,
      operationKind: input.operationKind,
      githubExternalId: input.githubExternalId,
      githubUrl: input.githubUrl ?? null,
    });
  }

  async markConflictReviewPostingIntentAmbiguous(input: {
    readonly intentId: string;
    readonly operationKind: "summary_comment" | "advisory_status";
  }): Promise<void> {
    const entry = [...this.intents.entries()].find(
      ([, intent]) => intent.intentId === input.intentId,
    );
    if (entry) {
      this.intents.set(entry[0], {
        status: "pending",
        intentId: input.intentId,
        operationKind: input.operationKind,
      });
    }
  }
}

class CapturingConflictPrePostValidator implements ActionConflictReviewPrePostValidatorPort {
  public readonly calls: Array<{
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
  }> = [];

  async assertConflictReviewPrePostState(
    input: (typeof this.calls)[number],
  ): Promise<void> {
    this.calls.push(input);
  }
}

class CapturingConflictPostingGateway implements ActionConflictReviewPostingGatewayPort {
  public readonly summaries: Array<{
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly marker: string;
    readonly body: string;
  }> = [];
  public readonly statuses: Array<{
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly context: string;
    readonly state: "success" | "failure" | "error";
    readonly description: string;
  }> = [];

  async upsertConflictReviewSummary(input: {
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly marker: string;
    readonly body: string;
  }) {
    this.summaries.push(input);
    return {
      githubExternalId: "summary_1",
      githubUrl: "https://github.com/777genius/example/pull/7#issuecomment-1",
    };
  }

  async postConflictReviewAdvisoryStatus(input: {
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly context: string;
    readonly state: "success" | "failure" | "error";
    readonly description: string;
  }) {
    this.statuses.push(input);
    return {
      githubExternalId: "status_1",
      githubUrl: "https://github.com/777genius/example/pull/7/checks",
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
      memoryPolicyConfig: new StaticMemoryPolicyConfig(),
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
        provider: "codex_oauth_rotating",
      },
    });
    expect(response.body).toContain("/api/action/v1/session/exchange");
    expect(response.body).toContain("Choose provider credentials");
    expect(response.body).toContain("Runtime access");
    expect(response.body).toContain("repository source code");
    expect(response.body).toContain("Codex OAuth rotating auth.json");
    expect(response.body).not.toContain("codex_api_key");
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

  it("persists pre-admission intent before claiming the generic webhook delivery", async () => {
    const deliveries = new InMemoryDeliveries();
    const pullRequests = new CapturingPullRequestWebhookHandler();
    const secret = "webhook-secret";
    const app = await createApiApp({
      githubWebhookDependencies: {
        webhookSecret: secret,
        installations: new InMemoryInstallations(),
        deliveries,
        preAdmissionPullRequests: {
          async handleGitHubPullRequestWebhook() {
            throw new Error("pre_admission_unavailable");
          },
        },
        pullRequests,
        clock: fixedClock,
      },
    });
    const payload = JSON.stringify({
      action: "synchronize",
      installation: { id: 129154876 },
      repository: {
        id: 123456,
        name: "example",
        full_name: "777genius/example",
      },
      pull_request: {
        number: 7,
        html_url: "https://github.com/777genius/example/pull/7",
        state: "open",
        merged: false,
        draft: false,
        base: { ref: "main", sha: "a".repeat(40) },
        head: {
          ref: "feature",
          sha: "b".repeat(40),
          repo: { full_name: "777genius/example" },
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-pre-admission-order",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signGitHubWebhookPayload(payload, secret),
      },
    });

    expect(response.statusCode).toBe(500);
    expect(deliveries.deliveries.size).toBe(0);
    expect(pullRequests.envelopes).toHaveLength(0);
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

  it("ignores advisory commit status webhooks as non-review triggers", async () => {
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
    const payload = JSON.stringify({
      context: "ReviewRouter conflict review",
      sha: "a".repeat(40),
      state: "success",
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-status",
        "x-github-event": "status",
        "x-hub-signature-256": signGitHubWebhookPayload(payload, secret),
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      processed: false,
      ignored: true,
      eventName: "status",
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
    repositories.runtimeConfig = openRouterRuntimeReviewConfiguration();
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
      provider: { model: "poolside/laguna-m.1:free" },
      runtimeEnv: { REVIEW_AUTH_MODE: "openrouter-api" },
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
        contents: "read",
        pullRequests: "write",
        issues: "write",
        statuses: "write",
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

  it("uses a safe action memory retrieval query when the runtime provides one", async () => {
    const repositories = new InMemoryActionRepositories();
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
        id: "mem_browser",
        body: "Run dashboard memory changes through browser layout checks.",
        scope: "repository",
        repositoryId: "repo_1",
      }),
    ]);
    const actionMemory = createActionMemoryDependencies({ memoryItems });
    const searchIndex = new CapturingMemorySearchIndex([
      {
        memoryItemId: "mem_browser",
        scope: "repository",
        score: 10,
        scoreParts: {
          lexicalScore: 1,
          semanticScore: 0,
          recencyScore: 0,
          scopeScore: 0,
          riskPenalty: 0,
        },
        explanationCode: "lexical_match",
      },
    ]);
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
        memorySearchIndex: searchIndex,
        clock: fixedClock,
      },
    });

    const exchange = await app.inject({
      method: "POST",
      url: "/api/action/v1/session/exchange",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/action/v1/memory?safeRetrievalQuery=browser%20layout",
      headers: {
        authorization: `Bearer ${exchange.json<{ sessionToken: string }>().sessionToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      protocolVersion: 1,
      memoryVersion: 1,
      items: [
        {
          id: "mem_browser",
          scope: "repository",
          body: "Run dashboard memory changes through browser layout checks.",
        },
      ],
    });
    expect(searchIndex.inputs).toEqual([
      expect.objectContaining({
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
        safeQuery: "browser layout",
        includeUserPrefs: false,
      }),
    ]);
    expect(actionMemory.usageEvents.events).toHaveLength(1);
    expect(actionMemory.usageEvents.events[0]).toMatchObject({
      memoryItemId: "mem_browser",
      metadata: { bundleItemCount: 1 },
    });
  });

  it("ignores unsafe action memory retrieval queries and falls back to canonical bundle", async () => {
    const repositories = new InMemoryActionRepositories();
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
    ]);
    const actionMemory = createActionMemoryDependencies({ memoryItems });
    const searchIndex = new CapturingMemorySearchIndex([]);
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
        memorySearchIndex: searchIndex,
        clock: fixedClock,
      },
    });

    const exchange = await app.inject({
      method: "POST",
      url: "/api/action/v1/session/exchange",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/action/v1/memory?safeRetrievalQuery=diff%20--git%20a%2Fx%20b%2Fx",
      headers: {
        authorization: `Bearer ${exchange.json<{ sessionToken: string }>().sessionToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{ id: "mem_repo" }],
      degraded: false,
    });
    expect(searchIndex.inputs).toEqual([]);
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

  it("rejects ambiguous conflict dispatch aliases at the HTTP boundary", async () => {
    const conflictReviews = new InMemoryConflictReviewExchangeVerifier();
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories: new InMemoryActionRepositories(),
        conflictReviews,
        oidcVerifier: new StaticActionOidcVerifier({
          event_name: "repository_dispatch",
          workflow_ref:
            "777genius/example/.github/workflows/reviewrouter.yml@refs/heads/main",
          job_workflow_ref:
            "777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@refs/tags/v1",
        }),
        sessions: new JoseActionSessionTokenService(
          "0123456789abcdef0123456789abcdef",
        ),
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v1/session/exchange",
      payload: {
        oidcToken: "opaque-github-oidc-token",
        conflictDispatch: {
          protocolVersion: 1,
          protocol_version: 1,
          dispatch_event_type: "reviewrouter_conflict_review",
          dispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
          dispatch_id: "cr_123e4567-e89b-12d3-a456-426614174001",
          nonce: "n".repeat(40),
          repository_id: "123456",
          pr_number: 7,
          head_sha: "a".repeat(40),
          base_ref: "main",
          base_sha: "b".repeat(40),
          fallback_version: 1,
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "invalid_action_request",
        message: "Action control plane request is invalid.",
        retryable: false,
      },
    });
    expect(conflictReviews.calls).toHaveLength(0);

    const sameAliasResponse = await app.inject({
      method: "POST",
      url: "/api/action/v1/session/exchange",
      payload: {
        oidcToken: "opaque-github-oidc-token",
        conflictDispatch: {
          protocol_version: 1,
          dispatch_event_type: "reviewrouter_conflict_review",
          dispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
          dispatch_id: "cr_123e4567-e89b-12d3-a456-426614174000",
          nonce: "n".repeat(40),
          repository_id: "123456",
          pr_number: 7,
          head_sha: "a".repeat(40),
          base_ref: "main",
          base_sha: "b".repeat(40),
          fallback_version: 1,
        },
      },
    });

    expect(sameAliasResponse.statusCode).toBe(400);
    expect(sameAliasResponse.json()).toEqual({
      error: {
        code: "invalid_action_request",
        message: "Action control plane request is invalid.",
        retryable: false,
      },
    });
    expect(conflictReviews.calls).toHaveLength(0);

    const unknownFieldResponse = await app.inject({
      method: "POST",
      url: "/api/action/v1/session/exchange",
      payload: {
        oidcToken: "opaque-github-oidc-token",
        conflictDispatch: {
          protocol_version: 1,
          dispatch_event_type: "reviewrouter_conflict_review",
          dispatch_id: "cr_123e4567-e89b-12d3-a456-426614174000",
          nonce: "n".repeat(40),
          repository_id: "123456",
          pr_number: 7,
          head_sha: "a".repeat(40),
          base_ref: "main",
          base_sha: "b".repeat(40),
          fallback_version: 1,
          providerConfig: { model: "unsafe" },
        },
      },
    });

    expect(unknownFieldResponse.statusCode).toBe(400);
    expect(unknownFieldResponse.json()).toEqual({
      error: {
        code: "invalid_action_request",
        message: "Action control plane request is invalid.",
        retryable: false,
      },
    });
    expect(conflictReviews.calls).toHaveLength(0);
  });

  it("exposes a conflict posting endpoint that validates session shape but fails closed", async () => {
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories: new InMemoryActionRepositories(),
        conflictReviews: new InMemoryConflictReviewExchangeVerifier(),
        commentTokens: new InMemoryCommentTokenIssuer(),
        oidcVerifier: new StaticActionOidcVerifier({
          event_name: "repository_dispatch",
          workflow_ref:
            "777genius/example/.github/workflows/reviewrouter.yml@refs/heads/main",
          job_workflow_ref:
            "777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@refs/tags/v1",
        }),
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
      payload: {
        oidcToken: "opaque-github-oidc-token",
        conflictDispatch: {
          protocol_version: 1,
          dispatch_event_type: "reviewrouter_conflict_review",
          dispatch_id: "cr_123e4567-e89b-12d3-a456-426614174000",
          nonce: "n".repeat(40),
          repository_id: "123456",
          pr_number: 7,
          head_sha: "a".repeat(40),
          base_ref: "main",
          base_sha: "b".repeat(40),
          fallback_version: 1,
        },
      },
    });
    expect(exchange.statusCode).toBe(200);
    const conflictSessionToken = exchange.json<{ sessionToken: string }>()
      .sessionToken;

    const genericCommentToken = await app.inject({
      method: "POST",
      url: "/api/action/v1/comment-token",
      headers: {
        authorization: `Bearer ${conflictSessionToken}`,
      },
    });
    expect(genericCommentToken.statusCode).toBe(503);
    expect(genericCommentToken.json()).toEqual({
      error: {
        code: "conflict_review_posting_unavailable",
        message: "Conflict review posting is not available for this runtime.",
        retryable: false,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v1/conflict-posting/session",
      headers: {
        authorization: `Bearer ${conflictSessionToken}`,
      },
      payload: {
        protocolVersion: 1,
        manifestHash: "c".repeat(64),
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: "conflict_review_posting_unavailable",
        message: "Conflict review posting is not available for this runtime.",
        retryable: false,
      },
    });
  });

  it("serves conflict posting session, summary, and advisory status through scoped HTTP routes", async () => {
    const conflictPostingSessions =
      new InMemoryConflictPostingSessionRepository();
    const postingSessions =
      new JoseActionConflictReviewPostingSessionTokenService(
        "0123456789abcdef0123456789abcdef",
      );
    const conflictPrePostValidator = new CapturingConflictPrePostValidator();
    const conflictPostingGateway = new CapturingConflictPostingGateway();
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories: new InMemoryActionRepositories(),
        conflictReviews: new InMemoryConflictReviewExchangeVerifier(),
        conflictPostingSessions,
        postingSessions,
        conflictPrePostValidator,
        conflictPostingGateway,
        commentTokens: new InMemoryCommentTokenIssuer(),
        oidcVerifier: new StaticActionOidcVerifier({
          event_name: "repository_dispatch",
          workflow_ref:
            "777genius/example/.github/workflows/reviewrouter.yml@refs/heads/main",
          job_workflow_ref:
            "777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@refs/tags/v1",
        }),
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
      payload: {
        oidcToken: "opaque-github-oidc-token",
        conflictDispatch: {
          protocol_version: 1,
          dispatch_event_type: "reviewrouter_conflict_review",
          dispatch_id: "cr_123e4567-e89b-12d3-a456-426614174000",
          nonce: "n".repeat(40),
          repository_id: "123456",
          pr_number: 7,
          head_sha: "a".repeat(40),
          base_ref: "main",
          base_sha: "b".repeat(40),
          fallback_version: 1,
        },
      },
    });
    expect(exchange.statusCode).toBe(200);
    const conflictSessionToken = exchange.json<{ sessionToken: string }>()
      .sessionToken;

    const genericCommentToken = await app.inject({
      method: "POST",
      url: "/api/action/v1/comment-token",
      headers: { authorization: `Bearer ${conflictSessionToken}` },
    });
    expect(genericCommentToken.statusCode).toBe(503);

    const postingSession = await app.inject({
      method: "POST",
      url: "/api/action/v1/conflict-posting/session",
      headers: { authorization: `Bearer ${conflictSessionToken}` },
      payload: {
        protocolVersion: 1,
        manifestHash: "c".repeat(64),
      },
    });
    expect(postingSession.statusCode).toBe(200);
    expect(postingSession.json()).toMatchObject({
      protocolVersion: 1,
      manifestHash: "c".repeat(64),
      scope: {
        dispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
        pullRequestNumber: 7,
        headSha: "a".repeat(40),
        allowedOperations: ["summary_comment", "advisory_status"],
      },
    });
    const postingSessionToken = postingSession.json<{
      postingSessionToken: string;
    }>().postingSessionToken;
    await expect(
      postingSessions.verify({
        token: postingSessionToken,
        now: fixedClock.now(),
      }),
    ).resolves.toMatchObject({
      purpose: "conflict-review-posting",
      dispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
    });

    const summary = await app.inject({
      method: "POST",
      url: "/api/action/v1/conflict-posting/summary",
      headers: { authorization: `Bearer ${postingSessionToken}` },
      payload: {
        protocolVersion: 1,
        summaryMarkdown: "Conflict-head review found one bounded issue.",
      },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({
      protocolVersion: 1,
      status: "posted",
      githubExternalId: "summary_1",
    });

    const duplicateSummary = await app.inject({
      method: "POST",
      url: "/api/action/v1/conflict-posting/summary",
      headers: { authorization: `Bearer ${postingSessionToken}` },
      payload: {
        protocolVersion: 1,
        summaryMarkdown: "Conflict-head review found one bounded issue.",
      },
    });
    expect(duplicateSummary.statusCode).toBe(200);
    expect(duplicateSummary.json()).toMatchObject({
      protocolVersion: 1,
      status: "already_posted",
      githubExternalId: "summary_1",
    });

    const status = await app.inject({
      method: "POST",
      url: "/api/action/v1/conflict-posting/status",
      headers: { authorization: `Bearer ${postingSessionToken}` },
      payload: {
        protocolVersion: 1,
        state: "success",
      },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      protocolVersion: 1,
      status: "posted",
      githubExternalId: "status_1",
    });

    expect(conflictPostingSessions.issued).toHaveLength(1);
    expect(conflictPrePostValidator.calls).toHaveLength(4);
    expect(conflictPostingGateway.summaries).toHaveLength(1);
    expect(conflictPostingGateway.summaries[0]?.body).toContain(
      "reviewrouter:conflict-review:v1",
    );
    expect(conflictPostingGateway.statuses).toEqual([
      expect.objectContaining({
        context: "ReviewRouter conflict review",
        headSha: "a".repeat(40),
        state: "success",
      }),
    ]);
  });

  it("returns a stable safe error for unsupported conflict runtime provider configs", async () => {
    const repositories = new InMemoryActionRepositories();
    const claudeProvider = {
      kind: "claude",
      authMode: "claude_code_oauth",
      model: "sonnet",
      reasoningEffort: "medium",
      agenticContext: true,
      fastMode: false,
      requiredHealthy: true,
    } as const;
    repositories.runtimeConfig = {
      schemaVersion: 2,
      provider: claudeProvider,
      providers: [claudeProvider],
      execution: {
        providerLimit: 1,
        providerMaxParallel: 1,
        inlineMinAgreement: 1,
      },
      blockingPolicy: { failOnSeverity: "critical" },
      limits: { inlineMaxComments: 5, targetTokensPerBatch: 50000 },
    };
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories,
        conflictReviews: new InMemoryConflictReviewExchangeVerifier(),
        oidcVerifier: new StaticActionOidcVerifier({
          event_name: "repository_dispatch",
          workflow_ref:
            "777genius/example/.github/workflows/reviewrouter.yml@refs/heads/main",
          job_workflow_ref:
            "777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@refs/tags/v1",
        }),
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
      payload: {
        oidcToken: "opaque-github-oidc-token",
        conflictDispatch: {
          protocol_version: 1,
          dispatch_event_type: "reviewrouter_conflict_review",
          dispatch_id: "cr_123e4567-e89b-12d3-a456-426614174000",
          nonce: "n".repeat(40),
          repository_id: "123456",
          pr_number: 7,
          head_sha: "a".repeat(40),
          base_ref: "main",
          base_sha: "b".repeat(40),
          fallback_version: 1,
        },
      },
    });
    expect(exchange.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: "/api/action/v1/config",
      headers: {
        authorization: `Bearer ${exchange.json<{ sessionToken: string }>().sessionToken}`,
        "x-reviewrouter-action-version": "v1",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "conflict_runtime_provider_unsupported",
        message:
          "Conflict review runtime currently supports Codex-backed providers only.",
        retryable: false,
      },
    });
    expect(response.body).not.toContain("sonnet");
    expect(response.body).not.toContain("claude_code_oauth");
  });

  it("returns a stable safe error for unsupported conflict runtime refs", async () => {
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories: new InMemoryActionRepositories(),
        conflictReviews: new InMemoryConflictReviewExchangeVerifier(),
        oidcVerifier: new StaticActionOidcVerifier({
          event_name: "repository_dispatch",
          workflow_ref:
            "777genius/example/.github/workflows/reviewrouter.yml@refs/heads/main",
          job_workflow_ref:
            "777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@refs/tags/v1",
        }),
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
      payload: {
        oidcToken: "opaque-github-oidc-token",
        conflictDispatch: {
          protocol_version: 1,
          dispatch_event_type: "reviewrouter_conflict_review",
          dispatch_id: "cr_123e4567-e89b-12d3-a456-426614174000",
          nonce: "n".repeat(40),
          repository_id: "123456",
          pr_number: 7,
          head_sha: "a".repeat(40),
          base_ref: "main",
          base_sha: "b".repeat(40),
          fallback_version: 1,
        },
      },
    });
    expect(exchange.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: "/api/action/v1/config",
      headers: {
        authorization: `Bearer ${exchange.json<{ sessionToken: string }>().sessionToken}`,
        "x-reviewrouter-action-version": "main",
      },
    });

    expect(response.statusCode).toBe(426);
    expect(response.json()).toEqual({
      error: {
        code: "conflict_runtime_version_unsupported",
        message: "Conflict review runtime ref is not supported for this run.",
        retryable: false,
      },
    });
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

  it("returns a retryable error when managed workflow source verification is temporarily unavailable", async () => {
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories: new InMemoryActionRepositories(),
        oidcVerifier: new StaticActionOidcVerifier(),
        sessions: new JoseActionSessionTokenService(
          "0123456789abcdef0123456789abcdef",
        ),
        legacyMutationAdmission: {
          assertLegacyReviewMutationAllowed: async () => {
            throw new Error("managed_workflow_source_temporarily_unavailable");
          },
        },
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v1/session/exchange",
      payload: { oidcToken: "opaque-github-oidc-token" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: "workflow_source_temporarily_unavailable",
        message:
          "Managed workflow verification is temporarily unavailable. Retry with a fresh OIDC token.",
        retryable: true,
      },
    });
  });

  it("keeps legacy action endpoints available for current action compatibility", async () => {
    const repositories = new InMemoryActionRepositories();
    repositories.runtimeConfig = openRouterRuntimeReviewConfiguration();
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

  it("registers the v2 426 bridge without consuming v1 OIDC replay state", async () => {
    const verifier = new StaticActionOidcVerifier({ jti: "a0-bridge-jti" });
    const replayNonces = new InMemoryActionReplayNonces();
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories: new InMemoryActionRepositories(),
        replayNonces,
        oidcVerifier: verifier,
        sessions: new JoseActionSessionTokenService(
          "0123456789abcdef0123456789abcdef",
        ),
        clock: fixedClock,
        oidcAudience: defaultActionOidcAudience,
      },
      reviewRunControlV2Dependencies: {
        readServerTime: async () => fixedClock.now(),
        createRequestId: () => "generated_request_id",
      },
    });
    const oidcToken = "same-opaque-token-for-v2-then-v1";
    const v2Payload = {
      protocolVersion: "2",
      schemaDigest: "a".repeat(64),
      requestId: "a0_api_bridge_request",
      oidcToken,
      supportedProtocols: [
        { protocolVersion: "2", schemaDigest: "a".repeat(64) },
      ],
    };

    const firstBridge = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-runs/authorize",
      payload: v2Payload,
    });
    const secondBridge = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-runs/authorize",
      payload: v2Payload,
    });

    expect(firstBridge.statusCode).toBe(426);
    expect(secondBridge.statusCode).toBe(426);
    expect(firstBridge.json()).toMatchObject({
      requestId: v2Payload.requestId,
      serverTime: fixedClock.now().toISOString(),
      error: {
        errorCode: "unsupported_protocol",
        retryClass: "never",
        details: { fallbackProtocolVersion: "1" },
      },
    });
    expect(verifier.calls).toBe(0);
    expect(replayNonces.calls).toBe(0);

    const v1Exchange = await app.inject({
      method: "POST",
      url: "/api/action/v1/session/exchange",
      payload: { oidcToken },
    });
    expect(v1Exchange.statusCode).toBe(200);
    expect(verifier.calls).toBe(1);
    expect(replayNonces.calls).toBe(1);
  });

  it("composes the remaining v2 context registrars disabled by default", async () => {
    const runtime = {
      readServerTime: async () => fixedClock.now(),
      createRequestId: () => "generated_request_id",
    };
    const app = await createApiApp({
      reviewRunControlV2Dependencies: runtime,
      reviewExecutionV2Dependencies: runtime,
      reviewEvidenceV2Dependencies: runtime,
      reviewSnapshotReadV2Dependencies: runtime,
      reviewPublicationRequestV2Dependencies: runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-executions/restore",
      payload: reviewActionV2GoldenFixtures.review_execution_restore.request,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        errorCode: "capability_disabled",
        retryClass: "never",
      },
    });
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
    const repositories = new InMemoryActionRepositories();
    repositories.runtimeConfig = openRouterRuntimeReviewConfiguration();
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories,
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

  it("registers GitLab integration routes through the API composition root", async () => {
    const headSha = "a".repeat(40);
    const gitLabIntegrationDependencies: RegisterGitLabIntegrationRoutesDependencies =
      {
        exchange: {
          verifier: {
            async verify() {
              return {
                iss: "https://gitlab.com",
                sub: "project_path:group/project:ref_type:branch:ref:feature",
                aud: "reviewrouter",
                namespace_id: "12",
                namespace_path: "group",
                project_id: "123",
                project_path: "group/project",
                job_project_id: "123",
                job_project_path: "group/project",
                user_id: "7",
                user_login: "ilya",
                pipeline_id: "1001",
                pipeline_source: "merge_request_event",
                job_id: "2002",
                ref: "feature",
                ref_type: "branch",
                sha: headSha,
              };
            },
          },
          repositories: {
            async findSelectedRepositoryByGitLabProjectId() {
              return {
                workspaceId: "workspace_1",
                repositoryId: "repo_1",
                gitlabProjectId: "123",
                fullName: "group/project",
                owner: "group",
                selected: true,
                installationStatus: "active",
              };
            },
          },
          mergeRequests: {
            async getMergeRequest() {
              return {
                projectId: "123",
                mergeRequestIid: "5",
                headSha,
                sourceProjectId: "123",
                targetProjectId: "123",
                state: "opened",
              };
            },
          },
          sessions: {
            async sign(input) {
              return {
                token: `gitlab-session:${input.claims.repositoryFullName}`,
                expiresAt: new Date(
                  input.issuedAt.getTime() + input.expiresInSeconds * 1000,
                ),
              };
            },
            async verify() {
              throw new Error("not_needed");
            },
          },
        },
        clock: fixedClock,
      };
    const app = await createApiApp({ gitLabIntegrationDependencies });

    const response = await app.inject({
      method: "POST",
      url: "/api/gitlab/action/v1/session/exchange",
      payload: {
        idToken: "gitlab-id-token",
        mergeRequestIid: "5",
        headSha,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      protocolVersion: 1,
      sessionToken: "gitlab-session:group/project",
      repository: "group/project",
    });
  });

  it("registers the GitLab control CI config route with only an installer admin token", async () => {
    const envKeys = [
      "REVIEW_ROUTER_GITLAB_INSTALLER_ADMIN_TOKEN",
      "REVIEW_ROUTER_GITLAB_INSTALLER_TOKEN",
      "REVIEW_ROUTER_GITLAB_API_TOKEN",
      "REVIEW_ROUTER_GITLAB_STATIC_REPOSITORIES_JSON",
      "REVIEW_ROUTER_GITLAB_RUNTIME_IMAGE",
    ] as const;
    const previousEnv = Object.fromEntries(
      envKeys.map((key) => [key, process.env[key]]),
    );
    process.env.REVIEW_ROUTER_GITLAB_INSTALLER_ADMIN_TOKEN =
      "gitlab-installer-admin";
    delete process.env.REVIEW_ROUTER_GITLAB_INSTALLER_TOKEN;
    delete process.env.REVIEW_ROUTER_GITLAB_API_TOKEN;
    delete process.env.REVIEW_ROUTER_GITLAB_STATIC_REPOSITORIES_JSON;
    process.env.REVIEW_ROUTER_GITLAB_RUNTIME_IMAGE =
      "registry.test/reviewrouter/gitlab-runtime:v1";

    try {
      const app = await createApiApp({});
      const response = await app.inject({
        method: "GET",
        url: "/api/gitlab/install/v1/control-ci-config",
        headers: {
          authorization: "Bearer gitlab-installer-admin",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        protocolVersion: 1,
        path: ".gitlab/reviewrouter.yml",
      });
      expect(response.json().content).toContain(
        "registry.test/reviewrouter/gitlab-runtime:v1",
      );

      const statusResponse = await app.inject({
        method: "GET",
        url: "/api/gitlab/install/v1/status",
        headers: {
          authorization: "Bearer gitlab-installer-admin",
        },
      });

      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.json()).toMatchObject({
        protocolVersion: 1,
        installation: {
          available: false,
          missingEnv: ["REVIEW_ROUTER_GITLAB_INSTALLER_TOKEN"],
        },
        exchange: {
          available: false,
          missingEnv: [
            "REVIEW_ROUTER_ACTION_SESSION_SECRET",
            "REVIEW_ROUTER_GITLAB_API_TOKEN",
            "REVIEW_ROUTER_GITLAB_STATIC_REPOSITORIES_JSON",
          ],
          registeredRepositoryCount: 0,
        },
        defaults: {
          audience: "reviewrouter",
          runtimeImage: "registry.test/reviewrouter/gitlab-runtime:v1",
          runtimeImageConfigured: true,
        },
      });
    } finally {
      for (const key of envKeys) {
        const previous = previousEnv[key];
        if (previous === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous;
        }
      }
    }
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
