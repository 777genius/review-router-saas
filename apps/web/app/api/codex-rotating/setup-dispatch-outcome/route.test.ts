import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordOutcome: vi.fn(),
  mapError: vi.fn(() => ({
    status: 400,
    error: "codex_rotating_setup_ledger_invalid",
  })),
}));

vi.mock("../../../../src/server/codex-rotating-setup-ledger", () => ({
  codexRotatingSetupLedger: { recordOutcome: mocks.recordOutcome },
  codexRotatingSetupLedgerHttpError: mocks.mapError,
}));

import { POST } from "./route";

describe("Codex rotating setup dispatch outcome transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not cache malformed JSON responses", async () => {
    const response = await POST(
      new Request(
        "https://reviewrouter.site/api/codex-rotating/setup-dispatch-outcome",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not-json",
        },
      ),
    );

    expect(mocks.recordOutcome).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
