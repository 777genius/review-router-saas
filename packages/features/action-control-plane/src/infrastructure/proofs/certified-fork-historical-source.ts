import type {
  ForkClaim,
  ForkComparison,
  ForkLedgerEvent,
  ForkLedgerInput,
  ForkRequestSeed,
  ForkReviewSeed,
} from "../../application/ports/certified-fork-effect-repository-port.js";
import type {
  ForkAuthority,
  ForkEvidence,
  ForkEffectState,
} from "../../domain/certified-fork-effect-state.js";
import type { ForkArchiveVersion } from "../prisma/prisma-certified-fork-effect-repository.js";
import type {
  RetainedFactInput,
  RetainedFactScope,
} from "../prisma/certified-fork-proof-fact-types.js";

export type HistoricalForkPredecessor = Readonly<{
  familyKey: string;
  version: string;
  reviewHash: string;
  outcomeHash: string;
}>;
export type HistoricalForkPreimage =
  | {
      operation: "acquire";
      data: {
        seed: ForkReviewSeed;
        admissionProof: string;
        ownerHash: string;
        ttlMs: number;
        commandId: string;
      };
    }
  | {
      operation: "renew" | "release";
      data: { expected: ForkComparison; ttl: number };
    }
  | {
      operation: "reconcile";
      data: { expected: ForkComparison; command: ForkLedgerInput };
    }
  /** Private import contract, NOT an existing application writer or legacy fallback.
   * Its protected producer must attest the exact ordered command inputs. This
   * admits historical prepare/begin/retry/inventory without inventing public APIs.
   * No real producer binding exists yet; unsupported sources MUST throw. */
  | {
      operation: "fork-historical-events-v1";
      data: { expected: ForkComparison; inputs: readonly ForkLedgerInput[] };
    };

export type HistoricalForkAdmission = Readonly<{
  fact: RetainedFactInput<"admission">;
  seed: ForkReviewSeed;
  requests: readonly ForkRequestSeed[];
  predecessor: HistoricalForkPredecessor | null;
}>;
export type HistoricalForkCommand = Readonly<{
  fact: RetainedFactInput<"command">;
  preimage: HistoricalForkPreimage;
  ownerHash: string;
}>;
export type HistoricalForkAuthority = Readonly<{
  fact: RetainedFactInput<"authority">;
  authority: ForkAuthority;
  claim: ForkClaim;
}>;
export type HistoricalForkEvidence = Readonly<{
  fact: RetainedFactInput<"evidence">;
  evidence: ForkEvidence;
  originalScope: Readonly<{
    requestHash: string;
    effectKey: string;
    attempt: string;
    originEpoch: string;
    originClaimHash: string;
    originOwnerHash: string;
    remoteScopeHash: string;
  }>;
}>;
export type HistoricalForkInventory = Readonly<{
  fact: RetainedFactInput<"inventory">;
  requests: readonly ForkRequestSeed[];
  entries: readonly { effectKey: string; dependencies: readonly string[] }[];
}>;
export type HistoricalForkOutput = Readonly<{
  fact: RetainedFactInput<"output">;
}>;

/** Mandatory INTERNAL protected composition, never supplied by an API caller.
 * Each resolver returns ONLY authenticated, committed source results: use the
 * retained reader's exact-kind/scope/hash checks AND fixed producer/version/source
 * custody validation. Structural interfaces do not implement authentication.
 * There are no real producer bindings in this slice, no permissive defaults and
 * no acceptance based on producer labels, caller DTOs, hashes or timestamps.
 *
 * Admission producer validates the full original decision/principal/request hash
 * preimages, binding, packet and original admission (not a derived generation
 * hash). Authority producer verifies the original principal/control observation.
 * Evidence producer authenticates provider/App response, all hash preimages,
 * remote identity and durable sender closure, binding the ORIGINAL attempt.
 * Distinct evidence records may authenticate the identical complete evidence.
 * Their authority references must resolve to the full original event closure;
 * this also applies to output.successEvidenceProof, without canonical proof IDs.
 * Same-generation acquisition may retain a fresh admission observation without
 * rewriting the older admission facts or the original generation seed.
 * Inventory producer authenticates the complete rendered plan and dependencies.
 * Output producer authenticates commit custody and causal read-before-command;
 * neither createdAt nor committedAt alone proves this. Command producer verifies
 * original principal, preimage and complete atomic command/fact/archive closure.
 * Unknown versions, unavailable/missing provenance and staged records throw.
 * Historical expiration is checked at original command time, never wall clock.
 *
 * open must authorize read access, pin a committed family tip, and load COMPLETE
 * contiguous joined versions 1..tip using the reviewed archive decoder. It must
 * not run within a write build/run hook. DB loading, principal authentication,
 * fixed producer bindings and current authorization remain unimplemented.
 */
export interface ProtectedForkHistoricalSource {
  open(familyKey: string): Promise<{
    familyKey: string;
    tipVersion: string;
    versions: readonly ForkArchiveVersion[];
    admission(
      scope: RetainedFactScope,
      proof: string,
    ): Promise<HistoricalForkAdmission>;
    command(
      scope: RetainedFactScope,
      proof: string,
    ): Promise<HistoricalForkCommand>;
    authority(
      scope: RetainedFactScope,
      proof: string,
    ): Promise<HistoricalForkAuthority>;
    evidence(
      scope: RetainedFactScope,
      proof: string,
      origin: ForkEffectState,
    ): Promise<HistoricalForkEvidence>;
    inventory(
      scope: RetainedFactScope,
      proof: string,
      event: ForkLedgerEvent,
    ): Promise<HistoricalForkInventory>;
    output(
      scope: RetainedFactScope,
      proof: string,
      consumingCommand: string,
    ): Promise<HistoricalForkOutput>;
  }>;
}
