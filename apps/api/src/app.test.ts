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

type RuntimeReviewConfiguration = NonNullable<
  Awaited<
    ReturnType<
      ActionControlPlaneRepositoryPort["findRuntimeReviewConfiguration"]
    >
  >
>["config"];

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
        contents: "read" as const,
        pullRequests: "write" as const,
        issues: "write" as const,
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
        },
      },
      paths: {
        "/demo": {},
        "/demo.md": {},
        "/docs": {},
        "/api/action/v1/session/exchange": {},
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
    const commentTokens = new InMemoryCommentTokenIssuer();
    const app = await createApiApp({
      actionControlPlaneDependencies: {
        repositories,
        commentTokens,
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
