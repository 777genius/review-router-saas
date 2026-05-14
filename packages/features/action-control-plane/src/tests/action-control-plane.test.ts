import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  parseReviewConfiguration,
  safeDefaultReviewConfiguration,
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
import type { ActionRateLimitPolicyPort } from "../application/ports/action-rate-limit-policy-port.js";
import type { ActionSessionTokenServicePort } from "../application/ports/action-session-token-service-port.js";
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
import { pruneExpiredActionOidcReplayNonces } from "../application/use-cases/prune-expired-action-oidc-replay-nonces.js";
import { resolveActionReviewThreadLifecycle } from "../application/use-cases/resolve-action-review-thread-lifecycle.js";
import { recordActionHealthReport } from "../application/use-cases/record-action-health-report.js";
import {
  actionHealthReportMaxBytes,
  assertSafeActionHealthReport,
  defaultActionOidcAudience,
  githubActionsOidcIssuer,
  type ActionHealthReport,
  type ActionRepositoryContext,
  type ActionReviewThreadLifecycleResolveResponse,
  type ActionSessionClaims,
  type GitHubActionsOidcClaims,
} from "../domain/action-control-plane.js";
import { JoseGitHubActionsOidcTokenVerifier } from "../infrastructure/oidc/jose-github-actions-oidc-token-verifier.js";
import { StaticActionRuntimeCompatibilityPolicy } from "../infrastructure/config/static-action-runtime-compatibility-policy.js";
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
  githubRunId: "1001",
  githubRunAttempt: "1",
  eventName: "pull_request",
  protocolVersion: 1,
};

class InMemoryActionControlPlaneRepository implements ActionControlPlaneRepositoryPort {
  public healthReports: ActionHealthReport[] = [];
  public repository: ActionRepositoryContext | null = repositoryContext;
  public runtimeConfig = safeDefaultReviewConfiguration;

  async findSelectedRepositoryByGithubId(
    githubRepositoryId: string,
  ): Promise<ActionRepositoryContext | null> {
    if (githubRepositoryId !== this.repository?.githubRepositoryId) {
      return null;
    }
    return this.repository;
  }

  async findRuntimeReviewConfiguration() {
    return { version: 7, config: this.runtimeConfig };
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
    return sessionClaims;
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
      githubRunId: "1001",
      protocolVersion: 1,
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
        model: "gpt-5.5",
        reasoningEffort: "medium",
        fastMode: false,
        secretBackedProviderEnabled: true,
      },
      providers: [
        {
          model: "gpt-5.5",
          secretBackedProviderEnabled: true,
        },
      ],
      execution: {
        providerLimit: 1,
        providerMaxParallel: 1,
        inlineMinAgreement: 1,
      },
      runtimeEnv: {
        REVIEW_AUTH_MODE: "codex-oauth",
        CODEX_MODEL: "gpt-5.5",
        CODEX_FAST_MODE: "false",
      },
    });
    expect(JSON.stringify(config)).not.toMatch(/SECRET|PRIVATE_KEY|AUTH_JSON/);
  });

  it("returns multi-provider runtime config for the action", async () => {
    const repositories = new InMemoryActionControlPlaneRepository();
    repositories.runtimeConfig = parseReviewConfiguration({
      ...safeDefaultReviewConfiguration,
      providers: [
        {
          kind: "codex",
          authMode: "codex_subscription_oauth",
          model: "gpt-5.5",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
        },
        {
          kind: "openrouter",
          authMode: "openrouter_api_key",
          model: "poolside/laguna-m.1:free",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
        },
      ],
      execution: {
        providerLimit: 2,
        providerMaxParallel: 2,
        inlineMinAgreement: 2,
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

    expect(config.providers.map((provider) => provider.model)).toEqual([
      "gpt-5.5",
      "poolside/laguna-m.1:free",
    ]);
    expect(config.execution).toEqual({
      providerLimit: 2,
      providerMaxParallel: 2,
      inlineMinAgreement: 2,
    });
    expect(config.runtimeEnv).toMatchObject({
      REVIEW_PROVIDERS: "codex/gpt-5.5,openrouter/poolside/laguna-m.1:free",
      PROVIDER_LIMIT: "2",
      PROVIDER_MAX_PARALLEL: "2",
      INLINE_MIN_AGREEMENT: "2",
      SYNTHESIS_MODEL: "codex/gpt-5.5",
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
    const signed = await sessions.sign({
      claims: sessionClaims,
      expiresInSeconds: 60,
      issuedAt: fixedNow,
    });

    await expect(
      sessions.verify({ token: signed.token, now: fixedNow }),
    ).resolves.toMatchObject(sessionClaims);
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
