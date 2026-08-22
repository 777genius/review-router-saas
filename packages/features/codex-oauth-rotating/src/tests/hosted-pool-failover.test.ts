import { describe, expect, it, vi } from "vitest";
import { runHostedCodexRelayTransport } from "../action/hosted-codex-relay";
import {
  hasHostedPoolRetryBudget,
  hostedPoolAccountFailureReason,
  runHostedPoolLeaseFailover,
} from "../action/github-action";

const oidcUrl = "https://vstoken.actions.githubusercontent.com/oidc/token";
const apiUrl = "https://reviewrouter.test";

describe("hosted pool account failover", () => {
  it.each([
    ["hosted_pool_quota_exhausted", "quota_exhausted"],
    ["hosted_relay_grant_failed:429", "quota_exhausted"],
    ["hosted_pool_authentication_failed", "authentication_failed"],
    ["hosted_relay_grant_failed:401", "authentication_failed"],
  ] as const)(
    "classifies definite pre-effect %s as %s",
    (message, expected) => {
      expect(hostedPoolAccountFailureReason(new Error(message))).toBe(expected);
    },
  );

  it.each([
    "quota_limited",
    "authentication_failed",
    "hosted_pool_account_failed",
    "relay_error: account_status_failed",
    "permission_required",
    "review_runtime_timeout",
    "hosted_relay_grant_failed:403",
    "hosted_relay_grant_ambiguous",
    "hosted_pool_effect_ambiguous",
  ])("does not rotate accounts for non-proven %s", (message) => {
    expect(hostedPoolAccountFailureReason(new Error(message))).toBeUndefined();
  });

  it("requires enough time for one backup grant exchange", () => {
    expect(
      hasHostedPoolRetryBudget({
        executionDeadlineEpochMs: 189_999,
        nowEpochMs: 100_000,
      }),
    ).toBe(false);
    expect(
      hasHostedPoolRetryBudget({
        executionDeadlineEpochMs: 190_000,
        nowEpochMs: 100_000,
      }),
    ).toBe(true);
  });

  it.each([401, 429] as const)(
    "runs one real backup transport after a definite pre-effect %s grant response",
    async (status) => {
      let oidcCalls = 0;
      let grantCalls = 0;
      const attempts: number[] = [];
      const reasons: string[] = [];
      const fetchImpl = vi.fn(async (url: string | URL) => {
        if (String(url).startsWith(oidcUrl)) {
          oidcCalls += 1;
          return Response.json({ value: `oidc-${oidcCalls}` });
        }
        grantCalls += 1;
        if (grantCalls === 1) return new Response("denied", { status });
        return Response.json(validGrant(grantCalls));
      }) as unknown as typeof fetch;

      await expect(
        runHostedPoolLeaseFailover({
          maxAttempts: 2,
          canRetry: () => true,
          onRetry: ({ reason }) => {
            reasons.push(reason);
          },
          runAttempt: async ({ attempt }) => {
            attempts.push(attempt);
            await runHostedCodexRelayTransport({
              env: freshOidcEnv(),
              fetchImpl,
              apiUrl,
              providerInstanceId: "provider-1",
              workflowSchemaVersion: 5,
              bindingId: "binding-1",
              bindingVersion: 7,
              maskSecret: vi.fn(),
              run: async () => undefined,
            });
            return "complete";
          },
        }),
      ).resolves.toBe("complete");

      expect(attempts).toEqual([1, 2]);
      expect(oidcCalls).toBe(2);
      expect(grantCalls).toBe(2);
      expect(reasons).toEqual([
        status === 401 ? "authentication_failed" : "quota_exhausted",
      ]);
    },
  );

  it.each([401, 429] as const)(
    "runs one real backup transport after a complete pre-effect %s relay response",
    async (status) => {
      let grantCalls = 0;
      let relayCalls = 0;
      const attempts: number[] = [];
      await expect(
        runHostedPoolLeaseFailover({
          maxAttempts: 2,
          canRetry: () => true,
          runAttempt: async ({ attempt }) => {
            attempts.push(attempt);
            await runHostedCodexRelayTransport({
              env: freshOidcEnv(),
              fetchImpl: vi.fn(async (url: string | URL) => {
                if (String(url).startsWith(oidcUrl)) {
                  return Response.json({ value: `oidc-${attempt}` });
                }
                if (String(url).endsWith("/hosted-relay/grant")) {
                  grantCalls += 1;
                  return Response.json(validGrant(grantCalls));
                }
                relayCalls += 1;
                return new Response("definite pre-effect rejection", {
                  status,
                });
              }) as unknown as typeof fetch,
              apiUrl,
              providerInstanceId: "provider-1",
              workflowSchemaVersion: 5,
              bindingId: "binding-1",
              bindingVersion: 7,
              maskSecret: vi.fn(),
              run: async ({ baseUrl }) => {
                if (attempt === 1) {
                  const response = await fetch(`${baseUrl}/responses`, {
                    method: "POST",
                    body: "{}",
                  });
                  await response.text();
                }
              },
            });
            return "complete";
          },
        }),
      ).resolves.toBe("complete");
      expect(attempts).toEqual([1, 2]);
      expect(grantCalls).toBe(2);
      expect(relayCalls).toBe(1);
    },
  );

  it("never grants again after a lost grant response", async () => {
    let grantCalls = 0;
    const attempts: number[] = [];
    await expect(
      runHostedPoolLeaseFailover({
        maxAttempts: 2,
        canRetry: () => true,
        runAttempt: async ({ attempt }) => {
          attempts.push(attempt);
          await runHostedCodexRelayTransport({
            env: freshOidcEnv(),
            fetchImpl: vi.fn(async (url: string | URL) => {
              if (String(url).startsWith(oidcUrl)) {
                return Response.json({ value: "oidc" });
              }
              grantCalls += 1;
              throw new TypeError("response_lost_after_persist");
            }) as unknown as typeof fetch,
            apiUrl,
            providerInstanceId: "provider-1",
            workflowSchemaVersion: 5,
            bindingId: "binding-1",
            bindingVersion: 7,
            maskSecret: vi.fn(),
            run: async () => undefined,
          });
        },
      }),
    ).rejects.toThrow("hosted_relay_grant_ambiguous");
    expect(attempts).toEqual([1]);
    expect(grantCalls).toBe(1);
  });

  it.each([
    ["completed 5xx", () => new Response("failed", { status: 500 })],
    [
      "truncated 200",
      () =>
        new Response('data: {"type":"response.completed"}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ],
  ] as const)(
    "does not run the outer loop again after a %s",
    async (_label, relayResponse) => {
      let grantCalls = 0;
      let relayCalls = 0;
      const attempts: number[] = [];
      await expect(
        runHostedPoolLeaseFailover({
          maxAttempts: 2,
          canRetry: () => true,
          runAttempt: async ({ attempt }) => {
            attempts.push(attempt);
            await runHostedCodexRelayTransport({
              env: freshOidcEnv(),
              fetchImpl: vi.fn(async (url: string | URL) => {
                if (String(url).startsWith(oidcUrl)) {
                  return Response.json({ value: "oidc" });
                }
                if (String(url).endsWith("/hosted-relay/grant")) {
                  grantCalls += 1;
                  return Response.json(validGrant(grantCalls));
                }
                relayCalls += 1;
                return relayResponse();
              }) as unknown as typeof fetch,
              apiUrl,
              providerInstanceId: "provider-1",
              workflowSchemaVersion: 5,
              bindingId: "binding-1",
              bindingVersion: 7,
              maskSecret: vi.fn(),
              run: async ({ baseUrl }) => {
                const response = await fetch(`${baseUrl}/responses`, {
                  method: "POST",
                  body: "{}",
                });
                await response.text();
                throw new Error("runtime_rejected_response");
              },
            });
          },
        }),
      ).rejects.toThrow("hosted_pool_effect_ambiguous");
      expect(attempts).toEqual([1]);
      expect(grantCalls).toBe(1);
      expect(relayCalls).toBe(1);
    },
  );

  it("allows at most one backup and never requests a third grant", async () => {
    const attempts: number[] = [];
    await expect(
      runHostedPoolLeaseFailover({
        maxAttempts: 2,
        canRetry: () => true,
        runAttempt: async ({ attempt }) => {
          attempts.push(attempt);
          throw new Error("hosted_relay_grant_failed:429");
        },
      }),
    ).rejects.toThrow("hosted_pool_capacity_exhausted");
    expect(attempts).toEqual([1, 2]);
  });

  it("rejects the former three-grant budget", async () => {
    await expect(
      runHostedPoolLeaseFailover({
        maxAttempts: 3,
        canRetry: () => true,
        runAttempt: async () => "unreachable",
      }),
    ).rejects.toThrow("hosted_pool_retry_budget_invalid");
  });

  it("does not acquire a backup after the execution budget closes", async () => {
    const attempts: number[] = [];
    await expect(
      runHostedPoolLeaseFailover({
        maxAttempts: 2,
        canRetry: () => false,
        runAttempt: async ({ attempt }) => {
          attempts.push(attempt);
          throw new Error("hosted_relay_grant_failed:401");
        },
      }),
    ).rejects.toThrow("hosted_pool_capacity_exhausted");
    expect(attempts).toEqual([1]);
  });
});

function freshOidcEnv(): NodeJS.ProcessEnv {
  return {
    ACTIONS_ID_TOKEN_REQUEST_URL: oidcUrl,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-request-token",
  };
}

function validGrant(ordinal: number): Record<string, unknown> {
  return {
    protocolVersion: 1,
    grant: `opaque-grant-${ordinal}`,
    relayUrl: "https://relay.reviewrouter.test/v1/responses",
    invocationLeaseId: `lease-${ordinal}`,
    runtimeConfigVersion: 1,
    runtimeEnv: {},
    repository: "octo/repo",
    commentToken: `comment-token-${ordinal}`,
    commentTokenRefreshCapability: `refresh-capability-${ordinal}`,
    grantExpiresAt: "2026-08-22T18:00:00.000Z",
    policy: { maxRequests: 2 },
  };
}
