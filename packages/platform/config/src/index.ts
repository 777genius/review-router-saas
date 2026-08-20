import { readFileSync } from "node:fs";
import { isLoopbackHostname } from "@reviewrouter/shared";
export { isLoopbackHostname } from "@reviewrouter/shared";
import { z } from "zod";

export const REVIEW_ROUTER_ACTION_REPOSITORY = "777genius/review-router";
export const DEFAULT_REVIEW_ROUTER_ACTION_VERSION = "main";

export const runtimeEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url().optional(),
  REVIEW_ROUTER_WEB_URL: z.string().url().default("http://localhost:3000"),
  REVIEW_ROUTER_API_URL: z.string().url().default("http://localhost:4000"),
  REVIEW_ROUTER_PUBLIC_API_URL: z.string().url().optional(),
  AUTH_SECRET: z.string().min(16),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY_FILE: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  REVIEW_ROUTER_ACTION_REF: z.string().optional(),
  REVIEW_ROUTER_ALLOWED_ACTION_REFS: z.string().default(""),
  REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: z.string().optional(),
  REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS: z.string().default(""),
  REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: z.string().optional(),
  REVIEW_ROUTER_ACTION_VERSION: z
    .string()
    .default(DEFAULT_REVIEW_ROUTER_ACTION_VERSION),
  REVIEW_ROUTER_ACTION_OIDC_AUDIENCE: z.string().default("reviewrouter"),
  REVIEW_ROUTER_ACTION_SESSION_SECRET: z.string().min(32).optional(),
  REVIEW_ROUTER_LEDGER_HMAC_KEY: z.string().min(32).optional(),
  REVIEW_ROUTER_DISABLE_ACTION_CONTROL_PLANE: z.enum(["0", "1"]).default("0"),
  REVIEW_ROUTER_BLOCKED_ACTION_VERSIONS: z.string().default(""),
  REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: z.enum(["0", "1"]).default("0"),
  REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: z.enum(["0", "1"]).default("0"),
  REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK: z
    .enum(["0", "1"])
    .default("1"),
  REVIEW_ROUTER_CONFLICT_REVIEW_FALLBACK_REPOSITORIES: z.string().default(""),
  REVIEW_ROUTER_ENABLE_CLAUDE_CODE_PROVIDER: z.enum(["0", "1"]).default("1"),
  REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: z.enum(["0", "1"]).default("0"),
  REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES: z.string().default(""),
  REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: z.enum(["0", "1"]).default("0"),
  REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: z.enum(["0", "1"]).default("0"),
  REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: z.enum(["0", "1"]).default("0"),
  REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: z.enum(["0", "1"]).default("0"),
  REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: z.enum(["0", "1"]).default("0"),
  REVIEW_ROUTER_DEFAULT_MODEL: z.string().default("gpt-5.6-sol"),
  REVIEW_ROUTER_DEFAULT_EFFORT: z
    .enum(["low", "medium", "high", "xhigh"])
    .default("xhigh"),
});

export type RuntimeEnv = z.infer<typeof runtimeEnvSchema>;

type ReviewRouterActionRefEnv = {
  readonly REVIEW_ROUTER_ACTION_REF?: string | undefined;
  readonly REVIEW_ROUTER_ALLOWED_ACTION_REFS?: string | undefined;
  readonly REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF?: string | undefined;
  readonly REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS?:
    | string
    | undefined;
  readonly REVIEW_ROUTER_ACTION_VERSION?: string | undefined;
  readonly [key: string]: string | undefined;
};

type ReviewRouterDatabaseRecoveryWitnessEnv = {
  readonly REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS?: string | undefined;
  readonly [key: string]: string | undefined;
};

type ReviewRouterApiUrlEnv = {
  readonly NODE_ENV?: string | undefined;
  readonly REVIEW_ROUTER_API_URL?: string | undefined;
  readonly REVIEW_ROUTER_PUBLIC_API_URL?: string | undefined;
  readonly [key: string]: string | undefined;
};

export function loadRuntimeEnv(
  input: NodeJS.ProcessEnv = process.env,
): RuntimeEnv {
  return runtimeEnvSchema.parse(input);
}

export function resolveReviewRouterActionRef(
  input: ReviewRouterActionRefEnv = process.env,
): string {
  const explicitRef = input.REVIEW_ROUTER_ACTION_REF?.trim();
  if (explicitRef) {
    return explicitRef;
  }

  const version =
    input.REVIEW_ROUTER_ACTION_VERSION?.trim() ||
    DEFAULT_REVIEW_ROUTER_ACTION_VERSION;
  return `${REVIEW_ROUTER_ACTION_REPOSITORY}@${version}`;
}

/**
 * Resolves the immutable Action release used only by rotating Codex workflows.
 *
 * This intentionally has no fallback to REVIEW_ROUTER_ACTION_REF: the general
 * workflow channel may track a branch, while a rotating workflow is part of a
 * durable secret-namespace attestation and must remain pinned to an exact
 * release for the lifetime of that namespace.
 */
export function resolveReviewRouterCodexRotatingActionRef(
  input: ReviewRouterActionRefEnv = process.env,
): string {
  const value = input.REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF?.trim();
  if (!value) {
    throw new Error("missing_env:REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF");
  }
  return normalizeFullShaActionRef(
    value,
    "REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF",
  );
}

export function resolveReviewRouterCodexRotatingTrustedActionRefs(
  input: ReviewRouterActionRefEnv = process.env,
): readonly string[] {
  const primaryRef = resolveReviewRouterCodexRotatingActionRef(input);
  const primaryRepository = actionRefRepository(primaryRef);
  const overlap = parseFullShaActionRefList(
    input.REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS,
    "REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS",
  );
  if (overlap.some((ref) => actionRefRepository(ref) !== primaryRepository)) {
    throw new Error(
      "invalid_env:REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS",
    );
  }
  return [...new Set([primaryRef, ...overlap])];
}

export function requireReviewRouterDatabaseRecoveryWitness(
  input: ReviewRouterDatabaseRecoveryWitnessEnv = process.env,
): string {
  const value = input.REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS?.trim();
  if (!value) {
    throw new Error("missing_env:REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS");
  }
  // 32 random bytes encode to 43 unpadded base64url characters. Keep this
  // aligned with fingerprintDatabaseRecoveryWitness without ever returning a
  // secret-bearing validation error.
  if (
    !/^[A-Za-z0-9_-]{43,256}$/.test(value) ||
    /replace-with|placeholder/i.test(value)
  ) {
    throw new Error("invalid_env:REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS");
  }
  return value;
}

export function resolveReviewRouterPublicApiUrl(
  input: ReviewRouterApiUrlEnv = process.env,
): string {
  const production = input.NODE_ENV === "production";
  const raw =
    input.REVIEW_ROUTER_PUBLIC_API_URL?.trim() ||
    input.REVIEW_ROUTER_API_URL?.trim();
  if (!raw) {
    if (production) {
      throw new Error("missing_env:REVIEW_ROUTER_PUBLIC_API_URL");
    }
    return "http://localhost:4000";
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid_workflow_api_url");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("invalid_workflow_api_url");
  }
  const local = isLoopbackHostname(url.hostname);
  if (production && local) {
    throw new Error("invalid_workflow_api_url");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && !production && local)
  ) {
    throw new Error("invalid_workflow_api_url");
  }
  return url.toString().replace(/\/$/u, "");
}

export function resolveReviewRouterTrustedActionRefs(
  input: ReviewRouterActionRefEnv = process.env,
): readonly string[] {
  const primaryRef = resolveReviewRouterActionRef(input);
  const refs = [
    ...(isFullShaActionRef(primaryRef) ? [primaryRef] : []),
    ...parseReviewRouterActionRefList(input.REVIEW_ROUTER_ALLOWED_ACTION_REFS),
  ];
  const normalizedRefs = refs.map((ref) =>
    normalizeFullShaActionRef(ref, "REVIEW_ROUTER_ALLOWED_ACTION_REFS"),
  );
  return [...new Set(normalizedRefs)];
}

export function parseReviewRouterActionRefList(
  value: string | undefined,
): readonly string[] {
  return parseFullShaActionRefList(value, "REVIEW_ROUTER_ALLOWED_ACTION_REFS");
}

export function isWorkflowProvisioningEnabled(
  input: NodeJS.ProcessEnv = process.env,
): boolean {
  if (input.REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING === "1") {
    return false;
  }
  return input.REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING === "1";
}

export function isConflictReviewFallbackEnabled(
  input: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = input.REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK?.trim();
  return value === undefined || value === "" || value === "1";
}

export function isConflictReviewFallbackAllowedForRepository(
  repositoryFullName: string,
  input: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isConflictReviewFallbackEnabled(input)) {
    return false;
  }
  const allowlist = parseConflictReviewFallbackRepositoryAllowlist(
    input.REVIEW_ROUTER_CONFLICT_REVIEW_FALLBACK_REPOSITORIES,
  );
  if (allowlist.length === 0) {
    return true;
  }
  const normalizedRepository = normalizeRepositoryFullName(
    repositoryFullName,
    "REVIEW_ROUTER_CONFLICT_REVIEW_FALLBACK_REPOSITORIES",
  );
  return allowlist.includes(normalizedRepository);
}

export function parseConflictReviewFallbackRepositoryAllowlist(
  value: string | undefined,
): readonly string[] {
  return parseRepositoryAllowlist(
    value,
    "REVIEW_ROUTER_CONFLICT_REVIEW_FALLBACK_REPOSITORIES",
  );
}

function parseRepositoryAllowlist(
  value: string | undefined,
  envName: string,
): readonly string[] {
  const raw = value?.trim();
  if (!raw) {
    return [];
  }
  const repositories = raw
    .split(/[\s,]+/)
    .map((repository) => normalizeRepositoryFullName(repository, envName))
    .filter((repository) => repository.length > 0);
  return [...new Set(repositories)];
}

export function isClaudeCodeProviderEnabled(
  input: NodeJS.ProcessEnv = process.env,
): boolean {
  return input.REVIEW_ROUTER_ENABLE_CLAUDE_CODE_PROVIDER !== "0";
}

export function isCodexRotatingOAuthEnabled(
  input: NodeJS.ProcessEnv = process.env,
): boolean {
  return input.REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH === "1";
}

export function isHostedCodexPoolEnabled(
  input: NodeJS.ProcessEnv = process.env,
): boolean {
  return input.REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL === "1";
}

export function isHostedCodexCustodyEnabled(
  input: NodeJS.ProcessEnv = process.env,
): boolean {
  return input.REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY === "1";
}

export function isHostedCodexAdmissionEnabled(
  input: NodeJS.ProcessEnv = process.env,
): boolean {
  return input.REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION === "1";
}

export function isHostedCodexRelayEnabled(
  input: NodeJS.ProcessEnv = process.env,
): boolean {
  return input.REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY === "1";
}

export function isHostedCodexFailoverEnabled(
  input: NodeJS.ProcessEnv = process.env,
): boolean {
  return input.REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER === "1";
}

export function isCodexRotatingOAuthAllowedForRepository(
  repositoryFullName: string,
  input: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isCodexRotatingOAuthEnabled(input)) {
    return false;
  }
  const allowlist = parseCodexRotatingOAuthRepositoryAllowlist(
    input.REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES,
  );
  if (allowlist.length === 0) {
    return true;
  }
  const normalizedRepository = normalizeRepositoryFullName(
    repositoryFullName,
    "REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES",
  );
  return allowlist.includes(normalizedRepository);
}

export function isCodexRotatingOAuthAllowedForWorkspaceDefault(
  input: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isCodexRotatingOAuthEnabled(input)) {
    return false;
  }
  return (
    parseCodexRotatingOAuthRepositoryAllowlist(
      input.REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES,
    ).length === 0
  );
}

export function parseCodexRotatingOAuthRepositoryAllowlist(
  value: string | undefined,
): readonly string[] {
  return parseRepositoryAllowlist(
    value,
    "REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES",
  );
}

export type GitHubAppPrivateKeyEnv = {
  readonly GITHUB_APP_PRIVATE_KEY?: string | undefined;
  readonly GITHUB_APP_PRIVATE_KEY_FILE?: string | undefined;
  readonly [key: string]: string | undefined;
};

export function readGitHubAppPrivateKey(
  input: GitHubAppPrivateKeyEnv = process.env,
): string | null {
  const inlineKey = input.GITHUB_APP_PRIVATE_KEY?.trim();
  if (inlineKey) {
    return normalizePrivateKey(inlineKey);
  }

  const privateKeyFile = input.GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  if (!privateKeyFile) {
    return null;
  }

  return readFileSync(privateKeyFile, "utf8");
}

export function requireGitHubAppPrivateKey(
  input: GitHubAppPrivateKeyEnv = process.env,
): string {
  const privateKey = readGitHubAppPrivateKey(input);
  if (!privateKey) {
    throw new Error("missing_env:GITHUB_APP_PRIVATE_KEY");
  }
  return privateKey;
}

function normalizePrivateKey(value: string): string {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

function normalizeRepositoryFullName(
  repositoryFullName: string,
  envName: string,
): string {
  const normalized = repositoryFullName.trim().toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/.test(
      normalized,
    )
  ) {
    throw new Error(`invalid_env:${envName}`);
  }
  return normalized;
}

function normalizeFullShaActionRef(actionRef: string, envName: string): string {
  const normalized = actionRef.trim().toLowerCase();
  if (!isFullShaActionRef(normalized)) {
    throw new Error(`invalid_env:${envName}`);
  }
  return normalized;
}

function parseFullShaActionRefList(
  value: string | undefined,
  envName: string,
): readonly string[] {
  const raw = value?.trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(/[\s,]+/)
    .map((ref) => normalizeFullShaActionRef(ref, envName))
    .filter((ref) => ref.length > 0);
}

function actionRefRepository(actionRef: string): string {
  return actionRef.slice(0, actionRef.lastIndexOf("@"));
}

function isFullShaActionRef(actionRef: string): boolean {
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[a-f0-9]{40}$/i.test(actionRef.trim());
}
