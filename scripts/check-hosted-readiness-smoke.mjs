#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(join(tmpdir(), "review-router-hosted-check-"));
try {
  const validEnv = join(tempDir, "valid.env");
  writeFileSync(validEnv, hostedEnv());
  expectStatus(validEnv, 0, "valid hosted env should pass");

  const forbiddenProviderSecretEnv = join(tempDir, "forbidden-provider.env");
  writeFileSync(
    forbiddenProviderSecretEnv,
    `${hostedEnv()}\nOPENAI_API_KEY="sk-aaaaaaaaaaaaaaaaaaaaaaaa"\n`,
  );
  expectStatus(
    forbiddenProviderSecretEnv,
    1,
    "provider API key in SaaS env should fail",
  );

  const forbiddenClaudeOAuthEnv = join(tempDir, "forbidden-claude-oauth.env");
  writeFileSync(
    forbiddenClaudeOAuthEnv,
    `${hostedEnv()}\nCLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-example"\n`,
  );
  expectStatus(
    forbiddenClaudeOAuthEnv,
    1,
    "Claude Code OAuth token in SaaS env should fail",
  );

  const forbiddenClaudeAuthTokenEnv = join(
    tempDir,
    "forbidden-claude-auth-token.env",
  );
  writeFileSync(
    forbiddenClaudeAuthTokenEnv,
    `${hostedEnv()}\nANTHROPIC_AUTH_TOKEN="sk-ant-oat01-example"\n`,
  );
  expectStatus(
    forbiddenClaudeAuthTokenEnv,
    1,
    "Anthropic auth token in SaaS env should fail",
  );

  const localhostEnv = join(tempDir, "localhost.env");
  writeFileSync(
    localhostEnv,
    hostedEnv({ REVIEW_ROUTER_PUBLIC_API_URL: "http://localhost:4000" }),
  );
  expectStatus(localhostEnv, 1, "localhost public API URL should fail");

  for (const [index, origin] of [
    "https://127.0.0.2",
    "https://127.255.255.255",
    "https://[::ffff:127.0.0.1]",
    "https://[::ffff:7f00:1]",
    "https://service.localhost.",
  ].entries()) {
    const loopbackAliasEnv = join(tempDir, `loopback-alias-${index}.env`);
    writeFileSync(
      loopbackAliasEnv,
      hostedEnv({ REVIEW_ROUTER_PUBLIC_API_URL: origin }),
    );
    expectStatus(loopbackAliasEnv, 1, `${origin} public API URL should fail`);
  }

  for (const [label, witness] of [
    ["missing", ""],
    ["invalid", "secret-that-must-never-be-logged"],
  ]) {
    const witnessEnv = join(tempDir, `witness-${label}.env`);
    writeFileSync(
      witnessEnv,
      hostedEnv({ REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: witness }),
    );
    expectStatus(
      witnessEnv,
      1,
      `${label} database recovery witness should fail`,
      witness,
    );
  }

  for (const key of [
    "REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH",
    "REVIEW_ROUTER_CODEX_ROTATING_NEW_WORK_ADMISSION_ENABLED",
    "REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED",
  ]) {
    const activeCutoverEnv = join(tempDir, `${key}.env`);
    writeFileSync(activeCutoverEnv, hostedEnv({ [key]: "1" }));
    expectStatus(
      activeCutoverEnv,
      1,
      `${key} must remain dormant during release readiness`,
    );
  }

  for (const [label, overrides] of [
    ["missing", { REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: "" }],
    [
      "mutable-url",
      {
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL:
          "https://raw.githubusercontent.com/777genius/review-router/main/scripts/seed-codex-rotating-auth.sh",
      },
    ],
    [
      "wrong-action-sha",
      {
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL:
          "https://raw.githubusercontent.com/777genius/review-router/1111111111111111111111111111111111111111/scripts/seed-codex-rotating-auth.sh",
      },
    ],
  ]) {
    const descriptorEnv = join(tempDir, `installer-${label}.env`);
    writeFileSync(descriptorEnv, hostedEnv(overrides));
    expectStatus(descriptorEnv, 1, `${label} installer descriptor should fail`);
  }

  console.log("Hosted readiness smoke passed.");
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

function expectStatus(envFile, expectedStatus, label, forbiddenOutput = "") {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-hosted-readiness.mjs"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        REVIEW_ROUTER_HOSTED_ENV_FILE: envFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (
    forbiddenOutput &&
    `${result.stdout}${result.stderr}`.includes(forbiddenOutput)
  ) {
    console.error(`ERROR: ${label} leaked a secret value`);
    process.exit(1);
  }
  if (result.status !== expectedStatus) {
    console.error(`ERROR: ${label}`);
    console.error(`Expected status ${expectedStatus}, got ${result.status}`);
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(1);
  }
}

function hostedEnv(overrides = {}) {
  const values = {
    NODE_ENV: "production",
    DATABASE_URL:
      "postgresql://reviewrouter:password@db.reviewrouter.example:5432/review_router?schema=public",
    REVIEW_ROUTER_WEB_URL: "https://app.reviewrouter.example",
    REVIEW_ROUTER_API_URL: "https://api.reviewrouter.example",
    REVIEW_ROUTER_PUBLIC_API_URL: "https://api.reviewrouter.example",
    AUTH_SECRET: "auth-secret-0123456789abcdef0123456789abcdef",
    GITHUB_CLIENT_ID: "Iv23liHostedSmokeClient",
    GITHUB_CLIENT_SECRET: "github-client-secret-0123456789abcdef",
    GITHUB_APP_ID: "1234567",
    GITHUB_APP_CLIENT_ID: "Iv23liHostedSmokeAppClient",
    GITHUB_APP_CLIENT_SECRET: "github-app-client-secret-0123456789abcdef",
    GITHUB_APP_SLUG: "reviewrouter-hosted-smoke",
    REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY:
      "token-encryption-secret-0123456789abcdef0123456789abcdef",
    GITHUB_APP_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
    GITHUB_WEBHOOK_SECRET: "webhook-secret-0123456789abcdef",
    REVIEW_ROUTER_ACTION_SESSION_SECRET:
      "action-session-secret-0123456789abcdef0123456789abcdef",
    REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS: "1",
    REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "1",
    REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "0",
    REVIEW_ROUTER_DISABLE_ACTION_CONTROL_PLANE: "0",
    REVIEW_ROUTER_ACTION_REF: "777genius/review-router@main",
    REVIEW_ROUTER_ALLOWED_ACTION_REFS:
      "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
    REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
      "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
    REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS: "",
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL:
      "https://raw.githubusercontent.com/777genius/review-router/0123456789abcdef0123456789abcdef01234567/scripts/seed-codex-rotating-auth.sh",
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: "v1.0.39",
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: "a".repeat(64),
    REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: "w".repeat(43),
    REVIEW_ROUTER_ACTION_VERSION: "main",
    REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "0",
    REVIEW_ROUTER_CODEX_ROTATING_NEW_WORK_ADMISSION_ENABLED: "0",
    REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED: "0",
    ...overrides,
  };

  return Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n");
}
