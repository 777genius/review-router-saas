export const codexRotatingSetupRecoveryAcknowledgement =
  "all_prior_installers_and_writers_are_stopped" as const;
export const codexRotatingAccountSwitchAcknowledgement =
  "all_prior_installers_and_writers_are_stopped_and_account_switch_is_intended" as const;

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
  readonly versionedNamespaceRecoveryAvailable?: boolean;
  readonly externalRecoveryWitnessRelation?: ExternalRecoveryWitnessRelation;
};

export type CodexRotatingSetupRecoveryDecision =
  | { readonly kind: "recover" }
  | { readonly kind: "idempotent_replay" };

/** Pure policy for the only transition that may abandon unknown provider auth. */
export function decideCodexRotatingSetupRecovery(input: {
  readonly acknowledgement?: string | undefined;
  readonly accountSwitch?: boolean | undefined;
  readonly snapshot: CodexRotatingSetupRecoverySnapshot;
}): CodexRotatingSetupRecoveryDecision {
  const requiredAcknowledgement = input.accountSwitch
    ? codexRotatingAccountSwitchAcknowledgement
    : codexRotatingSetupRecoveryAcknowledgement;
  if (input.acknowledgement !== requiredAcknowledgement) {
    throw new Error("codex_rotating_setup_recovery_acknowledgement_required");
  }
  if (input.snapshot.quarantined) {
    throw new Error("codex_rotating_identity_quarantined");
  }
  if (!input.snapshot.canonicalIdentity) {
    throw new Error("codex_rotating_provider_identity_mismatch");
  }
  assertExternalRecoveryWitnessAdmission({
    transition: "forced_operator_recovery",
    relation:
      input.snapshot.externalRecoveryWitnessRelation ??
      ExternalRecoveryWitnessRelation.NoPersistedEvidence,
  });
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
    if (input.snapshot.versionedNamespaceRecoveryAvailable === true) {
      return { kind: "recover" };
    }
    throw new Error("codex_rotating_remote_outcome_unknown");
  }
  if (
    input.snapshot.mutationOwnership === "clear" &&
    input.snapshot.externalRecoveryWitnessRelation !==
      ExternalRecoveryWitnessRelation.Mismatched
  ) {
    throw new Error("codex_rotating_setup_recovery_not_required");
  }
  return { kind: "recover" };
}
import {
  assertExternalRecoveryWitnessAdmission,
  ExternalRecoveryWitnessRelation,
} from "@reviewrouter/features-codex-oauth-rotating";
export { ExternalRecoveryWitnessRelation } from "@reviewrouter/features-codex-oauth-rotating";
