export type ApiDemoEndpoint = {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly purpose: string;
  readonly auth:
    | "public"
    | "github_webhook_signature"
    | "github_actions_oidc_session";
};

export type ApiDemoProvider = {
  readonly id: "codex_oauth" | "codex_api_key" | "openrouter_api_key";
  readonly label: string;
  readonly secretLocation: "github_actions_secret";
  readonly sentToSaas: false;
};

export type ApiDemoDocument = {
  readonly service: "review-router-api";
  readonly product: "ReviewRouter";
  readonly status: "demo_ready";
  readonly checkedAt: Date;
  readonly summary: string;
  readonly executionModel: {
    readonly reviewRunsIn: "customer_github_actions";
    readonly controlPlaneStores: readonly string[];
    readonly controlPlaneDoesNotStore: readonly string[];
  };
  readonly defaultReviewRuntime: {
    readonly actionVersion: string;
    readonly model: string;
    readonly effort: string;
    readonly provider: "codex_oauth";
  };
  readonly providers: readonly ApiDemoProvider[];
  readonly endpoints: readonly ApiDemoEndpoint[];
  readonly links: {
    readonly dashboard: string;
    readonly gettingStarted: string;
    readonly docs: string;
  };
};

export function buildApiDemoDocument(input: {
  readonly checkedAt: Date;
  readonly webUrl: string;
  readonly apiUrl: string;
  readonly actionVersion: string;
  readonly model: string;
  readonly effort: string;
}): ApiDemoDocument {
  return {
    service: "review-router-api",
    product: "ReviewRouter",
    status: "demo_ready",
    checkedAt: input.checkedAt,
    summary:
      "Hosted control plane for ReviewRouter. Repository code review still runs inside the customer's GitHub Actions workflow.",
    executionModel: {
      reviewRunsIn: "customer_github_actions",
      controlPlaneStores: [
        "GitHub installation metadata",
        "selected repositories",
        "review policy/configuration",
        "workflow setup state",
        "safe action health telemetry",
        "audit and outbox events",
      ],
      controlPlaneDoesNotStore: [
        "repository source code",
        "pull request diffs",
        "model prompts or responses by default",
        "Codex OAuth auth.json",
        "provider API keys",
      ],
    },
    defaultReviewRuntime: {
      actionVersion: input.actionVersion,
      model: input.model,
      effort: input.effort,
      provider: "codex_oauth",
    },
    providers: [
      {
        id: "codex_oauth",
        label: "Codex CLI with ChatGPT subscription OAuth",
        secretLocation: "github_actions_secret",
        sentToSaas: false,
      },
      {
        id: "codex_api_key",
        label: "Codex/OpenAI API key mode",
        secretLocation: "github_actions_secret",
        sentToSaas: false,
      },
      {
        id: "openrouter_api_key",
        label: "OpenRouter API key mode",
        secretLocation: "github_actions_secret",
        sentToSaas: false,
      },
    ],
    endpoints: [
      {
        method: "GET",
        path: "/health",
        purpose: "Liveness plus dependency health.",
        auth: "public",
      },
      {
        method: "GET",
        path: "/ready",
        purpose:
          "Small readiness response for demos, uptime checks, and smoke tests.",
        auth: "public",
      },
      {
        method: "GET",
        path: "/demo",
        purpose: "Human-readable API capability summary for the hosted beta.",
        auth: "public",
      },
      {
        method: "POST",
        path: "/webhooks/github",
        purpose: "GitHub App lifecycle webhooks for installation sync.",
        auth: "github_webhook_signature",
      },
      {
        method: "POST",
        path: "/api/action/v1/session/exchange",
        purpose:
          "GitHub Actions OIDC token exchange for runtime config access.",
        auth: "github_actions_oidc_session",
      },
      {
        method: "GET",
        path: "/api/action/v1/config",
        purpose: "Review runtime configuration fetched by the GitHub Action.",
        auth: "github_actions_oidc_session",
      },
      {
        method: "POST",
        path: "/api/action/v1/health-report",
        purpose: "Safe metadata-only action health telemetry.",
        auth: "github_actions_oidc_session",
      },
    ],
    links: {
      dashboard: `${input.webUrl}/dashboard`,
      gettingStarted: `${input.webUrl}/getting-started`,
      docs: "https://github.com/777genius/review-router-saas",
    },
  };
}
