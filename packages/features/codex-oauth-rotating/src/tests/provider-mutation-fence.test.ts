import { describe, expect, it } from "vitest";
import {
  assertCanonicalCodexRotatingProviderId,
  canonicalCodexRotatingProviderId,
  classifyCodexRotatingMutationOwnership,
  parseCodexRotatingMutationEpoch,
} from "../index";

describe("rotating provider identity and mutation fence", () => {
  it("derives the sole provider identity from the GitHub repository id", () => {
    expect(canonicalCodexRotatingProviderId("123456")).toBe(
      "codex-rotating:123456",
    );
    expect(() => canonicalCodexRotatingProviderId("owner/repo")).toThrow();
    expect(() =>
      assertCanonicalCodexRotatingProviderId({
        providerInstanceId: "codex-rotating:654321",
        githubRepositoryId: "123456",
      }),
    ).toThrow("codex_rotating_provider_identity_mismatch");
  });

  it("accepts only positive mutation epochs", () => {
    expect(parseCodexRotatingMutationEpoch(1n)).toBe(1n);
    expect(() => parseCodexRotatingMutationEpoch(0n)).toThrow(
      "codex_rotating_mutation_epoch_invalid",
    );
  });

  it("never makes a fetched installer recoverable by elapsed time", () => {
    const fetchedAt = new Date("2026-08-09T12:00:00.000Z");
    const classify = (now: string) =>
      classifyCodexRotatingMutationOwnership({
        owner: "setup",
        ownerId: "manifest_1",
        now: new Date(now),
        setup: {
          id: "manifest_1",
          status: "fetched",
          expiresAt: fetchedAt,
          lastFetchedAt: fetchedAt,
        },
      }).classification;
    expect(classify("2026-08-09T12:14:59.999Z")).toBe("remote_outcome_unknown");
    expect(classify("2036-08-09T12:15:00.000Z")).toBe("remote_outcome_unknown");
    expect(
      classifyCodexRotatingMutationOwnership({
        owner: "recovery",
        ownerId: "late_manifest_1",
        now: new Date("2026-08-09T12:14:59.999Z"),
        setup: {
          id: "manifest_1",
          status: "fetched",
          expiresAt: fetchedAt,
          lastFetchedAt: fetchedAt,
        },
      }).classification,
    ).toBe("remote_outcome_unknown");
  });

  it("keeps a late unknown runtime PUT blocking after every grace deadline", () => {
    expect(
      classifyCodexRotatingMutationOwnership({
        owner: "recovery",
        ownerId: "intent_1",
        now: new Date("2036-08-09T12:00:00.000Z"),
        writeback: {
          id: "intent_1",
          leaseId: "lease_1",
          status: "remote_outcome_unknown",
          claimedAt: new Date("2026-08-09T12:00:00.000Z"),
          claimMarker: false,
        },
        runtimeLease: {
          id: "lease_1",
          status: "unknown_auth_state",
          expiresAt: new Date("2026-08-09T12:15:00.000Z"),
        },
      }).classification,
    ).toBe("remote_outcome_unknown");
  });

  it("models a runtime claim through lease expiry plus grace", () => {
    const result = classifyCodexRotatingMutationOwnership({
      owner: "runtime",
      ownerId: "lease_1",
      now: new Date("2026-08-09T12:20:00.000Z"),
      writeback: {
        id: "intent_1",
        leaseId: "lease_1",
        status: "pending",
        claimedAt: new Date("2026-08-09T12:00:00.000Z"),
        claimMarker: true,
      },
      runtimeLease: {
        id: "lease_1",
        status: "finalized",
        expiresAt: new Date("2026-08-09T12:10:00.000Z"),
      },
    });
    expect(result).toMatchObject({ classification: "active" });
  });
});
