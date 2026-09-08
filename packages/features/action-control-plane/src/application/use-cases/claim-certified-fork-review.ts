import {
  fingerprint,
  hash,
  next,
  opaqueId,
  positive,
  requireFact,
} from "../../domain/certified-fork-effect-canonical.js";
import { assertSameForkReview } from "../../domain/certified-fork-effect-identity.js";
import type {
  ForkLedgerSnapshot,
  ForkReviewSeed,
} from "../ports/certified-fork-effect-repository-port.js";
import {
  advanced,
  commandHash,
  commitForkCommand,
  verifyForkCommandReceipt,
  comparison,
  currentClaim,
  inactive,
  ready,
  rebuildReview,
  replayForkLedger,
  captureForkInput,
  exactForkFields,
  validateForkSeed,
  validateForkSnapshot,
  preparedForkCommit,
  type ForkBoundary,
} from "../services/certified-fork-effect-ledger.js";

/** PR A has claim ownership only; it cannot reserve, begin, retry or send. */
export async function claimCertifiedForkReview(
  dependencies: ForkBoundary,
  input: {
    seed: ForkReviewSeed;
    admissionProof: string;
    ownerHash: string;
    ttlMs: number;
    commandId: string;
  },
) {
  const deps = ready(dependencies);
  if (!deps) return inactive(dependencies);
  input = captureForkInput(input);
  exactForkFields(input, [
    "seed",
    "admissionProof",
    "ownerHash",
    "ttlMs",
    "commandId",
  ]);
  validateForkSeed(input.seed);
  requireFact(
    typeof input.admissionProof === "string" && input.admissionProof.length > 0,
  );
  hash(input.ownerHash);
  opaqueId(input.commandId);
  positive(input.ttlMs);
  requireFact(input.ttlMs <= 300_000);
  const proposed = rebuildReview(input.seed, deps.proofs);
  const identity = {
    familyKey: proposed.familyKey,
    commandId: input.commandId,
    commandHash: commandHash("acquire", input),
  };
  const loaded = captureForkInput(
    await deps.repository.loadReview(identity.familyKey, identity.commandId),
  );
  // A delayed acknowledgement belongs to the original command, even when the
  // family has advanced. Only an authenticated exact receipt skips admission.
  if (loaded.receipt !== null) {
    requireFact(
      loaded.receipt.commandId === identity.commandId &&
        loaded.receipt.commandHash === identity.commandHash,
    );
    verifyForkCommandReceipt(deps, identity, loaded);
    return { status: "reconciliation_required" as const, loaded };
  }
  const prior =
    loaded.snapshot && replayForkLedger(loaded.snapshot, deps.proofs);
  const predecessor =
    input.seed.predecessor === null
      ? null
      : replayForkLedger(
          deps.proofs.predecessor(input.seed.predecessor),
          deps.proofs,
        );
  if (prior) {
    if (prior.review.logicalKey === proposed.logicalKey)
      assertSameForkReview(prior.review, proposed);
    else {
      requireFact(input.seed.predecessor !== null && prior.outcome !== null);
      // Validate the complete predecessor projection before entering storage CAS.
      requireFact(
        [...prior.states.values()].every((state) =>
          prior.outcome!.states.some(
            (old) =>
              fingerprint("fork-state", old) ===
              fingerprint("fork-state", state),
          ),
        ),
      );
      requireFact(
        predecessor?.outcome?.outcomeHash === prior.outcome.outcomeHash &&
          predecessor.review.familyKey === loaded.snapshot?.familyKey,
      );
    }
  }
  return commitForkCommand(deps, "acquireClaim", {
    ...identity,
    expected:
      loaded.snapshot && prior ? comparison(loaded.snapshot, prior) : null,
    build(current, at) {
      positive(at);
      deps.proofs.ownership(deps.ownerProof, input.ownerHash, at);
      deps.proofs.admission(
        input.admissionProof,
        proposed,
        true,
        at,
        prior?.review.logicalKey === proposed.logicalKey
          ? [...prior.states.values()].map((s) => s.request)
          : [],
      );
      let events: ForkLedgerSnapshot["events"] = [];
      if (current) {
        requireFact(current.claim === null || current.claim.expiresAt <= at);
        if (prior?.review.logicalKey === proposed.logicalKey)
          events = current.events;
      } else requireFact(input.seed.facts.generation === "0");
      const epoch = next(current?.fence ?? "0");
      const expiresAt = positive(at + input.ttlMs);
      return preparedForkCommit(
        {
          seed: input.seed,
          admissionProof: input.admissionProof,
          reviewHash: fingerprint("fork-admission", proposed),
          familyKey: proposed.familyKey,
          version: next(current?.version ?? "0"),
          fence: epoch,
          events,
          claim: {
            ownerHash: input.ownerHash,
            epoch,
            expiresAt,
            claimHash: fingerprint("fork-claim", {
              reviewHash: fingerprint("fork-admission", proposed),
              ownerHash: input.ownerHash,
              epoch,
              at,
            }),
          },
        },
        prior?.review.logicalKey === proposed.logicalKey
          ? prior
          : {
              review: proposed,
              states: new Map(),
              inventory: null,
              outcome: null,
            },
      );
    },
  });
}

export async function manageCertifiedForkClaim(
  dependencies: ForkBoundary,
  input: {
    operation: "renew" | "release";
    expected: ForkLedgerSnapshot;
    commandId: string;
    ttlMs?: number;
  },
) {
  const deps = ready(dependencies);
  if (!deps) return inactive(dependencies);
  input = captureForkInput(input);
  exactForkFields(input, ["operation", "expected", "commandId"], ["ttlMs"]);
  validateForkSnapshot(input.expected);
  requireFact(input.operation === "renew" || input.operation === "release");
  opaqueId(input.commandId);
  const ttl = input.operation === "renew" ? positive(input.ttlMs) : 0;
  if (input.ttlMs !== undefined) positive(input.ttlMs);
  requireFact(ttl <= 300_000);
  const ledger = replayForkLedger(input.expected, deps.proofs);
  const expected = comparison(input.expected, ledger);
  return commitForkCommand(
    deps,
    input.operation === "renew" ? "renewClaim" : "releaseClaim",
    {
      familyKey: input.expected.familyKey,
      commandId: input.commandId,
      commandHash: commandHash(input.operation, { expected, ttl }),
      expected,
      build(current, at) {
        requireFact(current);
        const claim = currentClaim(current, at);
        deps.proofs.ownership(deps.ownerProof, claim.ownerHash, at);
        const rebuilt = ledger;
        deps.proofs.admission(
          current.admissionProof,
          rebuilt.review,
          true,
          at,
          [...rebuilt.states.values()].map((s) => s.request),
        );
        return preparedForkCommit(
          {
            ...advanced(current),
            claim:
              input.operation === "release"
                ? null
                : {
                    ...claim,
                    expiresAt: positive(Math.max(claim.expiresAt, at + ttl)),
                  },
          },
          ledger,
        );
      },
    },
  );
}
