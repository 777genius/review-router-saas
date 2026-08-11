import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  mapError: vi.fn(() => ({ status: 400, error: "invalid_request" })),
}));

vi.mock("../../../../src/server/codex-rotating-setup-ledger", () => ({
  codexRotatingSetupLedger: { prepare: mocks.prepare },
  codexRotatingSetupLedgerHttpError: mocks.mapError,
}));

import { POST } from "./route";

describe("Codex rotating setup prepare transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not cache malformed JSON", async () => {
    const response = await POST(
      new Request(
        "https://reviewrouter.site/api/codex-rotating/setup-prepare",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not-json",
        },
      ),
    );

    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.mapError).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_json" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
