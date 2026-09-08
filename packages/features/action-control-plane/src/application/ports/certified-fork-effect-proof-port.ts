import type {
  ForkReview,
  ForkRequest,
} from "../../domain/certified-fork-effect-identity.js";
import type {
  ForkAuthority,
  ForkEvidence,
  ForkEffectState,
} from "../../domain/certified-fork-effect-state.js";
import type {
  ForkDurability,
  ForkOutput,
  ForkInventory,
  ForkOutcome,
} from "../../domain/certified-fork-effect-outcome.js";
import type {
  ForkClaim,
  ForkCommandReceipt,
  ForkLedgerInput,
  ForkLedgerSnapshot,
} from "./certified-fork-effect-repository-port.js";

/** Data on disk, never authority until authenticated by the trusted adapter.
 * Complete states bind requests, attempts, revisions, holds, stops and seal.
 * anchorHash binds admission/seed, family, aggregate revision, fence and claim.
 * position binds the command receipt; prefixHash commits ordered canonical events.
 */
export type ForkCheckpointState = Readonly<{
  review: ForkReview;
  states: readonly ForkEffectState[];
  inventory: ForkInventory | null;
  outcome: ForkOutcome | null;
}>;
export type ForkCheckpoint = Readonly<{
  proof: string;
  prefixLength: number;
  prefixHash: string;
  anchorHash: string;
  position: { commandId: string; commandHash: string } | null;
  state: ForkCheckpointState;
}>;

export type ForkAuthorityContext = Readonly<{
  review: ForkReview;
  revision: string;
  at: number;
  mode: "execute" | "reconcile" | null; // null: authenticate the recorded historical mode
  claim: ForkClaim | null;
}>;
/** INTERNAL trusted composition only. Methods throw on unauthenticated proof.
 * Tokens must resolve to authenticated retained facts, never caller-supplied DTOs.
 * Historical verification proves authority at the recorded transaction time, NOT
 * a lease valid now. verifyLedger authenticates the entire ordered durable log,
 * its completeness, admission, version and historical claim/fence (no hash-only trust).
 * Repository comparison, not historical verification, establishes the current family tip.
 * Current admission additionally checks tenant, binding, provider settings/input,
 * remote scope and predecessor against the authoritative control-plane contract.
 * Historical verification/restoration runs before repository transactions. Current
 * lease/ownership/admission checks remain synchronous at storage time.
 */
export interface CertifiedForkEffectProofPort {
  /** Authenticate every checkpoint byte against retained trusted facts, then mint
   * fresh domain capabilities. A DTO cast, hash-only check or process-local cache
   * is insufficient. Historical capabilities NEVER establish a current lease.
   */
  restoreCheckpoint(
    checkpoint: ForkCheckpoint,
    snapshot: ForkLedgerSnapshot,
  ): ForkCheckpointState;
  /** Trusted composition only: accept live domain capabilities after validated
   * transition. Retain the data-only authenticated checkpoint atomically with the
   * ledger/receipt; an issued but uncommitted token is not a committed ledger.
   */
  issueCheckpoint(
    snapshot: ForkLedgerSnapshot,
    state: ForkCheckpointState,
    position: ForkCheckpoint["position"],
  ): ForkCheckpoint;
  /** Authenticate the CURRENT requesting principal; knowing the stored hash is
   * not ownership. null authenticates receipt recovery without requiring a live
   * lease; it must still reject invalid principal proofs. A numeric storage time
   * is used for new transactions. Never treat historical authority as a session.
   */
  ownership(proof: string, ownerHash: string, at: number | null): void;
  predecessor(proof: string): ForkLedgerSnapshot;
  verifyLedger(snapshot: ForkLedgerSnapshot): void;
  /** Authenticate every receipt field, including original ownerHash, and its
   * binding to this family and original review/command/version. A later snapshot
   * may have a different claim/epoch; it must not replace the receipt owner.
   */
  verifyReceipt(
    receipt: ForkCommandReceipt,
    snapshot: ForkLedgerSnapshot,
  ): void;
  admission(
    proof: string,
    review: ForkReview,
    current: boolean,
    at: number | null,
    requests: readonly ForkRequest[],
  ): void;
  authorize(context: ForkAuthorityContext): string;
  authority(proof: string, context: ForkAuthorityContext): ForkAuthority;
  evidence(proof: string): ForkEvidence;
  inventory(
    proof: string,
    review: ForkReview,
    requests: readonly ForkRequest[],
    at: number,
  ): readonly string[];
  durability(proof: string, output: ForkOutput, at: number): ForkDurability;
  retainedOutput(proof: string, output: ForkOutput, at: number): void;
  /** Authenticate new evidence against its original receipt/authority too, so an
   * identical late proof can dedupe without rewriting its authorityHash. */
  mutation(input: ForkLedgerInput, review: ForkReview, at: number): void;
}
