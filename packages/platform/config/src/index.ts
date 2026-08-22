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
  REVIEW_ROUTER_HOSTED_POOL_ACTION_TAG: z.string().optional(),
  REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA: z.string().optional(),
  REVIEW_ROUTER_HOSTED_POOL_ACTION_DIST_SHA256: z.string().optional(),
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
  readonly REVIEW_ROUTER_HOSTED_POOL_ACTION_TAG?: string | undefined;
  readonly REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA?: string | undefined;
  readonly REVIEW_ROUTER_HOSTED_POOL_ACTION_DIST_SHA256?: string | undefined;
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

export type HostedPoolActionRelease = Readonly<{
  repository: typeof REVIEW_ROUTER_ACTION_REPOSITORY;
  tag: string;
  commitSha: string;
  distSha256: string;
  actionRef: string;
}>;

export type HostedCodexRuntimeRole = "api" | "web" | "worker";

const hostedCodexRuntimeRoleArnName =
  "REVIEW_ROUTER_HOSTED_CODEX_AWS_ROLE_ARN" as const;

const hostedCodexFlagOrder = [
  "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL",
  "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY",
  "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION",
  "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY",
  "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER",
] as const;
const hostedCodexFlagDependencies = Object.freeze({
  REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY:
    "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL",
  REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION:
    "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY",
  REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY:
    "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY",
  REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER:
    "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY",
} as const);

/** Fail-closed, side-effect-free startup validation for each hosted role. */
export function assertHostedCodexProductionReadiness(
  input: ReviewRouterActionRefEnv,
  runtimeRole?: HostedCodexRuntimeRole,
): void {
  const values = hostedCodexFlagOrder.map((name) => input[name]?.trim() ?? "0");
  for (let index = 0; index < values.length; index += 1) {
    if (!["0", "1"].includes(values[index]!)) {
      throw new Error(`invalid_env:${hostedCodexFlagOrder[index]}`);
    }
    const name = hostedCodexFlagOrder[index]!;
    const dependency =
      hostedCodexFlagDependencies[
        name as keyof typeof hostedCodexFlagDependencies
      ];
    if (
      dependency &&
      values[index] === "1" &&
      input[dependency]?.trim() !== "1"
    )
      throw new Error(`hosted_codex_flag_dependency:${name}`);
  }
  if (!values.includes("1")) return;
  if (input.NODE_ENV !== "production") return;
  const role = runtimeRole ?? input.REVIEW_ROUTER_RUNTIME_ROLE?.trim();
  if (!role || !["api", "web", "worker"].includes(role)) {
    throw new Error("hosted_codex_runtime_role_invalid");
  }
  if (role === "worker") throw new Error("hosted_codex_worker_role_forbidden");
  resolveHostedPoolActionRelease(input);
  if (values[1] !== "1") return;
  if (
    input.REVIEW_ROUTER_HOSTED_CODEX_KEYRING_MODE?.trim() !== "external_kms"
  ) {
    throw new Error("hosted_codex_external_kms_required");
  }
  const expectedKmsRole = role === "api" ? "relay" : "enrollment";
  if (input.REVIEW_ROUTER_HOSTED_CODEX_KMS_ROLE?.trim() !== expectedKmsRole) {
    throw new Error("hosted_codex_kms_role_mismatch");
  }
  const roleArn = input[hostedCodexRuntimeRoleArnName]?.trim() ?? "";
  if (
    !/^arn:(?:aws|aws-us-gov|aws-cn):iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/u.test(
      roleArn,
    )
  ) {
    throw new Error("hosted_codex_aws_role_arn_invalid");
  }
  const keyArn = input.REVIEW_ROUTER_HOSTED_CODEX_KMS_KEY_ARN?.trim() ?? "";
  const keyArnMatch =
    /^arn:(?:aws|aws-us-gov|aws-cn):kms:([a-z0-9-]+):\d{12}:key\/(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/iu.exec(
      keyArn,
    );
  if (!keyArnMatch) {
    throw new Error("hosted_codex_aws_kms_key_id_invalid");
  }
  const region = input.AWS_REGION?.trim() ?? "";
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(region)) {
    throw new Error("hosted_codex_aws_kms_region_invalid");
  }
  if (keyArnMatch[1]?.toLowerCase() !== region.toLowerCase()) {
    throw new Error("hosted_codex_aws_kms_region_mismatch");
  }
  if (
    !/^render:postgres:dpg-[a-z0-9-]{8,}$/u.test(
      input.REVIEW_ROUTER_HOSTED_CODEX_DATABASE_RESOURCE_IDENTITY?.trim() ?? "",
    )
  ) {
    throw new Error("hosted_codex_database_resource_identity_invalid");
  }
  if (
    !/^[A-Za-z0-9_-]{22,128}$/u.test(
      input.REVIEW_ROUTER_HOSTED_CODEX_DATABASE_INCARNATION?.trim() ?? "",
    )
  ) {
    throw new Error("hosted_codex_database_incarnation_invalid");
  }
  requireCanonicalBase64Secret(
    input.REVIEW_ROUTER_HOSTED_CODEX_FINGERPRINT_PEPPER,
    "hosted_codex_fingerprint_pepper_invalid",
  );
  if (role === "api" && values[2] === "1") {
    requireCanonicalBase64Secret(
      input.REVIEW_ROUTER_HOSTED_CODEX_CAPABILITY_HMAC_KEY,
      "hosted_codex_capability_hmac_key_invalid",
    );
  }
}

function requireCanonicalBase64Secret(
  value: string | undefined,
  error: string,
) {
  const encoded = value?.trim() ?? "";
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength < 32 || decoded.toString("base64") !== encoded) {
    throw new Error(error);
  }
}

/**
 * Resolves the independently recorded public Action release consumed by the
 * hosted pool. The mutable general Action channel and an unpaired rotating SHA
 * are deliberately insufficient for hosted credential custody.
 */
export function resolveHostedPoolActionRelease(
  input: ReviewRouterActionRefEnv = process.env,
): HostedPoolActionRelease {
  const tag = input.REVIEW_ROUTER_HOSTED_POOL_ACTION_TAG?.trim() ?? "";
  const commitSha =
    input.REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA?.trim().toLowerCase() ?? "";
  const distSha256 =
    input.REVIEW_ROUTER_HOSTED_POOL_ACTION_DIST_SHA256?.trim().toLowerCase() ??
    "";
  if (!/^v[1-9][0-9]*\.[0-9]+\.[0-9]+$/u.test(tag)) {
    throw new Error("invalid_env:REVIEW_ROUTER_HOSTED_POOL_ACTION_TAG");
  }
  if (!/^[a-f0-9]{40}$/u.test(commitSha)) {
    throw new Error("invalid_env:REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA");
  }
  if (!/^[a-f0-9]{64}$/u.test(distSha256)) {
    throw new Error("invalid_env:REVIEW_ROUTER_HOSTED_POOL_ACTION_DIST_SHA256");
  }
  const actionRef = resolveReviewRouterCodexRotatingActionRef(input);
  if (actionRef !== `${REVIEW_ROUTER_ACTION_REPOSITORY}@${commitSha}`) {
    throw new Error("hosted_pool_action_release_ref_mismatch");
  }
  return Object.freeze({
    repository: REVIEW_ROUTER_ACTION_REPOSITORY,
    tag,
    commitSha,
    distSha256,
    actionRef,
  });
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
