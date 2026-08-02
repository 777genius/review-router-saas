import type { ContextDependencyReplayDecision } from "./context-replay-decision";
import { ContextDependencyReplayStatus } from "./context-replay-decision";

export const targetReplayProofMaxLifetimeMs = 15 * 60 * 1_000;

export type TargetReplayProof = Readonly<{
  replayProofId: string;
  sourceAttestationId: string;
  sourceAttestationHash: string;
  sourceOperationReceiptIdsHash: string | null;
  targetExecutionId: string;
  targetWorkSlotId: string;
  targetReviewRevisionHash: string;
  targetCheckoutTreeOid: string;
  replayBinaryHash: string;
  replayPolicyVersion: string;
  reusePolicyVectorHash: string;
  createdAtMs: number;
  expiresAtMs: number;
}>;

export function createTargetReplayProof(
  candidate: TargetReplayProof,
  replayDecision: ContextDependencyReplayDecision,
): TargetReplayProof {
  if (replayDecision.status !== ContextDependencyReplayStatus.Matched) {
    throw new Error("target_replay_not_matched");
  }
  assertIdentifier(candidate.replayProofId, "target_replay_proof_id");
  assertIdentifier(candidate.sourceAttestationId, "source_attestation_id");
  assertSha256(candidate.sourceAttestationHash, "source_attestation_hash");
  if (candidate.sourceOperationReceiptIdsHash !== null) {
    assertSha256(
      candidate.sourceOperationReceiptIdsHash,
      "source_operation_receipt_ids_hash",
    );
  }
  assertIdentifier(candidate.targetExecutionId, "target_execution_id");
  assertIdentifier(candidate.targetWorkSlotId, "target_work_slot_id");
  assertSha256(
    candidate.targetReviewRevisionHash,
    "target_review_revision_hash",
  );
  assertGitOid(candidate.targetCheckoutTreeOid, "target_checkout_tree_oid");
  assertSha256(candidate.replayBinaryHash, "replay_binary_hash");
  assertIdentifier(candidate.replayPolicyVersion, "replay_policy_version");
  assertSha256(candidate.reusePolicyVectorHash, "reuse_policy_vector_hash");
  assertEpoch(candidate.createdAtMs, "created_at_ms");
  assertEpoch(candidate.expiresAtMs, "expires_at_ms");
  if (
    candidate.expiresAtMs <= candidate.createdAtMs ||
    candidate.expiresAtMs - candidate.createdAtMs >
      targetReplayProofMaxLifetimeMs
  ) {
    throw new Error("target_replay_proof_lifetime_invalid");
  }
  return Object.freeze({ ...candidate });
}

function assertEpoch(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field}_invalid`);
  }
}

function assertGitOid(value: string, field: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error(`${field}_invalid`);
  }
}

function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field}_invalid`);
}

function assertIdentifier(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) {
    throw new Error(`${field}_invalid`);
  }
}
