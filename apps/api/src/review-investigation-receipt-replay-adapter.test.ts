import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  InvestigationObligationKind,
  InvestigationObligationOrigin,
  InvestigationObligationState,
  InvestigationReceiptKind,
  InvestigationReceiptReplayVerdict,
} from "@reviewrouter/features-review-investigations";
import { NodeSha256InvestigationDigest } from "@reviewrouter/features-review-investigations/composition";
import { canonicalJson } from "@reviewrouter/features-review-run-control";
import { ContextAttestationInvestigationReceiptReplayAdapter } from "./review-investigation-receipt-replay-adapter.js";

describe("ContextAttestationInvestigationReceiptReplayAdapter", () => {
  it("derives a target-bound receipt from a matching unexpired proof", async () => {
    const store = {
      findReplayProof: vi.fn().mockResolvedValue(proof),
      findAcceptedAttestation: vi.fn().mockResolvedValue({
        attestationId: "attestation-1",
        attestationHash: hash("attestation"),
        reuseExpiresAtMs: 2_000,
        sessionId: "session-1",
      }),
      findSession: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
    };
    const adapter = new ContextAttestationInvestigationReceiptReplayAdapter(
      store as never,
      { nowMs: () => 1_000 },
      new NodeSha256InvestigationDigest(),
      currentFacts(),
    );

    const result = await adapter.replay(replayInput);

    expect(result).toMatchObject({
      verdict: InvestigationReceiptReplayVerdict.Matched,
      targetReceipt: {
        reviewRevisionHash: hash("target-revision"),
        replayProofId: "proof-1",
        acceptedAttestationId: "attestation-1",
      },
    });
    expect(result.targetReceipt?.receiptId).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed when the proof is scoped to another target slot", async () => {
    const adapter = new ContextAttestationInvestigationReceiptReplayAdapter(
      {
        findReplayProof: vi
          .fn()
          .mockResolvedValue({ ...proof, targetWorkSlotId: "other-slot" }),
        findAcceptedAttestation: vi.fn().mockResolvedValue({
          attestationId: "attestation-1",
          attestationHash: hash("attestation"),
          reuseExpiresAtMs: 2_000,
          sessionId: "session-1",
        }),
        findSession: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
      } as never,
      { nowMs: () => 1_000 },
      new NodeSha256InvestigationDigest(),
      currentFacts(),
    );

    await expect(adapter.replay(replayInput)).resolves.toEqual({
      verdict: InvestigationReceiptReplayVerdict.Mismatched,
      targetReceipt: null,
    });
  });

  it("fails closed when the live reuse-policy vector changed", async () => {
    const store = {
      findReplayProof: vi.fn().mockResolvedValue(proof),
      findAcceptedAttestation: vi.fn().mockResolvedValue({
        attestationId: "attestation-1",
        attestationHash: hash("attestation"),
        reuseExpiresAtMs: 2_000,
        sessionId: "session-1",
      }),
      findSession: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
    };
    const adapter = new ContextAttestationInvestigationReceiptReplayAdapter(
      store as never,
      { nowMs: () => 1_000 },
      new NodeSha256InvestigationDigest(),
      currentFacts({ reusePolicyVectorHash: hash("changed-reuse") }),
    );

    await expect(adapter.replay(replayInput)).resolves.toEqual({
      verdict: InvestigationReceiptReplayVerdict.Mismatched,
      targetReceipt: null,
    });
  });
});

const proof = {
  replayProofId: "proof-1",
  sourceAttestationId: "attestation-1",
  sourceAttestationHash: hash("attestation"),
  sourceOperationReceiptIdsHash: hash(
    canonicalJson({ operationReceiptIds: [hash("operation-receipt")] }),
  ),
  targetExecutionId: "execution-target",
  targetWorkSlotId: "slot-target",
  targetReviewRevisionHash: hash("target-revision"),
  targetCheckoutTreeOid: "1".repeat(40),
  replayBinaryHash: hash("binary"),
  replayPolicyVersion: "replay-v1",
  reusePolicyVectorHash: hash("reuse"),
  createdAtMs: 500,
  expiresAtMs: 1_500,
};

const replayInput = {
  sourceInvestigationId: "investigation-source",
  sourceCertificateHash: hash("certificate"),
  replayProofId: "proof-1",
  targetExecutionId: "execution-target",
  targetWorkSlotId: "slot-target",
  targetProviderVoteLaneId: hash("provider-lane"),
  producerReleaseId: "release-1",
  obligation: {
    obligationId: hash("obligation"),
    coverageContractVersion: "coverage-v1",
    stableReviewUnitKey: "unit-1",
    kind: InvestigationObligationKind.ChangedContent,
    canonicalSubject: "src/service.ts@head",
    canonicalRequirement: "read complete content",
    riskPriority: 10,
    origin: InvestigationObligationOrigin.CoverageContract,
    state: InvestigationObligationState.Satisfied,
    receipt: null,
    unresolvableReason: null,
  },
  sourceReceipt: {
    receiptId: hash("receipt"),
    operationKey: hash("operation"),
    kind: InvestigationReceiptKind.Blob,
    canonicalSubject: "src/service.ts@head",
    reviewRevisionHash: hash("source-revision"),
    gatewayPolicyVersion: "gateway-v4",
    evidenceDigest: hash("evidence"),
    operationReceiptIds: [hash("operation-receipt")],
    acceptedAttestationId: "attestation-1",
    acceptedAttestationHash: hash("attestation"),
    replayProofId: null,
    complete: true,
    truncated: false,
    failed: false,
  },
  targetRevision: {
    baseSha: "1".repeat(40),
    mergeBaseSha: "2".repeat(40),
    headSha: "3".repeat(40),
    reviewRevisionHash: hash("target-revision"),
  },
  gatewayPolicyVersion: "gateway-v4",
} as const;

function currentFacts(
  overrides: Partial<{
    targetCheckoutTreeOid: string;
    replayBinaryHash: string;
    replayPolicyVersion: string;
    reusePolicyVectorHash: string;
  }> = {},
) {
  return {
    resolve: vi.fn().mockResolvedValue({
      targetCheckoutTreeOid: proof.targetCheckoutTreeOid,
      replayBinaryHash: proof.replayBinaryHash,
      replayPolicyVersion: proof.replayPolicyVersion,
      reusePolicyVectorHash: proof.reusePolicyVectorHash,
      ...overrides,
    }),
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
