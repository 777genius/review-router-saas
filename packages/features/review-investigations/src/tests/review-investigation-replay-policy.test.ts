import { describe, expect, it } from "vitest";
import {
  CleanCertificateEligibilityReason,
  ContextCriticDecision,
  InvestigationObligationKind,
  InvestigationObligationOrigin,
  InvestigationObligationState,
  InvestigationReceiptKind,
  InvestigationTurnProviderKind,
  ReceiptReplayEligibilityReason,
  ReviewInvestigationConclusion,
  ReviewInvestigationState,
  evaluateCleanCertificateEligibility,
  evaluateReceiptReplayEligibility,
  type ReviewInvestigation,
} from "../index";

const now = Date.parse("2026-08-06T12:00:00.000Z");

describe("review investigation replay eligibility", () => {
  it("keeps clean publication eligibility separate from receipt replay", () => {
    const findings = source({
      state: ReviewInvestigationState.Concluded,
      conclusion: ReviewInvestigationConclusion.Findings,
    });

    expect(evaluateCleanCertificateEligibility(findings, now)).toEqual({
      eligible: false,
      reason: CleanCertificateEligibilityReason.NotVerifiedClean,
    });
    expect(evaluateReceiptReplayEligibility(findings, now)).toEqual({
      eligible: true,
      reason: ReceiptReplayEligibilityReason.Eligible,
    });
  });

  it("allows committed superseded evidence and rejects in-flight or expired sources", () => {
    const superseded = source({
      state: ReviewInvestigationState.Superseded,
      conclusion: null,
      certificate: null,
    });
    expect(evaluateReceiptReplayEligibility(superseded, now).eligible).toBe(
      true,
    );
    expect(
      evaluateReceiptReplayEligibility(
        {
          ...superseded,
          state: ReviewInvestigationState.TurnLeased,
          replayEvidenceCheckpoint: {
            ...superseded.replayEvidenceCheckpoint!,
            sourceState: ReviewInvestigationState.TurnLeased,
          },
        },
        now,
      ).reason,
    ).toBe(ReceiptReplayEligibilityReason.SourceInFlight);
    expect(
      evaluateReceiptReplayEligibility(
        {
          ...superseded,
          replayEvidenceCheckpoint: {
            ...superseded.replayEvidenceCheckpoint!,
            expiresAt: "2026-08-06T11:59:59.000Z",
          },
        },
        now,
      ).reason,
    ).toBe(ReceiptReplayEligibilityReason.CheckpointExpired);
  });
});

function source(overrides: Partial<ReviewInvestigation>): ReviewInvestigation {
  const state = overrides.state ?? ReviewInvestigationState.Concluded;
  const conclusion =
    overrides.conclusion === undefined
      ? ReviewInvestigationConclusion.VerifiedClean
      : overrides.conclusion;
  const investigation = {
    investigationId: "investigation-source",
    version: 7,
    state,
    conclusion,
    dossierDigest: "a".repeat(64),
    findings:
      conclusion === ReviewInvestigationConclusion.Findings
        ? [{ fingerprint: "finding-1" }]
        : [],
    obligations: [
      {
        obligationId: "b".repeat(64),
        kind: InvestigationObligationKind.ChangedContent,
        origin: InvestigationObligationOrigin.CoverageContract,
        state: InvestigationObligationState.Satisfied,
        receipt: {
          receiptId: "c".repeat(64),
          operationKey: "d".repeat(64),
          kind: InvestigationReceiptKind.Blob,
          canonicalSubject: "src/a.ts@head",
          reviewRevisionHash: "e".repeat(64),
          gatewayPolicyVersion: "gateway-v4",
          evidenceDigest: "f".repeat(64),
          operationReceiptIds: ["g".repeat(64)],
          acceptedAttestationId: "attestation-1",
          acceptedAttestationHash: "1".repeat(64),
          replayProofId: null,
          complete: true,
          truncated: false,
          failed: false,
        },
      },
    ],
    certificate: {
      conclusion,
      criticDecision: ContextCriticDecision.Accept,
      criticAttestationId: "critic-1",
      criticAttestationHash: "2".repeat(64),
      terminalProviderKind: InvestigationTurnProviderKind.Codex,
      terminalActualModel: "gpt-test",
      expiresAt: "2026-08-07T12:00:00.000Z",
    },
    replayEvidenceCheckpoint: {
      checkpointId: "checkpoint-1",
      checkpointHash: "3".repeat(64),
      sourceInvestigationId: "investigation-source",
      sourceInvestigationVersion: 7,
      sourceDossierDigest: "a".repeat(64),
      scopeHash: "4".repeat(64),
      reviewRevisionHash: "e".repeat(64),
      stableReviewUnitKey: "unit-1",
      providerVoteLaneId: "lane-1",
      contractHash: "5".repeat(64),
      policyHash: "6".repeat(64),
      producerReleaseId: "release-1",
      producerReleaseHash: "0".repeat(64),
      runtimeProfileHash: "7".repeat(64),
      receiptSetHash: "8".repeat(64),
      contextAttestationSetHash: "9".repeat(64),
      sourceState: state,
      sourceConclusion: conclusion,
      issuedAt: "2026-08-06T11:00:00.000Z",
      expiresAt: "2026-08-07T12:00:00.000Z",
    },
    ...overrides,
  };
  return investigation as unknown as ReviewInvestigation;
}
