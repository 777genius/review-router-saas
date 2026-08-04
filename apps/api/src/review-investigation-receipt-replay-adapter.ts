import {
  InvestigationReceiptReplayVerdict,
  type InvestigationDigestPort,
  type InvestigationReceiptReplayPort,
} from "@reviewrouter/features-review-investigations";
import type {
  ContextAttestationClockPort,
  ContextAttestationStorePort,
} from "@reviewrouter/features-review-context-attestation";
import {
  TargetReplayProofVerificationStatus,
  VerifyTargetReplayProof,
  type AcceptedDependencyAttestation,
  type GatewaySession,
} from "@reviewrouter/features-review-context-attestation";
import { canonicalJson } from "@reviewrouter/features-review-run-control";

export class ContextAttestationInvestigationReceiptReplayAdapter implements InvestigationReceiptReplayPort {
  private readonly verifier: VerifyTargetReplayProof;

  constructor(
    private readonly store: ContextAttestationStorePort,
    private readonly clock: ContextAttestationClockPort,
    private readonly digest: InvestigationDigestPort,
    private readonly currentFacts: InvestigationReplayProofCurrentFactsPort,
  ) {
    this.verifier = new VerifyTargetReplayProof({ store, clock });
  }

  async replay(input: Parameters<InvestigationReceiptReplayPort["replay"]>[0]) {
    const proof = await this.store.findReplayProof(input.replayProofId);
    const source = proof
      ? await this.store.findAcceptedAttestation(proof.sourceAttestationId)
      : null;
    const session = source
      ? await this.store.findSession(source.sessionId)
      : null;
    const now = this.clock.nowMs();
    const sourceOperationReceiptIdsHash = await this.digest.digestUtf8(
      canonicalJson({
        operationReceiptIds: [
          ...input.sourceReceipt.operationReceiptIds,
        ].sort(),
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
    const facts = await this.currentFacts.resolve({
      targetExecutionId: input.targetExecutionId,
      targetWorkSlotId: input.targetWorkSlotId,
      targetProviderVoteLaneId: input.targetProviderVoteLaneId,
      targetRevision: input.targetRevision,
      producerReleaseId: input.producerReleaseId,
      gatewayPolicyVersion: input.gatewayPolicyVersion,
      sourceAttestation: source,
      sourceSession: session,
    });
    if (!facts) return mismatched();
    const verification = await this.verifier.execute({
      replayProofId: input.replayProofId,
      sourceAttestationId: source.attestationId,
      sourceAttestationHash: source.attestationHash,
      targetExecutionId: input.targetExecutionId,
      targetWorkSlotId: input.targetWorkSlotId,
      targetReviewRevisionHash: input.targetRevision.reviewRevisionHash,
      targetCheckoutTreeOid: facts.targetCheckoutTreeOid,
      replayBinaryHash: facts.replayBinaryHash,
      replayPolicyVersion: facts.replayPolicyVersion,
      reusePolicyVectorHash: facts.reusePolicyVectorHash,
    });
    if (verification.status !== TargetReplayProofVerificationStatus.Accepted) {
      return mismatched();
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

export interface InvestigationReplayProofCurrentFactsPort {
  resolve(input: {
    readonly targetExecutionId: string;
    readonly targetWorkSlotId: string;
    readonly targetProviderVoteLaneId: string;
    readonly targetRevision: Parameters<
      InvestigationReceiptReplayPort["replay"]
    >[0]["targetRevision"];
    readonly producerReleaseId: string;
    readonly gatewayPolicyVersion: string;
    readonly sourceAttestation: AcceptedDependencyAttestation;
    readonly sourceSession: GatewaySession | null;
  }): Promise<Readonly<{
    targetCheckoutTreeOid: string;
    replayBinaryHash: string;
    replayPolicyVersion: string;
    reusePolicyVectorHash: string;
  }> | null>;
}

function mismatched() {
  return Object.freeze({
    verdict: InvestigationReceiptReplayVerdict.Mismatched,
    targetReceipt: null,
  } as const);
}
