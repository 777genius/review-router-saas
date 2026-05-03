import { describe, expect, it } from "vitest";
import { getAuthEnvironmentStatus, readOptionalAuthEnv } from "./auth-env";

describe("auth env", () => {
  it("reports missing required GitHub OAuth env without throwing during build", () => {
    expect(getAuthEnvironmentStatus({})).toEqual({
      configured: false,
      missing: [
        "AUTH_SECRET",
        "GITHUB_APP_CLIENT_ID",
        "GITHUB_APP_CLIENT_SECRET",
      ],
    });
  });

  it("reports configured auth env when all required values are present", () => {
    expect(
      getAuthEnvironmentStatus({
        AUTH_SECRET: "secret",
        GITHUB_APP_CLIENT_ID: "client",
        GITHUB_APP_CLIENT_SECRET: "client-secret",
      }),
    ).toEqual({ configured: true, missing: [] });
  });

  it("keeps Auth.js import build-safe with explicit placeholders", () => {
    expect(readOptionalAuthEnv("REVIEW_ROUTER_TEST_MISSING")).toBe(
      "missing-review_router_test_missing",
    );
  });
});
