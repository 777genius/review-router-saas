import {
  InvestigationEvaluationImportStatus,
  InvestigationPromotionDecision,
  InvestigationPromotionPolicyErrorCode,
  InvestigationTelemetryEvidenceCompleteness,
  InvestigationTelemetrySource,
} from "../../packages/features/review-investigation-operations/src/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createReviewInvestigationProductionE2EHarness,
  resetReviewInvestigationProductionE2EDatabase,
  type ReviewInvestigationProductionE2EHarness,
} from "./support/review-investigation-production-e2e-harness.js";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const enabled = process.env.REVIEW_ROUTER_REVIEW_INVESTIGATION_E2E === "1";
if (enabled && !databaseUrl) {
  throw new Error(
    "REVIEW_ROUTER_TEST_DATABASE_URL is required for review-investigation:e2e",
  );
}
const describeWithDatabase = databaseUrl && enabled ? describe : describe.skip;

describeWithDatabase.sequential(
  "review investigation production PostgreSQL E2E",
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

    it("survives restart, preserves record-only authority, and promotes only signed evaluated evidence", async () => {
      const fixture = requiredHarness(harness);
      const shadow = await fixture.runVerifiedClean({
        label: "shadow",
        expandRelations: true,
        terminalSource: InvestigationTelemetrySource.Shadow,
        restartAfterFirstCommit: true,
      });
      const disposable = await fixture.runVerifiedClean({
        label: "fixture",
        expandRelations: false,
        terminalSource: InvestigationTelemetrySource.DisposableFixture,
      });

      const shadowEvaluation = await fixture.importEvaluation(shadow, "shadow");
      const fixtureEvaluation = await fixture.importEvaluation(
        disposable,
        "fixture",
      );
      await expect(
        fixture.generatePromotionReport({
          ...fixture.promotionProfile,
          version: "retired.v0",
        }),
      ).rejects.toMatchObject({
        code: InvestigationPromotionPolicyErrorCode.ProfileNotConfigured,
      });
      await expect(
        fixture.client.reviewInvestigationPromotionReport.count(),
      ).resolves.toBe(0);
      const promotion = await fixture.generatePromotionReport();
      await fixture.assertSupersededHeadFailsClosed("superseded");

      expect(shadow.expansionObligationCount).toBe(1);
      expect(shadowEvaluation.first.status).toBe(
        InvestigationEvaluationImportStatus.Imported,
      );
      expect(shadowEvaluation.replay.status).toBe(
        InvestigationEvaluationImportStatus.AlreadyImported,
      );
      expect(fixtureEvaluation.first.status).toBe(
        InvestigationEvaluationImportStatus.Imported,
      );
      expect(fixtureEvaluation.replay.status).toBe(
        InvestigationEvaluationImportStatus.AlreadyImported,
      );
      expect(promotion.body).toMatchObject({
        decision: InvestigationPromotionDecision.Eligible,
        blockers: [],
        metrics: {
          fullyEvaluatedSamples: 2,
          terminalOperationalSamples: 2,
          seededSamples: 1,
          shadowSamples: 1,
          falseCleanCount: 0,
          securityViolationCount: 0,
        },
      });

      const [
        shadowRows,
        terminalRows,
        evaluationCount,
        observations,
        publications,
      ] = await Promise.all([
        fixture.client.reviewInvestigationShadowEvidence.findMany({
          orderBy: { investigationId: "asc" },
          select: {
            investigationId: true,
            authority: true,
            sourceKind: true,
            certificateHash: true,
          },
        }),
        fixture.client.reviewInvestigationTelemetrySample.findMany({
          where: {
            sampleId: {
              in: [shadow.terminalSampleId, disposable.terminalSampleId],
            },
          },
          orderBy: { sampleId: "asc" },
          select: { payload: true },
        }),
        fixture.client.reviewInvestigationEvaluationAttestation.count(),
        fixture.client.reviewEvidenceObservation.count(),
        fixture.client.reviewPublicationAttemptV2.count(),
      ]);

      expect(shadowRows).toHaveLength(2);
      expect(shadowRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            investigationId: shadow.investigationId,
            authority: "non_authoritative",
            sourceKind: "terminal_certificate",
            certificateHash: shadow.certificateHash,
          }),
          expect.objectContaining({
            investigationId: disposable.investigationId,
            authority: "non_authoritative",
            sourceKind: "terminal_certificate",
            certificateHash: disposable.certificateHash,
          }),
        ]),
      );
      expect(terminalRows).toHaveLength(2);
      for (const row of terminalRows) {
        expect(row.payload).toMatchObject({
          evidenceCompleteness:
            InvestigationTelemetryEvidenceCompleteness.TerminalOperational,
          expectedDefectCount: null,
          detectedDefectCount: null,
          falseClean: null,
          capacityWaitMs: null,
          securityViolationCount: null,
        });
      }
      expect(evaluationCount).toBe(2);
      await expect(
        fixture.client.reviewInvestigationPromotionReport.count(),
      ).resolves.toBe(1);

      // Three setup observations provide real lease authority. Investigation
      // record-only evidence must not create any additional observation or publication.
      expect(observations).toBe(3);
      expect(publications).toBe(0);
      expect(fixture.base.fakeGitHub.comments).toHaveLength(0);
      expect(fixture.base.fakeGitHub.checkRuns).toHaveLength(0);
    }, 120_000);
  },
);

function requiredHarness(
  value: ReviewInvestigationProductionE2EHarness | null,
): ReviewInvestigationProductionE2EHarness {
  if (!value) throw new Error("review_investigation_e2e_harness_missing");
  return value;
}
