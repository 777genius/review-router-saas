import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ReviewPublicationAdjudicationEvidenceStatus,
  ReviewPublicationCapability,
  ReviewPublicationTerminalOutcome,
} from "@reviewrouter/features-review-publishing/v2";
import type { createPrismaClient } from "@reviewrouter/platform-db";
import { SystemClock } from "@reviewrouter/shared";
import {
  createProductionReviewV2WorkerRuntime,
  productionReviewV2AdjudicationEvidence,
  productionReviewV2PublicationCapabilities,
  reviewV2CapabilityActiveKeyIdEnv,
  reviewV2CapabilityKeysEnv,
} from "./review-v2-production-runtime";
import {
  createReviewV2WorkerFeature,
  reviewV2WorkerEnabledEnv,
} from "./review-v2-worker-runtime";

describe("review v2 production worker composition", () => {
  it("boots the enabled factory with Prisma, GitHub App, publication, and schedulers", () => {
    const env = {
      [reviewV2WorkerEnabledEnv]: "1",
      [reviewV2CapabilityActiveKeyIdEnv]: "review-v2-key-1",
      [reviewV2CapabilityKeysEnv]: JSON.stringify([
        {
          keyId: "review-v2-key-1",
          secretBase64: Buffer.alloc(32, 7).toString("base64"),
          verifyUntil: null,
        },
      ]),
      REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_ACTIVE_KEY_ID: "review-run-key-1",
      REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON: JSON.stringify([
        {
          keyId: "review-run-key-1",
          secretBase64: Buffer.alloc(32, 8).toString("base64"),
          verifyUntil: null,
        },
      ]),
      REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON:
        JSON.stringify([
          {
            producerReleaseId: "producer-release-1",
            distributionKind: "public_reusable",
            actionCommitSha: "a".repeat(40),
            runtimeCommitSha: "b".repeat(40),
            wrapperEntrypointDigest: null,
            runtimeEntrypointDigest: "c".repeat(64),
            schemaDigest: "d".repeat(64),
            canonicalizerDigest: "e".repeat(64),
            capabilityProfile: "exact_revision_v2",
            protocolLimitsProfileId: "limits-1",
            operationalSloProfileId: "slo-1",
          },
        ]),
    };
    const prisma = {} as ReturnType<typeof createPrismaClient>;
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();

    const feature = createReviewV2WorkerFeature({
      env,
      createEnabledRuntime: () =>
        createProductionReviewV2WorkerRuntime({
          prisma,
          clock: new SystemClock(),
          env,
          githubAppId: "1",
          githubPrivateKey: privateKey,
        }),
    });

    expect(feature.enabled).toBe(true);
    expect(feature.handlers.map((handler) => handler.type)).toEqual([
      "review.execution.finalized",
      "github.pull_request.review_request_ingress",
      "review.request.ingress",
    ]);
  });

  it("reports the missing enabled-only key explicitly", () => {
    expect(() =>
      createProductionReviewV2WorkerRuntime({
        prisma: {} as ReturnType<typeof createPrismaClient>,
        clock: new SystemClock(),
        env: {},
        githubAppId: "1",
        githubPrivateKey: "unused",
      }),
    ).toThrow(
      `review_v2_worker_config_missing:${reviewV2CapabilityActiveKeyIdEnv}`,
    );
  });

  it("enables every declared publication capability in production", () => {
    expect([...productionReviewV2PublicationCapabilities()].sort()).toEqual(
      [...Object.values(ReviewPublicationCapability)].sort(),
    );
  });

  it("deliberately gates operator adjudication without verified live inventory", async () => {
    await expect(
      productionReviewV2AdjudicationEvidence.resolve({
        publicationAttemptId: "publication-1",
        correctedOutcome: ReviewPublicationTerminalOutcome.Succeeded,
        evidenceHash: "e".repeat(64),
      }),
    ).resolves.toEqual({
      status: ReviewPublicationAdjudicationEvidenceStatus.Unavailable,
      reason: "operator_adjudication_requires_live_inventory",
    });
  });
});
