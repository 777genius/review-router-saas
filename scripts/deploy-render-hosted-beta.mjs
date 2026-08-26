/* global fetch */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  reviewV2ContextEnvForRole,
  reviewV2ProjectionPolicyVersion,
  reviewV2ProjectionPolicyVersionEnvKey,
} from "./review-v2-render-env.mjs";
import { isLoopbackHostname } from "../packages/shared/src/validation/loopback-hostname.mjs";
import { resolveCodexRotatingInstallerDescriptor } from "../packages/shared/src/validation/codex-rotating-installer-descriptor.mjs";
import { canonicalProviderJson } from "./codex-rotating-provider-provenance.mjs";
import {
  assertTrustedGitHubEvidence,
  fetchTrustedGitHubEvidence,
  gitBlobSha,
} from "./lib/github-actions-trusted-evidence.mjs";

const renderApi = "https://api.render.com/v1";
const roleBootstrapDatabaseUrlEnvironmentName =
  "REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL";
const forbiddenRuntimeDeployDotenvMessage =
  "REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL is forbidden in the runtime deploy environment file";
const dotenvWhitespace = /\s/u;
const dotenvAssignmentNameStart = /[A-Za-z_]/u;
const dotenvAssignmentNamePart = /[A-Za-z0-9_]/u;

function skipDotenvWhitespace(line, start) {
  let offset = start;
  while (offset < line.length && dotenvWhitespace.test(line[offset])) {
    offset += 1;
  }
  return offset;
}

function lexDotenvAssignment(line) {
  const assignmentStart = skipDotenvWhitespace(line, 0);
  if (
    assignmentStart === line.length ||
    line[assignmentStart] === "#" ||
    !dotenvAssignmentNameStart.test(line[assignmentStart])
  ) {
    return null;
  }

  let nameStart = assignmentStart;
  if (
    line.startsWith("export", assignmentStart) &&
    dotenvWhitespace.test(line[assignmentStart + "export".length])
  ) {
    nameStart = skipDotenvWhitespace(line, assignmentStart + "export".length);
    if (
      nameStart === line.length ||
      !dotenvAssignmentNameStart.test(line[nameStart])
    ) {
      return null;
    }
  }

  let offset = nameStart + 1;
  while (offset < line.length && dotenvAssignmentNamePart.test(line[offset])) {
    offset += 1;
  }
  const nameEnd = offset;
  offset = skipDotenvWhitespace(line, offset);
  if (line[offset] !== "=") return null;

  return {
    name: line.slice(nameStart, nameEnd),
    valueStart: offset + 1,
  };
}

function parseDotenv(text, forbiddenNames = new Set()) {
  const values = {};
  for (const rawLine of text.split("\n")) {
    const assignment = lexDotenvAssignment(rawLine);
    if (!assignment) continue;
    if (forbiddenNames.has(assignment.name)) {
      throw new Error(forbiddenRuntimeDeployDotenvMessage);
    }

    let value = rawLine.slice(assignment.valueStart).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[assignment.name] = value.replace(/\\n/g, "\n");
  }
  return values;
}

function readRuntimeDeployDotenv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return parseHostedDeployDotenv(fs.readFileSync(filePath, "utf8"));
}

export function parseHostedDeployDotenv(text) {
  return parseDotenv(text, new Set([roleBootstrapDatabaseUrlEnvironmentName]));
}

export function requiredEnv(name, source) {
  const value = source[name] ?? process.env[name];
  if (!value) throw new Error(`Missing required value: ${name}`);
  return value;
}

const placeholderPattern =
  /(?:replace[-_ ]?with|placeholder|changeme|change[-_ ]?me|example|todo|insert[-_ ]?here)/iu;

const stableSecretNames = Object.freeze([
  "AUTH_SECRET",
  "REVIEW_ROUTER_ACTION_SESSION_SECRET",
  "REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY",
  "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
]);

const installerDescriptorSchema =
  "reviewrouter.codex-rotating-installer-descriptor.v1";
const installerDescriptorEnvironmentNames = Object.freeze([
  "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL",
  "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION",
  "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256",
]);

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertExactObjectKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, i) => key !== wanted[i])
  ) {
    throw new Error(`${label} fields are not canonical`);
  }
}

/**
 * Read the release-produced descriptor only through a separately pinned digest.
 * Keeping the digest outside the file prevents a locally substituted descriptor
 * from selecting its own installer bytes.
 */
export function readVerifiedInstallerReleaseDescriptor(source) {
  const descriptorPath = requiredEnv(
    "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_DESCRIPTOR_FILE",
    source,
  );
  const expectedDigest = requiredEnv(
    "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_DESCRIPTOR_SHA256",
    source,
  );
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) {
    throw new Error(
      "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_DESCRIPTOR_SHA256 must be an exact lowercase SHA-256",
    );
  }
  const bytes = fs.readFileSync(descriptorPath);
  if (sha256Bytes(bytes) !== expectedDigest) {
    throw new Error(
      "immutable rotating installer release descriptor digest mismatch",
    );
  }
  let descriptor;
  try {
    descriptor = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(
      "immutable rotating installer release descriptor is not valid JSON",
    );
  }
  assertExactObjectKeys(
    descriptor,
    ["schemaVersion", "url", "version", "sha256", "actionRef", "reseed"],
    "immutable rotating installer release descriptor",
  );
  assertExactObjectKeys(
    descriptor.reseed,
    ["url", "sha256"],
    "immutable rotating reseed descriptor",
  );
  if (descriptor.schemaVersion !== installerDescriptorSchema) {
    throw new Error(
      "immutable rotating installer release descriptor schema mismatch",
    );
  }
  const actionRef = resolveHostedCodexRotatingActionRef(source);
  if (String(descriptor.actionRef).toLowerCase() !== actionRef) {
    throw new Error(
      "immutable rotating installer release descriptor Action ref mismatch",
    );
  }
  const tupleEnv = {
    ...source,
    REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: actionRef,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL: descriptor.url,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: descriptor.version,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: descriptor.sha256,
  };
  const tuple = resolveCodexRotatingInstallerDescriptor(tupleEnv);
  const actionRepository = actionRef.slice(0, actionRef.lastIndexOf("@"));
  const actionSha = actionRef.slice(actionRef.lastIndexOf("@") + 1);
  const expectedReseedUrl = `https://raw.githubusercontent.com/${actionRepository}/${actionSha}/scripts/reseed-codex-rotating-auth.sh`;
  if (
    descriptor.reseed.url !== expectedReseedUrl ||
    !/^[a-f0-9]{64}$/u.test(descriptor.reseed.sha256)
  ) {
    throw new Error("immutable rotating reseed descriptor mismatch");
  }
  return Object.freeze({
    descriptorPath,
    descriptorSha256: expectedDigest,
    actionRef,
    tuple: Object.freeze(tuple),
  });
}

function installerDescriptorIdentity(value) {
  return JSON.stringify({
    descriptorSha256: value.descriptorSha256,
    actionRef: value.actionRef,
    tuple: value.tuple,
  });
}

function applyInstallerTuple(source, verified) {
  return {
    ...source,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL: verified.tuple.url,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: verified.tuple.version,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: verified.tuple.sha256,
  };
}

export function resolveStableSecuritySecrets(source) {
  return Object.fromEntries(
    stableSecretNames.map((name) => {
      const value =
        name === "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS"
          ? requireDatabaseRecoveryWitness(source)
          : requiredEnv(name, source);
      if (
        value !== value.trim() ||
        value.length < 32 ||
        placeholderPattern.test(value)
      ) {
        throw new Error(
          `${name} must be a stable, non-placeholder secret of at least 32 characters`,
        );
      }
      return [name, value];
    }),
  );
}

function resolveHostedActionRef(source) {
  const actionRef =
    source.REVIEW_ROUTER_ACTION_REF ?? process.env.REVIEW_ROUTER_ACTION_REF;
  if (actionRef) {
    return actionRef;
  }
  const version =
    source.REVIEW_ROUTER_ACTION_VERSION ??
    process.env.REVIEW_ROUTER_ACTION_VERSION ??
    "main";
  return `777genius/review-router@${version}`;
}

export function resolveHostedCodexRotatingActionRef(source) {
  const value = requiredEnv(
    "REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF",
    source,
  ).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/i.test(value)) {
    throw new Error(
      "REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF must be an exact full-SHA Action ref",
    );
  }
  return value.toLowerCase();
}

export function resolveHostedCodexRotatingAllowedActionRefs(source) {
  const primary = resolveHostedCodexRotatingActionRef(source);
  const primaryRepository = primary.slice(0, primary.lastIndexOf("@"));
  const value = String(
    source.REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS ??
      process.env.REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS ??
      "",
  ).trim();
  if (!value) return "";
  const refs = value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((ref) => {
      const normalized = ref.toLowerCase();
      if (
        !/^[a-z0-9_.-]+\/[a-z0-9_.-]+@[a-f0-9]{40}$/.test(normalized) ||
        normalized.slice(0, normalized.lastIndexOf("@")) !== primaryRepository
      ) {
        throw new Error(
          "REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS must contain only same-repository full-SHA Action refs",
        );
      }
      return normalized;
    });
  return [...new Set(refs)].join(",");
}

export function requireDatabaseRecoveryWitness(source) {
  const value = requiredEnv(
    "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
    source,
  ).trim();
  if (
    !/^[A-Za-z0-9_-]{43,256}$/.test(value) ||
    /replace-with|placeholder/i.test(value)
  ) {
    throw new Error(
      "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS must be 43-256 base64url characters",
    );
  }
  return value;
}

const databaseUrlEnvironmentByRole = Object.freeze({
  api: "REVIEW_ROUTER_API_DATABASE_URL",
  web: "REVIEW_ROUTER_WEB_DATABASE_URL",
  worker: "REVIEW_ROUTER_WORKER_DATABASE_URL",
  commentTokenCustody: "REVIEW_ROUTER_COMMENT_TOKEN_CUSTODY_DATABASE_URL",
  codexEffectAuthority: "REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL",
  releaseMigration: "REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL",
});

export function resolveDistinctDatabaseRoleUrls(source) {
  const expectedUsers = {
    api: "reviewrouter_api",
    web: "reviewrouter_web",
    worker: "reviewrouter_worker",
    commentTokenCustody: "reviewrouter_comment_token_custody",
    codexEffectAuthority: "reviewrouter_codex_effect_authority",
    releaseMigration: "reviewrouter_release_migration",
  };
  const urls = {};
  for (const [role, environmentName] of Object.entries(
    databaseUrlEnvironmentByRole,
  )) {
    let parsed;
    try {
      parsed = new URL(requiredEnv(environmentName, source));
    } catch {
      throw new Error(`${environmentName} must be a PostgreSQL URL`);
    }
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      decodeURIComponent(parsed.username) !== expectedUsers[role] ||
      !parsed.password
    ) {
      throw new Error(
        `${environmentName} must authenticate as ${expectedUsers[role]}`,
      );
    }
    urls[role] = parsed.toString();
  }
  const identities = Object.values(urls).map(normalizedDatabaseIdentity);
  if (new Set(identities).size !== 1) {
    throw new Error("all database roles must target one database generation");
  }
  const credentials = Object.values(urls).map((value) => {
    const parsed = new URL(value);
    return `${decodeURIComponent(parsed.username)}\0${decodeURIComponent(parsed.password)}`;
  });
  const passwords = Object.values(urls).map((value) =>
    decodeURIComponent(new URL(value).password),
  );
  if (new Set(credentials).size !== 6 || new Set(passwords).size !== 6) {
    throw new Error("database role credentials must be distinct");
  }
  return urls;
}

export function normalizedDatabaseIdentity(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("database connection must be a PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("database connection must be a PostgreSQL URL");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!databaseName || databaseName.includes("/")) {
    throw new Error("database connection must select exactly one database");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  return `${hostname}:${parsed.port || "5432"}/${databaseName}`;
}

export function assertSelectedDatabaseIdentity(
  selectedConnection,
  databaseUrls,
) {
  const selected = normalizedDatabaseIdentity(selectedConnection);
  for (const [role, value] of Object.entries(databaseUrls)) {
    if (normalizedDatabaseIdentity(value) !== selected) {
      throw new Error(
        `selected Render database identity does not match ${databaseUrlEnvironmentByRole[role]}`,
      );
    }
  }
  return selected;
}

function resourceValue(value) {
  return (
    value?.service ??
    value?.postgres ??
    value?.resource ??
    value?.environment ??
    value?.project ??
    value
  );
}

function identityId(value) {
  return typeof value === "string" ? value : value?.id;
}

export function observedRenderScope(value) {
  const resource = resourceValue(value) ?? {};
  return {
    ownerId: identityId(resource.ownerId ?? resource.owner),
    projectId: identityId(resource.projectId ?? resource.project),
    environmentId: identityId(resource.environmentId ?? resource.environment),
  };
}

export function assertExactRenderScope(value, expected, label) {
  const observed = observedRenderScope(value);
  for (const key of ["ownerId", "environmentId"]) {
    if (!observed[key] || observed[key] !== expected[key]) {
      throw new Error(`Render ${label} ${key} does not match requested scope`);
    }
  }
  if (observed.projectId && observed.projectId !== expected.projectId) {
    throw new Error(`Render ${label} projectId does not match requested scope`);
  }
  return resourceValue(value);
}

export async function verifyControlPlaneScope(client, expected) {
  const project = resourceValue(
    await client.request("GET", `/projects/${expected.projectId}`),
  );
  if (identityId(project?.ownerId ?? project?.owner) !== expected.ownerId) {
    throw new Error("Render project ownerId does not match requested scope");
  }
  const environment = resourceValue(
    await client.request("GET", `/environments/${expected.environmentId}`),
  );
  if (
    identityId(environment?.ownerId ?? environment?.owner) !==
      expected.ownerId ||
    identityId(environment?.projectId ?? environment?.project) !==
      expected.projectId
  ) {
    throw new Error(
      "Render environment does not match requested owner/project scope",
    );
  }
}

function readRenderApiKey() {
  if (process.env.RENDER_API_KEY) return process.env.RENDER_API_KEY;
  const keyPath = path.join(
    process.env.HOME ?? "",
    ".config/review-router/render-api-key",
  );
  if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath, "utf8").trim();
  throw new Error(
    "Missing RENDER_API_KEY or ~/.config/review-router/render-api-key",
  );
}

function readGithubPrivateKey(env) {
  if (env.GITHUB_APP_PRIVATE_KEY) return env.GITHUB_APP_PRIVATE_KEY;
  const keyFile =
    env.GITHUB_APP_PRIVATE_KEY_FILE ?? process.env.GITHUB_APP_PRIVATE_KEY_FILE;
  if (keyFile) return fs.readFileSync(keyFile, "utf8");
  throw new Error(
    "Missing GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE",
  );
}

function assertHostedUrl(name, value) {
  if (!value) throw new Error(`${name} is required for hosted deployment`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a canonical public HTTPS origin`);
  }
  if (
    url.protocol !== "https:" ||
    isLoopbackHostname(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(`${name} must be a canonical public HTTPS origin`);
  }
}

export function assertHostedDeployEnv({ apiUrl, env, envFile, webUrl }) {
  // URL identity is security-sensitive workflow input and is never bypassed,
  // including staging deploys using REVIEW_ROUTER_ALLOW_LOCAL_DEPLOY_ENV.
  assertHostedUrl("REVIEW_ROUTER_WEB_URL", webUrl);
  assertHostedUrl("REVIEW_ROUTER_API_URL", apiUrl);
  if (env.NEXTAUTH_URL) assertHostedUrl("NEXTAUTH_URL", env.NEXTAUTH_URL);

  if (env.REVIEW_ROUTER_ALLOW_LOCAL_DEPLOY_ENV === "1") return;

  const appSlug = String(env.GITHUB_APP_SLUG ?? "");
  const issues = [];
  if (path.basename(envFile) === ".env.local") {
    issues.push("deployment env file is .env.local");
  }
  if (appSlug.toLowerCase().includes("local")) {
    issues.push("GITHUB_APP_SLUG looks local");
  }

  if (issues.length > 0) {
    throw new Error(
      [
        "Refusing hosted Render deploy with local-looking configuration.",
        ...issues.map((issue) => `- ${issue}`),
        "Use REVIEW_ROUTER_RENDER_RUNTIME_DEPLOY_ENV_FILE with a dedicated runtime-deploy file or set REVIEW_ROUTER_ALLOW_LOCAL_DEPLOY_ENV=1 only for an intentional staging deploy.",
      ].join("\n"),
    );
  }
}

function asEnvVars(values) {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value: String(value),
  }));
}

const apiOnlyGitLabEnvKeys = [
  "REVIEW_ROUTER_GITLAB_API_TOKEN",
  "REVIEW_ROUTER_GITLAB_API_BASE_URL",
  "REVIEW_ROUTER_GITLAB_INSTALLER_TOKEN",
  "REVIEW_ROUTER_GITLAB_INSTALLER_ADMIN_TOKEN",
  "REVIEW_ROUTER_GITLAB_STATIC_REPOSITORIES_JSON",
  "REVIEW_ROUTER_GITLAB_OIDC_ISSUER",
  "REVIEW_ROUTER_GITLAB_OIDC_JWKS_URL",
  "REVIEW_ROUTER_GITLAB_OIDC_AUDIENCE",
  "REVIEW_ROUTER_GITLAB_RUNTIME_IMAGE",
];

function readOptionalEnvVars(env, keys) {
  const values = {};
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && String(value).trim() !== "") {
      values[key] = value;
    }
  }
  return values;
}

const hostedPoolFlags = Object.freeze([
  "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL",
  "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY",
  "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION",
  "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY",
  "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER",
]);

export function hostedPoolRuntimeEnvForRole(env, role) {
  const release = {
    REVIEW_ROUTER_HOSTED_POOL_ACTION_TAG: requiredEnv(
      "REVIEW_ROUTER_HOSTED_POOL_ACTION_TAG",
      env,
    ),
    REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA: requiredEnv(
      "REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA",
      env,
    ).toLowerCase(),
    REVIEW_ROUTER_HOSTED_POOL_ACTION_DIST_SHA256: requiredEnv(
      "REVIEW_ROUTER_HOSTED_POOL_ACTION_DIST_SHA256",
      env,
    ).toLowerCase(),
  };
  if (
    !/^v[1-9][0-9]*\.[0-9]+\.[0-9]+$/u.test(
      release.REVIEW_ROUTER_HOSTED_POOL_ACTION_TAG,
    )
  )
    throw new Error("hosted pool Action tag must be immutable semver");
  if (!/^[a-f0-9]{40}$/u.test(release.REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA))
    throw new Error("hosted pool Action SHA must be a full commit");
  if (
    !/^[a-f0-9]{64}$/u.test(
      release.REVIEW_ROUTER_HOSTED_POOL_ACTION_DIST_SHA256,
    )
  )
    throw new Error("hosted pool Action dist digest must be SHA-256");
  if (
    resolveHostedCodexRotatingActionRef(env) !==
    `777genius/review-router@${release.REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA}`
  ) {
    throw new Error(
      "hosted pool Action release does not match the consumed ref",
    );
  }

  // Runtime deploy convergence is always dormant. Hosted-pool activation is a
  // separate observed operation through hosted-pool:control.
  for (const name of hostedPoolFlags) exactBinaryFlag(env, name);
  const flags = Object.fromEntries(hostedPoolFlags.map((name) => [name, "0"]));
  if (role === "worker") return { ...release, ...flags };
  const roleArns = ["RELAY", "ENROLLMENT", "RECOVERY"].map((purpose) =>
    requiredEnv(`REVIEW_ROUTER_HOSTED_CODEX_${purpose}_AWS_ROLE_ARN`, env),
  );
  if (
    roleArns.some(
      (arn) =>
        !/^arn:(?:aws|aws-us-gov|aws-cn):iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/u.test(
          arn,
        ),
    ) ||
    new Set(roleArns).size !== roleArns.length
  ) {
    throw new Error(
      "hosted pool relay, enrollment, and recovery roles must be distinct immutable ARNs",
    );
  }
  const purpose = role === "api" ? "RELAY" : "ENROLLMENT";
  const roleArn = requiredEnv(
    `REVIEW_ROUTER_HOSTED_CODEX_${purpose}_AWS_ROLE_ARN`,
    env,
  );
  if (Object.hasOwn(env, "REVIEW_ROUTER_HOSTED_CODEX_AWS_ROLE_ARN")) {
    throw new Error(
      "runtime-only hosted pool role ARN must not be supplied by deploy source",
    );
  }
  if (Object.hasOwn(env, "AWS_WEB_IDENTITY_TOKEN_FILE")) {
    throw new Error(
      "Render-managed AWS web identity token path must not be supplied by deploy source",
    );
  }
  const kmsKeyArn = requiredEnv("REVIEW_ROUTER_HOSTED_CODEX_KMS_KEY_ARN", env);
  const awsRegion = requiredEnv("AWS_REGION", env);
  const kmsRegion =
    /^arn:(?:aws|aws-us-gov|aws-cn):kms:([a-z0-9-]+):\d{12}:key\/(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/iu.exec(
      kmsKeyArn,
    )?.[1];
  if (!kmsRegion || kmsRegion.toLowerCase() !== awsRegion.toLowerCase()) {
    throw new Error("hosted pool KMS key ARN and AWS region must match");
  }
  return {
    ...release,
    ...flags,
    REVIEW_ROUTER_HOSTED_CODEX_KEYRING_MODE: "external_kms",
    REVIEW_ROUTER_HOSTED_CODEX_KMS_ROLE: purpose.toLowerCase(),
    REVIEW_ROUTER_HOSTED_CODEX_AWS_ROLE_ARN: roleArn,
    AWS_ROLE_ARN: roleArn,
    REVIEW_ROUTER_HOSTED_CODEX_KMS_KEY_ARN: kmsKeyArn,
    AWS_REGION: awsRegion,
    REVIEW_ROUTER_HOSTED_CODEX_DATABASE_RESOURCE_IDENTITY: requiredEnv(
      "REVIEW_ROUTER_HOSTED_CODEX_DATABASE_RESOURCE_IDENTITY",
      env,
    ),
    REVIEW_ROUTER_HOSTED_CODEX_DATABASE_INCARNATION: requiredEnv(
      "REVIEW_ROUTER_HOSTED_CODEX_DATABASE_INCARNATION",
      env,
    ),
    REVIEW_ROUTER_HOSTED_CODEX_FINGERPRINT_PEPPER: requiredEnv(
      "REVIEW_ROUTER_HOSTED_CODEX_FINGERPRINT_PEPPER",
      env,
    ),
    ...(role === "api"
      ? {
          REVIEW_ROUTER_HOSTED_CODEX_CAPABILITY_HMAC_KEY: requiredEnv(
            "REVIEW_ROUTER_HOSTED_CODEX_CAPABILITY_HMAC_KEY",
            env,
          ),
        }
      : {}),
  };
}

export const reviewV2ActivationFlagNames = Object.freeze([
  "REVIEW_ROUTER_REVIEW_V2_DIRECT_INITIALIZATION_ENABLED",
  "REVIEW_ROUTER_REVIEW_V2_RUN_CONTROL_ENABLED",
  "REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED",
  "REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED",
  "REVIEW_ROUTER_REVIEW_V2_INTENT_ADMISSION_REQUIRED",
  "REVIEW_ROUTER_REVIEW_V2_WORKFLOW_DISPATCH_READY",
  "REVIEW_ROUTER_OUTBOX_FENCED_TAKEOVER_ENABLED",
]);

export const reviewV2RequiredRuntimeEnvNames = Object.freeze([
  "REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_ACTIVE_KEY_ID",
  "REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON",
  "REVIEW_ROUTER_REVIEW_V2_CAPABILITY_ACTIVE_KEY_ID",
  "REVIEW_ROUTER_REVIEW_V2_CAPABILITY_KEYS_JSON",
  "REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON",
  "REVIEW_ROUTER_REVIEW_V2_PROVIDER_VOTE_LANES_JSON",
]);

export const reviewV2ApiOnlyRuntimeEnvNames = Object.freeze([
  "REVIEW_ROUTER_REVIEW_V2_CONTEXT_SESSION_SECRET_BASE64",
  "REVIEW_ROUTER_REVIEW_V2_CONTEXT_REPLAY_ACTIVE_KEY_ID",
  "REVIEW_ROUTER_REVIEW_V2_CONTEXT_REPLAY_KEYS_JSON",
  "REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL_SHA256",
]);

export const reviewV2SharedRuntimeEnvNames = Object.freeze([
  ...reviewV2ActivationFlagNames,
  "REVIEW_ROUTER_REVIEW_V2_WORKFLOW_PROVISIONING_MODE",
  ...reviewV2RequiredRuntimeEnvNames,
  reviewV2ProjectionPolicyVersionEnvKey,
]);

function reviewV2RuntimeActive(env) {
  return (
    env.REVIEW_ROUTER_REVIEW_V2_RUN_CONTROL_ENABLED === "1" ||
    env.REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED === "1" ||
    env.REVIEW_ROUTER_PROGRESS_PROJECTION_CAPTURE === "1" ||
    env.REVIEW_ROUTER_PROGRESS_FILE_COVERAGE === "1" ||
    env.REVIEW_ROUTER_HOSTED_PROGRESS_COMMENT_WRITES === "1"
  );
}

export function assertReviewV2ApiWorkerEnvConvergence(apiEnv, workerEnv) {
  for (const key of reviewV2SharedRuntimeEnvNames) {
    if (apiEnv[key] !== workerEnv[key]) {
      throw new Error(`Review v2 API/worker environment drift for ${key}`);
    }
  }
  const operatorKey = "REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL_SHA256";
  if (Object.hasOwn(workerEnv, operatorKey)) {
    throw new Error(
      `Review v2 worker environment contains API-only ${operatorKey}`,
    );
  }
  if (reviewV2RuntimeActive(workerEnv)) {
    for (const key of [
      "REVIEW_ROUTER_REVIEW_V2_PROVIDER_VOTE_LANES_JSON",
      reviewV2ProjectionPolicyVersionEnvKey,
    ]) {
      if (!workerEnv[key]) {
        throw new Error(
          `active Review v2 worker environment is missing ${key}`,
        );
      }
    }
  }
}

function exactBinaryFlag(env, name) {
  const value = requiredEnv(name, env);
  if (value !== "0" && value !== "1") {
    throw new Error(`${name} must be exactly 0 or 1`);
  }
  return value;
}

function reviewV2RuntimeEnvForRole(env, role) {
  // These two flags already exist in the hosted production contract. Requiring
  // them prevents a full Render PUT from silently turning an active rollout off.
  const runControlEnabled = exactBinaryFlag(
    env,
    "REVIEW_ROUTER_REVIEW_V2_RUN_CONTROL_ENABLED",
  );
  const workerEnabled = exactBinaryFlag(
    env,
    "REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED",
  );
  const progressEnabled = [
    "REVIEW_ROUTER_PROGRESS_PROJECTION_CAPTURE",
    "REVIEW_ROUTER_PROGRESS_FILE_COVERAGE",
    "REVIEW_ROUTER_HOSTED_PROGRESS_COMMENT_WRITES",
  ].some((name) => env[name] === "1");
  const active =
    runControlEnabled === "1" || workerEnabled === "1" || progressEnabled;

  if (!active) {
    return {
      REVIEW_ROUTER_REVIEW_V2_RUN_CONTROL_ENABLED: runControlEnabled,
      REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED: workerEnabled,
    };
  }

  const flags = Object.fromEntries(
    reviewV2ActivationFlagNames.map((name) => [
      name,
      name === "REVIEW_ROUTER_REVIEW_V2_RUN_CONTROL_ENABLED"
        ? runControlEnabled
        : name === "REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED"
          ? workerEnabled
          : exactBinaryFlag(env, name),
    ]),
  );
  const provisioningMode = requiredEnv(
    "REVIEW_ROUTER_REVIEW_V2_WORKFLOW_PROVISIONING_MODE",
    env,
  );
  if (provisioningMode !== "client_triggered_t0") {
    throw new Error(
      "REVIEW_ROUTER_REVIEW_V2_WORKFLOW_PROVISIONING_MODE must be client_triggered_t0",
    );
  }

  const common = Object.fromEntries(
    reviewV2RequiredRuntimeEnvNames.map((name) => [
      name,
      requiredEnv(name, env),
    ]),
  );
  const selected = {
    ...flags,
    REVIEW_ROUTER_REVIEW_V2_WORKFLOW_PROVISIONING_MODE: provisioningMode,
    ...common,
  };
  if (role === "api") {
    Object.assign(
      selected,
      Object.fromEntries(
        reviewV2ApiOnlyRuntimeEnvNames.map((name) => [
          name,
          requiredEnv(name, env),
        ]),
      ),
    );
  }
  return selected;
}

export class RenderClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async request(method, endpoint, body) {
    const response = await fetch(`${renderApi}${endpoint}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!response.ok) {
      throw new Error(`${method} ${endpoint} failed ${response.status}`);
    }
    return data;
  }

  async list(endpoint) {
    const data = await this.request(
      "GET",
      `${endpoint}${endpoint.includes("?") ? "&" : "?"}limit=100`,
    );
    return Array.isArray(data) ? data : [];
  }
}

export function serviceDetails({ type, healthCheckPath }) {
  const details = {
    maxShutdownDelaySeconds: type === "background_worker" ? 120 : 60,
    plan: "starter",
    // Database rollout runs in the trusted GitHub migration workflow.
    // Runtime services must represent per-service migration callers as null.
    preDeployCommand: null,
    region: "frankfurt",
    runtime: "image",
  };
  if (type === "web_service") details.healthCheckPath = healthCheckPath;
  return details;
}

export function buildServiceEnv({
  databaseUrl,
  databaseUrls,
  env,
  privateKey,
  role,
  webUrl,
  apiUrl,
}) {
  const runtimeGeneration = resolveRuntimeGenerationProofEnv(env);
  const stableSecrets = resolveStableSecuritySecrets(env);
  const installer = resolveCodexRotatingInstallerDescriptor(env);
  const values = {
    AUTH_SECRET: stableSecrets.AUTH_SECRET,
    AUTH_TRUST_HOST: "true",
    DATABASE_URL: databaseUrl,
    GITHUB_APP_CLIENT_ID: requiredEnv("GITHUB_APP_CLIENT_ID", env),
    GITHUB_APP_CLIENT_SECRET: requiredEnv("GITHUB_APP_CLIENT_SECRET", env),
    GITHUB_APP_ID: requiredEnv("GITHUB_APP_ID", env),
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: requiredEnv("GITHUB_APP_SLUG", env),
    GITHUB_CLIENT_ID:
      env.GITHUB_CLIENT_ID ?? requiredEnv("GITHUB_APP_CLIENT_ID", env),
    GITHUB_CLIENT_SECRET:
      env.GITHUB_CLIENT_SECRET ?? requiredEnv("GITHUB_APP_CLIENT_SECRET", env),
    GITHUB_WEBHOOK_SECRET: requiredEnv("GITHUB_WEBHOOK_SECRET", env),
    NODE_ENV: "production",
    NODE_VERSION: "24",
    REVIEW_ROUTER_ACTION_REF: resolveHostedActionRef(env),
    REVIEW_ROUTER_ALLOWED_ACTION_REFS:
      env.REVIEW_ROUTER_ALLOWED_ACTION_REFS ?? "",
    REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
      resolveHostedCodexRotatingActionRef(env),
    REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS:
      resolveHostedCodexRotatingAllowedActionRefs(env),
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL: installer.url,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: installer.version,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: installer.sha256,
    REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS:
      stableSecrets.REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS,
    REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256:
      runtimeGeneration.expectedWitnessSha256,
    REVIEW_ROUTER_RUNTIME_ROLLOUT_ID: runtimeGeneration.rolloutId,
    REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA: runtimeGeneration.commitSha,
    REVIEW_ROUTER_RUNTIME_ROLLOUT_STARTED_AT: runtimeGeneration.startedAt,
    ...(role === "api"
      ? {
          REVIEW_ROUTER_LIVE_CANARY_TOKEN_SHA256: requiredEnv(
            "REVIEW_ROUTER_LIVE_CANARY_TOKEN_SHA256",
            env,
          ),
        }
      : {}),
    REVIEW_ROUTER_ACTION_OIDC_AUDIENCE: "reviewrouter",
    REVIEW_ROUTER_ACTION_SESSION_SECRET:
      stableSecrets.REVIEW_ROUTER_ACTION_SESSION_SECRET,
    REVIEW_ROUTER_API_URL: apiUrl,
    REVIEW_ROUTER_DEFAULT_EFFORT: env.REVIEW_ROUTER_DEFAULT_EFFORT ?? "xhigh",
    REVIEW_ROUTER_DEFAULT_MODEL:
      env.REVIEW_ROUTER_DEFAULT_MODEL ?? "gpt-5.6-sol",
    REVIEW_ROUTER_DISABLE_ACTION_CONTROL_PLANE: "0",
    REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "0",
    REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS: "1",
    REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK:
      env.REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK ?? "1",
    // Deploy convergence is always dormant. Cutover is a separate observed
    // operation and stale local/example values are intentionally ignored.
    REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "0",
    REVIEW_ROUTER_CODEX_ROTATING_NEW_WORK_ADMISSION_ENABLED: "0",
    REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "1",
    REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES:
      env.REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES ?? "",
    REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED: "0",
    REVIEW_ROUTER_CONFLICT_REVIEW_FALLBACK_REPOSITORIES:
      env.REVIEW_ROUTER_CONFLICT_REVIEW_FALLBACK_REPOSITORIES ?? "",
    REVIEW_ROUTER_MAX_REPOSITORIES_PER_SYNC: "250",
    REVIEW_ROUTER_OUTBOX_BATCH_SIZE: "25",
    REVIEW_ROUTER_OUTBOX_PROCESSING_STALE_MS: "900000",
    REVIEW_ROUTER_PROGRESS_FILE_COVERAGE:
      env.REVIEW_ROUTER_PROGRESS_FILE_COVERAGE ?? "0",
    REVIEW_ROUTER_PROGRESS_PROJECTION_CAPTURE:
      env.REVIEW_ROUTER_PROGRESS_PROJECTION_CAPTURE ?? "0",
    REVIEW_ROUTER_PROGRESS_REPOSITORIES:
      env.REVIEW_ROUTER_PROGRESS_REPOSITORIES ?? "",
    REVIEW_ROUTER_HOSTED_PROGRESS_COMMENT_WRITES:
      env.REVIEW_ROUTER_HOSTED_PROGRESS_COMMENT_WRITES ?? "0",
    REVIEW_ROUTER_PUBLIC_API_URL: apiUrl,
    REVIEW_ROUTER_RUNTIME_ROLE: role,
    REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY:
      stableSecrets.REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY,
    REVIEW_ROUTER_WEB_URL: webUrl,
    REVIEW_ROUTER_WORKER_BUSY_MS: "250",
    REVIEW_ROUTER_WORKER_ERROR_MS: "5000",
    REVIEW_ROUTER_WORKER_IDLE_MS: "5000",
  };
  if (role === "api" || role === "web") {
    const authorityDatabaseUrl =
      databaseUrls?.codexEffectAuthority ??
      env.REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL;
    if (authorityDatabaseUrl) {
      values.REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL =
        authorityDatabaseUrl;
    }
  }
  // Provision custody authority while the runtime is deliberately dormant so
  // the later control-plane-only activation does not depend on another deploy.
  if (role === "api") {
    const custodyDatabaseUrl =
      databaseUrls?.commentTokenCustody ??
      env.REVIEW_ROUTER_COMMENT_TOKEN_CUSTODY_DATABASE_URL;
    if (!custodyDatabaseUrl)
      throw new Error(
        "Missing required value: REVIEW_ROUTER_COMMENT_TOKEN_CUSTODY_DATABASE_URL",
      );
    values.REVIEW_ROUTER_COMMENT_TOKEN_CUSTODY_DATABASE_URL =
      custodyDatabaseUrl;
  }
  if (role === "api") {
    Object.assign(values, readOptionalEnvVars(env, apiOnlyGitLabEnvKeys));
  }
  Object.assign(values, reviewV2RuntimeEnvForRole(env, role));
  Object.assign(values, reviewV2ContextEnvForRole(env, role));
  Object.assign(values, hostedPoolRuntimeEnvForRole(env, role));
  if (
    values.REVIEW_ROUTER_REVIEW_V2_RUN_CONTROL_ENABLED === "1" ||
    values.REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED === "1" ||
    values.REVIEW_ROUTER_PROGRESS_PROJECTION_CAPTURE === "1" ||
    values.REVIEW_ROUTER_PROGRESS_FILE_COVERAGE === "1" ||
    values.REVIEW_ROUTER_HOSTED_PROGRESS_COMMENT_WRITES === "1"
  ) {
    values.REVIEW_ROUTER_REVIEW_V2_PROJECTION_POLICY_VERSION =
      reviewV2ProjectionPolicyVersion;
  }
  Object.assign(values, {
    REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED: "0",
    REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED: "0",
    REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED: "0",
  });
  if (role !== "worker") values.PORT = "10000";
  return asEnvVars(values);
}

function resolveRuntimeGenerationProofEnv(env) {
  const expectedWitnessSha256 = requiredEnv(
    "REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256",
    env,
  );
  const rolloutId = requiredEnv("REVIEW_ROUTER_RUNTIME_ROLLOUT_ID", env);
  const commitSha = requiredEnv(
    "REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA",
    env,
  );
  const startedAt = requiredEnv(
    "REVIEW_ROUTER_RUNTIME_ROLLOUT_STARTED_AT",
    env,
  );
  if (
    !/^[a-f0-9]{64}$/u.test(expectedWitnessSha256) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u.test(rolloutId) ||
    !/^[a-f0-9]{40}$/u.test(commitSha) ||
    new Date(startedAt).toISOString() !== startedAt
  )
    throw new Error("runtime generation proof environment is invalid");
  return { expectedWitnessSha256, rolloutId, commitSha, startedAt };
}

export async function addToEnvironment(client, environmentId, resourceIds) {
  if (!environmentId || resourceIds.length === 0) return;
  const readLinkedIds = async () => {
    const linked = await client.request(
      "GET",
      `/environments/${environmentId}/resources`,
    );
    return new Set(
      (Array.isArray(linked) ? linked : (linked?.resources ?? [])).map((item) =>
        identityId(resourceValue(item)?.id ?? item?.resourceId),
      ),
    );
  };
  let linkedIds = await readLinkedIds();
  const missingIds = resourceIds.filter(
    (resourceId) => !linkedIds.has(resourceId),
  );
  if (missingIds.length > 0) {
    await client.request("POST", `/environments/${environmentId}/resources`, {
      resourceIds: missingIds,
    });
    linkedIds = await readLinkedIds();
  }
  for (const resourceId of resourceIds) {
    if (!linkedIds.has(resourceId)) {
      throw new Error(
        `Render environment link verification failed for ${resourceId}`,
      );
    }
  }
}

export async function ensureDatabase(client, { allowCreate = true, ...scope }) {
  const candidates = (await client.list(`/postgres?ownerId=${scope.ownerId}`))
    .map((item) => item.postgres)
    .filter((postgres) => postgres?.name === "reviewrouter-db");
  const matching = candidates.filter((postgres) => {
    const observed = observedRenderScope(postgres);
    return (
      observed.ownerId === scope.ownerId &&
      observed.environmentId === scope.environmentId &&
      (!observed.projectId || observed.projectId === scope.projectId)
    );
  });
  if (matching.length > 1) {
    throw new Error(
      "multiple Render databases match the exact requested scope",
    );
  }
  const existing = matching[0];
  if (existing) {
    if (!/^17(?:\.|$)/u.test(String(existing.version ?? ""))) {
      throw new Error(
        "existing Render database reviewrouter-db must use PostgreSQL 17",
      );
    }
    return existing;
  }
  if (!allowCreate) {
    throw new Error(
      "runtime-deploy requires an existing database from the prepare phase",
    );
  }

  console.log("creating database reviewrouter-db");
  return await client.request("POST", "/postgres", {
    databaseName: "review_router",
    databaseUser: "reviewrouter_role_bootstrap",
    environmentId: scope.environmentId,
    ipAllowList: [],
    name: "reviewrouter-db",
    ownerId: scope.ownerId,
    projectId: scope.projectId,
    plan: "basic_256mb",
    region: "frankfurt",
    version: "17",
  });
}

async function waitForDatabase(client, databaseId) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const postgres = await client.request("GET", `/postgres/${databaseId}`);
    let connectionInfo;
    try {
      connectionInfo = await client.request(
        "GET",
        `/postgres/${databaseId}/connection-info`,
      );
    } catch {
      connectionInfo = null;
    }
    const status = postgres.status ?? postgres.postgres?.status;
    console.log(
      `database status: ${status}${connectionInfo?.internalConnectionString ? " connection-ready" : ""}`,
    );
    if (connectionInfo?.internalConnectionString) {
      return {
        ...(postgres.postgres ?? postgres),
        internalConnectionString: connectionInfo.internalConnectionString,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw new Error("Timed out waiting for database connection string");
}

export async function ensureService(client, spec, common) {
  const candidates = (await client.list(`/services?ownerId=${common.ownerId}`))
    .map((item) => item.service)
    .filter((service) => service?.name === spec.name);
  const matching = candidates.filter((service) => {
    const observed = observedRenderScope(service);
    return (
      observed.ownerId === common.ownerId &&
      observed.environmentId === common.environmentId &&
      (!observed.projectId || observed.projectId === common.projectId)
    );
  });
  if (matching.length > 1) {
    throw new Error(`multiple Render services named ${spec.name} match scope`);
  }
  const existing = matching[0];
  if (existing) return existing;
  if (common.allowCreate === false) {
    throw new Error(
      `runtime-deploy requires existing service ${spec.name} from the prepare phase`,
    );
  }

  console.log(`creating service ${spec.name}`);
  const created = await client.request("POST", "/services", {
    autoDeployTrigger: "off",
    image: { imagePath: common.imageUrl },
    name: spec.name,
    environmentId: common.environmentId,
    ownerId: common.ownerId,
    projectId: common.projectId,
    serviceDetails: serviceDetails(spec),
    type: spec.type,
  });
  return created.service ?? created;
}

function observedRuntimeImage(service) {
  const value = service.service ?? service;
  const details = value.serviceDetails ?? {};
  return {
    runtime:
      details.runtime ??
      details.env ??
      details.envSpecificDetails?.runtime ??
      null,
    imagePath:
      value.image?.imagePath ??
      value.image?.url ??
      value.imagePath ??
      details.image?.imagePath ??
      details.image?.url ??
      details.imagePath ??
      null,
  };
}

export async function convergeImmutableRuntimeImage(
  client,
  service,
  spec,
  imageUrl,
) {
  if (
    !/^ghcr\.io\/777genius\/review-router-saas-runtime@sha256:[a-f0-9]{64}$/u.test(
      imageUrl,
    )
  ) {
    throw new Error(
      "hosted runtime image must use the canonical GHCR repository and exact digest",
    );
  }
  await client.request("PATCH", `/services/${service.id}`, {
    autoDeployTrigger: "off",
    image: { imagePath: imageUrl },
    serviceDetails: {
      preDeployCommand: "",
      runtime: "image",
    },
  });
  const observed = await client.request("GET", `/services/${service.id}`);
  const facts = observedRuntimeImage(observed);
  if (facts.runtime !== "image" || facts.imagePath !== imageUrl) {
    throw new Error(
      `Render service ${service.name} did not converge on the immutable image source`,
    );
  }
  return facts;
}

export async function verifyResourceScope(
  client,
  kind,
  resourceId,
  scope,
  label,
) {
  return assertExactRenderScope(
    await client.request("GET", `/${kind}/${resourceId}`),
    scope,
    label,
  );
}

export async function syncService(client, service, spec, common) {
  console.log(`syncing env for ${spec.name}`);
  await verifyControlPlaneScope(client, common);
  await addToEnvironment(client, common.environmentId, [service.id]);
  await verifyResourceScope(client, "services", service.id, common, spec.name);
  // Re-read the digest-pinned release descriptor after all scope reads and
  // immediately before constructing the secret-bearing PUT. A path swap or
  // local edit fails closed unless the bytes still match the release digest.
  const rereadDescriptor = readVerifiedInstallerReleaseDescriptor(common.env);
  if (
    installerDescriptorIdentity(rereadDescriptor) !==
    installerDescriptorIdentity(common.installerDescriptor)
  ) {
    throw new Error(
      "immutable rotating installer release descriptor changed before mutation",
    );
  }
  const expectedEnv = buildServiceEnv({
    ...common,
    env: applyInstallerTuple(common.env, rereadDescriptor),
    databaseUrl: common.databaseUrls[spec.role],
    role: spec.role,
  });
  await client.request("PUT", `/services/${service.id}/env-vars`, expectedEnv);
  return verifyServiceEnvConvergence(client, service, expectedEnv);
}

function renderEnvVars(value) {
  const candidate = Array.isArray(value)
    ? value
    : (value?.envVars ??
      value?.environmentVariables ??
      value?.service?.envVars);
  if (!Array.isArray(candidate)) {
    throw new Error(
      "Render service environment convergence response is invalid",
    );
  }
  return Object.fromEntries(
    candidate.map((item) => {
      const envVar = item?.envVar ?? item;
      return [
        envVar?.key,
        String(envVar?.value ?? envVar?.envVarValue?.value ?? ""),
      ];
    }),
  );
}

export async function verifyServiceEnvConvergence(
  client,
  service,
  expectedEnv,
) {
  const observed = renderEnvVars(
    await client.request("GET", `/services/${service.id}/env-vars?limit=100`),
  );
  for (const { key, value } of expectedEnv) {
    if (observed[key] !== String(value)) {
      throw new Error(
        `Render service ${service.name} environment did not converge for ${key}`,
      );
    }
  }
  // Exercise the same hosted readiness contracts against the provider read,
  // including exact tuple shape and the stable encryption/recovery secrets.
  resolveCodexRotatingInstallerDescriptor(observed);
  resolveStableSecuritySecrets(observed);
  for (const key of installerDescriptorEnvironmentNames) {
    if (!observed[key]) {
      throw new Error(
        `Render service ${service.name} readiness is missing ${key}`,
      );
    }
  }
  const role = Object.fromEntries(
    expectedEnv.map(({ key, value }) => [key, String(value)]),
  ).REVIEW_ROUTER_RUNTIME_ROLE;
  if (role === "worker") {
    assertReviewV2ApiWorkerEnvConvergence(observed, observed);
  }
  return observed;
}

export async function disableAndVerifyPreDeployCommand(client, service) {
  await client.request("PATCH", `/services/${service.id}`, {
    autoDeployTrigger: "off",
    serviceDetails: { preDeployCommand: "" },
  });
  const observed = await client.request("GET", `/services/${service.id}`);
  const value = observed.service ?? observed;
  const preDeployCommand =
    value.serviceDetails?.envSpecificDetails?.preDeployCommand;
  if (preDeployCommand !== "") {
    throw new Error(
      `Render service ${service.name} preDeployCommand is not canonically disabled`,
    );
  }
  if (value.autoDeployTrigger !== "off") {
    throw new Error(
      `Render service ${service.name} autoDeployTrigger is not canonical off`,
    );
  }
}

export function assertMigrationEvidence(trustedEvidence, context) {
  const evidence = assertTrustedGitHubEvidence(trustedEvidence).evidence;
  return assertMigrationEvidencePayload(evidence, context);
}

export function assertMigrationEvidencePayload(
  evidence,
  { scope, databaseId, databaseIdentity, commit, imageDigest, databaseUrls },
) {
  const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
  if (
    evidence?.version !== 5 ||
    !exactKeys(evidence, [
      "version",
      "rolloutId",
      "execution",
      "scope",
      "release",
      "database",
      "databaseGeneration",
      "migration",
      "runtimeRoles",
      "databaseObservation",
      "migrationOutput",
    ])
  ) {
    throw new Error("migration evidence version or shape must be exactly 5");
  }
  const provider = evidence.databaseObservation;
  const providerResponses = Array.isArray(provider?.rawResponses)
    ? provider.rawResponses
    : [];
  const digest = (value) =>
    createHash("sha256")
      .update(Buffer.from(canonicalProviderJson(value)))
      .digest("hex");
  if (
    !exactKeys(provider, [
      "observationVersion",
      "source",
      "captureIdentity",
      "rawResponses",
      "database",
    ]) ||
    provider?.observationVersion !== 4 ||
    provider?.source !== "render-api" ||
    providerResponses.length !== 2 ||
    providerResponses.some(
      (response) =>
        !exactKeys(response, ["url", "status", "bodySha256", "body"]) ||
        typeof response?.url !== "string" ||
        !response.url.startsWith("https://api.render.com/v1/") ||
        response.status !== 200 ||
        response.bodySha256 !== digest(response.body),
    ) ||
    !exactKeys(provider.captureIdentity, [
      "ownerId",
      "apiHost",
      "authenticated",
      "observedAt",
      "rawResponsesSha256",
    ]) ||
    provider.captureIdentity.ownerId !== scope.ownerId ||
    provider.captureIdentity.apiHost !== "api.render.com" ||
    provider.captureIdentity.authenticated !== true ||
    !Number.isFinite(Date.parse(provider.captureIdentity.observedAt ?? "")) ||
    provider.captureIdentity?.rawResponsesSha256 !== digest(providerResponses)
  ) {
    throw new Error(
      "migration evidence is missing a bound Render provider observation",
    );
  }
  if (
    !exactKeys(evidence.execution, [
      "repositoryId",
      "repositoryFullName",
      "workflowPath",
      "workflowSha",
      "workflowRef",
      "runId",
      "runAttempt",
      "jobId",
      "jobName",
      "artifactName",
      "headSha",
    ]) ||
    evidence.execution.workflowPath !==
      ".github/workflows/codex-rotating-release-migration.yml" ||
    evidence.execution.workflowRef !== commit ||
    evidence.execution.headSha !== commit ||
    evidence.execution.jobName !== "trusted-release-migration" ||
    !/^[a-f0-9]{40}$/u.test(evidence.execution.workflowSha ?? "") ||
    ![
      evidence.execution.repositoryId,
      evidence.execution.runId,
      evidence.execution.jobId,
    ].every(
      (value) => typeof value === "string" && /^[1-9][0-9]*$/u.test(value),
    ) ||
    !Number.isSafeInteger(evidence.execution.runAttempt) ||
    evidence.execution.runAttempt <= 0
  )
    throw new Error("migration evidence GitHub execution identity is invalid");
  if (!exactKeys(evidence.scope, ["ownerId", "projectId", "environmentId"]))
    throw new Error("migration evidence scope shape is invalid");
  for (const key of ["ownerId", "projectId", "environmentId"]) {
    if (evidence.scope?.[key] !== scope[key]) {
      throw new Error(
        `migration evidence ${key} does not match requested scope`,
      );
    }
  }
  if (
    !exactKeys(evidence.release, ["commit", "imageDigest"]) ||
    evidence.release?.commit !== commit ||
    evidence.release?.imageDigest !== imageDigest
  ) {
    throw new Error("migration evidence immutable release does not match");
  }
  if (
    !exactKeys(evidence.database, [
      "id",
      "postgresMajorVersion",
      "identity",
      "observationSha256",
    ]) ||
    evidence.database?.id !== databaseId ||
    evidence.database?.postgresMajorVersion !== "17" ||
    evidence.database?.identity !== databaseIdentity ||
    evidence.database?.observationSha256 !== digest(provider)
  ) {
    throw new Error("migration evidence database identity does not match");
  }
  if (
    !exactKeys(evidence.databaseGeneration, [
      "recoveryWitnessSha256",
      "systemIdentifier",
    ]) ||
    typeof evidence.databaseGeneration.systemIdentifier !== "string" ||
    !/^[0-9]+$/u.test(evidence.databaseGeneration.systemIdentifier ?? "") ||
    typeof evidence.databaseGeneration.recoveryWitnessSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(
      evidence.databaseGeneration.recoveryWitnessSha256 ?? "",
    )
  ) {
    throw new Error("migration evidence database generation is invalid");
  }
  const migration = evidence.migration;
  if (
    !exactKeys(migration, [
      "callerCount",
      "status",
      "preflightStatus",
      "migrationStatus",
      "evidenceStatus",
      "outputSha256",
    ]) ||
    migration.callerCount !== 1 ||
    migration.status !== "succeeded" ||
    migration.preflightStatus !== "passed" ||
    migration.migrationStatus !== "succeeded" ||
    migration.evidenceStatus !== "verified" ||
    migration.outputSha256 !== digest(evidence.migrationOutput)
  ) {
    throw new Error(
      "migration evidence must prove one successful exclusive preflight/migration/evidence job",
    );
  }
  if (
    !exactKeys(provider.database, ["id", "name", "version", "ownerId"]) ||
    provider.database?.id !== databaseId ||
    !/^17(?:\.|$)/u.test(String(provider.database?.version ?? "")) ||
    provider.database?.ownerId !== scope.ownerId ||
    providerResponses[0].url !==
      `https://api.render.com/v1/owners/${encodeURIComponent(scope.ownerId)}` ||
    providerResponses[0].body?.id !== scope.ownerId ||
    providerResponses[1].url !==
      `https://api.render.com/v1/postgres/${encodeURIComponent(databaseId)}` ||
    providerResponses[1].body?.id !== databaseId ||
    (providerResponses[1].body?.ownerId ??
      providerResponses[1].body?.owner?.id) !== scope.ownerId ||
    String(providerResponses[1].body?.version) !==
      String(provider.database.version)
  ) {
    throw new Error("migration evidence Render database observation mismatch");
  }
  if (
    !exactKeys(evidence.migrationOutput, [
      "version",
      "caller",
      "callerCount",
      "commit",
      "databaseGeneration",
      "databaseIdentity",
      "imageDigest",
      "migrationStatus",
      "preflightOutputSha256",
      "preflightStatus",
      "roles",
      "status",
    ]) ||
    evidence.migrationOutput.version !== 3 ||
    evidence.migrationOutput?.caller !==
      "scripts/run-codex-rotating-release-migration.mjs" ||
    evidence.migrationOutput?.callerCount !== 1 ||
    evidence.migrationOutput?.commit !== commit ||
    evidence.migrationOutput?.imageDigest !== imageDigest ||
    evidence.migrationOutput?.databaseIdentity !== databaseIdentity ||
    evidence.migrationOutput?.databaseGeneration?.systemIdentifier !==
      evidence.databaseGeneration.systemIdentifier ||
    evidence.migrationOutput?.databaseGeneration?.recoveryWitnessSha256 !==
      evidence.databaseGeneration.recoveryWitnessSha256 ||
    evidence.migrationOutput?.status !== "succeeded"
  ) {
    throw new Error("migration evidence canonical caller output mismatch");
  }
  const expectedRoles = new Map(
    Object.entries(databaseUrls).map(([role, url]) => [
      role,
      {
        username: decodeURIComponent(new URL(url).username),
        databaseIdentity: normalizedDatabaseIdentity(url),
      },
    ]),
  );
  const roles = Array.isArray(evidence.runtimeRoles)
    ? evidence.runtimeRoles
    : [];
  if (roles.length !== expectedRoles.size) {
    throw new Error("migration evidence must verify all five database roles");
  }
  for (const role of roles) {
    const expected = expectedRoles.get(role.role);
    if (
      !expected ||
      !exactKeys(role, [
        "role",
        "username",
        "databaseIdentity",
        "login",
        "superuser",
        "createDatabase",
        "createRole",
        "replication",
        "bypassRls",
        "canSetReleaseRole",
      ]) ||
      role.username !== expected.username ||
      role.databaseIdentity !== expected.databaseIdentity ||
      role.login !== true ||
      role.superuser !== false ||
      role.createDatabase !== false ||
      role.createRole !== false ||
      role.replication !== false ||
      role.bypassRls !== false ||
      role.canSetReleaseRole !== (role.role === "releaseMigration")
    ) {
      throw new Error("migration evidence database role verification failed");
    }
    expectedRoles.delete(role.role);
  }
  if (expectedRoles.size !== 0) {
    throw new Error("migration evidence must verify every canonical role once");
  }
  const outputRoles = Array.isArray(evidence.migrationOutput.roles)
    ? evidence.migrationOutput.roles
    : [];
  if (
    outputRoles.length !== roles.length ||
    outputRoles.some((role) => {
      const normalized = roles.find(
        (entry) => entry.username === role.username,
      );
      return (
        !exactKeys(role, [
          "username",
          "login",
          "superuser",
          "createDatabase",
          "createRole",
          "replication",
          "bypassRls",
          "canSetReleaseRole",
        ]) ||
        !normalized ||
        [
          "login",
          "superuser",
          "createDatabase",
          "createRole",
          "replication",
          "bypassRls",
          "canSetReleaseRole",
        ].some((key) => role[key] !== normalized[key])
      );
    })
  )
    throw new Error("migration evidence role observations are not cross-bound");
  return evidence;
}

export async function fetchTrustedMigrationEvidence(
  env,
  fetchImpl = globalThis.fetch,
) {
  const workflowPath = ".github/workflows/codex-rotating-release-migration.yml";
  const workflowBytes = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", workflowPath),
  );
  const commit = requiredEnv("REVIEW_ROUTER_RENDER_COMMIT_SHA", env);
  return fetchTrustedGitHubEvidence(
    {
      token: requiredEnv("REVIEW_ROUTER_ROLLOUT_GITHUB_TOKEN", env),
      repository: "777genius/review-router-saas",
      repositoryId: requiredEnv(
        "REVIEW_ROUTER_ROLLOUT_EVIDENCE_REPOSITORY_ID",
        env,
      ),
      workflowPath,
      workflowSha: gitBlobSha(workflowBytes),
      workflowRef: commit,
      headSha: commit,
      rolloutId: requiredEnv("REVIEW_ROUTER_ROLLOUT_EVIDENCE_ROLLOUT_ID", env),
      runId: requiredEnv("REVIEW_ROUTER_ROLLOUT_EVIDENCE_RUN_ID", env),
      runAttempt: requiredEnv(
        "REVIEW_ROUTER_ROLLOUT_EVIDENCE_RUN_ATTEMPT",
        env,
      ),
      jobId: requiredEnv("REVIEW_ROUTER_ROLLOUT_EVIDENCE_JOB_ID", env),
      jobName: "trusted-release-migration",
      artifactId: requiredEnv(
        "REVIEW_ROUTER_ROLLOUT_EVIDENCE_ARTIFACT_ID",
        env,
      ),
      artifactName: requiredEnv(
        "REVIEW_ROUTER_ROLLOUT_EVIDENCE_ARTIFACT_NAME",
        env,
      ),
    },
    fetchImpl,
  );
}

export function claimTrustedMigrationEvidence(
  databaseUrl,
  trustedEvidence,
  execute = spawnSync,
) {
  const trusted = assertTrustedGitHubEvidence(trustedEvidence);
  const parsed = new URL(databaseUrl);
  if (decodeURIComponent(parsed.username) !== "reviewrouter_release_migration")
    throw new Error(
      "trusted migration evidence claim requires the release role",
    );
  const receipt = trusted.receipt;
  const release = trusted.evidence.release;
  const generation = trusted.evidence.databaseGeneration;
  const result = execute(
    "psql",
    [
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--set",
      `artifact_digest=${receipt.artifactDigest}`,
      "--set",
      `artifact_id=${receipt.artifactId}`,
      "--set",
      `rollout_id=${receipt.rolloutId}`,
      "--set",
      `run_id=${receipt.runId}`,
      "--set",
      `run_attempt=${receipt.runAttempt}`,
      "--set",
      `job_id=${receipt.jobId}`,
      "--set",
      `workflow_path=${receipt.workflowPath}`,
      "--set",
      `commit=${receipt.commit}`,
      "--set",
      `image_digest=${release.imageDigest}`,
      "--set",
      `system_identifier=${generation.systemIdentifier}`,
      "--set",
      `recovery_witness_sha256=${generation.recoveryWitnessSha256}`,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        PGHOST: parsed.hostname,
        PGPORT: parsed.port || "5432",
        PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
        PGUSER: decodeURIComponent(parsed.username),
        PGPASSWORD: decodeURIComponent(parsed.password),
        PGSSLMODE: parsed.searchParams.get("sslmode") ?? "require",
      },
      input: String.raw`\set ON_ERROR_STOP on
BEGIN;
SELECT reviewrouter_bootstrap.consume_migration_evidence(
  :'artifact_digest',
  :'artifact_id',
  :'rollout_id',
  :'run_id',
  :'run_attempt'::integer,
  :'job_id',
  :'workflow_path',
  :'commit',
  :'image_digest',
  :'system_identifier',
  :'recovery_witness_sha256'
);
COMMIT;
SELECT 'claimed';
`,
      maxBuffer: 1024 * 1024,
    },
  );
  if (
    result.status !== 0 ||
    result.stdout.trim().split(/\s+/u).at(-1) !== "claimed"
  )
    throw new Error("trusted migration evidence claim failed or was replayed");
}

function resolvedDeployFacts(deploy) {
  const value = deploy.deploy ?? deploy;
  return {
    id: value.id ?? null,
    status: value.status ?? null,
    artifactId: value.artifactId ?? null,
    imageRef: value.image?.ref ?? null,
    imageDigest:
      value.image?.sha ??
      value.image?.digest ??
      value.imageDigest ??
      value.build?.imageDigest ??
      null,
  };
}

export async function triggerAndVerifyDeploy(
  client,
  service,
  {
    imageUrl,
    imageDigest,
    poll = async () => new Promise((resolve) => setTimeout(resolve, 10_000)),
    maxAttempts = 180,
  },
) {
  console.log(`triggering deploy for ${service.name}`);
  const created = await client.request(
    "POST",
    `/services/${service.id}/deploys`,
    {
      clearCache: "do_not_clear",
      imageUrl,
    },
  );
  const createdId = resolvedDeployFacts(created).id;
  if (!createdId)
    throw new Error(
      `Render service ${service.name} did not return a deploy id`,
    );
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const observed = await client.request(
      "GET",
      `/services/${service.id}/deploys/${createdId}`,
    );
    const facts = resolvedDeployFacts(observed);
    if (
      ["build_failed", "update_failed", "canceled", "deactivated"].includes(
        facts.status,
      )
    ) {
      throw new Error(
        `Render service ${service.name} deploy terminated as ${facts.status}`,
      );
    }
    if (facts.status === "live") {
      if (facts.imageRef !== imageUrl) {
        throw new Error(
          `Render service ${service.name} resolved image reference mismatch`,
        );
      }
      if (facts.imageDigest !== imageDigest) {
        throw new Error(
          `Render service ${service.name} resolved image digest mismatch`,
        );
      }
      return facts;
    }
    await poll();
  }
  throw new Error(`Render service ${service.name} deploy did not resolve`);
}

export async function main() {
  if (Object.hasOwn(process.env, roleBootstrapDatabaseUrlEnvironmentName)) {
    throw new Error(
      `${roleBootstrapDatabaseUrlEnvironmentName} crossed the runtime deploy process boundary`,
    );
  }
  const envFile =
    process.env.REVIEW_ROUTER_RENDER_RUNTIME_DEPLOY_ENV_FILE ??
    ".env.render-runtime-deploy";
  const env = {
    ...readRuntimeDeployDotenv(envFile),
    ...process.env,
  };
  const ownerId = requiredEnv("RENDER_OWNER_ID", env);
  const projectId = requiredEnv("RENDER_PROJECT_ID", env);
  const environmentId = requiredEnv("RENDER_ENVIRONMENT_ID", env);
  const phase = requiredEnv("REVIEW_ROUTER_RENDER_PHASE", env);
  if (!["prepare", "runtime-deploy"].includes(phase)) {
    throw new Error(
      "REVIEW_ROUTER_RENDER_PHASE must be prepare or runtime-deploy",
    );
  }
  const scope = { ownerId, projectId, environmentId };
  const commit = requiredEnv("REVIEW_ROUTER_RENDER_COMMIT_SHA", env);
  const imageDigest = requiredEnv("REVIEW_ROUTER_RENDER_IMAGE_DIGEST", env);
  if (!/^[a-f0-9]{40}$/u.test(commit))
    throw new Error(
      "REVIEW_ROUTER_RENDER_COMMIT_SHA must be an exact 40-character lowercase SHA",
    );
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageDigest))
    throw new Error(
      "REVIEW_ROUTER_RENDER_IMAGE_DIGEST must be an exact sha256 digest",
    );
  const imageUrl = `ghcr.io/777genius/review-router-saas-runtime@${imageDigest}`;
  const webUrl = env.REVIEW_ROUTER_WEB_URL ?? "https://reviewrouter.site";
  const apiUrl = env.REVIEW_ROUTER_API_URL ?? "https://api.reviewrouter.site";
  assertHostedDeployEnv({ apiUrl, env, envFile, webUrl });
  // Resolve every cross-process security value before constructing a Render
  // client or mutating hosted state. buildServiceEnv revalidates defensively.
  env.REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF =
    resolveHostedCodexRotatingActionRef(env);
  env.REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS =
    resolveHostedCodexRotatingAllowedActionRefs(env);
  const stableSecrets = resolveStableSecuritySecrets(env);
  Object.assign(env, stableSecrets);
  const installerDescriptor = readVerifiedInstallerReleaseDescriptor(env);
  Object.assign(env, applyInstallerTuple(env, installerDescriptor));
  const databaseUrls =
    phase === "runtime-deploy" ? resolveDistinctDatabaseRoleUrls(env) : null;
  const privateKey =
    phase === "runtime-deploy" ? readGithubPrivateKey(env) : null;
  const client = new RenderClient(readRenderApiKey());
  let trustedMigrationEvidence = null;

  await verifyControlPlaneScope(client, scope);
  const database = await ensureDatabase(client, {
    ...scope,
    allowCreate: phase === "prepare",
  });
  const readyDatabase = await waitForDatabase(client, database.id);
  if (!/^17(?:\.|$)/u.test(String(readyDatabase.version ?? ""))) {
    throw new Error(
      "ready Render database reviewrouter-db must use PostgreSQL 17",
    );
  }
  await verifyResourceScope(
    client,
    "postgres",
    readyDatabase.id,
    scope,
    "reviewrouter-db",
  );
  if (phase === "runtime-deploy") {
    const selectedDatabaseIdentity = assertSelectedDatabaseIdentity(
      readyDatabase.internalConnectionString,
      databaseUrls,
    );
    trustedMigrationEvidence = await fetchTrustedMigrationEvidence(env);
    assertMigrationEvidence(trustedMigrationEvidence, {
      scope,
      databaseId: readyDatabase.id,
      databaseIdentity: selectedDatabaseIdentity,
      commit,
      imageDigest,
      databaseUrls,
    });
  }
  const common = {
    allowCreate: phase === "prepare",
    apiUrl,
    databaseUrls,
    env,
    installerDescriptor,
    imageUrl,
    environmentId,
    ownerId,
    projectId,
    privateKey,
    webUrl,
  };
  const serviceSpecs = [
    {
      healthCheckPath: "/",
      name: "reviewrouter-web",
      role: "web",
      startCommand: "pnpm web:start",
      type: "web_service",
    },
    {
      healthCheckPath: "/health",
      name: "reviewrouter-api",
      role: "api",
      startCommand: "HOST=0.0.0.0 pnpm api:start",
      type: "web_service",
    },
    {
      name: "reviewrouter-worker",
      role: "worker",
      startCommand: "pnpm worker:start",
      type: "background_worker",
    },
  ];

  const services = [];
  for (const spec of serviceSpecs) {
    const service = await ensureService(client, spec, common);
    services.push({ service, spec });
  }
  await addToEnvironment(client, environmentId, [
    readyDatabase.id,
    ...services.map(({ service }) => service.id),
  ]);
  for (const { service } of services) {
    await verifyResourceScope(
      client,
      "services",
      service.id,
      scope,
      service.name,
    );
  }
  // Unsafe commit deployment and per-service migrations remain disabled in
  // both phases. No runtime environment is written during prepare.
  for (const { service } of services)
    await disableAndVerifyPreDeployCommand(client, service);

  if (phase === "prepare") {
    console.log(
      JSON.stringify(
        {
          phase,
          scope,
          database: { id: readyDatabase.id, status: readyDatabase.status },
          services: services.map(({ service, spec }) => ({
            serviceId: service.id,
            name: service.name,
            role: spec.role,
          })),
          next: "dispatch the immutable codex-rotating-release-migration workflow once, then invoke runtime-deploy with its authenticated GitHub artifact identity",
        },
        null,
        2,
      ),
    );
    return;
  }

  claimTrustedMigrationEvidence(
    databaseUrls.releaseMigration,
    trustedMigrationEvidence,
  );

  // Scope is fetched again immediately before each complete secret-bearing PUT.
  const convergedEnvByRole = {};
  for (const { service, spec } of services) {
    convergedEnvByRole[spec.role] = await syncService(
      client,
      service,
      spec,
      common,
    );
  }
  assertReviewV2ApiWorkerEnvConvergence(
    convergedEnvByRole.api,
    convergedEnvByRole.worker,
  );
  for (const { service, spec } of services)
    await convergeImmutableRuntimeImage(client, service, spec, imageUrl);
  const resolvedDeploys = [];
  for (const { service } of services)
    resolvedDeploys.push(
      await triggerAndVerifyDeploy(client, service, {
        imageDigest,
        imageUrl,
      }),
    );

  console.log(
    JSON.stringify(
      {
        phase,
        scope,
        database: { id: readyDatabase.id, status: readyDatabase.status },
        services: services.map(({ service }, index) => ({
          serviceId: service.id,
          name: service.name,
          role: services[index].spec.role,
          url: service.serviceDetails?.url ?? null,
          deployId: resolvedDeploys[index]?.id ?? null,
        })),
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] === "--assert-runtime-deploy-process-boundary") {
    if (Object.hasOwn(process.env, roleBootstrapDatabaseUrlEnvironmentName)) {
      throw new Error("runtime deploy process boundary check failed");
    }
    process.stdout.write("runtime deploy process boundary check passed\n");
  } else {
    await main();
  }
}
