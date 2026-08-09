import { describe, expect, it } from "vitest";
import {
  codexRotatingSetupRecoveryAcknowledgement,
  decideCodexRotatingSetupRecovery,
} from "../domain/codex-rotating-setup-recovery";

const recoverable = {
  canonicalIdentity: true,
  quarantined: false,
  hasFetchedManifest: true,
  hasAmbiguousWritebackIntent: false,
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
});
