import { readFileSync } from "node:fs";
import { z } from "zod";

export const REVIEW_ROUTER_ACTION_REPOSITORY = "777genius/review-router";
export const DEFAULT_REVIEW_ROUTER_ACTION_VERSION = "v1";

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
    .default("0"),
  REVIEW_ROUTER_ENABLE_CLAUDE_CODE_PROVIDER: z.enum(["0", "1"]).default("1"),
  REVIEW_ROUTER_DEFAULT_MODEL: z.string().default("gpt-5.5"),
  REVIEW_ROUTER_DEFAULT_EFFORT: z
    .enum(["low", "medium", "high", "xhigh"])
    .default("medium"),
});

export type RuntimeEnv = z.infer<typeof runtimeEnvSchema>;

type ReviewRouterActionRefEnv = {
  readonly REVIEW_ROUTER_ACTION_REF?: string | undefined;
  readonly REVIEW_ROUTER_ACTION_VERSION?: string | undefined;
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
  return input.REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK === "1";
}

export function isClaudeCodeProviderEnabled(
  input: NodeJS.ProcessEnv = process.env,
): boolean {
  return input.REVIEW_ROUTER_ENABLE_CLAUDE_CODE_PROVIDER !== "0";
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
