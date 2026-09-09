import {
  certifiedForkReviewModelOutputHash,
  parseCertifiedForkReviewModelOutput,
  serializeCertifiedForkReviewModelOutput,
} from "../../application/use-cases/certified-fork-review-packet.js";
import {
  authentic,
  fingerprint,
  requireFact,
} from "../../domain/certified-fork-effect-canonical.js";
import {
  assertSameForkRequest,
  assertSameForkReview,
  type ForkRequest,
  type ForkReview,
} from "../../domain/certified-fork-effect-identity.js";
import { createForkOutput } from "../../domain/certified-fork-effect-outcome.js";
import {
  isForkSuccess,
  type ForkEffectState,
  type ForkEvidence,
} from "../../domain/certified-fork-effect-state.js";
import {
  canonicalRetainedBytes,
  parseFactScope,
  parseRetainedFact,
  retainedReference,
  type RetainedFactScope,
} from "../prisma/certified-fork-proof-fact-types.js";

/** INTERNAL cold-loader input, supplied independently of the untrusted output DTO.
 * The protected caller authenticates admission, request preimages, provider receipt
 * and its proof reference, and replays providerState with the domain constructors.
 * filePaths is the exact ordered packet.files.map(file => file.path) from that
 * authenticated request's parsed packet; a DTO's own filePaths is never authority.
 */
export type RetainedForkOutputContext = Readonly<{
  proofId: string;
  scope: RetainedFactScope;
  review: ForkReview;
  request: ForkRequest;
  providerState: ForkEffectState;
  successEvidence: ForkEvidence;
  successEvidenceProof: string;
  filePaths: readonly string[];
}>;

/** Validate one bounded storage fact and reconstruct ONLY a semantic commitment.
 * Pass Reader.read(...).fact, not the reader envelope. The reader separately checks
 * storage bytes/digests. Neither that check nor this result authenticates custody,
 * producer IDs, commitIdentity, timestamps, sourceArtifact or current authority.
 * No durability capability is returned and no runtime composition is installed.
 *
 * Remaining protected producer dependency: a versioned output producer must bind
 * retained UTF-8 bytes to the authenticated provider response/request/packet and
 * success proof in the exact tenant/repository/generation; the committed reader and
 * command producer must establish read-before-command commit ordering. There is no
 * accepted universal producer schema or timestamp-based substitute in this helper.
 */
export function validateRetainedForkOutput(
  input: unknown,
  trusted: RetainedForkOutputContext,
) {
  const fact = parseRetainedFact(input);
  requireFact(fact.kind === "output");
  const scope = parseFactScope(trusted.scope);
  requireFact(
    fact.proofId === retainedReference(trusted.proofId) &&
      canonicalRetainedBytes(fact.scope) === canonicalRetainedBytes(scope),
  );
  const review = authentic("review", trusted.review);
  const request = authentic("request", trusted.request);
  const state = authentic("state", trusted.providerState);
  const success = authentic("evidence", trusted.successEvidence);
  authentic("effect", request.effect);
  assertSameForkReview(review, request.review);
  assertSameForkRequest(request, state.request);
  requireFact(
    scope.workspaceId === review.facts.workspaceId &&
      scope.repositoryConnectionId === review.facts.repositoryId &&
      scope.familyKey === review.familyKey &&
      scope.reviewHash === fingerprint("fork-admission", review) &&
      request.effect.slot.stage === "provider" &&
      isForkSuccess(request, success),
  );
  const last = state.attempts.at(-1);
  const successHash = fingerprint("fork-evidence", success);
  requireFact(
    last &&
      last.status === "succeeded" &&
      !state.integrityHold &&
      success.logicalKey === review.logicalKey &&
      success.effectKey === request.effect.effectKey &&
      success.requestHash === request.requestHash &&
      success.remoteScopeHash === request.remoteScopeHash &&
      success.attempt === last.ordinal &&
      success.originEpoch === last.originEpoch &&
      last.evidence.some(
        (evidence) =>
          fingerprint("fork-evidence", authentic("evidence", evidence)) ===
          successHash,
      ),
  );
  const payload = fact.payload;
  requireFact(
    payload.successEvidenceProof ===
      retainedReference(trusted.successEvidenceProof) &&
      payload.bindingHash === review.bindingHash &&
      payload.bindingHash === request.bindingHash &&
      payload.contextHash === request.contextHash &&
      payload.requestHash === request.requestHash &&
      payload.effectKey === request.effect.effectKey &&
      canonicalRetainedBytes(payload.filePaths) ===
        canonicalRetainedBytes(trusted.filePaths),
  );
  const modelOutput = parseCertifiedForkReviewModelOutput(
    payload.modelOutput,
    trusted.filePaths,
  );
  const outputBytes = serializeCertifiedForkReviewModelOutput(
    modelOutput,
    trusted.filePaths,
  );
  const canonicalOutputHash = certifiedForkReviewModelOutputHash(
    modelOutput,
    trusted.filePaths,
  );
  requireFact(
    payload.outputBytes === outputBytes &&
      success.resultHash === canonicalOutputHash,
  );
  const output = createForkOutput(state, {
    bindingHash: payload.bindingHash,
    contextHash: payload.contextHash,
    canonicalOutputHash,
  });
  requireFact(
    output.canonicalOutputHash === canonicalOutputHash &&
      output.successEvidenceHash === successHash &&
      output.outputHash === payload.outputCommitmentHash,
  );
  return Object.freeze({ modelOutput, outputBytes, output });
}
