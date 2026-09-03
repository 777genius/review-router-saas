import type { CertifiedForkReviewPromptPacket } from "./certified-fork-review-packet.js";
import {
  certifiedForkReviewPacketMaxBytes,
  certifiedForkReviewPromptContextHash,
  parseCertifiedForkReviewFiles,
  readExactRecord,
  serializeParsedCertifiedForkReviewPromptPacket,
} from "./certified-fork-review-packet.js";
import { parseCertifiedForkReviewBinding } from "./certified-fork-review-binding.js";

export function prepareCertifiedForkReview(
  input: unknown,
): CertifiedForkReviewPromptPacket {
  const values = readExactRecord(
    input,
    ["binding", "files"],
    "certified_fork_review_prepare_input_invalid",
  );
  const binding = parseCertifiedForkReviewBinding(values.binding);
  const files = parseCertifiedForkReviewFiles(values.files);
  const contextHash = certifiedForkReviewPromptContextHash({ binding, files });
  const packet = Object.freeze({
    protocolVersion: 1 as const,
    binding,
    contextHash,
    files,
  });
  if (
    Buffer.byteLength(
      serializeParsedCertifiedForkReviewPromptPacket(packet),
      "utf8",
    ) > certifiedForkReviewPacketMaxBytes
  ) {
    throw new Error("certified_fork_review_packet_too_large");
  }
  return packet;
}
