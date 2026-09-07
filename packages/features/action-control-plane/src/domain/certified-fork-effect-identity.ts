import {
  artifact,
  authentic,
  choice,
  counter,
  fingerprint,
  hash,
  list,
  next,
  opaqueId,
  positive,
  record,
  requireFact,
  sha,
} from "./certified-fork-effect-canonical.js";
// Structural read contract keeps identity independent of the later outcome layer.
// Runtime outcome provenance is still mandatory for generation admission.
type ForkPredecessor = Readonly<{
  review: ForkReview;
  outcomeHash: string;
  status:
    | "completed"
    | "stopped_no_effect"
    | "stopped_with_effect"
    | "output_unavailable"
    | "unresolved";
}>;
const logicalFacts = record({
  workspaceId: opaqueId,
  repositoryId: opaqueId,
  sourceRepositoryId: opaqueId,
  baseRepositoryId: opaqueId,
  pullRequest: positive,
  headSha: sha,
  baseSha: sha,
  trustDomain: choice("fork"),
  generation: counter,
});
export type ForkLogicalFacts = ReturnType<typeof logicalFacts>;
export type ForkReview = Readonly<{
  facts: ForkLogicalFacts;
  logicalKey: string;
  familyKey: string;
  bindingHash: string;
  admissionHash: string | null;
}>;
const admissionFacts = record({ admissionHash: hash });
/** Generation > 0 requires an explicit admission and a resolved, sealed predecessor.
 * Identical inputs are idempotent. Composition must CAS the admitted generation;
 * pure construction cannot arbitrate concurrent callers or authenticate admission. */
export function createForkReview(
  facts: ForkLogicalFacts,
  bindingHash: string,
  predecessor: ForkPredecessor | null = null,
  admission: { admissionHash: string } | null = null,
): ForkReview {
  const parsed = logicalFacts(facts);
  const binding = hash(bindingHash);
  const { generation, ...family } = parsed;
  const familyKey = fingerprint("fork-review-family", family);
  const admitted = admission === null ? null : admissionFacts(admission);
  if (generation === "0")
    requireFact(predecessor === null && admitted === null);
  else {
    requireFact(predecessor !== null && admitted !== null);
    authentic("outcome", predecessor);
    requireFact(
      predecessor.review.familyKey === familyKey &&
        predecessor.review.bindingHash === binding,
    );
    requireFact(generation === next(predecessor.review.facts.generation));
    requireFact(predecessor.status !== "unresolved");
  }
  return artifact("review", {
    facts: parsed,
    logicalKey: fingerprint("fork-review", parsed),
    familyKey,
    bindingHash: binding,
    admissionHash:
      admitted &&
      fingerprint("fork-generation", [admitted, predecessor!.outcomeHash]),
  });
}
const slotFacts = record({
  stage: choice("provider", "publication"),
  role: choice("review", "advisory", "summary", "inline"),
  slot: positive,
});
export type ForkSlot = ReturnType<typeof slotFacts>;
export type ForkEffect = Readonly<{
  logicalKey: string;
  effectKey: string;
  slot: ForkSlot;
}>;
export function createForkEffect(
  review: ForkReview,
  input: ForkSlot,
): ForkEffect {
  authentic("review", review);
  const slot = slotFacts(input);
  requireFact(
    slot.stage === "provider"
      ? slot.role === "review" && slot.slot === 1
      : slot.role !== "review",
  );
  const facts = { logicalKey: review.logicalKey, slot };
  return artifact("effect", {
    ...facts,
    effectKey: fingerprint("fork-effect", facts),
  });
}
const common = {
  contextHash: hash,
  adapterContractHash: hash,
  schemaHash: hash,
};
const providerFacts = record({
  ...common,
  providerInstanceId: opaqueId,
  accountScopeHash: hash,
  modelHash: hash,
  settingsHash: hash,
  trustedInstructionsHash: hash,
  effectiveInputHash: hash,
  toolsOutputSchemaHash: hash,
  executionPolicyHash: hash,
});
const publicationFacts = record({
  ...common,
  outputCommitmentHash: hash,
  frozenPlanHash: hash,
  appId: opaqueId,
  installationId: opaqueId,
  baseRepositoryId: opaqueId,
  pullRequest: positive,
  commitSha: sha,
  objectTargetHash: hash,
  renderPolicyHash: hash,
  payloadHashes: list(hash),
  markerHash: hash,
});
export type ForkProviderFacts = ReturnType<typeof providerFacts>;
export type ForkPublicationFacts = ReturnType<typeof publicationFacts>;
export type ForkRequest = Readonly<{
  effect: ForkEffect;
  review: ForkReview;
  bindingHash: string;
  contextHash: string;
  facts: ForkProviderFacts | ForkPublicationFacts;
  requestHash: string;
  remoteScopeHash: string;
}>;
export function createForkRequest(
  review: ForkReview,
  effect: ForkEffect,
  facts: ForkProviderFacts | ForkPublicationFacts,
): ForkRequest {
  authentic("review", review);
  authentic("effect", effect);
  requireFact(effect.logicalKey === review.logicalKey);
  const parsed =
    effect.slot.stage === "provider"
      ? providerFacts(facts)
      : publicationFacts(facts);
  if ("baseRepositoryId" in parsed) {
    requireFact(
      parsed.baseRepositoryId === review.facts.baseRepositoryId &&
        parsed.pullRequest === review.facts.pullRequest &&
        parsed.commitSha === review.facts.headSha,
    );
    requireFact(parsed.payloadHashes.length > 0);
  }
  const scope =
    "accountScopeHash" in parsed
      ? {
          providerInstanceId: parsed.providerInstanceId,
          accountScopeHash: parsed.accountScopeHash,
        }
      : {
          appId: parsed.appId,
          installationId: parsed.installationId,
          baseRepositoryId: parsed.baseRepositoryId,
          pullRequest: parsed.pullRequest,
          commitSha: parsed.commitSha,
          objectTargetHash: parsed.objectTargetHash,
        };
  const value = {
    effect,
    review,
    bindingHash: review.bindingHash,
    contextHash: parsed.contextHash,
    facts: parsed,
    remoteScopeHash: fingerprint("fork-remote-scope", scope),
  };
  return artifact("request", {
    ...value,
    requestHash: fingerprint(
      effect.slot.stage === "provider"
        ? "fork-provider-request"
        : "fork-publication-request",
      value,
    ),
  });
}
/** Compare against the authoritative admitted identity; ingress identifiers never enter it. */
export function assertSameForkReview(
  current: ForkReview,
  proposed: ForkReview,
): ForkReview {
  authentic("review", current);
  authentic("review", proposed);
  requireFact(
    fingerprint("fork-admission", current) ===
      fingerprint("fork-admission", proposed),
  );
  return current;
}
export function assertSameForkRequest(
  current: ForkRequest,
  proposed: ForkRequest,
): ForkRequest {
  authentic("request", current);
  authentic("request", proposed);
  requireFact(
    current.effect.effectKey === proposed.effect.effectKey &&
      current.requestHash === proposed.requestHash,
  );
  return current;
}
