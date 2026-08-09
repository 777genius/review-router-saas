import { describe, expect, it } from "vitest";
import {
  blocksCodexRotatingProviderMutation,
  decideCodexRotatingWritebackConfirmation,
  decideCodexRotatingWritebackPreparation,
  mayFailCodexRotatingWritebackClaim,
} from "../domain/codex-rotating-writeback-policy.js";

describe("Codex rotating writeback policy", () => {
  it("allows only a missing intent to acquire the durable claim", () => {
    expect(
      decideCodexRotatingWritebackPreparation({
        existing: undefined,
        encryptedPayloadDigest: "digest-a",
      }),
    ).toEqual({ status: "claim" });
  });

  it.each(["pending", "claimed", "failed", "ambiguous", "future-state"])(
    "fails closed for exact %s replay",
    (status) => {
      expect(
        decideCodexRotatingWritebackPreparation({
          existing: { encryptedPayloadDigest: "digest-a", status },
          encryptedPayloadDigest: "digest-a",
        }),
      ).toEqual({ status: "writeback_recovery_required" });
    },
  );

  it("distinguishes an exact completed replay from a digest conflict", () => {
    expect(
      decideCodexRotatingWritebackPreparation({
        existing: {
          encryptedPayloadDigest: "digest-a",
          status: "completed",
        },
        encryptedPayloadDigest: "digest-a",
      }),
    ).toEqual({ status: "idempotent_replay" });
    expect(
      decideCodexRotatingWritebackPreparation({
        existing: {
          encryptedPayloadDigest: "digest-a",
          status: "completed",
        },
        encryptedPayloadDigest: "digest-b",
      }),
    ).toEqual({ status: "writeback_idempotency_conflict" });
  });

  it("permits confirmation and failure transitions only from claimed", () => {
    expect(
      decideCodexRotatingWritebackConfirmation({
        status: "pending",
        safeErrorCode: "runtime_write_claim_v1",
      }),
    ).toBe("confirm");
    expect(
      decideCodexRotatingWritebackConfirmation({ status: "completed" }),
    ).toBe("idempotent");
    expect(
      decideCodexRotatingWritebackConfirmation({ status: "pending" }),
    ).toBe("recovery_required");
    expect(
      mayFailCodexRotatingWritebackClaim({
        status: "pending",
        safeErrorCode: "runtime_write_claim_v1",
      }),
    ).toBe(true);
    expect(mayFailCodexRotatingWritebackClaim({ status: "pending" })).toBe(
      false,
    );
    expect(blocksCodexRotatingProviderMutation("pending")).toBe(true);
    expect(blocksCodexRotatingProviderMutation("failed")).toBe(false);
  });
});
