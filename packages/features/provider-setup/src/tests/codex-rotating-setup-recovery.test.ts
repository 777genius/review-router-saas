import { describe, expect, it } from "vitest";
import {
  codexRotatingAccountSwitchAcknowledgement,
  codexRotatingSetupRecoveryAcknowledgement,
  decideCodexRotatingSetupRecovery,
  ExternalRecoveryWitnessRelation,
} from "../domain/codex-rotating-setup-recovery";

const recoverable = {
  canonicalIdentity: true,
  quarantined: false,
  mutationOwnership: "recoverable",
  recoveryRequestAlreadyApplied: false,
} as const;

describe("Codex rotating setup recovery policy", () => {
  it("requires the exact acknowledgement before abandoning unknown auth", () => {
    expect(() =>
      decideCodexRotatingSetupRecovery({ snapshot: recoverable }),
    ).toThrow("codex_rotating_setup_recovery_acknowledgement_required");
    expect(() =>
      decideCodexRotatingSetupRecovery({
        acknowledgement: "yes",
        snapshot: recoverable,
      }),
    ).toThrow("codex_rotating_setup_recovery_acknowledgement_required");
  });

  it("requires a distinct explicit acknowledgement for an account-switch epoch", () => {
    expect(() =>
      decideCodexRotatingSetupRecovery({
        acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
        accountSwitch: true,
        snapshot: recoverable,
      }),
    ).toThrow("codex_rotating_setup_recovery_acknowledgement_required");
    expect(
      decideCodexRotatingSetupRecovery({
        acknowledgement: codexRotatingAccountSwitchAcknowledgement,
        accountSwitch: true,
        snapshot: recoverable,
      }),
    ).toEqual({ kind: "recover" });
  });

  it("fails closed for quarantine instead of rewriting immutable identity", () => {
    expect(() =>
      decideCodexRotatingSetupRecovery({
        acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
        snapshot: { ...recoverable, quarantined: true },
      }),
    ).toThrow("codex_rotating_identity_quarantined");
  });

  it("returns a typed idempotent retry decision", () => {
    expect(
      decideCodexRotatingSetupRecovery({
        acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
        snapshot: { ...recoverable, recoveryRequestAlreadyApplied: true },
      }),
    ).toEqual({ kind: "idempotent_replay" });
  });

  it.each([
    ["active", "codex_rotating_mutation_still_active"],
    ["remote_outcome_unknown", "codex_rotating_remote_outcome_unknown"],
    ["ambiguous", "codex_rotating_mutation_ownership_ambiguous"],
  ] as const)(
    "refuses %s external mutation ownership",
    (classification, code) => {
      expect(() =>
        decideCodexRotatingSetupRecovery({
          acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
          snapshot: { ...recoverable, mutationOwnership: classification },
        }),
      ).toThrow(code);
    },
  );

  it("allows remote fixed-name evidence only through versioned namespace recovery", () => {
    expect(
      decideCodexRotatingSetupRecovery({
        acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
        snapshot: {
          ...recoverable,
          mutationOwnership: "remote_outcome_unknown",
          versionedNamespaceRecoveryAvailable: true,
        },
      }),
    ).toEqual({ kind: "recover" });
  });

  it("admits W1 to W2 rotation only with the exact forced acknowledgement", () => {
    const rotated = {
      ...recoverable,
      mutationOwnership: "clear" as const,
      externalRecoveryWitnessRelation:
        ExternalRecoveryWitnessRelation.Mismatched,
    };
    expect(() =>
      decideCodexRotatingSetupRecovery({ snapshot: rotated }),
    ).toThrow("codex_rotating_setup_recovery_acknowledgement_required");
    expect(
      decideCodexRotatingSetupRecovery({
        acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
        snapshot: rotated,
      }),
    ).toEqual({ kind: "recover" });
  });
});
