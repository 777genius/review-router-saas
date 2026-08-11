import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  mapError: vi.fn(() => ({ status: 400, error: "invalid_request" })),
}));

vi.mock("../../../../src/server/codex-rotating-setup-ledger", () => ({
  codexRotatingSetupLedger: { status: mocks.status },
  codexRotatingSetupLedgerHttpError: mocks.mapError,
}));

import * as route from "./route";

const claimId = "codex_claim_11111111-1111-4111-8111-111111111111";

describe("Codex rotating setup status capability transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.status.mockResolvedValue({
      status: "prepared",
      claimId,
      databaseIncarnation: "7612345678901234567",
      databaseRecoveryWitnessFingerprint: "a".repeat(64),
      attempt: null,
    });
  });

  it("accepts the capability only in a POST JSON body", async () => {
    expect("GET" in route).toBe(false);
    const response = await route.POST(
      new Request(
        "https://reviewrouter.site/api/codex-rotating/setup-status?claimId=stp%3Apublic-nonce",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ claimId }),
        },
      ),
    );

    expect(mocks.status).toHaveBeenCalledWith({ claimId });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "prepared",
      claimId,
      databaseIncarnation: "7612345678901234567",
      databaseRecoveryWitnessFingerprint: "a".repeat(64),
      attempt: null,
    });
  });

  it("does not cache malformed capability requests", async () => {
    const response = await route.POST(
      new Request("https://reviewrouter.site/api/codex-rotating/setup-status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
    );

    expect(mocks.status).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
