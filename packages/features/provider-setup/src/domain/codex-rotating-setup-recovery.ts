export const codexRotatingSetupRecoveryAcknowledgement =
  "github_secret_may_have_changed" as const;

export type CodexRotatingSetupRecoverySnapshot = {
  readonly canonicalIdentity: boolean;
  readonly quarantined: boolean;
  readonly hasFetchedManifest: boolean;
  readonly hasAmbiguousWritebackIntent: boolean;
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
  if (
    !input.snapshot.hasFetchedManifest &&
    !input.snapshot.hasAmbiguousWritebackIntent
  ) {
    throw new Error("codex_rotating_setup_recovery_not_required");
  }
  return { kind: "recover" };
}
