#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fetchHttp = globalThis.fetch;
const composeFile = "deploy/self-hosted/compose.yml";
const runSuffix = `${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const projectName = `reviewrouter-self-hosted-e2e-${runSuffix}`;
const testDatabase = `review_router_test_${process.pid}_${Date.now()}`;
const tempDirectory = mkdtempSync(
  join(tmpdir(), "reviewrouter-self-hosted-e2e-"),
);
const envFile = join(tempDirectory, "self-hosted.env");
const investigationReleaseFixture = JSON.parse(
  readFileSync(
    join(
      repoRoot,
      "scripts/self-hosted-e2e/review-investigation-release.fixture.json",
    ),
    "utf8",
  ),
);
assertInvestigationReleaseFixture(investigationReleaseFixture);
let composeTouched = false;
let testDatabaseCreated = false;

const ports = {
  web: await reserveFreePort(),
  api: await reserveFreePort(),
  postgres: await reserveFreePort(),
};
const secrets = createTestSecrets();
const testEnv = createTestEnvironment();
writeEnvFile(testEnv);

try {
  run("docker", ["version", "--format", "server={{.Server.Version}}"]);
  run(process.execPath, ["scripts/check-self-hosted-readiness.mjs"], testEnv);
  run(
    process.execPath,
    ["scripts/check-self-hosted-compose-contract.mjs"],
    testEnv,
  );

  composeTouched = true;
  runCompose(["up", "-d", "--build", "--wait", "--wait-timeout", "300"]);
  assertComposeState();
  await assertHealthEndpoint(
    `http://127.0.0.1:${ports.web}/api/health`,
    "review-router-web",
  );
  await assertHealthEndpoint(
    `http://127.0.0.1:${ports.api}/health`,
    "review-router-api",
  );

  runComposeWithSanitizedOutput(["run", "--rm", "migrate"]);
  setGlobalReviewV2EmergencyStop(false);
  runComposeWithSanitizedOutput(["run", "--rm", "migrate"]);
  setGlobalReviewV2EmergencyStop(true);
  runComposeWithSanitizedOutput([
    "exec",
    "-T",
    "postgres",
    "createdb",
    "-U",
    testEnv.POSTGRES_USER,
    testDatabase,
  ]);
  testDatabaseCreated = true;

  runCompose([
    "exec",
    "-T",
    "-e",
    `REVIEW_ROUTER_E2E_DATABASE=${testDatabase}`,
    "worker",
    "sh",
    "-lc",
    containerE2ECommand(),
  ]);

  assertLogsAreSanitized();
  const controlPlaneCommit = capture("git", ["rev-parse", "HEAD"]).trim();
  console.log("Self-hosted E2E passed.");
  console.log(`control-plane-commit=${controlPlaneCommit}`);
  console.log(`action-ref=${testEnv.REVIEW_ROUTER_ACTION_REF}`);
  console.log(
    "compose=healthy migrations=idempotent review-v2=passed investigation-same-release=passed action-oidc=passed logs=clean",
  );
} catch (error) {
  if (composeTouched) printSafeDiagnostics();
  throw error;
} finally {
  if (testDatabaseCreated) {
    runCompose(
      [
        "exec",
        "-T",
        "postgres",
        "dropdb",
        "--if-exists",
        "--force",
        "-U",
        testEnv.POSTGRES_USER,
        testDatabase,
      ],
      { allowFailure: true },
    );
  }
  if (composeTouched) {
    runCompose(["down", "--volumes", "--remove-orphans"], {
      allowFailure: true,
    });
  }
  rmSync(tempDirectory, { force: true, recursive: true });
}

function createTestSecrets() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    auth: randomSecret(),
    actionSession: randomSecret(),
    encryption: randomSecret(),
    webhook: randomSecret(),
    postgres: randomSecret(),
    githubClient: randomSecret(),
    reviewRunAuthorization: randomBytes(32).toString("base64"),
    reviewV2Capability: randomBytes(32).toString("base64"),
    reviewV2ContextSession: randomBytes(32).toString("base64"),
    reviewV2ContextReplay: randomBytes(32).toString("base64"),
    investigationPrivateMaterial: randomBytes(32).toString("base64url"),
    reviewV2Operator: randomSecret(),
    privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  };
}

function createTestEnvironment() {
  const actionRef =
    process.env.REVIEW_ROUTER_SELF_HOSTED_E2E_ACTION_REF ??
    `777genius/review-router@${"a".repeat(40)}`;
  const actionCommitSha = actionRef.slice(actionRef.lastIndexOf("@") + 1);
  const env = {
    ...process.env,
    NODE_ENV: "production",
    AUTH_TRUST_HOST: "true",
    POSTGRES_DB: "review_router",
    POSTGRES_USER: "reviewrouter",
    POSTGRES_PASSWORD: secrets.postgres,
    DATABASE_URL: `postgresql://reviewrouter:${secrets.postgres}@postgres:5432/review_router?schema=public`,
    REVIEW_ROUTER_WEB_BIND: `127.0.0.1:${ports.web}`,
    REVIEW_ROUTER_API_BIND: `127.0.0.1:${ports.api}`,
    REVIEW_ROUTER_POSTGRES_BIND: `127.0.0.1:${ports.postgres}`,
    REVIEW_ROUTER_WEB_URL: "https://selfhost.reviewrouter.test",
    REVIEW_ROUTER_API_URL: "https://api.selfhost.reviewrouter.test",
    REVIEW_ROUTER_PUBLIC_WEB_URL: "https://selfhost.reviewrouter.test",
    REVIEW_ROUTER_PUBLIC_API_URL: "https://api.selfhost.reviewrouter.test",
    NEXTAUTH_URL: "https://selfhost.reviewrouter.test",
    AUTH_SECRET: secrets.auth,
    REVIEW_ROUTER_ACTION_SESSION_SECRET: secrets.actionSession,
    REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY: secrets.encryption,
    GITHUB_APP_ID: "123456",
    GITHUB_APP_CLIENT_ID: "Iv1.selfhostede2eclient",
    GITHUB_APP_CLIENT_SECRET: secrets.githubClient,
    GITHUB_APP_SLUG: "reviewrouter-selfhosted-e2e",
    GITHUB_CLIENT_ID: "Iv1.selfhostede2eclient",
    GITHUB_CLIENT_SECRET: secrets.githubClient,
    GITHUB_WEBHOOK_SECRET: secrets.webhook,
    GITHUB_APP_PRIVATE_KEY: secrets.privateKey.replaceAll("\n", "\\n"),
    REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "managed-review",
    REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS: "1",
    REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
    REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
    REVIEW_ROUTER_DISABLE_ACTION_CONTROL_PLANE: "0",
    REVIEW_ROUTER_ACTION_OIDC_AUDIENCE: "reviewrouter",
    REVIEW_ROUTER_ACTION_REF: actionRef,
    REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "1",
    REVIEW_ROUTER_REVIEW_V2_DIRECT_INITIALIZATION_ENABLED: "1",
    REVIEW_ROUTER_REVIEW_V2_WORKFLOW_PROVISIONING_MODE: "client_triggered_t0",
    REVIEW_ROUTER_REVIEW_V2_RUN_CONTROL_ENABLED: "1",
    REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED: "1",
    REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED: "0",
    REVIEW_ROUTER_REVIEW_V2_INTENT_ADMISSION_REQUIRED: "0",
    REVIEW_ROUTER_REVIEW_V2_WORKFLOW_DISPATCH_READY: "0",
    REVIEW_ROUTER_OUTBOX_FENCED_TAKEOVER_ENABLED: "1",
    REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_ACTIVE_KEY_ID:
      "self-hosted-e2e-authorization",
    REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON: JSON.stringify([
      {
        keyId: "self-hosted-e2e-authorization",
        secretBase64: secrets.reviewRunAuthorization,
        verifyUntil: null,
      },
    ]),
    REVIEW_ROUTER_REVIEW_V2_CAPABILITY_ACTIVE_KEY_ID:
      "self-hosted-e2e-capability",
    REVIEW_ROUTER_REVIEW_V2_CAPABILITY_KEYS_JSON: JSON.stringify([
      {
        keyId: "self-hosted-e2e-capability",
        secretBase64: secrets.reviewV2Capability,
        verifyUntil: null,
      },
    ]),
    REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON: JSON.stringify([
      {
        producerReleaseId: "self-hosted-e2e-action-v2",
        distributionKind: "public_reusable",
        actionCommitSha,
        runtimeCommitSha: "b".repeat(40),
        wrapperEntrypointDigest: null,
        runtimeEntrypointDigest: "c".repeat(64),
        contextGatewayPolicyVersion:
          investigationReleaseFixture.contextGateway.policyVersion,
        contextGatewayEntrypointDigest:
          investigationReleaseFixture.contextGateway.entrypointDigest,
        reviewInvestigationCapability:
          investigationReleaseFixture.reviewInvestigation.capability,
        reviewInvestigationCoverageProfileHash:
          investigationReleaseFixture.reviewInvestigation.coverageProfileHash,
        reviewInvestigationPolicyHash:
          investigationReleaseFixture.reviewInvestigation.policyHash,
        schemaDigest: "e".repeat(64),
        canonicalizerDigest: "f".repeat(64),
        capabilityProfile: "exact_revision_v2",
        protocolLimitsProfileId: "self-hosted-e2e-limits-v2",
        operationalSloProfileId: "self-hosted-e2e-slo-v2",
      },
    ]),
    REVIEW_ROUTER_REVIEW_V2_PROVIDER_VOTE_LANES_JSON: JSON.stringify([
      { providerKind: "codex", providerVoteIdentityHash: "1".repeat(64) },
    ]),
    REVIEW_ROUTER_REVIEW_V2_PROJECTION_POLICY_VERSION:
      "review-projection-policy.v4-t0",
    REVIEW_ROUTER_REVIEW_V2_CONTEXT_SESSION_SECRET_BASE64:
      secrets.reviewV2ContextSession,
    REVIEW_ROUTER_REVIEW_V2_CONTEXT_REPLAY_ACTIVE_KEY_ID:
      "self-hosted-e2e-context",
    REVIEW_ROUTER_REVIEW_V2_CONTEXT_REPLAY_KEYS_JSON: JSON.stringify([
      {
        keyId: "self-hosted-e2e-context",
        secretBase64: secrets.reviewV2ContextReplay,
      },
    ]),
    REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL_SHA256: createHash("sha256")
      .update(secrets.reviewV2Operator, "utf8")
      .digest("hex"),
    REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: "1",
    REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED: "1",
    REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED: "1",
    REVIEW_ROUTER_REVIEW_INVESTIGATION_MAINTENANCE_ENABLED: "1",
    REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED: "0",
    REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED: "0",
    REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED: "0",
    REVIEW_ROUTER_REVIEW_INVESTIGATION_EMERGENCY_DISABLED: "0",
    REVIEW_ROUTER_REVIEW_INVESTIGATION_SELECTORS_JSON: JSON.stringify({
      context_critic: [],
      recording: [],
      shadow: [],
    }),
    REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_ACTIVE_KEY_ID:
      "self-hosted-e2e-private-material",
    REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_KEYS_JSON:
      JSON.stringify({
        "self-hosted-e2e-private-material":
          secrets.investigationPrivateMaterial,
      }),
    REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_TTL_MS: "86400000",
    REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK: "1",
    REVIEW_ROUTER_DEFAULT_MODEL: "gpt-5.5",
    REVIEW_ROUTER_DEFAULT_EFFORT: "xhigh",
    REVIEW_ROUTER_SELF_HOSTED_ENV_FILE: envFile,
  };
  for (const name of [
    "CODEX_AUTH_JSON",
    "CODEX_CONFIG_TOML",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "GEMINI_API_KEY",
  ]) {
    delete env[name];
  }
  return env;
}

function writeEnvFile(env) {
  const names = [
    "NODE_ENV",
    "AUTH_TRUST_HOST",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "DATABASE_URL",
    "REVIEW_ROUTER_WEB_BIND",
    "REVIEW_ROUTER_API_BIND",
    "REVIEW_ROUTER_POSTGRES_BIND",
    "REVIEW_ROUTER_WEB_URL",
    "REVIEW_ROUTER_API_URL",
    "REVIEW_ROUTER_PUBLIC_WEB_URL",
    "REVIEW_ROUTER_PUBLIC_API_URL",
    "NEXTAUTH_URL",
    "AUTH_SECRET",
    "REVIEW_ROUTER_ACTION_SESSION_SECRET",
    "REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY",
    "GITHUB_APP_ID",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_SLUG",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "GITHUB_WEBHOOK_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    "REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE",
    "REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS",
    "REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING",
    "REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING",
    "REVIEW_ROUTER_DISABLE_ACTION_CONTROL_PLANE",
    "REVIEW_ROUTER_ACTION_OIDC_AUDIENCE",
    "REVIEW_ROUTER_ACTION_REF",
    "REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH",
    "REVIEW_ROUTER_REVIEW_V2_DIRECT_INITIALIZATION_ENABLED",
    "REVIEW_ROUTER_REVIEW_V2_WORKFLOW_PROVISIONING_MODE",
    "REVIEW_ROUTER_REVIEW_V2_RUN_CONTROL_ENABLED",
    "REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED",
    "REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED",
    "REVIEW_ROUTER_REVIEW_V2_INTENT_ADMISSION_REQUIRED",
    "REVIEW_ROUTER_REVIEW_V2_WORKFLOW_DISPATCH_READY",
    "REVIEW_ROUTER_OUTBOX_FENCED_TAKEOVER_ENABLED",
    "REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_ACTIVE_KEY_ID",
    "REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON",
    "REVIEW_ROUTER_REVIEW_V2_CAPABILITY_ACTIVE_KEY_ID",
    "REVIEW_ROUTER_REVIEW_V2_CAPABILITY_KEYS_JSON",
    "REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON",
    "REVIEW_ROUTER_REVIEW_V2_PROVIDER_VOTE_LANES_JSON",
    "REVIEW_ROUTER_REVIEW_V2_PROJECTION_POLICY_VERSION",
    "REVIEW_ROUTER_REVIEW_V2_CONTEXT_SESSION_SECRET_BASE64",
    "REVIEW_ROUTER_REVIEW_V2_CONTEXT_REPLAY_ACTIVE_KEY_ID",
    "REVIEW_ROUTER_REVIEW_V2_CONTEXT_REPLAY_KEYS_JSON",
    "REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL_SHA256",
    "REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED",
    "REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED",
    "REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED",
    "REVIEW_ROUTER_REVIEW_INVESTIGATION_MAINTENANCE_ENABLED",
    "REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED",
    "REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED",
    "REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED",
    "REVIEW_ROUTER_REVIEW_INVESTIGATION_EMERGENCY_DISABLED",
    "REVIEW_ROUTER_REVIEW_INVESTIGATION_SELECTORS_JSON",
    "REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_ACTIVE_KEY_ID",
    "REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_KEYS_JSON",
    "REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_TTL_MS",
    "REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK",
    "REVIEW_ROUTER_DEFAULT_MODEL",
    "REVIEW_ROUTER_DEFAULT_EFFORT",
    "REVIEW_ROUTER_SELF_HOSTED_ENV_FILE",
  ];
  writeFileSync(
    envFile,
    `${names.map((name) => `${name}=${env[name]}`).join("\n")}\n`,
    {
      mode: 0o600,
    },
  );
}

function composeArguments(args) {
  return [
    "compose",
    "-p",
    projectName,
    "--env-file",
    envFile,
    "-f",
    composeFile,
    ...args,
  ];
}

function runCompose(args, options) {
  return run("docker", composeArguments(args), testEnv, options);
}

function captureCompose(args, options) {
  return capture("docker", composeArguments(args), testEnv, options);
}

function runComposeWithSanitizedOutput(args) {
  const result = spawnSync("docker", composeArguments(args), {
    cwd: repoRoot,
    env: testEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  assertCredentialMaterialAbsent(
    `${stdout}${stderr}`,
    "self_hosted_e2e_output",
  );
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (result.status !== 0) {
    throw new Error(
      `docker ${composeArguments(args).join(" ")} failed with ${result.status ?? result.signal}`,
    );
  }
  return result;
}

function setGlobalReviewV2EmergencyStop(stopped) {
  runCompose([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    testEnv.POSTGRES_USER,
    "-d",
    testEnv.POSTGRES_DB,
    "-c",
    `UPDATE "ReviewSafetyEmergencyControl" SET "stopped" = ${stopped ? "true" : "false"}, "updatedAt" = statement_timestamp() WHERE "emergencyControlId" = 'global-review-v2'`,
  ]);
}

function run(command, args, env = process.env, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status ?? result.signal}`,
    );
  }
  return result;
}

function capture(command, args, env = process.env, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status ?? result.signal}`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function assertComposeState() {
  const records = parseComposeRecords(
    captureCompose(["ps", "-a", "--format", "json"]),
  );
  const byService = new Map(records.map((record) => [record.Service, record]));
  for (const service of ["postgres", "web", "api", "worker"]) {
    const record = byService.get(service);
    if (!record || record.State !== "running") {
      throw new Error(`self_hosted_service_not_running:${service}`);
    }
  }
  for (const service of ["postgres", "web", "api"]) {
    if (byService.get(service)?.Health !== "healthy") {
      throw new Error(`self_hosted_service_not_healthy:${service}`);
    }
  }
  const migrate = byService.get("migrate");
  if (
    !migrate ||
    migrate.State !== "exited" ||
    Number(migrate.ExitCode) !== 0
  ) {
    throw new Error("self_hosted_migration_failed");
  }
}

async function assertHealthEndpoint(url, expectedService) {
  const response = await fetchHttp(url, { redirect: "manual" });
  if (response.status !== 200) {
    throw new Error(
      `self_hosted_health_status:${expectedService}:${response.status}`,
    );
  }
  const payload = await response.json();
  if (payload?.service !== expectedService || payload?.status !== "ok") {
    throw new Error(`self_hosted_health_payload:${expectedService}`);
  }
}

function containerE2ECommand() {
  return [
    "set -eu",
    "test_url=$(node -e 'const u=new URL(process.env.DATABASE_URL);u.pathname=`/${process.env.REVIEW_ROUTER_E2E_DATABASE}`;process.stdout.write(u.href)')",
    'DATABASE_URL="$test_url" pnpm --filter @reviewrouter/platform-db db:migrate:deploy',
    'REVIEW_ROUTER_REVIEW_V2_E2E_ALLOW_DOCKER_DATABASE=1 REVIEW_ROUTER_TEST_DATABASE_URL="$test_url" pnpm review-v2:e2e',
    'REVIEW_ROUTER_REVIEW_V2_E2E_ALLOW_DOCKER_DATABASE=1 REVIEW_ROUTER_SELF_HOSTED_REVIEW_PATHS_E2E=1 REVIEW_ROUTER_TEST_DATABASE_URL="$test_url" pnpm exec vitest run scripts/self-hosted-e2e/self-hosted-review-paths.e2e.test.ts',
    'DATABASE_URL="$test_url" REVIEW_ROUTER_TARGET_REPO="reviewrouter-e2e/self-hosted-fixture" pnpm spike:action:e2e',
  ].join("\n");
}

function assertLogsAreSanitized() {
  const logs = captureCompose([
    "logs",
    "--no-color",
    "web",
    "api",
    "worker",
    "migrate",
    "postgres",
  ]);
  assertCredentialMaterialAbsent(logs, "self_hosted_logs");
}

function assertCredentialMaterialAbsent(value, source) {
  const forbiddenValues = [
    ...Object.values(secrets),
    testEnv.GITHUB_APP_PRIVATE_KEY,
  ];
  if (forbiddenValues.some((secret) => secret && value.includes(secret))) {
    throw new Error(`${source}_contains_generated_secret`);
  }
  if (
    /gh[pousr]_[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._-]{20,}|BEGIN [A-Z ]*PRIVATE KEY|refresh_token|access_token|auth\.json/i.test(
      value,
    )
  ) {
    throw new Error(`${source}_contains_credential_material`);
  }
}

function printSafeDiagnostics() {
  const status = captureCompose(["ps", "-a"], { allowFailure: true });
  if (status.trim()) console.error(status.trim());
  const logs = captureCompose(
    [
      "logs",
      "--no-color",
      "--tail",
      "80",
      "web",
      "api",
      "worker",
      "migrate",
      "postgres",
    ],
    { allowFailure: true },
  );
  const sanitized = redact(logs).trim();
  if (sanitized) console.error(sanitized);
}

function redact(value) {
  let result = value;
  for (const secret of Object.values(secrets)) {
    if (secret) result = result.replaceAll(secret, "[REDACTED]");
  }
  result = result.replaceAll(testEnv.GITHUB_APP_PRIVATE_KEY, "[REDACTED]");
  return result
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/gi, "[REDACTED]")
    .replace(/Bearer [A-Za-z0-9._-]{20,}/gi, "Bearer [REDACTED]")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED]");
}

function randomSecret() {
  return randomBytes(36).toString("base64url");
}

function assertInvestigationReleaseFixture(fixture) {
  const gateway = fixture?.contextGateway;
  const investigation = fixture?.reviewInvestigation;
  const policyHash = createHash("sha256")
    .update(canonicalJson(investigation?.policy))
    .digest("hex");
  if (
    gateway?.policyVersion !== "context-gateway-v4" ||
    JSON.stringify(gateway.supportedPolicyVersions) !==
      JSON.stringify(["context-gateway-v3", "context-gateway-v4"]) ||
    !isSha256(gateway.entrypointDigest) ||
    investigation?.capability !== "review_investigation_v1" ||
    !isSha256(investigation.coverageProfileHash) ||
    !isSha256(investigation.policyHash) ||
    investigation.policyHash !== policyHash
  ) {
    throw new Error("self_hosted_investigation_release_fixture_invalid");
  }
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function parseComposeRecords(value) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function reserveFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("self_hosted_e2e_port_allocation_failed"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}
