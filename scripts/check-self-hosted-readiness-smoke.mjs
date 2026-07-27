#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" });

const baseEnv = {
  ...process.env,
  NODE_ENV: "production",
  DATABASE_URL:
    "postgresql://reviewrouter:strong-password@postgres:5432/review_router?schema=public",
  REVIEW_ROUTER_WEB_URL: "https://selfhost.reviewrouter.test",
  REVIEW_ROUTER_API_URL: "https://api.selfhost.reviewrouter.test",
  REVIEW_ROUTER_PUBLIC_API_URL: "https://api.selfhost.reviewrouter.test",
  REVIEW_ROUTER_PUBLIC_WEB_URL: "https://selfhost.reviewrouter.test",
  NEXTAUTH_URL: "https://selfhost.reviewrouter.test",
  AUTH_SECRET: "a".repeat(48),
  GITHUB_APP_ID: "123456",
  GITHUB_APP_CLIENT_ID: "Iv1.selfhostedtestclient",
  GITHUB_APP_CLIENT_SECRET: "b".repeat(40),
  GITHUB_APP_SLUG: "reviewrouter-selfhosted-test",
  GITHUB_WEBHOOK_SECRET: "c".repeat(40),
  GITHUB_APP_PRIVATE_KEY: privateKeyPem.replaceAll("\n", "\\n"),
  REVIEW_ROUTER_ACTION_SESSION_SECRET: "d".repeat(48),
  REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY: "e".repeat(48),
  REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS: "1",
  REVIEW_ROUTER_DISABLE_ACTION_CONTROL_PLANE: "0",
  REVIEW_ROUTER_ACTION_REF:
    "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
  REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "1",
  REVIEW_ROUTER_SELF_HOSTED_ENV_FILE:
    "/tmp/reviewrouter-self-hosted-smoke-env-does-not-exist",
};

const cases = [
  {
    name: "managed-review passes without workflow provisioning",
    expectSuccess: true,
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "managed-review",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
    },
  },
  {
    name: "managed-review rejects active workflow provisioning",
    expectSuccess: false,
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "managed-review",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "0",
    },
  },
  {
    name: "review-only rejects workflow dispatch-ready mode",
    expectSuccess: false,
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "review-only",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_V2_WORKFLOW_DISPATCH_READY: "1",
    },
  },
  {
    name: "provisioning passes with workflow provisioning enabled",
    expectSuccess: true,
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "provisioning",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "0",
    },
  },
];

for (const testCase of cases) {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-self-hosted-readiness.mjs"],
    {
      cwd: process.cwd(),
      env: { ...baseEnv, ...testCase.env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const success = result.status === 0;
  if (success !== testCase.expectSuccess) {
    console.error(`Self-hosted readiness smoke failed: ${testCase.name}`);
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(1);
  }
}

console.log("Self-hosted readiness smoke passed.");
