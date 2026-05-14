import { z } from "zod";
import {
  actionConflictReviewDispatchPayloadSchema,
  actionRuntimeConfigResponseSchema,
  defaultActionOidcAudience,
  type ActionConflictReviewRuntimeConfig,
  type ActionRuntimeConfigResponse,
} from "@reviewrouter/features-action-control-plane";

type FetchLike = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string | undefined;
    readonly redirect?: "error" | undefined;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export type ActionControlPlaneRuntimeConfigClientOptions = {
  readonly apiUrl: string;
  readonly audience?: string | undefined;
  readonly actionVersion?: string | undefined;
  readonly fetch?: FetchLike | undefined;
};

const exchangeResponseSchema = z
  .object({
    protocolVersion: z.literal(1),
    sessionToken: z.string().min(1),
    expiresAt: z.string().datetime(),
    repository: z.string().min(1),
  })
  .strict();

const actionErrorResponseSchema = z.union([
  z
    .object({
      error: z
        .object({
          code: z.string().min(1).max(120),
          message: z.string().max(500).optional(),
          retryable: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ error: z.string().min(1).max(120) }).strict(),
]);

export class ActionControlPlaneRuntimeConfigClient {
  private readonly apiUrl: URL;
  private readonly audience: string;
  private readonly actionVersion: string | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(options: ActionControlPlaneRuntimeConfigClientOptions) {
    this.apiUrl = parseTrustedApiUrl(options.apiUrl);
    this.audience = options.audience ?? defaultActionOidcAudience;
    this.actionVersion = options.actionVersion?.trim() || undefined;
    this.fetchImpl =
      options.fetch ??
      (async (input, init) => {
        return fetch(input, {
          method: init.method,
          headers: init.headers,
          ...(init.redirect === undefined ? {} : { redirect: init.redirect }),
          ...(init.body === undefined ? {} : { body: init.body }),
        });
      });
  }

  async exchangeConflictSession(input: {
    readonly oidcToken: string;
    readonly conflictDispatchPayload: unknown;
  }): Promise<{
    readonly sessionToken: string;
    readonly expiresAt: string;
    readonly repository: string;
  }> {
    const oidcToken = validateBearerToken(input.oidcToken);
    const conflictDispatch = actionConflictReviewDispatchPayloadSchema.parse(
      input.conflictDispatchPayload,
    );
    const response = await this.postJson({
      path: "/api/action/v1/session/exchange",
      bearerToken: null,
      body: {
        oidcToken,
        audience: this.audience,
        conflictDispatch,
      },
    });
    const parsed = exchangeResponseSchema.parse(response);
    return {
      sessionToken: parsed.sessionToken,
      expiresAt: parsed.expiresAt,
      repository: parsed.repository,
    };
  }

  async fetchRuntimeConfig(input: {
    readonly sessionToken: string;
  }): Promise<ActionRuntimeConfigResponse> {
    const response = await this.getJson({
      path: "/api/action/v1/config",
      bearerToken: validateBearerToken(input.sessionToken),
    });
    return actionRuntimeConfigResponseSchema.parse(response);
  }

  async fetchConflictRuntimeConfig(input: {
    readonly sessionToken: string;
  }): Promise<{
    readonly runtimeConfig: ActionRuntimeConfigResponse;
    readonly conflictReview: ActionConflictReviewRuntimeConfig;
  }> {
    const runtimeConfig = await this.fetchRuntimeConfig(input);
    if (!runtimeConfig.conflictReview) {
      throw new Error("conflict_runtime_config_missing");
    }
    return {
      runtimeConfig,
      conflictReview: runtimeConfig.conflictReview,
    };
  }

  private async postJson(input: {
    readonly path: string;
    readonly bearerToken: string | null;
    readonly body: Readonly<Record<string, unknown>>;
  }): Promise<unknown> {
    const response = await this.fetchImpl(
      resolveApiPath(this.apiUrl, input.path),
      {
        method: "POST",
        headers: buildHeaders({
          bearerToken: input.bearerToken,
          actionVersion: this.actionVersion,
          json: true,
        }),
        body: JSON.stringify(input.body),
        redirect: "error",
      },
    );
    return parseActionResponse(response);
  }

  private async getJson(input: {
    readonly path: string;
    readonly bearerToken: string;
  }): Promise<unknown> {
    const response = await this.fetchImpl(
      resolveApiPath(this.apiUrl, input.path),
      {
        method: "GET",
        headers: buildHeaders({
          bearerToken: input.bearerToken,
          actionVersion: this.actionVersion,
          json: false,
        }),
        redirect: "error",
      },
    );
    return parseActionResponse(response);
  }
}

function buildHeaders(input: {
  readonly bearerToken: string | null;
  readonly actionVersion: string | undefined;
  readonly json: boolean;
}): Record<string, string> {
  return {
    accept: "application/json",
    ...(input.json ? { "content-type": "application/json" } : {}),
    ...(input.bearerToken
      ? { authorization: `Bearer ${input.bearerToken}` }
      : {}),
    ...(input.actionVersion
      ? { "x-reviewrouter-action-version": input.actionVersion }
      : {}),
  };
}

async function parseActionResponse(response: {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}): Promise<unknown> {
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `conflict_runtime_action_http_error:${safeErrorCode(payload)}:${response.status}`,
    );
  }
  return payload;
}

function resolveApiPath(apiUrl: URL, path: string): string {
  if (!isTrustedApiPath(path)) {
    throw new Error("conflict_runtime_action_endpoint_invalid");
  }
  const resolved = new URL(path, apiUrl);
  if (resolved.origin !== apiUrl.origin) {
    throw new Error("conflict_runtime_action_endpoint_invalid");
  }
  return resolved.toString();
}

function isTrustedApiPath(path: string): boolean {
  if (
    path.length === 0 ||
    path !== path.trim() ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("..") ||
    /%2e|%2f|%5c/i.test(path)
  ) {
    return false;
  }
  for (const character of path) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return false;
    }
  }
  return true;
}

function parseTrustedApiUrl(apiUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error("conflict_runtime_action_api_url_invalid");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("conflict_runtime_action_api_url_invalid");
  }
  if (parsed.protocol === "https:") {
    return parsed;
  }
  if (parsed.protocol === "http:" && isLocalhost(parsed.hostname)) {
    return parsed;
  }
  throw new Error("conflict_runtime_action_api_url_invalid");
}

function isLocalhost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function validateBearerToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    throw new Error("conflict_runtime_action_token_invalid");
  }
  return trimmed;
}

function safeErrorCode(payload: unknown): string {
  const parsed = actionErrorResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return "unknown_action_error";
  }
  const error = parsed.data.error;
  return safePublicActionErrorCode(
    typeof error === "string" ? error : error.code,
  );
}

function safePublicActionErrorCode(code: string): string {
  if (
    !/^[a-zA-Z0-9_:-]{1,120}$/.test(code) ||
    /authorization|bearer|gh[spou]_|github_pat_|sk-[a-z0-9]|api[_-]?key[:=]|secret[:=]|token[:=]|nonce[:=]/i.test(
      code,
    )
  ) {
    return "unknown_action_error";
  }
  return code;
}
