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
  readonly id:
    | "codex_oauth_rotating"
    | "claude_code_oauth"
    | "openrouter_api_key";
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
    readonly demoMarkdown: string;
    readonly openapi: string;
    readonly apiDocs: string;
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
    readonly provider: "codex_oauth_rotating";
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
    readonly apiDocs: string;
    readonly demoMarkdown: string;
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
      demoMarkdown: `${input.apiUrl}/demo.md`,
      openapi: `${input.apiUrl}/openapi.json`,
      apiDocs: `${input.apiUrl}/docs`,
      dashboard: `${input.webUrl}/dashboard`,
      docs: "https://github.com/777genius/review-router",
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
        "Codex OAuth rotating auth.json",
        "Claude Code OAuth token",
        "provider API keys",
      ],
    },
    defaultReviewRuntime: {
      actionVersion: input.actionVersion,
      model: input.model,
      effort: input.effort,
      provider: "codex_oauth_rotating",
    },
    providers: [
      {
        id: "codex_oauth_rotating",
        label:
          "Codex CLI with ChatGPT subscription OAuth and GitHub-hosted refresh",
        secretLocation: "github_actions_secret",
        sentToSaas: false,
      },
      {
        id: "claude_code_oauth",
        label: "Claude Code subscription OAuth",
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
        path: "/demo.md",
        purpose: "Terminal-friendly Markdown API demo summary.",
        auth: "public",
      },
      {
        method: "GET",
        path: "/openapi.json",
        purpose: "Machine-readable API surface for public demo endpoints.",
        auth: "public",
      },
      {
        method: "GET",
        path: "/docs",
        purpose:
          "Browser-friendly hosted API demo page for humans and screenshots.",
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
        method: "GET",
        path: "/api/action/v1/memory",
        purpose:
          "Scoped repository and workspace memory bundle fetched by the GitHub Action, optionally narrowed by a safe retrieval query.",
        auth: "github_actions_oidc_session",
      },
      {
        method: "POST",
        path: "/api/action/v1/memory-candidates",
        purpose:
          "Bounded distilled memory candidate submission from interaction workflows.",
        auth: "github_actions_oidc_session",
      },
      {
        method: "POST",
        path: "/api/action/v1/memory-commands",
        purpose:
          "Normalized memory confirmation, rejection, disable, and forget commands from interaction workflows.",
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
          "Store Codex OAuth rotating, Claude Code OAuth, or OpenRouter API credentials in GitHub Actions secrets. The hosted control plane does not receive those credentials.",
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
      {
        title: "Open the browser demo",
        command: `open ${input.apiUrl}/docs`,
        expectedSignal:
          "HTML page explains quick start and security boundaries",
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
          "Codex OAuth rotating auth.json, Claude Code OAuth tokens, and provider API keys remain GitHub Actions secrets owned by the target repository or organization.",
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
        "Hosted production requires REVIEW_ROUTER_ACTION_REF to be pinned to a full 40-character commit SHA.",
      ],
    },
    links: {
      dashboard: `${input.webUrl}/dashboard`,
      gettingStarted: `${input.webUrl}/getting-started`,
      docs: "https://github.com/777genius/review-router",
      openapi: `${input.apiUrl}/openapi.json`,
      apiDocs: `${input.apiUrl}/docs`,
      demoMarkdown: `${input.apiUrl}/demo.md`,
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
                        webUrl: "https://reviewrouter.site",
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
                          webUrl: "https://reviewrouter.site",
                          apiUrl: input.apiUrl,
                          actionVersion:
                            "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
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
      "/demo.md": {
        get: {
          summary: "Markdown API demo summary",
          responses: {
            "200": {
              description: "Terminal-friendly Markdown ReviewRouter API demo.",
              headers: jsonResponseHeaders,
              content: {
                "text/markdown": {
                  schema: { type: "string" },
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
      "/docs": {
        get: {
          summary: "Browser-friendly API demo page",
          responses: {
            "200": {
              description: "HTML ReviewRouter API demo page.",
              headers: jsonResponseHeaders,
              content: {
                "text/html": {
                  schema: { type: "string" },
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
      "/api/action/v1/memory": {
        get: {
          summary: "Scoped action memory bundle",
          description:
            "Returns confirmed, scoped memory snippets for the current repository action session. The optional retrieval query is a bounded safe hint generated by the runtime from PR metadata, not raw code, diffs, prompts, model output, or local conversation text. Unsafe query values are ignored and the endpoint falls back to the canonical scoped bundle.",
          parameters: [
            {
              name: "safeRetrievalQuery",
              in: "query",
              required: false,
              schema: { type: "string", maxLength: 500 },
              description:
                "Optional short, sanitized retrieval hint used to rank memory for the action run.",
            },
            {
              name: "q",
              in: "query",
              required: false,
              schema: { type: "string", maxLength: 500 },
              description:
                "Alias for safeRetrievalQuery. Kept for compact runtime clients.",
            },
          ],
          security: [{ reviewRouterActionSession: [] }],
          responses: {
            "200": {
              description: "Repository-scoped memory bundle.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ActionMemoryBundle" },
                },
              },
            },
            "401": { description: "Invalid action session." },
            "403": { description: "Repository or entitlement unavailable." },
          },
        },
      },
      "/api/action/v1/memory-candidates": {
        post: {
          summary: "Submit bounded memory candidate",
          description:
            "Accepts only distilled memory candidate text plus safe metadata from interaction workflows. Raw GitHub conversations, code, diffs, prompts, and model output are not valid payloads.",
          security: [{ reviewRouterActionSession: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ActionMemoryCandidateRequest",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Candidate processed as created, noop, or rejected.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ActionMemoryMutationResponse",
                  },
                },
              },
            },
            "400": { description: "Invalid memory candidate payload." },
            "401": { description: "Invalid action session." },
            "403": { description: "Not an interaction workflow session." },
          },
        },
      },
      "/api/action/v1/memory-commands": {
        post: {
          summary: "Execute normalized memory commands",
          description:
            "Accepts only normalized memory command ids from interaction workflows. The control plane rechecks repository/workspace permissions before confirming, rejecting, disabling, or forgetting memory.",
          security: [{ reviewRouterActionSession: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ActionMemoryCommandRequest",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Commands processed independently in order.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ActionMemoryCommandResponse",
                  },
                },
              },
            },
            "400": { description: "Invalid memory command payload." },
            "401": { description: "Invalid action session." },
            "403": { description: "Not an interaction workflow session." },
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
                "demoMarkdown",
                "openapi",
                "apiDocs",
                "dashboard",
                "docs",
              ],
              additionalProperties: false,
              properties: {
                health: { type: "string", format: "uri" },
                ready: { type: "string", format: "uri" },
                demo: { type: "string", format: "uri" },
                demoMarkdown: { type: "string", format: "uri" },
                openapi: { type: "string", format: "uri" },
                apiDocs: { type: "string", format: "uri" },
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
        ActionMemoryBundle: {
          type: "object",
          required: ["protocolVersion", "memoryVersion", "items"],
          additionalProperties: false,
          properties: {
            protocolVersion: { type: "number", const: 1 },
            memoryVersion: { type: "number", const: 1 },
            items: {
              type: "array",
              items: {
                type: "object",
                required: [
                  "id",
                  "scope",
                  "body",
                  "riskLevel",
                  "confidence",
                  "source",
                ],
                additionalProperties: true,
                properties: {
                  id: { type: "string" },
                  scope: {
                    type: "string",
                    enum: ["repository", "workspace", "user_prefs"],
                  },
                  body: { type: "string", maxLength: 1000 },
                  riskLevel: {
                    type: "string",
                    enum: ["low", "medium", "high", "critical"],
                  },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  source: {
                    type: "object",
                    required: ["type", "sourceVisibility"],
                    additionalProperties: true,
                    properties: {
                      type: { type: "string" },
                      sourceVisibility: {
                        type: "string",
                        enum: ["private", "internal", "public"],
                      },
                    },
                  },
                },
              },
            },
          },
        },
        ActionMemoryCandidateRequest: {
          type: "object",
          required: ["intent", "candidateBody", "extractionMethod", "source"],
          additionalProperties: false,
          properties: {
            protocolVersion: { type: "number", const: 1, default: 1 },
            intent: {
              type: "string",
              enum: [
                "explicit_command",
                "explicit_natural_language",
                "model_suggested_candidate",
                "ambiguous_discussion",
                "no_memory_intent",
              ],
            },
            requestedScope: {
              type: ["string", "null"],
              enum: ["repository", "workspace", null],
            },
            candidateBody: {
              type: "string",
              maxLength: 1000,
              description:
                "Distilled memory text only. Do not send raw comment threads, code, diffs, prompts, or model output.",
            },
            sourceTextHash: { type: ["string", "null"], maxLength: 256 },
            extractionMethod: {
              type: "string",
              enum: [
                "explicit_command",
                "explicit_natural_language",
                "model_suggested_candidate",
              ],
            },
            extractionVersion: {
              type: "number",
              minimum: 1,
              maximum: 100,
              default: 1,
            },
            source: {
              type: "object",
              required: ["sourceId"],
              additionalProperties: false,
              properties: {
                sourceId: { type: "string", minLength: 1, maxLength: 200 },
                githubCommentId: { type: ["string", "null"], maxLength: 80 },
                githubPullRequestNumber: {
                  type: ["number", "null"],
                  minimum: 1,
                  maximum: 1000000,
                },
                url: { type: ["string", "null"], format: "uri" },
                redactedExcerpt: { type: ["string", "null"], maxLength: 500 },
                sourceHash: { type: ["string", "null"], maxLength: 256 },
                sourceVisibility: {
                  type: "string",
                  enum: ["private", "internal", "public"],
                  default: "internal",
                },
              },
            },
          },
        },
        ActionMemoryCommandRequest: {
          type: "object",
          required: ["commands"],
          additionalProperties: false,
          properties: {
            protocolVersion: { type: "number", const: 1, default: 1 },
            commands: {
              type: "array",
              minItems: 1,
              maxItems: 5,
              items: {
                oneOf: [
                  {
                    type: "object",
                    required: ["kind", "suggestionId"],
                    additionalProperties: false,
                    properties: {
                      kind: {
                        type: "string",
                        const: "confirm_suggestion",
                      },
                      suggestionId: { type: "string", minLength: 1 },
                    },
                  },
                  {
                    type: "object",
                    required: ["kind", "suggestionId"],
                    additionalProperties: false,
                    properties: {
                      kind: {
                        type: "string",
                        const: "reject_suggestion",
                      },
                      suggestionId: { type: "string", minLength: 1 },
                      reason: { type: ["string", "null"], maxLength: 500 },
                    },
                  },
                  {
                    type: "object",
                    required: ["kind", "memoryItemId"],
                    additionalProperties: false,
                    properties: {
                      kind: {
                        type: "string",
                        enum: ["disable_memory", "forget_memory"],
                      },
                      memoryItemId: { type: "string", minLength: 1 },
                    },
                  },
                  {
                    type: "object",
                    required: ["kind"],
                    additionalProperties: false,
                    properties: {
                      kind: { type: "string", const: "list_memory" },
                      view: {
                        type: "string",
                        enum: ["active", "pending"],
                        default: "active",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        ActionMemoryCommandResponse: {
          type: "object",
          required: ["protocolVersion", "results"],
          additionalProperties: false,
          properties: {
            protocolVersion: { type: "number", const: 1 },
            results: {
              type: "array",
              items: {
                type: "object",
                required: ["kind", "status"],
                additionalProperties: false,
                properties: {
                  kind: {
                    type: "string",
                    enum: [
                      "confirm_suggestion",
                      "reject_suggestion",
                      "disable_memory",
                      "forget_memory",
                      "list_memory",
                    ],
                  },
                  status: {
                    type: "string",
                    enum: ["created", "updated", "noop", "rejected"],
                  },
                  id: { type: "string" },
                  version: { type: "number" },
                  reason: { type: "string" },
                  retryable: { type: "boolean" },
                },
              },
            },
          },
        },
        ActionMemoryMutationResponse: {
          type: "object",
          required: ["protocolVersion", "status"],
          additionalProperties: false,
          properties: {
            protocolVersion: { type: "number", const: 1 },
            status: {
              type: "string",
              enum: ["created", "updated", "noop", "rejected"],
            },
            id: { type: "string" },
            version: { type: "number" },
            reason: { type: "string" },
            retryable: { type: "boolean" },
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
