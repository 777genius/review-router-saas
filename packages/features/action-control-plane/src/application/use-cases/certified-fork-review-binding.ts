import { createHash } from "node:crypto";
import type {
  CertifiedForkReviewBinding,
  CertifiedForkReviewClaimScope,
} from "../ports/certified-fork-review-port.js";

export const certifiedForkReviewWorkflowSchemaVersion = 5;
export const certifiedForkReviewMaxPromptPacketBytes = 300_000;
export const certifiedForkReviewMaxExecutionIdChars = 8_192;
export const certifiedForkReviewPromptPolicyVersion = 1;

export function assertCertifiedForkReviewPromptPacketSize(
  packet: unknown,
): void {
  if (
    Buffer.byteLength(JSON.stringify(packet), "utf8") >
    certifiedForkReviewMaxPromptPacketBytes
  )
    throw new Error("certified_fork_prompt_packet_too_large");
}

export function certifiedForkReviewBindingHash(
  binding: CertifiedForkReviewBinding,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceRepository: binding.sourceRepository,
        sourceRepositoryId: binding.sourceRepositoryId,
        baseRepository: binding.baseRepository,
        baseRepositoryId: binding.baseRepositoryId,
        pullRequestNumber: binding.pullRequestNumber,
        reviewHeadSha: binding.reviewHeadSha,
        baseSha: binding.baseSha,
        trustDomain: binding.trustDomain,
      }),
    )
    .digest("hex");
}

export function certifiedForkReviewLeaseBindingKey(hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash))
    throw new Error("certified_fork_lease_binding_invalid");
  return `fork:${hash}`;
}

export function certifiedForkReviewClaimScope(
  binding: CertifiedForkReviewBinding,
  contextHash: string,
): CertifiedForkReviewClaimScope {
  if (!/^[a-f0-9]{64}$/.test(contextHash))
    throw new Error("certified_fork_context_mismatch");
  return {
    baseRepositoryId: binding.baseRepositoryId,
    pullRequestNumber: binding.pullRequestNumber,
    reviewHeadSha: binding.reviewHeadSha.toLowerCase(),
    baseSha: binding.baseSha.toLowerCase(),
    contextHash,
    promptPolicyVersion: certifiedForkReviewPromptPolicyVersion,
  };
}

export function certifiedForkReviewReservationOwner(input: {
  repositoryId: string;
  runId: string;
  runAttempt: string;
  workflowSha: string;
}): string {
  return createHash("sha256")
    .update(
      `certified-fork-reservation:${input.repositoryId}:${input.runId}:${input.runAttempt}:${input.workflowSha}`,
    )
    .digest("hex");
}
