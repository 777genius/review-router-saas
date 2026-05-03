import { describe, expect, it } from "vitest";
import type {
  ActionControlPlaneRepositoryPort,
  ActionEntitlementPolicyPort,
  ActionHealthReport,
  ActionRateLimitPolicyPort,
  ActionRepositoryContext,
  GitHubActionsOidcClaims,
  GitHubActionsOidcTokenVerifierPort,
} from "@reviewrouter/features-action-control-plane";
import {
  actionHealthReportMaxBytes,
  defaultActionOidcAudience,
  githubActionsOidcIssuer,
  JoseActionSessionTokenService,
} from "@reviewrouter/features-action-control-plane";
import type {
  GitHubInstallationRepositoryPort,
  GitHubInstallationSnapshot,
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

describe("API app", () => {
  it("serves health status", async () => {
    const app = await createApiApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
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

  it("serves action OIDC exchange, config fetch, and safe health report", async () => {
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
    expect(exchange.statusCode).toBe(200);
    const session = exchange.json<{ sessionToken: string }>();

    const config = await app.inject({
      method: "GET",
      url: "/api/action/config",
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({
      protocolVersion: 1,
      provider: { model: "gpt-5.5" },
      runtimeEnv: { REVIEW_AUTH_MODE: "codex-oauth" },
    });

    const health = await app.inject({
      method: "POST",
      url: "/api/action/health-report",
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
