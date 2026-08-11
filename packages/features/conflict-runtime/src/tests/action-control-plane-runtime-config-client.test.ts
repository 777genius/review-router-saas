import { describe, expect, it } from "vitest";
import { ActionControlPlaneRuntimeConfigClient } from "../infrastructure/action-control-plane-runtime-config-client.js";

type FetchCall = {
  readonly url: string;
  readonly method?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly body?: unknown;
  readonly redirect?: "error" | undefined;
};

const conflictDispatchPayload = {
  protocol_version: 1,
  dispatch_event_type: "reviewrouter_conflict_review",
  dispatch_id: "cr_123e4567-e89b-12d3-a456-426614174000",
  nonce: "n".repeat(40),
  repository_id: "123456",
  pr_number: 7,
  head_sha: "a".repeat(40),
  base_ref: "main",
  base_sha: "b".repeat(40),
  fallback_version: 1,
};

describe("ActionControlPlaneRuntimeConfigClient", () => {
  it("exchanges conflict OIDC and fetches conflict runtime config with fixed endpoints", async () => {
    const calls: FetchCall[] = [];
    const client = new ActionControlPlaneRuntimeConfigClient({
      apiUrl: "https://reviewrouter.example",
      actionVersion: "v1.2.3",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          method: init.method,
          headers: init.headers,
          body: init.body ? JSON.parse(init.body) : undefined,
          redirect: init.redirect,
        });
        if (String(url).endsWith("/session/exchange")) {
          return jsonResponse({
            protocolVersion: 1,
            sessionToken: "action-session-token",
            expiresAt: "2026-05-14T12:15:00.000Z",
            repository: "777genius/example",
          });
        }
        return jsonResponse(runtimeConfigResponse());
      },
    });

    const session = await client.exchangeConflictSession({
      oidcToken: "github-oidc-token",
      conflictDispatchPayload,
    });
    const config = await client.fetchConflictRuntimeConfig({
      sessionToken: session.sessionToken,
    });

    expect(session).toEqual({
      sessionToken: "action-session-token",
      expiresAt: "2026-05-14T12:15:00.000Z",
      repository: "777genius/example",
    });
    expect(config.conflictReview.reviewKind).toBe("conflict-head");
    expect(calls.map((call) => call.url)).toEqual([
      "https://reviewrouter.example/api/action/v1/session/exchange",
      "https://reviewrouter.example/api/action/v1/config",
    ]);
    expect(calls[0]).toMatchObject({
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-reviewrouter-action-version": "v1.2.3",
      },
      body: {
        oidcToken: "github-oidc-token",
        conflictDispatch: {
          protocolVersion: 1,
          dispatchEventType: "reviewrouter_conflict_review",
          dispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
          repositoryId: "123456",
          pullRequestNumber: 7,
        },
      },
      redirect: "error",
    });
    expect(calls[0]?.body).not.toHaveProperty("audience");
    expect(calls[1]).toMatchObject({
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: "Bearer action-session-token",
        "x-reviewrouter-action-version": "v1.2.3",
      },
      redirect: "error",
    });
    expect(JSON.stringify(calls)).not.toMatch(/postingSessionToken|ghs_/i);
  });

  it("rejects untrusted API URLs before sending OIDC or session tokens", () => {
    let fetchCalls = 0;
    expect(
      () =>
        new ActionControlPlaneRuntimeConfigClient({
          apiUrl: "http://reviewrouter.example",
          fetch: async () => {
            fetchCalls += 1;
            return jsonResponse({});
          },
        }),
    ).toThrow("conflict_runtime_action_api_url_invalid");
    expect(
      () =>
        new ActionControlPlaneRuntimeConfigClient({
          apiUrl: "https://token@example.test",
          fetch: async () => {
            fetchCalls += 1;
            return jsonResponse({});
          },
        }),
    ).toThrow("conflict_runtime_action_api_url_invalid");
    expect(
      () =>
        new ActionControlPlaneRuntimeConfigClient({
          apiUrl: "https://reviewrouter.example?target=evil",
          fetch: async () => {
            fetchCalls += 1;
            return jsonResponse({});
          },
        }),
    ).toThrow("conflict_runtime_action_api_url_invalid");
    expect(
      () =>
        new ActionControlPlaneRuntimeConfigClient({
          apiUrl: "https://reviewrouter.example/base-path",
          fetch: async () => {
            fetchCalls += 1;
            return jsonResponse({});
          },
        }),
    ).toThrow("conflict_runtime_action_api_url_invalid");
    expect(
      () =>
        new ActionControlPlaneRuntimeConfigClient({
          apiUrl: "http://localhost:4000",
          fetch: async () => {
            fetchCalls += 1;
            return jsonResponse({});
          },
        }),
    ).not.toThrow();
    expect(
      () =>
        new ActionControlPlaneRuntimeConfigClient({
          apiUrl: "http://[::1]:4000",
          fetch: async () => {
            fetchCalls += 1;
            return jsonResponse({});
          },
        }),
    ).not.toThrow();
    expect(
      () =>
        new ActionControlPlaneRuntimeConfigClient({
          apiUrl: "http://127.0.0.1:4000",
          fetch: async () => {
            fetchCalls += 1;
            return jsonResponse({});
          },
        }),
    ).not.toThrow();
    expect(
      () =>
        new ActionControlPlaneRuntimeConfigClient({
          apiUrl: "http://local.reviewrouter.localhost:4000",
          fetch: async () => {
            fetchCalls += 1;
            return jsonResponse({});
          },
        }),
    ).not.toThrow();
    expect(fetchCalls).toBe(0);
  });

  it("fails closed when config is not conflict-capable or action API rejects", async () => {
    const missingConflictConfigClient =
      new ActionControlPlaneRuntimeConfigClient({
        apiUrl: "https://reviewrouter.example",
        fetch: async () =>
          jsonResponse({
            ...runtimeConfigResponse(),
            conflictReview: undefined,
          }),
      });

    await expect(
      missingConflictConfigClient.fetchConflictRuntimeConfig({
        sessionToken: "action-session-token",
      }),
    ).rejects.toThrow("conflict_runtime_config_missing");

    const rejectedClient = new ActionControlPlaneRuntimeConfigClient({
      apiUrl: "https://reviewrouter.example",
      fetch: async () =>
        jsonResponse(
          {
            error: {
              code: "conflict_review_runtime_disabled",
              message: "redacted",
              retryable: true,
            },
          },
          503,
        ),
    });

    await expect(
      rejectedClient.exchangeConflictSession({
        oidcToken: "github-oidc-token",
        conflictDispatchPayload,
      }),
    ).rejects.toThrow(
      "conflict_runtime_action_http_error:conflict_review_runtime_disabled:503",
    );

    const unsafeErrorClient = new ActionControlPlaneRuntimeConfigClient({
      apiUrl: "https://reviewrouter.example",
      fetch: async () =>
        jsonResponse(
          {
            error: {
              code: "nonce:raw-dispatch-secret",
              message: "redacted",
              retryable: false,
            },
          },
          500,
        ),
    });

    await expect(
      unsafeErrorClient.fetchConflictRuntimeConfig({
        sessionToken: "action-session-token",
      }),
    ).rejects.toThrow(
      "conflict_runtime_action_http_error:unknown_action_error:500",
    );
  });
});

function runtimeConfigResponse() {
  const provider = {
    kind: "codex",
    authMode: "codex_subscription_oauth",
    model: "gpt-5.5",
    reasoningEffort: "medium",
    agenticContext: true,
    fastMode: false,
    secretBackedProviderEnabled: true,
  };
  return {
    protocolVersion: 1,
    configVersion: 7,
    provider,
    providers: [provider],
    execution: {
      providerLimit: 1,
      providerMaxParallel: 1,
      inlineMinAgreement: 1,
    },
    blockingPolicy: { failOnSeverity: "major" },
    limits: {
      inlineMaxComments: 0,
      targetTokensPerBatch: 20_000,
    },
    runtimeEnv: {
      REVIEW_ROUTER_REVIEW_KIND: "conflict-head",
    },
    conflictReview: {
      protocolVersion: 1,
      reviewKind: "conflict-head",
      dispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
      pullRequestNumber: 7,
      headSha: "a".repeat(40),
      baseRef: "main",
      baseSha: "b".repeat(40),
      checkout: {
        mode: "exact_head_sha",
        headSha: "a".repeat(40),
        baseRef: "main",
        baseSha: "b".repeat(40),
        persistCredentials: false,
      },
      diff: {
        mode: "expected_base_to_head",
        baseSha: "b".repeat(40),
        headSha: "a".repeat(40),
        maxFiles: 100,
        maxBytes: 256 * 1024,
        maxPatchBytesPerFile: 48 * 1024,
      },
      posting: {
        mode: "proxy",
        sessionEndpoint: "/api/action/v1/conflict-posting/session",
        summaryEndpoint: "/api/action/v1/conflict-posting/summary",
        statusEndpoint: "/api/action/v1/conflict-posting/status",
        allowedOperations: ["summary_comment", "advisory_status"],
        summaryMaxBytes: 60_000,
        statusContext: "ReviewRouter conflict review",
      },
    },
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}
