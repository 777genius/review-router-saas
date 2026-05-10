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
  GitHubInstallationRepositoryPort,
  GitHubInstallationSnapshot,
  GitHubPullRequestWebhookEnvelope,
  GitHubPullRequestWebhookHandlerPort,
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
