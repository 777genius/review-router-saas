import {
  InvestigationReceiptReplayVerdict,
  type InvestigationDigestPort,
  type InvestigationReceiptReplayPort,
} from "@reviewrouter/features-review-investigations";
import type {
  ContextAttestationClockPort,
  ContextAttestationStorePort,
} from "@reviewrouter/features-review-context-attestation";
import { canonicalJson } from "@reviewrouter/features-review-run-control";

export class ContextAttestationInvestigationReceiptReplayAdapter implements InvestigationReceiptReplayPort {
  constructor(
    private readonly store: ContextAttestationStorePort,
    private readonly clock: ContextAttestationClockPort,
    private readonly digest: InvestigationDigestPort,
  ) {}

  async replay(input: Parameters<InvestigationReceiptReplayPort["replay"]>[0]) {
    const proof = await this.store.findReplayProof(input.replayProofId);
    const source = proof
      ? await this.store.findAcceptedAttestation(proof.sourceAttestationId)
      : null;
    const now = this.clock.nowMs();
    const sourceOperationReceiptIdsHash = await this.digest.digestUtf8(
      canonicalJson({
        operationReceiptIds: [...input.sourceReceipt.operationReceiptIds].sort(),
      }),
    );
    if (
      proof === null ||
      source === null ||
      input.sourceReceipt.acceptedAttestationId === null ||
      input.sourceReceipt.acceptedAttestationHash === null ||
      proof.sourceAttestationId !== input.sourceReceipt.acceptedAttestationId ||
      proof.sourceAttestationHash !==
        input.sourceReceipt.acceptedAttestationHash ||
      proof.sourceOperationReceiptIdsHash !== sourceOperationReceiptIdsHash ||
      source.attestationHash !== proof.sourceAttestationHash ||
      source.reuseExpiresAtMs <= now ||
      proof.expiresAtMs <= now ||
      proof.targetExecutionId !== input.targetExecutionId ||
      proof.targetWorkSlotId !== input.targetWorkSlotId ||
      proof.targetReviewRevisionHash !== input.targetRevision.reviewRevisionHash
    ) {
      return Object.freeze({
        verdict: InvestigationReceiptReplayVerdict.Mismatched,
        targetReceipt: null,
      });
    }
    const receiptId = await this.digest.digestUtf8(
      canonicalJson({
        obligationId: input.obligation.obligationId,
        replayProofId: proof.replayProofId,
        sourceReceiptId: input.sourceReceipt.receiptId,
        targetReviewRevisionHash: input.targetRevision.reviewRevisionHash,
      }),
    );
    return Object.freeze({
      verdict: InvestigationReceiptReplayVerdict.Matched,
      targetReceipt: Object.freeze({
        ...input.sourceReceipt,
        receiptId,
        operationKey: await this.digest.digestUtf8(
          canonicalJson({
            replayProofId: proof.replayProofId,
            sourceOperationKey: input.sourceReceipt.operationKey,
          }),
        ),
        reviewRevisionHash: input.targetRevision.reviewRevisionHash,
        evidenceDigest: await this.digest.digestUtf8(
          canonicalJson({
            replayProofId: proof.replayProofId,
            sourceEvidenceDigest: input.sourceReceipt.evidenceDigest,
          }),
        ),
        replayProofId: proof.replayProofId,
      }),
    });
  }
}
