import {
  artifact,
  authentic,
  choice,
  counter,
  fingerprint,
  hash,
  list,
  next,
  nullable,
  record,
  requireFact,
  set,
} from "./certified-fork-effect-canonical.js";
import type { ForkRequest } from "./certified-fork-effect-identity.js";
import type { ForkInventory } from "./certified-fork-effect-outcome.js";
const authorityFacts = record({
  logicalKey: hash,
  reviewHash: hash,
  epoch: counter,
  claimHash: hash,
  ownerHash: hash,
  revision: counter,
  mode: choice("execute", "reconcile"),
  validUntilHash: hash,
});
export type ForkAuthority = ReturnType<typeof authorityFacts>;
const evidenceFacts = record({
  logicalKey: hash,
  effectKey: hash,
  requestHash: hash,
  attempt: counter,
  originEpoch: counter,
  remoteScopeHash: hash,
  authorityHash: hash,
  kind: choice("success", "no_effect", "unknown", "conflict"),
  source: choice(
    "provider_receipt",
    "github_app_receipt",
    "dispatch_journal",
    "observation",
  ),
  verifierHash: hash,
  evidenceHash: hash,
  externalRefHash: nullable(hash),
  resultHash: nullable(hash),
  disposition: choice(
    "authenticated_success",
    "definitive_no_effect",
    "indeterminate",
    "duplicate_effects",
  ),
  senderClosure: choice("closed", "open"),
  reason: choice(
    "confirmed",
    "never_dispatched",
    "rejected",
    "timeout",
    "absent",
    "listing_empty",
    "conflicting",
    "duplicate_remote_effects",
  ),
});
export type ForkEvidence = ReturnType<typeof evidenceFacts>;
const evidenceKey = (e: ForkEvidence) => fingerprint("fork-evidence", e);
export type ForkAttempt = Readonly<{
  ordinal: string;
  originEpoch: string;
  originClaimHash: string;
  originOwnerHash: string;
  status: "prepared" | "in_flight" | "succeeded" | "no_effect" | "unknown";
  evidence: readonly ForkEvidence[];
}>;
export type ForkStop = "stale" | "cancelled";
export type ForkEffectState = Readonly<{
  request: ForkRequest;
  revision: string;
  authority: ForkAuthority;
  attempts: readonly ForkAttempt[];
  stops: readonly ForkStop[];
  sealed: boolean;
  integrityHold: boolean;
  inventoryHash: string | null;
}>;
export type ForkCommand =
  | {
      kind: "begin";
      inventory: ForkInventory | null;
      states: readonly ForkEffectState[];
    }
  | { kind: "evidence"; evidence: ForkEvidence }
  | { kind: "retry" }
  | { kind: "stop"; reason: ForkStop }
  | { kind: "seal" };
const stopParser = choice("stale", "cancelled");
export function forkAuthorityHash(authority: ForkAuthority): string {
  authentic("authority", authority);
  return fingerprint("fork-authority", authority);
}
function attempt(authority: ForkAuthority, ordinal: string): ForkAttempt {
  return {
    ordinal,
    originEpoch: authority.epoch,
    originClaimHash: authority.claimHash,
    originOwnerHash: authority.ownerHash,
    status: "prepared",
    evidence: [],
  };
}
export function prepareForkEffect(
  request: ForkRequest,
  authority: ForkAuthority,
): ForkEffectState {
  authentic("request", request);
  authentic("authority", authority);
  requireFact(
    authority.logicalKey === request.effect.logicalKey &&
      authority.reviewHash === fingerprint("fork-admission", request.review) &&
      authority.mode === "execute" &&
      authority.revision === "0",
  );
  return artifact("state", {
    request,
    revision: "1",
    authority,
    attempts: [attempt(authority, "0")],
    stops: [],
    sealed: false,
    integrityHold: false,
    inventoryHash: null,
  });
}
/** The state passed here must be the complete authoritative ledger for this effect.
 * A storage adapter must later CAS it; constructing a fresh ledger is not retry permission. */
export function transitionForkEffect(
  state: ForkEffectState,
  authority: ForkAuthority,
  input: ForkCommand,
): ForkEffectState {
  authentic("state", state);
  authentic("authority", authority);
  requireFact(
    authority.logicalKey === state.request.effect.logicalKey &&
      authority.reviewHash ===
        fingerprint("fork-admission", state.request.review),
  );
  const command = parseCommand(input);
  const targetIndex =
    command.kind === "evidence"
      ? state.attempts.findIndex((a) => a.ordinal === command.evidence.attempt)
      : state.attempts.length - 1;
  requireFact(targetIndex >= 0);
  const last = state.attempts[targetIndex]!;
  if (
    command.kind === "evidence" &&
    last.evidence.some(
      (item) => evidenceKey(item) === evidenceKey(command.evidence),
    )
  )
    return state;
  requireFact(
    authority.revision === state.revision &&
      BigInt(authority.epoch) >= BigInt(state.authority.epoch),
  );
  if (authority.epoch === state.authority.epoch) {
    requireFact(
      authority.claimHash === state.authority.claimHash &&
        authority.ownerHash === state.authority.ownerHash,
    );
  }
  let updated = last;
  let stops = state.stops;
  let sealed = state.sealed;
  let integrityHold = state.integrityHold;
  let inventoryHash = state.inventoryHash;
  const attempts = [...state.attempts];
  if (command.kind === "stop")
    stops = set(
      [...stops.filter((s) => s !== command.reason), command.reason],
      (s) => s,
    );
  else if (command.kind === "seal") sealed = true;
  else if (command.kind === "begin" || command.kind === "retry") {
    requireFact(
      authority.mode === "execute" &&
        !sealed &&
        stops.length === 0 &&
        !integrityHold,
    );
    if (command.kind === "begin") {
      requireFact(
        last.status === "prepared" &&
          last.originEpoch === authority.epoch &&
          last.originClaimHash === authority.claimHash &&
          last.originOwnerHash === authority.ownerHash,
      );
      if (state.request.effect.slot.stage === "publication") {
        requireFact(command.inventory !== null);
        authentic("inventory", command.inventory);
        requireFact(
          inventoryHash === null ||
            inventoryHash === command.inventory.inventoryHash,
        );
        inventoryHash = command.inventory.inventoryHash;
        const entry = command.inventory.entries.find(
          (item) => item.request.requestHash === state.request.requestHash,
        );
        const states = set(command.states, (s) => s.request.effect.effectKey);
        requireFact(
          entry &&
            states.includes(state) &&
            states.length === command.inventory.entries.length,
        );
        const output = command.inventory.output;
        const provider = states.find(
          (s) => s.request.effect.slot.stage === "provider",
        );
        requireFact(
          output &&
            provider &&
            provider.request.requestHash === output.requestHash &&
            provider.attempts.at(-1)!.status === "succeeded" &&
            provider.attempts
              .at(-1)!
              .evidence.some(
                (e) =>
                  isForkSuccess(provider.request, e) &&
                  evidenceKey(e) === output.successEvidenceHash &&
                  e.resultHash === output.canonicalOutputHash,
              ),
        );
        requireFact(
          states.every(
            (s, i) =>
              s.request.requestHash ===
                command.inventory!.entries[i]!.request.requestHash &&
              (s.inventoryHash === null || s.inventoryHash === inventoryHash) &&
              !s.sealed &&
              !s.integrityHold &&
              s.stops.length === 0 &&
              (s.attempts.at(-1)!.status === "succeeded" ||
                (!entry.dependencies.includes(s.request.effect.effectKey) &&
                  ["prepared", "no_effect"].includes(
                    s.attempts.at(-1)!.status,
                  ))),
          ),
        );
      } else
        requireFact(command.inventory === null && command.states.length === 0);
      updated = { ...last, status: "in_flight" };
    } else {
      requireFact(last.status === "no_effect");
      requireFact(attempts.length < 256);
      attempts.push(attempt(authority, next(last.ordinal)));
    }
  } else {
    const evidence = command.evidence;
    requireFact(
      evidence.logicalKey === state.request.effect.logicalKey &&
        evidence.effectKey === state.request.effect.effectKey &&
        evidence.requestHash === state.request.requestHash &&
        evidence.attempt === last.ordinal &&
        evidence.originEpoch === last.originEpoch &&
        evidence.remoteScopeHash === state.request.remoteScopeHash &&
        evidence.authorityHash === forkAuthorityHash(authority),
    );
    if (
      last.status === "unknown" ||
      last.status === "no_effect" ||
      targetIndex !== attempts.length - 1 ||
      sealed
    )
      requireFact(authority.mode === "reconcile");
    const success = isForkSuccess(state.request, evidence);
    const noEffect =
      evidence.kind === "no_effect" &&
      evidence.disposition === "definitive_no_effect" &&
      evidence.senderClosure === "closed" &&
      evidence.externalRefHash === null &&
      evidence.resultHash === null &&
      (evidence.reason === "never_dispatched"
        ? evidence.source === "dispatch_journal"
        : evidence.reason === "rejected" &&
          evidence.source ===
            (state.request.effect.slot.stage === "provider"
              ? "provider_receipt"
              : "github_app_receipt"));
    if (last.status === "prepared")
      requireFact(noEffect && evidence.reason === "never_dispatched");
    // Inconsistent terminal evidence is retained as an integrity hold, never a retry.
    const conflicting =
      evidence.kind === "conflict" ||
      evidence.disposition === "duplicate_effects" ||
      last.status === "succeeded" ||
      (last.status === "no_effect" && !noEffect);
    integrityHold ||= conflicting;
    updated = {
      ...last,
      status: conflicting
        ? "unknown"
        : success
          ? "succeeded"
          : noEffect
            ? "no_effect"
            : "unknown",
      evidence: set([...last.evidence, evidence], (e) => evidenceKey(e)),
    };
    requireFact(updated.evidence.length <= 256);
    // Saturation itself is a sticky hold, committed with the last retained proof.
    // Further distinct evidence is explicitly rejected, never silently discarded;
    // the authoritative prior ledger already forbids every begin/retry path.
    integrityHold ||= updated.evidence.length === 256;
  }
  if (command.kind !== "retry") attempts[targetIndex] = updated;
  return artifact("state", {
    request: state.request,
    revision: next(state.revision),
    authority,
    attempts,
    stops,
    sealed,
    integrityHold,
    inventoryHash,
  });
}
function parseCommand(input: ForkCommand): ForkCommand {
  // Exact alternatives are tried using descriptor-safe parsers; no input property is read.
  const alternatives = [
    record({
      kind: choice("begin"),
      inventory: nullable((v: unknown) =>
        authentic("inventory", v as ForkInventory),
      ),
      states: list((v: unknown) => authentic("state", v as ForkEffectState)),
    }),
    record({
      kind: choice("evidence"),
      evidence: (v: unknown) => authentic("evidence", v as ForkEvidence),
    }),
    record({ kind: choice("retry") }),
    record({ kind: choice("stop"), reason: stopParser }),
    record({ kind: choice("seal") }),
  ];
  for (const parse of alternatives) {
    try {
      return parse(input);
    } catch {
      /* try exact next shape */
    }
  }
  throw new Error("certified_fork_effect_contract_rejected");
}
/** INTERNAL trust injection, never exported by the package root. Only the trusted
 * composition root may install these verifiers. They must authenticate opaque
 * adapter proofs (including current lease, sender closure and receipt semantics),
 * and throw on failure; accepting a caller DTO here defeats the trust boundary.
 * Authority reviewHash must be fingerprint("fork-admission", admittedReview),
 * computed from the complete authoritative admitted review after verifying the
 * predecessor/admission and current lease. Legacy logical-key-only proofs reject.
 * Returned capabilities are detached, frozen and registered by runtime identity.
 * Persist data-only snapshots; restore mutation authority by replaying the verified
 * ledger through prepare/transition with newly verified capabilities, never casts.
 * Storage must still CAS the complete ledger and enforce current lease validity. */
export function createForkStateVerifier<
  AuthorityProof,
  EvidenceProof,
>(verifiers: {
  authority: (proof: AuthorityProof) => ForkAuthority;
  evidence: (proof: EvidenceProof) => ForkEvidence;
}) {
  const { authority, evidence } = verifiers;
  return Object.freeze({
    authority: (proof: AuthorityProof) =>
      artifact("authority", authorityFacts(authority(proof))),
    evidence: (proof: EvidenceProof) =>
      artifact("evidence", evidenceFacts(evidence(proof))),
  });
}
export function isForkSuccess(
  request: ForkRequest,
  evidence: ForkEvidence,
): boolean {
  return (
    evidence.kind === "success" &&
    evidence.disposition === "authenticated_success" &&
    evidence.reason === "confirmed" &&
    evidence.externalRefHash !== null &&
    evidence.resultHash !== null &&
    evidence.source ===
      (request.effect.slot.stage === "provider"
        ? "provider_receipt"
        : "github_app_receipt")
  );
}
export function assertForkStateExtension(
  previous: ForkEffectState,
  current: ForkEffectState,
): void {
  authentic("state", previous);
  authentic("state", current);
  requireFact(
    previous.request.requestHash === current.request.requestHash &&
      BigInt(current.revision) >= BigInt(previous.revision) &&
      BigInt(current.authority.epoch) >= BigInt(previous.authority.epoch),
  );
  if (current.revision === previous.revision)
    requireFact(
      fingerprint("fork-state", current) ===
        fingerprint("fork-state", previous),
    );
  if (current.authority.epoch === previous.authority.epoch)
    requireFact(
      current.authority.claimHash === previous.authority.claimHash &&
        current.authority.ownerHash === previous.authority.ownerHash,
    );
  if (previous.sealed && current.revision !== previous.revision)
    requireFact(current.authority.mode === "reconcile");
  requireFact(
    previous.stops.every((s) => current.stops.includes(s)) &&
      (!previous.sealed || current.sealed) &&
      (!previous.integrityHold || current.integrityHold),
  );
  requireFact(current.attempts.length >= previous.attempts.length);
  requireFact(
    previous.inventoryHash === null ||
      current.inventoryHash === previous.inventoryHash,
  );
  previous.attempts.forEach((old, index) => {
    const newer = current.attempts[index]!;
    requireFact(
      old.ordinal === newer.ordinal &&
        old.originEpoch === newer.originEpoch &&
        old.originClaimHash === newer.originClaimHash &&
        old.originOwnerHash === newer.originOwnerHash,
    );
    requireFact(
      old.evidence.every((e) =>
        newer.evidence.some((n) => evidenceKey(n) === evidenceKey(e)),
      ),
    );
    if (old.status === "unknown" || old.status === "in_flight")
      requireFact(newer.status !== "prepared");
    if (old.status === "succeeded")
      requireFact(newer.status === "succeeded" || current.integrityHold);
    if (old.status === "no_effect")
      requireFact(newer.status === "no_effect" || current.integrityHold);
  });
}
