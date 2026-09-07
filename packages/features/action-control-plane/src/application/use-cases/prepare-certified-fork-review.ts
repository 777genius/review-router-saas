import type { CertifiedForkReviewGatewayPort } from "../ports/certified-fork-review-port.js";
import type { CertifiedForkReviewPromptPacket } from "./certified-fork-review-packet.js";
import {
  certifiedForkReviewPromptContextHash,
  parseCertifiedForkReviewFiles,
  parseCertifiedForkReviewPromptPacket,
  readExactRecord,
} from "./certified-fork-review-packet.js";
import {
  assertCertifiedForkReviewBindingMatches,
  parseCertifiedForkReviewBinding,
} from "./certified-fork-review-binding.js";

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
  const packet = {
    protocolVersion: 1 as const,
    binding,
    contextHash,
    files,
  };
  return parseCertifiedForkReviewPromptPacket(packet);
}

export async function prepareCurrentCertifiedForkReview(
  input: unknown,
  { gateway }: { gateway: CertifiedForkReviewGatewayPort },
): Promise<CertifiedForkReviewPromptPacket> {
  const values = readExactRecord(
    input,
    ["githubInstallationId", "binding"],
    "certified_fork_review_prepare_input_invalid",
  );
  const githubInstallationId = values.githubInstallationId;
  if (
    typeof githubInstallationId !== "string" ||
    !/^[1-9][0-9]*$/u.test(githubInstallationId)
  ) {
    throw new Error("certified_fork_review_installation_invalid");
  }
  const binding = parseCertifiedForkReviewBinding(values.binding);
  const context = readExactRecord(
    await gateway.prepareContext(
      Object.freeze({ githubInstallationId, binding }),
    ),
    ["contextHash", "promptPacket"],
    "certified_fork_review_context_invalid",
  );
  const packet = parseCertifiedForkReviewPromptPacket(context.promptPacket);
  assertCertifiedForkReviewBindingMatches(binding, packet.binding);
  if (context.contextHash !== packet.contextHash) {
    throw new Error("certified_fork_review_context_hash_mismatch");
  }
  return packet;
}
