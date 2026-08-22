import { request as httpRequest } from "node:http";

type HostedPoolFailureReason =
  | "quota_exhausted"
  | "authentication_failed"
  | undefined;

type HostedPoolFailoverInput<T> = {
  maxAttempts?: number;
  canRetry: () => boolean;
  runAttempt: (input: { attempt: number; maxAttempts: number }) => Promise<T>;
  onRetry?: (input: {
    attempt: number;
    maxAttempts: number;
    reason: Exclude<HostedPoolFailureReason, undefined>;
  }) => void | Promise<void>;
};

type HostedTransportInput = {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  apiUrl: string;
  providerInstanceId: string;
  workflowSchemaVersion: number;
  bindingId: string;
  bindingVersion: number;
  maskSecret: (secret: string) => void;
  run: (input: { baseUrl: string }) => Promise<void>;
};

type HostedProxy = {
  baseUrl: string;
  failoverReason: () =>
    | "quota_exhausted"
    | "authentication_failed"
    | "ambiguous"
    | undefined;
  close: () => Promise<void>;
};

const actionBundle = jest.requireActual("../../../action-dist/index.cjs") as {
  hostedPoolAccountFailureReason(error: unknown): HostedPoolFailureReason;
  requestHostedRelayGrantWithFreshGitHubOidc(
    input: Omit<HostedTransportInput, "run">,
  ): Promise<unknown>;
  runHostedCodexRelayTransport(input: HostedTransportInput): Promise<void>;
  runHostedPoolLeaseFailover<T>(input: HostedPoolFailoverInput<T>): Promise<T>;
  startHostedCodexRelayProxy(input: {
    fetchImpl: typeof fetch;
    relayUrl: string;
    upstreamCommentTokenRefreshUrl: string;
    grant: string;
    commentTokenRefreshCapability: string;
    invocationLeaseId: string;
    bindingId: string;
    bindingVersion: number;
    policy: { maxRequests: number };
  }): Promise<HostedProxy>;
};

const oidcUrl = "https://vstoken.actions.githubusercontent.com/oidc/token";
const apiUrl = "https://reviewrouter.test";

describe("hosted pool replay-fenced failover artifact", () => {
  it.each([
    ["hosted_pool_quota_exhausted", "quota_exhausted"],
    ["hosted_relay_grant_failed:429", "quota_exhausted"],
    ["hosted_pool_authentication_failed", "authentication_failed"],
    ["hosted_relay_grant_failed:401", "authentication_failed"],
  ] as const)(
    "classifies definite pre-effect %s as %s",
    (message, expected) => {
      expect(
        actionBundle.hostedPoolAccountFailureReason(new Error(message)),
      ).toBe(expected);
    },
  );

  it.each([
    "quota_limited",
    "authentication_failed",
    "hosted_pool_account_failed",
    "review_runtime_timeout",
    "hosted_relay_grant_failed:403",
    "hosted_relay_grant_ambiguous",
    "hosted_pool_effect_ambiguous",
  ])("does not rotate for non-proven %s", (message) => {
    expect(
      actionBundle.hostedPoolAccountFailureReason(new Error(message)),
    ).toBeUndefined();
  });

  it.each([401, 429] as const)(
    "uses one real backup after a complete pre-effect %s relay response",
    async (status) => {
      let grantCalls = 0;
      let relayCalls = 0;
      const attempts: number[] = [];
      await expect(
        actionBundle.runHostedPoolLeaseFailover({
          maxAttempts: 2,
          canRetry: () => true,
          runAttempt: async ({ attempt }) => {
            attempts.push(attempt);
            await actionBundle.runHostedCodexRelayTransport({
              env: freshOidcEnv(),
              apiUrl,
              providerInstanceId: "provider-1",
              workflowSchemaVersion: 5,
              bindingId: "binding-1",
              bindingVersion: 7,
              maskSecret: jest.fn(),
              fetchImpl: jest.fn(async (url: string | URL) => {
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
              }) as typeof fetch,
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

  it("never re-POSTs or enters the outer loop after a lost grant response", async () => {
    let grantCalls = 0;
    const attempts: number[] = [];
    await expect(
      actionBundle.runHostedPoolLeaseFailover({
        maxAttempts: 2,
        canRetry: () => true,
        runAttempt: async ({ attempt }) => {
          attempts.push(attempt);
          await actionBundle.runHostedCodexRelayTransport({
            env: freshOidcEnv(),
            apiUrl,
            providerInstanceId: "provider-1",
            workflowSchemaVersion: 5,
            bindingId: "binding-1",
            bindingVersion: 7,
            maskSecret: jest.fn(),
            run: async () => undefined,
            fetchImpl: jest.fn(async (url: string | URL) => {
              if (String(url).startsWith(oidcUrl)) {
                return Response.json({ value: "oidc" });
              }
              grantCalls += 1;
              throw new TypeError("response_lost_after_persist");
            }) as typeof fetch,
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
    "keeps the outer-loop fence after a %s",
    async (_label, response) => {
      let grantCalls = 0;
      let relayCalls = 0;
      const attempts: number[] = [];
      await expect(
        actionBundle.runHostedPoolLeaseFailover({
          maxAttempts: 2,
          canRetry: () => true,
          runAttempt: async ({ attempt }) => {
            attempts.push(attempt);
            await actionBundle.runHostedCodexRelayTransport({
              env: freshOidcEnv(),
              apiUrl,
              providerInstanceId: "provider-1",
              workflowSchemaVersion: 5,
              bindingId: "binding-1",
              bindingVersion: 7,
              maskSecret: jest.fn(),
              fetchImpl: jest.fn(async (url: string | URL) => {
                if (String(url).startsWith(oidcUrl)) {
                  return Response.json({ value: "oidc" });
                }
                if (String(url).endsWith("/hosted-relay/grant")) {
                  grantCalls += 1;
                  return Response.json(validGrant(grantCalls));
                }
                relayCalls += 1;
                return response();
              }) as typeof fetch,
              run: async ({ baseUrl }) => {
                const result = await fetch(`${baseUrl}/responses`, {
                  method: "POST",
                  body: "{}",
                });
                await result.text();
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

  it("sets the replay fence before a slow body can race another mutation", async () => {
    let relayCalls = 0;
    const proxy = await actionBundle.startHostedCodexRelayProxy({
      grant: "grant",
      commentTokenRefreshCapability: "refresh",
      invocationLeaseId: "lease",
      bindingId: "binding",
      bindingVersion: 1,
      relayUrl: "https://relay.reviewrouter.test/v1/responses",
      upstreamCommentTokenRefreshUrl:
        "https://relay.reviewrouter.test/v1/comment-token",
      policy: { maxRequests: 2 },
      fetchImpl: jest.fn(async () => {
        relayCalls += 1;
        return new Response("data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch,
    });
    try {
      const slow = httpRequest(`${proxy.baseUrl}/responses`, {
        method: "POST",
      });
      slow.write('{"input":"');
      await new Promise<void>((resolve) => setImmediate(resolve));
      const concurrent = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        body: "{}",
      });
      expect(concurrent.status).toBe(409);
      expect(relayCalls).toBe(0);
      const finished = new Promise<void>((resolve, reject) => {
        slow.once("response", (response) => {
          response.resume();
          response.once("end", resolve);
        });
        slow.once("error", reject);
      });
      slow.end('review"}');
      await finished;
      expect(relayCalls).toBe(1);
    } finally {
      await proxy.close();
    }
  });

  it("allows no third grant and rejects the former three-attempt budget", async () => {
    const attempts: number[] = [];
    await expect(
      actionBundle.runHostedPoolLeaseFailover({
        maxAttempts: 2,
        canRetry: () => true,
        runAttempt: async ({ attempt }) => {
          attempts.push(attempt);
          throw new Error("hosted_relay_grant_failed:429");
        },
      }),
    ).rejects.toThrow("hosted_pool_capacity_exhausted");
    expect(attempts).toEqual([1, 2]);
    await expect(
      actionBundle.runHostedPoolLeaseFailover({
        maxAttempts: 3,
        canRetry: () => true,
        runAttempt: async () => undefined,
      }),
    ).rejects.toThrow("hosted_pool_retry_budget_invalid");
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
    grant: `grant-${ordinal}`,
    relayUrl: "https://relay.reviewrouter.test/v1/responses",
    invocationLeaseId: `lease-${ordinal}`,
    runtimeConfigVersion: 1,
    runtimeEnv: {},
    repository: "octo/repo",
    commentToken: `comment-${ordinal}`,
    commentTokenRefreshCapability: `refresh-${ordinal}`,
    grantExpiresAt: "2026-08-22T18:00:00.000Z",
    policy: { maxRequests: 2 },
  };
}
