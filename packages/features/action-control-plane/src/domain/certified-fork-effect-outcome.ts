import {
  artifact,
  authentic,
  choice,
  fingerprint,
  hash,
  list,
  nullable,
  record,
  requireFact,
  set,
} from "./certified-fork-effect-canonical.js";
import {
  assertSameForkReview,
  createForkReview,
  type ForkLogicalFacts,
  type ForkRequest,
  type ForkReview,
} from "./certified-fork-effect-identity.js";
import {
  assertForkStateExtension,
  isForkSuccess,
  type ForkEffectState,
} from "./certified-fork-effect-state.js";
export type ForkOutput = Readonly<{
  logicalKey: string;
  effectKey: string;
  requestHash: string;
  successEvidenceHash: string;
  bindingHash: string;
  contextHash: string;
  canonicalOutputHash: string;
  outputHash: string;
}>;
/** This constructs a commitment only. It does NOT commit or retain the output. */
export function createForkOutput(
  state: ForkEffectState,
  input: {
    bindingHash: string;
    contextHash: string;
    canonicalOutputHash: string;
  },
): ForkOutput {
  authentic("state", state);
  const parsed = record({
    bindingHash: hash,
    contextHash: hash,
    canonicalOutputHash: hash,
  })(input);
  const last = state.attempts.at(-1)!;
  requireFact(
    state.request.effect.slot.stage === "provider" &&
      last.status === "succeeded" &&
      !state.integrityHold,
  );
  requireFact(
    parsed.bindingHash === state.request.bindingHash &&
      parsed.contextHash === state.request.contextHash,
  );
  const success = last.evidence.find((e) => isForkSuccess(state.request, e));
  requireFact(success && success.resultHash === parsed.canonicalOutputHash);
  const facts = {
    logicalKey: state.request.effect.logicalKey,
    effectKey: state.request.effect.effectKey,
    requestHash: state.request.requestHash,
    successEvidenceHash: fingerprint("fork-evidence", success),
    ...parsed,
  };
  return artifact("output", {
    ...facts,
    outputHash: fingerprint("fork-output", facts),
  });
}
const durabilityFacts = record({
  disposition: choice("durably_committed"),
  outputCommitmentHash: hash,
  commitReceiptHash: hash,
});
export type ForkDurability = ReturnType<typeof durabilityFacts>;
/** INTERNAL: install only at trusted composition. The verifier authenticates the
 * storage receipt and retained output; hashes/DTOs alone are not persistence proof. */
export function createForkDurabilityVerifier<Proof>(
  verify: (proof: Proof) => ForkDurability,
) {
  return (proof: Proof): ForkDurability =>
    artifact("durability", durabilityFacts(verify(proof)));
}
export type ForkInventoryEntry = Readonly<{
  request: ForkRequest;
  dependencies: readonly string[];
}>;
export type ForkInventory = Readonly<{
  review: ForkReview;
  logicalKey: string;
  entries: readonly ForkInventoryEntry[];
  inventoryHash: string;
  output: ForkOutput | null;
  durability: ForkDurability | null;
}>;
/** Trusted composition supplies the COMPLETE planned keys and authenticated durable
 * receipt facts. Membership is frozen before any publication begin; no append API.
 * A pure function cannot discover omitted work or independently prove persistence. */
export function freezeForkInventory(
  review: ForkReview,
  input: readonly ForkInventoryEntry[],
  expectedEffectKeys: readonly string[],
  output: ForkOutput | null,
  durability: ForkDurability | null,
): ForkInventory {
  authentic("review", review);
  const entries = set(
    list(
      record({
        request: (v: unknown) => authentic("request", v as ForkRequest),
        dependencies: (v: unknown) => set(list(hash)(v), (key) => key),
      }),
    )(input),
    (e) => e.request.effect.effectKey,
  );
  const expected = set(list(hash)(expectedEffectKeys), (key) => key);
  requireFact(
    entries.length > 0 &&
      entries.length === expected.length &&
      entries.every(
        (e, i) =>
          e.request.effect.effectKey === expected[i] &&
          e.request.effect.logicalKey === review.logicalKey &&
          e.request.bindingHash === review.bindingHash,
      ),
  );
  entries.forEach((e) => assertSameForkReview(review, e.request.review));
  const provider = entries.filter(
    (e) => e.request.effect.slot.stage === "provider",
  );
  requireFact(provider.length === 1 && provider[0]!.dependencies.length === 0);
  const parsedOutput = output === null ? null : authentic("output", output);
  const parsedDurability = nullable((v: unknown) =>
    authentic("durability", v as ForkDurability),
  )(durability);
  requireFact((parsedOutput === null) === (parsedDurability === null));
  if (parsedOutput !== null) {
    requireFact(
      parsedOutput.logicalKey === review.logicalKey &&
        parsedOutput.requestHash === provider[0]!.request.requestHash &&
        parsedDurability?.outputCommitmentHash === parsedOutput.outputHash,
    );
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    requireFact(!visiting.has(key));
    if (visited.has(key)) return;
    const entry = entries.find((e) => e.request.effect.effectKey === key);
    requireFact(entry);
    visiting.add(key);
    entry.dependencies.forEach(visit);
    visiting.delete(key);
    visited.add(key);
  };
  entries.forEach((e) => {
    visit(e.request.effect.effectKey);
    if (e.request.effect.slot.stage === "publication") {
      requireFact(
        parsedOutput &&
          parsedDurability &&
          e.dependencies.includes(provider[0]!.request.effect.effectKey),
      );
      requireFact(
        "outputCommitmentHash" in e.request.facts &&
          e.request.facts.outputCommitmentHash === parsedOutput.outputHash &&
          e.request.contextHash === parsedOutput.contextHash,
      );
    }
  });
  const facts = {
    review,
    logicalKey: review.logicalKey,
    entries,
    output: parsedOutput,
    durability: parsedDurability,
  };
  return artifact("inventory", {
    ...facts,
    inventoryHash: fingerprint("fork-inventory", facts),
  });
}
export type ForkOutcome = Readonly<{
  review: ForkReview;
  inventory: ForkInventory;
  states: readonly ForkEffectState[];
  output: ForkOutput | null;
  outputAvailability: "available" | "unavailable";
  stops: readonly ("stale" | "cancelled")[];
  predecessorHash: string | null;
  status:
    | "completed"
    | "stopped_no_effect"
    | "stopped_with_effect"
    | "output_unavailable"
    | "unresolved";
  outcomeHash: string;
}>;
/** Stack2 authenticates the full outcome before projecting stack1's exact DTO.
 * This constructs identity, not admission authority. Trusted composition must
 * compare with its authoritative admitted review via assertSameForkReview and
 * CAS the predecessor/admission before issuing execution authority. */
export function createForkReviewFromOutcome(
  facts: ForkLogicalFacts,
  bindingHash: string,
  predecessor: ForkOutcome | null = null,
  admission: { admissionHash: string } | null = null,
): ForkReview {
  const prior = predecessor === null ? null : authentic("outcome", predecessor);
  return createForkReview(
    facts,
    bindingHash,
    prior === null
      ? null
      : {
          review: prior.review,
          outcomeHash: prior.outcomeHash,
          status: prior.status,
        },
    admission,
  );
}
/** All ledgers must be sealed first, even for an unresolved outcome. Reconciliation
 * retains the frozen inventory and every attempt/evidence, and cannot reopen sends. */
export function createForkOutcome(
  review: ForkReview,
  inventory: ForkInventory,
  input: readonly ForkEffectState[],
  outputAvailability: "available" | "unavailable",
  predecessor: ForkOutcome | null = null,
): ForkOutcome {
  authentic("review", review);
  authentic("inventory", inventory);
  assertSameForkReview(review, inventory.review);
  const availability = choice("available", "unavailable")(outputAvailability);
  const states = set(
    list((v: unknown) => authentic("state", v as ForkEffectState))(input),
    (s) => s.request.effect.effectKey,
  );
  requireFact(
    inventory.logicalKey === review.logicalKey &&
      states.length === inventory.entries.length,
  );
  requireFact(
    states.every(
      (s, i) =>
        s.request.requestHash === inventory.entries[i]!.request.requestHash &&
        s.sealed &&
        (s.inventoryHash === null ||
          s.inventoryHash === inventory.inventoryHash),
    ),
  );
  states.forEach((s) => assertSameForkReview(review, s.request.review));
  if (predecessor !== null) {
    authentic("outcome", predecessor);
    assertSameForkReview(review, predecessor.review);
    requireFact(
      predecessor.review.logicalKey === review.logicalKey &&
        predecessor.inventory.inventoryHash === inventory.inventoryHash,
    );
    states.forEach((s, i) => {
      const old = predecessor.states[i]!;
      assertForkStateExtension(old, s);
      requireFact(old.attempts.length === s.attempts.length);
      if (fingerprint("fork-state", old) !== fingerprint("fork-state", s))
        requireFact(s.authority.mode === "reconcile");
    });
  }
  const stops = set([...new Set(states.flatMap((s) => s.stops))], (s) => s);
  const unresolved = states.some(
    (s) =>
      s.integrityHold ||
      s.attempts.some(
        (a) =>
          a.status === "unknown" ||
          a.status === "in_flight" ||
          a.status === "prepared",
      ),
  );
  const successes = states.filter((s) =>
    s.attempts.some((a) => a.status === "succeeded"),
  );
  const remoteRefs = states.flatMap((s) =>
    s.attempts.flatMap((a) =>
      a.evidence
        .filter((e) => isForkSuccess(s.request, e))
        .map(
          (e) =>
            `${
              "accountScopeHash" in s.request.facts
                ? s.request.facts.providerInstanceId +
                  s.request.facts.accountScopeHash
                : [
                    s.request.facts.appId,
                    s.request.facts.installationId,
                    s.request.facts.baseRepositoryId,
                  ].join(":")
            }:${e.externalRefHash}`,
        ),
    ),
  );
  // Multiple success evidence in one attempt is already an integrity hold; shared
  // remote objects across distinct effects also require human/adapter reconciliation.
  const duplicate = new Set(remoteRefs).size !== remoteRefs.length;
  const providerSucceeded = successes.some(
    (s) => s.request.effect.slot.stage === "provider",
  );
  if (inventory.output !== null) {
    const state = states.find(
      (s) => s.request.requestHash === inventory.output!.requestHash,
    );
    requireFact(
      state &&
        state.attempts.some((a) =>
          a.evidence.some(
            (e) =>
              fingerprint("fork-evidence", e) ===
              inventory.output!.successEvidenceHash,
          ),
        ),
    );
  }
  requireFact(availability !== "available" || inventory.output !== null);
  const status: ForkOutcome["status"] =
    unresolved || duplicate
      ? "unresolved"
      : providerSucceeded &&
          (availability === "unavailable" || inventory.output === null)
        ? "output_unavailable"
        : stops.length > 0
          ? successes.length > 0
            ? "stopped_with_effect"
            : "stopped_no_effect"
          : successes.length === states.length && inventory.output !== null
            ? "completed"
            : "unresolved";
  const facts = {
    review,
    inventory,
    states,
    output: availability === "available" ? inventory.output : null,
    outputAvailability: availability,
    stops,
    predecessorHash: predecessor?.outcomeHash ?? null,
    status,
  };
  return artifact("outcome", {
    ...facts,
    outcomeHash: fingerprint("fork-outcome", facts),
  });
}
