import { types } from "node:util";
import {
  fingerprint,
  requireFact,
  next,
  positive,
  hash,
  counter,
  authentic,
} from "../../domain/certified-fork-effect-canonical.js";
import {
  createForkEffect,
  createForkRequest,
  createForkReview,
  type ForkReview,
} from "../../domain/certified-fork-effect-identity.js";
import {
  createForkReviewFromOutcome,
  createForkOutput,
  createForkDurabilityVerifier,
  freezeForkInventory,
  createForkOutcome,
  type ForkInventory,
  type ForkOutcome,
} from "../../domain/certified-fork-effect-outcome.js";
import {
  createForkStateVerifier,
  prepareForkEffect,
  transitionForkEffect,
  type ForkEffectState,
} from "../../domain/certified-fork-effect-state.js";
import type {
  CertifiedForkEffectProofPort,
  ForkAuthorityContext,
  ForkCheckpointState,
} from "../ports/certified-fork-effect-proof-port.js";
import type {
  CertifiedForkEffectRepositoryPort,
  ForkComparison,
  ForkLedgerEvent,
  ForkLedgerSnapshot,
  ForkReviewSeed,
  ForkTransaction,
  ForkLoadedReview,
  ForkLedgerInput,
} from "../ports/certified-fork-effect-repository-port.js";

/** No user code runs during capture: reject proxies before inspecting descriptors.
 * Dates (including Date-like objects), accessors and inherited records are not wire
 * values. Bounds apply to the entire graph, including ignored/unknown fields. */
export function captureForkInput<T>(input: T): T {
  let remaining = 1_000_000;
  const active = new Set<object>();
  function capture(value: unknown, depth: number): unknown {
    requireFact(--remaining >= 0 && depth <= 32);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      requireFact(value.length <= 4096);
      return value;
    }
    if (typeof value === "number") {
      requireFact(Number.isSafeInteger(value) && !Object.is(value, -0));
      return value;
    }
    requireFact(typeof value === "object" && value !== null);
    requireFact(!types.isProxy(value) && !active.has(value));
    const array = Array.isArray(value);
    requireFact(
      Object.getPrototypeOf(value) ===
        (array ? Array.prototype : Object.prototype),
    );
    const keys = Reflect.ownKeys(value);
    requireFact(keys.length <= (array ? 100_001 : 64));
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      requireFact(
        Number.isSafeInteger(length) && length >= 0 && length <= 100_000,
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    requireFact(keys.every((key) => typeof key === "string"));
    const length = array ? descriptors.length?.value : keys.length;
    requireFact(
      Number.isSafeInteger(length) &&
        length >= 0 &&
        length <= (array ? 100_000 : 64),
    );
    requireFact(!array || keys.length === length + 1);
    active.add(value);
    const result: Record<string, unknown> | unknown[] = array ? [] : {};
    for (const key of keys) {
      requireFact(typeof key === "string");
      const descriptor = descriptors[key]!;
      requireFact("value" in descriptor);
      if (array && key === "length") continue;
      requireFact(
        descriptor.enumerable &&
          (array
            ? /^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < length
            : /^[A-Za-z][A-Za-z0-9]*$/u.test(key)),
      );
      Object.defineProperty(result, key, {
        value: capture(descriptor.value, depth + 1),
        enumerable: true,
      });
    }
    active.delete(value);
    return Object.freeze(result);
  }
  return capture(input, 0) as T;
}
export function exactForkFields(
  value: object,
  required: string[],
  optional: string[] = [],
): void {
  requireFact(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  requireFact(
    required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every(
        (key) => required.includes(key) || optional.includes(key),
      ),
  );
}
function proofReference(value: unknown): void {
  requireFact(
    typeof value === "string" && value.length > 0 && value.length <= 4096,
  );
}
export function validateForkSeed(seed: ForkReviewSeed): ForkReview {
  exactForkFields(seed, [
    "facts",
    "bindingHash",
    "admissionHash",
    "predecessor",
  ]);
  requireFact(seed.facts && Object.hasOwn(seed.facts, "generation"));
  counter(seed.facts.generation);
  if (seed.predecessor !== null) proofReference(seed.predecessor);
  if (seed.admissionHash !== null) hash(seed.admissionHash);
  requireFact(
    seed.facts.generation === "0"
      ? seed.predecessor === null && seed.admissionHash === null
      : seed.predecessor !== null && seed.admissionHash !== null,
  );
  return createForkReview({ ...seed.facts, generation: "0" }, seed.bindingHash);
}
export function validateForkCommand(
  input: ForkLedgerInput,
  review?: ForkReview,
): void {
  requireFact(input !== null && typeof input === "object");
  if (input.kind === "prepare") {
    exactForkFields(input, ["kind", "request"]);
    exactForkFields(input.request, ["slot", "facts"]);
    requireFact(review);
    createForkRequest(
      review,
      createForkEffect(review, input.request.slot),
      input.request.facts,
    );
  } else if (
    ["begin", "retry", "seal", "stop", "evidence"].includes(input.kind)
  ) {
    exactForkFields(input, [
      "kind",
      "effectKey",
      ...(input.kind === "stop"
        ? ["reason"]
        : input.kind === "evidence"
          ? ["proof"]
          : []),
    ]);
    requireFact("effectKey" in input);
    hash(input.effectKey);
    if (input.kind === "stop")
      requireFact(input.reason === "stale" || input.reason === "cancelled");
    if (input.kind === "evidence") proofReference(input.proof);
  } else if (input.kind === "outcome") {
    exactForkFields(input, ["kind", "availability", "retainedProof"]);
    requireFact(
      input.availability === "available" ||
        input.availability === "unavailable",
    );
    if (input.retainedProof !== null) proofReference(input.retainedProof);
    requireFact(
      input.availability === "available"
        ? input.retainedProof !== null
        : input.retainedProof === null,
    );
  } else {
    requireFact(input.kind === "inventory");
    exactForkFields(input, ["kind", "entries", "completenessProof", "output"]);
    proofReference(input.completenessProof);
    requireFact(Array.isArray(input.entries) && input.entries.length <= 256);
    for (const entry of input.entries) {
      exactForkFields(entry, ["effectKey", "dependencies"]);
      hash(entry.effectKey);
      requireFact(
        Array.isArray(entry.dependencies) && entry.dependencies.length <= 256,
      );
      entry.dependencies.forEach(hash);
    }
    if (input.output !== null) {
      exactForkFields(input.output, [
        "effectKey",
        "canonicalOutputHash",
        "durabilityProof",
      ]);
      hash(input.output.effectKey);
      hash(input.output.canonicalOutputHash);
      proofReference(input.output.durabilityProof);
    }
  }
}
export function validateForkSnapshot(snapshot: ForkLedgerSnapshot): void {
  exactForkFields(
    snapshot,
    [
      "seed",
      "admissionProof",
      "reviewHash",
      "familyKey",
      "version",
      "fence",
      "claim",
      "events",
    ],
    ["checkpoint"],
  );
  const review = validateForkSeed(snapshot.seed);
  proofReference(snapshot.admissionProof);
  hash(snapshot.reviewHash);
  hash(snapshot.familyKey);
  counter(snapshot.version);
  counter(snapshot.fence);
  if (snapshot.claim !== null) {
    exactForkFields(snapshot.claim, [
      "ownerHash",
      "claimHash",
      "epoch",
      "expiresAt",
    ]);
    hash(snapshot.claim.ownerHash);
    hash(snapshot.claim.claimHash);
    counter(snapshot.claim.epoch);
    positive(snapshot.claim.expiresAt);
  }
  requireFact(Array.isArray(snapshot.events));
  let time = 0;
  for (const event of snapshot.events) {
    exactForkFields(event, ["at", "authorityProof", "input"]);
    positive(event.at);
    requireFact(event.at >= time);
    time = event.at;
    if (event.authorityProof !== null) proofReference(event.authorityProof);
    validateForkCommand(event.input, review);
  }
}

export type ForkBoundary = Readonly<{
  enabled?: boolean | undefined;
  repository?: CertifiedForkEffectRepositoryPort | undefined;
  proofs?: CertifiedForkEffectProofPort | undefined;
  ownerProof?: string | undefined;
}>;
export type ForkReady = {
  enabled: true;
  repository: CertifiedForkEffectRepositoryPort;
  proofs: CertifiedForkEffectProofPort;
  ownerProof: string;
};
export type ForkBoundaryResult =
  | { status: "disabled" | "missing_dependencies" }
  | {
      status: "committed" | "reconciliation_required";
      loaded: ForkLoadedReview;
    };
export function ready(deps: ForkBoundary): ForkReady | null {
  requireFact(
    typeof deps === "object" && deps !== null && !types.isProxy(deps),
  );
  requireFact(Object.getPrototypeOf(deps) === Object.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(deps);
  requireFact(Object.values(descriptors).every((d) => "value" in d));
  deps = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
  if (
    deps.enabled !== true ||
    !deps.repository ||
    !deps.proofs ||
    !deps.ownerProof
  )
    return null;
  requireFact(
    typeof deps.ownerProof === "string" && deps.ownerProof.length <= 4096,
  );
  return {
    enabled: true,
    repository: deps.repository,
    proofs: deps.proofs,
    ownerProof: deps.ownerProof,
  };
}
export function inactive(deps: ForkBoundary): ForkBoundaryResult {
  return {
    status: deps.enabled === true ? "missing_dependencies" : "disabled",
  };
}
export type ForkRebuiltLedger = {
  review: ForkReview;
  states: Map<string, ForkEffectState>;
  inventory: ForkInventory | null;
  outcome: ForkOutcome | null;
};
export const FORK_REPLAY_SUFFIX_LIMIT = 32;
export function checkpointAnchor(snapshot: ForkLedgerSnapshot): string {
  return fingerprint("fork-checkpoint-anchor", {
    seed: snapshot.seed,
    admissionProof: snapshot.admissionProof,
    reviewHash: snapshot.reviewHash,
    familyKey: snapshot.familyKey,
    version: snapshot.version,
    fence: snapshot.fence,
    claim: snapshot.claim,
  });
}
export function checkpointState(
  ledger: ForkRebuiltLedger,
): ForkCheckpointState {
  return { ...ledger, states: [...ledger.states.values()] };
}
export function preparedForkCommit(
  snapshot: ForkLedgerSnapshot,
  ledger: ForkRebuiltLedger,
) {
  return { snapshot, state: checkpointState(ledger) };
}
export function rebuildReview(
  seed: ForkReviewSeed,
  proofs: CertifiedForkEffectProofPort,
  depth = 0,
): ForkReview {
  requireFact(depth < 64);
  const predecessor =
    seed.predecessor === null
      ? null
      : replayForkLedger(
          proofs.predecessor(seed.predecessor),
          proofs,
          depth + 1,
        ).outcome;
  requireFact(seed.predecessor === null || predecessor !== null);
  return createForkReviewFromOutcome(
    seed.facts,
    seed.bindingHash,
    predecessor,
    seed.admissionHash === null ? null : { admissionHash: seed.admissionHash },
  );
}
/** Unbounded ordered log uses a chain rather than canonical's bounded set arrays.
 * This digest is an integrity comparison, NEVER proof of authenticity on its own. */
export function forkLedgerHash(
  snapshot: ForkLedgerSnapshot,
  length = snapshot.events.length,
): string {
  requireFact(
    Number.isSafeInteger(length) &&
      length >= 0 &&
      length <= snapshot.events.length,
  );
  let digest = fingerprint("fork-ledger-seed", {
    seed: snapshot.seed,
    admissionProof: snapshot.admissionProof,
  });
  for (const event of snapshot.events.slice(0, length))
    digest = fingerprint("fork-ledger-link", { previous: digest, event });
  return digest;
}
export function replayForkLedger(
  snapshot: ForkLedgerSnapshot,
  proofs: CertifiedForkEffectProofPort,
  depth = 0,
): ForkRebuiltLedger {
  snapshot = captureForkInput(snapshot);
  validateForkSnapshot(snapshot);
  const checkpoint = snapshot.checkpoint;
  const prefixLength = checkpoint?.prefixLength ?? 0;
  if (
    !Number.isSafeInteger(prefixLength) ||
    prefixLength < 0 ||
    prefixLength > snapshot.events.length
  )
    throw new Error("checkpoint_tampered");
  if (snapshot.events.length - prefixLength > FORK_REPLAY_SUFFIX_LIMIT)
    throw new Error("checkpoint_required");
  if (
    checkpoint &&
    (checkpoint.anchorHash !== checkpointAnchor(snapshot) ||
      checkpoint.prefixHash !== forkLedgerHash(snapshot, prefixLength))
  )
    throw new Error("checkpoint_stale_or_tampered");
  proofs.verifyLedger(snapshot);
  if (checkpoint) {
    const restored = proofs.restoreCheckpoint(checkpoint, snapshot);
    authentic("review", restored.review);
    restored.states.forEach((state) => authentic("state", state));
    if (restored.inventory) authentic("inventory", restored.inventory);
    if (restored.outcome) authentic("outcome", restored.outcome);
    requireFact(
      fingerprint("fork-checkpoint-state", restored) ===
        fingerprint("fork-checkpoint-state", checkpoint.state),
    );
    requireFact(
      fingerprint("fork-admission", restored.review) === snapshot.reviewHash &&
        restored.review.familyKey === snapshot.familyKey,
    );
    const ledger = {
      ...restored,
      states: new Map(
        restored.states.map((state) => [state.request.effect.effectKey, state]),
      ),
    };
    requireFact(ledger.states.size === restored.states.length);
    for (const event of snapshot.events.slice(prefixLength))
      applyForkEvent(ledger, event, proofs, null);
    return ledger;
  }
  const review = rebuildReview(snapshot.seed, proofs, depth);
  requireFact(
    snapshot.reviewHash === fingerprint("fork-admission", review) &&
      snapshot.familyKey === review.familyKey,
  );
  proofs.admission(snapshot.admissionProof, review, false, null, []);
  const ledger: ForkRebuiltLedger = {
    review,
    states: new Map(),
    inventory: null,
    outcome: null,
  };
  let time = 0;
  for (const event of snapshot.events) {
    positive(event.at);
    requireFact(event.at >= time);
    time = event.at;
    applyForkEvent(ledger, event, proofs, null);
  }
  return ledger;
}
export function applyForkEvent(
  ledger: ForkRebuiltLedger,
  event: ForkLedgerEvent,
  proofs: CertifiedForkEffectProofPort,
  claim: ForkLedgerSnapshot["claim"],
): void {
  const { input, at } = event;
  const { review, states } = ledger;
  if (input.kind === "inventory") {
    requireFact(
      ledger.inventory === null &&
        event.authorityProof === null &&
        ledger.outcome === null,
    );
    const entries = input.entries.map((e) => {
      const state = states.get(e.effectKey);
      requireFact(state);
      return { request: state.request, dependencies: e.dependencies };
    });
    requireFact(entries.length === states.size);
    const expected = proofs.inventory(
      input.completenessProof,
      review,
      entries.map((e) => e.request),
      at,
    );
    const source =
      input.output === null ? null : states.get(input.output.effectKey);
    requireFact(input.output === null || source);
    const output =
      source && input.output
        ? createForkOutput(source, {
            bindingHash: review.bindingHash,
            contextHash: source.request.contextHash,
            canonicalOutputHash: input.output.canonicalOutputHash,
          })
        : null;
    const durability =
      output && input.output
        ? createForkDurabilityVerifier((proof: string) =>
            proofs.durability(proof, output, at),
          )(input.output.durabilityProof)
        : null;
    ledger.inventory = freezeForkInventory(
      review,
      entries,
      expected,
      output,
      durability,
    );
    return;
  }
  if (input.kind === "outcome") {
    requireFact(ledger.inventory && event.authorityProof === null);
    if (input.availability === "available") {
      requireFact(ledger.inventory.output && input.retainedProof !== null);
      proofs.retainedOutput(input.retainedProof, ledger.inventory.output, at);
    } else requireFact(input.retainedProof === null);
    ledger.outcome = createForkOutcome(
      review,
      ledger.inventory,
      [...states.values()],
      input.availability,
      ledger.outcome,
    );
    return;
  }
  const request =
    input.kind === "prepare"
      ? createForkRequest(
          review,
          createForkEffect(review, input.request.slot),
          input.request.facts,
        )
      : null;
  const key = request
    ? request.effect.effectKey
    : "effectKey" in input
      ? input.effectKey
      : "";
  const state = states.get(key);
  requireFact(event.authorityProof !== null);
  const context: ForkAuthorityContext = {
    review,
    revision: state?.revision ?? "0",
    at,
    mode:
      claim === null
        ? null
        : input.kind === "prepare" ||
            input.kind === "begin" ||
            input.kind === "retry"
          ? "execute"
          : "reconcile",
    claim,
  };
  const verifier = createForkStateVerifier({
    authority: (proof: string) => proofs.authority(proof, context),
    evidence: (proof: string) => proofs.evidence(proof),
  });
  const authority = verifier.authority(event.authorityProof);
  requireFact(
    (context.mode === null || authority.mode === context.mode) &&
      authority.revision === context.revision &&
      authority.reviewHash === fingerprint("fork-admission", review),
  );
  if (claim)
    requireFact(
      authority.epoch === claim.epoch &&
        authority.ownerHash === claim.ownerHash &&
        authority.claimHash === claim.claimHash &&
        authority.validUntilHash ===
          fingerprint("fork-lease-expiry", claim.expiresAt),
    );
  if (request) {
    requireFact(!state && ledger.inventory === null && ledger.outcome === null);
    states.set(key, prepareForkEffect(request, authority));
    return;
  }
  requireFact(state);
  const command =
    input.kind === "evidence"
      ? { kind: "evidence" as const, evidence: verifier.evidence(input.proof) }
      : input.kind === "begin"
        ? {
            kind: "begin" as const,
            inventory:
              state.request.effect.slot.stage === "provider"
                ? null
                : ledger.inventory,
            states:
              state.request.effect.slot.stage === "provider"
                ? []
                : [...states.values()],
          }
        : input.kind === "stop"
          ? { kind: "stop" as const, reason: input.reason }
          : { kind: input.kind as "retry" | "seal" };
  const updated = transitionForkEffect(state, authority, command);
  // Duplicate authenticated evidence must not acquire a new log entry/revision.
  requireFact(updated !== state);
  states.set(key, updated);
}
export function comparison(
  snapshot: ForkLedgerSnapshot,
  ledger: ForkRebuiltLedger,
): ForkComparison {
  return {
    reviewHash: snapshot.reviewHash,
    version: snapshot.version,
    fence: snapshot.fence,
    claim: snapshot.claim,
    ledgerHash: forkLedgerHash(snapshot),
    outcomeHash: ledger.outcome?.outcomeHash ?? null,
    revisions: [...ledger.states.values()]
      .map((s) => ({
        effectKey: s.request.effect.effectKey,
        revision: s.revision,
      }))
      .sort((a, b) => a.effectKey.localeCompare(b.effectKey)),
  };
}
export function currentClaim(
  snapshot: ForkLedgerSnapshot,
  at: number,
): NonNullable<ForkLedgerSnapshot["claim"]> {
  const claim = snapshot.claim;
  requireFact(claim && claim.epoch === snapshot.fence && claim.expiresAt > at);
  return claim;
}
export function advanced(snapshot: ForkLedgerSnapshot): ForkLedgerSnapshot {
  return { ...snapshot, version: next(snapshot.version) };
}
/** Authenticate the original command independently of the current family generation. */
export function verifyForkCommandReceipt(
  { proofs, ownerProof }: Pick<ForkReady, "proofs" | "ownerProof">,
  tx: Pick<ForkTransaction, "familyKey" | "commandId" | "commandHash">,
  loaded: ForkLoadedReview,
): ForkRebuiltLedger {
  requireFact(loaded.snapshot && loaded.receipt);
  const ledger = replayForkLedger(loaded.snapshot, proofs);
  proofs.verifyReceipt(loaded.receipt, loaded.snapshot);
  requireFact(
    loaded.snapshot.familyKey === tx.familyKey &&
      loaded.receipt.commandHash === tx.commandHash &&
      loaded.receipt.commandId === tx.commandId,
  );
  hash(loaded.receipt.ownerHash);
  // Release removes the claim and later acquisition replaces its owner/epoch.
  // Only the authenticated original receipt identifies the recovery principal.
  proofs.ownership(ownerProof, loaded.receipt.ownerHash, null);
  return ledger;
}
export async function commitForkCommand(
  deps: ForkReady,
  operation:
    | "acquireClaim"
    | "renewClaim"
    | "releaseClaim"
    | "compareAndCommit",
  tx: ForkTransaction,
): Promise<ForkBoundaryResult> {
  // Capture boundary identity before storage yields; proof bytes are never part
  // of deterministic command identity. build closes over captured use-case data.
  const { repository, proofs, ownerProof } = deps;
  const { build, ...identity } = tx;
  tx = Object.freeze({ ...captureForkInput(identity), build });
  let loaded: ForkLoadedReview;
  let recovered = false;
  try {
    loaded = await repository[operation](tx);
  } catch (error) {
    // Ambiguous acknowledgement permits one read, never another transaction.
    loaded = captureForkInput(
      await repository.loadReview(tx.familyKey, tx.commandId),
    );
    if (!loaded.receipt) throw error;
    recovered = true;
  }
  loaded = captureForkInput(loaded);
  const ledger = verifyForkCommandReceipt({ proofs, ownerProof }, tx, loaded);
  return {
    status:
      recovered ||
      loaded.replayed ||
      (operation === "acquireClaim" && ledger.states.size > 0)
        ? "reconciliation_required"
        : "committed",
    loaded,
  };
}
export function commandHash(operation: string, data: unknown): string {
  return hash(fingerprint("fork-application-command", { operation, data }));
}
