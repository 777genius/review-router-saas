import { createHash } from "node:crypto";

export const codexAuthJsonMaxBytes = 32 * 1024;

export type ValidatedCodexAuthJson = {
  readonly auth_mode: "chatgpt";
  readonly tokens: {
    readonly refresh_token: string;
    readonly access_token?: string;
    readonly id_token?: string;
    readonly expiry?: string | number;
    readonly [key: string]: unknown;
  };
  readonly last_refresh?: string;
  readonly [key: string]: unknown;
};

export type CodexAuthJsonValidationResult = {
  readonly parsed: ValidatedCodexAuthJson;
  readonly byteLength: number;
  readonly exactBytesSha256: string;
  readonly warnings: readonly string[];
};

export function validateCodexAuthJsonBytes(input: {
  readonly authJsonBytes: string;
  readonly maxBytes?: number;
  readonly staleWarningDays?: number;
  readonly now?: Date;
}): CodexAuthJsonValidationResult {
  const maxBytes = input.maxBytes ?? codexAuthJsonMaxBytes;
  const byteLength = Buffer.byteLength(input.authJsonBytes, "utf8");
  if (byteLength === 0) {
    throw new Error("codex_auth_json_empty");
  }
  if (byteLength > maxBytes) {
    throw new Error("codex_auth_json_too_large");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(input.authJsonBytes);
  } catch {
    throw new Error("codex_auth_json_invalid_json");
  }
  const parsed = parseCodexAuthJson(parsedJson);

  return {
    parsed,
    byteLength,
    exactBytesSha256: createHash("sha256")
      .update(input.authJsonBytes, "utf8")
      .digest("hex"),
    warnings: collectCodexAuthJsonWarnings({
      parsed,
      staleWarningDays: input.staleWarningDays ?? 30,
      now: input.now ?? new Date(),
    }),
  };
}

export function compactCodexAuthJson(input: {
  readonly authJsonBytes: string;
  readonly maxBytes?: number;
}): {
  readonly compactAuthJsonBytes: string;
  readonly byteLength: number;
} {
  const validation = validateCodexAuthJsonBytes(input);
  const compactAuthJsonBytes = JSON.stringify(validation.parsed);
  const byteLength = Buffer.byteLength(compactAuthJsonBytes, "utf8");
  if (byteLength > (input.maxBytes ?? codexAuthJsonMaxBytes)) {
    throw new Error("codex_auth_json_too_large_after_compact");
  }
  return { compactAuthJsonBytes, byteLength };
}

export function classifyCodexRuntimeFailure(message: string): string {
  const normalized = message.toLowerCase();
  if (isCodexQuotaOrRateLimitFailure(normalized)) {
    return "quota_limited";
  }
  if (
    normalized.includes("unauthorized") ||
    normalized.includes("invalid_grant") ||
    normalized.includes("refresh token") ||
    normalized.includes("login required")
  ) {
    return "needs_reconnect";
  }
  if (
    normalized.includes("permission") ||
    normalized.includes("forbidden") ||
    normalized.includes("resource not accessible")
  ) {
    return "permission_required";
  }
  return "unknown_auth_state";
}

function isCodexQuotaOrRateLimitFailure(normalizedMessage: string): boolean {
  return (
    /\b(?:429|too many requests|rate[_ -]?limit(?:ed| exceeded)?|rate_limit_exceeded)\b/.test(
      normalizedMessage,
    ) ||
    /\b(?:insufficient_quota|quota_exceeded|exceeded (?:your )?(?:current )?quota|quota (?:limit|exceeded))\b/.test(
      normalizedMessage,
    ) ||
    /\b(?:billing_hard_limit|payment required|billing (?:limit|quota|hard limit|not active|required))\b/.test(
      normalizedMessage,
    )
  );
}

export function pruneCodexChildEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (shouldDropChildEnvKey(key)) continue;
    allowed[key] = value;
  }
  return allowed;
}

export function buildCodexRefreshBootstrapPlan(input: {
  readonly codexBinaryPath: string;
  readonly tempHome: string;
  readonly tempCodexHome: string;
  readonly emptyWorkingDirectory: string;
  readonly authJsonPath: string;
}): {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
} {
  return {
    command: input.codexBinaryPath,
    args: [
      "exec",
      "--sandbox",
      "read-only",
      "--ignore-rules",
      "--ephemeral",
      "-C",
      input.emptyWorkingDirectory,
      "--skip-git-repo-check",
      "-",
    ],
    cwd: input.emptyWorkingDirectory,
    env: {
      HOME: input.tempHome,
      CODEX_HOME: input.tempCodexHome,
      REVIEWROUTER_CODEX_AUTH_PATH: input.authJsonPath,
    },
  };
}

function parseCodexAuthJson(value: unknown): ValidatedCodexAuthJson {
  if (!isObject(value)) {
    throw new Error("codex_auth_json_invalid_shape");
  }
  if (value.auth_mode !== "chatgpt") {
    throw new Error("codex_auth_json_invalid_auth_mode");
  }
  if (!isObject(value.tokens)) {
    throw new Error("codex_auth_json_missing_tokens");
  }
  if (
    typeof value.tokens.refresh_token !== "string" ||
    value.tokens.refresh_token.length === 0
  ) {
    throw new Error("codex_auth_json_missing_refresh_token");
  }
  for (const key of ["access_token", "id_token"] as const) {
    const token = value.tokens[key];
    if (token !== undefined && typeof token !== "string") {
      throw new Error(`codex_auth_json_invalid_${key}`);
    }
  }
  if (
    value.last_refresh !== undefined &&
    typeof value.last_refresh !== "string"
  ) {
    throw new Error("codex_auth_json_invalid_last_refresh");
  }
  return value as ValidatedCodexAuthJson;
}

function collectCodexAuthJsonWarnings(input: {
  readonly parsed: ValidatedCodexAuthJson;
  readonly staleWarningDays: number;
  readonly now: Date;
}): readonly string[] {
  const warnings: string[] = [];
  if (!input.parsed.last_refresh) {
    warnings.push("last_refresh_missing");
    return warnings;
  }
  const refreshedAt = Date.parse(input.parsed.last_refresh);
  if (!Number.isFinite(refreshedAt)) {
    warnings.push("last_refresh_unparseable");
    return warnings;
  }
  const ageDays = (input.now.getTime() - refreshedAt) / 86_400_000;
  if (ageDays > input.staleWarningDays) {
    warnings.push("last_refresh_stale");
  }
  return warnings;
}

function shouldDropChildEnvKey(key: string): boolean {
  return (
    key === "GITHUB_TOKEN" ||
    key === "GH_TOKEN" ||
    key === "ACTIONS_ID_TOKEN_REQUEST_URL" ||
    key === "ACTIONS_ID_TOKEN_REQUEST_TOKEN" ||
    key === "GITHUB_ENV" ||
    key === "GITHUB_OUTPUT" ||
    key === "GITHUB_PATH" ||
    key === "GITHUB_STEP_SUMMARY" ||
    key === "GITHUB_STATE" ||
    key === "NODE_OPTIONS" ||
    key === "BASH_ENV" ||
    key === "ENV" ||
    key.startsWith("GIT_") ||
    key.startsWith("INPUT_AUTH") ||
    key.includes("CODEX_AUTH_JSON") ||
    key.includes("REVIEWROUTER_CODEX_AUTH_JSON") ||
    key.includes("OPENAI_API_KEY") ||
    key.includes("CLAUDE_CODE_OAUTH_TOKEN") ||
    key.includes("OPENROUTER_API_KEY") ||
    key.includes("REVIEW_ROUTER_COMMENT_TOKEN") ||
    key.includes("REVIEWROUTER_PROXY_NONCE")
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
