import type {
  ForkLogicalFacts,
  ForkProviderFacts,
  ForkPublicationFacts,
  ForkSlot,
} from "../../domain/certified-fork-effect-identity.js";
import type { ForkStop } from "../../domain/certified-fork-effect-state.js";
import type {
  ForkCheckpoint,
  ForkCheckpointState,
} from "./certified-fork-effect-proof-port.js";

/** PR A: reconstruction data, not capabilities. No reservation or send API. */
export type ForkReviewSeed = Readonly<{
  facts: ForkLogicalFacts;
  bindingHash: string;
  admissionHash: string | null;
  predecessor: string | null;
}>;
export type ForkRequestSeed = Readonly<{
  slot: ForkSlot;
  facts: ForkProviderFacts | ForkPublicationFacts;
}>;
export type ForkLedgerInput =
  | { kind: "prepare"; request: ForkRequestSeed }
  | { kind: "begin" | "retry" | "seal"; effectKey: string }
  | { kind: "stop"; effectKey: string; reason: ForkStop }
  | { kind: "evidence"; effectKey: string; proof: string }
  | {
      kind: "inventory";
      entries: readonly {
        effectKey: string;
        dependencies: readonly string[];
      }[];
      completenessProof: string;
      output: {
        effectKey: string;
        canonicalOutputHash: string;
        durabilityProof: string;
      } | null;
    }
  | {
      kind: "outcome";
      availability: "available" | "unavailable";
      retainedProof: string | null;
    };
export type ForkLedgerEvent = Readonly<{
  at: number;
  authorityProof: string | null;
  input: ForkLedgerInput;
}>;
export type ForkClaim = Readonly<{
  ownerHash: string;
  claimHash: string;
  epoch: string;
  expiresAt: number;
}>;
export type ForkLedgerSnapshot = Readonly<{
  seed: ForkReviewSeed;
  admissionProof: string;
  reviewHash: string;
  familyKey: string;
  version: string;
  fence: string;
  claim: ForkClaim | null;
  events: readonly ForkLedgerEvent[];
  checkpoint?: ForkCheckpoint;
}>;
/** Compare every field, including all sibling revisions, in the same transaction.
 * Family row serialization also covers absent-row admission and predecessor outcome.
 * No clock supplied by a caller is authority. Release/expiry says nothing about sends.
 */
export type ForkComparison = Readonly<{
  reviewHash: string;
  version: string;
  fence: string;
  claim: ForkClaim | null;
  ledgerHash: string;
  outcomeHash: string | null;
  revisions: readonly { effectKey: string; revision: string }[];
}>;
/** Authenticated atomically with the command: ownerHash is the original
 * committing principal (acquired claim for acquire, pre-transition claim for
 * renew/release/compareAndCommit). Never derive it from the later family tip.
 * commandHash binds the original command, including its owner/claim/epoch facts.
 */
export type ForkCommandReceipt = Readonly<{
  ownerHash: string;
  commandId: string;
  commandHash: string;
  reviewHash: string;
  version: string;
}>;
export type ForkLoadedReview = Readonly<{
  snapshot: ForkLedgerSnapshot | null;
  receipt: ForkCommandReceipt | null;
  replayed?: boolean;
}>;
export type ForkTransaction = Readonly<{
  familyKey: string;
  commandId: string;
  commandHash: string;
  expected: ForkComparison | null;
  /** Called only after receipt dedupe and atomic comparison; synchronous, no I/O.
   * Historical reconstruction/authentication MUST finish before this callback.
   * The returned state contains live capabilities for the trusted checkpoint
   * issuer, never values to deserialize into authority. Persist only data.
   * Persist snapshot, authenticated checkpoint, comparison index and command
   * receipt atomically, or persist none. Cached comparisons are trusted storage
   * indexes, updated in this same transaction, never client-provided CAS facts.
   * Production adapters must authenticate the committed history on subsequent loads.
   */
  build: (
    current: ForkLedgerSnapshot | null,
    storageTime: number,
  ) => { snapshot: ForkLedgerSnapshot; state: ForkCheckpointState };
}>;
export interface CertifiedForkEffectRepositoryPort {
  loadReview(familyKey: string, commandId?: string): Promise<ForkLoadedReview>;
  acquireClaim(transaction: ForkTransaction): Promise<ForkLoadedReview>;
  renewClaim(transaction: ForkTransaction): Promise<ForkLoadedReview>;
  releaseClaim(transaction: ForkTransaction): Promise<ForkLoadedReview>;
  compareAndCommit(transaction: ForkTransaction): Promise<ForkLoadedReview>;
}
