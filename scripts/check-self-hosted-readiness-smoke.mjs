#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";

const investigationReleaseFixture = JSON.parse(
  readFileSync(
    new URL(
      "./self-hosted-e2e/review-investigation-release.fixture.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
if (
  investigationReleaseFixture.contextGateway.policyVersion !==
    "context-gateway-v4" ||
  !investigationReleaseFixture.contextGateway.supportedPolicyVersions.includes(
    "context-gateway-v3",
  ) ||
  !investigationReleaseFixture.contextGateway.supportedPolicyVersions.includes(
    "context-gateway-v4",
  )
) {
  throw new Error("self_hosted_investigation_gateway_metadata_invalid");
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" });
const actionCommitSha = "0123456789abcdef0123456789abcdef01234567";
const signingKey = Buffer.from("s".repeat(32)).toString("base64");
const investigationLeaseSigningKey = Buffer.from("i".repeat(32)).toString(
  "base64",
);
const contextSessionKey = Buffer.from("c".repeat(32)).toString("base64");
const contextReplayKey = Buffer.from("r".repeat(32)).toString("base64");
const investigationPrivateMaterialKey = Buffer.from("p".repeat(32)).toString(
  "base64url",
);
const signingKeys = JSON.stringify([
  { keyId: "self-hosted-t0", secretBase64: signingKey, verifyUntil: null },
]);
const investigationLeaseSigningKeys = JSON.stringify([
  {
    keyId: "self-hosted-investigation",
    secretBase64: investigationLeaseSigningKey,
    verifyUntil: null,
  },
]);
const producerReleaseAttestations = JSON.stringify([
  {
    producerReleaseId: "self-hosted-action-v2",
    distributionKind: "public_reusable",
    actionCommitSha,
    runtimeCommitSha: "1".repeat(40),
    wrapperEntrypointDigest: null,
    runtimeEntrypointDigest: "2".repeat(64),
    contextGatewayPolicyVersion: "review-context-gateway.v1",
    contextGatewayEntrypointDigest: "3".repeat(64),
    schemaDigest: "4".repeat(64),
    canonicalizerDigest: "5".repeat(64),
    capabilityProfile: "exact_revision_v2",
    protocolLimitsProfileId: "self-hosted-limits-v2",
    operationalSloProfileId: "self-hosted-slo-v2",
  },
]);
const investigationProducerReleaseAttestations = JSON.stringify([
  {
    ...JSON.parse(producerReleaseAttestations)[0],
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
  },
]);

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
  REVIEW_ROUTER_ACTION_OIDC_AUDIENCE: "reviewrouter",
  REVIEW_ROUTER_ACTION_REF: `777genius/review-router@${actionCommitSha}`,
  REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: `777genius/review-router@${actionCommitSha}`,
  REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS: "",
  REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL: `https://raw.githubusercontent.com/777genius/review-router/${actionCommitSha}/scripts/seed-codex-rotating-auth.sh`,
  REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: "v1.0.39",
  REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: "a".repeat(64),
  REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: "w".repeat(43),
  REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "1",
  REVIEW_ROUTER_REVIEW_V2_DIRECT_INITIALIZATION_ENABLED: "1",
  REVIEW_ROUTER_REVIEW_V2_WORKFLOW_PROVISIONING_MODE: "client_triggered_t0",
  REVIEW_ROUTER_REVIEW_V2_RUN_CONTROL_ENABLED: "1",
  REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED: "1",
  REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED: "0",
  REVIEW_ROUTER_REVIEW_V2_INTENT_ADMISSION_REQUIRED: "0",
  REVIEW_ROUTER_REVIEW_V2_WORKFLOW_DISPATCH_READY: "0",
  REVIEW_ROUTER_OUTBOX_FENCED_TAKEOVER_ENABLED: "1",
  REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_ACTIVE_KEY_ID: "self-hosted-t0",
  REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON: signingKeys,
  REVIEW_ROUTER_REVIEW_V2_CAPABILITY_ACTIVE_KEY_ID: "self-hosted-t0",
  REVIEW_ROUTER_REVIEW_V2_CAPABILITY_KEYS_JSON: signingKeys,
  REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON:
    producerReleaseAttestations,
  REVIEW_ROUTER_REVIEW_V2_PROVIDER_VOTE_LANES_JSON: JSON.stringify([
    { providerKind: "codex", providerVoteIdentityHash: "6".repeat(64) },
  ]),
  REVIEW_ROUTER_REVIEW_V2_PROJECTION_POLICY_VERSION:
    "review-projection-policy.v5-t0",
  REVIEW_ROUTER_REVIEW_V2_CONTEXT_SESSION_SECRET_BASE64: contextSessionKey,
  REVIEW_ROUTER_REVIEW_V2_CONTEXT_REPLAY_ACTIVE_KEY_ID: "context-self-hosted",
  REVIEW_ROUTER_REVIEW_V2_CONTEXT_REPLAY_KEYS_JSON: JSON.stringify([
    { keyId: "context-self-hosted", secretBase64: contextReplayKey },
  ]),
  REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL_SHA256: "7".repeat(64),
  REVIEW_ROUTER_REVIEW_INVESTIGATION_LEASE_CAPABILITY_ACTIVE_KEY_ID:
    "self-hosted-investigation",
  REVIEW_ROUTER_REVIEW_INVESTIGATION_LEASE_CAPABILITY_KEYS_JSON:
    investigationLeaseSigningKeys,
  REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_ACTIVE_KEY_ID:
    "self-hosted-private-material",
  REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_KEYS_JSON: JSON.stringify(
    {
      "self-hosted-private-material": investigationPrivateMaterialKey,
    },
  ),
  REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_TTL_MS: "86400000",
  REVIEW_ROUTER_SELF_HOSTED_ENV_FILE:
    "/tmp/reviewrouter-self-hosted-smoke-env-does-not-exist",
};

const cases = [
  ...[
    "https://127.0.0.2",
    "https://127.255.255.255",
    "https://[::ffff:127.0.0.1]",
    "https://[::ffff:7f00:1]",
    "https://service.localhost.",
  ].map((origin) => ({
    name: `rejects loopback alias ${origin}`,
    expectSuccess: false,
    expectedError:
      "REVIEW_ROUTER_PUBLIC_API_URL must not point to localhost in self-hosted production.",
    env: { REVIEW_ROUTER_PUBLIC_API_URL: origin },
  })),
  {
    name: "requires the shared database recovery witness",
    expectSuccess: false,
    expectedError:
      "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS must be 43-256 base64url characters.",
    env: { REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: "" },
  },
  {
    name: "does not expose an invalid database recovery witness",
    expectSuccess: false,
    expectedError:
      "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS must be 43-256 base64url characters.",
    forbiddenOutput: "database-recovery-secret-never-log",
    env: {
      REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS:
        "database-recovery-secret-never-log",
    },
  },
  {
    name: "rejects a mutable rotating Action channel",
    expectSuccess: false,
    expectedError:
      "REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF must be an exact full-SHA Action ref.",
    env: {
      REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: "777genius/review-router@main",
    },
  },
  {
    name: "requires a complete installer descriptor",
    expectSuccess: false,
    expectedError: "codex_rotating_installer_descriptor_incomplete",
    env: { REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: "" },
  },
  {
    name: "rejects an installer URL for another Action SHA",
    expectSuccess: false,
    expectedError: "invalid_codex_rotating_installer_url",
    env: {
      REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL:
        "https://raw.githubusercontent.com/777genius/review-router/1111111111111111111111111111111111111111/scripts/seed-codex-rotating-auth.sh",
    },
  },
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
    name: "review-only passes in client-triggered T0 mode",
    expectSuccess: true,
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "review-only",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
    },
  },
  {
    name: "client-triggered T0 rejects intent admission",
    expectSuccess: false,
    expectedError:
      "REVIEW_ROUTER_REVIEW_V2_INTENT_ADMISSION_REQUIRED must be 0.",
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "managed-review",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_V2_INTENT_ADMISSION_REQUIRED: "1",
    },
  },
  {
    name: "client-triggered T0 rejects intent ingress",
    expectSuccess: false,
    expectedError: "REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED must be 0.",
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "managed-review",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED: "1",
    },
  },
  {
    name: "client-triggered T0 rejects server workflow dispatch",
    expectSuccess: false,
    expectedError: "REVIEW_ROUTER_REVIEW_V2_WORKFLOW_DISPATCH_READY must be 0.",
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "managed-review",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_V2_WORKFLOW_DISPATCH_READY: "1",
    },
  },
  {
    name: "client-triggered T0 requires direct initialization opt-in",
    expectSuccess: false,
    expectedError:
      "REVIEW_ROUTER_REVIEW_V2_DIRECT_INITIALIZATION_ENABLED must be 1.",
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "managed-review",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_V2_DIRECT_INITIALIZATION_ENABLED: "0",
    },
  },
  {
    name: "client-triggered T0 rejects other provisioning modes",
    expectSuccess: false,
    expectedError:
      "REVIEW_ROUTER_REVIEW_V2_WORKFLOW_PROVISIONING_MODE must be client_triggered_t0.",
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "managed-review",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_V2_WORKFLOW_PROVISIONING_MODE:
        "server_dispatched_t0",
    },
  },
  {
    name: "T0 rejects malformed capability key rings",
    expectSuccess: false,
    expectedError:
      "REVIEW_ROUTER_REVIEW_V2_CAPABILITY_KEYS_JSON must contain 1-10 valid",
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "managed-review",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_V2_CAPABILITY_KEYS_JSON: JSON.stringify([
        {
          keyId: "self-hosted-t0",
          secretBase64: "too-short",
          verifyUntil: null,
        },
      ]),
    },
  },
  {
    name: "T0 rejects incomplete producer release attestations",
    expectSuccess: false,
    expectedError:
      "REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON must contain 1-100 valid",
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "review-only",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON:
        JSON.stringify([{ actionCommitSha }]),
    },
  },
  {
    name: "T0 accepts a complete investigation-capable producer release",
    expectSuccess: true,
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "review-only",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON:
        investigationProducerReleaseAttestations,
    },
  },
  {
    name: "T0 rejects a partial investigation producer profile",
    expectSuccess: false,
    expectedError:
      "REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON must contain 1-100 valid",
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "review-only",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON:
        JSON.stringify([
          {
            ...JSON.parse(investigationProducerReleaseAttestations)[0],
            reviewInvestigationPolicyHash: null,
          },
        ]),
    },
  },
  {
    name: "T0 rejects malformed provider vote lanes",
    expectSuccess: false,
    expectedError:
      "REVIEW_ROUTER_REVIEW_V2_PROVIDER_VOTE_LANES_JSON must contain 1-16 valid",
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "review-only",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_V2_PROVIDER_VOTE_LANES_JSON: JSON.stringify([{}]),
    },
  },
  {
    name: "investigation recording requires retention maintenance",
    expectSuccess: false,
    expectedError:
      "REVIEW_ROUTER_REVIEW_INVESTIGATION_MAINTENANCE_ENABLED must be 1 when investigation recording is enabled.",
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "review-only",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_MAINTENANCE_ENABLED: "0",
    },
  },
  {
    name: "investigation recording accepts active retention maintenance",
    expectSuccess: true,
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "review-only",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_MAINTENANCE_ENABLED: "1",
    },
  },
  {
    name: "investigation emergency rollback disables recording prerequisites",
    expectSuccess: true,
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "review-only",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_EMERGENCY_DISABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_MAINTENANCE_ENABLED: "0",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_LEASE_CAPABILITY_ACTIVE_KEY_ID: "",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_LEASE_CAPABILITY_KEYS_JSON: "",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_ACTIVE_KEY_ID: "",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_KEYS_JSON: "",
    },
  },
  {
    name: "investigation recording requires its independent lease key ring",
    expectSuccess: false,
    expectedError:
      "REVIEW_ROUTER_REVIEW_INVESTIGATION_LEASE_CAPABILITY_ACTIVE_KEY_ID is required.",
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "review-only",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_MAINTENANCE_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_LEASE_CAPABILITY_ACTIVE_KEY_ID: "",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_LEASE_CAPABILITY_KEYS_JSON: "",
    },
  },
  {
    name: "investigation recording requires its private material key ring",
    expectSuccess: false,
    expectedError:
      "REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_ACTIVE_KEY_ID is required.",
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "review-only",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_MAINTENANCE_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_ACTIVE_KEY_ID: "",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_KEYS_JSON: "",
    },
  },
  {
    name: "investigation recording rejects private material key IDs rejected by production",
    expectSuccess: false,
    expectedError:
      "REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_ACTIVE_KEY_ID is invalid.",
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "review-only",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_MAINTENANCE_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_ACTIVE_KEY_ID:
        "bad key",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_KEYS_JSON:
        JSON.stringify({ "bad key": investigationPrivateMaterialKey }),
    },
  },
  {
    name: "investigation recording rejects private material TTLs rejected by production",
    expectSuccess: false,
    expectedError:
      "REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_TTL_MS must be an integer from 60000 through 604800000 milliseconds.",
    env: {
      REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE: "review-only",
      REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "0",
      REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_MAINTENANCE_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_TTL_MS: "59999",
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
  if (
    testCase.expectedError &&
    !`${result.stdout}${result.stderr}`.includes(testCase.expectedError)
  ) {
    console.error(
      `Self-hosted readiness smoke did not report the expected error: ${testCase.name}`,
    );
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(1);
  }
  if (
    testCase.forbiddenOutput &&
    `${result.stdout}${result.stderr}`.includes(testCase.forbiddenOutput)
  ) {
    console.error(
      `Self-hosted readiness smoke exposed a forbidden value: ${testCase.name}`,
    );
    process.exit(1);
  }
}

console.log("Self-hosted readiness smoke passed.");
