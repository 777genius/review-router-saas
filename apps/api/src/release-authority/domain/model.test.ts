import { describe, expect, it } from "vitest";
import { ReleaseAuthorityState } from "./model";

describe("release authority aggregate", () => {
  it("defines only the accepted explicit states", () => {
    expect(Object.values(ReleaseAuthorityState)).toEqual([
      "pre_activation",
      "compensating",
      "compensated",
      "activation_authorized",
      "activated",
      "outcome_unknown",
      "forward_repair_required",
    ]);
  });
});
