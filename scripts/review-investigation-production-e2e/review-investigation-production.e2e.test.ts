import { item11Enabled } from "./support/item11-gate.fixture.mjs";
import { randomUUID } from "node:crypto";
import {
  createPrismaClient,
  type PrismaClient,
} from "../../packages/platform/db/src/index.js";
import { assertFixtureOwnership } from "./support/investigation-control-plane-child.fixture.js";
import type {
  Boot,
  Snapshot,
} from "./support/investigation-control-plane-process.fixture.js";
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

    // Each parameter is a separately reset, newly prepared database case. The
    // switch changes before the named read; this does not assert a commit fence.
    for (const boundary of ["admission", "planning", "active", "conclusion"] as const) {
      it(`denies investigation ${boundary} without stopping legacy review`, async () => {
        const fixture = requiredHarness(harness);
        let exercised = false;
        await fixture.runWithFinding({
          label: `disable-${boundary}`, expandRelations: false,
          terminalSource: InvestigationTelemetrySource.Shadow,
          boundary: async (stage, operation, investigationId) => {
            if (stage !== boundary || exercised) return;
            exercised = true;
            const before = await fixture.boundarySnapshot();
            const reads = fixture.emergency.reads;
            fixture.emergency.disabled = true;
            await expect(operation()).rejects.toMatchObject({
              statusCode: 403, issues: ["investigation_rollout_emergency_disabled"],
            });
            expect(fixture.emergency.reads).toBeGreaterThan(reads);
            expect(await fixture.boundarySnapshot()).toEqual(before);
            if (investigationId) {
              expect((await fixture.restoreBoundary(investigationId)).result).toMatchObject({
                status: "found", investigationId,
              });
              expect(await fixture.boundarySnapshot()).toEqual(before);
            }
            // Resume only after the disabled attempt and durable assertions;
            // the same composed handlers supply the enabled positive control.
            fixture.emergency.disabled = false;
          },
        });
        expect(exercised).toBe(true);
        fixture.emergency.disabled = true;
        await assertLegacyContinuity(fixture);
      }, 120_000);
    }

    it("restores immutable Findings and matching committed/terminal retries while disabled", async () => {
      const fixture = requiredHarness(harness);
      const stages: string[] = [];
      await fixture.runWithFinding({
        label: "disabled-restore", expandRelations: false,
        terminalSource: InvestigationTelemetrySource.Shadow,
        boundary: async (stage, replay, investigationId) => {
          if (stage !== "committed" && stage !== "terminal") return;
          if (investigationId === undefined) {
            throw new Error("review_investigation_e2e_investigation_id_missing");
          }
          stages.push(stage);
          const before = await fixture.boundarySnapshot();
          fixture.emergency.disabled = true;
          expect((await fixture.restoreBoundary(investigationId)).result.status).toBe("found");
          await replay();
          expect(await fixture.boundarySnapshot()).toEqual(before);
          expect(before.investigations[0]!.findings).not.toEqual([]);
          if (stage === "terminal") {
            expect(before.certificates).toHaveLength(1);
            // Repair only the disposable non-authoritative projection. Neither
            // this replay nor restore may issue a replacement certificate.
            await fixture.client.reviewInvestigationShadowEvidence.deleteMany({ where: { investigationId } });
            await replay();
            expect(await fixture.client.reviewInvestigationShadowEvidence.findMany({ where: { investigationId } })).toEqual([
              expect.objectContaining({ certificateHash: before.certificates[0]!.certificateHash, authority: "non_authoritative" }),
            ]);
            expect(await fixture.boundarySnapshot()).toEqual(before);
          }
          fixture.emergency.disabled = false;
        },
      });
      expect(stages).toContain("committed");
      expect(stages).toContain("terminal");
    }, 120_000);

    for (const conclusion of ["findings", "verified_clean"] as const) {
      for (const boundary of ["evidence", "finalization", "worker", "enabled"] as const) {
        it(`${conclusion}: ${boundary} preserves investigation authority`, async () => {
          const fixture = requiredHarness(harness);
          const input = { label: `${conclusion}-${boundary}`, expandRelations: false, attachSetup: true,
            terminalSource: InvestigationTelemetrySource.Shadow } as const;
          const flow = conclusion === "findings"
            ? await fixture.runWithFinding(input) : await fixture.runVerifiedClean(input);
          expect(await fixture.verifyAcceptedCertificate(flow)).toMatchObject({
            status: InvestigationCertificateVerificationStatus.Accepted, conclusion,
          });
          const prepared = await fixture.prepareCertificateAcceptance(flow);
          if (boundary === "evidence") {
            const before = await fixture.boundarySnapshot();
            const reads = fixture.emergency.reads;
            fixture.emergency.disabled = true;
            expect((await prepared.accept()).result).toMatchObject({
              status: "rejected", rejectionReason: "investigation_certificate_not_accepted",
            });
            expect(fixture.emergency.reads).toBeGreaterThan(reads);
            expect(await fixture.boundarySnapshot()).toEqual(before);
            fixture.emergency.disabled = false;
          }
          const accepted = await prepared.accept();
          expect(accepted.result.status).toBe("accepted");
          const observationId = accepted.result.observationId!;
          expect((await prepared.attach(observationId)).result.status).toBe("applied");
          const before = await fixture.boundarySnapshot();
          expect(before.observations.find(row => row.observationId === observationId)).toMatchObject({
            investigationCertificateId: flow.certificateId,
            investigationCertificateHash: flow.certificateHash,
            executionProfile: "investigation_gateway_v1",
          });
          if (boundary === "finalization") {
            const reads = fixture.emergency.reads;
            fixture.emergency.disabled = true;
            await expect(prepared.finalize(observationId)).rejects.toMatchObject({
              statusCode: 403, issues: ["investigation_rollout_emergency_disabled"],
            });
            expect(fixture.emergency.reads).toBeGreaterThan(reads);
            expect(await fixture.boundarySnapshot()).toEqual(before);
            fixture.emergency.disabled = false;
          }
          expect((await prepared.finalize(observationId)).result.status).toBe("applied");
          const finalized = await fixture.boundarySnapshot();
          expect(finalized.artifacts).toHaveLength(before.artifacts.length + 1);
          expect(finalized.outbox).toHaveLength(before.outbox.length + 1);
          expect(finalized.observations).toEqual(before.observations);
          expect(finalized.artifacts[0]!.findingCount).toBe(conclusion === "findings" ? 1 : 0);
          expect(finalized.artifacts[0]!.projectionEnvelope).toMatchObject({
            authoritativeObservationIds: [observationId],
            coverage: { state: "complete" },
            publishing: { summary: { allClear: conclusion === "verified_clean" } },
          });
          let postBeginReads: number | undefined;
          if (boundary === "worker") {
            fixture.emergency.beforeRead = async request => {
              if (!new URL(request.url).pathname.endsWith("/pulls/42")) return;
              const begun = await fixture.client.reviewPublicationOperationAttemptV2.count();
              if (begun === 0 || postBeginReads !== undefined) return;
              expect(fixture.base.fakeGitHub.comments).toHaveLength(0);
              expect(fixture.base.fakeGitHub.checkRuns).toHaveLength(0);
              postBeginReads = fixture.emergency.reads;
              fixture.emergency.disabled = true;
            };
          }
          await fixture.base.processFinalizedOutbox();
          await fixture.base.runWorkerUntilSettled();
          delete fixture.emergency.beforeRead;
          if (boundary === "worker") {
            expect(await fixture.client.reviewPublicationAuditTombstoneV2.findMany()).toEqual(
              expect.arrayContaining([expect.objectContaining({
                finalOutcome: "failed_no_effect",
                finalReason: "publication_effect_gate_disabled",
              })]),
            );
            expect(postBeginReads).toBeDefined();
            expect(fixture.emergency.reads).toBeGreaterThan(postBeginReads!);
            expect(fixture.base.fakeGitHub.comments).toHaveLength(0);
            expect(fixture.base.fakeGitHub.checkRuns).toHaveLength(0);
            expect(fixture.base.fakeGitHub.calls.filter(call =>
              ["POST", "PATCH", "PUT", "DELETE"].includes(call.method) &&
              /\/(comments|reviews|check-runs)(?:\/|$)/u.test(call.pathname))).toEqual([]);
            expect(await fixture.client.reviewPublicationAttemptV2.findMany()).toEqual([
              expect.objectContaining({ terminalOutcome: "failed_no_effect" }),
            ]);
          } else {
            expect(await fixture.client.reviewPublicationAttemptV2.findMany()).toEqual([
              expect.objectContaining({ terminalOutcome: "succeeded" }),
            ]);
            expect(fixture.base.fakeGitHub.comments.length).toBeGreaterThan(0);
            expect(fixture.base.fakeGitHub.checkRuns.length).toBeGreaterThan(0);
            if (conclusion === "findings") {
              expect(fixture.base.fakeGitHub.comments.some(comment => comment.body.includes("Investigation Findings"))).toBe(true);
              expect(fixture.base.fakeGitHub.checkRuns.some(check => check.conclusion === "failure")).toBe(true);
            }
          }
          const settled = await fixture.boundarySnapshot();
          expect(settled.certificates).toEqual(finalized.certificates);
          expect(settled.investigations).toEqual(finalized.investigations);
          expect(settled.observations).toEqual(finalized.observations);
          expect(settled.artifacts).toEqual(finalized.artifacts);
          fixture.emergency.disabled = true;
          expect((await fixture.restoreBoundary(flow.investigationId)).result.status).toBe("found");
          await fixture.retryTerminalBoundary(flow.investigationId);
          expect(await fixture.boundarySnapshot()).toEqual(settled);
          await assertLegacyContinuity(fixture);
        }, 120_000);
      }
    }

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

async function assertLegacyContinuity(fixture: ReviewInvestigationProductionE2EHarness) {
  expect(fixture.emergency.disabled).toBe(true);
  const authorization = await fixture.base.authorize();
  expect(authorization.authorizationToken.length).toBeGreaterThan(0);

  const legacy = await fixture.base.createCommittedFlow({ authorization });
  expect((await fixture.base.finalize(legacy)).result.status).toBe("applied");
  await fixture.base.processFinalizedOutbox();
  await fixture.base.runWorkerUntilSettled();
  expect(await fixture.client.reviewPublicationAttemptV2.findMany({ where: { executionId: legacy.executionId } })).toEqual([
    expect.objectContaining({ terminalOutcome: "succeeded" }),
  ]);
  expect(fixture.base.fakeGitHub.comments.some(comment => comment.body.includes("Review complete"))).toBe(true);
  expect(fixture.base.fakeGitHub.checkRuns.some(check => check.conclusion === "success")).toBe(true);
  expect(fixture.emergency.disabled).toBe(true);
}

function requiredHarness(
  value: ReviewInvestigationProductionE2EHarness | null,
): ReviewInvestigationProductionE2EHarness {
  if (!value) throw new Error("review_investigation_e2e_harness_missing");
  return value;
}

// Separate from the legacy suite's unconditional resets: assignment must be
// established before the first destructive operation for this scenario.
(item11Enabled(process.env) ? describe : describe.skip).sequential(
  "owned control-plane process persistence",
  () => {
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
      const withOwner = async (
        action: (client: PrismaClient) => Promise<void>,
      ) => {
        const client = createPrismaClient({
          databaseUrl: databaseUrl!,
          poolMax: 1,
        });
        try {
          await assertFixtureOwnership(client, databaseUrl!, runId);
          await action(client);
        } finally {
          await client.$disconnect();
        }
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
        fixture = await createReviewInvestigationProductionE2EHarness(
          databaseUrl!,
        );
        boots.push(await fixture.startControlPlaneProcess(runId));
        const flow = await fixture.runWithFinding({
          label: `os-restart-${runId}`,
          expandRelations: true,
          terminalSource: InvestigationTelemetrySource.Shadow,
          checkpoint: async ({ request, read }) => {
            checkpointCalls += 1;
            expect(checkpointCalls).toBe(1);
            const running = fixture!;
            checkpoint = await running.controlPlane.snapshot(
              read.investigationId,
            );
            expect(checkpoint.investigation.version.toString()).toBe(
              read.investigationVersion,
            );
            expect(checkpoint.investigation.dossierDigest).toBe(
              read.dossierDigest,
            );
            expect(checkpoint.investigation.activeTurnId).toBeNull();
            expect(checkpoint.investigation.findings).toHaveLength(1);
            expect(checkpoint.investigation.turnProvenance).not.toEqual([]);
            expect(
              checkpoint.turns.some(
                (turn) =>
                  turn.state === "committed" &&
                  turn.acceptedAttestationId &&
                  turn.sanitizedOutcomeHash,
              ),
            ).toBe(true);
            expect(checkpoint.receipts.length).toBeGreaterThan(0);
            expect(
              checkpoint.receipts.every(
                (receipt) =>
                  receipt.acceptedAttestationId &&
                  receipt.acceptedAttestationHash &&
                  receipt.evidenceDigest,
              ),
            ).toBe(true);
            expect(
              checkpoint.obligations.some(
                (obligation) => obligation.state === "open",
              ),
            ).toBe(true);
            expect(checkpoint.leases.length).toBeGreaterThan(0);
            // Committing a turn changes the binding and revokes its prior lease.
            expect(
              checkpoint.leases.every((lease) => lease.state === "revoked"),
            ).toBe(true);
            const observations =
              await running.client.reviewEvidenceObservation.count();
            expect(observations).toBe(1);
            boots.push(await running.replaceControlPlaneProcess());
            expect(boots[0]!.pid).not.toBe(process.pid);
            expect(boots[1]!.pid).not.toBe(boots[0]!.pid);
            expect(boots[1]!.nonce).not.toBe(boots[0]!.nonce);
            expect(
              await running.controlPlane.snapshot(read.investigationId),
            ).toEqual(checkpoint);
            const replay = await running.controlPlane.invoke("commit", request);
            expect(replay.result).toMatchObject({
              investigationVersion: read.investigationVersion,
              dossierDigest: read.dossierDigest,
            });
            expect(
              await running.controlPlane.snapshot(read.investigationId),
            ).toEqual(checkpoint);
            expect(
              checkpoint.commands.filter(
                (command) => command.commandId === request.idempotencyKey,
              ),
            ).toHaveLength(1);
            await expect(
              running.controlPlane.invoke(
                "commit",
                await conflictingCommitRequest(request),
              ),
            ).rejects.toThrow("item11_investigation_idempotency_conflict");
            expect(
              await running.controlPlane.snapshot(read.investigationId),
            ).toEqual(checkpoint);
            expect(await running.client.reviewEvidenceObservation.count()).toBe(
              observations,
            );
          },
        });
        expect(checkpointCalls).toBe(1);
        expect(checkpoint).toBeDefined();
        const terminal = await fixture.controlPlane.snapshot(
          flow.investigationId,
        );
        expect(terminal.investigation.investigationId).toBe(
          checkpoint!.investigation.investigationId,
        );
        expect(
          await fixture.client.reviewInvestigation.count({
            where: {
              naturalIdentityHash:
                checkpoint!.investigation.naturalIdentityHash,
            },
          }),
        ).toBe(1);
        expect(terminal.investigation.state).toBe("concluded");
        // Findings conclude directly; independent critic is required for clean.
        expect(
          terminal.turns.filter((turn) => turn.purpose === "critic"),
        ).toHaveLength(0);
        expect(terminal.certificates).toHaveLength(1);
        expect(terminal.shadows).toHaveLength(1);
        expect(terminal.telemetry).toHaveLength(1);
        expect(flow.expansionObligationCount).toBe(1);
        expect(await fixture.verifyAcceptedCertificate(flow)).toMatchObject({
          status: InvestigationCertificateVerificationStatus.Accepted,
          conclusion: InvestigationCertificateConclusion.Findings,
        });
        expect(terminal.investigation.findings).toEqual(
          checkpoint!.investigation.findings,
        );
        for (const receipt of checkpoint!.receipts) {
          const retained = terminal.receipts.find(
            (value) => value.receiptId === receipt.receiptId,
          )!;
          expect(retained).toBeDefined();
          // Conclusion may extend evidence retention; all evidence bindings stay exact.
          expect(retained.retainUntil.getTime()).toBeGreaterThanOrEqual(
            receipt.retainUntil.getTime(),
          );
          expect({ ...retained, retainUntil: receipt.retainUntil }).toEqual(
            receipt,
          );
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
            const rows = await client.$queryRaw<
              Array<{ claim_token: string }>
            >`SELECT claim_token FROM item11_fixture_owner`;
            expect(rows).toEqual([{ claim_token: claim }]);
          });
          await resetReviewInvestigationProductionE2EDatabase(databaseUrl!);
        }
        console.info("item11 resource measurements", {
          durationMs: Math.round(performance.now() - started),
          parentRssBytes: process.memoryUsage().rss,
          childBootRssBytes: boots.map((boot) => boot.rss),
          childLaunches: boots.length,
          configuredConnectionCeiling: 14,
        });
      }
    }, 120_000);
  },
);
