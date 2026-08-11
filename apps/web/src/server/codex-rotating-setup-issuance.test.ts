import { afterEach, describe, expect, it } from "vitest";
import { assertSetupIssuanceEnabled } from "./codex-rotating-setup-manifest.js";

const key = "REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED";
const original = process.env[key];

afterEach(() => {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
});

describe("rotating setup issuance configuration", () => {
  it.each([undefined, "", "0", "true", "01", " 1", "enabled"])(
    "fails closed unless the enabled value is exact: %s",
    (value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      expect(assertSetupIssuanceEnabled).toThrow(
        "codex_rotating_setup_issuance_quiesced",
      );
    },
  );

  it("accepts only exact 1", () => {
    process.env[key] = "1";
    expect(assertSetupIssuanceEnabled).not.toThrow();
  });
});
