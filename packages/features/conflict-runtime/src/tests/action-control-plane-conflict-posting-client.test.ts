import { describe, expect, it } from "vitest";
import type { ActionConflictReviewRuntimeConfig } from "@reviewrouter/features-action-control-plane";
import { ActionControlPlaneConflictPostingClient } from "../infrastructure/action-control-plane-conflict-posting-client.js";

const runtimeConfig: ActionConflictReviewRuntimeConfig = {
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
    maxFiles: 10,
    maxBytes: 20_000,
    maxPatchBytesPerFile: 10_000,
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
};

type FetchCall = {
  readonly url: string;
  readonly method?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly body?: unknown;
  readonly redirect?: "error" | undefined;
};

describe("ActionControlPlaneConflictPostingClient", () => {
  it("uses fixed conflict posting endpoints and scoped bearer tokens", async () => {
    const calls: FetchCall[] = [];
    const client = new ActionControlPlaneConflictPostingClient({
      apiUrl: "https://reviewrouter.example",
      actionSessionToken: "action-session-token",
      config: runtimeConfig,
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method,
          headers: init?.headers,
          body: init?.body ? JSON.parse(init.body) : undefined,
          redirect: init?.redirect,
        });
        if (String(url).endsWith("/session")) {
          return jsonResponse({
            protocolVersion: 1,
            postingSessionToken: "posting-session-token",
            expiresAt: "2026-05-14T12:05:00.000Z",
            manifestHash: "c".repeat(64),
            scope: {
              dispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
              pullRequestNumber: 7,
              headSha: "a".repeat(40),
              baseRef: "main",
              baseSha: "b".repeat(40),
              allowedOperations: ["summary_comment", "advisory_status"],
            },
          });
        }
        return jsonResponse({
          protocolVersion: 1,
          status: "posted",
          githubExternalId: "github_1",
          githubUrl: null,
        });
      },
    });

    const postingSession = await client.requestPostingSession({
      manifestHash: "c".repeat(64),
    });
    await client.postSummary({
      postingSessionToken: postingSession.postingSessionToken,
      summaryMarkdown: "Safe advisory summary.",
    });
    await client.postStatus({
      postingSessionToken: postingSession.postingSessionToken,
      state: "success",
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://reviewrouter.example/api/action/v1/conflict-posting/session",
      "https://reviewrouter.example/api/action/v1/conflict-posting/summary",
      "https://reviewrouter.example/api/action/v1/conflict-posting/status",
    ]);
    expect(calls[0]).toMatchObject({
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: "Bearer action-session-token",
        "content-type": "application/json",
      },
      body: { protocolVersion: 1, manifestHash: "c".repeat(64) },
      redirect: "error",
    });
    expect(calls[1]).toMatchObject({
      headers: {
        accept: "application/json",
        authorization: "Bearer posting-session-token",
      },
      body: {
        protocolVersion: 1,
        summaryMarkdown: "Safe advisory summary.",
      },
      redirect: "error",
    });
    expect(calls[2]).toMatchObject({
      headers: {
        accept: "application/json",
        authorization: "Bearer posting-session-token",
      },
      body: { protocolVersion: 1, state: "success" },
      redirect: "error",
    });
    expect(JSON.stringify(calls)).not.toMatch(/targetSha|context|commentId/i);
  });

  it("fails closed on untrusted API URLs and mismatched posting session scopes", async () => {
    expect(
      () =>
        new ActionControlPlaneConflictPostingClient({
          apiUrl: "http://reviewrouter.example",
          actionSessionToken: "action-session-token",
          config: runtimeConfig,
        }),
    ).toThrow("conflict_runtime_posting_api_url_invalid");
    expect(
      () =>
        new ActionControlPlaneConflictPostingClient({
          apiUrl: "https://token@example.test",
          actionSessionToken: "action-session-token",
          config: runtimeConfig,
        }),
    ).toThrow("conflict_runtime_posting_api_url_invalid");
    expect(
      () =>
        new ActionControlPlaneConflictPostingClient({
          apiUrl: "https://reviewrouter.example/base-path",
          actionSessionToken: "action-session-token",
          config: runtimeConfig,
        }),
    ).toThrow("conflict_runtime_posting_api_url_invalid");
    expect(
      () =>
        new ActionControlPlaneConflictPostingClient({
          apiUrl: "http://localhost:4000",
          actionSessionToken: "action-session-token",
          config: runtimeConfig,
        }),
    ).not.toThrow();
    expect(
      () =>
        new ActionControlPlaneConflictPostingClient({
          apiUrl: "http://[::1]:4000",
          actionSessionToken: "action-session-token",
          config: runtimeConfig,
        }),
    ).not.toThrow();

    const client = new ActionControlPlaneConflictPostingClient({
      apiUrl: "https://reviewrouter.example",
      actionSessionToken: "action-session-token",
      config: runtimeConfig,
      fetch: async () =>
        jsonResponse({
          protocolVersion: 1,
          postingSessionToken: "posting-session-token",
          expiresAt: "2026-05-14T12:05:00.000Z",
          manifestHash: "c".repeat(64),
          scope: {
            dispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
            pullRequestNumber: 7,
            headSha: "d".repeat(40),
            baseRef: "main",
            baseSha: "b".repeat(40),
            allowedOperations: ["summary_comment", "advisory_status"],
          },
        }),
    });

    await expect(
      client.requestPostingSession({ manifestHash: "c".repeat(64) }),
    ).rejects.toThrow("conflict_runtime_posting_scope_response_mismatch");

    const protocolRelativeClient = new ActionControlPlaneConflictPostingClient({
      apiUrl: "https://reviewrouter.example",
      actionSessionToken: "action-session-token",
      config: runtimeConfigWithMalformedPostingEndpoint(
        "sessionEndpoint",
        "//evil.example/api/action/v1/conflict-posting/session",
      ),
      fetch: async () => {
        throw new Error("fetch_should_not_run");
      },
    });
    await expect(
      protocolRelativeClient.requestPostingSession({
        manifestHash: "c".repeat(64),
      }),
    ).rejects.toThrow("conflict_runtime_posting_endpoint_invalid");

    const encodedTraversalClient = new ActionControlPlaneConflictPostingClient({
      apiUrl: "https://reviewrouter.example",
      actionSessionToken: "action-session-token",
      config: runtimeConfigWithMalformedPostingEndpoint(
        "summaryEndpoint",
        "/api/action/v1/%2e%2e/conflict-posting/summary",
      ),
      fetch: async () => {
        throw new Error("fetch_should_not_run");
      },
    });
    await expect(
      encodedTraversalClient.postSummary({
        postingSessionToken: "posting-session-token",
        summaryMarkdown: "Safe advisory summary.",
      }),
    ).rejects.toThrow("conflict_runtime_posting_endpoint_invalid");
  });

  it("validates posting payloads before sending them to the proxy", async () => {
    let fetchCalls = 0;
    const client = new ActionControlPlaneConflictPostingClient({
      apiUrl: "https://reviewrouter.example",
      actionSessionToken: "action-session-token",
      config: runtimeConfig,
      fetch: async () => {
        fetchCalls += 1;
        return jsonResponse({
          protocolVersion: 1,
          status: "posted",
          githubExternalId: "github_1",
          githubUrl: null,
        });
      },
    });

    await expect(
      client.postSummary({
        postingSessionToken: "posting-session-token",
        summaryMarkdown: " ".repeat(2),
      }),
    ).rejects.toThrow("conflict_runtime_posting_summary_invalid");
    await expect(
      client.postSummary({
        postingSessionToken: "posting-session-token",
        summaryMarkdown: "x".repeat(60_001),
      }),
    ).rejects.toThrow("conflict_runtime_posting_summary_too_large");
    await expect(
      client.postSummary({
        postingSessionToken: "posting-session-token",
        summaryMarkdown: "<!-- reviewrouter:conflict-review:v1 -->",
      }),
    ).rejects.toThrow("conflict_runtime_posting_summary_marker_forbidden");
    await expect(
      client.postStatus({
        postingSessionToken: "posting-session-token",
        state: "success",
        description: "Merge result reviewed",
      }),
    ).rejects.toThrow("conflict_runtime_posting_status_claim_forbidden");
    await expect(
      client.postStatus({
        postingSessionToken: "posting-session-token",
        state: "success",
        description: "x".repeat(141),
      }),
    ).rejects.toThrow("conflict_runtime_posting_status_description_invalid");
    expect(fetchCalls).toBe(0);
  });

  it("fails closed when posting is disabled or the server returns an error", async () => {
    expect(
      () =>
        new ActionControlPlaneConflictPostingClient({
          apiUrl: "https://reviewrouter.example",
          actionSessionToken: "action-session-token",
          config: {
            ...runtimeConfig,
            posting: {
              mode: "disabled",
              reason: "posting_proxy_not_enabled",
            },
          },
        }),
    ).toThrow("conflict_runtime_posting_proxy_required");

    const client = new ActionControlPlaneConflictPostingClient({
      apiUrl: "https://reviewrouter.example",
      actionSessionToken: "action-session-token",
      config: runtimeConfig,
      fetch: async () =>
        jsonResponse(
          {
            error: {
              code: "conflict_review_exchange_denied",
              message: "redacted",
              retryable: false,
            },
          },
          403,
        ),
    });

    await expect(
      client.requestPostingSession({ manifestHash: "c".repeat(64) }),
    ).rejects.toThrow(
      "conflict_runtime_posting_http_error:conflict_review_exchange_denied:403",
    );

    const unsafeErrorClient = new ActionControlPlaneConflictPostingClient({
      apiUrl: "https://reviewrouter.example",
      actionSessionToken: "action-session-token",
      config: runtimeConfig,
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
      unsafeErrorClient.requestPostingSession({ manifestHash: "c".repeat(64) }),
    ).rejects.toThrow(
      "conflict_runtime_posting_http_error:unknown_action_error:500",
    );
  });
});

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function runtimeConfigWithMalformedPostingEndpoint(
  field: "sessionEndpoint" | "summaryEndpoint" | "statusEndpoint",
  endpoint: string,
): ActionConflictReviewRuntimeConfig {
  return {
    ...runtimeConfig,
    posting: {
      ...runtimeConfig.posting,
      [field]: endpoint,
    },
  } as unknown as ActionConflictReviewRuntimeConfig;
}
