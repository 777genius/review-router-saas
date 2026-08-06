import { describe, expect, it } from "vitest";
import { resolveReviewCommandLedgerHmacSecret } from "../infrastructure/review-command-ledger-configuration";

describe("review command ledger configuration", () => {
  it("uses one deterministic precedence for API and worker composition", () => {
    expect(
      resolveReviewCommandLedgerHmacSecret(
        {
          REVIEW_ROUTER_LEDGER_HMAC_KEY: " dedicated ",
          REVIEW_ROUTER_ACTION_SESSION_SECRET: "session",
          AUTH_SECRET: "auth",
        },
        "fallback",
      ),
    ).toBe("dedicated");
    expect(
      resolveReviewCommandLedgerHmacSecret(
        {
          REVIEW_ROUTER_ACTION_SESSION_SECRET: " session ",
          AUTH_SECRET: "auth",
        },
        "fallback",
      ),
    ).toBe("session");
    expect(
      resolveReviewCommandLedgerHmacSecret(
        { AUTH_SECRET: "auth" },
        " fallback ",
      ),
    ).toBe("fallback");
    expect(
      resolveReviewCommandLedgerHmacSecret({ AUTH_SECRET: " auth " }),
    ).toBe("auth");
  });

  it("returns null when every candidate is empty", () => {
    expect(
      resolveReviewCommandLedgerHmacSecret(
        {
          REVIEW_ROUTER_LEDGER_HMAC_KEY: " ",
          REVIEW_ROUTER_ACTION_SESSION_SECRET: "",
          AUTH_SECRET: " ",
        },
        " ",
      ),
    ).toBeNull();
  });
});
