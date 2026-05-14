import { z } from "zod";
import type { ActionConflictReviewRuntimeConfig } from "@reviewrouter/features-action-control-plane";
import type { ConflictRuntimePostingClientPort } from "../application/conflict-runtime-runner.js";

type FetchLike = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly redirect?: "error" | undefined;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export type ActionControlPlaneConflictPostingClientOptions = {
  readonly apiUrl: string;
  readonly actionSessionToken: string;
  readonly config: ActionConflictReviewRuntimeConfig;
  readonly fetch?: FetchLike | undefined;
};

type ProxyConflictRuntimeConfig = ActionConflictReviewRuntimeConfig & {
  readonly posting: Extract<
    ActionConflictReviewRuntimeConfig["posting"],
    { readonly mode: "proxy" }
  >;
};

const postingSessionResponseSchema = z
  .object({
    protocolVersion: z.literal(1),
    postingSessionToken: z.string().min(1),
    expiresAt: z.string().datetime(),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/i),
    scope: z
      .object({
        dispatchId: z.string().min(1),
        pullRequestNumber: z.number().int().positive(),
        headSha: z.string().regex(/^[a-f0-9]{40}$/i),
        baseRef: z.string().min(1),
        baseSha: z.string().regex(/^[a-f0-9]{40}$/i),
        allowedOperations: z.tuple([
          z.literal("summary_comment"),
          z.literal("advisory_status"),
        ]),
      })
      .strict(),
  })
  .strict();

const postingWriteResponseSchema = z
  .object({
    protocolVersion: z.literal(1),
    status: z.enum(["posted", "already_posted"]),
    githubExternalId: z.string().min(1),
    githubUrl: z.string().nullable(),
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

export class ActionControlPlaneConflictPostingClient implements ConflictRuntimePostingClientPort {
  private readonly apiUrl: URL;
  private readonly actionSessionToken: string;
  private readonly config: ProxyConflictRuntimeConfig;
  private readonly fetchImpl: FetchLike;

  constructor(options: ActionControlPlaneConflictPostingClientOptions) {
    if (options.config.posting.mode !== "proxy") {
      throw new Error("conflict_runtime_posting_proxy_required");
    }
    this.apiUrl = parseTrustedApiUrl(options.apiUrl);
    this.actionSessionToken = validateBearerToken(options.actionSessionToken);
    this.config = options.config as ProxyConflictRuntimeConfig;
    this.fetchImpl =
      options.fetch ??
      (async (input, init) => {
        return fetch(input, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          ...(init.redirect === undefined ? {} : { redirect: init.redirect }),
        });
      });
  }

  async requestPostingSession(input: {
    readonly manifestHash: string;
  }): Promise<{ readonly postingSessionToken: string }> {
    const response = await this.postJson({
      path: this.config.posting.sessionEndpoint,
      bearerToken: this.actionSessionToken,
      body: {
        protocolVersion: 1,
        manifestHash: validateManifestHash(input.manifestHash),
      },
    });
    const parsed = postingSessionResponseSchema.parse(response);
    if (
      parsed.manifestHash.toLowerCase() !== input.manifestHash.toLowerCase()
    ) {
      throw new Error("conflict_runtime_posting_manifest_response_mismatch");
    }
    assertPostingSessionScopeMatchesConfig(parsed.scope, this.config);
    return { postingSessionToken: parsed.postingSessionToken };
  }

  async postSummary(input: {
    readonly postingSessionToken: string;
    readonly summaryMarkdown: string;
  }): Promise<void> {
    const response = await this.postJson({
      path: this.config.posting.summaryEndpoint,
      bearerToken: validateBearerToken(input.postingSessionToken),
      body: {
        protocolVersion: 1,
        summaryMarkdown: validateSummaryMarkdown(
          input.summaryMarkdown,
          this.config.posting.summaryMaxBytes,
        ),
      },
    });
    postingWriteResponseSchema.parse(response);
  }

  async postStatus(input: {
    readonly postingSessionToken: string;
    readonly state: "success" | "failure" | "error";
    readonly description?: string | undefined;
  }): Promise<void> {
    const response = await this.postJson({
      path: this.config.posting.statusEndpoint,
      bearerToken: validateBearerToken(input.postingSessionToken),
      body: {
        protocolVersion: 1,
        state: input.state,
        ...optionalStatusDescription(input.description),
      },
    });
    postingWriteResponseSchema.parse(response);
  }

  private async postJson(input: {
    readonly path: string;
    readonly bearerToken: string;
    readonly body: Readonly<Record<string, unknown>>;
  }): Promise<unknown> {
    const response = await this.fetchImpl(
      resolveApiPath(this.apiUrl, input.path),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.bearerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input.body),
        redirect: "error",
      },
    );
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(
        `conflict_runtime_posting_http_error:${safeErrorCode(payload)}:${response.status}`,
      );
    }
    return payload;
  }
}

function resolveApiPath(apiUrl: URL, path: string): string {
  if (!isTrustedApiPath(path)) {
    throw new Error("conflict_runtime_posting_endpoint_invalid");
  }
  const resolved = new URL(path, apiUrl);
  if (resolved.origin !== apiUrl.origin) {
    throw new Error("conflict_runtime_posting_endpoint_invalid");
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
    throw new Error("conflict_runtime_posting_api_url_invalid");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("conflict_runtime_posting_api_url_invalid");
  }
  if (parsed.protocol === "https:") {
    return parsed;
  }
  if (parsed.protocol === "http:" && isLocalhost(parsed.hostname)) {
    return parsed;
  }
  throw new Error("conflict_runtime_posting_api_url_invalid");
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
    throw new Error("conflict_runtime_posting_token_invalid");
  }
  return trimmed;
}

function validateManifestHash(manifestHash: string): string {
  if (!/^[a-f0-9]{64}$/i.test(manifestHash)) {
    throw new Error("conflict_runtime_posting_manifest_invalid");
  }
  return manifestHash;
}

function assertPostingSessionScopeMatchesConfig(
  scope: z.infer<typeof postingSessionResponseSchema>["scope"],
  config: ProxyConflictRuntimeConfig,
): void {
  if (
    scope.dispatchId !== config.dispatchId ||
    scope.pullRequestNumber !== config.pullRequestNumber ||
    scope.headSha.toLowerCase() !== config.headSha.toLowerCase() ||
    scope.baseRef !== config.baseRef ||
    scope.baseSha.toLowerCase() !== config.baseSha.toLowerCase() ||
    scope.allowedOperations[0] !== config.posting.allowedOperations[0] ||
    scope.allowedOperations[1] !== config.posting.allowedOperations[1]
  ) {
    throw new Error("conflict_runtime_posting_scope_response_mismatch");
  }
}

function validateSummaryMarkdown(
  summaryMarkdown: string,
  summaryMaxBytes: number,
): string {
  const trimmed = summaryMarkdown.trim();
  if (trimmed.length === 0) {
    throw new Error("conflict_runtime_posting_summary_invalid");
  }
  if (Buffer.byteLength(trimmed, "utf8") > summaryMaxBytes) {
    throw new Error("conflict_runtime_posting_summary_too_large");
  }
  if (/reviewrouter:conflict-review/i.test(trimmed)) {
    throw new Error("conflict_runtime_posting_summary_marker_forbidden");
  }
  return trimmed;
}

function optionalStatusDescription(description: string | undefined): {
  readonly description?: string;
} {
  if (description === undefined) {
    return {};
  }
  const trimmed = description.trim();
  if (trimmed.length === 0 || trimmed.length > 140) {
    throw new Error("conflict_runtime_posting_status_description_invalid");
  }
  if (/required|merge result reviewed/i.test(trimmed)) {
    throw new Error("conflict_runtime_posting_status_claim_forbidden");
  }
  return { description: trimmed };
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
