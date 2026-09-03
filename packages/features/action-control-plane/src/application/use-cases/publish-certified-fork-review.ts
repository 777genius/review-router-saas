import type { CertifiedForkReviewBinding } from "../ports/certified-fork-review-port.js";
import {
  certifiedForkReviewModelOutputHash,
  parseCertifiedForkReviewModelOutput,
  parseCertifiedForkReviewPromptPacket,
  readExactRecord,
  type CertifiedForkReviewModelOutput,
  type CertifiedForkReviewPromptPacket,
} from "./certified-fork-review-packet.js";
import {
  assertCertifiedForkReviewBindingMatches,
  parseCertifiedForkReviewBinding,
} from "./certified-fork-review-binding.js";

export type CertifiedForkReviewPublishResult =
  | Readonly<{
      status: "stale";
      code: "certified_fork_review_stale";
      binding: CertifiedForkReviewBinding;
      contextHash: string;
    }>
  | Readonly<{
      status: "ready";
      binding: CertifiedForkReviewBinding;
      contextHash: string;
      modelOutput: CertifiedForkReviewModelOutput;
      outputHash: string;
    }>;

function staleResult(
  packet: CertifiedForkReviewPromptPacket,
): CertifiedForkReviewPublishResult {
  return Object.freeze({
    status: "stale" as const,
    code: "certified_fork_review_stale" as const,
    binding: packet.binding,
    contextHash: packet.contextHash,
  });
}

export function publishCertifiedForkReview(
  input: unknown,
): CertifiedForkReviewPublishResult {
  const values = readExactRecord(
    input,
    ["prepared", "binding", "modelOutput"],
    "certified_fork_review_publish_input_invalid",
  );
  const packet = parseCertifiedForkReviewPromptPacket(values.prepared);
  const binding = parseCertifiedForkReviewBinding(values.binding);
  try {
    assertCertifiedForkReviewBindingMatches(packet.binding, binding);
  } catch (error) {
    if (error instanceof Error) return staleResult(packet);
    throw error;
  }
  const filePaths = packet.files.map((file) => file.path);
  const modelOutput = parseCertifiedForkReviewModelOutput(
    values.modelOutput,
    filePaths,
  );
  const outputHash = certifiedForkReviewModelOutputHash(modelOutput, filePaths);
  return Object.freeze({
    status: "ready" as const,
    binding,
    contextHash: packet.contextHash,
    modelOutput,
    outputHash,
  });
}
