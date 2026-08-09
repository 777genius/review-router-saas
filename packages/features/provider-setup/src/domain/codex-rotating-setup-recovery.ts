export const codexRotatingSetupRecoveryAcknowledgement =
  "all_prior_installers_and_writers_are_stopped" as const;

export type CodexRotatingSetupRecoverySnapshot = {
  readonly canonicalIdentity: boolean;
  readonly quarantined: boolean;
  readonly mutationOwnership:
    | "active"
    | "remote_outcome_unknown"
    | "ambiguous"
    | "recoverable"
    | "clear";
  readonly recoveryRequestAlreadyApplied: boolean;
};

export type CodexRotatingSetupRecoveryDecision =
  | { readonly kind: "recover" }
  | { readonly kind: "idempotent_replay" };

/** Pure policy for the only transition that may abandon unknown provider auth. */
export function decideCodexRotatingSetupRecovery(input: {
  readonly acknowledgement?: string | undefined;
  readonly snapshot: CodexRotatingSetupRecoverySnapshot;
}): CodexRotatingSetupRecoveryDecision {
  if (input.acknowledgement !== codexRotatingSetupRecoveryAcknowledgement) {
    throw new Error("codex_rotating_setup_recovery_acknowledgement_required");
  }
  if (input.snapshot.quarantined) {
    throw new Error("codex_rotating_identity_quarantined");
  }
  if (!input.snapshot.canonicalIdentity) {
    throw new Error("codex_rotating_provider_identity_mismatch");
  }
  if (input.snapshot.recoveryRequestAlreadyApplied) {
    return { kind: "idempotent_replay" };
  }
  if (input.snapshot.mutationOwnership === "active") {
    throw new Error("codex_rotating_mutation_still_active");
  }
  if (input.snapshot.mutationOwnership === "ambiguous") {
    throw new Error("codex_rotating_mutation_ownership_ambiguous");
  }
  if (input.snapshot.mutationOwnership === "remote_outcome_unknown") {
    throw new Error("codex_rotating_remote_outcome_unknown");
  }
  if (input.snapshot.mutationOwnership === "clear") {
    throw new Error("codex_rotating_setup_recovery_not_required");
  }
  return { kind: "recover" };
}
