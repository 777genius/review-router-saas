import { item11Enabled } from "./support/item11-gate.fixture.mjs";
import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "../../packages/platform/db/src/index.js";
import { assertFixtureOwnership } from "./support/investigation-control-plane-child.fixture.js";
import type { Boot, Snapshot } from "./support/investigation-control-plane-process.fixture.js";
import {
  InvestigationEvaluationImportStatus,
  InvestigationPromotionDecision,
  InvestigationPromotionPolicyErrorCode,
  InvestigationTelemetryEvidenceCompleteness,
  InvestigationTelemetrySource,
} from "../../packages/features/review-investigation-operations/src/index.js";
import {
  InvestigationCertificateConclusion,
  InvestigationCertificateVerificationDenialReason,
  InvestigationCertificateVerificationStatus,
} from "../../packages/features/review-evidence/src/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  conflictingCommitRequest,
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

    it("persists attested finding evidence across restart and certificate acceptance", async () => {
      const fixture = requiredHarness(harness);
      const flow = await fixture.runWithFinding({
        label: "finding-restart",
        expandRelations: false,
        terminalSource: InvestigationTelemetrySource.Shadow,
        restartAfterFindingCommit: true,
      });
      const certificateVerification =
        await fixture.verifyAcceptedCertificate(flow);
      const investigation =
        await fixture.client.reviewInvestigation.findUniqueOrThrow({
          where: { investigationId: flow.investigationId },
          select: {
            state: true,
            conclusion: true,
            findings: true,
            turnProvenance: true,
          },
        });
      const findings = investigation.findings as Array<{
        evidenceReceiptIds: string[];
      }>;
      const provenance = investigation.turnProvenance as Array<{
        acceptedOperationReceiptIds?: string[];
      }>;
      const acceptedOperationReceiptIds = new Set(
        provenance.flatMap((turn) => turn.acceptedOperationReceiptIds ?? []),
      );

      expect(investigation).toMatchObject({
        state: "concluded",
        conclusion: "findings",
      });
      expect(findings).toHaveLength(1);
      expect(certificateVerification).toEqual({
        status: InvestigationCertificateVerificationStatus.Accepted,
        reason: InvestigationCertificateVerificationDenialReason.None,
        acceptedCertificateHash: flow.certificateHash,
        conclusion: InvestigationCertificateConclusion.Findings,
      });
      expect(findings[0]!.evidenceReceiptIds.length).toBeGreaterThan(0);
      expect(
        findings[0]!.evidenceReceiptIds.every((receiptId) =>
          acceptedOperationReceiptIds.has(receiptId),
        ),
      ).toBe(true);
      await expect(
        fixture.client.reviewInvestigationShadowEvidence.findFirstOrThrow({
          where: {
            investigationId: flow.investigationId,
            certificateHash: flow.certificateHash,
          },
        }),
      ).resolves.toMatchObject({
        sourceKind: "terminal_certificate",
        authority: "non_authoritative",
      });
    }, 120_000);
  },
);

function requiredHarness(
  value: ReviewInvestigationProductionE2EHarness | null,
): ReviewInvestigationProductionE2EHarness {
  if (!value) throw new Error("review_investigation_e2e_harness_missing");
  return value;
}

// Separate from the legacy suite's unconditional resets: assignment must be
// established before the first destructive operation for this scenario.
(item11Enabled(process.env) ? describe : describe.skip).sequential("owned control-plane process persistence", () => {
  it("restores durable investigation state after OS process restart", async () => {
    const databaseUrl = process.env.REVIEW_ROUTER_ITEM11_DATABASE_URL;
    const started = performance.now();
    const runId = process.env.REVIEW_ROUTER_ITEM11_RUN_ID ?? "";
    const claim = randomUUID();
    let fixture: ReviewInvestigationProductionE2EHarness | undefined;
    let claimed = false;
    let checkpoint: Snapshot | undefined;
    let checkpointCalls = 0;
    const boots: Boot[] = [];
    const withOwner = async (action: (client: PrismaClient) => Promise<void>) => {
      const client = createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 1 });
      try {
        await assertFixtureOwnership(client, databaseUrl!, runId);
        await action(client);
      } finally { await client.$disconnect(); }
    };
    try {
      await withOwner(async (client) => {
        const count = await client.$executeRaw`
          UPDATE item11_fixture_owner SET claim_token = ${claim}
          WHERE run_id = ${runId} AND claim_token IS NULL`;
        expect(count).toBe(1);
        claimed = true;
      });
      await resetReviewInvestigationProductionE2EDatabase(databaseUrl!);
      fixture = await createReviewInvestigationProductionE2EHarness(databaseUrl!);
      boots.push(await fixture.startControlPlaneProcess(runId));
      const flow = await fixture.runWithFinding({
        label: `os-restart-${runId}`, expandRelations: true,
        terminalSource: InvestigationTelemetrySource.Shadow,
        checkpoint: async ({ request, read }) => {
          checkpointCalls += 1;
          expect(checkpointCalls).toBe(1);
          const running = fixture!;
          checkpoint = await running.controlPlane.snapshot(read.investigationId);
          expect(checkpoint.investigation.version.toString()).toBe(read.investigationVersion);
          expect(checkpoint.investigation.dossierDigest).toBe(read.dossierDigest);
          expect(checkpoint.investigation.activeTurnId).toBeNull();
          expect(checkpoint.investigation.findings).toHaveLength(1);
          expect(checkpoint.investigation.turnProvenance).not.toEqual([]);
          expect(checkpoint.turns.some((turn) => turn.state === "committed" && turn.acceptedAttestationId && turn.sanitizedOutcomeHash)).toBe(true);
          expect(checkpoint.receipts.length).toBeGreaterThan(0);
          expect(checkpoint.receipts.every((receipt) => receipt.acceptedAttestationId && receipt.acceptedAttestationHash && receipt.evidenceDigest)).toBe(true);
          expect(checkpoint.obligations.some((obligation) => obligation.state === "open")).toBe(true);
          expect(checkpoint.leases.length).toBeGreaterThan(0);
          expect(checkpoint.leases.every((lease) => lease.state === "released")).toBe(true);
          const observations = await running.client.reviewEvidenceObservation.count();
          expect(observations).toBe(1);
          boots.push(await running.replaceControlPlaneProcess());
          expect(boots[0]!.pid).not.toBe(process.pid);
          expect(boots[1]!.pid).not.toBe(boots[0]!.pid);
          expect(boots[1]!.nonce).not.toBe(boots[0]!.nonce);
          expect(await running.controlPlane.snapshot(read.investigationId)).toEqual(checkpoint);
          const replay = await running.controlPlane.invoke("commit", request);
          expect(replay.result).toMatchObject({ investigationVersion: read.investigationVersion, dossierDigest: read.dossierDigest });
          expect(await running.controlPlane.snapshot(read.investigationId)).toEqual(checkpoint);
          expect(checkpoint.commands.filter((command) => command.commandId === request.idempotencyKey)).toHaveLength(1);
          await expect(running.controlPlane.invoke("commit", await conflictingCommitRequest(request)))
            .rejects.toThrow("item11_investigation_idempotency_conflict");
          expect(await running.controlPlane.snapshot(read.investigationId)).toEqual(checkpoint);
          expect(await running.client.reviewEvidenceObservation.count()).toBe(observations);
        },
      });
      expect(checkpointCalls).toBe(1);
      expect(checkpoint).toBeDefined();
      const terminal = await fixture.controlPlane.snapshot(flow.investigationId);
      expect(terminal.investigation.investigationId).toBe(checkpoint!.investigation.investigationId);
      expect(await fixture.client.reviewInvestigation.count({ where: { naturalIdentityHash: checkpoint!.investigation.naturalIdentityHash } })).toBe(1);
      expect(terminal.investigation.state).toBe("concluded");
      expect(terminal.turns.some((turn) => turn.purpose === "critic" && turn.state === "committed")).toBe(true);
      expect(terminal.certificates).toHaveLength(1);
      expect(terminal.shadows).toHaveLength(1);
      expect(terminal.telemetry).toHaveLength(1);
      expect(flow.expansionObligationCount).toBe(1);
      expect(await fixture.verifyAcceptedCertificate(flow)).toMatchObject({ status: InvestigationCertificateVerificationStatus.Accepted, conclusion: InvestigationCertificateConclusion.Findings });
      expect(terminal.investigation.findings).toEqual(checkpoint!.investigation.findings);
      for (const receipt of checkpoint!.receipts) {
        const retained = terminal.receipts.find((value) => value.receiptId === receipt.receiptId)!;
        expect(retained).toBeDefined();
        // Conclusion may extend evidence retention; all evidence bindings stay exact.
        expect(retained.retainUntil.getTime()).toBeGreaterThanOrEqual(receipt.retainUntil.getTime());
        expect({ ...retained, retainUntil: receipt.retainUntil }).toEqual(receipt);
      }
      expect(await fixture.client.reviewEvidenceObservation.count()).toBe(1);
      expect(await fixture.client.reviewPublicationAttemptV2.count()).toBe(0);
      expect(fixture.base.fakeGitHub.comments).toHaveLength(0);
      expect(fixture.base.fakeGitHub.checkRuns).toHaveLength(0);
    } finally {
      // If close cannot establish death this throws before any database reset.
      await fixture?.close();
      if (claimed) {
        await withOwner(async (client) => {
          const rows = await client.$queryRaw<Array<{ claim_token: string }>>`SELECT claim_token FROM item11_fixture_owner`;
          expect(rows).toEqual([{ claim_token: claim }]);
        });
        await resetReviewInvestigationProductionE2EDatabase(databaseUrl!);
      }
      console.info("item11 resource measurements", {
        durationMs: Math.round(performance.now() - started),
        parentRssBytes: process.memoryUsage().rss,
        childBootRssBytes: boots.map((boot) => boot.rss),
        childLaunches: boots.length, configuredConnectionCeiling: 14,
      });
    }
  }, 120_000);
});
