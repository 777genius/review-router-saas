import { Readable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { hostedCommentTokenDelivery } from "../application/ports/hosted-comment-token-mint-ledger-port";
import {
  hostedCodexCommentTokenPath,
  hostedCodexGrantPath,
  hostedCodexResponsesPath,
  registerHostedCodexRelayRoutes,
} from "../interface/http/register-hosted-codex-relay-routes";

describe("hosted Codex relay routes", () => {
  it("keeps the transport contract exact and streams only safe upstream headers", async () => {
    const relayOpen = vi.fn(async ({ body }: { body: Readable }) => {
      let captured = "";
      for await (const chunk of body) captured += chunk.toString();
      expect(captured).toBe('{"input":"hello"}');
      return {
        statusCode: 200,
        headers: {
          "content-type": "text/event-stream",
          "set-cookie": "provider-secret-cookie=forbidden",
        },
        body: Readable.from(["data: one\n\n", "data: [DONE]\n\n"]),
      };
    });
    const app = Fastify({ logger: false });
    const releaseInitialDelivery = vi.fn(async () => undefined);
    const releaseRefreshDelivery = vi.fn(async () => undefined);
    await registerHostedCodexRelayRoutes(app, {
      enabled: true,
      grants: {
        issue: async () => ({
          protocolVersion: 1,
          grant: "opaque-grant",
          relayUrl: hostedCodexResponsesPath,
          invocationLeaseId: "lease-1",
          runtimeConfigVersion: 1,
          runtimeEnv: { REVIEW_ROUTER_PROVIDER: "codex" },
          repository: "owner/private-repo",
          commentToken: "github-app-token",
          commentTokenRefreshCapability: "opaque-comment-refresh",
          grantExpiresAt: "2026-08-15T12:00:00.000Z",
          commentTokenExpiresAt: "2026-08-15T11:00:00.000Z",
          [hostedCommentTokenDelivery]: releaseInitialDelivery,
          policy: {
            maxRequests: 4,
            maxRequestBodyBytes: 1_024,
            maxResponseBytes: 4_096,
            maxOutputTokens: 1_024,
          },
        }),
      },
      commentTokens: {
        issue: async () => ({
          token: "refreshed-github-app-token",
          repository: "owner/private-repo",
          [hostedCommentTokenDelivery]: releaseRefreshDelivery,
        }),
      },
      authorization: {
        authorize: async () => ({
          grantId: "grant-id",
          requestId: "request-id",
          accountId: "account-id",
          workspaceId: "workspace-test",
          poolId: "pool-test",
          runId: "run-id",
          runAttempt: 1,
          model: "gpt-5.1-codex-mini",
          accountUsable: true,
          grantExpiresAtMs: Date.now() + 60_000,
          declaredRequestBytes: 2,
          maxRequestBodyBytes: 1_024,
          maxResponseBytes: 4_096,
          maxOutputTokens: 1_024,
        }),
      },
      relay: { open: relayOpen },
    });

    const grant = await app.inject({
      method: "POST",
      url: hostedCodexGrantPath,
      payload: {
        oidcToken: "x".repeat(32),
        providerInstanceId: "provider-1",
        workflowSchemaVersion: 1,
        bindingId: "binding-1",
        bindingVersion: 7,
      },
    });
    expect(grant.statusCode).toBe(200);
    expect(grant.json()).toMatchObject({
      protocolVersion: 1,
      grant: "opaque-grant",
      invocationLeaseId: "lease-1",
      repository: "owner/private-repo",
      commentToken: "github-app-token",
    });
    await vi.waitFor(() =>
      expect(releaseInitialDelivery).toHaveBeenCalledOnce(),
    );

    const response = await app.inject({
      method: "POST",
      url: hostedCodexResponsesPath,
      headers: {
        authorization: "Bearer opaque-grant",
        "idempotency-key": "request-idempotency",
        "x-reviewrouter-request-ordinal": "1",
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      payload: '{"input":"hello"}',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).toBe("data: one\n\ndata: [DONE]\n\n");
    expect(relayOpen).toHaveBeenCalledOnce();

    const commentToken = await app.inject({
      method: "POST",
      url: hostedCodexCommentTokenPath,
      headers: {
        authorization: "Bearer opaque-comment-refresh",
        "idempotency-key": "comment-refresh-1",
      },
      payload: {
        invocationLeaseId: "lease-1",
        bindingId: "binding-1",
        bindingVersion: 7,
      },
    });
    expect(commentToken.json()).toEqual({
      token: "refreshed-github-app-token",
      repository: "owner/private-repo",
    });
    await vi.waitFor(() =>
      expect(releaseRefreshDelivery).toHaveBeenCalledOnce(),
    );
    await app.close();
  });

  it("does not register any route while the master flag is off", async () => {
    const app = Fastify({ logger: false });
    await registerHostedCodexRelayRoutes(app, {
      enabled: false,
      grants: { issue: vi.fn() },
      commentTokens: { issue: vi.fn() },
      authorization: { authorize: vi.fn() },
      relay: { open: vi.fn() },
    });
    expect(
      (await app.inject({ method: "POST", url: hostedCodexGrantPath }))
        .statusCode,
    ).toBe(404);
    await app.close();
  });
});
