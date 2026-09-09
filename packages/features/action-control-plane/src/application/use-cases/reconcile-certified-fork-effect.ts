import {
  fingerprint,
  opaqueId,
  requireFact,
} from "../../domain/certified-fork-effect-canonical.js";
import { createForkStateVerifier } from "../../domain/certified-fork-effect-state.js";
import type {
  ForkLedgerInput,
  ForkLedgerSnapshot,
} from "../ports/certified-fork-effect-repository-port.js";
import {
  advanced,
  applyForkEvent,
  commandHash,
  commitForkCommand,
  comparison,
  currentClaim,
  inactive,
  ready,
  replayForkLedger,
  captureForkInput,
  exactForkFields,
  validateForkCommand,
  validateForkSnapshot,
  preparedForkCommit,
  type ForkBoundary,
} from "../services/certified-fork-effect-ledger.js";

export type ForkReconciliationInput =
  | Extract<ForkLedgerInput, { kind: "evidence" | "stop" | "outcome" }>
  | { kind: "seal"; effectKey: string };

/** Only evidence, sticky stops, sealing and outcome correction are writable in A.
 * Retry and begin remain entirely absent, including after authenticated no-effect.
 */
export async function reconcileCertifiedForkEffect(
  dependencies: ForkBoundary,
  input: {
    expected: ForkLedgerSnapshot;
    commandId: string;
    command: ForkReconciliationInput;
  },
) {
  const deps = ready(dependencies);
  if (!deps) return inactive(dependencies);
  input = captureForkInput(input);
  exactForkFields(input, ["expected", "commandId", "command"]);
  validateForkSnapshot(input.expected);
  validateForkCommand(input.command);
  requireFact(
    ["evidence", "stop", "seal", "outcome"].includes(input.command.kind),
  );
  opaqueId(input.commandId);
  const prior = replayForkLedger(input.expected, deps.proofs);
  const expected = comparison(input.expected, prior);
  return commitForkCommand(deps, "compareAndCommit", {
    familyKey: input.expected.familyKey,
    commandId: input.commandId,
    commandHash: commandHash("reconcile", { expected, command: input.command }),
    expected,
    build(current, at) {
      requireFact(current);
      const claim = currentClaim(current, at);
      deps.proofs.ownership(deps.ownerProof, claim.ownerHash, at);
      const ledger = prior;
      deps.proofs.admission(
        current.admissionProof,
        ledger.review,
        true,
        at,
        [...ledger.states.values()].map((s) => s.request),
      );
      deps.proofs.mutation(input.command, ledger.review, at);
      const state =
        "effectKey" in input.command
          ? ledger.states.get(input.command.effectKey)
          : null;
      if (input.command.kind === "evidence") {
        requireFact(state);
        const evidence = createForkStateVerifier({
          authority: () => {
            throw new Error("no_authority");
          },
          evidence: (proof: string) => deps.proofs.evidence(proof),
        }).evidence(input.command.proof);
        const duplicate = state.attempts.some((attempt) =>
          attempt.evidence.some(
            (old) =>
              fingerprint("fork-evidence", old) ===
              fingerprint("fork-evidence", evidence),
          ),
        );
        if (duplicate) return preparedForkCommit(advanced(current), ledger); // Receipt-only commit, no history rewrite.
      }
      const event = {
        at,
        input: input.command,
        authorityProof:
          input.command.kind === "outcome"
            ? null
            : deps.proofs.authorize({
                review: ledger.review,
                revision: state?.revision ?? "0",
                at,
                mode: "reconcile",
                claim,
              }),
      };
      applyForkEvent(ledger, event, deps.proofs, claim);
      return preparedForkCommit(
        { ...advanced(current), events: [...current.events, event] },
        ledger,
      );
    },
  });
}
