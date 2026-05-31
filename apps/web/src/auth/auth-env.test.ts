import { describe, expect, it, vi } from "vitest";
import { authOptions } from "./auth-options";
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

  it("uses a branded sign-in page instead of the default Auth.js screen", () => {
    expect(authOptions.pages).toMatchObject({
      signIn: "/auth/signin",
      error: "/auth/signin",
    });
  });

  it("requests repository OAuth scope for review thread resolution", () => {
    const provider = authOptions.providers[0] as {
      readonly options?: {
        readonly authorization?: {
          readonly params?: { readonly scope?: string };
        };
      };
    };

    expect(provider.options?.authorization?.params?.scope?.split(" ")).toEqual(
      expect.arrayContaining(["read:user", "user:email", "repo"]),
    );
  });

  it("downgrades stale JWT session cookie noise to a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    authOptions.logger?.error?.(
      "JWT_SESSION_ERROR",
      new Error("decryption operation failed"),
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
