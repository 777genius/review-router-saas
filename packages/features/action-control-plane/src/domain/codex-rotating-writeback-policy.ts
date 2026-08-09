export const codexRotatingWritebackClaimMarker =
  "runtime_write_claim_v1" as const;

export type CodexRotatingWritebackIntentStatus =
  | "pending"
  | "completed"
  | "failed"
  | "ambiguous";

export type CodexRotatingWritebackPreparationDecision =
  | { readonly status: "claim" }
  | { readonly status: "idempotent_replay" }
  | { readonly status: "writeback_recovery_required" }
  | { readonly status: "writeback_idempotency_conflict" };

/**
 * Owns the fail-closed replay policy for the irreversible provider write.
 * Unknown persisted states are deliberately treated as ambiguous so an older
 * or partially rolled-out record can never authorize another provider PUT.
 */
export function decideCodexRotatingWritebackPreparation(input: {
  readonly existing:
    | {
        readonly encryptedPayloadDigest: string;
        readonly status: string;
      }
    | undefined;
  readonly encryptedPayloadDigest: string;
}): CodexRotatingWritebackPreparationDecision {
  if (!input.existing) return { status: "claim" };
  if (input.existing.encryptedPayloadDigest !== input.encryptedPayloadDigest) {
    return { status: "writeback_idempotency_conflict" };
  }
  if (input.existing.status === "completed") {
    return { status: "idempotent_replay" };
  }
  return { status: "writeback_recovery_required" };
}

export function decideCodexRotatingWritebackConfirmation(intent: {
  readonly status: string;
  readonly safeErrorCode?: string | null;
}): "confirm" | "idempotent" | "recovery_required" {
  if (
    intent.status === "pending" &&
    intent.safeErrorCode === codexRotatingWritebackClaimMarker
  ) {
    return "confirm";
  }
  if (intent.status === "completed") return "idempotent";
  return "recovery_required";
}

export function mayFailCodexRotatingWritebackClaim(intent: {
  readonly status: string;
  readonly safeErrorCode?: string | null;
}): boolean {
  return (
    intent.status === "pending" &&
    intent.safeErrorCode === codexRotatingWritebackClaimMarker
  );
}

export function blocksCodexRotatingProviderMutation(status: string): boolean {
  return status === "pending";
}
