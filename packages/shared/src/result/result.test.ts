import { describe, expect, it } from "vitest";
import { err, ok, unwrap } from "./index.js";

describe("Result", () => {
  it("unwraps ok values", () => {
    expect(unwrap(ok("ready"))).toBe("ready");
  });

  it("throws error values", () => {
    expect(() => unwrap(err(new Error("failed")))).toThrow("failed");
  });
});
