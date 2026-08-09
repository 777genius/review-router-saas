import { describe, expect, it } from "vitest";
import {
  assertCodexRotatingSetupRecoveryHttpFields,
  codexRotatingSetupRecoveryHttpStatus,
  safeCodexRotatingSetupRecoveryErrorCode,
} from "../domain/codex-rotating-setup-recovery-http";

describe("Codex rotating recovery HTTP contract", () => {
  it("uses one validation reason for every transport", () => {
    expect(() =>
      assertCodexRotatingSetupRecoveryHttpFields({
        acknowledgement: "all_prior_installers_and_writers_are_stopped",
        recoveryRequestId: "bad id",
      }),
    ).toThrow("codex_rotating_setup_recovery_request_invalid");
  });

  it.each([
    ["codex_rotating_setup_recovery_request_invalid", 400],
    ["codex_rotating_provider_identity_mismatch", 409],
    ["codex_rotating_provider_not_found", 404],
    ["codex_rotating_remote_outcome_unknown", 409],
  ] as const)("maps %s to HTTP %i", (reason, status) => {
    const safeReason = safeCodexRotatingSetupRecoveryErrorCode(
      new Error(reason),
    );
    expect(safeReason).toBe(reason);
    expect(codexRotatingSetupRecoveryHttpStatus(safeReason)).toBe(status);
  });

  it("sanitizes unknown details", () => {
    expect(
      safeCodexRotatingSetupRecoveryErrorCode(
        new Error("secret=must-not-escape"),
      ),
    ).toBe("invalid_request");
  });
});
