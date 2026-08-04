import { createHash } from "node:crypto";
import { InvestigationTelemetrySource } from "../../packages/features/review-investigation-operations/src/index.js";
import { canonicalJson } from "../../packages/features/review-run-control/src/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReviewInvestigationProductionE2EHarness,
  productionInvestigationPolicy,
  resetReviewInvestigationProductionE2EDatabase,
  type ReviewInvestigationProductionE2EHarness,
} from "../review-investigation-production-e2e/support/review-investigation-production-e2e-harness.js";
import releaseFixture from "./review-investigation-release.fixture.json";

vi.mock(
  "../../apps/api/src/review-action-v2-production-composition.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../apps/api/src/review-action-v2-production-composition.js")
      >();
    return {
      ...actual,
      composeReviewActionV2ProductionRoutes: (
        input: Parameters<
          typeof actual.composeReviewActionV2ProductionRoutes
        >[0],
      ) =>
        actual.composeReviewActionV2ProductionRoutes({
          ...input,
          env: {
            ...input.env,
            REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_ACTIVE_KEY_ID:
              "self-hosted-e2e-private-material",
            REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_KEYS_JSON:
              JSON.stringify({
                "self-hosted-e2e-private-material": Buffer.from(
                  "self-hosted-e2e-private-key-32b!",
                ).toString("base64url"),
              }),
            REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_TTL_MS:
              "86400000",
          },
        }),
    };
  },
);

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const enabled = process.env.REVIEW_ROUTER_SELF_HOSTED_REVIEW_PATHS_E2E === "1";
if (enabled && !databaseUrl) {
  throw new Error(
    "REVIEW_ROUTER_TEST_DATABASE_URL is required for the self-hosted review paths E2E",
  );
}
const describeWithDatabase = databaseUrl && enabled ? describe : describe.skip;

describeWithDatabase.sequential(
  "self-hosted legacy and investigation review paths",
  () => {
    let harness: ReviewInvestigationProductionE2EHarness | null = null;

    beforeEach(async () => {
      await resetReviewInvestigationProductionE2EDatabase(databaseUrl!);
      harness = await createReviewInvestigationProductionE2EHarness(
        databaseUrl!,
      );
    });

    afterEach(async () => {
      await harness?.close();
      harness = null;
      await resetReviewInvestigationProductionE2EDatabase(databaseUrl!);
    });

    it("completes legacy and fake-gateway investigation work on one immutable producer release", async () => {
      const fixture = requiredHarness(harness);
      const expected = expectedReleaseProfile();
      const before = await readImmutableRelease(fixture);

      expect(before).toMatchObject(expected);
      expect(configuredReleaseProfile(fixture)).toMatchObject(expected);
      expectRequiredRolloutOnly(fixture);

      const authorization = await fixture.base.authorize();
      // The shared harness normally owns one authorization per scenario. Reuse
      // it here so both paths prove the same release without a duplicate OIDC run.
      Object.assign(fixture, { authorization });
      const legacy = await fixture.base.createCommittedFlow({ authorization });
      await fixture.base.releaseProviderLease(legacy);
      await fixture.base.finalize(legacy);
      await fixture.base.processFinalizedOutbox();
      await fixture.base.runWorkerUntilSettled();

      const legacyState =
        await fixture.client.reviewExecutionV2.findUniqueOrThrow({
          where: { executionId: legacy.executionId },
          select: { producerReleaseId: true, state: true },
        });
      const legacyObservation =
        await fixture.client.reviewEvidenceObservation.findUniqueOrThrow({
          where: { observationId: legacy.observationId },
          select: { producerReleaseId: true },
        });
      expect(legacyState).toEqual({
        producerReleaseId: fixture.base.producerReleaseId,
        state: "completed",
      });
      expect(legacyObservation.producerReleaseId).toBe(
        fixture.base.producerReleaseId,
      );

      const investigation = await fixture.runVerifiedClean({
        label: "self-hosted-same-release",
        expandRelations: true,
        terminalSource: InvestigationTelemetrySource.DisposableFixture,
        restartAfterFirstCommit: true,
      });
      const [investigationState, investigationExecution, gatewaySessions] =
        await Promise.all([
          fixture.client.reviewInvestigation.findUniqueOrThrow({
            where: { investigationId: investigation.investigationId },
            select: {
              certificateId: true,
              producerReleaseId: true,
              state: true,
            },
          }),
          fixture.client.reviewExecutionV2.findUniqueOrThrow({
            where: { executionId: investigation.executionId },
            select: { producerReleaseId: true },
          }),
          fixture.client.reviewContextGatewaySession.findMany({
            where: { sourceExecutionId: investigation.executionId },
            select: {
              gatewayPolicyVersion: true,
              producerReleaseId: true,
              state: true,
            },
          }),
        ]);

      expect(investigationState).toEqual({
        certificateId: investigation.certificateId,
        producerReleaseId: fixture.base.producerReleaseId,
        state: "concluded",
      });
      expect(investigationExecution.producerReleaseId).toBe(
        fixture.base.producerReleaseId,
      );
      expect(gatewaySessions.length).toBeGreaterThan(0);
      expect(gatewaySessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            gatewayPolicyVersion: releaseFixture.contextGateway.policyVersion,
            producerReleaseId: fixture.base.producerReleaseId,
            state: "accepted",
          }),
        ]),
      );
      expect(await readImmutableRelease(fixture)).toEqual(before);
      expect(
        new Set([
          legacyState.producerReleaseId,
          legacyObservation.producerReleaseId,
          investigationState.producerReleaseId,
          investigationExecution.producerReleaseId,
          ...gatewaySessions.map((session) => session.producerReleaseId),
        ]),
      ).toEqual(new Set([fixture.base.producerReleaseId]));
      expect(fixture.base.fakeGitHub.comments).toHaveLength(1);
      expect(fixture.base.fakeGitHub.checkRuns).toHaveLength(1);
    }, 120_000);

    it("fails closed before investigation state when the registered profile is changed", async () => {
      const fixture = requiredHarness(harness);
      await fixture.client.producerRelease.update({
        where: { producerReleaseId: fixture.base.producerReleaseId },
        data: { reviewInvestigationPolicyHash: "0".repeat(64) },
      });

      await expect(
        fixture.runVerifiedClean({
          label: "self-hosted-profile-mismatch",
          expandRelations: false,
          terminalSource: InvestigationTelemetrySource.DisposableFixture,
        }),
      ).rejects.toMatchObject({
        errorCode: "forbidden",
        issues: ["producer_release_attestation_mismatch"],
        statusCode: 403,
      });
      await expect(fixture.client.reviewInvestigation.count()).resolves.toBe(0);
      await expect(
        fixture.client.reviewContextGatewaySession.count(),
      ).resolves.toBe(0);
      await expect(fixture.client.reviewRunAuthorization.count()).resolves.toBe(
        0,
      );
    }, 60_000);
  },
);

function requiredHarness(
  value: ReviewInvestigationProductionE2EHarness | null,
): ReviewInvestigationProductionE2EHarness {
  if (!value) throw new Error("self_hosted_review_paths_harness_missing");
  return value;
}

function expectedReleaseProfile() {
  expect(releaseFixture.contextGateway.supportedPolicyVersions).toEqual([
    "context-gateway-v3",
    "context-gateway-v4",
  ]);
  expect(releaseFixture.contextGateway.supportedPolicyVersions).toContain(
    releaseFixture.contextGateway.policyVersion,
  );
  expect(sha256(canonicalJson(productionInvestigationPolicy))).toBe(
    releaseFixture.reviewInvestigation.policyHash,
  );
  expect(productionInvestigationPolicy).toEqual(
    releaseFixture.reviewInvestigation.policy,
  );
  return {
    contextGatewayEntrypointDigest:
      releaseFixture.contextGateway.entrypointDigest,
    contextGatewayPolicyVersion: releaseFixture.contextGateway.policyVersion,
    reviewInvestigationCapability:
      releaseFixture.reviewInvestigation.capability,
    reviewInvestigationCoverageProfileHash:
      releaseFixture.reviewInvestigation.coverageProfileHash,
    reviewInvestigationPolicyHash:
      releaseFixture.reviewInvestigation.policyHash,
  } as const;
}

function configuredReleaseProfile(
  fixture: ReviewInvestigationProductionE2EHarness,
) {
  const raw =
    fixture.base.env[
      "REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON"
    ];
  if (!raw) throw new Error("self_hosted_release_attestation_missing");
  const values = JSON.parse(raw) as readonly Record<string, unknown>[];
  const configured = values.find(
    (value) => value.producerReleaseId === fixture.base.producerReleaseId,
  );
  if (!configured) throw new Error("self_hosted_release_attestation_mismatch");
  return configured;
}

function expectRequiredRolloutOnly(
  fixture: ReviewInvestigationProductionE2EHarness,
): void {
  expect(fixture.base.env).toMatchObject({
    REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED: "1",
    REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: "1",
    REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED: "1",
  });
  for (const name of [
    "REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED",
    "REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED",
    "REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED",
  ]) {
    expect(fixture.base.env[name]).toBeUndefined();
  }
}

async function readImmutableRelease(
  fixture: ReviewInvestigationProductionE2EHarness,
) {
  return fixture.client.producerRelease.findUniqueOrThrow({
    where: { producerReleaseId: fixture.base.producerReleaseId },
    select: {
      actionCommitSha: true,
      capabilityProfile: true,
      contextGatewayEntrypointDigest: true,
      contextGatewayPolicyVersion: true,
      distributionKind: true,
      operationalSloProfileId: true,
      producerReleaseId: true,
      protocolLimitsProfileId: true,
      reviewInvestigationCapability: true,
      reviewInvestigationCoverageProfileHash: true,
      reviewInvestigationPolicyHash: true,
      runtimeCommitSha: true,
      runtimeEntrypointDigest: true,
      schemaDigest: true,
      state: true,
      wrapperEntrypointDigest: true,
    },
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
