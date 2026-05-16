import { describe, expect, it } from "vitest";
import type { Clock } from "@reviewrouter/shared";
import {
  getApiDemo,
  getApiDemoIndex,
  getApiDemoOpenApi,
} from "../application/get-api-demo.js";

const fixedClock: Clock = {
  now: () => new Date("2026-05-04T09:00:00.000Z"),
};

describe("getApiDemo", () => {
  it("describes the hosted control plane without claiming SaaS sees code or secrets", () => {
    const demo = getApiDemo({
      clock: fixedClock,
      webUrl: "https://web.example.com/",
      apiUrl: "https://api.example.com/",
      actionVersion: "main",
      model: "gpt-5.5",
      effort: "medium",
    });

    expect(demo.status).toBe("demo_ready");
    expect(demo.contractVersion).toBe("2026-05-04");
    expect(demo.executionModel.reviewRunsIn).toBe("customer_github_actions");
    expect(demo.executionModel.controlPlaneDoesNotStore).toContain(
      "repository source code",
    );
    expect(demo.executionModel.controlPlaneDoesNotStore).toContain(
      "Codex OAuth auth.json",
    );
    expect(demo.providers.every((provider) => !provider.sentToSaas)).toBe(true);
    expect(demo.links.dashboard).toBe("https://web.example.com/dashboard");
    expect(demo.links.openapi).toBe("https://api.example.com/openapi.json");
    expect(demo.quickStart.map((step) => step.title)).toContain(
      "Choose provider credentials",
    );
    expect(demo.securityBoundaries.map((boundary) => boundary.topic)).toEqual([
      "Repository code",
      "Provider credentials",
      "Runtime access",
      "Telemetry",
    ]);
    expect(
      demo.sampleRequests.map((request) => request.command).join("\n"),
    ).toContain("https://api.example.com/openapi.json");
    expect(demo.maturity.stage).toBe("hosted_beta");
    expect(demo.endpoints.map((endpoint) => endpoint.path)).toContain(
      "/api/action/v1/session/exchange",
    );
  });

  it("builds an API index with stable public links", () => {
    const index = getApiDemoIndex({
      webUrl: "https://web.example.com/",
      apiUrl: "https://api.example.com/",
    });

    expect(index).toMatchObject({
      service: "review-router-api",
      product: "ReviewRouter",
      status: "ok",
      links: {
        health: "https://api.example.com/health",
        ready: "https://api.example.com/ready",
        demo: "https://api.example.com/demo",
        demoMarkdown: "https://api.example.com/demo.md",
        openapi: "https://api.example.com/openapi.json",
        apiDocs: "https://api.example.com/docs",
        dashboard: "https://web.example.com/dashboard",
      },
    });
  });

  it("builds an OpenAPI document for public demo endpoints", () => {
    const openapi = getApiDemoOpenApi({
      apiUrl: "https://api.example.com/",
    });

    expect(openapi).toMatchObject({
      openapi: "3.1.0",
      info: {
        title: "ReviewRouter API",
        version: "2026-05-04",
      },
      servers: [{ url: "https://api.example.com" }],
    });
    expect(Object.keys(openapi.paths as Record<string, unknown>)).toContain(
      "/demo",
    );
    expect(Object.keys(openapi.paths as Record<string, unknown>)).toContain(
      "/demo.md",
    );
    expect(Object.keys(openapi.paths as Record<string, unknown>)).toContain(
      "/docs",
    );
    expect(Object.keys(openapi.paths as Record<string, unknown>)).toContain(
      "/api/action/v1/session/exchange",
    );
    expect(Object.keys(openapi.paths as Record<string, unknown>)).toContain(
      "/api/action/v1/memory",
    );
    expect(Object.keys(openapi.paths as Record<string, unknown>)).toContain(
      "/api/action/v1/memory-candidates",
    );
    expect(Object.keys(openapi.paths as Record<string, unknown>)).toContain(
      "/api/action/v1/memory-commands",
    );
    expect(openapi).toMatchObject({
      components: {
        schemas: {
          ApiDemo: {
            required: expect.arrayContaining([
              "securityBoundaries",
              "sampleRequests",
              "maturity",
            ]),
          },
          ApiIndex: {},
          ReadyResponse: {},
          ActionMemoryBundle: {},
          ActionMemoryCandidateRequest: {},
          ActionMemoryCommandRequest: {},
          ActionMemoryCommandResponse: {},
          ActionMemoryMutationResponse: {},
        },
      },
    });

    const paths = openapi.paths as Record<string, Record<string, unknown>>;
    expect(paths["/demo"]).toMatchObject({
      get: {
        responses: {
          "200": {
            headers: {
              "Access-Control-Allow-Origin": {},
              "X-ReviewRouter-Demo": {},
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ApiDemo" },
              },
            },
          },
        },
      },
    });
    expect(paths["/api/action/v1/memory"]).toMatchObject({
      get: {
        security: [{ reviewRouterActionSession: [] }],
        parameters: expect.arrayContaining([
          expect.objectContaining({
            name: "safeRetrievalQuery",
            in: "query",
            required: false,
            schema: { type: "string", maxLength: 500 },
          }),
          expect.objectContaining({
            name: "q",
            in: "query",
            required: false,
            schema: { type: "string", maxLength: 500 },
          }),
        ]),
      },
    });
    expect(paths["/api/action/v1/memory-candidates"]).toMatchObject({
      post: {
        security: [{ reviewRouterActionSession: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/ActionMemoryCandidateRequest",
              },
            },
          },
        },
      },
    });
    expect(paths["/api/action/v1/memory-commands"]).toMatchObject({
      post: {
        security: [{ reviewRouterActionSession: [] }],
        requestBody: {
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
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ActionMemoryCommandResponse",
                },
              },
            },
          },
        },
      },
    });
  });
});
