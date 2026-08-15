import { Readable } from "node:stream";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHostedCodexRelayTransport } from "../../packages/features/codex-oauth-rotating/src/action/hosted-codex-relay";
import {
  hostedCodexResponsesPath,
  registerHostedCodexRelayRoutes,
} from "../../packages/features/hosted-account-pool/src/interface/http/register-hosted-codex-relay-routes";
import { HostedCodexSessionStore } from "../../packages/features/hosted-account-pool/src/infrastructure/runtime/hosted-codex-session-runtime";

const actionOidcRequestSecret = "github-actions-oidc-request-secret-sentinel";
const freshOidcSecret = "fresh-github-oidc-token-sentinel-0123456789";
const relayGrantSecret = "opaque-hosted-relay-grant-sentinel";
const commentRefreshSecret = "opaque-comment-refresh-capability-sentinel";
const commentTokenOne = "github-comment-token-one-sentinel";
const commentTokenTwo = "github-comment-token-two-sentinel";
const providerAccessToken = "provider-access-token-must-stay-in-saas";
const providerRefreshToken = "provider-refresh-token-must-stay-in-saas";

const openApps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("disposable hosted pool local E2E", () => {
  it("runs grant -> nonce proxy -> Fastify relay -> SSE for multiple turns and refreshes the comment token", async () => {
    const relayBodies: string[] = [];
    const relayAuthorizations: string[] = [];
    const relayOrdinals: number[] = [];
    const masks: string[] = [];
    const logs: string[] = [];
    const persistedSafeMetadata = {
      accountId: "account-1",
      credentialCiphertextHash: "a".repeat(64),
      grantHash: "b".repeat(64),
    };
    let commentRefreshes = 0;
    let baseUrl = "";

    const app = Fastify({ logger: false });
    openApps.push(app);
    app.get("/fake/github-oidc", async (request) => {
      expect(request.headers.authorization).toBe(
        `bearer ${actionOidcRequestSecret}`,
      );
      expect((request.query as { audience?: string }).audience).toBe(
        "reviewrouter",
      );
      return { value: freshOidcSecret };
    });
    await registerHostedCodexRelayRoutes(app, {
      enabled: true,
      grants: {
        issue: async (request) => {
          expect(request.oidcToken).toBe(freshOidcSecret);
          expect(request).toMatchObject({
            providerInstanceId: "provider-1",
            workflowSchemaVersion: 5,
            bindingId: "binding-1",
            bindingVersion: 7,
          });
          return {
            protocolVersion: 1,
            grant: relayGrantSecret,
            relayUrl: `${baseUrl}${hostedCodexResponsesPath}`,
            invocationLeaseId: "invocation-lease-1",
            runtimeConfigVersion: 12,
            runtimeEnv: { REVIEW_PROVIDERS: "codex/gpt-5.5" },
            repository: "disposable-fixture/private-repo",
            commentToken: commentTokenOne,
            commentTokenRefreshCapability: commentRefreshSecret,
            grantExpiresAt: "2026-08-15T19:00:00.000Z",
            commentTokenExpiresAt: "2026-08-15T18:00:00.000Z",
            policy: { maxRequests: 3, maxRequestBodyBytes: 16_384 },
          };
        },
      },
      commentTokens: {
        issue: async (request) => {
          commentRefreshes += 1;
          expect(request).toMatchObject({
            opaqueRefreshCapability: commentRefreshSecret,
            invocationLeaseId: "invocation-lease-1",
            bindingId: "binding-1",
            bindingVersion: 7,
          });
          expect(request.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{22}:1$/);
          return {
            token: commentTokenTwo,
            repository: "disposable-fixture/private-repo",
          };
        },
      },
      authorization: {
        authorize: async (request) => {
          relayAuthorizations.push(request.opaqueGrant);
          relayOrdinals.push(request.requestOrdinal);
          return {
            grantId: "grant-1",
            requestId: `request-${request.requestOrdinal}`,
            accountId: "account-1",
            runId: "run-1",
            runAttempt: 1,
            model: "gpt-5.5",
            accountUsable: true,
            grantExpiresAtMs: Date.now() + 60_000,
            declaredRequestBytes: request.requestBytes,
            maxRequestBodyBytes: 16_384,
          };
        },
      },
      relay: {
        open: async ({ authorization, body }) => {
          let json = "";
          for await (const chunk of body) json += chunk.toString();
          relayBodies.push(json);
          const turn = relayBodies.length;
          logs.push(`relay request ${authorization.requestId} completed`);
          return {
            statusCode: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-request-id": `fake-upstream-${turn}`,
              "set-cookie": `forbidden=${providerAccessToken}`,
            },
            body: Readable.from([
              `data: {"type":"response.output_text.delta","delta":"turn-${turn}"}\n\n`,
              "data: [DONE]\n\n",
            ]),
          };
        },
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = app.listeningOrigin;

    const env: NodeJS.ProcessEnv = {
      ACTIONS_ID_TOKEN_REQUEST_URL: `${baseUrl}/fake/github-oidc`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: actionOidcRequestSecret,
    };
    await runHostedCodexRelayTransport({
      env,
      apiUrl: baseUrl,
      providerInstanceId: "provider-1",
      workflowSchemaVersion: 5,
      bindingId: "binding-1",
      bindingVersion: 7,
      maskSecret: (secret) => masks.push(secret),
      fetchImpl: fetch,
      run: async ({ baseUrl: proxyBaseUrl, commentTokenRefreshUrl }) => {
        for (const turn of [1, 2]) {
          const response = await fetch(`${proxyBaseUrl}/responses`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer caller-owned-token-must-be-stripped",
              "chatgpt-account-id": "caller-account-must-be-stripped",
            },
            body: JSON.stringify({ input: `turn-${turn}` }),
          });
          expect(response.status).toBe(200);
          expect(response.headers.get("set-cookie")).toBeNull();
          expect(await response.text()).toContain(`"turn-${turn}"`);
        }
        const refreshed = await fetch(commentTokenRefreshUrl, {
          method: "POST",
          body: "{}",
        });
        expect(refreshed.status).toBe(200);
        await expect(refreshed.json()).resolves.toEqual({
          token: commentTokenTwo,
          repository: "disposable-fixture/private-repo",
        });
      },
    });

    expect(relayBodies).toEqual(['{"input":"turn-1"}', '{"input":"turn-2"}']);
    expect(relayAuthorizations).toEqual([relayGrantSecret, relayGrantSecret]);
    expect(relayOrdinals).toEqual([1, 2]);
    expect(commentRefreshes).toBe(1);
    expect(masks).toEqual([
      freshOidcSecret,
      relayGrantSecret,
      commentRefreshSecret,
      commentTokenOne,
    ]);
    expect(env).not.toHaveProperty("ACTIONS_ID_TOKEN_REQUEST_TOKEN");

    const actionVisibleMaterial = JSON.stringify({ env, relayBodies, logs });
    const providerCustodyMaterial = JSON.stringify(persistedSafeMetadata);
    for (const credential of [providerAccessToken, providerRefreshToken]) {
      expect(actionVisibleMaterial).not.toContain(credential);
      expect(providerCustodyMaterial).not.toContain(credential);
    }
    expect(actionVisibleMaterial).not.toContain(commentRefreshSecret);
    expect(actionVisibleMaterial).not.toContain(relayGrantSecret);
    expect(actionVisibleMaterial).not.toContain("caller-owned-token");
    expect(actionVisibleMaterial).not.toContain("caller-account");
  });

  it("allows two same-account relay invocations to overlap without an inference lease", async () => {
    let active = 0;
    let maximumActive = 0;
    let releaseBoth: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const app = Fastify({ logger: false });
    openApps.push(app);
    await registerHostedCodexRelayRoutes(app, {
      enabled: true,
      grants: { issue: vi.fn() },
      commentTokens: { issue: vi.fn() },
      authorization: {
        authorize: async ({ requestOrdinal, requestBytes }) => ({
          grantId: `grant-${requestOrdinal}`,
          requestId: `request-${requestOrdinal}`,
          accountId: "account-1",
          runId: "parallel-run",
          runAttempt: 1,
          model: "gpt-5.5",
          accountUsable: true,
          grantExpiresAtMs: Date.now() + 60_000,
          declaredRequestBytes: requestBytes,
          maxRequestBodyBytes: 1_024,
        }),
      },
      relay: {
        open: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          if (active === 2) releaseBoth?.();
          await bothStarted;
          active -= 1;
          return {
            statusCode: 200,
            headers: { "content-type": "text/event-stream" },
            body: Readable.from(["data: [DONE]\n\n"]),
          };
        },
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const invoke = (ordinal: number) =>
      fetch(`${app.listeningOrigin}${hostedCodexResponsesPath}`, {
        method: "POST",
        headers: {
          authorization: `Bearer grant-${ordinal}`,
          "content-type": "application/json",
          "idempotency-key": `invocation-${ordinal}`,
          "x-reviewrouter-request-ordinal": String(ordinal),
        },
        body: "{}",
      });
    const responses = await Promise.all([invoke(1), invoke(2)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(maximumActive).toBe(2);
  });

  it("accepts exactly one writer when two refreshes race on the same generation", async () => {
    let generation = 1;
    let contenders = 0;
    let releaseRace: (() => void) | undefined;
    const raceStarted = new Promise<void>((resolve) => {
      releaseRace = resolve;
    });
    const authJsonBytes = validCodexAuthJson();
    const store = new HostedCodexSessionStore({
      read: async () => ({
        accountId: "account-1",
        authJsonBytes,
        generation,
        generationHash: `generation-${generation}`,
        storageVersion: "test-only",
      }),
      compareAndSwap: async (request) => {
        contenders += 1;
        if (contenders === 2) releaseRace?.();
        await raceStarted;
        if (request.expectedGeneration !== generation) {
          return {
            status: "stale_generation" as const,
            currentGeneration: generation,
            currentGenerationHash: `generation-${generation}`,
          };
        }
        generation += 1;
        return {
          status: "accepted" as const,
          generation,
          generationHash: `generation-${generation}`,
        };
      },
    });
    const restored = await store.read({ providerInstanceId: "account-1" });
    expect(restored).not.toBeNull();

    const write = (leaseId: string) =>
      store.write({
        providerInstanceId: "account-1",
        expectedGeneration: 1,
        nextArtifact: restored!.artifact,
        idempotencyKey: `refresh-${leaseId}`,
        leaseId,
      });
    const results = await Promise.all([write("fence-a"), write("fence-b")]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "accepted",
      "stale_generation",
    ]);
    expect(generation).toBe(2);
  });

  it("fails closed at the relay service seam for scope, expiry, replay, and budget violations", async () => {
    const relayOpen = vi.fn();
    const app = Fastify({ logger: false });
    openApps.push(app);
    const rejectionByGrant = new Map<string, string>([
      ["cross-tenant", "workspace_mismatch"],
      ["cross-repository", "repository_mismatch"],
      ["stale-binding", "binding_revision_mismatch"],
      ["expired", "grant_invalid_expired"],
      ["replay", "relay_request_replay_conflict"],
      ["request-budget", "request_budget_exhausted"],
    ]);
    await registerHostedCodexRelayRoutes(app, {
      enabled: true,
      grants: { issue: vi.fn() },
      commentTokens: { issue: vi.fn() },
      authorization: {
        authorize: async ({ opaqueGrant, requestOrdinal, requestBytes }) => {
          const rejection = rejectionByGrant.get(opaqueGrant);
          if (rejection) throw new Error(rejection);
          return {
            grantId: "grant-valid",
            requestId: `request-${requestOrdinal}`,
            accountId: "account-1",
            runId: "denial-run",
            runAttempt: 1,
            model: "gpt-5.5",
            accountUsable: true,
            grantExpiresAtMs: Date.now() + 60_000,
            declaredRequestBytes: requestBytes,
            maxRequestBodyBytes: opaqueGrant === "byte-budget" ? 1 : 1_024,
          };
        },
      },
      relay: { open: relayOpen },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const denials: readonly (readonly [string, number])[] = [
      ["cross-tenant", 403],
      ["cross-repository", 403],
      ["stale-binding", 403],
      ["expired", 401],
      ["replay", 502],
      ["request-budget", 429],
    ];
    for (const [index, [grant, expectedStatus]] of denials.entries()) {
      const response = await directRelayRequest(
        app.listeningOrigin,
        String(grant),
        index + 1,
        "{}",
      );
      expect(response.status, String(grant)).toBe(expectedStatus);
      await expect(response.json()).resolves.toEqual({
        error: "hosted_codex_relay_rejected",
      });
    }
    const oversized = await directRelayRequest(
      app.listeningOrigin,
      "byte-budget",
      7,
      "{}",
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      error: "relay_request_body_too_large",
    });
    expect(relayOpen).not.toHaveBeenCalled();
  });
});

function directRelayRequest(
  origin: string,
  grant: string,
  ordinal: number,
  body: string,
) {
  return fetch(`${origin}${hostedCodexResponsesPath}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${grant}`,
      "content-type": "application/json",
      "idempotency-key": `negative-${ordinal}`,
      "x-reviewrouter-request-ordinal": String(ordinal),
    },
    body,
  });
}

function validCodexAuthJson(): Uint8Array {
  const claims = Buffer.from(
    JSON.stringify({
      iss: "https://auth.openai.com",
      sub: "disposable-e2e-user",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "disposable-e2e-account",
      },
    }),
  ).toString("base64url");
  return Buffer.from(
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "disposable-access-token",
        refresh_token: "disposable-refresh-token",
        id_token: `e30.${claims}.signature`,
      },
      last_refresh: "2026-08-15T12:00:00.000Z",
    }),
  );
}
