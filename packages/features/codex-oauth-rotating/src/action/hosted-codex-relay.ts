import { randomBytes } from "node:crypto";
import http from "node:http";
import { z } from "zod";

const defaultOidcAudience = "reviewrouter";
export const forkAgenticSandboxHostedPoolActionMode =
  "fork-agentic-sandbox-hosted-pool";
const defaultMaxRequestBodyBytes = 2_000_000;
const absoluteMaxRelayRequests = 64;
const maxCommentTokenRefreshes = 8;
const oidcRequestTimeoutMs = 20_000;
const grantRequestTimeoutMs = 30_000;
const grantExchangeTotalTimeoutMs = 75_000;
const grantExchangeMaxAttempts = 3;
const grantExchangeBackoffBaseMs = 250;

class RetryableHostedRelayExchangeError extends Error {}

const hostedRelayGrantSchema = z
  .object({
    protocolVersion: z.literal(1),
    grant: z.string().min(1),
    relayUrl: z.string().url(),
    invocationLeaseId: z.string().min(1),
    runtimeConfigVersion: z.number().int().nonnegative(),
    runtimeEnv: z.record(z.string(), z.string()),
    repository: z.string().min(1),
    commentToken: z.string().min(1),
    commentTokenRefreshCapability: z.string().min(1),
    grantExpiresAt: z.string().datetime(),
    commentTokenExpiresAt: z.string().datetime().optional(),
    policy: z
      .object({
        maxRequests: z.number().int().min(1).max(absoluteMaxRelayRequests),
        maxRequestBodyBytes: z
          .number()
          .int()
          .min(1)
          .max(defaultMaxRequestBodyBytes)
          .optional(),
      })
      .strict(),
  })
  .strict();

export type HostedRelayGrant = z.infer<typeof hostedRelayGrantSchema>;

export type HostedRelayProxy = {
  readonly baseUrl: string;
  readonly commentTokenRefreshUrl: string;
  readonly close: () => Promise<void>;
};

type FetchLike = typeof fetch;

type MaskSecret = (secret: string) => void;

export type HostedRelayTransportInput = {
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: FetchLike;
  readonly apiUrl: string;
  readonly providerInstanceId: string;
  readonly workflowSchemaVersion: number;
  readonly bindingId: string;
  readonly bindingVersion: number;
  readonly maskSecret: MaskSecret;
  readonly deferOidcRequestEnvCleanup?: boolean | undefined;
  readonly retryDelay?: ((ms: number) => Promise<void>) | undefined;
  readonly run: (input: {
    readonly baseUrl: string;
    readonly policy: HostedRelayGrant["policy"];
    readonly grantExpiresAt: string;
    readonly commentTokenExpiresAt?: string | undefined;
    readonly invocationLeaseId: string;
    readonly runtimeConfigVersion: number;
    readonly runtimeEnv: Readonly<Record<string, string>>;
    readonly repository: string;
    readonly commentToken: string;
    readonly commentTokenRefreshUrl: string;
  }) => Promise<void>;
};

/**
 * Runs the hosted transport without ever loading provider auth JSON. The opaque
 * relay grant remains captured by the parent proxy closure for its lifetime.
 */
export async function runHostedCodexRelayTransport(
  input: HostedRelayTransportInput,
): Promise<void> {
  clearHostedActionCredentialEnv(input.env);
  const relayGrant = await requestHostedRelayGrantWithFreshGitHubOidc(input);
  const proxy = await startHostedCodexRelayProxy({
    fetchImpl: input.fetchImpl,
    relayUrl: relayGrant.relayUrl,
    upstreamCommentTokenRefreshUrl: `${input.apiUrl.replace(/\/+$/, "")}/api/action/v1/hosted-relay/comment-token`,
    grant: relayGrant.grant,
    commentTokenRefreshCapability: relayGrant.commentTokenRefreshCapability,
    invocationLeaseId: relayGrant.invocationLeaseId,
    bindingId: input.bindingId,
    bindingVersion: input.bindingVersion,
    policy: relayGrant.policy,
  });
  try {
    await input.run({
      baseUrl: proxy.baseUrl,
      policy: relayGrant.policy,
      grantExpiresAt: relayGrant.grantExpiresAt,
      ...(relayGrant.commentTokenExpiresAt
        ? { commentTokenExpiresAt: relayGrant.commentTokenExpiresAt }
        : {}),
      invocationLeaseId: relayGrant.invocationLeaseId,
      runtimeConfigVersion: relayGrant.runtimeConfigVersion,
      runtimeEnv: relayGrant.runtimeEnv,
      repository: relayGrant.repository,
      commentToken: relayGrant.commentToken,
      commentTokenRefreshUrl: proxy.commentTokenRefreshUrl,
    });
  } finally {
    await proxy.close();
    clearHostedActionCredentialEnv(input.env);
    if (!input.deferOidcRequestEnvCleanup) {
      clearOidcRequestEnv(input.env);
    }
  }
}

export async function requestHostedRelayGrantWithFreshGitHubOidc(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: FetchLike;
  readonly apiUrl: string;
  readonly providerInstanceId: string;
  readonly workflowSchemaVersion: number;
  readonly bindingId: string;
  readonly bindingVersion: number;
  readonly maskSecret: MaskSecret;
  readonly deferOidcRequestEnvCleanup?: boolean | undefined;
  readonly retryDelay?: ((ms: number) => Promise<void>) | undefined;
}): Promise<HostedRelayGrant> {
  const totalController = new AbortController();
  const totalTimer = setTimeout(
    () =>
      totalController.abort(new Error("hosted_relay_grant_deadline_exceeded")),
    grantExchangeTotalTimeoutMs,
  );
  let lastError: unknown;
  try {
    for (let attempt = 1; attempt <= grantExchangeMaxAttempts; attempt += 1) {
      if (totalController.signal.aborted) {
        throw new Error("hosted_relay_grant_deadline_exceeded");
      }
      try {
        const oidcToken = await requestGitHubActionsOidcToken({
          env: input.env,
          fetchImpl: input.fetchImpl,
          audience: defaultOidcAudience,
          totalSignal: totalController.signal,
        });
        input.maskSecret(oidcToken);
        let response: Response;
        try {
          response = await fetchWithTimeout(
            input.fetchImpl,
            `${input.apiUrl.replace(/\/+$/, "")}/api/action/v1/hosted-relay/grant`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                oidcToken,
                providerInstanceId: input.providerInstanceId,
                workflowSchemaVersion: input.workflowSchemaVersion,
                bindingId: input.bindingId,
                bindingVersion: input.bindingVersion,
              }),
            },
            grantRequestTimeoutMs,
            totalController.signal,
          );
        } catch (error) {
          if (totalController.signal.aborted) {
            throw new Error("hosted_relay_grant_deadline_exceeded", {
              cause: error,
            });
          }
          throw new RetryableHostedRelayExchangeError(
            "hosted_relay_grant_transport_failed",
            { cause: error },
          );
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          if (response.status === 429 || response.status >= 500) {
            throw new RetryableHostedRelayExchangeError(
              `hosted_relay_grant_retryable:${response.status}`,
            );
          }
          throw new Error(`hosted_relay_grant_failed:${response.status}`);
        }
        let rawGrant: unknown;
        try {
          rawGrant = await response.json();
        } catch (error) {
          throw new RetryableHostedRelayExchangeError(
            "hosted_relay_grant_response_failed",
            { cause: error },
          );
        }
        if (typeof rawGrant === "object" && rawGrant !== null) {
          const rawGrantRecord = rawGrant as Record<string, unknown>;
          for (const name of [
            "grant",
            "commentTokenRefreshCapability",
            "commentToken",
          ] as const) {
            const secret = rawGrantRecord[name];
            if (typeof secret === "string" && secret.length > 0) {
              input.maskSecret(secret);
            }
          }
        }
        return hostedRelayGrantSchema.parse(rawGrant);
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof RetryableHostedRelayExchangeError) ||
          attempt === grantExchangeMaxAttempts ||
          totalController.signal.aborted
        ) {
          throw error;
        }
        const backoffMs = grantExchangeBackoffBaseMs * 2 ** (attempt - 1);
        if (input.retryDelay) {
          await input.retryDelay(backoffMs);
        } else {
          await delayWithSignal(backoffMs, totalController.signal);
        }
      }
    }
    throw lastError;
  } finally {
    clearTimeout(totalTimer);
    if (!input.deferOidcRequestEnvCleanup) {
      clearOidcRequestEnv(input.env);
    }
  }
}

export async function startHostedCodexRelayProxy(input: {
  readonly fetchImpl: FetchLike;
  readonly relayUrl: string;
  readonly upstreamCommentTokenRefreshUrl: string;
  readonly grant: string;
  readonly commentTokenRefreshCapability: string;
  readonly invocationLeaseId: string;
  readonly bindingId: string;
  readonly bindingVersion: number;
  readonly policy: HostedRelayGrant["policy"];
}): Promise<HostedRelayProxy> {
  const nonce = randomBytes(24).toString("base64url");
  const proxyRequestNamespace = randomBytes(16).toString("base64url");
  const commentRefreshNamespace = randomBytes(16).toString("base64url");
  const maxBodyBytes =
    input.policy.maxRequestBodyBytes ?? defaultMaxRequestBodyBytes;
  let requestCount = 0;
  let commentTokenRefreshCount = 0;
  let closing = false;
  const activeUpstreamRequests = new Set<AbortController>();

  const server = http.createServer((req, res) => {
    void (async () => {
      let downstreamClosed = false;
      let upstreamController: AbortController | undefined;
      const abortUpstream = () => {
        downstreamClosed = true;
        upstreamController?.abort(new Error("downstream_closed"));
      };
      req.once("aborted", abortUpstream);
      res.once("close", abortUpstream);
      try {
        const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        if (req.method !== "POST") {
          writeProxyError(res, 404, "proxy_route_denied");
          return;
        }
        if (closing) {
          writeProxyError(res, 503, "proxy_closing");
          return;
        }
        if (path === `/${nonce}/control/comment-token`) {
          commentTokenRefreshCount += 1;
          if (commentTokenRefreshCount > maxCommentTokenRefreshes) {
            writeProxyError(res, 429, "comment_token_refresh_budget_exceeded");
            return;
          }
          await readRequestBody(req, 16_384);
          const refreshOrdinal = commentTokenRefreshCount;
          const refreshBody = Buffer.from(
            JSON.stringify({
              invocationLeaseId: input.invocationLeaseId,
              bindingId: input.bindingId,
              bindingVersion: input.bindingVersion,
            }),
          );
          upstreamController = new AbortController();
          activeUpstreamRequests.add(upstreamController);
          const refreshed = await input.fetchImpl(
            input.upstreamCommentTokenRefreshUrl,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${input.commentTokenRefreshCapability}`,
                accept: "application/json",
                "content-type": "application/json",
                "content-length": String(refreshBody.byteLength),
                "idempotency-key": `${commentRefreshNamespace}:${refreshOrdinal}`,
                "x-reviewrouter-request-ordinal": String(refreshOrdinal),
              },
              body: new Uint8Array(refreshBody),
              signal: upstreamController.signal,
            },
          );
          if (!downstreamClosed) {
            await writeUpstreamResponse(res, refreshed);
          } else {
            await refreshed.body?.cancel().catch(() => undefined);
          }
          return;
        }
        if (path !== `/${nonce}/v1/responses`) {
          writeProxyError(res, 404, "proxy_route_denied");
          return;
        }
        requestCount += 1;
        if (requestCount > input.policy.maxRequests) {
          writeProxyError(res, 429, "proxy_request_budget_exceeded");
          return;
        }
        const ordinal = requestCount;
        const body = await readRequestBody(req, maxBodyBytes);
        upstreamController = new AbortController();
        activeUpstreamRequests.add(upstreamController);
        const upstream = await input.fetchImpl(input.relayUrl, {
          method: "POST",
          headers: buildHostedRelayHeaders({
            requestHeaders: req.headers,
            grant: input.grant,
            requestOrdinal: ordinal,
            idempotencyKey: `${proxyRequestNamespace}:${ordinal}`,
            requestBytes: body.byteLength,
          }),
          body: new Uint8Array(body),
          signal: upstreamController.signal,
        });
        if (!downstreamClosed) {
          await writeUpstreamResponse(res, upstream);
        } else {
          await upstream.body?.cancel().catch(() => undefined);
        }
      } catch (error) {
        if (!downstreamClosed) {
          const code =
            error instanceof Error &&
            error.message === "proxy_request_body_too_large"
              ? "proxy_request_body_too_large"
              : "proxy_upstream_failed";
          if (res.headersSent) {
            res.destroy();
          } else {
            writeProxyError(
              res,
              code === "proxy_request_body_too_large" ? 413 : 502,
              code,
            );
          }
        }
      } finally {
        req.off("aborted", abortUpstream);
        res.off("close", abortUpstream);
        if (upstreamController) {
          activeUpstreamRequests.delete(upstreamController);
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("proxy_listener_invalid_address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/${nonce}/v1`,
    commentTokenRefreshUrl: `http://127.0.0.1:${address.port}/${nonce}/control/comment-token`,
    close: async () => {
      if (closing) return;
      closing = true;
      for (const controller of activeUpstreamRequests) {
        controller.abort(new Error("proxy_closing"));
      }
      const closed = closeServer(server);
      server.closeAllConnections();
      await closed;
    },
  };
}

export function buildHostedRelayHeaders(input: {
  readonly requestHeaders: http.IncomingHttpHeaders;
  readonly grant: string;
  readonly requestOrdinal: number;
  readonly idempotencyKey: string;
  readonly requestBytes: number;
}): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.grant}`,
    accept: joinedHeader(input.requestHeaders, "accept") ?? "text/event-stream",
    "content-type":
      joinedHeader(input.requestHeaders, "content-type") ?? "application/json",
    "content-length": String(input.requestBytes),
    "idempotency-key": input.idempotencyKey,
    "x-reviewrouter-request-ordinal": String(input.requestOrdinal),
  };
  for (const name of ["x-client-request-id", "x-request-id", "traceparent"]) {
    const value = joinedHeader(input.requestHeaders, name);
    if (value) headers[name] = value;
  }
  return headers;
}

function joinedHeader(
  headers: http.IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

async function requestGitHubActionsOidcToken(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: FetchLike;
  readonly audience: string;
  readonly totalSignal: AbortSignal;
}): Promise<string> {
  const requestUrl = input.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = input.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) throw new Error("github_oidc_unavailable");
  const url = parseTrustedGitHubActionsOidcUrl(requestUrl);
  url.searchParams.set("audience", input.audience);
  let response: Response;
  try {
    response = await fetchWithTimeout(
      input.fetchImpl,
      url.toString(),
      {
        headers: { authorization: `bearer ${requestToken}` },
        redirect: "error",
      },
      oidcRequestTimeoutMs,
      input.totalSignal,
    );
  } catch (error) {
    if (input.totalSignal.aborted) {
      throw new Error("hosted_relay_grant_deadline_exceeded", { cause: error });
    }
    throw new RetryableHostedRelayExchangeError(
      "github_oidc_transport_failed",
      {
        cause: error,
      },
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableHostedRelayExchangeError(
        `github_oidc_retryable:${response.status}`,
      );
    }
    throw new Error("github_oidc_request_failed");
  }
  let body: { readonly value?: unknown };
  try {
    body = (await response.json()) as { readonly value?: unknown };
  } catch (error) {
    throw new RetryableHostedRelayExchangeError("github_oidc_response_failed", {
      cause: error,
    });
  }
  if (typeof body.value !== "string" || body.value.length === 0) {
    throw new Error("github_oidc_request_failed");
  }
  return body.value;
}

export function parseTrustedGitHubActionsOidcUrl(requestUrl: string): URL {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    throw new Error("github_oidc_url_untrusted");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".actions.githubusercontent.com") ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    throw new Error("github_oidc_url_untrusted");
  }
  return url;
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  totalSignal?: AbortSignal | undefined,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromTotal = () =>
    controller.abort(totalSignal?.reason ?? new Error("request_aborted"));
  totalSignal?.addEventListener("abort", abortFromTotal, { once: true });
  if (totalSignal?.aborted) abortFromTotal();
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    totalSignal?.removeEventListener("abort", abortFromTotal);
  }
}

function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("hosted_relay_grant_deadline_exceeded"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("hosted_relay_grant_deadline_exceeded"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function readRequestBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        tooLarge = true;
        reject(new Error("proxy_request_body_too_large"));
        req.resume();
        return;
      }
      chunks.push(buffer);
    });
    req.once("error", reject);
    req.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function writeUpstreamResponse(
  res: http.ServerResponse,
  upstream: Response,
): Promise<void> {
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "cache-control", "x-request-id"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await waitForDrain(res);
    }
    res.end();
  } finally {
    reader.releaseLock();
  }
}

async function waitForDrain(res: http.ServerResponse): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("downstream_closed"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
  });
}

function writeProxyError(
  res: http.ServerResponse,
  status: number,
  code: string,
): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: code }));
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function clearHostedActionCredentialEnv(env: NodeJS.ProcessEnv): void {
  delete env.INPUT_AUTH_JSON;
  delete env["INPUT_AUTH-JSON"];
  delete env.REVIEWROUTER_CODEX_AUTH_JSON;
}

function clearOidcRequestEnv(env: NodeJS.ProcessEnv): void {
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
}
