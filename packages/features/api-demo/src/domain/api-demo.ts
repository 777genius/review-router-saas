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

export type ApiDemoQuickStartStep = {
  readonly order: number;
  readonly title: string;
  readonly description: string;
  readonly command?: string;
};

export type ApiDemoSecurityBoundary = {
  readonly topic: string;
  readonly guarantee: string;
};

export type ApiDemoSampleRequest = {
  readonly title: string;
  readonly command: string;
  readonly expectedSignal: string;
};

export type ApiDemoMaturity = {
  readonly stage: "hosted_beta";
  readonly readyFor: readonly string[];
  readonly knownLimitations: readonly string[];
};

export type ApiDemoIndexDocument = {
  readonly service: "review-router-api";
  readonly product: "ReviewRouter";
  readonly status: "ok";
  readonly summary: string;
  readonly links: {
    readonly health: string;
    readonly ready: string;
    readonly demo: string;
    readonly openapi: string;
    readonly dashboard: string;
    readonly docs: string;
  };
};

export type ApiDemoDocument = {
  readonly service: "review-router-api";
  readonly product: "ReviewRouter";
  readonly contractVersion: "2026-05-04";
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
  readonly quickStart: readonly ApiDemoQuickStartStep[];
  readonly sampleRequests: readonly ApiDemoSampleRequest[];
  readonly securityBoundaries: readonly ApiDemoSecurityBoundary[];
  readonly maturity: ApiDemoMaturity;
  readonly links: {
    readonly dashboard: string;
    readonly gettingStarted: string;
    readonly docs: string;
    readonly openapi: string;
  };
};

export function buildApiDemoIndex(input: {
  readonly webUrl: string;
  readonly apiUrl: string;
}): ApiDemoIndexDocument {
  return {
    service: "review-router-api",
    product: "ReviewRouter",
    status: "ok",
    summary: "Public API entrypoint for the ReviewRouter hosted control plane.",
    links: {
      health: `${input.apiUrl}/health`,
      ready: `${input.apiUrl}/ready`,
      demo: `${input.apiUrl}/demo`,
      openapi: `${input.apiUrl}/openapi.json`,
      dashboard: `${input.webUrl}/dashboard`,
      docs: "https://github.com/777genius/review-router-saas",
    },
  };
}

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
    contractVersion: "2026-05-04",
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
        method: "GET",
        path: "/openapi.json",
        purpose: "Machine-readable API surface for public demo endpoints.",
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
    quickStart: [
      {
        order: 1,
        title: "Install the GitHub App",
        description:
          "Connect ReviewRouter to selected repositories from the dashboard.",
      },
      {
        order: 2,
        title: "Choose provider credentials",
        description:
          "Store Codex OAuth, OpenAI API key, or OpenRouter API key in GitHub Actions secrets. The hosted control plane does not receive those credentials.",
      },
      {
        order: 3,
        title: "Provision the workflow",
        description:
          "Create a small GitHub Actions workflow that calls the ReviewRouter Action and fetches metadata-only runtime config from this API.",
      },
      {
        order: 4,
        title: "Open a pull request",
        description:
          "Review comments are posted from the installed GitHub App while model execution remains inside the repository workflow.",
      },
    ],
    sampleRequests: [
      {
        title: "Check service health",
        command: `curl -fsS ${input.apiUrl}/health | jq .`,
        expectedSignal: "status is ok and database dependency is ok",
      },
      {
        title: "Inspect demo contract",
        command: `curl -fsS ${input.apiUrl}/demo | jq .`,
        expectedSignal:
          "executionModel.reviewRunsIn is customer_github_actions",
      },
      {
        title: "Inspect OpenAPI metadata",
        command: `curl -fsS ${input.apiUrl}/openapi.json | jq .info`,
        expectedSignal: "OpenAPI document title is ReviewRouter API",
      },
    ],
    securityBoundaries: [
      {
        topic: "Repository code",
        guarantee:
          "Pull request diffs and source files are reviewed in the customer's GitHub Actions job, not uploaded to the SaaS control plane by default.",
      },
      {
        topic: "Provider credentials",
        guarantee:
          "Codex OAuth auth.json and provider API keys remain GitHub Actions secrets owned by the target repository or organization.",
      },
      {
        topic: "Runtime access",
        guarantee:
          "Workflow runtime config access uses GitHub Actions OIDC and short-lived ReviewRouter action sessions.",
      },
      {
        topic: "Telemetry",
        guarantee:
          "Health reports are metadata-only and intended for setup diagnostics, not model prompt or response storage.",
      },
    ],
    maturity: {
      stage: "hosted_beta",
      readyFor: [
        "dashboard walkthrough",
        "API smoke demo",
        "selected repository beta installs",
        "metadata-only action control-plane demo",
      ],
      knownLimitations: [
        "GitHub App lifecycle events must be enabled in the App settings before full install sync works.",
        "Public production should pin the GitHub Action to a release tag instead of main.",
      ],
    },
    links: {
      dashboard: `${input.webUrl}/dashboard`,
      gettingStarted: `${input.webUrl}/getting-started`,
      docs: "https://github.com/777genius/review-router-saas",
      openapi: `${input.apiUrl}/openapi.json`,
    },
  };
}

export function buildApiDemoOpenApiDocument(input: {
  readonly apiUrl: string;
}): Record<string, unknown> {
  const jsonResponseHeaders = {
    "Access-Control-Allow-Origin": {
      schema: { type: "string", const: "*" },
      description: "Public demo endpoints are browser-readable.",
    },
    "Cache-Control": {
      schema: { type: "string", const: "no-store" },
      description:
        "Demo responses are generated from current deployment config.",
    },
    "X-ReviewRouter-Demo": {
      schema: { type: "string", const: "true" },
      description: "Marks intentionally public demo endpoints.",
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "ReviewRouter API",
      version: "2026-05-04",
      summary:
        "Hosted control-plane API for ReviewRouter. Reviews run in customer GitHub Actions.",
    },
    servers: [{ url: input.apiUrl }],
    paths: {
      "/": {
        get: {
          summary: "API index",
          responses: {
            "200": {
              description: "Public ReviewRouter API index.",
              headers: jsonResponseHeaders,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ApiIndex" },
                  examples: {
                    hosted: {
                      value: buildApiDemoIndex({
                        webUrl: "https://reviewrouter-web.onrender.com",
                        apiUrl: input.apiUrl,
                      }),
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/health": {
        get: {
          summary: "Service and dependency health",
          responses: {
            "200": {
              description: "Service is healthy.",
              headers: jsonResponseHeaders,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/HealthResponse" },
                },
              },
            },
          },
        },
      },
      "/ready": {
        get: {
          summary: "Compact readiness check",
          responses: {
            "200": {
              description: "Service is ready.",
              headers: jsonResponseHeaders,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ReadyResponse" },
                  examples: {
                    ready: {
                      value: {
                        service: "review-router-api",
                        status: "ready",
                        checkedAt: "2026-05-04T00:00:00.000Z",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/demo": {
        get: {
          summary: "Public hosted beta capability summary",
          responses: {
            "200": {
              description: "ReviewRouter hosted beta demo document.",
              headers: jsonResponseHeaders,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ApiDemo" },
                  examples: {
                    hosted: {
                      value: {
                        ...buildApiDemoDocument({
                          checkedAt: new Date("2026-05-04T00:00:00.000Z"),
                          webUrl: "https://reviewrouter-web.onrender.com",
                          apiUrl: input.apiUrl,
                          actionVersion: "main",
                          model: "gpt-5.5",
                          effort: "medium",
                        }),
                        checkedAt: "2026-05-04T00:00:00.000Z",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/openapi.json": {
        get: {
          summary: "OpenAPI document",
          responses: {
            "200": {
              description: "OpenAPI 3.1 document.",
              headers: jsonResponseHeaders,
              content: {
                "application/json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
      "/webhooks/github": {
        post: {
          summary: "GitHub App lifecycle webhook",
          security: [{ githubWebhookSignature: [] }],
          responses: {
            "202": { description: "Webhook accepted." },
            "401": { description: "Invalid GitHub webhook signature." },
          },
        },
      },
      "/api/action/v1/session/exchange": {
        post: {
          summary: "GitHub Actions OIDC exchange",
          security: [{ githubActionsOidc: [] }],
          responses: {
            "200": { description: "Short-lived action session issued." },
            "401": { description: "Invalid GitHub Actions OIDC token." },
          },
        },
      },
      "/api/action/v1/config": {
        get: {
          summary: "Runtime review configuration",
          security: [{ reviewRouterActionSession: [] }],
          responses: {
            "200": { description: "Repository runtime config." },
            "401": { description: "Invalid action session." },
          },
        },
      },
      "/api/action/v1/health-report": {
        post: {
          summary: "Metadata-only action health report",
          security: [{ reviewRouterActionSession: [] }],
          responses: {
            "202": { description: "Health report accepted." },
            "401": { description: "Invalid action session." },
          },
        },
      },
    },
    components: {
      schemas: {
        ApiIndex: {
          type: "object",
          required: ["service", "product", "status", "summary", "links"],
          properties: {
            service: { type: "string", const: "review-router-api" },
            product: { type: "string", const: "ReviewRouter" },
            status: { type: "string", const: "ok" },
            summary: { type: "string" },
            links: {
              type: "object",
              required: [
                "health",
                "ready",
                "demo",
                "openapi",
                "dashboard",
                "docs",
              ],
              additionalProperties: false,
              properties: {
                health: { type: "string", format: "uri" },
                ready: { type: "string", format: "uri" },
                demo: { type: "string", format: "uri" },
                openapi: { type: "string", format: "uri" },
                dashboard: { type: "string", format: "uri" },
                docs: { type: "string", format: "uri" },
              },
            },
          },
        },
        ReadyResponse: {
          type: "object",
          required: ["service", "status", "checkedAt"],
          properties: {
            service: { type: "string", const: "review-router-api" },
            status: { type: "string", const: "ready" },
            checkedAt: { type: "string", format: "date-time" },
          },
        },
        HealthResponse: {
          type: "object",
          required: ["service", "status", "checkedAt"],
          properties: {
            service: { type: "string", const: "review-router-api" },
            status: { type: "string", enum: ["ok", "degraded"] },
            checkedAt: { type: "string", format: "date-time" },
            dependencies: {
              type: "array",
              items: {
                type: "object",
                required: ["name", "status"],
                properties: {
                  name: { type: "string" },
                  status: { type: "string", enum: ["ok", "degraded"] },
                },
              },
            },
          },
        },
        ApiDemo: {
          type: "object",
          required: [
            "service",
            "product",
            "contractVersion",
            "status",
            "checkedAt",
            "summary",
            "executionModel",
            "defaultReviewRuntime",
            "providers",
            "endpoints",
            "quickStart",
            "sampleRequests",
            "securityBoundaries",
            "maturity",
            "links",
          ],
          properties: {
            service: { type: "string", const: "review-router-api" },
            product: { type: "string", const: "ReviewRouter" },
            contractVersion: { type: "string", const: "2026-05-04" },
            status: { type: "string", const: "demo_ready" },
            checkedAt: { type: "string", format: "date-time" },
            summary: { type: "string" },
            executionModel: { type: "object" },
            defaultReviewRuntime: { type: "object" },
            providers: { type: "array", items: { type: "object" } },
            endpoints: { type: "array", items: { type: "object" } },
            quickStart: { type: "array", items: { type: "object" } },
            sampleRequests: { type: "array", items: { type: "object" } },
            securityBoundaries: { type: "array", items: { type: "object" } },
            maturity: { type: "object" },
            links: { type: "object" },
          },
        },
      },
      securitySchemes: {
        githubWebhookSignature: {
          type: "apiKey",
          in: "header",
          name: "x-hub-signature-256",
        },
        githubActionsOidc: {
          type: "http",
          scheme: "bearer",
          description: "GitHub Actions OIDC JWT.",
        },
        reviewRouterActionSession: {
          type: "http",
          scheme: "bearer",
          description:
            "Short-lived ReviewRouter session returned by the OIDC exchange endpoint.",
        },
      },
    },
  };
}
