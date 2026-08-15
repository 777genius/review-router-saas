import { describe, expect, it, vi } from "vitest";
import {
  buildHostedRelayHeaders,
  requestHostedRelayGrantWithFreshGitHubOidc,
  runHostedCodexRelayTransport,
  startHostedCodexRelayProxy,
} from "../action/hosted-codex-relay";

describe("hosted Codex relay transport", () => {
  it("exchanges fresh OIDC without requiring auth JSON and masks both bearer values", async () => {
    const env: NodeJS.ProcessEnv = {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.test/oidc",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-request-token",
      INPUT_AUTH_JSON: "must-not-be-read",
      REVIEWROUTER_CODEX_AUTH_JSON: "must-not-be-read-either",
    };
    const masks: string[] = [];
    const calls: Array<{ url: string; body?: string }> = [];
    let runtimeBaseUrl = "";
    await runHostedCodexRelayTransport({
      env,
      apiUrl: "https://reviewrouter.test/",
      providerInstanceId: "provider-1",
      workflowSchemaVersion: 5,
      bindingId: "binding-1",
      bindingVersion: 7,
      maskSecret: (secret) => masks.push(secret),
      fetchImpl: vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          ...(init?.body ? { body: String(init.body) } : {}),
        });
        if (String(url).startsWith("https://github.test/oidc")) {
          return Response.json({ value: "fresh-oidc-token" });
        }
        return Response.json({
          protocolVersion: 1,
          grant: "opaque-relay-grant",
          relayUrl: "https://relay.reviewrouter.test/v1/responses",
          invocationLeaseId: "invocation-lease-1",
          runtimeConfigVersion: 11,
          runtimeEnv: { REVIEW_PROVIDERS: "codex/gpt-5.5" },
          repository: "octo/repo",
          commentToken: "github-comment-token",
          commentTokenRefreshCapability: "comment-refresh-capability",
          grantExpiresAt: "2026-08-15T19:00:00.000Z",
          commentTokenExpiresAt: "2026-08-15T18:00:00.000Z",
          policy: { maxRequests: 3 },
        });
      }) as unknown as typeof fetch,
      run: async ({
        baseUrl,
        policy,
        runtimeConfigVersion,
        grantExpiresAt,
        commentTokenExpiresAt,
      }) => {
        runtimeBaseUrl = baseUrl;
        expect(policy.maxRequests).toBe(3);
        expect(runtimeConfigVersion).toBe(11);
        expect(typeof runtimeConfigVersion).toBe("number");
        expect(grantExpiresAt).toBe("2026-08-15T19:00:00.000Z");
        expect(commentTokenExpiresAt).toBe("2026-08-15T18:00:00.000Z");
        expect(env).not.toHaveProperty("INPUT_AUTH_JSON");
        expect(env).not.toHaveProperty("REVIEWROUTER_CODEX_AUTH_JSON");
        expect(Object.values(env)).not.toContain("opaque-relay-grant");
      },
    });

    expect(runtimeBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/.+\/v1$/);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("audience=reviewrouter");
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      oidcToken: "fresh-oidc-token",
      providerInstanceId: "provider-1",
      workflowSchemaVersion: 5,
      bindingId: "binding-1",
      bindingVersion: 7,
    });
    expect(calls[1]?.body).not.toContain("must-not-be-read");
    expect(masks).toEqual([
      "fresh-oidc-token",
      "opaque-relay-grant",
      "comment-refresh-capability",
      "github-comment-token",
    ]);
    expect(env).not.toHaveProperty("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  });

  it("retries a lost persisted-grant response with a fresh OIDC token", async () => {
    const env: NodeJS.ProcessEnv = {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.test/oidc",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-request-token",
    };
    const oidcTokens = ["fresh-oidc-1", "fresh-oidc-2"];
    const grantBodies: Array<Record<string, unknown>> = [];
    const masks: string[] = [];
    const delays: number[] = [];
    let oidcCalls = 0;
    let grantCalls = 0;
    const grant = {
      protocolVersion: 1,
      grant: "same-outcome-safe-grant",
      relayUrl:
        "https://reviewrouter.test/api/action/v1/hosted-codex/responses",
      invocationLeaseId: "same-invocation-lease",
      runtimeConfigVersion: 12,
      runtimeEnv: { REVIEW_PROVIDERS: "codex/gpt-5.5" },
      repository: "octo/repo",
      commentToken: "same-comment-token",
      commentTokenRefreshCapability: "same-refresh-capability",
      grantExpiresAt: "2026-08-15T19:00:00.000Z",
      policy: { maxRequests: 3 },
    };

    const result = await requestHostedRelayGrantWithFreshGitHubOidc({
      env,
      apiUrl: "https://reviewrouter.test",
      providerInstanceId: "provider-1",
      workflowSchemaVersion: 5,
      bindingId: "binding-1",
      bindingVersion: 7,
      maskSecret: (secret) => masks.push(secret),
      retryDelay: async (ms) => {
        delays.push(ms);
      },
      fetchImpl: vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).startsWith("https://github.test/oidc")) {
          const value = oidcTokens[oidcCalls++];
          return Response.json({ value });
        }
        grantCalls += 1;
        grantBodies.push(JSON.parse(String(init?.body)));
        if (grantCalls === 1) {
          throw new TypeError("response_lost_after_persist");
        }
        return Response.json(grant);
      }) as unknown as typeof fetch,
    });

    expect(result).toEqual(grant);
    expect(oidcCalls).toBe(2);
    expect(grantCalls).toBe(2);
    expect(grantBodies.map((body) => body.oidcToken)).toEqual(oidcTokens);
    expect(grantBodies[0]).toMatchObject({
      bindingId: "binding-1",
      bindingVersion: 7,
    });
    expect(grantBodies[1]).toMatchObject({
      bindingId: "binding-1",
      bindingVersion: 7,
    });
    expect(delays).toEqual([250]);
    expect(masks).toEqual([
      "fresh-oidc-1",
      "fresh-oidc-2",
      "same-outcome-safe-grant",
      "same-refresh-capability",
      "same-comment-token",
    ]);
    expect(env).not.toHaveProperty("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  });

  it("does not retry authority failures from the grant endpoint", async () => {
    let oidcCalls = 0;
    let grantCalls = 0;
    const delays: number[] = [];
    await expect(
      requestHostedRelayGrantWithFreshGitHubOidc({
        env: {
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.test/oidc",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-request-token",
        },
        apiUrl: "https://reviewrouter.test",
        providerInstanceId: "provider-1",
        workflowSchemaVersion: 5,
        bindingId: "binding-1",
        bindingVersion: 7,
        maskSecret: vi.fn(),
        retryDelay: async (ms) => {
          delays.push(ms);
        },
        fetchImpl: vi.fn(async (url: string | URL) => {
          if (String(url).startsWith("https://github.test/oidc")) {
            oidcCalls += 1;
            return Response.json({ value: "fresh-oidc" });
          }
          grantCalls += 1;
          return Response.json({ error: "binding_forbidden" }, { status: 403 });
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("hosted_relay_grant_failed:403");
    expect(oidcCalls).toBe(1);
    expect(grantCalls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("strips caller credentials and forwards only content, stream, and request identity semantics", () => {
    const headers = buildHostedRelayHeaders({
      requestHeaders: {
        accept: "text/event-stream",
        "content-type": "application/json",
        authorization: "Bearer caller-token",
        "chatgpt-account-id": "account-123",
        "openai-organization": "org-123",
        "openai-project": "project-123",
        "x-codex-beta-features": "dangerous",
        "x-client-request-id": "client-request-1",
        "x-request-id": "request-1",
        traceparent: "00-trace-parent",
        cookie: "secret-cookie",
        "content-length": "999999",
      },
      grant: "opaque-grant",
      requestOrdinal: 2,
      idempotencyKey: "proxy:2",
      requestBytes: 17,
    });

    expect(headers).toEqual({
      authorization: "Bearer opaque-grant",
      accept: "text/event-stream",
      "content-type": "application/json",
      "content-length": "17",
      "idempotency-key": "proxy:2",
      "x-reviewrouter-request-ordinal": "2",
      "x-client-request-id": "client-request-1",
      "x-request-id": "request-1",
      traceparent: "00-trace-parent",
    });
    expect(JSON.stringify(headers)).not.toContain("caller-token");
    expect(JSON.stringify(headers)).not.toContain("account-123");
    expect(JSON.stringify(headers)).not.toContain("org-123");
    expect(JSON.stringify(headers)).not.toContain("project-123");
    expect(JSON.stringify(headers)).not.toContain("dangerous");
  });

  it("streams SSE, assigns stable per-request ordinals, and enforces the grant budget", async () => {
    const observed: Array<{
      authorization: string | null;
      ordinal: string | null;
      idempotencyKey: string | null;
      accountId: string | null;
      codexHeader: string | null;
      contentLength: string | null;
      body: string;
    }> = [];
    const proxy = await startHostedCodexRelayProxy({
      grant: "opaque-relay-grant",
      commentTokenRefreshCapability: "comment-refresh-capability",
      invocationLeaseId: "invocation-lease-1",
      bindingId: "binding-1",
      bindingVersion: 7,
      relayUrl: "https://relay.reviewrouter.test/v1/responses",
      upstreamCommentTokenRefreshUrl:
        "https://relay.reviewrouter.test/v1/comment-token",
      policy: { maxRequests: 2 },
      fetchImpl: vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        observed.push({
          authorization: headers.get("authorization"),
          ordinal: headers.get("x-reviewrouter-request-ordinal"),
          idempotencyKey: headers.get("idempotency-key"),
          accountId: headers.get("chatgpt-account-id"),
          codexHeader: headers.get("x-codex-beta-features"),
          contentLength: headers.get("content-length"),
          body:
            init?.body instanceof Uint8Array
              ? Buffer.from(init.body).toString("utf8")
              : String(init?.body ?? ""),
        });
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("data: first\n\n"));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }) as unknown as typeof fetch,
    });
    try {
      for (const ordinal of [1, 2]) {
        const response = await fetch(`${proxy.baseUrl}/responses`, {
          method: "POST",
          headers: {
            authorization: "Bearer caller-secret",
            "chatgpt-account-id": "caller-account",
            "x-codex-beta-features": "caller-capability",
          },
          body: "{}",
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain(
          "text/event-stream",
        );
        expect(await response.text()).toBe("data: first\n\ndata: [DONE]\n\n");
        expect(observed.at(-1)?.ordinal).toBe(String(ordinal));
      }
      expect(observed[0]?.idempotencyKey).toMatch(/:1$/);
      expect(observed[1]?.idempotencyKey).toMatch(/:2$/);
      expect(observed.map((value) => value.authorization)).toEqual([
        "Bearer opaque-relay-grant",
        "Bearer opaque-relay-grant",
      ]);
      expect(observed.map((value) => value.accountId)).toEqual([null, null]);
      expect(observed.map((value) => value.codexHeader)).toEqual([null, null]);
      expect(observed.map((value) => value.contentLength)).toEqual(["2", "2"]);
      expect(observed.map((value) => value.body)).toEqual(["{}", "{}"]);
      expect(JSON.stringify(observed)).not.toContain("caller-secret");
      expect(JSON.stringify(observed)).not.toContain("caller-account");

      const exceeded = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        body: "{}",
      });
      expect(exceeded.status).toBe(429);
      await expect(exceeded.json()).resolves.toEqual({
        error: "proxy_request_budget_exceeded",
      });
      expect(observed).toHaveLength(2);
    } finally {
      await proxy.close();
    }
  });

  it("aborts an in-flight relay request when the parent proxy closes", async () => {
    let observedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const proxy = await startHostedCodexRelayProxy({
      grant: "opaque-relay-grant",
      commentTokenRefreshCapability: "comment-refresh-capability",
      invocationLeaseId: "invocation-lease-1",
      bindingId: "binding-1",
      bindingVersion: 7,
      relayUrl: "https://relay.reviewrouter.test/v1/responses",
      upstreamCommentTokenRefreshUrl:
        "https://relay.reviewrouter.test/v1/comment-token",
      policy: { maxRequests: 2 },
      fetchImpl: vi.fn(
        async (_url: string | URL, init?: RequestInit): Promise<Response> => {
          observedSignal = init?.signal ?? undefined;
          markStarted?.();
          return new Promise((_resolve, reject) => {
            observedSignal?.addEventListener(
              "abort",
              () => reject(new Error("relay_aborted")),
              { once: true },
            );
          });
        },
      ) as unknown as typeof fetch,
    });
    const downstream = fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      body: "{}",
    }).catch(() => undefined);
    await started;
    await proxy.close();
    await downstream;
    expect(observedSignal?.aborted).toBe(true);
  });

  it("refreshes GitHub comment tokens through a separate narrow capability", async () => {
    let observedAuthorization = "";
    let observedBody = "";
    let observedContentLength = "";
    let observedIdempotencyKey = "";
    let observedOrdinal = "";
    const proxy = await startHostedCodexRelayProxy({
      grant: "responses-only-grant",
      commentTokenRefreshCapability: "comment-refresh-capability",
      invocationLeaseId: "invocation-lease-1",
      bindingId: "binding-1",
      bindingVersion: 7,
      relayUrl:
        "https://reviewrouter.test/api/action/v1/hosted-codex/responses",
      upstreamCommentTokenRefreshUrl:
        "https://reviewrouter.test/api/action/v1/hosted-relay/comment-token",
      policy: { maxRequests: 2 },
      fetchImpl: vi.fn(async (_url: string | URL, init?: RequestInit) => {
        observedAuthorization =
          new Headers(init?.headers).get("authorization") ?? "";
        const headers = new Headers(init?.headers);
        observedContentLength = headers.get("content-length") ?? "";
        observedIdempotencyKey = headers.get("idempotency-key") ?? "";
        observedOrdinal = headers.get("x-reviewrouter-request-ordinal") ?? "";
        observedBody =
          init?.body instanceof Uint8Array
            ? Buffer.from(init.body).toString("utf8")
            : String(init?.body ?? "");
        return Response.json({
          token: "refreshed-github-token",
          repository: "octo/repo",
        });
      }) as unknown as typeof fetch,
    });
    try {
      const untrustedBody = JSON.stringify({ untrusted: "ignored" });
      const response = await fetch(proxy.commentTokenRefreshUrl, {
        method: "POST",
        headers: {
          "content-length": String(Buffer.byteLength(untrustedBody)),
          "idempotency-key": "client-controlled-key",
          "x-reviewrouter-request-ordinal": "999",
        },
        body: untrustedBody,
      });
      await expect(response.json()).resolves.toMatchObject({
        token: "refreshed-github-token",
      });
      expect(observedAuthorization).toBe("Bearer comment-refresh-capability");
      expect(JSON.parse(observedBody)).toEqual({
        invocationLeaseId: "invocation-lease-1",
        bindingId: "binding-1",
        bindingVersion: 7,
      });
      expect(observedContentLength).toBe(
        String(Buffer.byteLength(observedBody)),
      );
      expect(observedIdempotencyKey).toMatch(/:1$/);
      expect(observedIdempotencyKey).not.toBe("client-controlled-key");
      expect(observedOrdinal).toBe("1");
      expect(`${observedAuthorization}\n${observedBody}`).not.toContain(
        "responses-only-grant",
      );
    } finally {
      await proxy.close();
    }
  });
});
