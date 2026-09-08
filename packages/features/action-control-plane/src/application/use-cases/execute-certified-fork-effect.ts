import {
  opaqueId,
  positive,
  requireFact,
} from "../../domain/certified-fork-effect-canonical.js";
import {
  createForkEffect,
  createForkRequest,
} from "../../domain/certified-fork-effect-identity.js";
import type {
  ForkLedgerInput,
  ForkLedgerSnapshot,
} from "../ports/certified-fork-effect-repository-port.js";
import {
  advanced,
  applyForkEvent,
  captureForkInput,
  commandHash,
  commitForkCommand,
  comparison,
  currentClaim,
  exactForkFields,
  inactive,
  preparedForkCommit,
  ready,
  replayForkLedger,
  validateForkCommand,
  validateForkSnapshot,
  type ForkBoundary,
  type ForkBoundaryResult,
} from "../services/certified-fork-effect-ledger.js";

export type ForkExecutionInput =
  | Extract<ForkLedgerInput, { kind: "prepare" }>
  | {
      kind: "begin" | "retry";
      effectKey: string;
    };

/** Persist execution intent only. A committed begin is an input to a trusted
 * sender, never evidence of dispatch, remote success, or definitive no-effect.
 * Dedupe/ambiguous acknowledgements require reconciliation, not another send.
 * Inventory and evidence remain separately authenticated application operations.
 */
export async function executeCertifiedForkEffect(
  dependencies: ForkBoundary,
  input: {
    expected: ForkLedgerSnapshot;
    commandId: string;
    command: ForkExecutionInput;
  },
): Promise<ForkBoundaryResult> {
  const deps = ready(dependencies);
  if (!deps) return inactive(dependencies);
  input = captureForkInput(input);
  exactForkFields(input, ["expected", "commandId", "command"]);
  validateForkSnapshot(input.expected);
  opaqueId(input.commandId);
  requireFact(["prepare", "begin", "retry"].includes(input.command.kind));

  // Authenticate immutable history before storage yields. CAS covers the entire
  // family, including siblings used by publication dependency checks.
  const ledger = replayForkLedger(input.expected, deps.proofs);
  validateForkCommand(input.command, ledger.review);
  const request =
    input.command.kind === "prepare"
      ? createForkRequest(
          ledger.review,
          createForkEffect(ledger.review, input.command.request.slot),
          input.command.request.facts,
        )
      : null;
  const effectKey =
    input.command.kind === "prepare"
      ? request!.effect.effectKey
      : input.command.effectKey;
  const expected = comparison(input.expected, ledger);
  const requests = [...ledger.states.values()].map((state) => state.request);
  // Initial prepare must check the proposed request too, not just old siblings.
  if (request) requests.push(request);

  return commitForkCommand(deps, "compareAndCommit", {
    familyKey: input.expected.familyKey,
    commandId: input.commandId,
    commandHash: commandHash("execute", { expected, command: input.command }),
    expected,
    build(current, at) {
      positive(at);
      requireFact(current);
      const claim = currentClaim(current, at);
      deps.proofs.ownership(deps.ownerProof, claim.ownerHash, at);
      deps.proofs.admission(
        current.admissionProof,
        ledger.review,
        true,
        at,
        requests,
      );
      deps.proofs.mutation(input.command, ledger.review, at);
      const event = {
        at,
        input: input.command,
        authorityProof: deps.proofs.authorize({
          review: ledger.review,
          revision: ledger.states.get(effectKey)?.revision ?? "0",
          at,
          mode: "execute",
          claim,
        }),
      };
      // Domain rules enforce original claim on begin, closed no-effect on retry,
      // sticky holds/stops/seals, and publication inventory/dependencies.
      applyForkEvent(ledger, event, deps.proofs, claim);
      return preparedForkCommit(
        { ...advanced(current), events: [...current.events, event] },
        ledger,
      );
    },
  });
}
