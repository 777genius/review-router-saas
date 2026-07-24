import type { TargetReplayProof } from "../../domain/target-replay-proof";
import type {
  ContextAttestationClockPort,
  ContextAttestationStorePort,
} from "../ports/context-attestation-ports";

export enum TargetReplayProofVerificationStatus {
  Accepted = "accepted",
  Denied = "denied",
}

export type TargetReplayProofVerificationResult = Readonly<{
  status: TargetReplayProofVerificationStatus;
  proof: TargetReplayProof | null;
}>;

export class VerifyTargetReplayProof {
  constructor(
    private readonly dependencies: Readonly<{
      store: ContextAttestationStorePort;
      clock: ContextAttestationClockPort;
    }>,
  ) {}

  async execute(command: {
    readonly replayProofId: string;
    readonly sourceAttestationId: string;
    readonly sourceAttestationHash: string;
    readonly targetExecutionId: string;
    readonly targetWorkSlotId: string;
    readonly targetReviewRevisionHash: string;
    readonly targetCheckoutTreeOid: string;
    readonly replayBinaryHash: string;
    readonly replayPolicyVersion: string;
    readonly reusePolicyVectorHash: string;
  }): Promise<TargetReplayProofVerificationResult> {
    const proof = await this.dependencies.store.findReplayProof(
      command.replayProofId,
    );
    const source = proof
      ? await this.dependencies.store.findAcceptedAttestation(
          proof.sourceAttestationId,
        )
      : null;
    const nowMs = this.dependencies.clock.nowMs();
    if (
      !proof ||
      !source ||
      proof.sourceAttestationId !== command.sourceAttestationId ||
      proof.sourceAttestationHash !== command.sourceAttestationHash ||
      source.attestationId !== proof.sourceAttestationId ||
      source.attestationHash !== proof.sourceAttestationHash ||
      source.reuseExpiresAtMs <= nowMs ||
      proof.targetExecutionId !== command.targetExecutionId ||
      proof.targetWorkSlotId !== command.targetWorkSlotId ||
      proof.targetReviewRevisionHash !== command.targetReviewRevisionHash ||
      proof.targetCheckoutTreeOid !== command.targetCheckoutTreeOid ||
      proof.replayBinaryHash !== command.replayBinaryHash ||
      proof.replayPolicyVersion !== command.replayPolicyVersion ||
      proof.reusePolicyVectorHash !== command.reusePolicyVectorHash ||
      proof.expiresAtMs <= nowMs
    ) {
      return Object.freeze({
        status: TargetReplayProofVerificationStatus.Denied,
        proof: null,
      });
    }
    return Object.freeze({
      status: TargetReplayProofVerificationStatus.Accepted,
      proof,
    });
  }
}
