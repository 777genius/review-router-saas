import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuthEnvironmentStatus, readOptionalAuthEnv } from "./auth-env";

describe("auth env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("requires Auth secret and at least one source OAuth provider", () => {
    expect(getAuthEnvironmentStatus({})).toEqual({
      configured: false,
      missing: [
        "AUTH_SECRET",
        "GITHUB_APP_CLIENT_ID",
        "GITHUB_APP_CLIENT_SECRET",
        "GITLAB_OAUTH_CLIENT_ID",
        "GITLAB_OAUTH_CLIENT_SECRET",
      ],
    });
  });

  it("reports configured auth env with GitHub OAuth", () => {
    expect(
      getAuthEnvironmentStatus({
        AUTH_SECRET: "secret",
        GITHUB_APP_CLIENT_ID: "client",
        GITHUB_APP_CLIENT_SECRET: "client-secret",
      }),
    ).toEqual({ configured: true, missing: [] });
  });

  it("reports configured auth env with GitLab OAuth only", () => {
    expect(
      getAuthEnvironmentStatus({
        AUTH_SECRET: "secret",
        GITLAB_OAUTH_CLIENT_ID: "client",
        GITLAB_OAUTH_CLIENT_SECRET: "client-secret",
      }),
    ).toEqual({ configured: true, missing: [] });
  });

  it("keeps Auth.js import build-safe with explicit placeholders", () => {
    expect(readOptionalAuthEnv("REVIEW_ROUTER_TEST_MISSING")).toBe(
      "missing-review_router_test_missing",
    );
  });

  it("uses a branded sign-in page instead of the default Auth.js screen", async () => {
    const { authOptions } = await import("./auth-options");

    expect(authOptions.pages).toMatchObject({
      signIn: "/auth/signin",
      error: "/auth/signin",
    });
  });

  it("requests repository OAuth scope for review thread resolution", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "client");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "client-secret");
    vi.resetModules();

    const { authOptions } = await import("./auth-options");
    const provider = authOptions.providers.find(
      (candidate) => (candidate as { readonly id?: string }).id === "github",
    ) as
      | {
          readonly options?: {
            readonly authorization?: {
              readonly params?: { readonly scope?: string };
            };
          };
        }
      | undefined;

    expect(provider).toBeDefined();
    expect(provider?.options?.authorization?.params?.scope?.split(" ")).toEqual(
      expect.arrayContaining(["read:user", "user:email", "repo"]),
    );
  });

  it("downgrades stale JWT session cookie noise to a warning", async () => {
    const { authOptions } = await import("./auth-options");
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
