import { describe, expect, it } from "vitest";
import {
  InMemoryCodexRotatingSetupPayloadClaim,
  prepareCodexRotatingSetup,
} from "../index";

const claim = {
  payloadVersion: 1 as const,
  repositoryId: "900001",
  providerInstanceId: "codex-rotating:900001",
  setupNonce: "stp:payload-claim-0001",
  generationHash: "g".repeat(43),
  accountFingerprint: "a".repeat(43),
  authByteSize: 1234,
  installerVersion: "2026.08.09",
};

describe("prepareCodexRotatingSetup", () => {
  it("makes the first exact claim win and the same claim idempotent", async () => {
    const claims = new InMemoryCodexRotatingSetupPayloadClaim();
    await expect(prepareCodexRotatingSetup(claim, { claims })).resolves.toEqual(
      {
        status: "claimed",
      },
    );
    await expect(prepareCodexRotatingSetup(claim, { claims })).resolves.toEqual(
      {
        status: "already_claimed",
      },
    );
  });

  it("rejects a different exact payload in the same namespace", async () => {
    const claims = new InMemoryCodexRotatingSetupPayloadClaim();
    await prepareCodexRotatingSetup(claim, { claims });
    await expect(
      prepareCodexRotatingSetup(
        { ...claim, generationHash: "x".repeat(43) },
        { claims },
      ),
    ).rejects.toThrow("codex_rotating_setup_payload_claim_conflict");
  });

  it("serializes concurrent different claims", async () => {
    const claims = new InMemoryCodexRotatingSetupPayloadClaim();
    const results = await Promise.allSettled([
      prepareCodexRotatingSetup(claim, { claims }),
      prepareCodexRotatingSetup(
        { ...claim, accountFingerprint: "z".repeat(43) },
        { claims },
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });
});
