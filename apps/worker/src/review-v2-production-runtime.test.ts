import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CurrentMutationAuthorityStatus,
  CurrentPublicationLifecycleStatus,
  CurrentPublicationPermitStatus,
  CurrentReviewRevisionStatus,
  CurrentReviewSafetyDecisionStatus,
  ReviewPublicationAdjudicationEvidenceStatus,
  ReviewPublicationCapability,
  ReviewPublicationRunControlStatus,
  ReviewPublicationTerminalOutcome,
  type ReviewPublicationDecisionPorts,
  type ReviewPublicationPermitIdentity,
} from "@reviewrouter/features-review-publishing/v2";
import type { createPrismaClient } from "@reviewrouter/platform-db";
import { SystemClock } from "@reviewrouter/shared";
import {
  mapPersistedContextReuseExecutionProfile,
  mapPersistedContextReuseProviderKind,
  mapPersistedContextReuseTaskKind,
  createProductionReviewV2WorkerRuntime,
  ProductionReviewV2Freshness,
  productionReviewV2AdjudicationEvidence,
  productionReviewV2PublicationCapabilities,
  reviewV2CapabilityActiveKeyIdEnv,
  reviewV2CapabilityKeysEnv,
} from "./review-v2-production-runtime";
import {
  ProviderExecutionProfile,
  ReviewProviderKind as EvidenceProviderKind,
  ReviewTaskKind as EvidenceTaskKind,
} from "@reviewrouter/features-review-evidence";
import {
  createReviewV2WorkerFeature,
  reviewV2WorkerEnabledEnv,
} from "./review-v2-worker-runtime";
import {
  ReviewV2ContextReusePublicationStatus,
  type ReviewV2ContextReusePublicationGuardPort,
} from "./review-v2-context-reuse-publication-guard";
import {
  ReviewV2PublicationFreshnessReadStatus,
  ReviewV2ScmProvider,
} from "./review-v2-publication-ports";

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

  it("maps every persisted context-reuse discriminator without throwing", () => {
    expect(mapPersistedContextReuseProviderKind("future_provider")).toBe(
      EvidenceProviderKind.Unknown,
    );
    expect(
      ["code_review", "finding_revalidation", "conflict_review"].map(
        mapPersistedContextReuseTaskKind,
      ),
    ).toEqual([
      EvidenceTaskKind.Unknown,
      EvidenceTaskKind.Unknown,
      EvidenceTaskKind.Unknown,
    ]);
    expect(
      mapPersistedContextReuseExecutionProfile("investigation_gateway_v1"),
    ).toBe(ProviderExecutionProfile.InvestigationGatewayV1);
    expect(mapPersistedContextReuseExecutionProfile("future_profile")).toBe(
      ProviderExecutionProfile.Unknown,
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

  it.each([
    "permit",
    "run-control",
    "authority",
    "lifecycle",
    "safety",
    "context-reuse",
  ] as const)(
    "keeps an unavailable %s fact retryable in the production freshness path",
    async (unavailableFact) => {
      const freshness = productionFreshness(unavailableFact);

      await expect(
        freshness.read(ReviewV2ScmProvider.GitHub, publicationPermit()),
      ).resolves.toEqual({
        status: ReviewV2PublicationFreshnessReadStatus.Unavailable,
        safeReason: "publication_live_tuple_unavailable",
      });
    },
  );

  it("keeps thrown live dependencies retryable in the production freshness path", async () => {
    const freshness = productionFreshness("dependency-throw");

    await expect(
      freshness.read(ReviewV2ScmProvider.GitHub, publicationPermit()),
    ).resolves.toEqual({
      status: ReviewV2PublicationFreshnessReadStatus.Unavailable,
      safeReason: "publication_live_tuple_unavailable",
    });
  });

  it("classifies a proven non-current fact as missing rather than unavailable", async () => {
    const freshness = productionFreshness("permit-stale");

    await expect(
      freshness.read(ReviewV2ScmProvider.GitHub, publicationPermit()),
    ).resolves.toEqual({
      status: ReviewV2PublicationFreshnessReadStatus.Missing,
      safeReason: "publication_live_tuple_not_current",
    });
  });

  it("returns the complete freshness snapshot when every fact is current", async () => {
    const permit = publicationPermit();

    await expect(
      productionFreshness("all-current").read(
        ReviewV2ScmProvider.GitHub,
        permit,
      ),
    ).resolves.toEqual({
      status: ReviewV2PublicationFreshnessReadStatus.Available,
      snapshot: {
        baseSha: "b".repeat(40),
        mergeBaseSha: "c".repeat(40),
        reviewedHeadSha: permit.reviewedHeadSha,
        reviewRevisionHash: permit.reviewRevisionHash,
        lifecycleStateHash: permit.lifecycleStateHash,
        commandLedgerWatermark: permit.commandLedgerWatermark,
        authorizationId: permit.authorizationId,
        producerReleaseId: permit.producerReleaseId,
        permitEpoch: permit.permitEpoch,
        publicationSafetyDecisionHash: permit.publicationSafetyDecisionHash,
        publicationNotAfter: permit.publicationNotAfter,
      },
    });
  });
});

type FreshnessFact =
  | "all-current"
  | "permit"
  | "run-control"
  | "authority"
  | "lifecycle"
  | "safety"
  | "context-reuse"
  | "dependency-throw"
  | "permit-stale";

function productionFreshness(fact: FreshnessFact): ProductionReviewV2Freshness {
  const permit = publicationPermit();
  const decisions: ReviewPublicationDecisionPorts = {
    permits: {
      async resolve() {
        if (fact === "dependency-throw")
          throw new Error("provider_unavailable");
        if (fact === "permit") {
          return {
            status: CurrentPublicationPermitStatus.Unavailable,
            reason: "permit_unavailable",
          };
        }
        if (fact === "permit-stale") {
          return {
            status: CurrentPublicationPermitStatus.Stale,
            reason: "permit_stale",
          };
        }
        return { status: CurrentPublicationPermitStatus.Current, permit };
      },
    },
    runControl: {
      async resolve() {
        return {
          status:
            fact === "run-control"
              ? ReviewPublicationRunControlStatus.Unavailable
              : ReviewPublicationRunControlStatus.Allowed,
          authorizationId: permit.authorizationId,
          producerReleaseId: permit.producerReleaseId,
        };
      },
    },
    authority: {
      async resolve() {
        return {
          status:
            fact === "authority"
              ? CurrentMutationAuthorityStatus.Unavailable
              : CurrentMutationAuthorityStatus.Active,
          mutationEpoch: fact === "authority" ? null : permit.permitEpoch,
        };
      },
    },
    revision: {
      async resolve() {
        return {
          status: CurrentReviewRevisionStatus.Current,
          reviewedHeadSha: permit.reviewedHeadSha,
          reviewRevisionHash: permit.reviewRevisionHash,
        };
      },
    },
    lifecycle: {
      async resolve() {
        return {
          status:
            fact === "lifecycle"
              ? CurrentPublicationLifecycleStatus.Unavailable
              : CurrentPublicationLifecycleStatus.Current,
          lifecycleStateHash:
            fact === "lifecycle" ? null : permit.lifecycleStateHash,
          commandLedgerWatermark:
            fact === "lifecycle" ? null : permit.commandLedgerWatermark,
        };
      },
    },
    safety: {
      async resolve() {
        return {
          status:
            fact === "safety"
              ? CurrentReviewSafetyDecisionStatus.Unavailable
              : CurrentReviewSafetyDecisionStatus.Allowed,
          decisionHash:
            fact === "safety" ? null : permit.publicationSafetyDecisionHash,
        };
      },
    },
  };
  const contextReuse: ReviewV2ContextReusePublicationGuardPort = {
    async resolve() {
      return {
        status:
          fact === "context-reuse"
            ? ReviewV2ContextReusePublicationStatus.Unavailable
            : ReviewV2ContextReusePublicationStatus.Current,
      };
    },
  };
  return new ProductionReviewV2Freshness(
    decisions,
    [
      {
        provider: ReviewV2ScmProvider.GitHub,
        async readLiveRevision() {
          return {
            baseSha: "b".repeat(40),
            mergeBaseSha: "c".repeat(40),
            headSha: permit.reviewedHeadSha,
            reviewRevisionHash: permit.reviewRevisionHash,
          };
        },
      },
    ],
    contextReuse,
  );
}

function publicationPermit(): ReviewPublicationPermitIdentity {
  return {
    workspaceId: "workspace-1",
    repositoryConnectionId: "repository-connection-1",
    scmRepositoryIdentityId: "scm-repository-1",
    pullRequestNumber: 42,
    executionId: "execution-1",
    generation: 1n,
    authorizationId: "authorization-1",
    producerReleaseId: "release-1",
    reviewedHeadSha: "a".repeat(40),
    reviewRevisionHash: "b".repeat(64),
    projectionHash: "c".repeat(64),
    lifecycleStateHash: "d".repeat(64),
    commandLedgerWatermark: 2n,
    permitEpoch: 7n,
    publicationSafetyDecisionHash: "f".repeat(64),
    publicationNotAfter: new Date("2026-08-05T12:00:00.000Z"),
  };
}
