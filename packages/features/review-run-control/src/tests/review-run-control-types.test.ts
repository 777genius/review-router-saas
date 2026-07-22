import { describe, expect, it } from "vitest";
import { canonicalJson } from "../domain/review-run-control-types";

describe("review run control canonical JSON", () => {
  it("uses the generated protocol's locale-independent code-unit key order", () => {
    expect(
      canonicalJson({
        z: 5,
        "\ud83d\ude00": 7,
        _: 3,
        a: 4,
        Z: 2,
        A: 1,
        "\u00e4": 6,
      }),
    ).toBe('{"A":1,"Z":2,"_":3,"a":4,"z":5,"\u00e4":6,"\ud83d\ude00":7}');
  });
});
