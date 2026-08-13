import { describe, expect, it } from "vitest";
import {
  normalizeReleaseAuthorityRoutineError,
  ReleaseAuthorityAdapterConflictError,
  ReleaseAuthorityAdapterUnexpectedError,
} from "./routine-errors";

describe("release authority routine error boundary", () => {
  it.each([
    "release service transition intent conflict",
    "release service transition recovery intent missing",
    "release service transition checkpoint conflict",
    "release service transition checkpoint replay conflict",
    "release service transition checkpoint out of order",
    "release service transition source verification incomplete",
    "release service transition source acl not restored",
    "release source recovery runner effects unsafe",
    "release target service transition incomplete",
    "release source service recovery incomplete",
  ])(
    "maps exact durable conflict/precondition failures to 409: %s",
    (message) => {
      expect(() =>
        normalizeReleaseAuthorityRoutineError({
          code: "P2010",
          meta: { code: "P0001", message },
        }),
      ).toThrow(ReleaseAuthorityAdapterConflictError);
    },
  );

  it("maps a missing durable routine row to 409 by SQLSTATE", () => {
    expect(() =>
      normalizeReleaseAuthorityRoutineError({ code: "P0002" }),
    ).toThrow(ReleaseAuthorityAdapterConflictError);
  });

  it.each([
    "release service transition intent invalid",
    "release service transition outcome invalid",
    "prefix release service transition checkpoint conflict suffix",
    "sensitive database implementation detail",
  ])("sanitizes non-conflict database failures as 500: %s", (message) => {
    const cause = { code: "P2010", meta: { code: "P0001", message } };
    try {
      normalizeReleaseAuthorityRoutineError(cause);
      throw new Error("expected_normalization_failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ReleaseAuthorityAdapterUnexpectedError);
      expect(error).toMatchObject({
        message: "release_authority_adapter_failure",
        statusCode: 500,
        cause,
      });
      expect(String(error)).not.toContain(message);
    }
  });
});
