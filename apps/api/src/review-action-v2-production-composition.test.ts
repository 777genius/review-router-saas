import { Buffer } from "node:buffer";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  reviewActionV2CanonicalizerDigest,
  reviewActionV2PublishedSchemaDigest,
} from "@reviewrouter/protocol-review-action-v2";
import { describe, expect, it } from "vitest";
import { createApiApp } from "./app.js";
import {
  composeReviewActionV2ProductionRoutes,
  reviewActionV2CapabilityActiveKeyIdEnv,
  reviewActionV2CapabilityKeysEnv,
  reviewActionV2ProjectionPolicyVersionEnv,
  reviewActionV2ProviderVoteLanesEnv,
} from "./review-action-v2-production-composition.js";

const runtime = {
  readServerTime: async () => new Date("2026-07-23T00:00:00.000Z"),
  createRequestId: () => "request-1",
};

describe("Review Action v2 production composition", () => {
  it("keeps disabled boot inert without Prisma or v2 secrets", async () => {
    expect(
      composeReviewActionV2ProductionRoutes({
        enabled: false,
        env: {},
        runtime,
      }),
    ).toEqual({
      runControl: runtime,
      execution: runtime,
      evidence: runtime,
      snapshot: runtime,
      publication: runtime,
    });

    const app = await createApiApp({
      reviewRunControlV2Enabled: false,
      reviewActionV2Env: {},
    });
    await app.ready();
    await app.close();
  });

  it("fails enabled boot before constructing adapters without Prisma", () => {
    expect(() =>
      composeReviewActionV2ProductionRoutes({
        enabled: true,
        env: productionEnv(),
        runtime,
      }),
    ).toThrow("review_action_v2_prisma_unavailable");
  });

  it.each([
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "REVIEW_ROUTER_ACTION_OIDC_AUDIENCE",
    "REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_ACTIVE_KEY_ID",
    "REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON",
    "REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON",
    reviewActionV2ProviderVoteLanesEnv,
    reviewActionV2ProjectionPolicyVersionEnv,
    reviewActionV2CapabilityActiveKeyIdEnv,
    reviewActionV2CapabilityKeysEnv,
  ])("fails enabled composition when %s is absent", (name) => {
    const env = { ...productionEnv(), [name]: undefined };
    expect(() =>
      composeReviewActionV2ProductionRoutes({
        enabled: true,
        env,
        runtime,
        prisma: inertPrisma(),
      }),
    ).toThrow();
  });

  it("constructs Prisma-backed enabled handlers only with complete production config", () => {
    const routes = composeReviewActionV2ProductionRoutes({
      enabled: true,
      env: productionEnv(),
      runtime,
      prisma: inertPrisma(),
    });

    expect(routes.runControl.authorize?.capabilityEnabled).toBe(true);
    expect(routes.runControl.renew?.capabilityEnabled).toBe(true);
    expect(routes.execution.start?.capabilityEnabled).toBe(true);
    expect(routes.execution.acquireLease?.capabilityEnabled).toBe(true);
    expect(routes.execution.adoptObservation?.capabilityEnabled).toBe(true);
    expect(routes.execution.finalize?.capabilityEnabled).toBe(true);
    expect(routes.evidence.lookup?.capabilityEnabled).toBe(true);
    expect(routes.evidence.commit?.capabilityEnabled).toBe(true);
    expect(routes.snapshot.restore?.capabilityEnabled).toBe(true);
    expect(routes.publication.request?.capabilityEnabled).toBe(true);
    expect(routes.publication.status?.capabilityEnabled).toBe(true);
    expect(routes.runControl.readServerTime).toBe(runtime.readServerTime);
  });

  it("rejects malformed capability rotation config without exposing it", () => {
    const env = {
      ...productionEnv(),
      [reviewActionV2CapabilityKeysEnv]: JSON.stringify([
        { keyId: "v2", secretBase64: "short", verifyUntil: null },
      ]),
    };
    expect(() =>
      composeReviewActionV2ProductionRoutes({
        enabled: true,
        env,
        runtime,
        prisma: inertPrisma(),
      }),
    ).toThrow("review_action_v2_capability_key_invalid");
  });
});

function productionEnv(): Record<string, string> {
  const actionCommitSha = "a".repeat(40);
  const signingKeys = JSON.stringify([
    {
      keyId: "active-v2",
      secretBase64: Buffer.from("s".repeat(32)).toString("base64"),
      verifyUntil: null,
    },
  ]);
  return {
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
    REVIEW_ROUTER_ACTION_OIDC_AUDIENCE: "https://api.reviewrouter.dev",
    REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_ACTIVE_KEY_ID: "active-v2",
    REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON: signingKeys,
    REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON: JSON.stringify([
      {
        producerReleaseId: "public-action-v2",
        distributionKind: "public_reusable",
        actionCommitSha,
        runtimeCommitSha: "b".repeat(40),
        wrapperEntrypointDigest: null,
        runtimeEntrypointDigest: "c".repeat(64),
        schemaDigest: reviewActionV2PublishedSchemaDigest,
        canonicalizerDigest: reviewActionV2CanonicalizerDigest,
        capabilityProfile: "exact_revision_v2",
        protocolLimitsProfileId: "limits-v2",
        operationalSloProfileId: "slo-v2",
      },
    ]),
    [reviewActionV2ProviderVoteLanesEnv]: JSON.stringify([
      {
        providerKind: "codex",
        providerVoteIdentityHash: "d".repeat(64),
      },
    ]),
    [reviewActionV2ProjectionPolicyVersionEnv]: "current-review-v1",
    [reviewActionV2CapabilityActiveKeyIdEnv]: "active-v2",
    [reviewActionV2CapabilityKeysEnv]: signingKeys,
  };
}

function inertPrisma(): PrismaClient {
  return {} as PrismaClient;
}
