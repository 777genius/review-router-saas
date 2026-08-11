import { describe, expect, it } from "vitest";
import { resolveWorkflowPublicApiUrl } from "./workflow-public-api-url";

describe("resolveWorkflowPublicApiUrl", () => {
  it("uses the explicit public URL first", () => {
    expect(
      resolveWorkflowPublicApiUrl({
        NODE_ENV: "production",
        REVIEW_ROUTER_PUBLIC_API_URL: "https://app.reviewrouter.dev",
        REVIEW_ROUTER_API_URL: "https://internal.reviewrouter.dev",
      }),
    ).toBe("https://app.reviewrouter.dev");
  });

  it("falls back to REVIEW_ROUTER_API_URL when public URL is absent", () => {
    expect(
      resolveWorkflowPublicApiUrl({
        NODE_ENV: "production",
        REVIEW_ROUTER_API_URL: "https://app.reviewrouter.dev",
      }),
    ).toBe("https://app.reviewrouter.dev");
  });

  it("canonicalizes a configured root URL before embedding trust evidence", () => {
    expect(
      resolveWorkflowPublicApiUrl({
        NODE_ENV: "production",
        REVIEW_ROUTER_PUBLIC_API_URL: "https://app.reviewrouter.dev/",
      }),
    ).toBe("https://app.reviewrouter.dev");
  });

  it("allows localhost only for local development", () => {
    expect(resolveWorkflowPublicApiUrl({ NODE_ENV: "development" })).toBe(
      "http://localhost:4000",
    );
    expect(
      resolveWorkflowPublicApiUrl({
        NODE_ENV: "development",
        REVIEW_ROUTER_PUBLIC_API_URL: "http://localhost:4000",
      }),
    ).toBe("http://localhost:4000");
  });

  it("fails closed in production when no public API URL is configured", () => {
    expect(() =>
      resolveWorkflowPublicApiUrl({ NODE_ENV: "production" }),
    ).toThrow("missing_env:REVIEW_ROUTER_PUBLIC_API_URL");
  });

  it("rejects unsafe URLs before workflow generation", () => {
    expect(() =>
      resolveWorkflowPublicApiUrl({
        NODE_ENV: "production",
        REVIEW_ROUTER_PUBLIC_API_URL: "http://localhost:4000",
      }),
    ).toThrow("invalid_workflow_api_url");
    for (const origin of [
      "https://localhost",
      "https://service.localhost",
      "https://127.0.0.1",
      "https://127.1",
      "https://[::1]",
    ]) {
      expect(() =>
        resolveWorkflowPublicApiUrl({
          NODE_ENV: "production",
          REVIEW_ROUTER_PUBLIC_API_URL: origin,
        }),
      ).toThrow("invalid_workflow_api_url");
    }
    expect(() =>
      resolveWorkflowPublicApiUrl({
        NODE_ENV: "production",
        REVIEW_ROUTER_PUBLIC_API_URL: "http://app.reviewrouter.dev",
      }),
    ).toThrow("invalid_workflow_api_url");
    expect(() =>
      resolveWorkflowPublicApiUrl({
        NODE_ENV: "production",
        REVIEW_ROUTER_PUBLIC_API_URL: "https://token@app.reviewrouter.dev",
      }),
    ).toThrow("invalid_workflow_api_url");
    expect(() =>
      resolveWorkflowPublicApiUrl({
        NODE_ENV: "production",
        REVIEW_ROUTER_PUBLIC_API_URL: "https://app.reviewrouter.dev?x=1",
      }),
    ).toThrow("invalid_workflow_api_url");
  });
});
