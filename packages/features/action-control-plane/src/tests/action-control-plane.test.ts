import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  parseReviewConfiguration,
  safeDefaultReviewConfiguration,
  type ReviewConfiguration,
} from "@reviewrouter/features-review-config";
import type { Clock } from "@reviewrouter/shared";
import type {
  ActionOidcReplayNonceCleanupPort,
  ActionOidcReplayNonceStorePort,
  ConsumeActionOidcReplayNonceInput,
  DeleteExpiredActionOidcReplayNoncesInput,
  DeleteExpiredActionOidcReplayNoncesResult,
} from "../application/ports/action-oidc-replay-nonce-store-port.js";
import type { ActionControlPlaneRepositoryPort } from "../application/ports/action-control-plane-repository-port.js";
import type { ActionEntitlementPolicyPort } from "../application/ports/action-entitlement-policy-port.js";
import type {
  ActionLedgerKeyInput,
  ActionLedgerKeyPort,
} from "../application/ports/action-ledger-key-port.js";
import type {
  ActionConflictReviewDispatchPayload,
  ActionConflictReviewExchangeVerifierPort,
} from "../application/ports/action-conflict-review-exchange-verifier-port.js";
import type { ActionConflictReviewPrePostValidatorPort } from "../application/ports/action-conflict-review-pre-post-validator-port.js";
import type { ActionConflictReviewPostingSessionRepositoryPort } from "../application/ports/action-conflict-review-posting-session-repository-port.js";
import type { ActionConflictReviewPostingGatewayPort } from "../application/ports/action-conflict-review-posting-gateway-port.js";
import type { ActionConflictReviewRuntimeGatePort } from "../application/ports/action-conflict-review-runtime-gate-port.js";
import type { ActionRateLimitPolicyPort } from "../application/ports/action-rate-limit-policy-port.js";
import type { ActionSessionTokenServicePort } from "../application/ports/action-session-token-service-port.js";
import { LegacyReviewMutationOperation } from "../application/ports/legacy-review-mutation-admission-port.js";
import type {
  GitHubAppCommentTokenIssuerPort,
  IssueGitHubAppCommentTokenInput,
} from "../application/ports/github-app-comment-token-issuer-port.js";
import type {
  GitHubReviewThreadLifecycleResolverPort,
  ResolveGitHubReviewThreadLifecycleInput,
} from "../application/ports/github-review-thread-lifecycle-resolver-port.js";
import type { GitHubActionsOidcTokenVerifierPort } from "../application/ports/github-actions-oidc-token-verifier-port.js";
import { exchangeGitHubOidcToken } from "../application/use-cases/exchange-github-oidc-token.js";
import { getActionRuntimeConfig } from "../application/use-cases/get-action-runtime-config.js";
import { issueActionCommentToken } from "../application/use-cases/issue-action-comment-token.js";
import { postConflictReviewStatus } from "../application/use-cases/post-conflict-review-status.js";
import { postConflictReviewSummary } from "../application/use-cases/post-conflict-review-summary.js";
import { pruneExpiredActionOidcReplayNonces } from "../application/use-cases/prune-expired-action-oidc-replay-nonces.js";
import { resolveActionReviewThreadLifecycle } from "../application/use-cases/resolve-action-review-thread-lifecycle.js";
import { recordActionHealthReport } from "../application/use-cases/record-action-health-report.js";
import { requestConflictReviewPostingSession } from "../application/use-cases/request-conflict-review-posting-session.js";
import {
  actionHealthReportMaxBytes,
  assertSafeActionHealthReport,
  defaultActionOidcAudience,
  githubActionsOidcIssuer,
  githubActionsOidcClaimsSchema,
  parseActionConflictReviewDispatchPayload,
  type ActionConflictReviewPostingSessionClaims,
  type ActionHealthReport,
  type ActionRepositoryContext,
  type ActionReviewThreadLifecycleResolveResponse,
  type ActionSessionClaims,
  type GitHubActionsOidcClaims,
} from "../domain/action-control-plane.js";
import { JoseGitHubActionsOidcTokenVerifier } from "../infrastructure/oidc/jose-github-actions-oidc-token-verifier.js";
import { StaticActionRuntimeCompatibilityPolicy } from "../infrastructure/config/static-action-runtime-compatibility-policy.js";
import { JoseActionConflictReviewPostingSessionTokenService } from "../infrastructure/session/jose-action-conflict-review-posting-session-token-service.js";
import { JoseActionSessionTokenService } from "../infrastructure/session/jose-action-session-token-service.js";

const fixedNow = new Date("2026-05-03T12:00:00.000Z");
const clock: Clock = { now: () => fixedNow };

const repositoryContext: ActionRepositoryContext = {
  workspaceId: "workspace_1",
  repositoryId: "repo_1",
  githubRepositoryId: "123456",
  githubInstallationId: "129500385",
  fullName: "777genius/example",
  owner: "777genius",
  selected: true,
  installationStatus: "active",
};

const sessionClaims: ActionSessionClaims = {
  workspaceId: "workspace_1",
  repositoryId: "repo_1",
  githubRepositoryId: "123456",
  repository: "777genius/example",
  githubActorLogin: "777genius",
  githubRunId: "1001",
  githubRunAttempt: "1",
  eventName: "pull_request",
  protocolVersion: 1,
};

const defaultOpenRouterRuntimeConfig = parseReviewConfiguration({
  ...safeDefaultReviewConfiguration,
  provider: {
    kind: "openrouter",
    authMode: "openrouter_api_key",
    model: "poolside/laguna-m.1:free",
    reasoningEffort: "medium",
    agenticContext: true,
    fastMode: false,
    requiredHealthy: true,
  },
  providers: [
    {
      kind: "openrouter",
      authMode: "openrouter_api_key",
      model: "poolside/laguna-m.1:free",
      reasoningEffort: "medium",
      agenticContext: true,
      fastMode: false,
      requiredHealthy: true,
    },
  ],
});

class InMemoryActionControlPlaneRepository implements ActionControlPlaneRepositoryPort {
  public healthReports: ActionHealthReport[] = [];
  public repository: ActionRepositoryContext | null = repositoryContext;
  public runtimeConfig: ReviewConfiguration | null =
    defaultOpenRouterRuntimeConfig;
  public runtimeConfigVersion = 7;
  public runtimeConfigSource: "repository" | "workspace" = "repository";

  async findSelectedRepositoryByGithubId(
    githubRepositoryId: string,
  ): Promise<ActionRepositoryContext | null> {
    if (githubRepositoryId !== this.repository?.githubRepositoryId) {
      return null;
    }
    return this.repository;
  }

  async findRuntimeReviewConfiguration() {
    if (!this.runtimeConfig) {
      return null;
    }
    return {
      source: this.runtimeConfigSource,
      version: this.runtimeConfigVersion,
      config: this.runtimeConfig,
    };
  }

  async recordHealthReport(input: {
    readonly report: ActionHealthReport;
  }): Promise<void> {
    this.healthReports.push(input.report);
  }
}

class StaticOidcVerifier implements GitHubActionsOidcTokenVerifierPort {
  constructor(private readonly claims: GitHubActionsOidcClaims) {}

  async verify(): Promise<GitHubActionsOidcClaims> {
    return this.claims;
  }
}

class StaticSessionTokenService implements ActionSessionTokenServicePort {
  public signedClaims: ActionSessionClaims | null = null;

  constructor(
    private readonly verifiedClaims: ActionSessionClaims = sessionClaims,
  ) {}

  async sign(input: {
    readonly claims: ActionSessionClaims;
    readonly expiresInSeconds: number;
    readonly issuedAt: Date;
  }) {
    this.signedClaims = input.claims;
    return {
      token: "signed-session-token",
      expiresAt: new Date(
        input.issuedAt.getTime() + input.expiresInSeconds * 1000,
      ),
    };
  }

  async verify(): Promise<ActionSessionClaims> {
    return this.verifiedClaims;
  }
}

class InMemoryConflictReviewExchangeVerifier implements ActionConflictReviewExchangeVerifierPort {
  public calls: Array<{
    readonly dispatchPayload: ActionConflictReviewDispatchPayload;
    readonly claims: GitHubActionsOidcClaims;
    readonly configSnapshotId: string;
  }> = [];

  async verifyConflictReviewExchange(input: {
    readonly claims: GitHubActionsOidcClaims;
    readonly dispatchPayload: ActionConflictReviewDispatchPayload;
    readonly configSnapshotId: string;
  }) {
    this.calls.push({
      claims: input.claims,
      dispatchPayload: input.dispatchPayload,
      configSnapshotId: input.configSnapshotId,
    });
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

class ConfigurableConflictReviewRuntimeGate implements ActionConflictReviewRuntimeGatePort {
  public enabled = true;
  public readonly calls: Array<{
    readonly phase: "session_exchange" | "runtime_config" | "posting_session";
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly repositoryFullName: string;
  }> = [];

  async assertConflictReviewRuntimeEnabled(input: {
    readonly phase: "session_exchange" | "runtime_config" | "posting_session";
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly repositoryFullName: string;
  }): Promise<void> {
    this.calls.push(input);
    if (!this.enabled) {
      throw new Error("conflict_review_runtime_disabled");
    }
  }
}

class InMemoryConflictPostingSessionRepository implements ActionConflictReviewPostingSessionRepositoryPort {
  public readonly calls: Array<{
    readonly manifestHash: string;
    readonly session: ActionSessionClaims;
  }> = [];
  public readonly intents = new Map<
    string,
    {
      readonly intentId: string;
      readonly operationKind: "summary_comment" | "advisory_status";
      readonly bodyHash: string;
      status: "pending" | "completed" | "ambiguous";
      githubExternalId?: string | undefined;
      githubUrl?: string | undefined;
      safeErrorSummary?: string | undefined;
    }
  >();

  async issueConflictReviewPostingSession(input: {
    readonly session: ActionSessionClaims;
    readonly manifestHash: string;
    readonly issuedAt: Date;
  }): Promise<ActionConflictReviewPostingSessionClaims> {
    this.calls.push({
      manifestHash: input.manifestHash,
      session: input.session,
    });
    if (
      input.session.reviewKind !== "conflict-head" ||
      !input.session.conflictDispatchId ||
      !input.session.pullRequestNumber ||
      !input.session.headSha ||
      !input.session.baseRef ||
      !input.session.baseSha ||
      !input.session.configSnapshotId
    ) {
      throw new Error("conflict_review_session_required");
    }
    return {
      purpose: "conflict-review-posting",
      attemptId: "attempt_1",
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
  }

  async reserveConflictReviewPostingIntent(input: {
    readonly scope: ActionConflictReviewPostingSessionClaims;
    readonly operationKind: "summary_comment" | "advisory_status";
    readonly operationFingerprint: string;
    readonly bodyHash: string;
    readonly requestedAt: Date;
  }) {
    const existing = this.intents.get(input.operationFingerprint);
    if (existing?.status === "completed" && existing.githubExternalId) {
      return {
        status: "completed" as const,
        intentId: existing.intentId,
        githubExternalId: existing.githubExternalId,
        githubUrl: existing.githubUrl ?? null,
      };
    }
    if (existing?.status === "ambiguous") {
      existing.status = "pending";
      return { status: "reserved" as const, intentId: existing.intentId };
    }
    if (existing) {
      return { status: "pending" as const, intentId: existing.intentId };
    }
    const intentId = `intent_${this.intents.size + 1}`;
    this.intents.set(input.operationFingerprint, {
      intentId,
      operationKind: input.operationKind,
      bodyHash: input.bodyHash,
      status: "pending",
    });
    return { status: "reserved" as const, intentId };
  }

  async commitConflictReviewPostingIntent(input: {
    readonly scope: ActionConflictReviewPostingSessionClaims;
    readonly intentId: string;
    readonly operationKind: "summary_comment" | "advisory_status";
    readonly githubExternalId: string;
    readonly githubUrl?: string | undefined;
    readonly bodyHash: string;
    readonly completedAt: Date;
  }): Promise<void> {
    const existing = [...this.intents.values()].find(
      (intent) => intent.intentId === input.intentId,
    );
    if (!existing || existing.operationKind !== input.operationKind) {
      throw new Error("conflict_review_posting_intent_commit_race");
    }
    existing.status = "completed";
    existing.githubExternalId = input.githubExternalId;
    existing.githubUrl = input.githubUrl;
  }

  async markConflictReviewPostingIntentAmbiguous(input: {
    readonly scope: ActionConflictReviewPostingSessionClaims;
    readonly intentId: string;
    readonly operationKind: "summary_comment" | "advisory_status";
    readonly safeErrorCode: string;
    readonly safeErrorSummary: string;
    readonly failedAt: Date;
  }): Promise<void> {
    const existing = [...this.intents.values()].find(
      (intent) => intent.intentId === input.intentId,
    );
    if (existing) {
      existing.status = "ambiguous";
      existing.safeErrorSummary = input.safeErrorSummary;
    }
  }
}

class InMemoryConflictPostingGateway implements ActionConflictReviewPostingGatewayPort {
  public readonly summaries: Array<{
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly marker: string;
    readonly body: string;
  }> = [];
  public readonly statuses: Array<{
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly context: string;
    readonly state: "success" | "failure" | "error";
    readonly description: string;
  }> = [];

  async upsertConflictReviewSummary(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
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
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly context: string;
    readonly state: "success" | "failure" | "error";
    readonly description: string;
  }) {
    this.statuses.push(input);
    return {
      githubExternalId: "status_1",
      githubUrl: "https://github.com/777genius/example/statuses/1",
    };
  }
}

class ConfigurableConflictPrePostValidator implements ActionConflictReviewPrePostValidatorPort {
  public error: Error | null = null;
  public readonly calls: Array<{
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
  }> = [];

  async assertConflictReviewPrePostState(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
  }): Promise<void> {
    this.calls.push(input);
    if (this.error) {
      throw this.error;
    }
  }
}

class RejectingConflictPostingGateway extends InMemoryConflictPostingGateway {
  async upsertConflictReviewSummary(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly marker: string;
    readonly body: string;
  }): Promise<{
    readonly githubExternalId: string;
    readonly githubUrl: string;
  }> {
    void input;
    throw new Error(
      "network_timeout_after_summary_write token:ghs_secret nonce:raw-dispatch-nonce",
    );
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

class InMemoryReviewThreadLifecycleResolver implements GitHubReviewThreadLifecycleResolverPort {
  public readonly calls: ResolveGitHubReviewThreadLifecycleInput[] = [];
  public response: ActionReviewThreadLifecycleResolveResponse = {
    protocolVersion: 1,
    status: "resolved",
    resolvedBy: "github_user",
    reasonCodes: [],
  };

  async resolveReviewThreadLifecycle(
    input: ResolveGitHubReviewThreadLifecycleInput,
  ): Promise<ActionReviewThreadLifecycleResolveResponse> {
    this.calls.push(input);
    return this.response;
  }
}

class DenyingActionEntitlements implements ActionEntitlementPolicyPort {
  public readonly calls: Array<{
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly repositoryFullName?: string;
  }> = [];

  async assertActionControlPlaneAllowed(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly repositoryFullName?: string;
  }): Promise<void> {
    this.calls.push(input);
    throw new Error(
      "entitlement_denied:action_control_plane:feature_not_enabled_for_plan",
    );
  }
}

class StaticActionLedgerKeys implements ActionLedgerKeyPort {
  public readonly calls: ActionLedgerKeyInput[] = [];

  deriveLedgerKey(input: ActionLedgerKeyInput): string {
    this.calls.push(input);
    return "ledger-key";
  }
}

class DenyingActionRateLimits implements ActionRateLimitPolicyPort {
  public readonly oidcExchangeCalls: Array<{
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly repositoryFullName: string;
    readonly eventName: string;
    readonly githubActorLogin: string | null;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
  }> = [];
  public readonly healthReportCalls: Array<{
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly repositoryFullName: string;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
  }> = [];

  async assertOidcExchangeAllowed(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly repositoryFullName: string;
    readonly eventName: string;
    readonly githubActorLogin: string | null;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
  }): Promise<void> {
    this.oidcExchangeCalls.push(input);
    throw new Error("rate_limit_exceeded:action:oidc_exchange:repo_1");
  }

  async assertHealthReportAllowed(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly repositoryFullName: string;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
  }): Promise<void> {
    this.healthReportCalls.push(input);
    throw new Error("rate_limit_exceeded:action:health_report:repo_1");
  }
}

class InMemoryActionOidcReplayNonceStore
  implements ActionOidcReplayNonceStorePort, ActionOidcReplayNonceCleanupPort
{
  public readonly consumed = new Map<string, Date>();

  async tryConsumeNonce(
    input: ConsumeActionOidcReplayNonceInput,
  ): Promise<boolean> {
    if (this.consumed.has(input.key)) {
      return false;
    }
    this.consumed.set(input.key, input.expiresAt);
    return true;
  }

  async deleteExpiredNonces(
    input: DeleteExpiredActionOidcReplayNoncesInput,
  ): Promise<DeleteExpiredActionOidcReplayNoncesResult> {
    const expiredKeys = [...this.consumed.entries()]
      .filter(([, expiresAt]) => expiresAt <= input.expiredBefore)
      .slice(0, input.limit)
      .map(([key]) => key);
    for (const key of expiredKeys) {
      this.consumed.delete(key);
    }
    return { deleted: expiredKeys.length };
  }
}

describe("action control plane", () => {
  it("preserves GitHub repository visibility claims for stricter Codex OAuth validation", () => {
    const claims = githubActionsOidcClaimsSchema.parse({
      ...githubOidcClaims(),
      repository_visibility: "private",
    });

    expect(claims.repository_visibility).toBe("private");
  });

  it("exchanges valid GitHub OIDC claims for a scoped action session", async () => {
    const repository = new InMemoryActionControlPlaneRepository();
    const sessions = new StaticSessionTokenService();
    const result = await exchangeGitHubOidcToken(
      { oidcToken: "oidc", audience: defaultActionOidcAudience },
      {
        oidcVerifier: new StaticOidcVerifier(githubOidcClaims()),
        repositories: repository,
        sessions,
        clock,
      },
    );

    expect(result).toMatchObject({
      protocolVersion: 1,
      sessionToken: "signed-session-token",
      repository: "777genius/example",
    });
    expect(sessions.signedClaims).toMatchObject({
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
      githubActorLogin: "777genius",
      githubRunId: "1001",
      protocolVersion: 1,
    });
  });

  it("consumes the OIDC nonce before external legacy admission and never signs a blocked session", async () => {
    const sessions = new StaticSessionTokenService();
    const replayNonces = new InMemoryActionOidcReplayNonceStore();

    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({ jti: "blocked-session-jti" }),
          ),
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions,
          replayNonces,
          legacyMutationAdmission: {
            assertLegacyReviewMutationAllowed: async (input) => {
              expect(input).toMatchObject({
                operation: LegacyReviewMutationOperation.SessionExchange,
                githubInstallationId: "129500385",
                repositoryOwner: "777genius",
                eventName: "pull_request",
                workflowPath: ".github/workflows/reviewrouter.yml",
                workflowSha: null,
              });
              throw new Error("legacy_review_mutation_blocked:v1_draining");
            },
          },
          clock,
        },
      ),
    ).rejects.toThrow("legacy_review_mutation_blocked:v1_draining");
    expect(sessions.signedClaims).toBeNull();
    expect(replayNonces.consumed.size).toBe(1);
  });

  it("rejects a replay before invoking external workflow-source admission", async () => {
    const replayNonces = new InMemoryActionOidcReplayNonceStore();
    let admissionCalls = 0;
    const dependencies = {
      oidcVerifier: new StaticOidcVerifier(
        githubOidcClaims({ jti: "replayed-session-jti" }),
      ),
      repositories: new InMemoryActionControlPlaneRepository(),
      sessions: new StaticSessionTokenService(),
      replayNonces,
      legacyMutationAdmission: {
        assertLegacyReviewMutationAllowed: async () => {
          admissionCalls += 1;
        },
      },
      clock,
    };

    await exchangeGitHubOidcToken(
      { oidcToken: "oidc", audience: defaultActionOidcAudience },
      dependencies,
    );
    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        dependencies,
      ),
    ).rejects.toThrow("oidc_replay_detected");
    expect(admissionCalls).toBe(1);
  });

  it("accepts explicit workflow claims when GitHub echoes workflow_ref in job_workflow_ref", async () => {
    const sessions = new StaticSessionTokenService();
    await exchangeGitHubOidcToken(
      { oidcToken: "oidc", audience: defaultActionOidcAudience },
      {
        oidcVerifier: new StaticOidcVerifier(
          githubOidcClaims({
            workflow_ref:
              "777genius/example/.github/workflows/reviewrouter.yml@refs/pull/1/merge",
            job_workflow_ref:
              "777genius/example/.github/workflows/reviewrouter.yml@refs/pull/1/merge",
          }),
        ),
        repositories: new InMemoryActionControlPlaneRepository(),
        sessions,
        clock,
      },
    );

    expect(sessions.signedClaims).toMatchObject({
      repository: "777genius/example",
      workflowPath: ".github/workflows/reviewrouter.yml",
    });
  });

  it("accepts Codex rotating workflow OIDC claims", async () => {
    const sessions = new StaticSessionTokenService();
    await exchangeGitHubOidcToken(
      { oidcToken: "oidc", audience: defaultActionOidcAudience },
      {
        oidcVerifier: new StaticOidcVerifier(
          githubOidcClaims({
            workflow_ref:
              "777genius/example/.github/workflows/reviewrouter-codex.yml@refs/pull/1/merge",
          }),
        ),
        repositories: new InMemoryActionControlPlaneRepository(),
        sessions,
        clock,
      },
    );

    expect(sessions.signedClaims).toMatchObject({
      repository: "777genius/example",
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
    });
  });

  it("rejects the legacy review-router.yml workflow path", async () => {
    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({
              workflow_ref:
                "777genius/example/.github/workflows/review-router.yml@refs/pull/1/merge",
            }),
          ),
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService(),
          clock,
        },
      ),
    ).rejects.toThrow("workflow_ref_not_allowed");
  });

  it("accepts review comment OIDC claims for interaction commands", async () => {
    const sessions = new StaticSessionTokenService();
    await exchangeGitHubOidcToken(
      { oidcToken: "oidc", audience: defaultActionOidcAudience },
      {
        oidcVerifier: new StaticOidcVerifier(
          githubOidcClaims({
            event_name: "pull_request_review_comment",
            workflow_ref:
              "777genius/example/.github/workflows/reviewrouter-interaction.yml@refs/heads/main",
          }),
        ),
        repositories: new InMemoryActionControlPlaneRepository(),
        sessions,
        clock,
      },
    );

    expect(sessions.signedClaims).toMatchObject({
      eventName: "pull_request_review_comment",
      repository: "777genius/example",
    });
  });

  it("accepts PR conversation comment OIDC claims for interaction commands", async () => {
    const sessions = new StaticSessionTokenService();
    await exchangeGitHubOidcToken(
      { oidcToken: "oidc", audience: defaultActionOidcAudience },
      {
        oidcVerifier: new StaticOidcVerifier(
          githubOidcClaims({
            event_name: "issue_comment",
            workflow_ref:
              "777genius/example/.github/workflows/reviewrouter-interaction.yml@refs/heads/main",
          }),
        ),
        repositories: new InMemoryActionControlPlaneRepository(),
        sessions,
        clock,
      },
    );

    expect(sessions.signedClaims).toMatchObject({
      eventName: "issue_comment",
      repository: "777genius/example",
    });
  });

  it("accepts trusted organization required workflow refs for selected repositories", async () => {
    const repository = new InMemoryActionControlPlaneRepository();
    repository.repository = {
      ...repositoryContext,
      trustedWorkflowRefs: [
        "agent-teams-ai/reviewrouter-workflows/.github/workflows/reviewrouter-required.yml@refs/heads/main",
      ],
    };
    const sessions = new StaticSessionTokenService();

    await exchangeGitHubOidcToken(
      { oidcToken: "oidc", audience: defaultActionOidcAudience },
      {
        oidcVerifier: new StaticOidcVerifier(
          githubOidcClaims({
            event_name: "merge_group",
            workflow_ref:
              "agent-teams-ai/reviewrouter-workflows/.github/workflows/reviewrouter-required.yml@refs/heads/main",
          }),
        ),
        repositories: repository,
        sessions,
        clock,
      },
    );

    expect(sessions.signedClaims).toMatchObject({
      eventName: "merge_group",
      repository: "777genius/example",
    });
  });

  it("accepts trusted reusable workflow refs through job_workflow_ref", async () => {
    const repository = new InMemoryActionControlPlaneRepository();
    repository.repository = {
      ...repositoryContext,
      trustedWorkflowRefs: [
        "777genius/review-router/.github/workflows/reviewrouter-reusable.yml@refs/tags/v1",
      ],
    };
    const sessions = new StaticSessionTokenService();

    await exchangeGitHubOidcToken(
      { oidcToken: "oidc", audience: defaultActionOidcAudience },
      {
        oidcVerifier: new StaticOidcVerifier(
          githubOidcClaims({
            workflow_ref:
              "777genius/example/.github/workflows/reviewrouter.yml@refs/pull/1/merge",
            job_workflow_ref:
              "777genius/review-router/.github/workflows/reviewrouter-reusable.yml@refs/tags/v1",
          }),
        ),
        repositories: repository,
        sessions,
        clock,
      },
    );

    expect(sessions.signedClaims).toMatchObject({
      repository: "777genius/example",
    });
  });

  it("accepts official ReviewRouter reusable workflow refs without provisioning state", async () => {
    const sessions = new StaticSessionTokenService();

    await exchangeGitHubOidcToken(
      { oidcToken: "oidc", audience: defaultActionOidcAudience },
      {
        oidcVerifier: new StaticOidcVerifier(
          githubOidcClaims({
            workflow_ref:
              "777genius/example/.github/workflows/reviewrouter.yml@refs/pull/1/merge",
            job_workflow_ref:
              "777genius/review-router/.github/workflows/reviewrouter-reusable.yml@refs/tags/v1",
          }),
        ),
        repositories: new InMemoryActionControlPlaneRepository(),
        sessions,
        clock,
      },
    );

    expect(sessions.signedClaims).toMatchObject({
      repository: "777genius/example",
    });
  });

  it("rejects conflict reusable workflow refs outside repository_dispatch", async () => {
    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({
              workflow_ref:
                "777genius/example/.github/workflows/reviewrouter.yml@refs/pull/1/merge",
              job_workflow_ref:
                "777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@refs/tags/v1",
            }),
          ),
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService(),
          clock,
        },
      ),
    ).rejects.toThrow("workflow_ref_not_allowed");
  });

  it("rejects official reusable jobs when the caller workflow path is legacy", async () => {
    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({
              workflow_ref:
                "777genius/example/.github/workflows/review-router.yml@refs/pull/1/merge",
              job_workflow_ref:
                "777genius/review-router/.github/workflows/reviewrouter-reusable.yml@refs/tags/v1",
            }),
          ),
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService(),
          clock,
        },
      ),
    ).rejects.toThrow("workflow_ref_not_allowed");
  });

  it("accepts live main reusable workflow refs through job_workflow_ref", async () => {
    const repository = new InMemoryActionControlPlaneRepository();
    repository.repository = {
      ...repositoryContext,
      trustedWorkflowRefs: [
        "777genius/review-router/.github/workflows/reviewrouter-reusable.yml@refs/heads/main",
      ],
    };
    const sessions = new StaticSessionTokenService();

    await exchangeGitHubOidcToken(
      { oidcToken: "oidc", audience: defaultActionOidcAudience },
      {
        oidcVerifier: new StaticOidcVerifier(
          githubOidcClaims({
            workflow_ref:
              "777genius/example/.github/workflows/reviewrouter.yml@refs/pull/1/merge",
            job_workflow_ref:
              "777genius/review-router/.github/workflows/reviewrouter-reusable.yml@refs/heads/main",
          }),
        ),
        repositories: repository,
        sessions,
        clock,
      },
    );

    expect(sessions.signedClaims).toMatchObject({
      repository: "777genius/example",
    });
  });

  it("accepts trusted central workflow_ref when it calls a trusted reusable job", async () => {
    const repository = new InMemoryActionControlPlaneRepository();
    repository.repository = {
      ...repositoryContext,
      trustedWorkflowRefs: [
        "agent-teams-ai/reviewrouter-workflows/.github/workflows/reviewrouter-required.yml@refs/heads/main",
        "777genius/review-router/.github/workflows/reviewrouter-reusable.yml@refs/tags/v1",
      ],
    };
    const sessions = new StaticSessionTokenService();

    await exchangeGitHubOidcToken(
      { oidcToken: "oidc", audience: defaultActionOidcAudience },
      {
        oidcVerifier: new StaticOidcVerifier(
          githubOidcClaims({
            event_name: "merge_group",
            workflow_ref:
              "agent-teams-ai/reviewrouter-workflows/.github/workflows/reviewrouter-required.yml@refs/heads/main",
            job_workflow_ref:
              "777genius/review-router/.github/workflows/reviewrouter-reusable.yml@refs/tags/v1",
          }),
        ),
        repositories: repository,
        sessions,
        clock,
      },
    );

    expect(sessions.signedClaims).toMatchObject({
      repository: "777genius/example",
    });
  });

  it("rejects similar but untrusted organization required workflow refs", async () => {
    const repository = new InMemoryActionControlPlaneRepository();
    repository.repository = {
      ...repositoryContext,
      trustedWorkflowRefs: [
        "agent-teams-ai/reviewrouter-workflows/.github/workflows/reviewrouter-required.yml@refs/heads/main",
      ],
    };

    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({
              workflow_ref:
                "agent-teams-ai/reviewrouter-workflows/.github/workflows/other.yml@refs/heads/main",
            }),
          ),
          repositories: repository,
          sessions: new StaticSessionTokenService(),
          clock,
        },
      ),
    ).rejects.toThrow("workflow_ref_not_allowed");
  });

  it("rejects trusted job_workflow_ref claims when the caller workflow is from another repository", async () => {
    const repository = new InMemoryActionControlPlaneRepository();
    repository.repository = {
      ...repositoryContext,
      trustedWorkflowRefs: [
        "agent-teams-ai/reviewrouter-workflows/.github/workflows/reviewrouter-required.yml@refs/heads/main",
      ],
    };

    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({
              workflow_ref:
                "attacker/example/.github/workflows/reviewrouter.yml@refs/heads/main",
              job_workflow_ref:
                "agent-teams-ai/reviewrouter-workflows/.github/workflows/reviewrouter-required.yml@refs/heads/main",
            }),
          ),
          repositories: repository,
          sessions: new StaticSessionTokenService(),
          clock,
        },
      ),
    ).rejects.toThrow("workflow_ref_not_allowed");
  });

  it("rejects trusted reusable jobs when the caller path is not a ReviewRouter workflow", async () => {
    const repository = new InMemoryActionControlPlaneRepository();
    repository.repository = {
      ...repositoryContext,
      trustedWorkflowRefs: [
        "777genius/review-router/.github/workflows/reviewrouter-reusable.yml@refs/tags/v1",
      ],
    };

    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({
              workflow_ref:
                "777genius/example/.github/workflows/deploy.yml@refs/heads/main",
              job_workflow_ref:
                "777genius/review-router/.github/workflows/reviewrouter-reusable.yml@refs/tags/v1",
            }),
          ),
          repositories: repository,
          sessions: new StaticSessionTokenService(),
          clock,
        },
      ),
    ).rejects.toThrow("workflow_ref_not_allowed");
  });

  it("rejects untrusted reusable jobs even when the caller path is allowed", async () => {
    const repository = new InMemoryActionControlPlaneRepository();
    repository.repository = {
      ...repositoryContext,
      trustedWorkflowRefs: [
        "777genius/review-router/.github/workflows/reviewrouter-reusable.yml@refs/tags/v1",
      ],
    };

    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({
              workflow_ref:
                "777genius/example/.github/workflows/reviewrouter.yml@refs/heads/main",
              job_workflow_ref:
                "attacker/review-router/.github/workflows/reviewrouter-reusable.yml@refs/tags/v1",
            }),
          ),
          repositories: repository,
          sessions: new StaticSessionTokenService(),
          clock,
        },
      ),
    ).rejects.toThrow("workflow_ref_not_allowed");
  });

  it("allows repository_dispatch only through the trusted conflict reusable workflow and conflict record", async () => {
    const repository = new InMemoryActionControlPlaneRepository();
    const sessions = new StaticSessionTokenService();
    const conflictReviews = new InMemoryConflictReviewExchangeVerifier();
    const conflictReviewRuntimeGate =
      new ConfigurableConflictReviewRuntimeGate();
    const conflictDispatchPayload = conflictDispatch();

    await exchangeGitHubOidcToken(
      {
        oidcToken: "oidc",
        audience: defaultActionOidcAudience,
        conflictDispatchPayload,
      },
      {
        oidcVerifier: new StaticOidcVerifier(
          githubOidcClaims({
            event_name: "repository_dispatch",
            workflow_ref:
              "777genius/example/.github/workflows/reviewrouter.yml@refs/heads/main",
            job_workflow_ref:
              "777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@refs/tags/v1",
          }),
        ),
        repositories: repository,
        sessions,
        conflictReviews,
        conflictReviewRuntimeGate,
        clock,
      },
    );

    expect(conflictReviewRuntimeGate.calls).toEqual([
      {
        phase: "session_exchange",
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        repositoryFullName: "777genius/example",
      },
    ]);
    expect(conflictReviews.calls).toEqual([
      expect.objectContaining({ dispatchPayload: conflictDispatchPayload }),
    ]);
    expect(sessions.signedClaims).toMatchObject({
      eventName: "repository_dispatch",
      reviewKind: "conflict-head",
      conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
      pullRequestNumber: 7,
      headSha: "a".repeat(40),
      baseRef: "main",
      baseSha: "b".repeat(40),
      configSnapshotId: "repository:7",
    });
  });

  it("parses conflict dispatch payloads with one naming style and rejects ambiguous aliases", () => {
    const snakeCasePayload = {
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
    };

    expect(parseActionConflictReviewDispatchPayload(snakeCasePayload)).toEqual(
      conflictDispatch(),
    );
    expect(() =>
      parseActionConflictReviewDispatchPayload({
        ...snakeCasePayload,
        dispatchId: snakeCasePayload.dispatch_id,
      }),
    ).toThrow("conflicting_aliases");
    expect(() =>
      parseActionConflictReviewDispatchPayload({
        ...snakeCasePayload,
        provider_config: { model: "gpt-5.5" },
      }),
    ).toThrow();
    expect(() =>
      parseActionConflictReviewDispatchPayload({
        ...snakeCasePayload,
        dispatch_event_type: "wrong_dispatch_action",
      }),
    ).toThrow();
  });

  it("fails conflict session exchange before attempt verification when the runtime gate is disabled", async () => {
    const repository = new InMemoryActionControlPlaneRepository();
    const conflictReviews = new InMemoryConflictReviewExchangeVerifier();
    const conflictReviewRuntimeGate =
      new ConfigurableConflictReviewRuntimeGate();
    conflictReviewRuntimeGate.enabled = false;

    await expect(
      exchangeGitHubOidcToken(
        {
          oidcToken: "oidc",
          audience: defaultActionOidcAudience,
          conflictDispatchPayload: conflictDispatch(),
        },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({
              event_name: "repository_dispatch",
              workflow_ref:
                "777genius/example/.github/workflows/reviewrouter.yml@refs/heads/main",
              job_workflow_ref:
                "777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@refs/tags/v1",
            }),
          ),
          repositories: repository,
          sessions: new StaticSessionTokenService(),
          conflictReviews,
          conflictReviewRuntimeGate,
          clock,
        },
      ),
    ).rejects.toThrow("conflict_review_runtime_disabled");

    expect(conflictReviewRuntimeGate.calls).toEqual([
      expect.objectContaining({ phase: "session_exchange" }),
    ]);
    expect(conflictReviews.calls).toHaveLength(0);
  });

  it("rejects repository_dispatch without conflict payload", async () => {
    const repository = new InMemoryActionControlPlaneRepository();

    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({
              event_name: "repository_dispatch",
              workflow_ref:
                "777genius/example/.github/workflows/reviewrouter.yml@refs/heads/main",
              job_workflow_ref:
                "777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@refs/tags/v1",
            }),
          ),
          repositories: repository,
          sessions: new StaticSessionTokenService(),
          conflictReviews: new InMemoryConflictReviewExchangeVerifier(),
          clock,
        },
      ),
    ).rejects.toThrow("conflict_review_payload_required");
  });

  it("rejects repository_dispatch from the interaction reusable workflow", async () => {
    const repository = new InMemoryActionControlPlaneRepository();

    await expect(
      exchangeGitHubOidcToken(
        {
          oidcToken: "oidc",
          audience: defaultActionOidcAudience,
          conflictDispatchPayload: conflictDispatch(),
        },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({
              event_name: "repository_dispatch",
              workflow_ref:
                "777genius/example/.github/workflows/reviewrouter-interaction.yml@refs/heads/main",
              job_workflow_ref:
                "777genius/review-router/.github/workflows/reviewrouter-interaction-reusable.yml@refs/tags/v1",
            }),
          ),
          repositories: repository,
          sessions: new StaticSessionTokenService(),
          conflictReviews: new InMemoryConflictReviewExchangeVerifier(),
          clock,
        },
      ),
    ).rejects.toThrow("workflow_ref_not_allowed");
  });

  it("does not let trustedWorkflowRefs widen the conflict review caller workflow", async () => {
    const repository = new InMemoryActionControlPlaneRepository();
    repository.repository = {
      ...repositoryContext,
      trustedWorkflowRefs: [
        "777genius/example/.github/workflows/deploy.yml@refs/heads/main",
      ],
    };

    await expect(
      exchangeGitHubOidcToken(
        {
          oidcToken: "oidc",
          audience: defaultActionOidcAudience,
          conflictDispatchPayload: conflictDispatch(),
        },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({
              event_name: "repository_dispatch",
              workflow_ref:
                "777genius/example/.github/workflows/deploy.yml@refs/heads/main",
              job_workflow_ref:
                "777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@refs/tags/v1",
            }),
          ),
          repositories: repository,
          sessions: new StaticSessionTokenService(),
          conflictReviews: new InMemoryConflictReviewExchangeVerifier(),
          clock,
        },
      ),
    ).rejects.toThrow("workflow_ref_not_allowed");
  });

  it("rejects repository_dispatch from mutable reusable workflow refs", async () => {
    const repository = new InMemoryActionControlPlaneRepository();

    await expect(
      exchangeGitHubOidcToken(
        {
          oidcToken: "oidc",
          audience: defaultActionOidcAudience,
          conflictDispatchPayload: conflictDispatch(),
        },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({
              event_name: "repository_dispatch",
              workflow_ref:
                "777genius/example/.github/workflows/reviewrouter.yml@refs/heads/main",
              job_workflow_ref:
                "777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@refs/heads/main",
            }),
          ),
          repositories: repository,
          sessions: new StaticSessionTokenService(),
          conflictReviews: new InMemoryConflictReviewExchangeVerifier(),
          clock,
        },
      ),
    ).rejects.toThrow("workflow_ref_not_allowed");
  });

  it("rejects repository_dispatch from self-hosted runners", async () => {
    const repository = new InMemoryActionControlPlaneRepository();

    await expect(
      exchangeGitHubOidcToken(
        {
          oidcToken: "oidc",
          audience: defaultActionOidcAudience,
          conflictDispatchPayload: conflictDispatch(),
        },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({
              event_name: "repository_dispatch",
              workflow_ref:
                "777genius/example/.github/workflows/reviewrouter.yml@refs/heads/main",
              job_workflow_ref:
                "777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@refs/tags/v1",
              runner_environment: "self-hosted",
            }),
          ),
          repositories: repository,
          sessions: new StaticSessionTokenService(),
          conflictReviews: new InMemoryConflictReviewExchangeVerifier(),
          clock,
        },
      ),
    ).rejects.toThrow("workflow_ref_not_allowed");
  });

  it("rejects OIDC claims for a different repository id", async () => {
    const repository = new InMemoryActionControlPlaneRepository();
    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({ repository_id: "999999" }),
          ),
          repositories: repository,
          sessions: new StaticSessionTokenService(),
          clock,
        },
      ),
    ).rejects.toThrow("repository_not_registered");
  });

  it("rejects OIDC claims from non-ReviewRouter workflow files", async () => {
    const repository = new InMemoryActionControlPlaneRepository();
    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({
              workflow_ref:
                "777genius/example/.github/workflows/deploy.yml@refs/heads/main",
            }),
          ),
          repositories: repository,
          sessions: new StaticSessionTokenService(),
          clock,
        },
      ),
    ).rejects.toThrow("workflow_ref_not_allowed");
  });

  it("checks action control plane entitlements before issuing sessions", async () => {
    const entitlements = new DenyingActionEntitlements();

    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        {
          oidcVerifier: new StaticOidcVerifier(githubOidcClaims()),
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService(),
          entitlements,
          clock,
        },
      ),
    ).rejects.toThrow("entitlement_denied:action_control_plane");
    expect(entitlements.calls).toEqual([
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        repositoryFullName: "777genius/example",
      },
    ]);
  });

  it("checks action rate limits before issuing sessions", async () => {
    const rateLimits = new DenyingActionRateLimits();

    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        {
          oidcVerifier: new StaticOidcVerifier(githubOidcClaims()),
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService(),
          rateLimits,
          clock,
        },
      ),
    ).rejects.toThrow("rate_limit_exceeded:action:oidc_exchange");
    expect(rateLimits.oidcExchangeCalls).toEqual([
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        repositoryFullName: "777genius/example",
        eventName: "pull_request",
        githubActorLogin: "777genius",
        githubRunId: "1001",
        githubRunAttempt: "1",
      },
    ]);
  });

  it("rejects replayed GitHub OIDC tokens when replay protection is configured", async () => {
    const replayNonces = new InMemoryActionOidcReplayNonceStore();
    const dependencies = {
      oidcVerifier: new StaticOidcVerifier(
        githubOidcClaims({ jti: "nonce-1", exp: 1_777_777_777 }),
      ),
      repositories: new InMemoryActionControlPlaneRepository(),
      sessions: new StaticSessionTokenService(),
      replayNonces,
      clock,
    };

    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        dependencies,
      ),
    ).resolves.toMatchObject({ repository: "777genius/example" });
    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        dependencies,
      ),
    ).rejects.toThrow("oidc_replay_detected");
    expect(
      replayNonces.consumed.get(`${githubActionsOidcIssuer}:nonce-1`),
    ).toEqual(new Date(1_777_777_777_000));
  });

  it("requires jti when replay protection is configured", async () => {
    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        {
          oidcVerifier: new StaticOidcVerifier(githubOidcClaims()),
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService(),
          replayNonces: new InMemoryActionOidcReplayNonceStore(),
          clock,
        },
      ),
    ).rejects.toThrow("oidc_jti_required");
  });

  it("does not spend rate-limit capacity on replayed OIDC tokens", async () => {
    const rateLimits = new DenyingActionRateLimits();
    const replayNonces = new InMemoryActionOidcReplayNonceStore();
    await replayNonces.tryConsumeNonce({
      key: `${githubActionsOidcIssuer}:nonce-2`,
      expiresAt: new Date(fixedNow.getTime() + 60_000),
      now: fixedNow,
    });

    await expect(
      exchangeGitHubOidcToken(
        { oidcToken: "oidc", audience: defaultActionOidcAudience },
        {
          oidcVerifier: new StaticOidcVerifier(
            githubOidcClaims({ jti: "nonce-2" }),
          ),
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService(),
          replayNonces,
          rateLimits,
          clock,
        },
      ),
    ).rejects.toThrow("oidc_replay_detected");
    expect(rateLimits.oidcExchangeCalls).toEqual([]);
  });

  it("returns runtime config without secrets", async () => {
    const config = await getActionRuntimeConfig(
      { sessionToken: "session" },
      {
        repositories: new InMemoryActionControlPlaneRepository(),
        sessions: new StaticSessionTokenService(),
        clock,
      },
    );

    expect(config).toMatchObject({
      protocolVersion: 1,
      configVersion: 7,
      provider: {
        model: "poolside/laguna-m.1:free",
        reasoningEffort: "medium",
        fastMode: false,
        secretBackedProviderEnabled: true,
      },
      providers: [
        {
          model: "poolside/laguna-m.1:free",
          requiredHealthy: true,
          secretBackedProviderEnabled: true,
        },
      ],
      execution: {
        providerLimit: 1,
        providerMaxParallel: 1,
        inlineMinAgreement: 1,
      },
      runtimeEnv: {
        REVIEW_AUTH_MODE: "openrouter-api",
        CODEX_FAST_MODE: "false",
        REQUIRED_HEALTHY_PROVIDERS: "openrouter/poolside/laguna-m.1:free",
        REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: "0",
        REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED: "0",
        REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED: "0",
        REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED: "0",
        REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED: "0",
        REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED: "0",
      },
    });
    expect(JSON.stringify(config)).not.toMatch(/SECRET|PRIVATE_KEY|AUTH_JSON/);
  });

  it("returns explicitly enabled investigation rollout flags in OIDC runtime config", async () => {
    const repositories = new InMemoryActionControlPlaneRepository();
    repositories.runtimeConfig = parseReviewConfiguration({
      ...defaultOpenRouterRuntimeConfig,
      investigationRollout: {
        recordingEnabled: true,
        shadowEnabled: true,
        contextCriticEnabled: true,
        verifiedCleanEnabled: true,
        crossRevisionReplayEnabled: true,
        productionEffectsEnabled: true,
      },
    });

    const config = await getActionRuntimeConfig(
      { sessionToken: "session" },
      {
        repositories,
        sessions: new StaticSessionTokenService(),
        clock,
      },
    );

    expect(config.runtimeEnv).toMatchObject({
      REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED: "1",
    });
    expect(JSON.stringify(config)).not.toMatch(/SECRET|PRIVATE_KEY|AUTH_JSON/);
  });

  it("uses deployment defaults only when no persisted review config exists", async () => {
    const repositories = new InMemoryActionControlPlaneRepository();
    repositories.runtimeConfig = null;

    const config = await getActionRuntimeConfig(
      { sessionToken: "session" },
      {
        repositories,
        sessions: new StaticSessionTokenService({
          ...sessionClaims,
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
        }),
        defaultProvider: {
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
        clock,
      },
    );

    expect(config).toMatchObject({
      configVersion: 1,
      provider: {
        kind: "codex",
        authMode: "codex_subscription_oauth_rotating",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
      runtimeEnv: {
        CODEX_MODEL: "gpt-5.6-sol",
        CODEX_REASONING_EFFORT: "high",
      },
    });
  });

  it("checks the conflict runtime gate before rejecting unsupported production providers", async () => {
    const conflictReviewRuntimeGate =
      new ConfigurableConflictReviewRuntimeGate();

    await expect(
      getActionRuntimeConfig(
        { sessionToken: "session", actionVersion: "v1" },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService({
            ...sessionClaims,
            eventName: "repository_dispatch",
            reviewKind: "conflict-head",
            conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
            pullRequestNumber: 7,
            headSha: "a".repeat(40),
            baseRef: "main",
            baseSha: "b".repeat(40),
            configSnapshotId: "repository:7",
          }),
          conflictReviewRuntimeGate,
          clock,
        },
      ),
    ).rejects.toThrow("conflict_runtime_provider_unsupported:openrouter");

    expect(conflictReviewRuntimeGate.calls).toEqual([
      {
        phase: "runtime_config",
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        repositoryFullName: "777genius/example",
      },
    ]);
  });

  it("does not build conflict posting proxy config for unsupported production providers", async () => {
    await expect(
      getActionRuntimeConfig(
        { sessionToken: "session", actionVersion: "v1" },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService({
            ...sessionClaims,
            eventName: "repository_dispatch",
            reviewKind: "conflict-head",
            conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
            pullRequestNumber: 7,
            headSha: "a".repeat(40),
            baseRef: "main",
            baseSha: "b".repeat(40),
            configSnapshotId: "repository:7",
          }),
          conflictReviewRuntimeGate:
            new ConfigurableConflictReviewRuntimeGate(),
          conflictReviewPostingAvailable: true,
          clock,
        },
      ),
    ).rejects.toThrow("conflict_runtime_provider_unsupported:openrouter");
  });

  it("fails conflict runtime config when the runtime gate is disabled", async () => {
    const conflictReviewRuntimeGate =
      new ConfigurableConflictReviewRuntimeGate();
    conflictReviewRuntimeGate.enabled = false;

    await expect(
      getActionRuntimeConfig(
        { sessionToken: "session" },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService({
            ...sessionClaims,
            eventName: "repository_dispatch",
            reviewKind: "conflict-head",
            conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
            pullRequestNumber: 7,
            headSha: "a".repeat(40),
            baseRef: "main",
            baseSha: "b".repeat(40),
            configSnapshotId: "repository:7",
          }),
          conflictReviewRuntimeGate,
          clock,
        },
      ),
    ).rejects.toThrow("conflict_review_runtime_disabled");

    expect(conflictReviewRuntimeGate.calls).toEqual([
      expect.objectContaining({ phase: "runtime_config" }),
    ]);
  });

  it("rejects conflict runtime config without a pinned runtime version", async () => {
    const conflictSession = new StaticSessionTokenService({
      ...sessionClaims,
      eventName: "repository_dispatch",
      reviewKind: "conflict-head",
      conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
      pullRequestNumber: 7,
      headSha: "a".repeat(40),
      baseRef: "main",
      baseSha: "b".repeat(40),
      configSnapshotId: "repository:7",
    });

    await expect(
      getActionRuntimeConfig(
        { sessionToken: "session" },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: conflictSession,
          conflictReviewRuntimeGate:
            new ConfigurableConflictReviewRuntimeGate(),
          clock,
        },
      ),
    ).rejects.toThrow("conflict_runtime_version_required");

    await expect(
      getActionRuntimeConfig(
        { sessionToken: "session", actionVersion: "main" },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: conflictSession,
          conflictReviewRuntimeGate:
            new ConfigurableConflictReviewRuntimeGate(),
          clock,
        },
      ),
    ).rejects.toThrow("conflict_runtime_version_unsupported:main");
  });

  it("rejects incomplete conflict session claims instead of returning blank runtime fields", async () => {
    await expect(
      getActionRuntimeConfig(
        { sessionToken: "session", actionVersion: "v1" },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService({
            ...sessionClaims,
            eventName: "repository_dispatch",
            reviewKind: "conflict-head",
            conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
            pullRequestNumber: 7,
            headSha: "a".repeat(40),
            baseRef: "main",
            configSnapshotId: "repository:7",
          }),
          clock,
        },
      ),
    ).rejects.toThrow();
  });

  it("rejects conflict runtime config when the review config changed after exchange", async () => {
    const repositories = new InMemoryActionControlPlaneRepository();
    repositories.runtimeConfigVersion = 8;

    await expect(
      getActionRuntimeConfig(
        { sessionToken: "session", actionVersion: "v1" },
        {
          repositories,
          sessions: new StaticSessionTokenService({
            ...sessionClaims,
            eventName: "repository_dispatch",
            reviewKind: "conflict-head",
            conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
            pullRequestNumber: 7,
            headSha: "a".repeat(40),
            baseRef: "main",
            baseSha: "b".repeat(40),
            configSnapshotId: "repository:7",
          }),
          clock,
        },
      ),
    ).rejects.toThrow("conflict_review_config_snapshot_mismatch");
  });

  it("rejects conflict runtime config for providers without runtime adapters", async () => {
    const unsupportedProviderSets = [
      {
        expectedCode: "conflict_runtime_provider_unsupported:claude",
        providers: [
          {
            kind: "claude",
            authMode: "claude_code_oauth",
            model: "sonnet",
            reasoningEffort: "medium",
            agenticContext: true,
            fastMode: false,
          },
        ],
      },
      {
        expectedCode: "conflict_runtime_provider_unsupported:openrouter",
        providers: [
          {
            kind: "openrouter",
            authMode: "openrouter_api_key",
            model: "poolside/laguna-m.1:free",
            reasoningEffort: "medium",
            agenticContext: true,
            fastMode: false,
          },
        ],
      },
      {
        expectedCode: "codex_provider_requires_rotating_workflow",
        providers: [
          {
            kind: "codex",
            authMode: "codex_subscription_oauth_rotating",
            model: "gpt-5.5",
            reasoningEffort: "medium",
            agenticContext: true,
            fastMode: false,
          },
        ],
      },
    ] as const;

    for (const providerSet of unsupportedProviderSets) {
      const repositories = new InMemoryActionControlPlaneRepository();
      repositories.runtimeConfig = parseReviewConfiguration({
        ...safeDefaultReviewConfiguration,
        providers: providerSet.providers,
        execution:
          "execution" in providerSet
            ? providerSet.execution
            : safeDefaultReviewConfiguration.execution,
      });

      await expect(
        getActionRuntimeConfig(
          { sessionToken: "session", actionVersion: "v1" },
          {
            repositories,
            sessions: new StaticSessionTokenService({
              ...sessionClaims,
              eventName: "repository_dispatch",
              reviewKind: "conflict-head",
              conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
              pullRequestNumber: 7,
              headSha: "a".repeat(40),
              baseRef: "main",
              baseSha: "b".repeat(40),
              configSnapshotId: "repository:7",
            }),
            conflictReviewRuntimeGate:
              new ConfigurableConflictReviewRuntimeGate(),
            clock,
          },
        ),
      ).rejects.toThrow(providerSet.expectedCode);
    }
  });

  it.each([
    {
      authMode: "codex_subscription_oauth" as const,
      expectedCode: "codex_provider_requires_rotating_workflow",
    },
    {
      authMode: "codex_openai_api_key" as const,
      expectedCode: "codex_provider_requires_rotating_workflow",
    },
    {
      authMode: "codex_subscription_oauth_rotating" as const,
      expectedCode: "codex_provider_requires_rotating_workflow",
    },
  ])(
    "rejects Codex auth mode $authMode on the standard action runtime",
    async ({ authMode, expectedCode }) => {
      const repositories = new InMemoryActionControlPlaneRepository();
      repositories.runtimeConfig = parseReviewConfiguration({
        ...safeDefaultReviewConfiguration,
        providers: [
          {
            kind: "codex",
            authMode,
            model: "gpt-5.5",
            reasoningEffort: "medium",
            agenticContext: true,
            fastMode: false,
          },
        ],
      });

      await expect(
        getActionRuntimeConfig(
          { sessionToken: "session" },
          {
            repositories,
            sessions: new StaticSessionTokenService(),
            clock,
          },
        ),
      ).rejects.toThrow(expectedCode);
    },
  );

  it("returns Codex rotating runtime config for the Codex rotating workflow", async () => {
    const repositories = new InMemoryActionControlPlaneRepository();
    repositories.runtimeConfig = parseReviewConfiguration({
      ...safeDefaultReviewConfiguration,
      providers: [
        {
          kind: "codex",
          authMode: "codex_subscription_oauth_rotating",
          model: "gpt-5.5",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
        },
      ],
      reviewLanguage: "Russian",
    });

    const config = await getActionRuntimeConfig(
      { sessionToken: "session" },
      {
        repositories,
        sessions: new StaticSessionTokenService({
          ...sessionClaims,
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
        }),
        clock,
      },
    );

    expect(config).toMatchObject({
      provider: {
        kind: "codex",
        authMode: "codex_subscription_oauth_rotating",
        model: "gpt-5.5",
      },
      runtimeEnv: {
        REVIEW_AUTH_MODE: "codex-oauth-rotating",
        REVIEW_OUTPUT_LANGUAGE: "Russian",
      },
    });
  });

  it("returns Codex rotating runtime config for interaction workflows", async () => {
    const repositories = new InMemoryActionControlPlaneRepository();
    repositories.runtimeConfig = parseReviewConfiguration({
      ...safeDefaultReviewConfiguration,
      providers: [
        {
          kind: "codex",
          authMode: "codex_subscription_oauth_rotating",
          model: "gpt-5.5",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
        },
      ],
    });

    const config = await getActionRuntimeConfig(
      { sessionToken: "session" },
      {
        repositories,
        sessions: new StaticSessionTokenService({
          ...sessionClaims,
          eventName: "pull_request_review_comment",
          workflowPath: ".github/workflows/reviewrouter-interaction.yml",
        }),
        clock,
      },
    );

    expect(config).toMatchObject({
      provider: {
        kind: "codex",
        authMode: "codex_subscription_oauth_rotating",
      },
      runtimeEnv: {
        REVIEW_AUTH_MODE: "codex-oauth-rotating",
      },
    });
  });

  it("returns Claude runtime config without provider secrets", async () => {
    const repositories = new InMemoryActionControlPlaneRepository();
    repositories.runtimeConfig = parseReviewConfiguration({
      ...safeDefaultReviewConfiguration,
      providers: [
        {
          kind: "claude",
          authMode: "claude_code_oauth",
          model: "sonnet",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
        },
      ],
    });

    const config = await getActionRuntimeConfig(
      { sessionToken: "session", actionVersion: "v1.2.3" },
      {
        repositories,
        sessions: new StaticSessionTokenService(),
        compatibility: new StaticActionRuntimeCompatibilityPolicy({
          providerActionVersionAllowlist: { claude: ["v1.2.3"] },
        }),
        clock,
      },
    );

    expect(config.provider).toMatchObject({
      kind: "claude",
      authMode: "claude_code_oauth",
      model: "sonnet",
    });
    expect(config.runtimeEnv).toMatchObject({
      REVIEW_AUTH_MODE: "claude-oauth",
      REVIEW_PROVIDERS: "claude/sonnet",
      REQUIRED_HEALTHY_PROVIDERS: "claude/sonnet",
      SYNTHESIS_MODEL: "claude/sonnet",
      CLAUDE_MODEL: "sonnet",
    });
    expect(config.runtimeEnv).not.toHaveProperty("CODEX_MODEL");
    expect(JSON.stringify(config)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("adds a derived ledger key to runtime config when configured", async () => {
    const ledgerKeys = new StaticActionLedgerKeys();
    const config = await getActionRuntimeConfig(
      { sessionToken: "session" },
      {
        repositories: new InMemoryActionControlPlaneRepository(),
        sessions: new StaticSessionTokenService(),
        ledgerKeys,
        clock,
      },
    );

    expect(config.runtimeEnv.REVIEW_ROUTER_LEDGER_KEY).toBe("ledger-key");
    expect(ledgerKeys.calls).toEqual([
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
      },
    ]);
  });

  it("blocks runtime config for known-bad action versions", async () => {
    await expect(
      getActionRuntimeConfig(
        { sessionToken: "session", actionVersion: "v0.9.0" },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService(),
          compatibility: new StaticActionRuntimeCompatibilityPolicy({
            blockedActionVersions: ["v0.9.0"],
          }),
          clock,
        },
      ),
    ).rejects.toThrow("action_version_blocked:v0.9.0");
  });

  it("blocks Claude runtime config for action refs outside the provider allowlist", async () => {
    const repositories = new InMemoryActionControlPlaneRepository();
    repositories.runtimeConfig = parseReviewConfiguration({
      ...safeDefaultReviewConfiguration,
      providers: [
        {
          kind: "claude",
          authMode: "claude_code_oauth",
          model: "sonnet",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
        },
      ],
    });

    await expect(
      getActionRuntimeConfig(
        { sessionToken: "session", actionVersion: "v1.0.0" },
        {
          repositories,
          sessions: new StaticSessionTokenService(),
          compatibility: new StaticActionRuntimeCompatibilityPolicy({
            providerActionVersionAllowlist: { claude: ["v1.2.3"] },
          }),
          clock,
        },
      ),
    ).rejects.toThrow("action_version_provider_unsupported:claude:v1.0.0");
  });

  it("checks action control plane entitlements before returning config", async () => {
    await expect(
      getActionRuntimeConfig(
        { sessionToken: "session" },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService(),
          entitlements: new DenyingActionEntitlements(),
          clock,
        },
      ),
    ).rejects.toThrow("entitlement_denied:action_control_plane");
  });

  it("issues a repository-scoped GitHub App token for branded comments", async () => {
    const commentTokens = new InMemoryCommentTokenIssuer();

    const result = await issueActionCommentToken(
      { sessionToken: "session" },
      {
        repositories: new InMemoryActionControlPlaneRepository(),
        sessions: new StaticSessionTokenService(),
        commentTokens,
        clock,
      },
    );

    expect(result).toEqual({
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
  });

  it("does not mint a new v1 comment token after legacy admission closes", async () => {
    const commentTokens = new InMemoryCommentTokenIssuer();
    const admissionInputs: unknown[] = [];

    await expect(
      issueActionCommentToken(
        { sessionToken: "session" },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService(),
          commentTokens,
          legacyMutationAdmission: {
            assertLegacyReviewMutationAllowed: async (input) => {
              admissionInputs.push(input);
              throw new Error("legacy_review_mutation_blocked:v2_active");
            },
          },
          clock,
        },
      ),
    ).rejects.toThrow("legacy_review_mutation_blocked:v2_active");
    expect(admissionInputs).toEqual([
      expect.objectContaining({
        operation: LegacyReviewMutationOperation.CommentToken,
        eventName: "pull_request",
      }),
    ]);
    expect(commentTokens.calls).toEqual([]);
  });

  it("revalidates repository state before issuing branded comment tokens", async () => {
    const repositories = new InMemoryActionControlPlaneRepository();
    repositories.repository = { ...repositoryContext, selected: false };

    await expect(
      issueActionCommentToken(
        { sessionToken: "session" },
        {
          repositories,
          sessions: new StaticSessionTokenService(),
          commentTokens: new InMemoryCommentTokenIssuer(),
          clock,
        },
      ),
    ).rejects.toThrow("repository_not_selected");
  });

  it("does not issue the generic branded comment token for conflict-head sessions", async () => {
    await expect(
      issueActionCommentToken(
        { sessionToken: "session" },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService({
            ...sessionClaims,
            eventName: "repository_dispatch",
            reviewKind: "conflict-head",
            conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
            pullRequestNumber: 7,
            headSha: "a".repeat(40),
            baseRef: "main",
            baseSha: "b".repeat(40),
            configSnapshotId: "repository:7",
          }),
          commentTokens: new InMemoryCommentTokenIssuer(),
          clock,
        },
      ),
    ).rejects.toThrow("conflict_review_posting_token_unavailable");
  });

  it("keeps conflict posting capability fail-closed when the backing service is missing", async () => {
    const conflictReviewRuntimeGate =
      new ConfigurableConflictReviewRuntimeGate();

    await expect(
      requestConflictReviewPostingSession(
        {
          sessionToken: "session",
          protocolVersion: 1,
          manifestHash: "c".repeat(64),
        },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService({
            ...sessionClaims,
            eventName: "repository_dispatch",
            reviewKind: "conflict-head",
            conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
            pullRequestNumber: 7,
            headSha: "a".repeat(40),
            baseRef: "main",
            baseSha: "b".repeat(40),
            configSnapshotId: "repository:7",
          }),
          conflictReviewRuntimeGate,
          clock,
        },
      ),
    ).rejects.toThrow("conflict_review_posting_session_unavailable");

    expect(conflictReviewRuntimeGate.calls).toEqual([
      expect.objectContaining({ phase: "posting_session" }),
    ]);
  });

  it("issues a scoped conflict posting session with a separate token audience", async () => {
    const conflictPostingSessions =
      new InMemoryConflictPostingSessionRepository();
    const postingSessions =
      new JoseActionConflictReviewPostingSessionTokenService(
        "0123456789abcdef0123456789abcdef",
      );
    const conflictPrePostValidator = new ConfigurableConflictPrePostValidator();

    const result = await requestConflictReviewPostingSession(
      {
        sessionToken: "session",
        protocolVersion: 1,
        manifestHash: "c".repeat(64),
      },
      {
        repositories: new InMemoryActionControlPlaneRepository(),
        sessions: new StaticSessionTokenService({
          ...sessionClaims,
          eventName: "repository_dispatch",
          reviewKind: "conflict-head",
          conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
          pullRequestNumber: 7,
          headSha: "a".repeat(40),
          baseRef: "main",
          baseSha: "b".repeat(40),
          configSnapshotId: "repository:7",
        }),
        conflictReviewRuntimeGate: new ConfigurableConflictReviewRuntimeGate(),
        conflictPrePostValidator,
        conflictPostingSessions,
        postingSessions,
        clock,
      },
    );

    expect(result).toMatchObject({
      protocolVersion: 1,
      manifestHash: "c".repeat(64),
      scope: {
        dispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
        pullRequestNumber: 7,
        headSha: "a".repeat(40),
        baseRef: "main",
        baseSha: "b".repeat(40),
        allowedOperations: ["summary_comment", "advisory_status"],
      },
    });
    const claims = await postingSessions.verify({
      token: result.postingSessionToken,
      now: fixedNow,
    });
    expect(claims).toMatchObject({
      purpose: "conflict-review-posting",
      attemptId: "attempt_1",
      manifestHash: "c".repeat(64),
      operationScopeHash: "d".repeat(64),
    });
    await expect(
      new JoseActionSessionTokenService(
        "0123456789abcdef0123456789abcdef",
      ).verify({
        token: result.postingSessionToken,
        now: fixedNow,
      }),
    ).rejects.toThrow();
    expect(JSON.stringify(result)).not.toMatch(/nonce|github_token|ghs_/i);
    expect(conflictPrePostValidator.calls).toEqual([
      {
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        pullRequestNumber: 7,
        headSha: "a".repeat(40),
        baseRef: "main",
        baseSha: "b".repeat(40),
      },
    ]);
  });

  it("denies conflict posting session before issuing a token when pre-post validation fails", async () => {
    const conflictPostingSessions =
      new InMemoryConflictPostingSessionRepository();
    const postingSessions =
      new JoseActionConflictReviewPostingSessionTokenService(
        "0123456789abcdef0123456789abcdef",
      );
    const conflictPrePostValidator = new ConfigurableConflictPrePostValidator();
    conflictPrePostValidator.error = new Error(
      "conflict_posting_pr_head_mismatch",
    );

    await expect(
      requestConflictReviewPostingSession(
        {
          sessionToken: "session",
          protocolVersion: 1,
          manifestHash: "c".repeat(64),
        },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService({
            ...sessionClaims,
            eventName: "repository_dispatch",
            reviewKind: "conflict-head",
            conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
            pullRequestNumber: 7,
            headSha: "a".repeat(40),
            baseRef: "main",
            baseSha: "b".repeat(40),
            configSnapshotId: "repository:7",
          }),
          conflictReviewRuntimeGate:
            new ConfigurableConflictReviewRuntimeGate(),
          conflictPrePostValidator,
          conflictPostingSessions,
          postingSessions,
          clock,
        },
      ),
    ).rejects.toThrow("conflict_posting_pr_head_mismatch");

    expect(conflictPrePostValidator.calls).toHaveLength(1);
    expect(conflictPostingSessions.calls).toHaveLength(0);
  });

  it("posts conflict summary and advisory status through scoped proxy intents", async () => {
    const conflictPostingSessions =
      new InMemoryConflictPostingSessionRepository();
    const postingSessions =
      new JoseActionConflictReviewPostingSessionTokenService(
        "0123456789abcdef0123456789abcdef",
      );
    const conflictPostingGateway = new InMemoryConflictPostingGateway();
    const conflictPrePostValidator = new ConfigurableConflictPrePostValidator();
    const actionSession = {
      ...sessionClaims,
      eventName: "repository_dispatch" as const,
      reviewKind: "conflict-head" as const,
      conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
      pullRequestNumber: 7,
      headSha: "a".repeat(40),
      baseRef: "main",
      baseSha: "b".repeat(40),
      configSnapshotId: "repository:7",
    };
    const session = await requestConflictReviewPostingSession(
      {
        sessionToken: "session",
        protocolVersion: 1,
        manifestHash: "c".repeat(64),
      },
      {
        repositories: new InMemoryActionControlPlaneRepository(),
        sessions: new StaticSessionTokenService(actionSession),
        conflictReviewRuntimeGate: new ConfigurableConflictReviewRuntimeGate(),
        conflictPrePostValidator,
        conflictPostingSessions,
        postingSessions,
        clock,
      },
    );

    const summary = await postConflictReviewSummary(
      {
        postingSessionToken: session.postingSessionToken,
        protocolVersion: 1,
        summaryMarkdown: "Found 1 conflict-head issue.",
      },
      {
        conflictPostingSessions,
        postingSessions,
        conflictPostingGateway,
        conflictPrePostValidator,
        clock,
      },
    );
    const duplicateSummary = await postConflictReviewSummary(
      {
        postingSessionToken: session.postingSessionToken,
        protocolVersion: 1,
        summaryMarkdown: "Found 1 conflict-head issue.",
      },
      {
        conflictPostingSessions,
        postingSessions,
        conflictPostingGateway,
        conflictPrePostValidator,
        clock,
      },
    );
    const status = await postConflictReviewStatus(
      {
        postingSessionToken: session.postingSessionToken,
        protocolVersion: 1,
        state: "success",
      },
      {
        conflictPostingSessions,
        postingSessions,
        conflictPostingGateway,
        conflictPrePostValidator,
        clock,
      },
    );

    expect(summary.status).toBe("posted");
    expect(duplicateSummary.status).toBe("already_posted");
    expect(status.status).toBe("posted");
    expect(conflictPostingGateway.summaries).toHaveLength(1);
    expect(conflictPostingGateway.summaries[0]).toMatchObject({
      repositoryFullName: "777genius/example",
      pullRequestNumber: 7,
    });
    expect(conflictPostingGateway.summaries[0]?.body).toContain(
      "Advisory review",
    );
    expect(conflictPostingGateway.summaries[0]?.body).toContain(
      `Reviewed head: \`${"a".repeat(40)}\``,
    );
    expect(conflictPostingGateway.summaries[0]?.body).toContain(
      "Base ref: `main`",
    );
    expect(conflictPostingGateway.summaries[0]?.body).toContain(
      "reviewrouter:conflict-review:v1",
    );
    expect(conflictPostingGateway.statuses).toEqual([
      expect.objectContaining({
        repositoryFullName: "777genius/example",
        headSha: "a".repeat(40),
        context: "ReviewRouter conflict review",
        state: "success",
      }),
    ]);
    expect(conflictPrePostValidator.calls).toHaveLength(4);
  });

  it("repeats pre-post validation before summary and advisory status writes", async () => {
    const conflictPostingSessions =
      new InMemoryConflictPostingSessionRepository();
    const postingSessions =
      new JoseActionConflictReviewPostingSessionTokenService(
        "0123456789abcdef0123456789abcdef",
      );
    const conflictPrePostValidator = new ConfigurableConflictPrePostValidator();
    const conflictPostingGateway = new InMemoryConflictPostingGateway();
    const actionSession = {
      ...sessionClaims,
      eventName: "repository_dispatch" as const,
      reviewKind: "conflict-head" as const,
      conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
      pullRequestNumber: 7,
      headSha: "a".repeat(40),
      baseRef: "main",
      baseSha: "b".repeat(40),
      configSnapshotId: "repository:7",
    };
    const session = await requestConflictReviewPostingSession(
      {
        sessionToken: "session",
        protocolVersion: 1,
        manifestHash: "c".repeat(64),
      },
      {
        repositories: new InMemoryActionControlPlaneRepository(),
        sessions: new StaticSessionTokenService(actionSession),
        conflictReviewRuntimeGate: new ConfigurableConflictReviewRuntimeGate(),
        conflictPrePostValidator,
        conflictPostingSessions,
        postingSessions,
        clock,
      },
    );

    conflictPrePostValidator.error = new Error(
      "conflict_posting_pr_head_mismatch",
    );

    await expect(
      postConflictReviewSummary(
        {
          postingSessionToken: session.postingSessionToken,
          protocolVersion: 1,
          summaryMarkdown: "Found 1 conflict-head issue.",
        },
        {
          conflictPostingSessions,
          postingSessions,
          conflictPostingGateway,
          conflictPrePostValidator,
          clock,
        },
      ),
    ).rejects.toThrow("conflict_posting_pr_head_mismatch");
    await expect(
      postConflictReviewStatus(
        {
          postingSessionToken: session.postingSessionToken,
          protocolVersion: 1,
          state: "success",
        },
        {
          conflictPostingSessions,
          postingSessions,
          conflictPostingGateway,
          conflictPrePostValidator,
          clock,
        },
      ),
    ).rejects.toThrow("conflict_posting_pr_head_mismatch");

    expect(conflictPostingGateway.summaries).toHaveLength(0);
    expect(conflictPostingGateway.statuses).toHaveLength(0);
    expect(conflictPostingSessions.calls).toHaveLength(1);
  });

  it("can recover an ambiguous conflict summary posting intent on retry", async () => {
    const conflictPostingSessions =
      new InMemoryConflictPostingSessionRepository();
    const postingSessions =
      new JoseActionConflictReviewPostingSessionTokenService(
        "0123456789abcdef0123456789abcdef",
      );
    const conflictPrePostValidator = new ConfigurableConflictPrePostValidator();
    const actionSession = {
      ...sessionClaims,
      eventName: "repository_dispatch" as const,
      reviewKind: "conflict-head" as const,
      conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
      pullRequestNumber: 7,
      headSha: "a".repeat(40),
      baseRef: "main",
      baseSha: "b".repeat(40),
      configSnapshotId: "repository:7",
    };
    const session = await requestConflictReviewPostingSession(
      {
        sessionToken: "session",
        protocolVersion: 1,
        manifestHash: "c".repeat(64),
      },
      {
        repositories: new InMemoryActionControlPlaneRepository(),
        sessions: new StaticSessionTokenService(actionSession),
        conflictReviewRuntimeGate: new ConfigurableConflictReviewRuntimeGate(),
        conflictPrePostValidator,
        conflictPostingSessions,
        postingSessions,
        clock,
      },
    );
    const request = {
      postingSessionToken: session.postingSessionToken,
      protocolVersion: 1 as const,
      summaryMarkdown: "Found 1 conflict-head issue.",
    };

    await expect(
      postConflictReviewSummary(request, {
        conflictPostingSessions,
        postingSessions,
        conflictPostingGateway: new RejectingConflictPostingGateway(),
        conflictPrePostValidator,
        clock,
      }),
    ).rejects.toThrow("network_timeout_after_summary_write");
    expect(
      JSON.stringify([...conflictPostingSessions.intents.values()]),
    ).toContain("token=[redacted]");
    expect(
      JSON.stringify([...conflictPostingSessions.intents.values()]),
    ).not.toContain("ghs_secret");
    expect(
      JSON.stringify([...conflictPostingSessions.intents.values()]),
    ).toContain("nonce=[redacted]");
    expect(
      JSON.stringify([...conflictPostingSessions.intents.values()]),
    ).not.toContain("raw-dispatch-nonce");

    const retryGateway = new InMemoryConflictPostingGateway();
    await expect(
      postConflictReviewSummary(request, {
        conflictPostingSessions,
        postingSessions,
        conflictPostingGateway: retryGateway,
        conflictPrePostValidator,
        clock,
      }),
    ).resolves.toMatchObject({
      protocolVersion: 1,
      status: "posted",
      githubExternalId: "summary_1",
    });
    expect(retryGateway.summaries).toHaveLength(1);
  });

  it("rejects model-controlled summary markers and required-review claims", async () => {
    const postingSessions =
      new JoseActionConflictReviewPostingSessionTokenService(
        "0123456789abcdef0123456789abcdef",
      );
    const token = await postingSessions.sign({
      claims: {
        purpose: "conflict-review-posting",
        attemptId: "attempt_1",
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        githubRepositoryId: "123456",
        githubInstallationId: "129500385",
        repository: "777genius/example",
        githubRunId: "1001",
        githubRunAttempt: "1",
        dispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
        pullRequestNumber: 7,
        headSha: "a".repeat(40),
        baseRef: "main",
        baseSha: "b".repeat(40),
        configSnapshotId: "repository:7",
        manifestHash: "c".repeat(64),
        operationScopeHash: "d".repeat(64),
        protocolVersion: 1,
      },
      expiresInSeconds: 60,
      issuedAt: fixedNow,
    });

    await expect(
      postConflictReviewSummary(
        {
          postingSessionToken: token.token,
          protocolVersion: 1,
          summaryMarkdown:
            "<!-- reviewrouter:conflict-review:v1 --> merge result was reviewed",
        },
        {
          conflictPostingSessions:
            new InMemoryConflictPostingSessionRepository(),
          postingSessions,
          conflictPostingGateway: new InMemoryConflictPostingGateway(),
          clock,
        },
      ),
    ).rejects.toThrow("conflict_review_summary_marker_forbidden");
  });

  it("blocks conflict posting session before capability issuance when the runtime gate is disabled", async () => {
    const conflictReviewRuntimeGate =
      new ConfigurableConflictReviewRuntimeGate();
    conflictReviewRuntimeGate.enabled = false;

    await expect(
      requestConflictReviewPostingSession(
        {
          sessionToken: "session",
          protocolVersion: 1,
          manifestHash: "c".repeat(64),
        },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService({
            ...sessionClaims,
            eventName: "repository_dispatch",
            reviewKind: "conflict-head",
            conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
            pullRequestNumber: 7,
            headSha: "a".repeat(40),
            baseRef: "main",
            baseSha: "b".repeat(40),
            configSnapshotId: "repository:7",
          }),
          conflictReviewRuntimeGate,
          clock,
        },
      ),
    ).rejects.toThrow("conflict_review_runtime_disabled");
  });

  it("does not issue conflict posting sessions for normal action sessions", async () => {
    await expect(
      requestConflictReviewPostingSession(
        {
          sessionToken: "session",
          protocolVersion: 1,
          manifestHash: "c".repeat(64),
        },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService(),
          clock,
        },
      ),
    ).rejects.toThrow("conflict_review_session_required");
  });

  it("checks action control plane entitlements before issuing branded comment tokens", async () => {
    const commentTokens = new InMemoryCommentTokenIssuer();

    await expect(
      issueActionCommentToken(
        { sessionToken: "session" },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService(),
          commentTokens,
          entitlements: new DenyingActionEntitlements(),
          clock,
        },
      ),
    ).rejects.toThrow("entitlement_denied:action_control_plane");
    expect(commentTokens.calls).toEqual([]);
  });

  it("resolves review thread lifecycle through a repository-scoped backend resolver", async () => {
    const resolver = new InMemoryReviewThreadLifecycleResolver();
    const result = await resolveActionReviewThreadLifecycle(
      {
        sessionToken: "session",
        request: {
          protocolVersion: 1,
          pullRequestNumber: 109,
          reviewedHeadSha: "a".repeat(40),
          target: {
            targetId: "rrt_123",
            threadId: "PRRT_kwDOExample",
            fingerprint: "b".repeat(24),
            parentCommentId: "PRRC_kwDOExample",
            parentCommentUpdatedAt: "2026-05-03T11:59:00.000Z",
            threadCommentCount: 1,
          },
        },
      },
      {
        repositories: new InMemoryActionControlPlaneRepository(),
        sessions: new StaticSessionTokenService(),
        reviewThreadLifecycleResolver: resolver,
        clock,
      },
    );

    expect(result).toEqual({
      protocolVersion: 1,
      status: "resolved",
      resolvedBy: "github_user",
      reasonCodes: [],
    });
    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0]!.repository).toEqual(repositoryContext);
    expect(resolver.calls[0]!.request.target.threadId).toBe("PRRT_kwDOExample");
  });

  it("checks action control plane entitlements before resolving review thread lifecycle", async () => {
    const resolver = new InMemoryReviewThreadLifecycleResolver();

    await expect(
      resolveActionReviewThreadLifecycle(
        {
          sessionToken: "session",
          request: {
            protocolVersion: 1,
            pullRequestNumber: 109,
            reviewedHeadSha: "a".repeat(40),
            target: {
              targetId: "rrt_123",
              threadId: "PRRT_kwDOExample",
              fingerprint: "b".repeat(24),
              parentCommentId: "PRRC_kwDOExample",
              parentCommentUpdatedAt: "2026-05-03T11:59:00.000Z",
              threadCommentCount: 1,
            },
          },
        },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService(),
          reviewThreadLifecycleResolver: resolver,
          entitlements: new DenyingActionEntitlements(),
          clock,
        },
      ),
    ).rejects.toThrow("entitlement_denied:action_control_plane");
    expect(resolver.calls).toEqual([]);
  });

  it("revalidates repository state before returning runtime config", async () => {
    const repositories = new InMemoryActionControlPlaneRepository();
    repositories.repository = { ...repositoryContext, selected: false };

    await expect(
      getActionRuntimeConfig(
        { sessionToken: "session" },
        {
          repositories,
          sessions: new StaticSessionTokenService(),
          clock,
        },
      ),
    ).rejects.toThrow("repository_not_selected");
  });

  it("records safe health reports and rejects code/diff payloads", async () => {
    const repository = new InMemoryActionControlPlaneRepository();
    await recordActionHealthReport(
      {
        sessionToken: "session",
        report: {
          protocolVersion: 1,
          actionVersion: "v1",
          configVersion: 7,
          configSource: "runtime_oidc",
          providerSetupState: "configured",
          providerHealth: "ok",
          safeErrorCategory: "none",
          findingCounts: { critical: 1, major: 0, minor: 0, info: 0 },
          commentCounts: { inline: 1, summary: 1 },
        },
      },
      {
        repositories: repository,
        sessions: new StaticSessionTokenService(),
        clock,
      },
    );

    expect(repository.healthReports).toHaveLength(1);
    expect(repository.healthReports[0]).toMatchObject({
      protocolVersion: 1,
      configSource: "runtime_oidc",
      findingCounts: { critical: 1, major: 0, minor: 0, info: 0 },
      commentCounts: { inline: 1, summary: 1 },
    });
    expect(() =>
      assertSafeActionHealthReport({
        actionVersion: "v1",
        configVersion: 7,
        providerSetupState: "configured",
        providerHealth: "failed",
        safeErrorCategory: "runtime_error",
        safeErrorSummary: "```ts\nconsole.log('code')\n```",
      }),
    ).toThrow("health_report_contains_code_or_diff");
  });

  it("defaults legacy health reports to protocol version 1", () => {
    expect(
      assertSafeActionHealthReport({
        actionVersion: "v1",
        configVersion: 7,
        providerSetupState: "configured",
        providerHealth: "ok",
        safeErrorCategory: "none",
      }),
    ).toMatchObject({ protocolVersion: 1 });
  });

  it("checks action rate limits before accepting health reports", async () => {
    const rateLimits = new DenyingActionRateLimits();

    await expect(
      recordActionHealthReport(
        {
          sessionToken: "session",
          report: safeHealthReport(),
        },
        {
          repositories: new InMemoryActionControlPlaneRepository(),
          sessions: new StaticSessionTokenService(),
          rateLimits,
          clock,
        },
      ),
    ).rejects.toThrow("rate_limit_exceeded:action:health_report");
    expect(rateLimits.healthReportCalls).toEqual([
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        repositoryFullName: "777genius/example",
        githubRunId: "1001",
        githubRunAttempt: "1",
      },
    ]);
  });

  it("revalidates repository identity before accepting health reports", async () => {
    const repositories = new InMemoryActionControlPlaneRepository();
    repositories.repository = {
      ...repositoryContext,
      fullName: "777genius/renamed-example",
    };

    await expect(
      recordActionHealthReport(
        {
          sessionToken: "session",
          report: safeHealthReport(),
        },
        {
          repositories,
          sessions: new StaticSessionTokenService(),
          clock,
        },
      ),
    ).rejects.toThrow("repository_name_mismatch");
    expect(repositories.healthReports).toHaveLength(0);
  });

  it("rejects raw health payloads with extra fields, code, secrets, or oversized content", () => {
    const openAiToken = "s" + "k-" + "a".repeat(24);
    const claudeToken = "s" + "k-ant-oat01-" + "c".repeat(24);
    const githubToken = "github" + "_pat_" + "b".repeat(24);
    const bearerToken = "opaque-session-token-1234567890";

    expect(() =>
      assertSafeActionHealthReport({
        ...safeHealthReport(),
        extraTelemetry: "harmless but not allowed",
      }),
    ).toThrow(/Unrecognized key/);

    expect(() =>
      assertSafeActionHealthReport({
        ...safeHealthReport(),
        rawOutput: `OPENAI_API_KEY=${openAiToken}`,
      }),
    ).toThrow("health_report_contains_secret_value");

    expect(() =>
      assertSafeActionHealthReport({
        ...safeHealthReport(),
        safeErrorSummary: `GitHub returned token ${githubToken}`,
      }),
    ).toThrow("health_report_contains_secret_value");

    expect(() =>
      assertSafeActionHealthReport({
        ...safeHealthReport(),
        safeErrorSummary: `Claude returned ${claudeToken}`,
      }),
    ).toThrow("health_report_contains_secret_value");

    expect(() =>
      assertSafeActionHealthReport({
        ...safeHealthReport(),
        safeErrorSummary: `Authorization: Bearer ${bearerToken}`,
      }),
    ).toThrow("health_report_contains_secret_value");

    expect(() =>
      assertSafeActionHealthReport({
        ...safeHealthReport(),
        safeErrorSummary: "refresh_token=rotating-oauth-value",
      }),
    ).toThrow("health_report_contains_secret_value");

    expect(() =>
      assertSafeActionHealthReport({
        ...safeHealthReport(),
        safeErrorSummary: "nonce=raw-dispatch-nonce",
      }),
    ).toThrow("health_report_contains_secret_value");

    expect(() =>
      assertSafeActionHealthReport({
        ...safeHealthReport(),
        safeErrorSummary:
          "provider failed after retries " +
          "x".repeat(8_000) +
          " OPENAI_API_KEY=sk-abc12345678901234567",
      }),
    ).toThrow("health_report_contains_secret_value");

    expect(() =>
      assertSafeActionHealthReport({
        ...safeHealthReport(),
        rawDiff: "diff --git a/src/app.ts b/src/app.ts",
      }),
    ).toThrow("health_report_contains_code_or_diff");

    expect(() =>
      assertSafeActionHealthReport({
        ...safeHealthReport(),
        ignoredButLarge: "x".repeat(actionHealthReportMaxBytes),
      }),
    ).toThrow("health_report_too_large");
  });

  it("accepts actionable but metadata-only auth guidance", () => {
    expect(
      assertSafeActionHealthReport({
        ...safeHealthReport(),
        providerHealth: "failed",
        safeErrorCategory: "provider_auth_invalid",
        safeErrorSummary:
          "Codex auth appears stale. Re-seed auth.json on the trusted runner or GitHub Secret.",
      }),
    ).toMatchObject({
      providerHealth: "failed",
      safeErrorCategory: "provider_auth_invalid",
    });
  });

  it("prunes expired OIDC replay nonces through a narrow cleanup port", async () => {
    const replayNonces = new InMemoryActionOidcReplayNonceStore();
    await replayNonces.tryConsumeNonce({
      key: "expired",
      expiresAt: new Date(fixedNow.getTime() - 1),
      now: fixedNow,
    });
    await replayNonces.tryConsumeNonce({
      key: "active",
      expiresAt: new Date(fixedNow.getTime() + 60_000),
      now: fixedNow,
    });

    await expect(
      pruneExpiredActionOidcReplayNonces(
        { expiredBefore: fixedNow, limit: 100 },
        { replayNonces },
      ),
    ).resolves.toEqual({ deleted: 1 });
    expect([...replayNonces.consumed.keys()]).toEqual(["active"]);
  });

  it("signs and verifies short-lived action session tokens", async () => {
    const sessions = new JoseActionSessionTokenService(
      "0123456789abcdef0123456789abcdef",
    );
    const claims: ActionSessionClaims = {
      ...sessionClaims,
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
    };
    const signed = await sessions.sign({
      claims,
      expiresInSeconds: 60,
      issuedAt: fixedNow,
    });

    await expect(
      sessions.verify({ token: signed.token, now: fixedNow }),
    ).resolves.toMatchObject(claims);
    await expect(
      sessions.verify({
        token: signed.token,
        now: new Date(fixedNow.getTime() + 120_000),
      }),
    ).rejects.toThrow();
  });

  it("verifies review comment action session tokens for interaction runs", async () => {
    const sessions = new JoseActionSessionTokenService(
      "0123456789abcdef0123456789abcdef",
    );
    const claims: ActionSessionClaims = {
      ...sessionClaims,
      eventName: "pull_request_review_comment",
    };
    const signed = await sessions.sign({
      claims,
      expiresInSeconds: 60,
      issuedAt: fixedNow,
    });

    await expect(
      sessions.verify({ token: signed.token, now: fixedNow }),
    ).resolves.toMatchObject(claims);
  });

  it("verifies PR conversation comment action session tokens for interaction runs", async () => {
    const sessions = new JoseActionSessionTokenService(
      "0123456789abcdef0123456789abcdef",
    );
    const claims: ActionSessionClaims = {
      ...sessionClaims,
      eventName: "issue_comment",
    };
    const signed = await sessions.sign({
      claims,
      expiresInSeconds: 60,
      issuedAt: fixedNow,
    });

    await expect(
      sessions.verify({ token: signed.token, now: fixedNow }),
    ).resolves.toMatchObject(claims);
  });

  it("requires complete conflict identity in action session tokens", async () => {
    const sessions = new JoseActionSessionTokenService(
      "0123456789abcdef0123456789abcdef",
    );
    const claims: ActionSessionClaims = {
      ...sessionClaims,
      eventName: "repository_dispatch",
      reviewKind: "conflict-head",
      conflictDispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
      pullRequestNumber: 7,
      headSha: "a".repeat(40),
      baseRef: "main",
      baseSha: "b".repeat(40),
      configSnapshotId: "repository:7",
    };
    const signed = await sessions.sign({
      claims,
      expiresInSeconds: 60,
      issuedAt: fixedNow,
    });

    await expect(
      sessions.verify({ token: signed.token, now: fixedNow }),
    ).resolves.toMatchObject(claims);

    const { configSnapshotId, ...incompleteClaims } = claims;
    expect(configSnapshotId).toBe("repository:7");
    const incomplete = await sessions.sign({
      claims: incompleteClaims as unknown as ActionSessionClaims,
      expiresInSeconds: 60,
      issuedAt: fixedNow,
    });
    await expect(
      sessions.verify({ token: incomplete.token, now: fixedNow }),
    ).rejects.toThrow("invalid_action_session_configSnapshotId");

    const unsafeDispatchId = await sessions.sign({
      claims: {
        ...claims,
        conflictDispatchId: "cr_123",
      },
      expiresInSeconds: 60,
      issuedAt: fixedNow,
    });
    await expect(
      sessions.verify({ token: unsafeDispatchId.token, now: fixedNow }),
    ).rejects.toThrow("invalid_action_session_conflictDispatchId");

    const unsafeBaseRef = await sessions.sign({
      claims: {
        ...claims,
        baseRef: "refs/heads/main",
      },
      expiresInSeconds: 60,
      issuedAt: fixedNow,
    });
    await expect(
      sessions.verify({ token: unsafeBaseRef.token, now: fixedNow }),
    ).rejects.toThrow("invalid_action_session_baseRef");
  });

  it("verifies GitHub Actions OIDC JWTs with JWKS and rejects wrong audience", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "kid-1" }] });
    const verifier = new JoseGitHubActionsOidcTokenVerifier({ jwks });
    const issuedAtSeconds = Math.floor(Date.now() / 1000);
    const token = await new SignJWT(stripUndefined(githubOidcClaims()))
      .setProtectedHeader({ alg: "RS256", kid: "kid-1" })
      .setIssuer(githubActionsOidcIssuer)
      .setAudience(defaultActionOidcAudience)
      .setIssuedAt(issuedAtSeconds)
      .setExpirationTime(issuedAtSeconds + 60)
      .sign(privateKey);

    await expect(
      verifier.verify({ token, audience: defaultActionOidcAudience }),
    ).resolves.toMatchObject({ repository: "777genius/example" });
    await expect(
      verifier.verify({ token, audience: "wrong-audience" }),
    ).rejects.toThrow();
  });
});

function githubOidcClaims(
  overrides: Partial<GitHubActionsOidcClaims> = {},
): GitHubActionsOidcClaims {
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
    ...overrides,
  };
}

function conflictDispatch(): ActionConflictReviewDispatchPayload {
  return {
    protocolVersion: 1,
    dispatchEventType: "reviewrouter_conflict_review",
    dispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
    nonce: "n".repeat(40),
    repositoryId: "123456",
    pullRequestNumber: 7,
    headSha: "a".repeat(40),
    baseRef: "main",
    baseSha: "b".repeat(40),
    fallbackVersion: 1,
  };
}

function safeHealthReport(): ActionHealthReport {
  return {
    protocolVersion: 1,
    actionVersion: "v1",
    configVersion: 7,
    providerSetupState: "configured",
    providerHealth: "ok",
    safeErrorCategory: "none",
  };
}

function stripUndefined<T extends Record<string, unknown>>(
  input: T,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}
