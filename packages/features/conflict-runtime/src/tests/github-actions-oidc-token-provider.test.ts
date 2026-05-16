import { describe, expect, it } from "vitest";
import { GitHubActionsOidcTokenProvider } from "../infrastructure/github-actions-oidc-token-provider.js";

describe("GitHubActionsOidcTokenProvider", () => {
  it("requests a GitHub Actions OIDC token for the ReviewRouter audience", async () => {
    const calls: Array<{
      readonly url: string;
      readonly auth: string;
      readonly redirect?: "error" | undefined;
    }> = [];
    const token = await new GitHubActionsOidcTokenProvider({
      requestUrl: "https://actions.example/oidc?existing=1",
      requestToken: "request-token",
      audience: "reviewrouter",
      fetch: async (url, init) => {
        calls.push({
          url,
          auth: String(init.headers.authorization),
          redirect: init.redirect,
        });
        return {
          ok: true,
          status: 200,
          async json() {
            return { value: "oidc.jwt.value" };
          },
        };
      },
    }).requestToken();

    expect(token).toBe("oidc.jwt.value");
    expect(calls).toEqual([
      {
        url: "https://actions.example/oidc?existing=1&audience=reviewrouter",
        auth: "Bearer request-token",
        redirect: "error",
      },
    ]);
  });

  it("rejects untrusted OIDC request URLs before sending the request token", async () => {
    let fetchCalls = 0;
    await expect(
      new GitHubActionsOidcTokenProvider({
        requestUrl: "http://actions.example/oidc",
        requestToken: "request-token",
        fetch: async () => {
          fetchCalls += 1;
          return {
            ok: true,
            status: 200,
            async json() {
              return { value: "oidc.jwt.value" };
            },
          };
        },
      }).requestToken(),
    ).rejects.toThrow("conflict_runtime_oidc_url_untrusted");
    await expect(
      new GitHubActionsOidcTokenProvider({
        requestUrl: "not a url",
        requestToken: "request-token",
        fetch: async () => {
          fetchCalls += 1;
          return {
            ok: true,
            status: 200,
            async json() {
              return { value: "oidc.jwt.value" };
            },
          };
        },
      }).requestToken(),
    ).rejects.toThrow("conflict_runtime_oidc_url_untrusted");
    expect(fetchCalls).toBe(0);
  });

  it("fails closed without logging raw OIDC response bodies", async () => {
    await expect(
      new GitHubActionsOidcTokenProvider({
        requestUrl: "https://actions.example/oidc",
        requestToken: "request-token",
        fetch: async () => ({
          ok: false,
          status: 403,
          async json() {
            return { message: "token ghs_secret denied" };
          },
        }),
      }).requestToken(),
    ).rejects.toThrow(
      "conflict_runtime_oidc_http_error:oidc_request_failed:403",
    );
  });
});
